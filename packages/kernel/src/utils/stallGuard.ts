/**
 * stallGuard — 统一"停顿诊断 + 看门狗"基础设施
 *
 * ## 职责
 *
 * agent harness 最致命的体验是"卡死":某个 await 永远不 resolve,整条链挂起,
 * 用户看到转圈但日志里什么都没有,无从定位。本模块提供三件套,统一所有
 * "可能挂起"的等待点(锁 / 暂停 / 工具执行 / side-agent / LLM):
 *
 *   1. withTimeout() — 硬超时兜底:超时即 reject + 结构化日志, 让上层能恢复
 *   2. withWatchdog() — 软看门狗:不改变行为, 只在等待过久时定期打"还在等"心跳日志
 *   3. inflight 注册表 — 任意时刻可 dump 出"当前有哪些操作挂着、挂了多久、上下文是啥"
 *
 * ## 可观测性原则
 *   · 卡死是异常事件 → 日志双写 cliLogger(cli-*.log) + neoxLogger(neox-app-*.log),
 *     CLI 和 Electron server 子进程都能保留诊断记录。
 *   · 每条停顿日志都带 stallId, 方便 grep 串起 "开始等 → 还在等 → 超时/完成" 全过程。
 *   · 所有定时器 unref(), 绝不因为看门狗而阻止进程退出。
 *
 * ## 用法
 * ```ts
 * // 硬超时(会 reject)
 * const r = await withTimeout(() => doWork(), { label: 'tool:execute_shell', timeoutMs: 600_000 });
 *
 * // 软看门狗(不 reject, 只记日志)
 * await withWatchdog(longTask, { label: 'pause:waitForResume', warnAfterMs: 30_000 });
 *
 * // 排障: 把当前挂超过 10s 的操作全部打到日志
 * dumpInflightStalls(10_000);
 * ```
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cliLogger } from '../platform/cliLogger.js';
import { neoxLogger } from '../platform/neoxLogger.js';
import { NEOX_HOME_DIRNAME } from '../platform/neoxHome.js';

const STALL_TAG = 'STALL';

// ════════════════════════════════════════════════════════════════════════════
// 永远在线的卡死专用文件 sink — ~/.neox/logs/stall.log
//
// 为什么独立于 cliLogger/neoxLogger:
//   那两个 logger 分别要 CLI_DEBUG=1 / Electron enabled 才落盘。但卡死恰恰发生在
//   "你没预先开 debug" 的时候 → 事后无据可查。STALL 事件稀有低频(只在真卡时触发),
//   所以无条件直写一个专用文件, 保证任何运行模式下卡死都留痕。NEOX_STALL_LOG=0 可关。
//   直写 fs(非 console.*) 符合 infra 诊断不污染渲染的铁律。
// ════════════════════════════════════════════════════════════════════════════

const STALL_LOG_PATH = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'logs', 'stall.log');
const STALL_LOG_MAX_BYTES = 20 * 1024 * 1024; // 20MB 滚动一次
let stallFileDirEnsured = false;
let stallFileGiveUp = false;
/** 连续写失败计数 — 到 STALL_FILE_MAX_FAILURES 才真放弃(不再一次失败就永久静默) */
let stallFileWriteFailures = 0;
const STALL_FILE_MAX_FAILURES = 5;

function appendStallFile(
  level: string,
  tag: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  if (stallFileGiveUp || process.env.NEOX_STALL_LOG === '0') return;
  try {
    if (!stallFileDirEnsured) {
      fs.mkdirSync(path.dirname(STALL_LOG_PATH), { recursive: true });
      stallFileDirEnsured = true;
    }
    // 体积护栏: 超限就滚动到 .1(单备份, 卡死日志不需要长历史)
    try {
      const st = fs.statSync(STALL_LOG_PATH);
      if (st.size > STALL_LOG_MAX_BYTES) fs.renameSync(STALL_LOG_PATH, `${STALL_LOG_PATH}.1`);
    } catch { /* 文件不存在 = 首次写, 忽略 */ }
    const pid = typeof process !== 'undefined' ? process.pid : 0;
    const line = JSON.stringify({ ts: new Date().toISOString(), level, tag, pid, message, ...data });
    fs.appendFileSync(STALL_LOG_PATH, line + '\n');
    stallFileWriteFailures = 0;
  } catch {
    /* 写入失败时先重建日志目录并重试；连续失败达到阈值后才停止写入。 */
    stallFileWriteFailures += 1;
    if (stallFileWriteFailures === 1) {
      // 多半是目录被删了 — 重建目录, 下次写入即可自愈
      stallFileDirEnsured = false;
      try {
        fs.mkdirSync(path.dirname(STALL_LOG_PATH), { recursive: true });
        stallFileDirEnsured = true;
      } catch { /* 真不可写, 交给下面的计数 */ }
      return;
    }
    if (stallFileWriteFailures >= STALL_FILE_MAX_FAILURES) {
      // 目录不可写 / 沙箱等 → 放弃, 绝不外溢(诊断设施自身不能成为故障源)
      stallFileGiveUp = true;
    }
  }
}

