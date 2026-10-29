
import { useSyncExternalStore } from 'react';
import type { TimelineEntry } from '../../utils/workspaceUtils';

/** 完整 snapshot 契约 — 跟后端 TargetSnapshot 保持一致. */
export interface TargetIndicatorState {
  sessionId: string | null;
  status: 'off' | 'active' | 'paused' | 'satisfied' | 'abandoned' | 'expired';
  target: string | null;
  rationale: string | null;
  subMissions: Array<{ id: string; description: string; success_criteria?: string; status?: 'pending' | 'in_progress' | 'completed' }>;
  createdAt: number | null;
  updatedAt: number;
  maxRunTimeMs: number | null;
  lastDoneCheck: { done: boolean; reason: string; ts: number } | null;
  abandonReason: string | null;
  elapsedMs: number;
  subMissionCount: number;
  /** status==='completed' 的战略块数 — 横幅算宏观进度 (completed/total 块) */
  completedSubMissions: number;
  phase: 'research' | 'execute';
  /** 可选 —— 后端 snapshot 不带这两个字段, 只有本 store 自己写 */
  intentSessionId?: string | null;
  intentAt?: number;
}

const INITIAL: TargetIndicatorState = {
  sessionId: null,
  status: 'off',
  target: null,
  rationale: null,
  subMissions: [],
  createdAt: null,
  updatedAt: 0,
  maxRunTimeMs: null,
  lastDoneCheck: null,
  abandonReason: null,
  elapsedMs: 0,
  subMissionCount: 0,
  completedSubMissions: 0,
  phase: 'execute',
  intentSessionId: null,
  intentAt: 0,
};

let state: TargetIndicatorState = INITIAL;
const listeners = new Set<() => void>();
let subscribed = false;
let unsubscribeFn: (() => void) | null = null;

function emit(): void {
  listeners.forEach(fn => {
    try { fn(); } catch { /* noop */ }
  });
}

function subscribe(fn: () => void): () => void {
  ensureIpcSubscription();
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function getSnapshot(): TargetIndicatorState {
  return state;
}

/**
 * 首次订阅时挂上 IPC push 监听. 全生命周期一次挂载, 组件卸载不摘 (下次 mount 复用).
 * 挂载失败 (preload 未暴露 / IPC 不可用) 无害 — state 保持 INITIAL.
 */
function ensureIpcSubscription(): void {
  if (subscribed) return;
  subscribed = true;
  try {
    const api = (window as any).neox;
    if (typeof api?.onTargetSnapshot !== 'function') return;
    unsubscribeFn = api.onTargetSnapshot((snap: any) => {
      if (!snap || typeof snap !== 'object') return;
      applySnapshot(snap as TargetIndicatorState);
    });
  } catch (err: any) {
    console.warn('[target-indicator] IPC subscribe failed:', err?.message);
  }
}

/** 把后端 snapshot 合并到 store, 只在实际变化时 emit (避免无谓 rerender). */
function applySnapshot(next: TargetIndicatorState): void {
  const normalized = normalizeSnapshot(next);
  if (shallowEqualSnapshot(state, normalized)) return;
  state = normalized;
  emit();
}

/** 后端 snapshot 里 elapsedMs 是拍照时刻, 前端 tick 时会自算; 也做几个字段的 safeguard. */
function normalizeSnapshot(s: TargetIndicatorState): TargetIndicatorState {
  return {
    sessionId: s.sessionId ?? null,
    status: (s.status || 'off') as TargetIndicatorState['status'],
    target: s.target ?? null,
    rationale: s.rationale ?? null,
    subMissions: Array.isArray(s.subMissions) ? s.subMissions : [],
    createdAt: typeof s.createdAt === 'number' ? s.createdAt : null,
    updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : Date.now(),
    maxRunTimeMs: typeof s.maxRunTimeMs === 'number' ? s.maxRunTimeMs : null,
    lastDoneCheck: s.lastDoneCheck ?? null,
    abandonReason: s.abandonReason ?? null,
    elapsedMs: typeof s.elapsedMs === 'number' ? Math.max(0, s.elapsedMs) : 0,
    subMissionCount: typeof s.subMissionCount === 'number' ? s.subMissionCount : (s.subMissions?.length ?? 0),
    completedSubMissions: typeof s.completedSubMissions === 'number'
      ? s.completedSubMissions
      : (Array.isArray(s.subMissions) ? s.subMissions.filter((m) => m.status === 'completed').length : 0),
    phase: s.phase === 'research' ? 'research' : 'execute',
    /* 乐观态由本地拥有, 后端 snapshot 不带它 —— 从当前 state 继承下来。
     * 真态一旦落地 (这个会话进了 active/paused), 乐观态立刻退场, 免得两个来源打架。 */
    ...(() => {
      const live = (s.status === 'active' || s.status === 'paused') && s.sessionId
        && s.sessionId === state.intentSessionId;
      return live
        ? { intentSessionId: null, intentAt: 0 }
        : { intentSessionId: state.intentSessionId, intentAt: state.intentAt };
    })(),
  };
}

/** 用户刚发出 /target (或大白话表态) —— 先把药丸点亮, 别等模型那一轮 */
export function markTargetIntent(sessionId: string): void {
  if (!sessionId) return;
  state = { ...state, intentSessionId: sessionId, intentAt: Date.now() };
  emit();
}

/** 撤掉乐观态 —— 宽限窗过了还是 off (那一轮没进目标模式) / 用户点 ✕ 退出 */
export function clearTargetIntent(sessionId?: string): void {
  if (!state.intentSessionId) return;
  if (sessionId && state.intentSessionId !== sessionId) return;
  state = { ...state, intentSessionId: null, intentAt: 0 };
  emit();
}

/** 浅比较 — 只看 UI 关心的字段, 减少 re-render. */
function shallowEqualSnapshot(a: TargetIndicatorState, b: TargetIndicatorState): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.status === b.status &&
    a.target === b.target &&
    a.rationale === b.rationale &&
    a.createdAt === b.createdAt &&
    a.maxRunTimeMs === b.maxRunTimeMs &&
    a.subMissionCount === b.subMissionCount &&
    a.completedSubMissions === b.completedSubMissions &&
    a.phase === b.phase &&
    (a.lastDoneCheck?.ts ?? 0) === (b.lastDoneCheck?.ts ?? 0) &&
    a.abandonReason === b.abandonReason &&
    (a.intentSessionId ?? null) === (b.intentSessionId ?? null) &&
    (a.intentAt ?? 0) === (b.intentAt ?? 0)
  );
}

