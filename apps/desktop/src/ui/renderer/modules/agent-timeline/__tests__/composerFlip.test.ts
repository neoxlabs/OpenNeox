
import { describe, it, expect } from 'vitest';
import { shouldPlayComposerFlip, FLIP_MIN_DELTA_PX } from '../hooks/useComposerFlip';

const base = { enabled: true, wasCentered: true, centered: false, startTop: 358, endTop: 640 };

describe('shouldPlayComposerFlip · 只在"居中 → 落底"播一次', () => {
  it('居中 → 落底 且位移足够 → 播', () => {
    expect(shouldPlayComposerFlip(base)).toBe(true);
  });

  it('状态没变 → 不播 (v3 实测这种情况真的会发生, 且是抖动的元凶之一)', () => {
    expect(shouldPlayComposerFlip({ ...base, wasCentered: true, centered: true })).toBe(false);
    expect(shouldPlayComposerFlip({ ...base, wasCentered: false, centered: false })).toBe(false);
  });

  it('反向 (落底 → 居中) 不播 —— 那是用户主动切上下文, 平移过去反而拖沓', () => {
    expect(shouldPlayComposerFlip({ ...base, wasCentered: false, centered: true })).toBe(false);
  });

  it('首次渲染 (没有起点) 不播 —— 否则进页面就飞一下', () => {
    expect(shouldPlayComposerFlip({ ...base, startTop: null })).toBe(false);
  });

  it('位移太小不播 —— 免得把普通重排误当布局切换', () => {
    expect(shouldPlayComposerFlip({ ...base, startTop: 360, endTop: 360 })).toBe(false);
    expect(shouldPlayComposerFlip({ ...base, startTop: 360, endTop: 360 + FLIP_MIN_DELTA_PX - 1 })).toBe(false);
  });

  it('刚好到阈值就播', () => {
    expect(shouldPlayComposerFlip({ ...base, startTop: 360, endTop: 360 + FLIP_MIN_DELTA_PX })).toBe(true);
  });

  it('enabled=false 一律不播 (reduced-motion / 关动画开关的口子)', () => {
    expect(shouldPlayComposerFlip({ ...base, enabled: false })).toBe(false);
  });
});

describe('空态单向锁存 · 抖动不该翻回居中', () => {
  /**
   * 复刻 AgentTimelineView 里的推导 —— 一旦离开空态就不再回去, 换会话才解锁。
   * 这是 v4 的关键: 没有它, items.length 的瞬时抖动会让动画被触发四次。
   */
  const NO_SESSION = '__neox_no_session__';
  function makeLatch() {
    let leftEmpty: string | null = null;
    let lastSession: string | null | undefined;
    return (rawEmpty: boolean, sessionKey: string | null) => {
      if (lastSession !== sessionKey) { lastSession = sessionKey; leftEmpty = null; }
      const key = sessionKey ?? NO_SESSION;
      if (!rawEmpty) leftEmpty = key;
      return rawEmpty && leftEmpty !== key;
    };
  }

  it('空 → 有内容 → 空(抖动) 时不会翻回居中', () => {
    const latch = makeLatch();
    expect(latch(true, 's1')).toBe(true);    /* 空态 */
    expect(latch(false, 's1')).toBe(false);  /* 首条消息落地 */
    expect(latch(true, 's1')).toBe(false);   /* ← 抖动回 0, 但绝不能翻回居中 */
    expect(latch(false, 's1')).toBe(false);
  });

  it('换会话后新会话该有自己的空态', () => {
    const latch = makeLatch();
    latch(true, 's1'); latch(false, 's1');
    expect(latch(true, 's2')).toBe(true);
  });

  it('一直是空态就一直居中', () => {
    const latch = makeLatch();
    for (let i = 0; i < 5; i++) expect(latch(true, 's1')).toBe(true);
  });

  it('一进来就有内容 → 从不居中', () => {
    const latch = makeLatch();
    expect(latch(false, 's1')).toBe(false);
    expect(latch(false, 's1')).toBe(false);
  });

  it('无会话 (null) 也不崩', () => {
    const latch = makeLatch();
    expect(latch(true, null)).toBe(true);
    expect(latch(false, null)).toBe(false);
  });
});
