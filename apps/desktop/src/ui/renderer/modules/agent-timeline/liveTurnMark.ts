import type { Row, RowStep } from './timelineRows';
import { rowHasActive, rowHasWaitingAsk, rowStepIconKind, rowStepStatus } from './timelineRows';
import type { NeoxMarkState } from './NeoxMarkMotion';

function stepsOf(r: Row): RowStep[] {
  if (r.kind === 'single') return [r.step];
  if (r.kind === 'cluster' || r.kind === 'group') return r.items;
  if (r.kind === 'activity' || r.kind === 'work_progress') return r.rows.flatMap(stepsOf);
  return [];
}

export function liveTurnMark(rows: readonly Row[], streaming: boolean): { index: number; state: NeoxMarkState } | null {
  let u = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.kind === 'turn_fold') return null;
    if (r.kind === 'message' && r.message.role === 'user') { u = i; break; }
  }
  if (u < 0 || u + 1 >= rows.length) return null;
  const tail = rows.slice(u + 1);
  if (!streaming && !tail.some(rowHasActive)) return null;
  let state: NeoxMarkState = 'think';
  if (tail.some(rowHasWaitingAsk)) state = 'wait';
  else if (tail.flatMap(stepsOf).some((s) => {
    const st = rowStepStatus(s);
    return (st === 'running' || st === 'pending') && rowStepIconKind(s) !== 'thinking';
  })) state = 'work';
  return { index: u + 1, state };
}
