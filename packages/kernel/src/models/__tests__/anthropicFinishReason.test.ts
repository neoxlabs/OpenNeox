import { describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../anthropic.js';

async function* sse(events: object[]): AsyncGenerator<Buffer> {
  for (const e of events) yield Buffer.from(`event: ${(e as any).type}\ndata: ${JSON.stringify(e)}\n\n`);
}

async function finishReasonOf(events: object[]): Promise<string | undefined> {
  const provider = new AnthropicProvider({ authToken: 'k', baseUrl: 'https://api.deepseek.com/anthropic', defaultModel: 'deepseek-flash' } as any) as any;
  provider.client = { post: async () => ({ status: 200, headers: {}, data: sse(events) }) };
  let last: string | undefined;
  for await (const chunk of provider.chatStreamed([{ role: 'user', content: 'hi' }], { model: 'deepseek-flash', disableCaching: true })) {
    const fr = chunk?.choices?.[0]?.finish_reason;
    if (fr) last = fr;
  }
  return last;
}

const start = { type: 'message_start', message: { id: 'm', usage: { input_tokens: 1, output_tokens: 0 } } };
const toolStart = { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'write_file' } };
const toolDelta = { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"a.html","content":"<html><bo' } };
const stop = (reason: string) => [
  { type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 4096 } },
  { type: 'message_stop' },
];

describe('Anthropic 流中途断开', () => {
  it('已经吐出正文后断开: provider 不自己整段重发 (交给 runner 撤掉半截再重试)', async () => {
    const provider = new AnthropicProvider({ authToken: 'k', baseUrl: 'https://api.deepseek.com/anthropic', defaultModel: 'deepseek-flash' } as any) as any;
    let posts = 0;
    async function* dropping(): AsyncGenerator<Buffer> {
      yield* sse([start, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '开场白' } }]);
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    }
    provider.client = { post: async () => { posts++; return { status: 200, headers: {}, data: dropping() }; } };
    let text = '';
    await expect((async () => {
      for await (const c of provider.chatStreamed([{ role: 'user', content: 'hi' }], { model: 'deepseek-flash', disableCaching: true })) {
        text += c?.choices?.[0]?.delta?.content ?? '';
      }
    })()).rejects.toBeTruthy();
    expect(posts).toBe(1);
    expect(text).toBe('开场白');
  });
});

describe('Anthropic 流式 finish_reason', () => {
  it('max_tokens 截断 (即使有工具调用) → length', async () => {
    expect(await finishReasonOf([start, toolStart, toolDelta, ...stop('max_tokens')])).toBe('length');
  });
  it('model_context_window_exceeded 也是截断 → length (不然半截 write_file 会被补全执行)', async () => {
    expect(await finishReasonOf([start, toolStart, toolDelta, ...stop('model_context_window_exceeded')])).toBe('length');
  });
  it('refusal → content_filter (不是正常结束)', async () => {
    expect(await finishReasonOf([start, ...stop('refusal')])).toBe('content_filter');
  });
  it('tool_use → tool_calls', async () => {
    expect(await finishReasonOf([start, toolStart, { type: 'content_block_stop', index: 0 }, ...stop('tool_use')])).toBe('tool_calls');
  });
  it('end_turn → stop', async () => {
    const text = [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'content_block_stop', index: 0 },
    ];
    expect(await finishReasonOf([start, ...text, ...stop('end_turn')])).toBe('stop');
  });
});
