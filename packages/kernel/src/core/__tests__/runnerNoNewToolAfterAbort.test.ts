/**
 * pilot:H-11 回归 —— 点停止后不再有新工具调用。
 *
 * 场景: 第一轮模型发了一个工具调用, 工具在用户点停止时还没返回 (正常响应 abort)。
 * 要求: 这一轮收尾后**不再**向模型要下一轮, 也就不会再去执行第二个工具。
 *
 * 用假 LLM 记 chatStreamed 的调用次数: 收口在了第一轮 → 次数必须是 1。
 */
import { describe, expect, it } from 'vitest';
import { StreamedRunner } from '../runner.js';
import { ShortTermMemory } from '../../memory/shortterm.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function makeProvider(state: { calls: number }) {
  return {
    async chat() { throw new Error('chat() not expected'); },
    async *chatStreamed() {
      state.calls++;
      if (state.calls === 1) {
        yield {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'slow_tool', arguments: JSON.stringify({ q: 'x' }) },
              }],
            },
          }],
        };
        yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
        return;
      }
      /* 真到了第二轮: 再要一个工具 —— 这一步一旦发生就说明停止没拦住新工具 */
      yield {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_2',
              type: 'function',
              function: { name: 'must_not_run', arguments: '{}' },
            }],
          },
        }],
      };
      yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
    },
  } as any;
}

describe('runner: 停止后不再开新的一轮 / 新工具', () => {
  it('工具响应 abort → 不再请求模型, 第二个工具从不执行', async () => {
    const providerState = { calls: 0 };
    const toolState = { startedAt: 0, abortedAt: 0 };
    const mustNotRun = { called: false };
    const memory = new ShortTermMemory();
    const ac = new AbortController();

    const slowTool = {
      name: 'slow_tool',
      description: 'waits for abort',
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
      function: async (_args: any, ctx: any) => {
        toolState.startedAt = Date.now();
        await new Promise<void>((resolve) => {
          const signal: AbortSignal | undefined = ctx?.signal;
          if (signal?.aborted) return resolve();
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        toolState.abortedAt = Date.now();
        return 'stopped by signal';
      },
    } as any;

    const forbiddenTool = {
      name: 'must_not_run',
      description: 'must never run after abort',
      parameters: { type: 'object', properties: {} },
      function: async () => { mustNotRun.called = true; return 'oops'; },
    } as any;

    const runner = new StreamedRunner({
      llmProvider: makeProvider(providerState),
      model: 'test-model',
      tools: [slowTool, forbiddenTool],
      memory,
      config: { maxIterations: 5, temperature: 0 } as any,
      instructions: 'test agent',
      sessionId: 'sess-no-new-tool',
      workspacePath: process.cwd(),
      approvalHandler: async () => true,
      autoCompressEnabled: false,
      disableSystemPrompt: true,
      toolAbortGraceMs: 1000,
    } as any);

    const runPromise = (async () => {
      const events: string[] = [];
      for await (const ev of runner.run('go', undefined, ac.signal)) events.push((ev as any)?.type ?? 'unknown');
      return events;
    })();

    for (let i = 0; i < 100 && toolState.startedAt === 0; i++) await sleep(10);
    expect(toolState.startedAt).toBeGreaterThan(0);
    ac.abort();

    const events = await runPromise;
    expect(events).toContain('error');
    expect(toolState.abortedAt).toBeGreaterThan(0);
    /* 关键: 回到循环顶部看到 aborted 就结束, 不再向模型要下一轮 */
    expect(providerState.calls).toBe(1);
    /* 就算模型真发了第二个工具, 它也不该被执行 */
    await sleep(50);
    expect(mustNotRun.called).toBe(false);
  });
});
