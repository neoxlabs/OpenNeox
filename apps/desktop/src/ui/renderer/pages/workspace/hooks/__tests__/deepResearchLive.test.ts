import { describe, expect, it } from 'vitest';
import {
  isDeepResearchEntry,
  applyResearchProgress,
  bindResearchWorker,
  applyResearchWorkerTool,
  applyResearchWorkerTokens,
  markResearchWorkerDone,
  stripWorkerTaskPrefix,
  totalResearchTokens,
  type ResearchLiveFields,
} from '../deepResearchLive';

const progress = (over: Record<string, unknown> = {}) => ({
  type: 'research_progress',
  phase: 'tick',
  topic: 'Vite 相比 Webpack 的取舍',
  scale: 'compare',
  sources: 15, domains: 14, claims: 30, disputed: 4, singleSource: 24,
  dispatched: 3, completed: 1, failed: 0, inFlight: 2, queued: 0,
  concurrency: 3, maxWorkers: 10,
  workers: [
    { id: 'w1', question: '冷启动与 HMR 实测', status: 'done', summary: '实测 8787ms' },
    { id: 'w2', question: '生产构建耗时', status: 'running' },
    { id: 'w3', question: '生态兼容性', status: 'running' },
  ],
  ...over,
});

describe('认父卡', () => {
  it('工具名直呼其名', () => {
    expect(isDeepResearchEntry({ toolName: 'deep_research' })).toBe(true);
  });

  it('⭐️ 经 call_tool 调的也要认 —— 按名字分流会一张卡都出不来', () => {
    expect(isDeepResearchEntry({ toolName: 'call_tool', toolArgs: { name: 'deep_research' } })).toBe(true);
    expect(isDeepResearchEntry({ toolName: 'call_tool', toolArgs: { tool_name: 'deep_research' } })).toBe(true);
  });

  it('别的工具不认', () => {
    expect(isDeepResearchEntry({ toolName: 'web_fetch' })).toBe(false);
    expect(isDeepResearchEntry(undefined)).toBe(false);
  });
});

describe('进度事件喂卡', () => {
  it('一条事件就能画出整张卡: 题目/统计/每一路', () => {
    const next = applyResearchProgress({}, progress());
    expect(next.deepResearchTopic).toContain('Vite');
    expect(next.deepResearchPhase).toBe('running');
    expect(next.deepResearchStats?.claims).toBe(30);
    expect(next.deepResearchStats?.inFlight).toBe(2);
    expect(next.deepResearchWorkers?.map((w) => w.status)).toEqual(['done', 'running', 'running']);
  });

  it('done 相就是 done —— 卡片据此收敛', () => {
    const next = applyResearchProgress({}, progress({ phase: 'done' }));
    expect(next.deepResearchPhase).toBe('done');
  });

  it('⭐️ 进度刷新不许把 token / 工具数抹掉', () => {
    /* 这两个是子 agent 事件攒的, 调度器根本不知道。每来一条进度就盖掉的话,
     * token 数字会一秒跳一次 0 —— 用户盯着的就是这个数。 */
    let s: ResearchLiveFields = applyResearchProgress({}, progress());
    s = bindResearchWorker(s, 'Agent-1', '调研: 生产构建耗时');
    s = applyResearchWorkerTokens(s, 'Agent-1', 21400, 'add');
    s = applyResearchWorkerTool(s, 'Agent-1', 'web_fetch');

    s = applyResearchProgress(s, progress({ claims: 33 }));

    const row = s.deepResearchWorkers?.find((w) => w.id === 'w2');
    expect(row?.tokens).toBe(21400);
    expect(row?.toolCount).toBe(1);
    expect(row?.agentId).toBe('Agent-1');
    expect(s.deepResearchStats?.claims).toBe(33);
  });

  it('跑完的那一路不再顶着"正在 web_fetch"', () => {
    let s: ResearchLiveFields = applyResearchProgress({}, progress());
    s = bindResearchWorker(s, 'Agent-2', '调研: 生产构建耗时');
    s = applyResearchWorkerTool(s, 'Agent-2', 'web_fetch');
    expect(s.deepResearchWorkers?.find((w) => w.id === 'w2')?.currentTool).toBe('web_fetch');

    s = applyResearchProgress(s, progress({
      workers: [
        { id: 'w1', question: '冷启动与 HMR 实测', status: 'done' },
        { id: 'w2', question: '生产构建耗时', status: 'done', summary: '查完了' },
        { id: 'w3', question: '生态兼容性', status: 'running' },
      ],
    }));
    expect(s.deepResearchWorkers?.find((w) => w.id === 'w2')?.currentTool).toBeUndefined();
  });

  it('起手 start 事件里全是 queued, 卡片立刻有三行可画', () => {
    const next = applyResearchProgress({}, progress({
      phase: 'start', completed: 0, inFlight: 0, queued: 3, dispatched: 0,
      workers: [
        { id: 'w1', question: 'a', status: 'queued' },
        { id: 'w2', question: 'b', status: 'queued' },
        { id: 'w3', question: 'c', status: 'queued' },
      ],
    }));
    expect(next.deepResearchWorkers).toHaveLength(3);
    expect(next.deepResearchPhase).toBe('running');
  });
});

