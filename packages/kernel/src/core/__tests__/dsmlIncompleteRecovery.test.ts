import { describe, expect, it } from 'vitest';
import { StreamedRunner } from '../runner.js';
import { ShortTermMemory } from '../../memory/shortterm.js';
import type { Tool } from '../../types/index.js';

const BROKEN = `Let me do it in one edit for ui.ts and one for settings.test.ts.</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`;

const HINT = '工具调用格式不完整';

function probeTool(state: { n: number }): Tool {
  return {
    name: 'probe_page',
    description: 'Read the page',
    parameters: { type: 'object', properties: {} },
    function: async () => { state.n++; return 'page content'; },
  };
}

function toolCallChunk() {
  return {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: 'call_probe_1',
          type: 'function',
          function: { name: 'probe_page', arguments: '{}' },
        }],
      },
    }],
  };
}

function brokenChunk() {
  return { choices: [{ delta: { content: BROKEN } }] };
}

const stopChunk = { choices: [{ delta: {}, finish_reason: 'stop' }] };

function makeRunner(provider: any, sessionId: string, toolState: { n: number }) {
  return new StreamedRunner({
    llmProvider: provider,
    model: 'test-model',
    tools: [probeTool(toolState)],
    memory: new ShortTermMemory(),
    config: { maxIterations: 12, temperature: 0 } as any,
    instructions: 'test agent',
    sessionId,
    approvalHandler: async () => true,
    autoCompressEnabled: false,
    disableSystemPrompt: true,
  } as any);
}

async function run(runner: StreamedRunner) {
  const events: any[] = [];
  for await (const ev of runner.run('把设置页改好')) {
    events.push(ev);
    if (events.length > 2000) throw new Error('runaway event loop');
  }
  return {
    events,
    errors: events.filter((e) => e.type === 'error').map((e) => String(e.error)),
  };
}

describe('残缺 DSML 不算最终回答', () => {
  it('残缺 → 追加提示重来 → 第二次正常调用工具 → 任务继续', async () => {
    const seen: any[][] = [];
    let calls = 0;
    const provider = {
      async chat() { throw new Error('chat() not expected'); },
      async *chatStreamed(messages: any[]) {
        seen.push(messages.map((m) => ({ ...m })));
        const turn = calls++;
        if (turn === 0) {
          yield brokenChunk();
          yield stopChunk;
          return;
        }
        if (turn === 1) {
          yield toolCallChunk();
          yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
          return;
        }
        yield { choices: [{ delta: { content: '设置页改好了。' } }] };
        yield stopChunk;
      },
    };
    const toolState = { n: 0 };
    const runner = makeRunner(provider, 'dsml-retry-ok', toolState);

    const { events, errors } = await run(runner);

    expect(calls).toBe(3);
    expect(toolState.n).toBe(1);
    expect(errors).toEqual([]);
    /* 重来的那一轮: 模型看见了自己的残缺回复 (残片已摘), 以及要求重发的提示 */
    const secondTurn = seen[1]!;
    expect(secondTurn.some((m) => typeof m.content === 'string' && m.content.includes(HINT))).toBe(true);
    const assistant = secondTurn.filter((m) => m.role === 'assistant');
    expect(assistant.length).toBeGreaterThan(0);
    expect(assistant.every((m) => !String(m.content ?? '').includes('DSML'))).toBe(true);
    /* 最终回答仍由模型给出 */
    const text = events.filter((e) => e.type === 'text_delta').map((e) => e.delta).join('');
    expect(text).toContain('设置页改好了');
    /* 重来事件必须带上这一轮的原文 —— 宿主用它裁最终输出, 桌面/CLI 用它把气泡撤掉 */
    const retryEvents = events.filter((e) => e.type === 'raw_response_event' && e.event_type === 'dsml.incomplete_retry');
    expect(retryEvents).toHaveLength(1);
    expect(retryEvents[0].data.discardedText).toBe(BROKEN);
  });

  it('连续两次还残缺 → 如实结束并带上提示', async () => {
    let calls = 0;
    const provider = {
      async chat() { throw new Error('chat() not expected'); },
      async *chatStreamed() {
        calls++;
        yield brokenChunk();
        yield stopChunk;
      },
    };
    const runner = makeRunner(provider, 'dsml-retry-giveup', { n: 0 });
    const { errors } = await run(runner);

    /* 1 次原始 + 2 次重来 = 3 次, 之后不再请求 */
    expect(calls).toBe(3);
    expect(errors.some((e) => e.includes('DSML'))).toBe(true);
  });
});