/** stall.log 的绝对路径, 供 /diag 等提示用户去哪看。 */
export function getStallLogPath(): string {
  return STALL_LOG_PATH;
}

/** 暴露给同源诊断模块(runTrace)复用同一个永远在线文件 sink。 */
export function writeStallFile(
  level: string,
  tag: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  appendStallFile(level, tag, message, data);
}

/**
 * 双写日志 — 同一条停顿事件同时进 cli-*.log 和 neox-app-*.log,
 * 哪个 logger 在当前进程里 enabled 就被哪个捕获(CLI 进程 / Electron server 子进程)。
 * 两个 logger 内部都有 enabled 判定和文件大小护栏, 重复调用是安全的。
 */
function stallLog(
  level: 'warn' | 'error' | 'info',
  tag: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  try { cliLogger[level](tag, message, data); } catch { /* logger 自身异常绝不外溢 */ }
  try { neoxLogger[level](tag, message, data); } catch { /* ignore */ }
  appendStallFile(level, tag, message, data); // 永远在线: 不依赖 CLI_DEBUG
}

// ════════════════════════════════════════════════════════════════════════════
// 错误类型
// ════════════════════════════════════════════════════════════════════════════

/**
 * 超时错误 — 带足够定位信息(label / 已等时长 / 上限 / 上下文)。
 * name 固定 'StallTimeoutError', 上层可用 isStallTimeoutError() 判定。
 */
export class StallTimeoutError extends Error {
  readonly label: string;
  readonly elapsedMs: number;
  readonly timeoutMs: number;
  readonly stallId: number;
  readonly context?: Record<string, unknown>;

  constructor(params: {
    label: string;
    elapsedMs: number;
    timeoutMs: number;
    stallId: number;
    context?: Record<string, unknown>;
  }) {
    super(
      `Operation "${params.label}" timed out after ${params.elapsedMs}ms (limit ${params.timeoutMs}ms) [stall#${params.stallId}]`,
    );
    this.name = 'StallTimeoutError';
    this.label = params.label;
    this.elapsedMs = params.elapsedMs;
    this.timeoutMs = params.timeoutMs;
    this.stallId = params.stallId;
    this.context = params.context;
  }
}

export function isStallTimeoutError(err: unknown): err is StallTimeoutError {
  return err instanceof StallTimeoutError
    || (typeof err === 'object' && err !== null && (err as any).name === 'StallTimeoutError');
}

// ════════════════════════════════════════════════════════════════════════════
// inflight 注册表 — "当前有哪些操作挂着"
// ════════════════════════════════════════════════════════════════════════════

interface InflightEntry {
  id: number;
  label: string;
  startedAt: number;
  kind: 'timeout' | 'watchdog';
  timeoutMs?: number;
  context?: Record<string, unknown>;
}

const inflight = new Map<number, InflightEntry>();
let stallSeq = 0;

function register(entry: Omit<InflightEntry, 'id'>): number {
  const id = ++stallSeq;
  inflight.set(id, { ...entry, id });
  return id;
}

function deregister(id: number): void {
  inflight.delete(id);
}

/**
 * 返回当前挂起(尚未 settle)且年龄 >= minAgeMs 的操作快照。
 * 用于排障 / 健康检查 / 在卡死时主动 dump。
 */
