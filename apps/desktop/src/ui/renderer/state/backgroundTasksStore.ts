import { useMemo, useSyncExternalStore } from 'react';
import { dispatchOpFailedFromError } from '../components/notifyEvents';
import type { TrackedProcessKind } from '@neoxlabs/platform/platform/processManager.js';
import { noteStreamDrop } from './streamDropLedger';

export type BackgroundTaskStatus = 'running' | 'paused' | 'completed' | 'failed' | 'killed';

/** 一个进程的事实。注意**没有** classification —— "是不是服务"由 isPersistentService() 当场算。 */
export interface BackgroundTask {
  /** = pid。历史上是自增 taskId，快照化后 pid 就是天然主键，不再需要第二套 id。 */
  taskId: number;
  pid: number;
  command: string;
  name?: string;
  startedAtMs: number;
  endedAtMs?: number;
  status: BackgroundTaskStatus;
  exitCode?: number;
  port?: number;
  configId?: string;
  workspaceRoot?: string;
  origin?: 'spawned' | 'adopted';
  kind?: TrackedProcessKind;
  /** 起它的会话; 缺失 = 归属未知 (兜底显示) */
  ownerSessionId?: string;
  /** 用户确认过的工程级常驻 —— 唯一的跨会话可见途径 */
  persistent?: boolean;
  logFilePath?: string;
  healthy?: boolean;
  /** 最近一行 stdout, 单行预览用。全量在 logFilePath。 */
  lastOutputLine?: string;
}

/** server 快照里的一条事实 (serviceSnapshot.ts 的 ProcessFact)。字段名跟 server 端一致。 */
interface ProcessFactWire {
  pid: number;
  command: string;
  friendly_name?: string;
  name?: string;
  workspaceRoot?: string;
  origin?: 'spawned' | 'adopted';
  kind?: TrackedProcessKind;
  owner_session_id?: string;
  persistent?: boolean;
  startTime: number;
  endTime?: number;
  status?: 'running' | 'completed' | 'failed' | 'killed';
  paused?: boolean;
  lastOutputLine?: string;
  exitCode?: number;
  port?: number;
  config_id?: string;
  healthy?: boolean;
  log_file_path?: string;
}

/** "跑了这么久, 值得让用户瞥一眼"的门槛。注意它**不是**"是不是常驻服务"的判据 —— 见下。 */
export const WORTH_SURFACING_MIN_ALIVE_MS = 15_000;

export const BAR_FADE_AFTER_MS_OK = 5_000;
export const BAR_FADE_AFTER_MS_BAD = 12_000;

export function barFadeRemainMs(t: BackgroundTask, now = Date.now()): number {
  if (!t.endedAtMs) return Infinity;
  const budget = t.status === 'completed' ? BAR_FADE_AFTER_MS_OK : BAR_FADE_AFTER_MS_BAD;
  return Math.max(0, t.endedAtMs + budget - now);
}

export function worthSurfacing(t: BackgroundTask, now = Date.now()): boolean {
  if (t.kind === 'free-shell') return false;
  if (t.configId) return true;
  if (typeof t.port === 'number' && t.port > 0) return true;
  return (t.endedAtMs ?? now) - t.startedAtMs > WORTH_SURFACING_MIN_ALIVE_MS;
}

/**
 * 是不是**常驻服务** —— 只认人做过的决定, 跟 server 端 isService() 同一套判据。
 *   · 绑了 RunConfig (显式声明过)
 *   · persistent (用户手动转正 / adopt 外部进程)
 * 端口和存活时长一概不算 —— 那是猜意图, 而一个跑三分钟的构建照样占端口、照样活很久。
 */
export function isPersistentService(t: BackgroundTask): boolean {
  if (t.kind === 'free-shell') return false;
  if (t.kind === 'agent-task') return false;
  if (t.configId) return true;
  return t.persistent === true;
}

function statusOf(f: ProcessFactWire): BackgroundTaskStatus {
  /* paused 是观测出来的 (ps STAT 含 'T'), 不是 UI 记着"我点过暂停" —— 少一份要对账的状态 */
  if (f.paused && (f.status ?? 'running') === 'running') return 'paused';
  if (f.status) return f.status;
  if (f.endTime === undefined) return 'running';
  if (typeof f.exitCode !== 'number') return 'killed';
  return f.exitCode === 0 ? 'completed' : 'failed';
}

