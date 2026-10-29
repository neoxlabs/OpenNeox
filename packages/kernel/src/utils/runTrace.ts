/**
 * runTrace — 「这个 run 现在卡在哪一层」的可观测中枢
 *
 * ## 作用
 *
 * stallGuard 记录具体等待项,本模块进一步提供
 * "哪个 run、第几轮、当前处于 LLM / 工具 / 锁 / 子 agent 哪一层、空闲多久"的信息。
 * 本模块为每个 run 维护一个轻量 trace:
 *
 *   · 全局活跃 run 注册表(activeRuns)供看门狗和诊断接口枚举所有 run。
 *   · phaseStack —— 每进入一层(iteration / llm / tool:edit_file / lock:/a.ts)push
 *     一帧,退出 pop。任意时刻 snapshot 出迭代、工具和锁的当前位置链。
 *   · ALS(getCurrentRunTrace)用于就近归属:深层 async 代码(工具体内、锁)无需把
 *     runId 一路透传,直接读当前 run 往 stack 里 push 自己。
 *
 * ## registry + ALS 双轨
 *
 * runner.run() 是 generator,`enterWith` 设的 ALS 跨 yield 会丢。所以:
 *   · runner 自身(它持有 this.runTrace 实例引用)直接更新 iteration/phase。
 *   · runner.invokeTool 是普通 async 方法,在它内部用 runWithRunTrace() 包住 tool.function,
 *     ALS 在整棵工具子树里有效 → 深层锁/子 agent 用 getCurrentRunTrace() 可靠归属。
 *   · 看门狗/诊断只读 registry,与 ALS 是否丢失无关。
 *
 * ## 清理保证(绝不泄漏)
 *   · 正常结束 / break / 抛错 → runner 在收尾处调 endRun()。
 *   · 同 session 新的顶层 run 开始时 supersede 掉旧 run。
 *   · 看门狗周期 sweep:超过 RUN_TTL 的僵尸 trace 强制驱逐(最终兜底)。
 *   · 所有定时器 unref(),绝不阻止进程退出。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { cliLogger } from '../platform/cliLogger.js';
import { neoxLogger } from '../platform/neoxLogger.js';
import { getInflightStalls, envTimeoutMs, writeStallFile } from './stallGuard.js';

const TAG = 'RUNTRACE';

/** 三写日志 — gated 的 cli/neox logger + 永远在线的 stall.log(不依赖 CLI_DEBUG, 卡死必留痕)。 */
function traceLog(
  level: 'warn' | 'error' | 'info',
  tag: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  try { cliLogger[level](tag, message, data); } catch { /* logger 自身异常绝不外溢 */ }
  try { neoxLogger[level](tag, message, data); } catch { /* ignore */ }
  writeStallFile(level, tag, message, data); // 永远在线
}

// ════════════════════════════════════════════════════════════════════════════
// 配置(全部环境变量可调,默认值对标 stallGuard)
// ════════════════════════════════════════════════════════════════════════════

/** 看门狗轮询间隔; <=0 禁用看门狗。默认 30s。 */
const WATCH_INTERVAL_MS = envTimeoutMs('NEOX_RUNTRACE_WATCH_INTERVAL_MS', 30_000);
/** 只 dump 卡超过此年龄的 run / inflight,避免正常短 run 刷屏。默认 20s。 */
const WATCH_MIN_AGE_MS = envTimeoutMs('NEOX_RUNTRACE_WATCH_MIN_AGE_MS', 20_000);
/**
 * 周期 dump 还要求"这个 run 至少这么久没动过"。默认 60s。
 *
 *   看门狗按 idle 时长判断 run 是否停滞, 长时间但持续活动的 run 不会被当作停滞。
 */
const WATCH_MIN_IDLE_MS = envTimeoutMs('NEOX_RUNTRACE_WATCH_MIN_IDLE_MS', 60_000);
/** 带硬 deadline 的挂起操作, 用掉这个比例的预算后才值得上报(默认 60%)。 */
const TIMEOUT_WARN_FRACTION = 0.6;
/** 僵尸 trace 兜底驱逐阈值(被弃且没人 endRun 的 run)。默认 1h。 */
const RUN_TTL_MS = envTimeoutMs('NEOX_RUNTRACE_TTL_MS', 3_600_000);

