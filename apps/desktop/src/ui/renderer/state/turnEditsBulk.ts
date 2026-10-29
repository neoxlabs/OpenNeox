import { getAgentTurnEdits, patchAgentTurnHunkReview, type AgentTurnEditHunk } from './agentTurnEditsStore';

export type UpdateHunkReview = (sessionId: string, entryId: string, hunkIdx: number, review: 'accepted' | 'rejected') => void;

interface PendingHunk { path: string; h: AgentTurnEditHunk; fileIdx: number }

/** 待审 = pending 且有 oldString (纯新建不算) 且预览没截断 */
export function listPendingTurnHunks(sessionId: string): PendingHunk[] {
  const slice = getAgentTurnEdits(sessionId);
  const out: PendingHunk[] = [];
  for (const f of slice?.files ?? []) {
    (f.editHunks ?? []).forEach((h, fileIdx) => {
      if ((h.review ?? 'pending') !== 'pending') return;
      if (h.previewTruncated) return;
      if (!(typeof h.oldString === 'string' && h.oldString.length > 0)) return;
      out.push({ path: f.path, h, fileIdx });
    });
  }
  return out;
}

function markReviewed(sessionId: string, p: PendingHunk, review: 'accepted' | 'rejected', updateHunkReview?: UpdateHunkReview): void {
  const entryId = p.h.__sourceEntryId;
  const hunkIdx = typeof p.h.__sourceHunkIdx === 'number' ? p.h.__sourceHunkIdx : p.fileIdx;
  if (entryId && updateHunkReview && hunkIdx >= 0) updateHunkReview(sessionId, entryId, hunkIdx, review);
  patchAgentTurnHunkReview(sessionId, p.path, p.fileIdx, review);
}

/** 全部接受: 只标记。返回接受了几处。 */
export function acceptAllTurnEdits(sessionId: string, updateHunkReview?: UpdateHunkReview): number {
  const pending = listPendingTurnHunks(sessionId);
  for (const p of pending) markReviewed(sessionId, p, 'accepted', updateHunkReview);
  return pending.length;
}

/** 全部回退: 物理回退。返回 {ok, failed}; revert 能力不在时 ok=-1。 */
export async function revertAllTurnEdits(sessionId: string, updateHunkReview?: UpdateHunkReview): Promise<{ ok: number; failed: number }> {
  const api = (window as any).neox;
  if (typeof api?.revertFileHunk !== 'function') return { ok: -1, failed: 0 };
  const pending = listPendingTurnHunks(sessionId)
    .sort((a, b) => (b.h.startLine ?? 0) - (a.h.startLine ?? 0));
  let ok = 0; let failed = 0;
  for (const p of pending) {
    try {
      const r = await api.revertFileHunk({
        filePath: p.path, oldString: p.h.oldString, newString: p.h.newString, startLine: p.h.startLine,
      });
      if (r?.success) { ok++; markReviewed(sessionId, p, 'rejected', updateHunkReview); }
      else failed++;
    } catch { failed++; }
  }
  return { ok, failed };
}
