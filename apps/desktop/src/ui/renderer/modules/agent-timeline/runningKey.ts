import {
  isWaitingAskStep,
  rowStepId,
  rowStepStatus,
  thinkingTailParts,
  thinkingTextOf,
  type Row,
  type RowStep,
} from './timelineRows';

export function currentRunningKey(
  activity: Extract<Row, { kind: "activity" }>,
  options?: { plain?: boolean },
): string {
  let hit: RowStep | undefined;
  let settled: RowStep | undefined;
  for (let i = activity.rows.length - 1; i >= 0 && !hit; i--) {
    const r = activity.rows[i];
    const steps =
      r.kind === "single" ? [r.step]
        : r.kind === "cluster" || r.kind === "group" ? r.items
          : [];
    for (let j = steps.length - 1; j >= 0; j--) {
      const s = steps[j]!;
      const st = rowStepStatus(s);
      if (st === "running" || st === "pending" || st === "awaiting" || isWaitingAskStep(s)) {
        hit = s;
        if (st === "awaiting") break;
      } else if (!settled) {
        settled = s;
      }
    }
  }
  if (!hit) return `idle:${settled ? rowStepId(settled) : ""}`;
  let key = `${rowStepId(hit)}:${rowStepStatus(hit)}`;
  if (!options?.plain) {
    /* 头上显示的那段从第几句起拼: 半句话往后长不变, 新句攒够字数顶掉旧句时才变 ——
     * 只按句数算的话, 新句还短时显示的仍是旧句, 会滚上来一行一模一样的字 */
    const thinking = thinkingTextOf(hit);
    if (thinking.trim()) key += `:${thinkingTailParts(thinking).start}`;
  }
  return key;
}
