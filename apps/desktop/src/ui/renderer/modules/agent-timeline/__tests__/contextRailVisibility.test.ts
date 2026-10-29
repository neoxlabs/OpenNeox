import { describe, expect, it } from 'vitest';

type Layout = 'split' | 'swap' | 'tabs';
type Tab = 'timeline' | 'surface';

/** 复刻 AgentTimelineView 的判据。真实实现改了这里要一起改。 */
function railVisible(input: {
  layout: Layout;
  activeTab: Tab;
  shellWidth: number;
  hiddenByUser: boolean;
  itemCount: number;
  /** 迟滞: 上一次的结论 (SHOW 912 / HIDE 876) */
  prevFits?: boolean;
}): boolean {
  const { layout, activeTab, shellWidth, hiddenByUser, itemCount, prevFits = false } = input;
  const timelineIsVisible = layout !== 'tabs' || activeTab === 'timeline';
  const fits = prevFits ? shellWidth >= 876 : shellWidth >= 912;
  return timelineIsVisible && fits && !hiddenByUser && itemCount > 0;
}

const base = { layout: 'split' as Layout, activeTab: 'timeline' as Tab, shellWidth: 1098, hiddenByUser: false, itemCount: 10 };

describe('看得见 timeline 就该有右栏', () => {
  it('split 版面: 两边同时在, 右栏显示', () => {
    expect(railVisible(base)).toBe(true);
  });

  it('swap 版面 (产出在左/对话在右): 同样显示', () => {
    expect(railVisible({ ...base, layout: 'swap' })).toBe(true);
  });

  it('tabs 版面 + 停在对话侧: 显示', () => {
    expect(railVisible({ ...base, layout: 'tabs', activeTab: 'timeline' })).toBe(true);
  });
});

describe('⚠️ Surface 面板展开 ≠ 用户在看 Surface', () => {
  it('split 版面下 Surface 面板开着, 右栏照常在', () => {
    expect(railVisible({ ...base, layout: 'split', activeTab: 'timeline' })).toBe(true);
  });
});

describe('切到 Surface 那一侧就不该在', () => {
  it('tabs 版面 + 停在 Surface 侧: 不显示', () => {
    expect(railVisible({ ...base, layout: 'tabs', activeTab: 'surface' })).toBe(false);
  });
});

describe('宽度不够仍然藏 (这一条没变)', () => {
  it('低于 SHOW 阈值 912: 不显示', () => {
    expect(railVisible({ ...base, shellWidth: 900 })).toBe(false);
  });

  it('迟滞: 已显示时降到 876~912 之间不翻脸', () => {
    expect(railVisible({ ...base, shellWidth: 890, prevFits: true })).toBe(true);
  });

  it('迟滞: 已显示时跌破 876 才藏', () => {
    expect(railVisible({ ...base, shellWidth: 870, prevFits: true })).toBe(false);
  });
});

describe('另外两条前提照旧', () => {
  it('用户手动藏了就不显示', () => {
    expect(railVisible({ ...base, hiddenByUser: true })).toBe(false);
  });

  it('这次对话还没开始 (items 为空) 不显示 —— 免得空态被它挤偏', () => {
    expect(railVisible({ ...base, itemCount: 0 })).toBe(false);
  });
});
