
import { describe, it, expect } from 'vitest';
import { createEmptyFocusLatch, stepEmptyFocusLatch } from '../emptyFocusLatch';

/** 把一串 (会话, 是否空) 依次喂进去, 返回每帧的 codeEmptyFocus */
const run = (frames: Array<[string | null, boolean]>, initial: string | null = frames[0][0]) => {
  const st = createEmptyFocusLatch(initial);
  return frames.map(([k, empty]) => stepEmptyFocusLatch(st, k, empty));
};

describe('空态锁存 · 基本行为', () => {
  it('空会话 → 走居中空态', () => {
    expect(run([['s1', true]])).toEqual([true]);
  });

  it('有消息 → 不走空态', () => {
    expect(run([['s1', true], ['s1', false]])).toEqual([true, false]);
  });

  it('单向: 离开空态后即使 items 抖回 0 也不再回空态', () => {
    /* 首条消息落地过程中的真实抖动序列 */
    expect(run([['s1', true], ['s1', false], ['s1', true], ['s1', false]]))
      .toEqual([true, false, false, false]);
  });

  it('抖动期间只发生一次 true→false 跳变 (动画只会被触发一次)', () => {
    const seq = run([['s1', true], ['s1', true], ['s1', false], ['s1', true], ['s1', false], ['s1', false]]);
    let flips = 0;
    for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1]) flips++;
    expect(flips, `实际序列 ${JSON.stringify(seq)}`).toBe(1);
  });
});

describe('空态锁存 · 边界 1 · 无会话 (sessionKey = null)', () => {
  it('没有会话时空态照样出现 —— 不能被 null 初值判等吃掉', () => {
    expect(run([[null, true]], null)).toEqual([true]);
  });

  it('无会话下不上锁 —— 残影抖一帧后仍要回到居中空态 (死锁修复)', () => {
    expect(run([[null, true], [null, false], [null, true]], null))
      .toEqual([true, false, true]);
  });

  it('无会话下反复抖动也一直能回来 (key 恒为 null, 没有"切换"可依赖)', () => {
    expect(run([[null, true], [null, false], [null, true], [null, false], [null, true]], null))
      .toEqual([true, false, true, false, true]);
  });

  it('有会话时单向锁不受影响 —— 别把防抖动那条一起放开了', () => {
    expect(run([['s1', true], ['s1', false], ['s1', true]]))
      .toEqual([true, false, false]);
  });
});

describe('空态锁存 · 边界 2 · 切会话时 items 滞后 (用户实拍的那个 bug)', () => {
  it('切到新会话的那一帧 items 还是旧会话的 → 不许上锁, 下一帧仍要给空态', () => {
    const seq = run([
      ['s1', true],
      ['s1', false],   // s1 有消息了
      ['s2', false],   // ← 切到 s2, 但 items 还是 s1 的: 这一帧不能上锁
      ['s2', true],    // items 跟上来了, 必须回到居中空态
    ]);
    expect(seq[3], '新建会话必须走居中空态').toBe(true);
  });

  it('滞后好几帧也一样 (items 更新可能慢一两帧)', () => {
    const seq = run([['s1', false], ['s2', false], ['s2', false], ['s2', false], ['s2', true]]);
    expect(seq[4]).toBe(true);
  });

  it('切到一个本来就有历史消息的会话 → 全程不给空态, 不误开', () => {
    expect(run([['s1', true], ['s1', false], ['s2', false], ['s2', false]]))
      .toEqual([true, false, false, false]);
  });

  it('新会话看见空之后, 它自己发消息仍然正常上锁 (滞后豁免只用一次)', () => {
    const seq = run([
      ['s1', false],
      ['s2', false],   // 滞后帧
      ['s2', true],    // 新会话空态
      ['s2', false],   // 自己发了消息 → 上锁
      ['s2', true],    // 抖回 0 也不许回空态
    ]);
    expect(seq).toEqual([false, false, true, false, false]);
  });

  it('来回切两个会话, 各自的锁互不串味', () => {
    const st = createEmptyFocusLatch('s1');
    expect(stepEmptyFocusLatch(st, 's1', true)).toBe(true);
    expect(stepEmptyFocusLatch(st, 's1', false)).toBe(false);   // s1 上锁
    stepEmptyFocusLatch(st, 's2', false);                        // 滞后帧
    expect(stepEmptyFocusLatch(st, 's2', true)).toBe(true);      // s2 有自己的空态
    stepEmptyFocusLatch(st, 's1', false);                        // 切回 s1 的滞后帧
    expect(stepEmptyFocusLatch(st, 's1', true), 's1 回来时锁已随切换重置').toBe(true);
  });
});
