import { describe, expect, it } from 'vitest';
import { StreamedRunner } from '../runner.js';
import { ShortTermMemory } from '../../memory/shortterm.js';
import { consumeInterruptLatency, markInterruptRequested, __resetInterruptLatencyForTest } from '../interruptLatency.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function makeProvider(toolName: string, args: Record<string, unknown>) {
  let turn = 0;
  return {
    async chat() { throw new Error('chat() not expected'); },
    async *chatStreamed() {
      turn++;
      if (turn === 1) {
        yield {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: toolName, arguments: JSON.stringify(args) },
              }],
            },
          }],
        };
        yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
        return;
      }
      yield { choices: [{ delta: { content: 'ok' } }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
    },
  } as any;
}

function drain(runner: StreamedRunner, signal: AbortSignal): Promise<string[]> {
  const events: string[] = [];
  return (async () => {
    for await (const ev of runner.run('go', undefined, signal)) {
      events.push((ev as any)?.type ?? 'unknown');
    }
    return events;
  })();
}

function makeRunner(opts: {
  sessionId: string;
  tool: any;
  graceMs: number;
  memory: ShortTermMemory;
}) {
  return new StreamedRunner({
    llmProvider: makeProvider(opts.tool.name, { q: 'x' }),
    model: 'test-model',
    tools: [opts.tool],
    memory: opts.memory,
    config: { maxIterations: 3, temperature: 0 } as any,
    instructions: 'test agent',
    sessionId: opts.sessionId,
    workspacePath: process.cwd(),
    approvalHandler: async () => true,
    autoCompressEnabled: false,
    disableSystemPrompt: true,
    toolAbortGraceMs: opts.graceMs,
  } as any);
}

const LATE_MS = 400;

/** 完全不看 signal 的工具: abort 之后还要 LATE_MS 才返回, 返回一个必须被丢弃的字符串。 */
function makeDeafTool(state: { startedAt: number }) {
  return {
    name: 'deaf_tool',
    description: 'ignores abort',
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
    function: async () => {
      state.startedAt = Date.now();
      await sleep(LATE_MS);
      return 'late-secret-result';
    },
  } as any;
}

/** 正常响应 abort 的工具: 信号一到就返回。 */
function makeResponsiveTool(state: { startedAt: number; stoppedBySignal: boolean }) {
  return {
    name: 'responsive_tool',
    description: 'stops on abort',
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
    function: async (_args: any, ctx: any) => {
      state.startedAt = Date.now();
      const signal: AbortSignal | undefined = ctx?.signal;
      if (signal?.aborted) { state.stoppedBySignal = true; return 'stopped'; }
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
      state.stoppedBySignal = true;
      return 'stopped by signal';
    },
  } as any;
}

describe('runner: 停止后不响应 abort 的工具', () => {
  it('graceMs 内这一轮就结束 (远早于工具自己返回), 迟到的结果不进历史', async () => {
    __resetInterruptLatencyForTest();
    const sessionId = 'sess-deaf-tool';
    const memory = new ShortTermMemory();
    const state = { startedAt: 0 };
    const ac = new AbortController();
    /* grace 用 80ms 而不是真 3 秒: 要验的是“abort 后不再无限等”, 不是秒表本身;
     * 默认值 3000 由 toolAbortRace 的单测看住。工具自己 400ms 才返回 — 远晚于 80。 */
    const runner = makeRunner({ sessionId, tool: makeDeafTool(state), graceMs: 80, memory });

    const startedAt = Date.now();
    const runPromise = drain(runner, ac.signal);

    /* 等工具真正开始跑再点停止, 否则跑到的是“abort 后不再发工具”那条路, 验不到兜底 */
    for (let i = 0; i < 100 && state.startedAt === 0; i++) await sleep(10);
    expect(state.startedAt).toBeGreaterThan(0);
    markInterruptRequested(sessionId);
    ac.abort();

    const events = await runPromise;
    const elapsed = Date.now() - startedAt;

    /* 这一轮结束了, 而且是在工具自己返回 (400ms) 之前 —— 兜底真的生效了 */
    expect(elapsed).toBeLessThan(LATE_MS - 100);
    expect(events).toContain('error');

    const summary = consumeInterruptLatency(sessionId);
    expect(summary).not.toBeNull();
    /* 工具在跑, 没有流在飞 —— 这个字段就该是空的, 不能编一个数 */
    expect(summary!.streamMs).toBeUndefined();

    /* 迟到的结果: 等工具自己返回之后, 历史里也不能有它 */
    await sleep(LATE_MS);
    const history = memory.getAll().map((m: any) => String(m.content ?? '')).join('\n');
    expect(history).not.toContain('late-secret-result');
  });

  it('正常响应 abort 的工具行为不变: 这一轮照常结束, 记为「工具已停」而不是放弃', async () => {
    __resetInterruptLatencyForTest();
    const sessionId = 'sess-responsive-tool';
    const memory = new ShortTermMemory();
    const state = { startedAt: 0, stoppedBySignal: false };
    const ac = new AbortController();
    const runner = makeRunner({ sessionId, tool: makeResponsiveTool(state), graceMs: 1000, memory });

    const runPromise = drain(runner, ac.signal);
    for (let i = 0; i < 100 && state.startedAt === 0; i++) await sleep(10);
    expect(state.startedAt).toBeGreaterThan(0);
    markInterruptRequested(sessionId);
    ac.abort();

    const events = await runPromise;
    expect(events).toContain('error');
    expect(state.stoppedBySignal).toBe(true);

    const summary = consumeInterruptLatency(sessionId);
    expect(summary).not.toBeNull();
    expect(summary!.toolAbandoned).toBe(false);
    expect(summary!.toolMs).toBeGreaterThanOrEqual(0);
  });
});