// ════════════════════════════════════════════════════════════════════════════
// 类型
// ════════════════════════════════════════════════════════════════════════════

export interface PhaseFrame {
  id: number;
  /** 粗分类: 'iteration' | 'llm' | 'tool' | 'lock' | 'subagent' | 'pause' | ... */
  phase: string;
  /** 人读标签: 'tool:edit_file' / 'lock:/a.ts' / 'llm:stream' */
  label: string;
  startedAt: number;
  meta?: Record<string, unknown>;
}

export interface RunTraceSnapshot {
  runId: string;
  /** 父 run(子 agent/explore 自动挂上来),顶层 main run 为 undefined */
  parentRunId?: string;
  sessionId?: string;
  agentName?: string;
  /** 自 run 开始的总时长 */
  ageMs: number;
  /** 距最近一次活动(phase 变更 / 计数器更新)的时长 — idle 越大越可疑 */
  idleMs: number;
  iteration: number;
  toolCalls: number;
  stopReason: string | null;
  ended: boolean;
  /** 当前所有活跃 phase 帧(并行工具会有多帧),按进入时间升序 */
  frames: Array<{ phase: string; label: string; ageMs: number }>;
  /** 当前迭代和活跃阶段组成的可读位置链。 */
  current: string;
}

// ════════════════════════════════════════════════════════════════════════════
// RunTrace — 单个 run 的实时状态
// ════════════════════════════════════════════════════════════════════════════

let runSeq = 0;
let frameSeq = 0;

export class RunTrace {
  readonly runId: string;
  parentRunId?: string;
  sessionId?: string;
  agentName?: string;
  readonly startedAt: number;
  iteration = 0;
  toolCalls = 0;
  stopReason: string | null = null;
  ended = false;
  endedAt = 0;
  /** 最近一次状态变更时间,用于算 idleMs(判定"卡住" vs "正常慢") */
  lastActivityAt: number;
  /** 活跃 phase 帧。并行工具 → 多帧共存,故按 id 增删而非严格 LIFO。 */
  readonly frames: PhaseFrame[] = [];
  meta: Record<string, unknown>;

  constructor(opts: { sessionId?: string; agentName?: string; parentRunId?: string; meta?: Record<string, unknown> }) {
    this.runId = `run_${++runSeq}`;
    this.parentRunId = opts.parentRunId;
    this.sessionId = opts.sessionId;
    this.agentName = opts.agentName;
    this.startedAt = Date.now();
    this.lastActivityAt = this.startedAt;
    this.meta = opts.meta ?? {};
  }

  private touch(): void {
    this.lastActivityAt = Date.now();
  }

  /** runner 每轮 iteration++ 后调,更新轮次计数(顺便 touch,证明 run 还活着)。 */
  setIteration(n: number): void {
    this.iteration = n;
    this.touch();
  }

  incToolCalls(n = 1): void {
    this.toolCalls += n;
    this.touch();
  }

  /** 进入一层 → push 一帧,返回帧 id;务必在 finally 里用该 id popPhase。 */
  pushPhase(phase: string, label: string, meta?: Record<string, unknown>): number {
    const id = ++frameSeq;
    this.frames.push({ id, phase, label, startedAt: Date.now(), meta });
    this.touch();
    return id;
  }

  popPhase(id: number): void {
    const idx = this.frames.findIndex((f) => f.id === id);
    if (idx >= 0) this.frames.splice(idx, 1);
    this.touch();
  }

