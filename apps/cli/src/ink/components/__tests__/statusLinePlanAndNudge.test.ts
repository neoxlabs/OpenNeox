import { describe, expect, it } from 'vitest';
import { planProgress, contextNudgeFor } from '../StatusLine.js';

describe('状态行的计划进度', () => {
  it('第几步 = 已完成 + 正在做的那一步; 格数 = 已完成', () => {
    expect(planProgress([
      { step: 'a', status: 'completed' },
      { step: 'b', status: 'in_progress' },
      { step: 'c', status: 'pending' },
    ])).toEqual({ current: 2, total: 3, done: 1 });
  });
  it('还没开始: 第 1 步', () => {
    expect(planProgress([{ step: 'a', status: 'pending' }, { step: 'b', status: 'pending' }])).toEqual({ current: 1, total: 2, done: 0 });
  });
  it('没有计划或只有一步: 不显示', () => {
    expect(planProgress([])).toBeNull();
    expect(planProgress([{ step: 'a', status: 'in_progress' }])).toBeNull();
  });
});

describe('上下文快满的提醒', () => {
  it('默认阈值 85%: 73% 起提醒, 到 85% 就该自动压缩了, 不再提醒', () => {
    expect(contextNudgeFor(0.72, 0.85)).toBeNull();
    expect(contextNudgeFor(0.78, 0.85)).toEqual({ pct: 78, at: 85 });
    expect(contextNudgeFor(0.86, 0.85)).toBeNull();
  });
  it('阈值调到 90%: 跟设计稿一样 78% 时提醒「到 90% 会自动压缩」', () => {
    expect(contextNudgeFor(0.78, 0.9)).toEqual({ pct: 78, at: 90 });
  });
  it('阈值很低时也不早于 70%', () => {
    expect(contextNudgeFor(0.65, 0.7)).toBeNull();
  });
  it('拿不到窗口大小 (pressure 未知) 不提醒', () => {
    expect(contextNudgeFor(undefined, 0.85)).toBeNull();
  });
});
