import type { DiffLine } from './types';
import { computeCommitDiff } from '../ide-workspace/commitLineDiff';

export function editHunkLines(
  oldText: string,
  newText: string,
  startLine: number,
): { lines: DiffLine[]; add: number; del: number } {
  const d = computeCommitDiff(oldText, newText);
  const off = startLine - 1;
  const lines: DiffLine[] = d.rows.map((r) => {
    if (r.kind === 'gap') {
      /* SimpleDiff 的 gap 行拿 oldNo..newNo 当折叠区间 */
      const from = (r.oldNo ?? 1) + off;
      return { kind: 'gap', oldNo: from, newNo: from + (r.hidden ?? 1) - 1, text: '' };
    }
    return {
      kind: r.kind,
      text: r.text,
      ...(r.oldNo !== undefined ? { oldNo: r.oldNo + off } : {}),
      ...(r.newNo !== undefined ? { newNo: r.newNo + off } : {}),
    };
  });
  return { lines, add: d.add, del: d.del };
}
