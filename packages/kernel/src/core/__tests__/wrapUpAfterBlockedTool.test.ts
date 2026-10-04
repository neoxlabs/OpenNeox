import { describe, expect, it } from 'vitest';
import { StreamedRunner } from '../runner.js';
import { ShortTermMemory } from '../../memory/shortterm.js';
import type { Tool } from '../../types/index.js';

function probeTool(calls: { n: number }): Tool {
  return {
    name: 'probe_page',
    description: 'Read the page',
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
    function: async () => { calls.n++; return 'same page content'; },
  };
}

function toolCallChunk(i: number) {
  return {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: `call_${i}`,
          type: 'function',
          function: { name: 'probe_page', arguments: JSON.stringify({ q: 'same' }) },
        }],
      },
    }],
  };
}

const hasWrapUpReminder = (messages: any[]) =>
  messages.some((m) => typeof m?.content === 'string' && m.content.includes('blocked by a safety guard'));

/** 一直发同一个工具调用; 看到收尾提醒后按 onWrapUp 的剧本回话 */
function loopingProvider(state: { calls: number; sawReminder: boolean }, onWrapUp: 'text' | 'tool' | 'empty') {
  return {
    async chat() { throw new Error('chat() not expected'); },
    async *chatStreamed(messages: any[]) {
      state.calls++;
      if (hasWrapUpReminder(messages)) {
        state.sawReminder = true;
        if (onWrapUp === 'text') {
          yield { choices: [{ delta: { content: '做到第 3 步, 页面内容一直一样, 下一步换个选择器再试。' } }] };
          yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
          return;
        }
        if (onWrapUp === 'tool') {
          yield toolCallChunk(state.calls);
          yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
          return;
        }
        yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
        return;
      }
      yield toolCallChunk(state.calls);
      yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
    },
  } as any;
}

async function run(onWrapUp: 'text' | 'tool' | 'empty') {
  const state = { calls: 0, sawReminder: false };
  const toolRuns = { n: 0 };
  const runner = new StreamedRunner({
    llmProvider: loopingProvider(state, onWrapUp),
    model: 'test-model',
    tools: [probeTool(toolRuns)],
    memory: new ShortTermMemory(),
    config: { maxIterations: 20, temperature: 0 } as any,
    instructions: 'test agent',
    sessionId: `wrap-up-${onWrapUp}`,
    approvalHandler: async () => true,
    autoCompressEnabled: false,
    disableSystemPrompt: true,
  } as any);
  const events: any[] = [];
  for await (const ev of runner.run('看看这个页面')) {
    events.push(ev);
    if (events.length > 2000) throw new Error('runaway event loop');
  }
  const text = events.filter((e) => e.type === 'text_delta').map((e) => e.delta).join('');
  const errors = events.filter((e) => e.type === 'error').map((e) => String(e.error));
  return { state, toolRuns, text, errors };
}

describe('工具被硬拦后的收尾轮', () => {
  it('拦下之后模型还有一轮, 它写的结论就是结尾', async () => {
    const { state, text, errors } = await run('text');
    expect(state.sawReminder).toBe(true);
    expect(text).toContain('下一步换个选择器再试');
    expect(errors).toEqual([]);
  });

  it('收尾轮里再发工具调用 → 不执行, 也不再开下一轮', async () => {
    const before = await run('text');
    const { state, toolRuns } = await run('tool');
    expect(state.sawReminder).toBe(true);
    expect(toolRuns.n).toBe(before.toolRuns.n);
    expect(state.calls).toBe(before.state.calls);
  });

  it('收尾轮一个字都没写 → 报一条错误说明为什么停, 不许静默结束', async () => {
    const { state, errors } = await run('empty');
    expect(state.sawReminder).toBe(true);
    expect(errors.some((e) => /blocked/i.test(e))).toBe(true);
  });
});
