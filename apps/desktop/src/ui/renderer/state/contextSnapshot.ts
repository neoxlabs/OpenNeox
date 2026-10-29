
import { useSyncExternalStore } from 'react';

export interface ContextSnapshot {
  tokensUsed: number;
  contextWindow: number;
  breakdown?: any;
  latestRequestUsage?: any;
  sessionCache?: any;
  sessionId?: string;
  updatedAt: number;
}

const _snapshots = new Map<string, ContextSnapshot>();
let _latest: ContextSnapshot | null = null;  // 无 sessionId 调用的向后兼容回退
const _listeners = new Set<() => void>();
const MAX_SESSIONS = 40;  // 软上限, 防长跑累积; 超了驱逐最老 (Map 保插入序)

export function setContextSnapshot(snapshot: ContextSnapshot): void {
  if (snapshot.sessionId) {
    _snapshots.set(snapshot.sessionId, snapshot);
    if (_snapshots.size > MAX_SESSIONS) {
      const oldest = _snapshots.keys().next().value;
      if (oldest !== undefined) _snapshots.delete(oldest);
    }
  }
  _latest = snapshot;
  _listeners.forEach(fn => { try { fn(); } catch { /* noop */ } });
}

let _activeSessionId: string | null = null;
/* 活跃会话还没有快照时返回的空壳 —— 必须是同一个对象, useSyncExternalStore 每次拿到新引用会无限重渲染 */
let _activeEmpty: ContextSnapshot | null = null;

export function setActiveContextSession(sessionId: string | null): void {
  if (_activeSessionId === sessionId) return;
  _activeSessionId = sessionId;
  _activeEmpty = sessionId ? { tokensUsed: 0, contextWindow: 0, sessionId, updatedAt: 0 } : null;
  _listeners.forEach(fn => { try { fn(); } catch { /* noop */ } });
}

/** 按会话取快照; 传 sessionId 就只返该会话的 (没有则 null, 绝不串别的会话);
 *  不传则取当前活跃会话的; 活跃会话还没有快照时才回退最新 (向后兼容旧调用点)。 */
export function getContextSnapshot(sessionId?: string): ContextSnapshot | null {
  if (sessionId) return _snapshots.get(sessionId) ?? null;
  if (_activeSessionId) return _snapshots.get(_activeSessionId) ?? _activeEmpty;
  return _latest;
}

/** 会话删除时清掉其快照, 免得残留 (可选, 由 session 生命周期调用)。 */
export function clearContextSnapshot(sessionId: string): void {
  _snapshots.delete(sessionId);
}

/** React hook: 订阅快照更新. 传 sessionId → 只跟该会话的快照 (切会话不串)。 */
export function useContextSnapshot(sessionId?: string): ContextSnapshot | null {
  return useSyncExternalStore(
    (cb) => { _listeners.add(cb); return () => _listeners.delete(cb); },
    () => getContextSnapshot(sessionId),
    () => getContextSnapshot(sessionId),
  );
}
