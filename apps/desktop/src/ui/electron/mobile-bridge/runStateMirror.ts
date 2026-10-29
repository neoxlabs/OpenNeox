/**
 * runStateMirror.ts — Mobile-bridge ExecutionState mirror (transport only).
 *
 * Phone is a projector of desktop timeline sources. EntryLog is catch-upable via
 * SessionContext seq/history. ExecutionState (busy/idle) is pushed as best-effort
 * streaming — if no subscriber is attached, the frame must still be remembered so
 * session.subscribe can return an authoritative snapshot (attach = cursor + execution).
 *
 * This is NOT a second business state machine: it is a read-only copy of what the
 * desktop runtime already committed via setRunStatus / run_result → idle.
 */

export interface MirroredRunState {
  status: string;
  turn_id: string | null;
  last_committed_seq: number | null;
  pending_tool_calls: unknown[];
  initiated_by: string | null;
  paused_at: number | null;
  updated_at: number;
}

const bySession = new Map<string, MirroredRunState>();

function asNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Normalize a run_state_changed / store payload into mirror shape. */
export function normalizeRunState(raw: Record<string, unknown> | null | undefined): MirroredRunState | null {
  if (!raw || typeof raw !== 'object') return null;
  const status = String(raw.status ?? '').trim();
  if (!status) return null;
  const turn =
    (raw.turn_id as string | null | undefined) ??
    (raw.turnId as string | null | undefined) ??
    null;
  const updated =
    asNum(raw.updated_at) ??
    asNum(raw.updatedAt) ??
    Date.now();
  const pending =
    (raw.pending_tool_calls as unknown[]) ??
    (raw.pendingToolCalls as unknown[]) ??
    [];
  return {
    status,
    turn_id: typeof turn === 'string' && turn ? turn : null,
    last_committed_seq:
      asNum(raw.last_committed_seq) ?? asNum(raw.lastCommittedSeq),
    pending_tool_calls: Array.isArray(pending) ? pending : [],
    initiated_by:
      ((raw.initiated_by as string | null | undefined) ??
        (raw.initiatedBy as string | null | undefined) ??
        null) ||
      null,
    paused_at: asNum(raw.paused_at) ?? asNum(raw.pausedAt),
    updated_at: updated,
  };
}

/** Record live ExecutionState before (or instead of) push — survives SKIP no-sub. */
export function recordRunState(
  sessionId: string,
  raw: Record<string, unknown> | null | undefined,
): MirroredRunState | null {
  if (!sessionId) return null;
  const next = normalizeRunState(raw);
  if (!next) return null;
  const prev = bySession.get(sessionId);
  if (prev && prev.updated_at > next.updated_at) return prev;
  bySession.set(sessionId, next);
  if (!prev || prev.status !== next.status) {
    for (const fn of statusListeners) {
      try { fn(sessionId, next.status); } catch { /* 监听方自己的错不影响记账 */ }
    }
  }
  return next;
}

/* 状态翻转 (idle ↔ running ↔ awaiting_*) 的监听 —— wsServer 拿它广播 session.run_status 给所有手机,
 * 没订阅这条会话的手机 (电脑列表 / 侧栏) 也能知道哪条在跑、哪条在等人。心跳重播同状态不触发。 */
const statusListeners = new Set<(sessionId: string, status: string) => void>();

export function onRunStatusChange(fn: (sessionId: string, status: string) => void): () => void {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

/** Convenience: map agent_turn_done / run_result end → idle execution snapshot. */
export function recordIdleFromTurnDone(
  sessionId: string,
  turnId?: string | null,
  updatedAt: number = Date.now(),
): MirroredRunState | null {
  return recordRunState(sessionId, {
    status: 'idle',
    turn_id: turnId ?? null,
    pending_tool_calls: [],
    updated_at: updatedAt,
  });
}

export function getMirroredRunState(sessionId: string): MirroredRunState | null {
  const s = bySession.get(sessionId);
  return s ? { ...s, pending_tool_calls: [...s.pending_tool_calls] } : null;
}

/**
 * Pick newer of mirror vs sessionStore shape for session.subscribe attach snapshot.
 * Newer = higher updated_at; ties prefer mirror (live path just wrote it).
 */
export function mergeRunStateForSubscribe(
  mirror: MirroredRunState | null,
  fromStore: MirroredRunState | null,
): MirroredRunState | null {
  if (!mirror) return fromStore ? { ...fromStore, pending_tool_calls: [...fromStore.pending_tool_calls] } : null;
  if (!fromStore) return { ...mirror, pending_tool_calls: [...mirror.pending_tool_calls] };
  if (fromStore.updated_at > mirror.updated_at) {
    return { ...fromStore, pending_tool_calls: [...fromStore.pending_tool_calls] };
  }
  return { ...mirror, pending_tool_calls: [...mirror.pending_tool_calls] };
}

export function _clearAllRunStateMirrorForTest(): void {
  bySession.clear();
}
