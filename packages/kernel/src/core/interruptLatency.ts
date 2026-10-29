
import { cliLogger } from '../platform/cliLogger.js';
import { createSessionScopedStore, DEFAULT_SESSION_SCOPE } from './sessionScope.js';

/** 一条停止链路结束后交给 metrics 的结论。 */
export interface InterruptLatencySummary {
  /** 点停止 → 这一轮结束 (ms) */
  turnMs: number;
  /** 点停止 → 模型流停止 (ms)。停止时没有流在跑 → undefined */
  streamMs?: number;
  /** 点停止 → 工具停止 (ms)。停止时没有工具在跑 → undefined */
  toolMs?: number;
  /** 工具没响应 abort、被兜底放弃 */
  toolAbandoned: boolean;
  /** 被放弃的工具名 (只在 toolAbandoned 时有) */
  toolName?: string;
}

interface InterruptLatencyState {
  requestedAt: number;
  streamStoppedAt?: number;
  toolStoppedAt?: number;
  /** 本轮结束时间 —— 已发 run_done / 已落库 */
  turnEndedAt?: number;
  /** turn metrics 是否已取过一次 (防止同一停止重复落行) */
  reported: boolean;
  toolAbandoned: boolean;
  toolName?: string;
}

/** 停止之后一直没等到 run_done（host 被淘汰 / 进程退出）的记录按过期处理。 */
const STALE_MS = 5 * 60_000;

const store = createSessionScopedStore<InterruptLatencyState | null>(() => null, {
  inherit: false,
  maxScopes: 64,
});

function normalizeScope(scope?: string): string {
  const s = scope?.trim();
  return s ? s : DEFAULT_SESSION_SCOPE;
}

function logEvent(event: string, payload: Record<string, unknown>): void {
  try {
    cliLogger.info('INTERRUPT', JSON.stringify({ event, ...payload }));
  } catch { /* 日志失败不能影响停止链路 */ }
}

function toSummary(state: InterruptLatencyState, at: number): InterruptLatencySummary | null {
  const turnEndedAt = state.turnEndedAt ?? at;
  return {
    turnMs: turnEndedAt - state.requestedAt,
    streamMs: state.streamStoppedAt !== undefined ? state.streamStoppedAt - state.requestedAt : undefined,
    toolMs: state.toolStoppedAt !== undefined ? state.toolStoppedAt - state.requestedAt : undefined,
    toolAbandoned: state.toolAbandoned,
    toolName: state.toolName,
  };
}

/** a) 用户点了停止 (CLI Esc / 桌面停止按钮 / SDK abort 都会走到 host.interrupt)。 */
export function markInterruptRequested(scope: string | undefined, at: number = Date.now()): void {
  const key = normalizeScope(scope);
  store.set({ requestedAt: at, reported: false, toolAbandoned: false }, key);
  logEvent('interrupt.requested', { session: key });
}

/** b1) 模型流因 abort 停了。 */
export function markInterruptStreamStopped(scope: string | undefined, at: number = Date.now()): void {
  const key = normalizeScope(scope);
  const state = store.get(key);
  if (!state || state.streamStoppedAt !== undefined) return;
  if (at - state.requestedAt > STALE_MS) return;
  state.streamStoppedAt = at;
  logEvent('interrupt.streamStopped', { session: key, ms: at - state.requestedAt });
}

/** b2) 在飞工具停了 —— 自己响应了 abort，或被兜底放弃。 */
export function markInterruptToolStopped(
  scope: string | undefined,
  info: { abandoned: boolean; toolName?: string },
  at: number = Date.now(),
): void {
  const key = normalizeScope(scope);
  const state = store.get(key);
  if (!state || state.toolStoppedAt !== undefined) return;
  if (at - state.requestedAt > STALE_MS) return;
  state.toolStoppedAt = at;
  state.toolAbandoned = info.abandoned;
  state.toolName = info.toolName;
  logEvent(info.abandoned ? 'interrupt.toolAbandoned' : 'interrupt.toolStopped', {
    session: key,
    ms: at - state.requestedAt,
    tool: info.toolName,
    /* 工具比本轮结束还晚停时，把本轮结束耗时一并写进日志 —— 这一笔已经落不了库了 */
    turnMs: state.turnEndedAt !== undefined ? state.turnEndedAt - state.requestedAt : undefined,
  });
  /* 本轮已结束、工具也停完了 —— 记录使命完成，收掉 */
  if (state.turnEndedAt !== undefined) store.clearScope(key);
}

/**
 * c) 这一轮结束了 —— 取出本轮停止耗时交给 turn metrics 落库。
 * 每个停止只返回一次 (reported 置位)；记录先留着，让 3s 后才落账的工具放弃还能进日志。
 */
export function consumeInterruptLatency(
  scope: string | undefined,
  at: number = Date.now(),
): InterruptLatencySummary | null {
  const key = normalizeScope(scope);
  const state = store.get(key);
  if (!state) return null;
  if (at - state.requestedAt > STALE_MS) {
    store.clearScope(key);
    return null;
  }
  if (state.reported) return null;
  state.reported = true;
  state.turnEndedAt = at;
  const summary = toSummary(state, at)!;
  logEvent('interrupt.turnEnded', { session: key, ...summary });
  /* 工具早在本轮结束前就停了 → 没有迟到的账要记了 */
  if (state.toolStoppedAt !== undefined) store.clearScope(key);
  return summary;
}

/** 只读快照 (测试 / 排查用)，不消耗记录。 */
export function getInterruptLatency(scope: string | undefined): InterruptLatencySummary | null {
  const state = store.get(normalizeScope(scope));
  if (!state) return null;
  return toSummary(state, Date.now());
}

/** 仅测试用: 清掉所有会话的停止记录。 */
export function __resetInterruptLatencyForTest(): void {
  store.clearAll();
}
