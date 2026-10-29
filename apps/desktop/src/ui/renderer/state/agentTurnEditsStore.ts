/**
 * agentTurnEditsStore — 最近一轮 agent 文件改动 (供 IDE 编辑器顶栏 Accept/Reject).
 *
 * 数据由 TurnSummaryBar 在算完 aggregateTurnChanges 后写入;
 * CodeEditor 读当前打开文件是否有 pending hunks → 显审阅条.
 */

import { useSyncExternalStore } from 'react';

export type AgentTurnEditHunk = {
  oldString?: string;
  newString?: string;
  startLine?: number;
  previewTruncated?: boolean;
  review?: 'pending' | 'accepted' | 'rejected';
  __sourceEntryId?: string;
  __sourceHunkIdx?: number;
};

export type AgentTurnFileEdit = {
  path: string;
  addCount?: number;
  delCount?: number;
  changedLines?: Array<{ start: number; end: number; kind: 'add' | 'del' | 'modify' }>;
  editHunks?: AgentTurnEditHunk[];
};

type SessionSlice = {
  turnId: string;
  files: AgentTurnFileEdit[];
  updatedAt: number;
};

const bySession = new Map<string, SessionSlice>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function setAgentTurnEdits(
  sessionId: string,
  turnId: string,
  files: AgentTurnFileEdit[],
): void {
  if (!sessionId) return;
  const prev = bySession.get(sessionId);
  /* 同 turn 且同路径签名时跳过, 避免 TurnSummaryBar 每帧重写 */
  const sig = `${turnId}|${files.map((f) => `${f.path}:${f.editHunks?.length ?? 0}`).join(';')}`;
  const prevSig = prev
    ? `${prev.turnId}|${prev.files.map((f) => `${f.path}:${f.editHunks?.length ?? 0}`).join(';')}`
    : '';
  if (sig === prevSig) return;
  bySession.set(sessionId, { turnId, files, updatedAt: Date.now() });
  emit();
  /* open_surface 往往早于 turn_summary; edits 落盘后再把审阅数据补进已开的 code tab */
  void import('./surfaceStore').then((m) => {
    try { m.syncTurnEditsIntoCodeSurfaces(sessionId); } catch { /* ignore */ }
  });
}

export function clearAgentTurnEdits(sessionId: string): void {
  if (!sessionId || !bySession.has(sessionId)) return;
  bySession.delete(sessionId);
  emit();
}

export function getAgentTurnEdits(sessionId: string): SessionSlice | null {
  return bySession.get(sessionId) ?? null;
}

export function getAgentTurnEditForPath(
  sessionId: string,
  filePath: string,
): AgentTurnFileEdit | null {
  const slice = bySession.get(sessionId);
  if (!slice || !filePath) return null;
  const norm = filePath.replace(/\\/g, '/');
  return (
    slice.files.find((f) => {
      const p = f.path.replace(/\\/g, '/');
      return p === norm || norm.endsWith(`/${p}`) || p.endsWith(`/${norm.split('/').pop()}`);
    }) ?? null
  );
}

/** 整个会话本轮的改动 (一屏审阅面板用) —— 与 useAgentTurnEditForPath 同一份数据同一条订阅 */
export function useAgentTurnEdits(sessionId: string | undefined): SessionSlice | null {
  return useSyncExternalStore(
    subscribe,
    () => (sessionId ? (bySession.get(sessionId) ?? null) : null),
    () => null,
  );
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function useAgentTurnEditForPath(
  sessionId: string | undefined,
  filePath: string | undefined,
): AgentTurnFileEdit | null {
  return useSyncExternalStore(
    subscribe,
    () => (sessionId && filePath ? getAgentTurnEditForPath(sessionId, filePath) : null),
    () => null,
  );
}

/** 把某个 hunk 的 review 状态写回 store (Accept/Reject 后 IDE 条即时刷新). */
export function patchAgentTurnHunkReview(
  sessionId: string,
  filePath: string,
  hunkIdx: number,
  review: 'accepted' | 'rejected',
): void {
  const slice = bySession.get(sessionId);
  if (!slice) return;
  const norm = filePath.replace(/\\/g, '/');
  const nextFiles = slice.files.map((f) => {
    const p = f.path.replace(/\\/g, '/');
    if (p !== norm && !norm.endsWith(`/${p}`) && !p.endsWith(`/${norm.split('/').pop()}`)) {
      return f;
    }
    if (!f.editHunks) return f;
    const editHunks = f.editHunks.map((h, i) => (i === hunkIdx ? { ...h, review } : h));
    return { ...f, editHunks };
  });
  bySession.set(sessionId, { ...slice, files: nextFiles, updatedAt: Date.now() });
  emit();
}
