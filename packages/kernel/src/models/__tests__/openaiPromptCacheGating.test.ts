import { describe, expect, it } from 'vitest';
import { OpenAIProvider } from '../openai.js';

/* 只有 ephemeral 缓存模式注入 cache_control；服务端前缀缓存保持消息序列化稳定。 */

function makeProvider(): OpenAIProvider {
  return new OpenAIProvider({
    apiKey: 'test-key',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-pro',
  });
}

function makeToolMessages(): any[] {
  return [
    { role: 'system', content: 'You are Neox.' },
    { role: 'user', content: 'work on this task' },
    { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'readfile', arguments: '{"path":"a.ts"}' } }] },
    { role: 'tool', tool_call_id: 't1', content: 'file-a contents' },
  ];
}

describe('injectPromptCacheBreakpoints · type gating', () => {
  it('DeepSeek (openai-prompt-cache) — 消息内容保持 string, 不被 wrap 成 cache_control 数组', () => {
    const provider = makeProvider();
    const messages = makeToolMessages();

    /* 调 buildChatCompletionsPayload 走完整流程 (含 injectPromptCacheBreakpoints) */
    const payload = (provider as any).buildChatCompletionsPayload(messages, {
      model: 'deepseek-v4-pro',
      tools: [{ name: 'readfile', description: 'x', parameters: { type: 'object', properties: {}, additionalProperties: false }, function: () => '' }],
      temperature: 1,
      stream: false,
    });

    /* system[0].content 保持 string, 无 cache_control wrap */
    expect(typeof payload.messages[0].content).toBe('string');
    /* last user/tool message (最后一条 tool result) 也保持 string, 无 cache_control */
    const last = payload.messages[payload.messages.length - 1];
    expect(typeof last.content).toBe('string');
    /* tools[last] 也没有 cache_control 字段 */
    if (payload.tools) {
      for (const tool of payload.tools) {
        expect((tool as any).cache_control).toBeUndefined();
      }
    }
  });

  it('Claude (ephemeral) — 正常注入 3 处 breakpoint (回归保护)', () => {
    const provider = new OpenAIProvider({
      apiKey: 'test-key',
      baseUrl: 'https://openrouter.ai/api/v1',
      defaultModel: 'claude-opus-4-8',
    });
    const messages = makeToolMessages();
    const payload = (provider as any).buildChatCompletionsPayload(messages, {
      model: 'claude-opus-4-8',
      tools: [{ name: 'readfile', description: 'x', parameters: { type: 'object', properties: {}, additionalProperties: false }, function: () => '' }],
      temperature: 1,
      stream: false,
    });

    /* system[0].content 应被 wrap 成 array, 末尾 block 带 cache_control */
    const sys = payload.messages[0];
    expect(Array.isArray(sys.content)).toBe(true);
    const sysLastBlock = sys.content[sys.content.length - 1];
    expect(sysLastBlock.cache_control).toEqual({ type: 'ephemeral' });

    /* last user/tool 同样被 wrap */
    const last = payload.messages[payload.messages.length - 1];
    expect(Array.isArray(last.content)).toBe(true);
    const lastBlock = last.content[last.content.length - 1];
    expect(lastBlock.cache_control).toEqual({ type: 'ephemeral' });

    /* tools[last] 也应该有 cache_control */
    expect(payload.tools?.[payload.tools.length - 1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('DeepSeek 两次连续请求, message 序列化必须字节相同 (前缀稳定性回归)', () => {
    const provider = makeProvider();
    const msgs1 = makeToolMessages();
    const msgs2 = [
      ...makeToolMessages(),
      /* 第 2 次请求追加了 assistant/tool 轮 */
      { role: 'assistant', content: '', tool_calls: [{ id: 't2', type: 'function', function: { name: 'readfile', arguments: '{"path":"b.ts"}' } }] },
      { role: 'tool', tool_call_id: 't2', content: 'file-b contents' },
    ];
    const payload1 = (provider as any).buildChatCompletionsPayload(msgs1, { model: 'deepseek-v4-pro', temperature: 1, stream: false });
    const payload2 = (provider as any).buildChatCompletionsPayload(msgs2, { model: 'deepseek-v4-pro', temperature: 1, stream: false });

    /* 前 N 条 message 在两个 payload 里必须完全等同 (JSON 序列化字节相同).
     *   这是 openai-prompt-cache 命中前缀的必要条件. */
    const commonN = payload1.messages.length;
    for (let i = 0; i < commonN; i++) {
      const s1 = JSON.stringify(payload1.messages[i]);
      const s2 = JSON.stringify(payload2.messages[i]);
      expect(s1, `message[${i}] byte-mismatch (broken prefix cache)`).toBe(s2);
    }
  });
});
