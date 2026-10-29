import { describe, expect, it } from 'vitest';
import { stableCardOrder } from './stableCardOrder';

describe('stableCardOrder', () => {
  it('首次: 照 next 原样', () => {
    expect(stableCardOrder([], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('已在的卡开始新一轮 (next 里跑到最前) → 位置不动', () => {
    expect(stableCardOrder(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual(['a', 'b', 'c']);
  });

  it('新来的填进离开的那个槽位', () => {
    expect(stableCardOrder(['a', 'b', 'c'], ['d', 'a', 'c'])).toEqual(['a', 'd', 'c']);
  });

  it('多出来的新卡接在末尾, 没人填的空槽收掉', () => {
    expect(stableCardOrder(['a', 'b'], ['x', 'y', 'b'])).toEqual(['x', 'b', 'y']);
    expect(stableCardOrder(['a', 'b', 'c'], ['c'])).toEqual(['c']);
  });

  it('newcomersFirst: 新来的排最前, 已有的保持相对位置', () => {
    expect(stableCardOrder(['a', 'b', 'c'], ['b', 'n', 'c', 'a'], true)).toEqual(['n', 'a', 'b', 'c']);
    expect(stableCardOrder(['a', 'b', 'c'], ['c', 'b'], true)).toEqual(['b', 'c']);
  });

  it('同一输入再算一遍结果不变 (StrictMode 双渲染安全)', () => {
    const once = stableCardOrder(['a', 'b', 'c'], ['d', 'c', 'a']);
    expect(stableCardOrder(once, ['d', 'c', 'a'])).toEqual(once);
  });
});
