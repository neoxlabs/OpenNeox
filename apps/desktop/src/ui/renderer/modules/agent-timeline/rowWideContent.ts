/* 行宽判据 —— 渲染期算出"这一行里有没有 diff / turn-summary 结果面板",
 * 替代 CSS 里的 `.atl-row-clamp:has(.atl-tool__content-shell.is-content-diff)`
 * (work:M-03: 滚动期 `:has()` 会让祖先参与失效重算)。
 *
 *   放在独立文件是为了不在 timelineRows.ts (已到文件大小上限) 上继续堆。
 */
import { rowStepToTimelineStep, type Row, type RowStep } from './timelineRows';

/** step 的内容类型 (与 TimelineStep 的 `is-content-*` class 同口径: 下划线换成连字符) */
export function rowStepNormalizedContentType(step: RowStep): string | undefined {
  const content = rowStepToTimelineStep(step).content;
  return content ? content.type.replace(/_/g, '-') : undefined;
}

/** diff / turn-summary 是结果面板, 行宽要撑满。 */
export function rowStepIsWideContent(step: RowStep): boolean {
  const type = rowStepNormalizedContentType(step);
  return type === 'diff' || type === 'turn-summary';
}

/** 这一行 (含嵌套 activity / turn_fold / cluster) 里有没有 diff / turn-summary 内容 */
export function rowHasWideContent(row: Row): boolean {
  if (row.kind === 'single') return rowStepIsWideContent(row.step);
  if (row.kind === 'cluster' || row.kind === 'group') return row.items.some(rowStepIsWideContent);
  if (row.kind === 'activity' || row.kind === 'turn_fold' || row.kind === 'work_progress') {
    return row.rows.some(rowHasWideContent);
  }
  return false;
}