function factToTask(f: ProcessFactWire): BackgroundTask {
  return {
    taskId: f.pid,
    pid: f.pid,
    command: f.command,
    name: f.friendly_name || f.name,
    startedAtMs: f.startTime,
    endedAtMs: f.endTime,
    status: statusOf(f),
    exitCode: f.exitCode,
    port: f.port,
    configId: f.config_id,
    workspaceRoot: f.workspaceRoot,
    origin: f.origin,
    kind: f.kind,
    ownerSessionId: f.owner_session_id,
    persistent: f.persistent,
    logFilePath: f.log_file_path,
    healthy: f.healthy,
    lastOutputLine: f.lastOutputLine,
  };
}

/* ── 状态 (三个变量, 且都不需要对账) ──────────────────────────────────── */

let tasks: BackgroundTask[] = [];
/** 最近一次快照的产出时刻。UI 用它判断服务端是否还活着。 */
let generatedAt = 0;
/** 起进程瞬间的占位, 下一个快照就会覆盖。key = pid。 */
const optimisticAdds = new Map<number, BackgroundTask>();

const OPTIMISTIC_MAX_AGE_MS = 6_000;

const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) {
    try { fn(); } catch (err) { console.error('[bgTasksStore]', err); }
  }
}

/** getSnapshot 必须返回 stable ref (useSyncExternalStore 的硬要求, 否则无限重渲)。
 *  只有真正替换过内容才会换新数组引用。 */
function rebuild(facts: ProcessFactWire[], now = Date.now()): void {
  const next = facts.map(factToTask);
  const seen = new Set(next.map(t => t.pid));
  /* 快照收录了 → 占位功成身退; 超时还没被收录 → 它多半永远不会被收录 (别的工程 /
   * free-shell / 秒退), 直接丢掉, 绝不让它变成常驻幽灵。 */
  for (const [pid, placeholder] of optimisticAdds) {
    if (seen.has(pid) || now - placeholder.startedAtMs > OPTIMISTIC_MAX_AGE_MS) {
      if (!seen.has(pid)) noteStreamDrop('bg-task-never-in-snapshot', { type: 'background_task' }, `pid ${pid} ${placeholder.command.slice(0, 60)}`);
      optimisticAdds.delete(pid);
      continue;
    }
    next.push(placeholder);
  }
  next.sort((a, b) => b.startedAtMs - a.startedAtMs);
  tasks = next;
}

/** 快照 → 整体替换。这是唯一的写入路径。 */
export function ingestServiceSnapshot(snap: { generatedAt?: number; processes?: ProcessFactWire[] }): void {
  if (!snap || !Array.isArray(snap.processes)) return;
  /* 乱序到达的旧快照直接丢 —— 否则会把新状态倒回去 */
  const ts = Number(snap.generatedAt) || Date.now();
  if (ts < generatedAt) return;
  generatedAt = ts;
  rebuild(snap.processes);
  emit();
}

/** 起进程瞬间的乐观占位 —— 只为了 UI 立刻有反馈, ≤2s 后被真快照替换。 */
export function addOptimisticTask(pid: number, command: string): void {
  if (!pid || pid <= 0) return;
  if (tasks.some(t => t.pid === pid) || optimisticAdds.has(pid)) return;
  const placeholder: BackgroundTask = {
    taskId: pid,
    pid,
    command,
    startedAtMs: Date.now(),
    status: 'running',
  };
  optimisticAdds.set(pid, placeholder);
  tasks = [...tasks, placeholder].sort((a, b) => b.startedAtMs - a.startedAtMs);
  emit();
}

/** 服务端是否还在产快照。false = tick 停了 / 事件循环被打死 —— UI 该明说"无响应",
 *  而不是继续展示一份陈旧的"一切正常"。 */
export function isSnapshotFresh(now = Date.now()): boolean {
  if (generatedAt === 0) return true; /* 还没收到过第一份, 不算"失联" */
  return now - generatedAt < 10_000;
}

export function getSnapshotAge(now = Date.now()): number {
  return generatedAt === 0 ? 0 : now - generatedAt;
}

/* ── React 绑定 ──────────────────────────────────────────────────────── */

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
};

export function useBackgroundTasks(sessionId?: string | null): BackgroundTask[] {
  const all = useSyncExternalStore(subscribe, () => tasks, () => tasks);
  return useMemo(() => filterTasksForSession(all, sessionId), [all, sessionId]);
}

