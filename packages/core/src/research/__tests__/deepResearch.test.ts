import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { createDeepResearchTool } from '../deepResearch.js';

let workDir: string;
beforeEach(async () => { workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-dr-')); });
afterEach(async () => { await fs.rm(workDir, { recursive: true, force: true }); });

interface Dispatched { type: string; model: string; prompt: string; run_in_background: boolean; workDir: string; description: string }

/** 造一个假 agentTool, 记下每次派发, 按回调决定回什么 */
function fakeAgent(reply: (args: any, nth: number) => string): { tool: Tool; calls: Dispatched[] } {
  const calls: Dispatched[] = [];
  const tool: Tool = {
    name: 'agent',
    description: 'fake',
    parameters: { type: 'object', properties: {} },
    async function(args: any) {
      calls.push(args);
      return reply(args, calls.length);
    },
  };
  return { tool, calls };
}

const BYOK = { lookupProvider: () => ({ provider: { models: [{ name: 'deepseek-v4-pro' }, { name: 'deepseek-v4-flash' }] }, apiKey: 'sk-real' }) };
const CLOUD = { lookupProvider: () => ({ provider: { models: [] }, apiKey: 'neox-managed' }) };

const mk = (agentTool: Tool, over: any = {}) => createDeepResearchTool({
  workDir,
  agentTool,
  sessionProviderId: 'deepseek',
  sessionModelName: 'deepseek-v4-pro',
  getMaxConcurrentAgents: () => 8,
  /* 不注入就会真调 web_search 打网络 —— 每个用例都打, 又慢又不稳 */
  searchProbe: async () => ({ ok: true }),
  ...BYOK,
  ...over,
});

const run = async (tool: Tool, args: any) => JSON.parse(String(await (tool.function as any)(args, {})));

describe('派发形状', () => {
  it('派的是专用调研员型 (不是会写 REQUIREMENTS.md 的 research 型)、前台同步、带模型和钉死的工作目录', async () => {
    const { tool: agent, calls } = fakeAgent(() => JSON.stringify({ summary: '查完了', followUps: [] }));
    await run(mk(agent), { topic: 'T', questions: [{ question: '角度一', why: '因为' }], scale: 'simple' });

    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe('research_worker');
    expect(calls[0].run_in_background).toBe(false);
    expect(calls[0].workDir).toBe(workDir);
    expect(calls[0].model).toBe('deepseek-v4-pro');   // BYOK 默认不降级
    expect(calls[0].prompt).toContain('角度一');
    expect(calls[0].prompt).toMatch(/slug:\s*\S+/);
    expect(calls[0].prompt).toMatch(/angle:\s*角度一/);
  });

  it('订阅场景 worker 用同系列 flash', async () => {
    const { tool: agent, calls } = fakeAgent(() => JSON.stringify({ summary: 'ok', followUps: [] }));
    const out = await run(
      mk(agent, { sessionProviderId: 'neox-cloud', ...CLOUD }),
      { topic: 'T', questions: [{ question: 'q' }], scale: 'simple' },
    );
    expect(calls[0].model).toBe('deepseek-v4-flash');
    expect(out.metadata.leader_model).toBe('deepseek-v4-pro');
    expect(out.metadata.worker_model).toBe('deepseek-v4-flash');
    expect(out.metadata.model_kind).toBe('subscription');
  });

  it('用户指定 worker 模型时照它', async () => {
    const { tool: agent, calls } = fakeAgent(() => JSON.stringify({ summary: 'ok', followUps: [] }));
    await run(mk(agent), { topic: 'T', questions: [{ question: 'q' }], scale: 'simple', worker_model: 'deepseek-v4-flash' });
    expect(calls[0].model).toBe('deepseek-v4-flash');
  });
});

describe('滑动窗口接上了', () => {
  it('worker 顺出来的线索会被补位查掉', async () => {
    const { tool: agent, calls } = fakeAgent((_args, nth) =>
      JSON.stringify(nth === 1
        ? { summary: '第一轮', followUps: [{ question: '顺出来的线索', why: '原文没说清' }] }
        : { summary: '第二轮', followUps: [] }));
    const out = await run(mk(agent), { topic: 'T', questions: [{ question: '起点' }], scale: 'compare' });

    expect(calls).toHaveLength(2);
    expect(calls[1].prompt).toContain('顺出来的线索');
    /* 后派的 worker 看得到前面查到了什么 —— 这正是滑动窗口相对波次的好处 */
    expect(calls[1].prompt).toContain('第一轮');
    expect(out.metadata.dispatched).toBe(2);
  });

  it('并发被子 agent 硬闸夹住', async () => {
    let cur = 0; let peak = 0;
    const { tool: agent } = fakeAgent(() => JSON.stringify({ summary: 'ok', followUps: [] }));
    const wrapped: Tool = {
      ...agent,
      async function(args: any) {
        cur += 1; peak = Math.max(peak, cur);
        await new Promise((r) => setTimeout(r, 5));
        cur -= 1;
        return (agent.function as any)(args, {});
      },
    };
    await run(
      mk(wrapped, { getMaxConcurrentAgents: () => 2 }),   // deep 档本来要 4
      { topic: 'T', questions: Array.from({ length: 6 }, (_, i) => ({ question: `q${i}` })), scale: 'deep' },
    );
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('角度超过本档上限: 多的不查, 回执里如实说 (2026-09-23)', async () => {
    const { MAX_SEEDS } = await import('../deepResearch.js');
    const { tool: agent } = fakeAgent((_a, n) => JSON.stringify({ summary: `s${n}`, followUps: [] }));
    const out = await run(mk(agent), {
      topic: 'T',
      questions: Array.from({ length: 5 }, (_, i) => ({ question: `角度 ${i}` })),
      scale: 'simple',
    });
    expect(out.metadata.dispatched).toBe(MAX_SEEDS.simple);
    expect(out.content).toContain('这些没有查: 角度 2 / 角度 3 / 角度 4');
  });

  it('追问总量不超过起始角度数 —— 每个角度最多再追一层, 不会越跑越多', async () => {
    let k = 0;
    const { tool: agent } = fakeAgent(() => JSON.stringify({
      summary: 's', followUps: [{ question: `追问 ${++k}`, why: 'x' }],
    }));
    const out = await run(mk(agent), {
      topic: 'T', questions: [{ question: 'a' }, { question: 'b' }, { question: 'c' }], scale: 'deep',
    });
    expect(out.metadata.dispatched).toBe(6);
    expect(out.metadata.stop_reason).toBe('converged');
  });

  it('回执不再列出没查的线索, 并明说到此为止 —— 列出来等于递给模型下一轮的清单', async () => {
    const { tool: agent } = fakeAgent(() => JSON.stringify({ summary: 's', followUps: [] }));
    const out = await run(mk(agent), { topic: 'T', questions: [{ question: 'a' }], scale: 'compare' });
    expect(out.content).toContain('不要再调 deep_research');
    expect(out.content).not.toContain('没来得及查:');
  });

  it('一句用户话只跑一轮: 同一轮再调被拒, 用户开口后放行', async () => {
    const { beginUserTurnForResearch } = await import('../activeRuns.js');
    const { tool: agent, calls } = fakeAgent(() => JSON.stringify({ summary: 's', followUps: [] }));
    const tool = mk(agent, { sessionId: 'TURN1' });
    beginUserTurnForResearch('TURN1');
    const first = await run(tool, { topic: '题目', questions: [{ question: 'a' }], scale: 'simple' });
    expect(first.status).toBe('success');
    const again = await run(tool, { topic: '题目', questions: [{ question: 'b' }], scale: 'simple' });
    expect(again.status).toBe('error');
    expect(again.error).toContain('本轮已经调研过「题目」');
    expect(calls).toHaveLength(1);
    beginUserTurnForResearch('TURN1');
    const next = await run(tool, { topic: '题目', questions: [{ question: 'c' }], scale: 'simple' });
    expect(next.status).toBe('success');
  });

  it('线索被深度剪干净后是正常收敛, 不误报成撞上限', async () => {
    const { tool: agent } = fakeAgent((_a, n) => JSON.stringify({
      summary: `s${n}`,
      followUps: [{ question: `派生-${n}-a`, why: 'x' }, { question: `派生-${n}-b`, why: 'x' }],
    }));
    const out = await run(mk(agent), { topic: 'T', questions: [{ question: '起点' }], scale: 'simple' });
    expect(out.metadata.stop_reason).toBe('converged');
  });
});

describe('worker 回传的容错', () => {
  it('回传裹了 ``` 围栏也能解析出线索', async () => {
    const { tool: agent, calls } = fakeAgent((_a, n) => n === 1
      ? '好的，我查完了：\n```json\n{"summary":"结论A","followUps":[{"question":"再查这个","why":"y"}]}\n```'
      : JSON.stringify({ summary: 'B', followUps: [] }));
    await run(mk(agent), { topic: 'T', questions: [{ question: 'q' }], scale: 'compare' });
    expect(calls).toHaveLength(2);
    expect(calls[1].prompt).toContain('再查这个');
  });

  it('回传根本不是 JSON 也不算失败 —— 证据早写进账本了', async () => {
    const { tool: agent } = fakeAgent(() => '我查了一圈，主要发现是这样这样。');
    const out = await run(mk(agent), { topic: 'T', questions: [{ question: 'q' }], scale: 'simple' });
    expect(out.status).toBe('success');
    expect(out.content).toContain('1 成 0 败');
  });

  it('worker 报 [ERROR] 算这条失败, 不毁整轮', async () => {
    const { tool: agent } = fakeAgent((_a, n) => n === 1 ? '[ERROR] 子 agent 炸了' : JSON.stringify({ summary: 'ok', followUps: [] }));
    const out = await run(mk(agent), { topic: 'T', questions: [{ question: 'q1' }, { question: 'q2' }], scale: 'compare' });
    expect(out.status).toBe('success');
    expect(out.content).toContain('1 成 1 败');
  });

  it('子 agent 转了后台 = 结果拿不到, 算这条没查成', async () => {
    const { tool: agent } = fakeAgent(() => JSON.stringify({ status: 'auto_backgrounded', agentId: 'A1' }));
    const out = await run(mk(agent), { topic: 'T', questions: [{ question: 'q' }], scale: 'simple' });
    expect(out.content).toContain('0 成 1 败');
  });
});

describe('卡片的那条缝 —— 整段结果必须进得了宿主的 12000 字符预览', () => {
  /* 这是**静默失败**: metadata 被 JSON.stringify 进 output, 宿主 (agentRuntimeHost 的
   * MAX_TOOL_OUTPUT_PREVIEW) 砍到 12000 字符; 截断的 JSON 在渲染层 parse 不出来,
   * 于是整张卡消失, 症状完全不指向长度。cardPayload 层已经测过控量, 这里守的是**出口**。 */
  const HOST_PREVIEW_LIMIT = 12000;

  it('回执带 deep_research 命名空间, 且整段 JSON 远低于 12000', async () => {
    const { tool: agent } = fakeAgent(() => JSON.stringify({ summary: 'ok', followUps: [] }));
    const raw = String(await (mk(agent).function as any)(
      { topic: 'T'.repeat(200), questions: [{ question: 'q' }], scale: 'simple' }, {},
    ));
    expect(raw.length).toBeLessThan(HOST_PREVIEW_LIMIT);

    const out = JSON.parse(raw);
    /* 渲染层就是靠这个 key 存在与否分流的 (不看工具名) */
    expect(out.metadata.deep_research).toBeTruthy();
    expect(out.metadata.deep_research.stats).toBeTruthy();
    expect(Array.isArray(out.metadata.deep_research.disputes)).toBe(true);
  });

  it('大量没查完的线索也不会把回执撑爆', async () => {
    const { tool: agent } = fakeAgent(() => JSON.stringify({ summary: 's', followUps: [] }));
    const raw = String(await (mk(agent).function as any)({
      topic: '题'.repeat(120),
      questions: Array.from({ length: 40 }, (_, i) => ({ question: `很长的角度 ${'x'.repeat(200)} ${i}` })),
      scale: 'simple',
    }, {}));
    expect(raw.length).toBeLessThan(HOST_PREVIEW_LIMIT);
    expect(JSON.parse(raw).metadata.deep_research).toBeTruthy();
  });
});

describe('进度事件 —— CLI/桌面那块面板的数据源', () => {
  /* 事件名必须 research_ 开头: agenticRuntime 靠这个前缀把它当**主会话**事件转发。
   * 不带前缀会被打上 taskAgentId 当成子 agent 事件, 在 CLI 里被 worker 行分支吞掉,
   * 界面上一个字都看不到 —— 而且不报错, 属于静默失效。 */
  it('开工发 start, 每收割一条发 tick, 收尾发 done', async () => {
    const events: any[] = [];
    const { tool: agent } = fakeAgent(() => JSON.stringify({ summary: 'ok', followUps: [] }));
    await run(mk(agent, { onTaskAgentEvent: (_id: string, e: any) => events.push(e) }), {
      topic: 'T', questions: [{ question: 'q1' }, { question: 'q2' }], scale: 'compare',
    });

    expect(events.every((e) => String(e.type).startsWith('research_'))).toBe(true);
    const phases = events.map((e) => e.phase);
    expect(phases[0]).toBe('start');
    expect(phases[phases.length - 1]).toBe('done');
    expect(phases.filter((p) => p === 'tick')).toHaveLength(4);
  });

  it('start 带角度清单, tick 带在飞/已完成, done 带停因', async () => {
    const events: any[] = [];
    const { tool: agent } = fakeAgent(() => JSON.stringify({ summary: 'ok', followUps: [] }));
    await run(mk(agent, { onTaskAgentEvent: (_id: string, e: any) => events.push(e) }), {
      topic: 'T', questions: [{ question: '角度一' }, { question: '角度二' }], scale: 'compare',
    });

    const start = events.find((e) => e.phase === 'start');
    expect(start.seeds).toBe(2);
    expect(start.questions).toEqual(['角度一', '角度二']);

    for (const e of events) {
      expect(typeof e.completed, `${e.phase} 缺 completed`).toBe('number');
      expect(typeof e.inFlight, `${e.phase} 缺 inFlight`).toBe('number');
      expect(Array.isArray(e.workers), `${e.phase} 缺 workers`).toBe(true);
    }

    const done = events.find((e) => e.phase === 'done');
    expect(done.stopReason).toBe('converged');
    expect(done.dispatched).toBe(2);
  });

  it('⭐️ 每个角度各自的状态: queued → running → done', async () => {
    /* 用户要的体感:「能看到这么多 Agent 都在干活, 干了多少都知道, 然后几个 A 完成了就收敛」。
     * 总量数字给不了这个 —— 界面必须看得见每一路到哪了。 */
    const events: any[] = [];
    const { tool: agent } = fakeAgent((_a, n) => JSON.stringify({ summary: `第 ${n} 路查完`, followUps: [] }));
    await run(mk(agent, { onTaskAgentEvent: (_id: string, e: any) => events.push(e) }), {
      topic: 'T', questions: [{ question: '角度一' }, { question: '角度二' }], scale: 'compare',
    });

    const start = events.find((e) => e.phase === 'start');
    expect(start.workers.map((w: any) => w.status)).toEqual(['queued', 'queued']);
    expect(start.workers.map((w: any) => w.question)).toEqual(['角度一', '角度二']);

    /* 中途至少出现过一次"有人在跑" */
    expect(events.some((e) => (e.workers ?? []).some((w: any) => w.status === 'running'))).toBe(true);

    const done = events.find((e) => e.phase === 'done');
    expect(done.workers).toHaveLength(2);
    expect(done.workers.every((w: any) => w.status === 'done')).toBe(true);
    expect(done.workers[0].summary).toContain('查完');
  });

  it('某一路挂了, 它的状态是 failed 而不是消失', async () => {
    const events: any[] = [];
    const { tool: agent } = fakeAgent((_a, n) => n === 1 ? '[ERROR] 这路炸了' : JSON.stringify({ summary: 'ok', followUps: [] }));
    await run(mk(agent, { onTaskAgentEvent: (_id: string, e: any) => events.push(e) }), {
      topic: 'T', questions: [{ question: 'q1' }, { question: 'q2' }], scale: 'compare',
    });
    const done = events.find((e) => e.phase === 'done');
    const states = done.workers.map((w: any) => w.status).sort();
    expect(states).toEqual(['done', 'failed']);
  });

  it('没给回调也不炸', async () => {
    const { tool: agent } = fakeAgent(() => JSON.stringify({ summary: 'ok', followUps: [] }));
    const out = await run(mk(agent), { topic: 'T', questions: [{ question: 'q' }], scale: 'simple' });
    expect(out.status).toBe('success');
  });
});

describe('产物', () => {
  it('报告和账本都落盘, 路径在回执里', async () => {
    const { tool: agent } = fakeAgent(() => JSON.stringify({ summary: 'ok', followUps: [] }));
    const out = await run(mk(agent), { topic: 'Adyen vs Stripe 选型', questions: [{ question: 'q' }], scale: 'simple' });

    const dir = path.join(workDir, '.neox', 'research', out.metadata.slug);
    expect(await fs.readFile(path.join(dir, 'report.md'), 'utf-8')).toContain('# Adyen vs Stripe 选型');
    const led = JSON.parse(await fs.readFile(path.join(dir, 'ledger.json'), 'utf-8'));
    expect(led.topic).toBe('Adyen vs Stripe 选型');
    expect(out.content).toContain('report.md');
  });
});

describe('中断也不白花钱 —— 报告增量落盘', () => {
  it('第二个 worker 派出去时, 报告已经在盘上了', async () => {
    const seen: boolean[] = [];
    let dir = '';
    const { tool: agent } = fakeAgent((args: any) => {
      /* 从 prompt 里捞 slug, 第一次派发时还没有报告, 之后每次都该有 */
      const slug = (String(args.prompt).match(/^slug:\s*(.+)$/m)?.[1] ?? '').trim();
      dir = path.join(workDir, '.neox', 'research', slug);
      seen.push(fsSync.existsSync(path.join(dir, 'report.md')));
      return JSON.stringify({ summary: 'ok', followUps: [] });
    });

    await run(mk(agent), {
      topic: 'T', questions: [{ question: 'q1' }, { question: 'q2' }, { question: 'q3' }], scale: 'simple',
    });

    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.slice(1).every(Boolean)).toBe(true);
  });

  it('报告内容跟着账本一起长 —— 不是空壳', async () => {
    const { tool: agent } = fakeAgent(() => JSON.stringify({ summary: 'ok', followUps: [] }));
    const out = await run(mk(agent), { topic: '增量报告验证', questions: [{ question: 'q1' }, { question: 'q2' }], scale: 'simple' });
    const md = await fs.readFile(out.metadata.report_path, 'utf-8');
    expect(md).toContain('# 增量报告验证');
    expect(md).toContain('条结论');
  });
});

describe('停得下来 —— 调研员不许活过这次工具调用 (2026-09-14 真机)', () => {

  /** 假 agentTool: 记下每次派发拿到的 signal, 一直挂着直到 signal 被拉断 */
  function hangingAgent() {
    const signals: AbortSignal[] = [];
    const tool: Tool = {
      name: 'agent', description: 'fake', parameters: { type: 'object', properties: {} },
      async function(_args: any, ctx?: { signal?: AbortSignal }) {
        const s = ctx?.signal;
        if (!s) return '[ERROR] 没拿到 signal';
        signals.push(s);
        return new Promise<string>((resolve) => {
          if (s.aborted) return resolve('[ERROR] aborted');
          s.addEventListener('abort', () => resolve('[ERROR] aborted'), { once: true });
        });
      },
    };
    return { tool, signals };
  }

  it('工具调用被中断 → 在飞的调研员全部收到 abort, 工具照样返回并写出报告', async () => {
    const { tool: agent, signals } = hangingAgent();
    const call = new AbortController();
    const pending = (mk(agent).function as any)(
      { topic: '中断', questions: [{ question: 'q1' }, { question: 'q2' }], scale: 'compare' },
      { signal: call.signal },
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(signals.length).toBe(2);
    call.abort();
    const out = JSON.parse(String(await pending));
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(out.metadata.stop_reason).toBe('aborted');
    /* 被叫停就不起归纳 —— 回执里要说明白 */
    expect(out.content).toContain('没做收尾归纳');
  });

  it('stop_agent 的入口: 按会话登记, 叫停后调研员全停', async () => {
    const { stopDeepResearch, getActiveDeepResearch } = await import('../activeRuns.js');
    const { tool: agent, signals } = hangingAgent();
    const pending = (mk(agent, { sessionId: 'S1' }).function as any)(
      { topic: '可叫停', questions: [{ question: 'q1' }], scale: 'simple' }, {},
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(getActiveDeepResearch('S1')?.topic).toBe('可叫停');
    expect(stopDeepResearch('S1', '用户说停')).toBe(true);
    const out = JSON.parse(String(await pending));
    expect(signals[0].aborted).toBe(true);
    expect(out.metadata.stop_reason).toBe('aborted');
    /* 跑完就摘掉登记, 不留一个假装在跑的 */
    expect(getActiveDeepResearch('S1')).toBeUndefined();
  });

  it('开跑时就已经 aborted 的会话信号不作数 (上一轮留下的), 否则一次停止之后调研全都秒停', async () => {
    const { tool: agent, calls } = fakeAgent(() => JSON.stringify({ summary: 'ok', followUps: [] }));
    const stale = new AbortController(); stale.abort();
    const out = await run(mk(agent, { abortSignal: stale.signal }), { topic: 'T', questions: [{ question: 'q' }], scale: 'simple' });
    expect(calls).toHaveLength(1);
    expect(out.metadata.stop_reason).toBe('converged');
  });

  it('正常收尾时, 派发用的 signal 都被拉断 —— 返回之后不许有东西还挂着', async () => {
    const seen: AbortSignal[] = [];
    const tool: Tool = {
      name: 'agent', description: 'fake', parameters: { type: 'object', properties: {} },
      async function(_a: any, ctx?: { signal?: AbortSignal }) {
        if (ctx?.signal) seen.push(ctx.signal);
        return JSON.stringify({ summary: 'ok', followUps: [] });
      },
    };
    await run(mk(tool), { topic: 'T', questions: [{ question: 'q' }], scale: 'simple' });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.aborted)).toBe(true);
  });
});

describe('收敛 —— 队列只排跑得完的量 (2026-09-14 真机: 「还有 29 条排队」)', () => {
  it('每个调研员最多收 MAX_FOLLOW_UPS_PER_WORKER 条线索', async () => {
    const { MAX_FOLLOW_UPS_PER_WORKER } = await import('../deepResearch.js');
    const events: any[] = [];
    const { tool: agent } = fakeAgent((_a, n) => JSON.stringify(n === 1
      ? { summary: 's', followUps: Array.from({ length: 6 }, (_, i) => ({ question: `线索${i}`, why: 'x' })) }
      : { summary: 's', followUps: [] }));
    await run(mk(agent, { onTaskAgentEvent: (_id: string, e: any) => events.push(e) }), {
      topic: 'T', questions: [{ question: '起点' }], scale: 'deep',
    });
    const done = events.find((e) => e.phase === 'done');
    /* 1 个种子 + 最多 N 条线索 */
    expect(done.workers.length).toBe(1 + MAX_FOLLOW_UPS_PER_WORKER);
  });

  it('排队 + 已派 永远不超过 worker 上限 —— 界面上不会出现派不完的排队', async () => {
    let maxPlanned = 0;
    const { tool: agent } = fakeAgent((_a, n) => JSON.stringify({
      summary: `s${n}`,
      followUps: [{ question: `线-${n}-a`, why: 'x' }, { question: `线-${n}-b`, why: 'x' }],
    }));
    const out = await run(mk(agent, {
      onTaskAgentEvent: (_id: string, e: any) => { maxPlanned = Math.max(maxPlanned, e.workers.length); },
    }), {
      topic: 'T', questions: [{ question: 'a' }, { question: 'b' }], scale: 'compare',
    });
    expect(maxPlanned).toBeLessThanOrEqual(10);
    expect(out.metadata.dispatched).toBeLessThanOrEqual(10);
  });
});

describe('入参校验', () => {
  it('没给角度就拒 —— 拆题是主 agent 的活', async () => {
    const { tool: agent, calls } = fakeAgent(() => '');
    const out = await run(mk(agent), { topic: 'T', questions: [] });
    expect(out.status).toBe('error');
    expect(out.precondition).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('没给题目就拒', async () => {
    const { tool: agent } = fakeAgent(() => '');
    const out = await run(mk(agent), { topic: '  ', questions: [{ question: 'q' }] });
    expect(out.status).toBe('error');
  });
});
