import { describe, expect, it } from 'vitest';
import { deepResearchLiveContent, deepResearchCardContent } from '../deepResearchTimelineCard';

const runningEntry = (over: Record<string, unknown> = {}) => ({
  pending: true,
  toolName: 'deep_research',
  deepResearchPhase: 'running',
  deepResearchTopic: 'Vite vs Webpack',
  deepResearchScale: 'compare',
  deepResearchStartedAt: 1_700_000_000_000,
  deepResearchReportPath: '/w/.neox/research/vite/report.md',
  deepResearchStats: {
    sources: 19, domains: 14, claims: 35, disputed: 3, singleSource: 24,
    dispatched: 6, completed: 3, failed: 0, inFlight: 3, queued: 0,
    concurrency: 3, maxWorkers: 10,
  },
  deepResearchWorkers: [
    { id: 'w1', question: '冷启动', status: 'done', summary: '8787ms', toolCount: 26, tokens: 22400 },
    { id: 'w2', question: '构建耗时', status: 'running', currentTool: 'web_fetch', toolCount: 18, tokens: 7300 },
  ],
  ...over,
});

describe('活卡', () => {
  it('跑的时候出活卡, 带每一路和各自的 token', () => {
    const c: any = deepResearchLiveContent(runningEntry());
    expect(c?.type).toBe('deep_research');
    expect(c.phase).toBe('running');
    expect(c.workers).toHaveLength(2);
    expect(c.workers[1].currentTool).toBe('web_fetch');
    /* 卡头那个合计 = 各路之和 */
    expect(c.totalTokens).toBe(29700);
  });

  it('没有活卡数据的条目不认 —— 别的工具不受影响', () => {
    expect(deepResearchLiveContent({ toolName: 'web_fetch', pending: true })).toBeUndefined();
    expect(deepResearchLiveContent(undefined)).toBeUndefined();
  });

  it('⭐️ 工具条目落定 = 这轮结束了, 哪怕调度器的 done 没来', () => {
    const c: any = deepResearchLiveContent(runningEntry({ pending: false }));
    expect(c.phase).toBe('done');
    expect(c.interrupted).toBe(true);
    /* 中断时这是用户唯一的去处 */
    expect(c.reportPath).toBe('/w/.neox/research/vite/report.md');
  });

  it('正常跑完的不算中断', () => {
    const c: any = deepResearchLiveContent(runningEntry({ pending: false, deepResearchPhase: 'done' }));
    expect(c.phase).toBe('done');
    expect(c.interrupted).toBeUndefined();
  });
});

describe('结果卡', () => {
  it('按 metadata 分流, 不看工具名 (模型多半经 call_tool 调)', () => {
    const c: any = deepResearchCardContent({
      deep_research: {
        topic: 'T', scale: 'compare', stopReason: 'converged', dispatched: 3,
        reportPath: '/w/report.md',
        stats: { sources: 20, domains: 10, claims: 25, supported: 2, singleSource: 23, disputed: 2, unverified: 0, archivedChars: 4 },
        domains: ['a.com'], disputes: [], unexplored: [],
      },
    }, true);
    expect(c?.type).toBe('deep_research');
    expect(c.phase).toBe('done');
  });

  it('什么都没查到就不出壳 —— 让下面的错误卡说话', () => {
    const c = deepResearchCardContent({
      deep_research: { topic: 'T', stats: { sources: 0, claims: 0 } },
    }, true);
    expect(c).toBeUndefined();
  });
});
