import { describe, test, expect } from 'vitest';
import { buildTimelineRows, __resetBuildSegmentCacheForTests } from '../timelineRows';
import type { Row } from '../timelineRows';

function msg(id: string, role: 'user' | 'assistant', text: string) {
  return { kind: 'message', id, role, text, timestamp: new Date(1700000000000).toISOString() } as never;
}
function tool(id: string, title: string) {
  return { kind: 'tool', id, title, iconKind: 'plugin', status: 'done' } as never;
}
const build = (items: unknown[]) => buildTimelineRows(items as never, false, new Set(), true, false);
const foldOf = (rows: Row[]) => rows.find(r => r.kind === 'turn_fold') as Extract<Row, { kind: 'turn_fold' }>;

describe('turn_fold 拆掉单段 activity', () => {
  test('一段 activity → fold 里直接是步骤, 统计不变', () => {
    __resetBuildSegmentCacheForTests();
    const fold = foldOf(build([
      msg('u1', 'user', 'q'),
      tool('t1', 'Gcal list events'),
      { kind: 'tool', id: 'th1', title: 'Thought', iconKind: 'thinking', status: 'done',
        content: { type: 'thinking', text: '想一想' } } as never,
      msg('a1', 'assistant', 'done'),
    ]));
    expect(fold).toBeTruthy();
    expect(fold.rows.map(r => r.kind)).toEqual(['single', 'single']);
    expect(fold.opCount).toBe(1);
  });

  test('两段 activity (中间有助手短评) → 原样保留, 那句短评是分段的依据', () => {
    __resetBuildSegmentCacheForTests();
    const fold = foldOf(build([
      msg('u1', 'user', 'q'),
      tool('a', 'Gcal list events'), tool('b', 'Gcal list events'),
      msg('mid', 'assistant', '先看看日历'),
      tool('c', 'Gcal create event'), tool('d', 'Gcal create event'),
      msg('a1', 'assistant', 'done'),
    ]));
    expect(fold.rows.map(r => r.kind)).toEqual(['activity', 'message', 'activity']);
  });
});
