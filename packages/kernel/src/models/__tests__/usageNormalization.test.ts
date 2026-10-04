import { describe, expect, it } from 'vitest';
import { OpenAIProvider } from '../openai.js';

/* DeepSeek 缓存语义回归锁:
 *   prompt_cache_miss_tokens = 未命中缓存的普通输入 (正常输入价, 自动缓存无写入费),
 *   绝不能归入 cache_write_input_tokens — 否则下游 normalizedInput = prompt - (hit + miss)
 *   恒为 0, 面板 "Input (No Cache)" 永远是 0、真实输入被错标成 Cache Write。 */
describe('OpenAIProvider.normalizeUsage cache semantics', () => {
  const makeProvider = () => new OpenAIProvider({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-test',
    model: 'deepseek-chat',
  } as any);

  it('does not map DeepSeek prompt_cache_miss_tokens to cache write', () => {
    const usage = (makeProvider() as any).normalizeUsage({
      prompt_tokens: 48_000,
      completion_tokens: 600,
      total_tokens: 48_600,
      prompt_cache_hit_tokens: 47_744,
      prompt_cache_miss_tokens: 256,
    });

    expect(usage.prompt_cache_hit_tokens).toBe(47_744);
    expect(usage.prompt_cache_miss_tokens).toBe(256);
    expect(usage.cache_write_input_tokens).toBeUndefined();
  });

  it('still honors explicit vendor cache write fields', () => {
    const usage = (makeProvider() as any).normalizeUsage({
      prompt_tokens: 1000,
      completion_tokens: 50,
      total_tokens: 1050,
      cache_write_input_tokens: 800,
    });

    expect(usage.cache_write_input_tokens).toBe(800);
  });

  it('keeps prompt_tokens_details.cached_tokens as unified cached_tokens', () => {
    const usage = (makeProvider() as any).normalizeUsage({
      prompt_tokens: 2000,
      completion_tokens: 100,
      total_tokens: 2100,
      prompt_tokens_details: { cached_tokens: 1500 },
    });

    expect(usage.cached_tokens).toBe(1500);
    expect(usage.cache_write_input_tokens).toBeUndefined();
  });
});
