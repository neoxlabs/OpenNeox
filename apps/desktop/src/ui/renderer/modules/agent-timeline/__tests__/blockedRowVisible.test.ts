import { describe, it, expect } from 'vitest';
import { buildTimelineRows, __resetBuildSegmentCacheForTests } from '../timelineRows';
import type { Row } from '../timelineRows';

const msg = (id: string, role: 'user' | 'assistant', text: string) =>
  ({ kind: 'message', id, role, text, timestamp: new Date(1700000000000).toISOString() } as never);
const tool = (id: string, title: string) =>
  ({ kind: 'tool', id, title, iconKind: 'read', status: 'done' } as never);
const blockedStep = (id: string, notice: string) =>
  ({
    kind: 'tool', id, title: '读取文件', iconKind: 'read', status: 'done',
    blockedBy: 'loop',
    content: { type: 'log', level: 'info', message: notice },
  } as never);

const flatIds = (rows: Row[]): string[] => rows.flatMap((r) => {
  // step 是联合类型, 其中 LegacyStepRow 这一支没有 id —— 这里只关心带 id 的那支
  if (r.kind === 'single') return [(r as Extract<Row, { kind: 'single' }>).step as unknown as { id: string }].map((s) => s.id);
  return [];
});

describe('被拦下的那一行', () => {
  it('不被折进 activity 摘要 —— 顶层能直接看到', () => {
    __resetBuildSegmentCacheForTests();
    const rows = buildTimelineRows([
      msg('u1', 'user', '读一下那个文件'),
      tool('t1', 'read_file · a.ts'),
      blockedStep('b1', '同一个目标重复了 4 次 · mainWindowFactory.ts'),
      tool('t2', 'read_file · b.ts'),
    ] as never, false, new Set(), true, true);
    expect(flatIds(rows)).toContain('b1');
  });

  it('对照: 普通读取该折就折', () => {
    __resetBuildSegmentCacheForTests();
    const rows = buildTimelineRows([
      msg('u1', 'user', '读一下'),
      tool('t1', 'read_file · a.ts'),
      tool('t2', 'read_file · b.ts'),
      tool('t3', 'read_file · c.ts'),
    ] as never, false, new Set(), true, true);
    expect(flatIds(rows)).not.toContain('t2');
  });
});
