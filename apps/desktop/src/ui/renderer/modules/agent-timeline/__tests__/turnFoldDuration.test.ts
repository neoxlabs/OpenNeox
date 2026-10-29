import { describe, test, expect } from 'vitest';
import { buildTimelineRows, __resetBuildSegmentCacheForTests, type Row } from '../timelineRows';

const T0 = 1_700_000_000_000;
const msg = (id: string, role: 'user' | 'assistant', at: number) =>
  ({ kind: 'message', id, role, text: id, timestamp: new Date(at).toISOString() }) as never;
const tool = (id: string, at: number, dur = '1s') =>
  ({ kind: 'tool', id, title: `read_file · ${id}.ts`, iconKind: 'read', status: 'done', startedAtMs: at, duration: dur }) as never;

function foldOf(items: unknown[]): Extract<Row, { kind: 'turn_fold' }> {
  __resetBuildSegmentCacheForTests();
  const rows = buildTimelineRows(items as never, false, new Set(), true, false);
  return rows.find((r) => r.kind === 'turn_fold') as Extract<Row, { kind: 'turn_fold' }>;
}

describe('turn_fold 时长', () => {
  test('用户发出 → 工具 → 回复, 中间的想和写都算', () => {
    const f = foldOf([
      msg('u', 'user', T0),
      tool('a', T0 + 15_000),
      tool('b', T0 + 20_000),
      msg('done', 'assistant', T0 + 40_000),
    ]);
    expect(f.durationMs).toBe(40_000);
  });

  test('重试前隔了几分钟的空档不算', () => {
    const f = foldOf([
      msg('u', 'user', T0),
      tool('a', T0 + 5_000),
      tool('b', T0 + 300_000),
      msg('done', 'assistant', T0 + 310_000),
    ]);
    expect(f.durationMs).toBe(6_000 + 10_000);
  });
});