describe('子 agent 绑到行上', () => {
  it('按题目前缀绑 —— 派活的 description 就是题目前 60 字', () => {
    const s = bindResearchWorker(applyResearchProgress({}, progress()), 'Agent-7', '调研: 生态兼容性');
    expect(s.deepResearchWorkers?.find((w) => w.id === 'w3')?.agentId).toBe('Agent-7');
  });

  it('题目被截断过也能绑上', () => {
    const s = bindResearchWorker(applyResearchProgress({}, progress()), 'Agent-7', '调研: 冷启动与 HMR');
    expect(s.deepResearchWorkers?.find((w) => w.id === 'w1')?.agentId).toBe('Agent-7');
  });

  it('对不上前缀就退到第一个没绑的在跑行, 不能整行没 token', () => {
    const s = bindResearchWorker(applyResearchProgress({}, progress()), 'Agent-9', '调研: 完全对不上的题目');
    const bound = s.deepResearchWorkers?.filter((w) => w.agentId === 'Agent-9');
    expect(bound).toHaveLength(1);
    expect(bound?.[0].status).toBe('running');
  });

  it('同一个 agent 不重复绑', () => {
    let s = bindResearchWorker(applyResearchProgress({}, progress()), 'Agent-7', '调研: 生态兼容性');
    s = bindResearchWorker(s, 'Agent-7', '调研: 生态兼容性');
    expect(s.deepResearchWorkers?.filter((w) => w.agentId === 'Agent-7')).toHaveLength(1);
  });

  it('前缀剥离认中英文几种写法', () => {
    expect(stripWorkerTaskPrefix('调研: abc')).toBe('abc');
    expect(stripWorkerTaskPrefix('调研：abc')).toBe('abc');
    expect(stripWorkerTaskPrefix('abc')).toBe('abc');
  });
});

describe('收工 / 中断', () => {
  it('worker_complete 把那一行收成 done, 并摘掉"正在干什么"', () => {
    let s: ResearchLiveFields = applyResearchProgress({}, progress());
    s = bindResearchWorker(s, 'A', '调研: 生产构建耗时');
    s = applyResearchWorkerTool(s, 'A', 'web_fetch');
    s = markResearchWorkerDone(s, 'A', true, '查到 6 组可量化对照', 20);

    const row = s.deepResearchWorkers?.find((w) => w.id === 'w2');
    expect(row?.status).toBe('done');
    expect(row?.summary).toContain('6 组');
    expect(row?.toolCount).toBe(20);
    expect(row?.currentTool).toBeUndefined();
  });

  it('失败的那一路记 failed, 不是消失也不是 done', () => {
    let s: ResearchLiveFields = applyResearchProgress({}, progress());
    s = bindResearchWorker(s, 'A', '调研: 生产构建耗时');
    s = markResearchWorkerDone(s, 'A', false);
    expect(s.deepResearchWorkers?.find((w) => w.id === 'w2')?.status).toBe('failed');
  });

  it('报告路径第一条事件就进来 —— 中断时全靠它指路', () => {
    const s = applyResearchProgress({}, progress({ reportPath: '/w/.neox/research/x/report.md' }));
    expect(s.deepResearchReportPath).toBe('/w/.neox/research/x/report.md');
    /* 后续事件没带也不能把它抹掉 */
    const s2 = applyResearchProgress(s, progress({ reportPath: '' }));
    expect(s2.deepResearchReportPath).toBe('/w/.neox/research/x/report.md');
  });
});

describe('每一路的 token 和工具数', () => {
  it('流式估算累加, 权威值取大 —— 不能直接盖', () => {
    /* 权威 usage 是**单轮**的, 估算是整条命的累计。直接盖数字会往回跳。 */
    let s: ResearchLiveFields = bindResearchWorker(applyResearchProgress({}, progress()), 'A', '调研: 冷启动与 HMR 实测');
    s = applyResearchWorkerTokens(s, 'A', 5000, 'add');
    s = applyResearchWorkerTokens(s, 'A', 3000, 'add');
    expect(s.deepResearchWorkers?.[0].tokens).toBe(8000);

    s = applyResearchWorkerTokens(s, 'A', 2000, 'max');
    expect(s.deepResearchWorkers?.[0].tokens).toBe(8000);

    s = applyResearchWorkerTokens(s, 'A', 9000, 'max');
    expect(s.deepResearchWorkers?.[0].tokens).toBe(9000);
  });

  it('没绑上的 agent 事件安静丢掉, 不炸也不乱记账', () => {
    const s = applyResearchProgress({}, progress());
    expect(applyResearchWorkerTokens(s, '不认识的', 100, 'add')).toBe(s);
    expect(applyResearchWorkerTool(s, '不认识的', 'web_fetch')).toBe(s);
  });

  it('合计是各路之和 —— 卡头那个数字', () => {
    let s: ResearchLiveFields = applyResearchProgress({}, progress());
    s = bindResearchWorker(s, 'A', '调研: 冷启动与 HMR 实测');
    s = bindResearchWorker(s, 'B', '调研: 生产构建耗时');
    s = applyResearchWorkerTokens(s, 'A', 21400, 'add');
    s = applyResearchWorkerTokens(s, 'B', 34800, 'add');
    expect(totalResearchTokens(s.deepResearchWorkers)).toBe(56200);
  });
});
