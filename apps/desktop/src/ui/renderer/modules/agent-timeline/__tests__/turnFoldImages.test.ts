import { describe, test, expect } from 'vitest';
import { buildTimelineRows, __resetBuildSegmentCacheForTests } from '../timelineRows';
import type { Row } from '../timelineRows';

function msg(id: string, role: 'user' | 'assistant', text: string) {
  return { kind: 'message', id, role, text, timestamp: new Date(1700000000000).toISOString() } as never;
}
function tool(id: string, title: string) {
  return { kind: 'tool', id, title, iconKind: 'read', status: 'done' } as never;
}
function image(id: string, path: string) {
  return {
    kind: 'tool', id, title: '生成图片', iconKind: 'read', status: 'done',
    content: { type: 'image', paths: [path], count: 1, model: 'gpt-image-2' },
  } as never;
}

const build = (items: unknown[], streaming = false) =>
  buildTimelineRows(items as never, false, new Set(), true, streaming);

const foldsOf = (rows: Row[]) =>
  rows.filter(r => r.kind === 'turn_fold') as Array<Extract<Row, { kind: 'turn_fold' }>>;

const IMG = '/ws/2026-08-19-images/blue-square.png';

const turn = () => [
  msg('u1', 'user', '画一张图'),
  tool('t1', 'write_file · a.ts'),
  image('i1', IMG),
  msg('a1', 'assistant', '画好了'),
  msg('u2', 'user', '下一轮'),
];

describe('生图产物不被折叠', () => {
  test('封口 turn: 图留在折叠外, 过程仍被折起来', () => {
    __resetBuildSegmentCacheForTests();
    const rows = build(turn());
    expect(foldsOf(rows)).toHaveLength(1);
    expect(rows.some(r => JSON.stringify(r).includes(IMG))).toBe(true);
    expect(JSON.stringify(foldsOf(rows)[0]!.rows)).not.toContain(IMG);
  });

  test('顺序: 折叠条 → 回答正文 → 图', () => {
    __resetBuildSegmentCacheForTests();
    const rows = build(turn());
    const idxFold = rows.findIndex(r => r.kind === 'turn_fold');
    const idxAnswer = rows.findIndex(r => r.kind === 'message'
      && (r as Extract<Row, { kind: 'message' }>).message.text === '画好了');
    const idxImg = rows.findIndex(r => JSON.stringify(r).includes(IMG));
    expect(idxFold).toBeGreaterThan(-1);
    expect(idxAnswer).toBeGreaterThan(idxFold);
    expect(idxImg).toBeGreaterThan(idxAnswer);
  });

  test('展开过程时图不重复: 顶层只有一份, 折叠组里没有', () => {
    __resetBuildSegmentCacheForTests();
    const rows = build(turn());
    const hits = rows.filter(r => JSON.stringify(r).includes(IMG));
    expect(hits).toHaveLength(1);
  });
});