  snapshot(now = Date.now()): RunTraceSnapshot {
    const frames = [...this.frames]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((f) => ({ phase: f.phase, label: f.label, ageMs: now - f.startedAt }));
    const current = frames.length > 0
      ? `loop#${this.iteration} › ${frames.map((f) => f.label).join(' › ')}`
      : `loop#${this.iteration} (between phases)`;
    return {
      runId: this.runId,
      parentRunId: this.parentRunId,
      sessionId: this.sessionId,
      agentName: this.agentName,
      ageMs: now - this.startedAt,
      idleMs: now - this.lastActivityAt,
      iteration: this.iteration,
      toolCalls: this.toolCalls,
      stopReason: this.stopReason,
      ended: this.ended,
      frames,
      current,
    };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 全局注册表 + ALS
// ════════════════════════════════════════════════════════════════════════════

const activeRuns = new Map<string, RunTrace>();
const als = new AsyncLocalStorage<RunTrace>();

/**
 * 开一个新 run trace。runner.run() 入口调用一次,把返回的 trace 存到 this 上。
 * 同 session 若有未结束的旧 run(被弃),在此 supersede 掉,防注册表泄漏。
 */
export function beginRun(opts: {
  sessionId?: string;
  agentName?: string;
  /** 显式父 run;不传则自动从当前 ALS 推断(子 agent/explore 在父 invokeTool 上下文里 spawn)。 */
  parentRunId?: string;
  meta?: Record<string, unknown>;
} = {}): RunTrace {
  //  子 agent/explore 的 runner.run() 在父 invokeTool 的 ALS 上下文里被消费 →
  //    此刻 getCurrentRunTrace() 就是父 run,零穿透自动建立父子链。顶层 main run 无父。
  const parentRunId = opts.parentRunId ?? als.getStore()?.runId;
  // 父子同 session 时不要 supersede(子 agent 可能复用父 session)。只对"无父的新顶层 run"做 supersede。
  if (opts.sessionId && !parentRunId) {
    for (const t of activeRuns.values()) {
      if (t.sessionId === opts.sessionId && !t.ended) {
        t.ended = true;
        t.endedAt = Date.now();
        activeRuns.delete(t.runId);
        traceLog('info', TAG, `↩️ superseded abandoned run ${t.runId} (new run on session ${opts.sessionId})`, {
          superseded: t.snapshot(),
        });
      }
    }
  }
  const trace = new RunTrace({ ...opts, parentRunId });
  activeRuns.set(trace.runId, trace);
  ensureWatchdog();
  return trace;
}

/** run 结束(正常 / break / 抛错)必调。幂等。 */
export function endRun(trace: RunTrace | null | undefined, stopReason?: string | null): void {
  if (!trace) return;
  if (stopReason !== undefined) trace.stopReason = stopReason;
  trace.ended = true;
  trace.endedAt = Date.now();
  activeRuns.delete(trace.runId);
}

/** 当前 async 上下文所属的 run(深层工具/锁代码就近归属用)。 */
export function getCurrentRunTrace(): RunTrace | undefined {
  return als.getStore();
}

/** 在指定 trace 的 ALS 上下文里跑 fn。runner.invokeTool 用它包住 tool.function。 */
export function runWithRunTrace<T>(trace: RunTrace | null | undefined, fn: () => T): T {
  if (!trace) return fn();
  return als.run(trace, fn);
}

/**
 * 给一段 await 套 phase 帧(就近归属到当前 run)。无当前 run 时退化为直接 await。
 * 例: await withRunPhase('lock', `lock:${path}`,  => lockMgr.acquire(path))
 */
export async function withRunPhase<T>(
  phase: string,
  label: string,
  fn: () => Promise<T>,
  meta?: Record<string, unknown>,
): Promise<T> {
  const trace = als.getStore();
  if (!trace) return fn();
  const id = trace.pushPhase(phase, label, meta);
  try {
    return await fn();
  } finally {
    trace.popPhase(id);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 诊断聚合 — "把所有 run 和所有挂起操作摊开"
// ════════════════════════════════════════════════════════════════════════════

export function getActiveRunDiagnostics(minAgeMs = 0, minIdleMs = 0): RunTraceSnapshot[] {
  const now = Date.now();
  const out: RunTraceSnapshot[] = [];
  for (const t of activeRuns.values()) {
    if (now - t.startedAt < minAgeMs) continue;
    const snap = t.snapshot(now);
    /* minIdleMs > 0 = "只报真卡住的": 跑得久不算卡, 久没动才算卡。
       /diag 等显式查询传 0 → 照旧列出全部活跃 run。 */
    if (minIdleMs > 0 && snap.idleMs < minIdleMs) continue;
    out.push(snap);
  }
  return out.sort((a, b) => b.ageMs - a.ageMs);
}

/** 一站式运行时健康快照:活跃 run + stallGuard 的 inflight 挂起操作。供 /diag 命令直接打。 */
export function getRuntimeDiagnostics(minAgeMs = 0): {
  runs: RunTraceSnapshot[];
  inflight: ReturnType<typeof getInflightStalls>;
} {
  return {
    runs: getActiveRunDiagnostics(minAgeMs),
    inflight: getInflightStalls(minAgeMs),
  };
}

/** 把当前健康快照打到日志(warn)。返回 run + inflight 的命中条数。
 *
 *  minIdleMs > 0 时进入"只报真卡住"模式(周期看门狗用): run 必须久没 touch,
 *  且不再重复列 kind:'watchdog' 的 inflight —— 那类条目(如 runAttempt 包整个 run)
 *  生命周期本来就跟 run 一样长, 按年龄筛必然每次命中, 而它们自己已经在
 *  withWatchdog 里按自己的 warnAfterMs 打过日志了, 这里再列一遍纯属重复刷屏。 */
export function dumpRuntimeDiagnostics(minAgeMs = 0, tag = TAG, minIdleMs = 0): number {
  const runs = getActiveRunDiagnostics(minAgeMs, minIdleMs);
  const inflight = getInflightStalls(minAgeMs).filter(s => {
    if (minIdleMs <= 0) return true; // /diag 等显式查询: 全列
    /* kind:'watchdog' 生命周期跟 run 一样长(如 runAttempt 包整个 run), 按年龄筛必然每次命中,
       而它们自己已按 warnAfterMs 打过日志 —— 这里再列一遍纯属重复。 */
    if (s.kind === 'watchdog') return false;
    /* 带硬 deadline 的操作接近预算上限时才上报, 避免正常等待制造噪声。 */
    if (s.timeoutMs && s.timeoutMs > 0) {
      return s.ageMs >= s.timeoutMs * TIMEOUT_WARN_FRACTION;
    }
    return true;
  });
  if (runs.length === 0 && inflight.length === 0) return 0;
  traceLog(
    'warn',
    tag,
    `🩺 runtime diagnostics: ${runs.length} active run(s), ${inflight.length} in-flight stall(s) (>= ${minAgeMs}ms)`,
    { runs, inflight },
  );
  return runs.length + inflight.length;
}

// ════════════════════════════════════════════════════════════════════════════
// 看门狗 — 周期性 dump 卡住的 run(首个 run 开始时惰性自启)
// ════════════════════════════════════════════════════════════════════════════

let watchdogTimer: ReturnType<typeof setInterval> | undefined;
let watchdogStarted = false;

function sweepStaleRuns(): void {
  const now = Date.now();
  for (const [id, t] of activeRuns) {
    if (now - t.startedAt > RUN_TTL_MS) {
      activeRuns.delete(id);
      traceLog('warn', TAG, `🧹 evicted zombie run ${id} (age > ${RUN_TTL_MS}ms, never endRun'd)`, {
        zombie: t.snapshot(now),
      });
    }
  }
}

/** 惰性启动看门狗(beginRun 时调,幂等)。WATCH_INTERVAL_MS<=0 则不启。 */
function ensureWatchdog(): void {
  if (watchdogStarted || WATCH_INTERVAL_MS <= 0) return;
  watchdogStarted = true;
  watchdogTimer = setInterval(() => {
    try {
      sweepStaleRuns();
      dumpRuntimeDiagnostics(WATCH_MIN_AGE_MS, TAG, WATCH_MIN_IDLE_MS);
    } catch { /* 看门狗自身异常绝不外溢 */ }
  }, WATCH_INTERVAL_MS);
  if (typeof watchdogTimer?.unref === 'function') watchdogTimer.unref();
}

// ─── 测试辅助 ───
export function __resetRunTraceForTest(): void {
  activeRuns.clear();
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = undefined;
  watchdogStarted = false;
  runSeq = 0;
  frameSeq = 0;
}

/** 仅供测试 / 调试:当前活跃 run 数量。 */
export function __activeRunCount(): number {
  return activeRuns.size;
}
