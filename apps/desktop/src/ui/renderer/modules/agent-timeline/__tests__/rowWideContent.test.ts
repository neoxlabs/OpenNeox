/* rowWideContent —— 行宽判据的单元测试 (work:M-03)。
 *  这些标记决定 `.atl-row-clamp` / 活动子行要不要撑满, 算错就是 diff 卡突然变窄。 */
import { describe, it, expect } from 'vitest';
import { rowHasWideContent, rowStepIsWideContent, rowStepNormalizedContentType } from '../rowWideContent';
import { wrapStepAsRowStep } from '../timelineRows';
import type { Row } from '../timelineRows';
import type { TimelineStep } from '../types';

function step(content: unknown): TimelineStep {
  return { kind: 'tool', id: 's1', title: 't', status: 'done', content } as unknown as TimelineStep;
}

describe('rowWideContent', () => {
  it('diff / turn_summary 是宽内容', () => {
    expect(rowStepIsWideContent(wrapStepAsRowStep(step({ type: 'diff', hunks: [] })))).toBe(true);
    expect(rowStepIsWideContent(wrapStepAsRowStep(step({ type: 'turn_summary' })))).toBe(true);
    expect(rowStepIsWideContent(wrapStepAsRowStep(step({ type: 'code', lines: [] })))).toBe(false);
  });

  it('内容类型按 TimelineStep 的连字符口径', () => {
    expect(rowStepNormalizedContentType(wrapStepAsRowStep(step({ type: 'turn_summary' })))).toBe('turn-summary');
    expect(rowStepNormalizedContentType(wrapStepAsRowStep(step({ type: 'askUser' })))).toBe('askUser');
  });

  it('single / cluster / 嵌套 activity 都能找到宽内容', () => {
    const diffStep = wrapStepAsRowStep(step({ type: 'diff', hunks: [] }));
    const plainStep = wrapStepAsRowStep(step({ type: 'code', lines: [] }));

    const single: Row = { kind: 'single', step: diffStep };
    expect(rowHasWideContent(single)).toBe(true);

    const cluster: Row = {
      kind: 'cluster', id: 'c1', key: 'c1', iconKind: 'edit', head: 'edits',
      items: [plainStep, diffStep],
    };
    expect(rowHasWideContent(cluster)).toBe(true);

    const activity = {
      kind: 'activity', id: 'a1', opCount: 1, hasActive: false,
      rows: [{ kind: 'single', step: plainStep }],
    } as Row;
    expect(rowHasWideContent(activity)).toBe(false);
  });

  it('message 行不是宽内容', () => {
    const message = { kind: 'message', message: {} } as unknown as Row;
    expect(rowHasWideContent(message)).toBe(false);
  });
});
