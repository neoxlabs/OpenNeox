import { describe, it, expect } from 'vitest';
import { OpenAIProvider } from '../openai.js';
import { normalizeFinishReason } from '../../core/toolArgsGuard.js';

async function* sseStream(events: object[], done = true): AsyncGenerator<Buffer> {
  for (const e of events) yield Buffer.from(`data: ${JSON.stringify(e)}\n\n`);
  if (done) yield Buffer.from('data: [DONE]\n\n');
}

function makeProvider(): any {
  return new OpenAIProvider({ apiKey: 'k', baseUrl: 'https://example.invalid', model: 'm' } as any);
}

async function drain(gen: AsyncGenerator<any>) {
  let finish: string | undefined;
  let text = '';
  const args = new Map<number, string>();
  for await (const c of gen) {
    const ch = c?.choices?.[0];
    if (ch?.finish_reason) finish = ch.finish_reason;
    if (ch?.delta?.content) text += ch.delta.content;
    for (const tc of ch?.delta?.tool_calls ?? []) {
      if (tc?.function?.arguments) args.set(tc.index, (args.get(tc.index) ?? '') + tc.function.arguments);
    }
  }
  return { finish, text, args };
}

describe('Responses API · response.incomplete', () => {
  const textDelta = { type: 'response.output_text.delta', delta: '前半段' };
  const incomplete = (reason: string) => ({
    type: 'response.incomplete',
    response: { status: 'incomplete', incomplete_details: { reason }, usage: { input_tokens: 1, output_tokens: 9 } },
  });

  it('max_output_tokens → length, 已流出的正文保留, 不抛错', async () => {
    const r = await drain(makeProvider().parseResponsesAPIStream(sseStream([textDelta, incomplete('max_output_tokens')], false)));
    expect(r.finish).toBe('length');
    expect(r.text).toBe('前半段');
  });

  it('content_filter → content_filter', async () => {
    const r = await drain(makeProvider().parseResponsesAPIStream(sseStream([textDelta, incomplete('content_filter')], false)));
    expect(r.finish).toBe('content_filter');
  });

  it('截断时正在写的工具调用不当流故障抛出 (交给 runner 的截断守卫拦)', async () => {
    const events = [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc1', call_id: 'c1', name: 'write_file' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: '{"path":"a.html","content":"<ht' },
      incomplete('max_output_tokens'),
    ];
    const r = await drain(makeProvider().parseResponsesAPIStream(sseStream(events, false)));
    expect(r.finish).toBe('length');
  });

  it('正常完成时未完成的工具调用仍然是流故障', async () => {
    const events = [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc1', call_id: 'c1', name: 'write_file' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: '{"path":' },
      { type: 'response.completed', response: { output: [], usage: {} } },
    ];
    await expect(drain(makeProvider().parseResponsesAPIStream(sseStream(events, false)))).rejects.toThrow(/incomplete tool calls/);
  });

  it('超过 200KB 的工具参数不再被静默截断', async () => {
    const piece = 'x'.repeat(50_000);
    const events = [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc1', call_id: 'c1', name: 'write_file' } },
      ...Array.from({ length: 6 }, () => ({ type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: piece })),
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc1' } },
      { type: 'response.completed', response: { output: [], usage: {} } },
    ];
    const r = await drain(makeProvider().parseResponsesAPIStream(sseStream(events, false)));
    expect(r.args.get(0)!.length).toBe(300_000);
  });
});

describe('Anthropic 格式代理流', () => {
  const start = { type: 'message_start', message: { id: 'm', usage: {} } };
  const tool = [
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'write_file' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"a' } },
  ];

  it('max_tokens 截断 (有工具调用) → length, 不是 tool_calls', async () => {
    const r = await drain(makeProvider().parseAnthropicStreamResponse(sseStream([start, ...tool, { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: {} }])));
    expect(r.finish).toBe('length');
  });

  it('refusal → content_filter; tool_use → tool_calls', async () => {
    expect((await drain(makeProvider().parseAnthropicStreamResponse(sseStream([start, { type: 'message_delta', delta: { stop_reason: 'refusal' } }])))).finish).toBe('content_filter');
    expect((await drain(makeProvider().parseAnthropicStreamResponse(sseStream([start, ...tool, { type: 'message_delta', delta: { stop_reason: 'tool_use' } }])))).finish).toBe('tool_calls');
  });

  it('error 事件抛出来, 不被当成坏 JSON 吞掉', async () => {
    const events = [start, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }];
    await expect(drain(makeProvider().parseAnthropicStreamResponse(sseStream(events)))).rejects.toThrow('Overloaded');
  });

  it('坏 JSON 行照旧跳过', async () => {
    async function* raw() {
      yield Buffer.from('data: {not json\n\n');
      yield Buffer.from(`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })}\n\n`);
    }
    expect((await drain(makeProvider().parseAnthropicStreamResponse(raw()))).finish).toBe('stop');
  });
});

describe('normalizeFinishReason', () => {
  it('非标准写法归到 runner 认识的值, 标准值和未知值原样', () => {
    expect(normalizeFinishReason('max_tokens')).toBe('length');
    expect(normalizeFinishReason('sensitive')).toBe('content_filter');
    expect(normalizeFinishReason('function_call')).toBe('tool_calls');
    expect(normalizeFinishReason('end_turn')).toBe('stop');
    for (const v of ['stop', 'length', 'tool_calls', 'content_filter', 'whatever']) {
      expect(normalizeFinishReason(v)).toBe(v);
    }
  });
});
