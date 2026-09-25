
import { processManager } from '@neoxlabs/platform/platform/processManager.js';
import type { TrackedProcess } from '@neoxlabs/platform/platform/processManager.js';
import { probeListeningPort } from '@neoxlabs/platform/platform/portProbe.js';
import { getProcessInfoBatch, getProcessInfoBatchAsync, isPidAlive, normalizeWorkspaceRoot } from '@neoxlabs/platform/platform/processTree.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { deriveFriendlyName } from '@neoxlabs/platform/platform/processFriendlyName.js';
import { getBackgroundTaskNotifier } from '../shell/backgroundTaskNotifier.js';
import { getServiceConfigStore } from './serviceConfigStoreCache.js';
import * as path from 'node:path';
import type { TrackedProcessKind } from '@neoxlabs/platform/platform/processManager.js';

export interface ProcessFact {
  pid: number;
  id: string;
  command: string;
  /** IDEA 风格短名，UI 列表/详情标题优先用 */
  friendly_name: string;
  name: string;
  display_name?: string;
  cwd: string;
  workspaceRoot: string;
  origin: 'spawned' | 'adopted';
  kind: TrackedProcessKind;
  /** 起这个进程的会话 —— UI 据此只在自己会话里显示临时任务. 拿不到归属时 undefined. */
  owner_session_id?: string;
  /**
   * 是否已"转正"为工程级常驻 (跨会话可见).
   *
   *   默认 false —— 所有后台任务都是会话级临时的。晋升**只**认用户显式确认:
   *   手动转正, 或 serviceAdoptTool 接管外部进程 (那本身就是用户动作)。
   *   刻意不按端口/config_id/存活时长自动判定 —— 那是在猜意图, 而一个跑三分钟的
   *   构建照样占端口、照样活很久, 它并不是"服务"。(参照 IDEA: 启动的默认临时,
   *   手动转正才常驻。)
   */
  persistent?: boolean;
  startTime: number;
  endTime?: number;
  /** 从 endTime + exitCode 派生, 在快照这一处算一次 —— 不是独立维护的状态。 */
  status: 'running' | 'completed' | 'failed' | 'killed';
  /** SIGTSTP 挂起中 —— 由 ps STAT 观测得来, 不是 UI 侧记着"我点过暂停"。 */
  paused?: boolean;
  /** 最近一行 stdout, 给时间线那条后台任务栏做单行预览。全量输出在 log_file_path。 */
  lastOutputLine?: string;
  exitCode?: number;
  uptime_sec?: number;
  port?: number;
  config_id?: string;
  healthy?: boolean;
  health_checked_at?: number;
  log_file_path?: string;
  background: boolean;
}

export interface ServiceSnapshot {
  /** 快照产出时刻。UI 拿它判断"服务端是不是还活着" —— 超过 10s 没动就该明说无响应，
   *  而不是继续展示一份陈旧的"一切正常"。 */
  generatedAt: number;
  processes: ProcessFact[];
}

export function isService(p: ProcessFact): boolean {
  if (p.kind === 'free-shell') return false;
  if (p.kind === 'agent-task') return false;   /* 派给外部 agent 的一次性委派, 跑再久也不是服务 */
  if (p.config_id) return true;
  return p.persistent === true;
}

function lastLineOf(buf: string[] | undefined): string | undefined {
  if (!buf || buf.length === 0) return undefined;
  for (let i = buf.length - 1; i >= 0; i--) {
    const t = buf[i]?.trim();
    if (t) return t.length > 200 ? t.slice(0, 200) : t;
  }
  return undefined;
}

function toFact(p: TrackedProcess, now: number, paused: boolean): ProcessFact {
  const startMs = p.startTime.getTime();
  const friendly = deriveFriendlyName({
    command: p.command,
    configName: p.name,
    refinedName: p.refinedName,
  });
  return {
    pid: p.pid,
    id: String(p.pid),
    command: p.command,
    friendly_name: friendly,
    name: p.name || friendly,
    display_name: p.name,
    cwd: p.cwd,
    workspaceRoot: p.workspaceRoot || p.cwd,
    origin: p.origin ?? 'spawned',
    kind: p.kind ?? 'background-task',
    owner_session_id: getBackgroundTaskNotifier().ownerSessionOf(p.pid) ?? undefined,
    /* adopt 外部进程本身就是用户显式动作, 等同已转正 */
    persistent: (p.origin === 'adopted') || getBackgroundTaskNotifier().isPromoted(p.pid),
    startTime: startMs,
    endTime: p.endTime?.getTime(),
    status: p.status,
    paused: p.status === 'running' ? paused : undefined,
    lastOutputLine: p.status === 'running' ? lastLineOf(p.outputBuffer) : undefined,
    exitCode: p.exitCode,
    uptime_sec: p.status === 'running' ? Math.max(0, Math.floor((now - startMs) / 1000)) : undefined,
    port: p.port,
    config_id: p.configId,
    healthy: p.healthy,
    health_checked_at: p.healthCheckedAt,
    log_file_path: p.logFilePath,
    background: p.background,
  };
}

