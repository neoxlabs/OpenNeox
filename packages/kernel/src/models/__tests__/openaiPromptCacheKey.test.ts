import { describe, expect, it } from 'vitest';
import { OpenAIProvider, supportsPromptCacheKey } from '../openai.js';


function makeMessages(): any[] {
  return [
    { role: 'system', content: 'You are Neox.' },
    { role: 'user', content: 'hello' },
  ];
}

function buildPayload(provider: OpenAIProvider, model: string) {
  return (provider as any).buildChatCompletionsPayload(makeMessages(), {
    model, temperature: 1, stream: false,
  });
}

describe('supportsPromptCacheKey — 只对 OpenAI 家族发', () => {
  it('OpenAI 家族认', () => {
    for (const m of ['gpt-5.6-sol', 'gpt-4o', 'o3-mini', 'o4', 'chatgpt-4o-latest', 'GPT-5']) {
      expect(supportsPromptCacheKey(m), m).toBe(true);
    }
  });

  it('别家不认 — 未知参数可能让严格端点直接 400', () => {
    for (const m of ['deepseek-v4-pro', 'claude-opus-4-8', 'glm-4.6', 'kimi-k2.5', 'doubao-pro', 'gemini-2.5-pro']) {
      expect(supportsPromptCacheKey(m), m).toBe(false);
    }
  });

  it('第三方中转带前缀时按最后一段判定', () => {
    /* 实机现场用的就是这个形态 */
    expect(supportsPromptCacheKey('gptpro-relay-b:gpt-5.6-sol')).toBe(true);
    expect(supportsPromptCacheKey('someproxy:deepseek-v4-pro')).toBe(false);
  });

  it('空值不炸', () => {
    expect(supportsPromptCacheKey('')).toBe(false);
    expect(supportsPromptCacheKey(undefined)).toBe(false);
    expect(supportsPromptCacheKey(null)).toBe(false);
  });
});

describe('chat/completions payload 带上 prompt_cache_key', () => {
  it('GPT 模型 + 有 sessionId → payload 带 key', () => {
    const provider = new OpenAIProvider({
      apiKey: 'test-key', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-5.6-sol',
    });
    provider.setSessionId('session-abc-123');
    const payload = buildPayload(provider, 'gpt-5.6-sol');
    expect(payload.prompt_cache_key).toBe('session-abc-123');
  });

  it('同一 session 多次构造 → key 稳定 (路由亲和的前提)', () => {
    const provider = new OpenAIProvider({
      apiKey: 'test-key', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-5.6-sol',
    });
    provider.setSessionId('session-stable');
    const a = buildPayload(provider, 'gpt-5.6-sol');
    const b = buildPayload(provider, 'gpt-5.6-sol');
    expect(a.prompt_cache_key).toBe(b.prompt_cache_key);
  });

  it('DeepSeek 不带 — 它的缓存是自家实现, 不认这个字段', () => {
    const provider = new OpenAIProvider({
      apiKey: 'test-key', baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-v4-pro',
    });
    provider.setSessionId('session-abc-123');
    const payload = buildPayload(provider, 'deepseek-v4-pro');
    expect(payload.prompt_cache_key).toBeUndefined();
  });

  it('走 config.sessionId — runtimeBuilder 就是这么传的, 同会话稳定', () => {
    /* runtimeBuilder 的 adapterConfig 带 sessionId, OpenAIAdapter 用 ...rest 透传到这里。
     * 这条锁死那条链路: 只要外部给了会话 id, 它就必须原样出现在 payload 上。 */
    const provider = new OpenAIProvider({
      apiKey: 'test-key', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-5.6-sol',
      sessionId: 'session-from-runtime-builder',
    } as any);
    expect(buildPayload(provider, 'gpt-5.6-sol').prompt_cache_key).toBe('session-from-runtime-builder');
  });

  it('外部没给会话 id 时也有稳定的自生成值 — 至少同实例内不变', () => {
    const provider = new OpenAIProvider({
      apiKey: 'test-key', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-5.6-sol',
    });
    const a = buildPayload(provider, 'gpt-5.6-sol').prompt_cache_key;
    const b = buildPayload(provider, 'gpt-5.6-sol').prompt_cache_key;
    expect(a).toBeTruthy();
    expect(a).toBe(b);
  });

  it('NEOX_DISABLE_PROMPT_CACHE_KEY=1 可关 — 上游若拒收未知参数要有退路', () => {
    const prev = process.env.NEOX_DISABLE_PROMPT_CACHE_KEY;
    process.env.NEOX_DISABLE_PROMPT_CACHE_KEY = '1';
    try {
      const provider = new OpenAIProvider({
        apiKey: 'test-key', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-5.6-sol',
      });
      provider.setSessionId('session-abc-123');
      expect(buildPayload(provider, 'gpt-5.6-sol').prompt_cache_key).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.NEOX_DISABLE_PROMPT_CACHE_KEY;
      else process.env.NEOX_DISABLE_PROMPT_CACHE_KEY = prev;
    }
  });

  it('加了 key 不影响消息字节稳定性 (前缀本身仍不许被动到)', () => {
    const provider = new OpenAIProvider({
      apiKey: 'test-key', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-5.6-sol',
    });
    provider.setSessionId('s1');
    const payload = buildPayload(provider, 'gpt-5.6-sol');
    expect(typeof payload.messages[0].content).toBe('string');
    expect(typeof payload.messages[1].content).toBe('string');
  });
});