export function getInflightStalls(minAgeMs = 0): Array<{
  stallId: number;
  label: string;
  ageMs: number;
  kind: 'timeout' | 'watchdog';
  timeoutMs?: number;
  context?: Record<string, unknown>;
}> {
  const now = Date.now();
  const out: ReturnType<typeof getInflightStalls> = [];
  for (const e of inflight.values()) {
    const ageMs = now - e.startedAt;
    if (ageMs >= minAgeMs) {
      out.push({
        stallId: e.id,
        label: e.label,
        ageMs,
        kind: e.kind,
        timeoutMs: e.timeoutMs,
        context: e.context,
      });
    }
  }
  return out.sort((a, b) => b.ageMs - a.ageMs);
}

/**
 * 把当前挂起超过 minAgeMs 的操作全部打到日志(warn)。
 * 返回命中的条数。可由全局健康监控周期性调用, 或在捕获到异常时手动调一次。
 */
export function dumpInflightStalls(minAgeMs = 0, tag = STALL_TAG): number {
  const stalls = getInflightStalls(minAgeMs);
  if (stalls.length === 0) return 0;
  stallLog('warn', tag, `⏱️ ${stalls.length} in-flight operation(s) pending >= ${minAgeMs}ms`, {
    stalls: stalls.map((s) => ({
      stallId: s.stallId,
      label: s.label,
      ageMs: s.ageMs,
      kind: s.kind,
      timeoutMs: s.timeoutMs,
      context: s.context,
    })),
  });
  return stalls.length;
}

// ════════════════════════════════════════════════════════════════════════════
// withTimeout — 硬超时兜底
// ════════════════════════════════════════════════════════════════════════════

export interface WithTimeoutOptions {
  /** 操作标签, 例如 'tool:execute_shell' / 'mutex:loopDetector' */
  label: string;
  /** 超时上限(ms)。<=0 视为无超时(退化为直接 await, 但仍登记 inflight)。 */
  timeoutMs: number;
  /** 附加上下文, 会进日志(注意别放敏感信息) */
  context?: Record<string, unknown>;
  /** 日志 tag, 默认 'STALL' */
  tag?: string;
  /** 超时触发时在 reject 前调用的回调, 可用于 abort 底层任务。 */
  onTimeout?: () => void;
  /** 超时后是否 reject(默认 true)。false → resolve fallback 值。 */
  rejectOnTimeout?: boolean;
  /** rejectOnTimeout=false 时, 超时返回的值 */
  fallbackValue?: unknown;
}

/**
 * 给一个 Promise / Promise 工厂套硬超时。
 * 超时:打 error 日志 + 调 onTimeout() + reject(StallTimeoutError)。
 * 正常 settle:清定时器 + 注销 inflight, 原值/原异常透传。
 *
 * 注意:超时后底层任务可能仍在后台跑(JS 无法强杀 Promise)。onTimeout 给调用方
 * 机会去 abort 真正的资源(child_process / fetch)。
 */