const EXITED_RETENTION_MS = 5 * 60 * 1000;

export function buildSnapshot(workspaceRoot?: string): ServiceSnapshot {
  const now = Date.now();
  const all = processManager.getAll();
  /* 一次 ps 拿全部在跑进程的 STAT (暂停态). 逐个 fork ps 会让 tick 成本跟进程数成正比. */
  const runningPids = all.filter(p => p.status === 'running').map(p => p.pid);
  const live = runningPids.length > 0 ? getProcessInfoBatch(runningPids) : new Map();
  /* 归一后再比 —— 路径不能用 === 比, 见 normalizeWorkspaceRoot 的说明 */
  const targetWs = workspaceRoot ? normalizeWorkspaceRoot(workspaceRoot) : undefined;
  const out: ProcessFact[] = [];
  for (const p of all) {
    if (targetWs && normalizeWorkspaceRoot(p.workspaceRoot || p.cwd) !== targetWs) continue;
    const ended = p.endTime?.getTime();
    if (ended !== undefined && now - ended > EXITED_RETENTION_MS) continue;
    out.push(toFact(p, now, live.get(p.pid)?.stopped === true));
  }
  out.sort((a, b) => b.startTime - a.startTime);
  return { generatedAt: now, processes: out };
}

/* ── tick ────────────────────────────────────────────────────────────────
 * 两件事，两个频率:
 *   判活   kill(pid,0)  纳秒级，每轮全量
 *   探端口 lsof         100-300ms，只对"还没探到端口的"，按 2/6/15/30s 退避，四轮放弃
 * 混在一个频率上会让 lsof 把事件循环占满 —— 10 个进程 × 每 2s 一轮就是灾难。 */
const TICK_MS = 2_000;
const PORT_PROBE_SCHEDULE_MS = [2_000, 6_000, 15_000, 30_000];

let tickTimer: ReturnType<typeof setInterval> | null = null;
const probeRounds = new Map<number, number>();
const probeInFlight = new Set<number>();

interface SnapshotSubscriber {
  workspaceRoot?: string;
  publish: (snap: ServiceSnapshot) => void;
  lastSignature: string;
}
const subscribers = new Set<SnapshotSubscriber>();

/** 快照指纹 —— 没变化就不推。否则 renderer 每 2s 重渲整个列表，xterm 会抖。
 *  按订阅者各自算: A 工程的服务变了不该把 B 工程的列表也重渲一遍。 */
function signatureOf(snap: ServiceSnapshot): string {
  return snap.processes
    .map(p => `${p.pid}:${p.endTime ?? 0}:${p.exitCode ?? ''}:${p.port ?? ''}:${p.config_id ?? ''}:${p.healthy ?? ''}:${p.paused ? 1 : 0}:${p.lastOutputLine ?? ''}`)
    .join('|');
}

/**
 * 判活 —— 带 pid 复用防线。
 *
 * 光看 kill(pid,0) 会被 pid 复用骗: 进程早死了，pid 被系统分配给了别人，判活会说"活着"，
 * UI 就永远显示一个不存在的服务在跑。启动时间对不上 = 这个 pid 已经是别人的了。
 * 拿不到启动时间 (ps 不可用 / Windows) 时保守当活着，宁可晚一点标记退出也不误报死亡。
 */
function stillAlive(p: TrackedProcess, live: Map<number, { startTimeMs?: number }>): boolean {
  if (!isPidAlive(p.pid)) return false;
  const actualStart = live.get(p.pid)?.startTimeMs;
  if (actualStart === undefined) return true;
  return Math.abs(actualStart - p.startTime.getTime()) <= 2_000;
}

/* tick 改 async 后必须防重入: ps/wmic 偶尔慢过 2s, 两轮叠在一起会重复 markVanished /
 * 重复排端口探测。上一轮没跑完就跳过这一轮 —— 快照本来就是"最多晚 2 秒"的语义。 */
let tickRunning = false;