export function useTargetIndicator(): TargetIndicatorState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * 切换 session 时调用. 主动 IPC 拉一次真实 status snapshot,
 * 立刻更新 store — 避免"刚切过来还在等 push"的空档期.
 * 如果 IPC 无返回或者 target off, 会自然更新为 INITIAL.
 */
export async function syncTargetFromSession(sessionId: string | null): Promise<void> {
  ensureIpcSubscription();
  if (!sessionId) {
    if (state === INITIAL) return;
    state = INITIAL;
    emit();
    return;
  }
  try {
    const api = (window as any).neox;
    if (typeof api?.targetCommand !== 'function') return;
    const result: any = await api.targetCommand(sessionId, 'status');
    if (!result || result.ok === false) return;
    // targetCommand 'status' 走 sessionCheckpointTimelineHandlers 里的旧格式返回,
    // 手动拼成 TargetIndicatorState 结构 (fallback, 直到未来把 handler 也改吐 TargetSnapshot).
    const plan = result.plan ?? null;
    const now = Date.now();
    const createdAt = plan?.createdAt ?? null;
    applySnapshot({
      sessionId,
      status: (result.status || 'off') as TargetIndicatorState['status'],
      target: plan?.target ?? null,
      rationale: plan?.rationale ?? null,
      subMissions: Array.isArray(plan?.sub_missions) ? plan.sub_missions : [],
      createdAt,
      updatedAt: now,
      maxRunTimeMs: typeof plan?.maxRunTimeMs === 'number' ? plan.maxRunTimeMs : null,
      lastDoneCheck: result.lastDoneCheck ?? null,
      abandonReason: result.abandonReason ?? null,
      elapsedMs: createdAt ? Math.max(0, now - createdAt) : 0,
      subMissionCount: Array.isArray(plan?.sub_missions) ? plan.sub_missions.length : 0,
      completedSubMissions: Array.isArray(plan?.sub_missions)
        ? plan.sub_missions.filter((m: any) => m.status === 'completed').length
        : 0,
      phase: plan?.phase === 'research' ? 'research' : 'execute',
    });
  } catch (err: any) {
    console.warn('[target-indicator] initial sync failed:', err?.message);
  }
}

/** 测试用只读窥孔 —— 生产代码请用 useTargetIndicator() 订阅, 别直接读 */
export function getTargetIndicatorState(): TargetIndicatorState {
  return state;
}

/** 测试用: 灌一份后端快照进来 (等价于 IPC push), 免得测试去 mock preload */
export function __applySnapshotForTest(next: TargetIndicatorState): void {
  applySnapshot(next);
}

/** 显式 reset — 切 session 到无 target 状态 / 手动清空场景. */
export function resetTargetIndicator(): void {
  if (state === INITIAL) return;
  state = INITIAL;
  emit();
}

/**
 * @deprecated 兼容 shim — Phase A 前 timelineStore.applyTimelineUpdate 会调这个从 entries 派生状态.
 *   Phase A 后不再需要 (backend push 是唯一状态源). 保留 no-op 以免消费方调用报错;
 *   Phase B/C 时把 timelineStore 里的调用彻底删掉后再删本函数.
 */
export function refreshTargetIndicatorFromEntries(_entries: TimelineEntry[]): void {
  // no-op — 见 JSDoc
}
