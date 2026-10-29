import { describe, it, expect, beforeEach } from 'vitest';
import {
  setTimelineHydrating, getTimelineHydratingSessionId, subscribeTimelineFeed,
} from '../timelineFeedStore';

beforeEach(() => setTimelineHydrating(null));

describe('水合标记', () => {
  it('标记 / 解除', () => {
    setTimelineHydrating('s1');
    expect(getTimelineHydratingSessionId()).toBe('s1');
    setTimelineHydrating(null);
    expect(getTimelineHydratingSessionId()).toBeNull();
  });

  it('订阅者能收到变更 —— 否则 useSyncExternalStore 不会重渲, 骨架不会消失', () => {
    let hits = 0;
    const un = subscribeTimelineFeed(() => { hits += 1; });
    setTimelineHydrating('s1');
    expect(hits).toBeGreaterThan(0);
    un();
  });

  it('同值重复设置不 notify —— 流式期间高频调用不该把整棵树重渲一遍', () => {
    setTimelineHydrating('s1');
    let hits = 0;
    const un = subscribeTimelineFeed(() => { hits += 1; });
    setTimelineHydrating('s1');
    setTimelineHydrating('s1');
    expect(hits).toBe(0);
    un();
  });

  it('存 id 而不是布尔 —— 快速连切会话时后一次的标记不能被前一次的结束清掉', () => {
    /* 真实时序: 打开 s1 → 立刻切 s2 → s1 的加载才返回。
       如果存布尔, s1 的 finally 会把 s2 的水合标记清掉 → s2 闪空状态。
       存 id 的话, s1 的 finally 会先比对发现"当前等的是 s2", 什么都不做。 */
    setTimelineHydrating('s1');
    setTimelineHydrating('s2');
    const stillWaitingFor = getTimelineHydratingSessionId();
    /* s1 的 finally 里的守卫 */
    if (stillWaitingFor === 's1') setTimelineHydrating(null);
    expect(getTimelineHydratingSessionId()).toBe('s2');
  });
});

describe('视图三态判定', () => {
  /* AgentTimelineView 里那一行的语义复刻 —— 它是纯表达式, 值得单独钉住 */
  const isHydrating = (activeId: string | null, hydratingId: string | null) =>
    !!activeId && hydratingId === activeId;

  it('正在加载当前会话 → 显示骨架', () => {
    expect(isHydrating('s1', 's1')).toBe(true);
  });
  it('加载的是别的会话 → 不显示骨架', () => {
    expect(isHydrating('s1', 's2')).toBe(false);
  });
  it('没有会话 (主界面) → 永远不显示骨架', () => {
    expect(isHydrating(null, 's1')).toBe(false);
    expect(isHydrating(null, null)).toBe(false);
  });
  it('加载完成 → 不再显示骨架', () => {
    expect(isHydrating('s1', null)).toBe(false);
  });
});
