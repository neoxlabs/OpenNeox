import { describe, it, expect, vi } from 'vitest';
import { setAgentTurnEdits, getAgentTurnEdits } from '../agentTurnEditsStore';
import { listPendingTurnHunks, acceptAllTurnEdits, revertAllTurnEdits } from '../turnEditsBulk';

const seed = (sid: string) => setAgentTurnEdits(sid, 't1', [
  { path: '/ws/a.ts', editHunks: [
    { oldString: 'x', newString: 'y', startLine: 3, __sourceEntryId: 'e1', __sourceHunkIdx: 0 },
    { oldString: '', newString: 'new file', startLine: 1 },              /* 纯新建 → 不算待审 */
    { oldString: 'p', newString: 'q', startLine: 9, previewTruncated: true }, /* 截断 → 不算 */
  ] },
  { path: '/ws/b.ts', editHunks: [
    { oldString: 'm', newString: 'n', startLine: 5, review: 'accepted' },
    { oldString: 'k', newString: 'l', startLine: 7, __sourceEntryId: 'e2', __sourceHunkIdx: 1 },
  ] },
]);

describe('turnEditsBulk', () => {
  it('只数真正待审的 hunk', () => {
    seed('s1');
    expect(listPendingTurnHunks('s1').map((p) => `${p.path}#${p.fileIdx}`)).toEqual(['/ws/a.ts#0', '/ws/b.ts#1']);
  });

  it('全部接受: 时间线 + store 一起标, 不碰磁盘', () => {
    seed('s2');
    const upd = vi.fn();
    expect(acceptAllTurnEdits('s2', upd)).toBe(2);
    expect(upd).toHaveBeenCalledWith('s2', 'e1', 0, 'accepted');
    expect(upd).toHaveBeenCalledWith('s2', 'e2', 1, 'accepted');
    expect(listPendingTurnHunks('s2')).toEqual([]);
    expect(getAgentTurnEdits('s2')!.files[0].editHunks![0].review).toBe('accepted');
  });

  it('全部回退: 从下往上 revertFileHunk, 成功的才标 rejected', async () => {
    seed('s3');
    const calls: number[] = [];
    (globalThis as any).window = { neox: { revertFileHunk: async (a: { startLine: number }) => { calls.push(a.startLine); return { success: a.startLine !== 3 }; } } };
    const upd = vi.fn();
    const r = await revertAllTurnEdits('s3', upd);
    expect(calls).toEqual([7, 3]);
    expect(r).toEqual({ ok: 1, failed: 1 });
    expect(upd).toHaveBeenCalledTimes(1);
    expect(listPendingTurnHunks('s3').map((p) => p.path)).toEqual(['/ws/a.ts']);
  });

  it('revert 能力不在 → ok:-1, 什么都不动', async () => {
    seed('s4');
    (globalThis as any).window = { neox: {} };
    expect(await revertAllTurnEdits('s4')).toEqual({ ok: -1, failed: 0 });
    expect(listPendingTurnHunks('s4').length).toBe(2);
  });
});