/** 纯函数, 便于单测 —— 规则见 useBackgroundTasks 注释。 */
export function filterTasksForSession(
  all: BackgroundTask[],
  sessionId?: string | null,
): BackgroundTask[] {
  return all.filter((t) => {
    if (t.persistent) return true;          /* 用户确认过 → 工程级, 处处可见 */
    if (!t.ownerSessionId) return true;     /* 无主 → 兜底显示, 别弄丢 */
    return t.ownerSessionId === sessionId;  /* 其余只在自己会话里 */
  });
}

/** 当前快照的全部进程 (非 React 上下文用)。 */
export function getBackgroundTasks(): BackgroundTask[] {
  return tasks;
}

/** 非 React 订阅入口 (服务自动显示 serviceAutoShow 用) —— 跟 useBackgroundTasks 同一份快照。 */
export function subscribeBackgroundTasks(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** 是否已经收到过至少一份快照 (哪怕那份里一个进程都没有)。
 *  跟"列表是空的"是两件事: 自动显示要靠它区分"还没数据"和"确实没有服务"。 */
export function hasServiceSnapshot(): boolean {
  return generatedAt > 0;
}

/* ── 用户操作 (透传 IPC, 结果由下一个快照体现, 这里不预写状态) ─────────── */

/** 后端已经不在时, 把这条僵尸任务从列表里摘掉。
 *
 *   用户实录: 「死任务也不显示, 我也终止不了」。后端进程没了之后, 上一次运行遗留的
 *   任务条目还挂在栏里显示"运行中", 但任何 停止/暂停 都发不出去 —— 变成一个谁也
 *   动不了的僵尸。既然连接都不在, 那个进程一定不在跑了, 留着它只会让人反复去点。 */
function dropUnreachableTask(pid: number): void {
  const before = tasks.length;
  tasks = tasks.filter((t) => t.pid !== pid);
  if (tasks.length !== before) emit();
}

async function runBgTaskOp(
  label: string,
  pid: number,
  fnName: 'killBackgroundTask' | 'pauseBackgroundTask' | 'resumeBackgroundTask'
    | 'setBackgroundTaskPersistent',
  args: unknown[],
): Promise<void> {
  const fn = (window as any)?.neox?.[fnName];
  if (typeof fn !== 'function') {
    console.warn(`[bgTasksStore] ${fnName} IPC unavailable`);
    return;
  }
  try {
    const r = await fn(...args);
    if (r && r.ok === false) {
      if (r.unreachable) {
        console.warn(`[bgTasksStore] ${fnName} 后端不可达, 清掉 pid=${pid}`);
        dropUnreachableTask(pid);
        dispatchOpFailedFromError(
          label,
          new Error('后台服务已不在运行 — 这个任务是上次运行遗留的, 已从列表移除'),
        );
        return;
      }
      dispatchOpFailedFromError(label, new Error(r.error || '未知错误'));
    }
  } catch (err) {
    /* 走到这里说明连 IPC 都炸了 (handler 内部已经全 catch 过) */
    console.error(`[bgTasksStore] ${fnName} failed`, err);
    dispatchOpFailedFromError(label, err);
  }
}

export async function killBackgroundTask(pid: number, force = false): Promise<void> {
  await runBgTaskOp('停止后台任务', pid, 'killBackgroundTask', [pid, force]);
}

export async function pauseBackgroundTask(pid: number): Promise<void> {
  await runBgTaskOp('暂停后台任务', pid, 'pauseBackgroundTask', [pid]);
}

export async function resumeBackgroundTask(pid: number): Promise<void> {
  await runBgTaskOp('恢复后台任务', pid, 'resumeBackgroundTask', [pid]);
}

/**
 * 转正 / 取消转正 —— 唯一的跨会话晋升途径.
 *
 *   结果由下一个快照 (≤2s) 体现, 这里不预写状态 —— 跟其它操作一致。
 */
export async function setBackgroundTaskPersistent(
  pid: number,
  persistent: boolean,
): Promise<void> {
  await runBgTaskOp(
    persistent ? '设为常驻任务' : '取消常驻',
    pid,
    'setBackgroundTaskPersistent',
    [pid, persistent],
  );
}

/** 调试/测试用 */
export function _resetBackgroundTasksStoreForTest(): void {
  tasks = [];
  generatedAt = 0;
  optimisticAdds.clear();
  listeners.clear();
}