export async function withTimeout<T>(
  task: Promise<T> | (() => Promise<T>),
  opts: WithTimeoutOptions,
): Promise<T> {
  const { label, timeoutMs, context, tag = STALL_TAG } = opts;
  const startedAt = Date.now();
  const stallId = register({ label, startedAt, kind: 'timeout', timeoutMs, context });

  const promise = typeof task === 'function' ? task() : task;

  // 无超时:仍登记 inflight 便于 dump, 但不挂定时器
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    try {
      return await promise;
    } finally {
      deregister(stallId);
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (settled) return;
      const elapsedMs = Date.now() - startedAt;
      stallLog('error', tag, `🛑 STALL TIMEOUT: "${label}" exceeded ${timeoutMs}ms`, {
        stallId,
        label,
        elapsedMs,
        timeoutMs,
        context,
      });
      try { opts.onTimeout?.(); } catch (e: any) {
        stallLog('warn', tag, `onTimeout() threw for "${label}": ${e?.message ?? e}`, { stallId });
      }
      // 统一抛 StallTimeoutError; rejectOnTimeout=false 时由外层 catch 转成 fallback 值。
      reject(new StallTimeoutError({ label, elapsedMs, timeoutMs, stallId, context }));
    }, timeoutMs);
    // 看门狗定时器绝不阻止进程退出
    if (typeof timer?.unref === 'function') timer.unref();
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    settled = true;
    return result as T;
  } catch (err) {
    settled = true;
    if (isStallTimeoutError(err) && opts.rejectOnTimeout === false) {
      return opts.fallbackValue as T;
    }
    throw err;
  } finally {
    settled = true;
    if (timer) clearTimeout(timer);
    deregister(stallId);
    // 静默消费底层 promise 的后续 rejection, 避免超时后 unhandledRejection
    Promise.resolve(promise).catch(() => { /* swallowed: outer already settled */ });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// withWatchdog — 软看门狗(不改变行为, 只观测)
// ════════════════════════════════════════════════════════════════════════════

export interface WithWatchdogOptions {
  /** 操作标签 */
  label: string;
  /** 等待超过此时长(ms)开始打第一条"还在等"日志 */
  warnAfterMs: number;
  /** 之后每隔多久再打一条(默认 = warnAfterMs)。 */
  repeatEveryMs?: number;
  /** 打几条后停止重复(默认 5 条, 防止日志刷屏)。<=0 表示不限。 */
  maxWarns?: number;
  /** 附加上下文 */
  context?: Record<string, unknown>;
  /** 日志 tag */
  tag?: string;
  /**
   * 返回 true 时**跳过这一次**告警(不计入 warnCount, 也不停止后续轮询)。
   *
   *  加: 包住"整个 agent run"这类操作时, 纯按时长告警必然误报 —— 一次健康的
   *   17 分钟长任务会稳定刷出 "still pending after 180s/360s/..."。调用方用它接上真正的
   *   进度信号(runTrace 的 idleMs), 做到"跑得久不喊, 真不动才喊"。
   */
  suppressWhen?: () => boolean;
}

/**
 * 给一个 Promise 套软看门狗:不改变它的 resolve/reject 行为, 只在它迟迟不
 * settle 时定期打" still pending"日志。用于那些"不该强行超时但必须可观测"
 * 的等待(例如用户主动 pause、side-agent fire-and-forget)。
 */
export async function withWatchdog<T>(
  task: Promise<T> | (() => Promise<T>),
  opts: WithWatchdogOptions,
): Promise<T> {
  const { label, warnAfterMs, context, tag = STALL_TAG, suppressWhen } = opts;
  const repeatEveryMs = opts.repeatEveryMs && opts.repeatEveryMs > 0 ? opts.repeatEveryMs : warnAfterMs;
  const maxWarns = opts.maxWarns === undefined ? 5 : opts.maxWarns;
  const startedAt = Date.now();
  const stallId = register({ label, startedAt, kind: 'watchdog', context });

  const promise = typeof task === 'function' ? task() : task;

  let warnCount = 0;
  let interval: ReturnType<typeof setInterval> | undefined;

  const tick = () => {
    /* 有进度就闭嘴 — 不计 warnCount, 保持轮询, 真停了才会喊 */
    if (suppressWhen) {
      try {
        if (suppressWhen()) return;
      } catch { /* 判定函数异常 → 当作"无法确认有进度", 照常告警 */ }
    }
    warnCount += 1;
    const elapsedMs = Date.now() - startedAt;
    stallLog('warn', tag, `⌛ STALL WATCH: "${label}" still pending after ${elapsedMs}ms`, {
      stallId,
      label,
      elapsedMs,
      warnCount,
      context,
    });
    if (maxWarns > 0 && warnCount >= maxWarns && interval) {
      clearInterval(interval);
      interval = undefined;
      stallLog('warn', tag, `⌛ STALL WATCH: "${label}" — stop logging after ${warnCount} warns (still pending)`, {
        stallId,
        label,
      });
    }
  };

  const firstTimer = setTimeout(() => {
    tick();
    if (maxWarns === 1) return;
    interval = setInterval(tick, repeatEveryMs);
    if (typeof interval?.unref === 'function') interval.unref();
  }, warnAfterMs);
  if (typeof firstTimer?.unref === 'function') firstTimer.unref();

  try {
    return await promise;
  } finally {
    clearTimeout(firstTimer);
    if (interval) clearInterval(interval);
    deregister(stallId);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 环境变量读取助手 — 统一各处超时配置的解析口径
// ════════════════════════════════════════════════════════════════════════════

/**
 * 从环境变量读一个毫秒数, 非法 / 缺失时回退 fallback。
 * 约定: 显式设为 "0" 表示"禁用超时"(返回 0, 调用方据此退化为无限等待)。
 */
export function envTimeoutMs(envKey: string, fallbackMs: number): number {
  const raw = process.env[envKey];
  if (raw === undefined || raw === '') return fallbackMs;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallbackMs;
  return Math.floor(n);
}