async function runTick(): Promise<void> {
  if (tickRunning) return;
  tickRunning = true;
  try {
    await runTickInner();
  } finally {
    tickRunning = false;
  }
}

async function runTickInner(): Promise<void> {
  const running = processManager.getAll().filter(p => p.status === 'running');
  /* 一次 ps 供整轮判活使用 (启动时间用于 pid 复用校验)。
   * async 变体: 这个 tick 每 2s 跑一次, 同步 fork 会周期性地钉住 runtime 线程。 */
  const live = running.length > 0 ? await getProcessInfoBatchAsync(running.map(p => p.pid)) : new Map();

  for (const p of running) {
    if (!stillAlive(p, live)) {
      processManager.markVanished(p.pid);
      probeRounds.delete(p.pid);
    }
  }

  /* 2) 探端口: 只对还没端口的、还在跑的。退避表走完就放弃 (worker/cron 类本来就不监听端口)。 */
  for (const p of processManager.getAll()) {
    if (p.status !== 'running') continue;
    if (p.port !== undefined) continue;
    if (p.kind === 'free-shell') continue;
    if (probeInFlight.has(p.pid)) continue;
    const round = probeRounds.get(p.pid) ?? 0;
    if (round >= PORT_PROBE_SCHEDULE_MS.length) continue;
    const aliveMs = Date.now() - p.startTime.getTime();
    if (aliveMs < PORT_PROBE_SCHEDULE_MS[round]) continue;
    probeRounds.set(p.pid, round + 1);
    probeInFlight.add(p.pid);
    void probeListeningPort(p.pid)
      .then((port) => {
        if (port) {
          processManager.setPort(p.pid, port);
          probeRounds.set(p.pid, PORT_PROBE_SCHEDULE_MS.length); /* 探到即停 */
          emitPortDetectedHint(p, port);
        }
      })
      .catch(() => { /* lsof 不可用等，静默 */ })
      .finally(() => { probeInFlight.delete(p.pid); });
  }

  for (const sub of subscribers) {
    const snap = buildSnapshot(sub.workspaceRoot);
    const sig = signatureOf(snap);
    if (sig === sub.lastSignature) continue;
    sub.lastSignature = sig;
    try { sub.publish(snap); } catch (err: any) {
      cliLogger.warn('SVC_SNAPSHOT', `publish failed: ${err?.message ?? err}`);
    }
  }
}

/**
 * 注册一个订阅者并确保 tick 在跑。每个工程窗口调一次。
 *
 * 定时器本身全进程一条 (探端口/判活对所有进程做一遍就够), 但**订阅者是多个**。
 * 返回 unsubscribe —— 窗口关掉要摘掉, 否则往已销毁的 bus 上推。
 *
 * 没有 tracked 进程时 tick 只是一次 map 遍历, 成本可忽略, 不做启停切换 —— 那又是一份状态。
 */
export function startServiceSnapshotTick(
  publish: (snap: ServiceSnapshot) => void,
  workspaceRoot?: string,
): () => void {
  const sub: SnapshotSubscriber = { publish, workspaceRoot, lastSignature: '' };
  subscribers.add(sub);
  if (!tickTimer) {
    tickTimer = setInterval(() => {
      void runTick().catch((err: any) => {
        cliLogger.warn('SVC_SNAPSHOT', `tick failed: ${err?.message ?? err}`);
      });
    }, TICK_MS);
    tickTimer.unref?.();
  }
  return () => { subscribers.delete(sub); };
}

export function stopServiceSnapshotTick(): void {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  subscribers.clear();
  probeRounds.clear();
  probeInFlight.clear();
}

function emitPortDetectedHint(proc: TrackedProcess, port: number): void {
  try {
    if (proc.configId) return;                    /* 已经是声明过的服务, 没什么可问 */
    if (getBackgroundTaskNotifier().isPromoted(proc.pid)) return;  /* 已转正, 别再问 */
    if (portHintSent.has(proc.pid)) return;       /* 一个进程只问一次, 别刷屏 */
    portHintSent.add(proc.pid);
    cliLogger.info('SVC_SNAPSHOT',
      `检测到 ${deriveFriendlyName({ command: proc.command, refinedName: proc.refinedName })} 监听 :${port} — 等用户决定是否转为常驻服务`);
  } catch (err: any) {
    cliLogger.warn('SVC_SNAPSHOT', `端口提示失败 (不影响运行): ${err?.message}`);
  }
}

/** 一个 pid 只提示一次 —— 进程没了就该忘掉, 免得 pid 复用后白捡上一个的"已问过"。 */
const portHintSent = new Set<number>();
