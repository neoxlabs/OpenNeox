import { describe, it, expect } from 'vitest';
import { DoubaoProvider } from '../doubao.js';
import { GeminiProvider } from '../gemini.js';

async function* sse(events: object[]): AsyncGenerator<Buffer> {
  for (const e of events) yield Buffer.from(`data: ${JSON.stringify(e)}\n\n`);
}

async function lastFinish(gen: AsyncGenerator<any>): Promise<string | undefined> {
  let f: string | undefined;
  for await (const c of gen) if (c?.choices?.[0]?.finish_reason) f = c.choices[0].finish_reason;
  return f;
}

const doubao = (): any => new DoubaoProvider({ apiKey: 'k' } as any);
const fcAdded = { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc1', call_id: 'c1', name: 'write_file' } };
const fcDelta = { type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: '{"path":"a.html","content":"<ht' };

describe('豆包 Responses 流收尾', () => {
  it('response.incomplete (max_output_tokens) → length, 即使有工具调用', async () => {
    const inc = { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] } };
    expect(await lastFinish(doubao().parseStreamResponse(sse([fcAdded, fcDelta, inc])))).toBe('length');
  });

  it('content_filter → content_filter', async () => {
    const inc = { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [] } };
    expect(await lastFinish(doubao().parseStreamResponse(sse([inc])))).toBe('content_filter');
  });

  it('没等到 completed 就断了 → STREAM_INCOMPLETE, 不报 tool_calls', async () => {
    await expect(lastFinish(doubao().parseStreamResponse(sse([fcAdded, fcDelta])))).rejects.toMatchObject({ code: 'STREAM_INCOMPLETE' });
  });

  it('正常 completed 照旧: 有工具 → tool_calls', async () => {
    const done = { type: 'response.completed', response: { status: 'completed', output: [] } };
    expect(await lastFinish(doubao().parseStreamResponse(sse([fcAdded, { ...fcDelta, delta: '{}' }, done])))).toBe('tool_calls');
  });
});

describe('Gemini 提示词被拦', () => {
  it('没有 candidates 只有 blockReason → content_filter, 不是空回复', async () => {
    const gem: any = new GeminiProvider('AIza-test');
    const blocked = { promptFeedback: { blockReason: 'SAFETY' } };
    expect(await lastFinish(gem.streamGenerator(sse([blocked]), 'req1', Date.now()))).toBe('content_filter');
  });
});
