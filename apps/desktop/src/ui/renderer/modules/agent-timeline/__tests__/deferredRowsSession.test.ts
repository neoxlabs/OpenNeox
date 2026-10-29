import { describe, test, expect } from 'vitest';

/** 与 hook 尾部同形的纯判据 */
function pick<T>(displayedSession: string | null, currentSession: string | null, state: T[], computed: T[]): T[] {
  return displayedSession === currentSession ? state : computed;
}

describe('切会话时渲染哪一份行', () => {
  test('★ 归属不匹配 → 用 computedRows, 不给旧行任何一帧', () => {
    const oldRows = ['思考 · 1.0s · 162 字', '列目录'];
    const newRows: string[] = [];           // 新会话 msgCount=0, 一行都没有
    /* effect 还没跑: displayedSession 仍是旧会话 */
    expect(pick('sess-old', 'sess-new', oldRows, newRows)).toEqual([]);
  });

  test('归属匹配 → 用 state (defer/滚动稳定那套照常生效)', () => {
    const state = ['a', 'b'];
    const computed = ['a', 'b', 'c'];       // 正在 defer 的新内容
    expect(pick('sess-1', 'sess-1', state, computed)).toEqual(state);
  });

  test('effect 跑完对齐后回到 state', () => {
    const state = ['x'];
    const computed = ['x', 'y'];
    expect(pick('sess-new', 'sess-new', state, computed)).toEqual(state);
  });

  test('null / undefined 会话也按同一规则, 不能因为"没归属"就放行旧行', () => {
    expect(pick('sess-old', null, ['旧行'], [])).toEqual([]);
    expect(pick(null, 'sess-new', ['旧行'], [])).toEqual([]);
    expect(pick(null, null, ['保留'], [])).toEqual(['保留']);
  });
});
