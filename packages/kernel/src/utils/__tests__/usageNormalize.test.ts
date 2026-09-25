import { describe, it, expect } from 'vitest';
import { normalizeUsageTokens } from '../usageNormalize.js';

/* 两大协议家族对"输入 token"的口径根本不同, 这是最容易再次漂移的地方。
 * 真实事故: 压缩阈值的 token 校准直接读 prompt_tokens —— DeepSeek 上恰好等于全量(有效),
 * Anthropic 上只是非缓存增量(几百) → 比值 <<1 被夹回 1 → 对 Claude/grok 静默失效。 */
describe('normalizeUsageTokens — 两个协议家族的口径不能混', () => {
  it('Anthropic: prompt_tokens 是非缓存增量, 总 context 要把缓存加回来', () => {
    const r = normalizeUsageTokens({
      prompt_tokens: 146,                    // = input_tokens, 只是非缓存部分
      cache_read_input_tokens: 109_056,
      cache_creation_input_tokens: 0,
    });
    expect(r.normalizedInput).toBe(146);
    expect(r.cacheRead).toBe(109_056);
    /* 关键: 真实占用上下文窗口的是 109202, 不是 146 */
    expect(r.contextTokens).toBe(109_202);
  });

  it('Anthropic: cache_creation 也占 context', () => {
    const r = normalizeUsageTokens({
      prompt_tokens: 500,
      cache_read_input_tokens: 1_000,
      cache_creation_input_tokens: 20_000,
    });
    expect(r.cacheWrite).toBe(20_000);
    expect(r.contextTokens).toBe(21_500);
  });

  it('DeepSeek/OpenAI: prompt_tokens 已是总量, 不能重复加缓存', () => {
    const r = normalizeUsageTokens({
      prompt_tokens: 109_202,                // 总量(含缓存)
      prompt_cache_hit_tokens: 109_056,
    });
    expect(r.cacheRead).toBe(109_056);
    expect(r.normalizedInput).toBe(146);     // 总量 - 缓存
    /* 关键: 不能变成 109202 + 109056 */
    expect(r.contextTokens).toBe(109_202);
  });

  it('OpenAI prompt_tokens_details.cached_tokens 同样识别', () => {
    const r = normalizeUsageTokens({
      prompt_tokens: 50_000,
      prompt_tokens_details: { cached_tokens: 48_000 },
    });
    expect(r.normalizedInput).toBe(2_000);
    expect(r.contextTokens).toBe(50_000);
  });

  it('无缓存字段: 全量就是 prompt_tokens', () => {
    const r = normalizeUsageTokens({ prompt_tokens: 7_000 });
    expect(r).toEqual({ normalizedInput: 7_000, cacheRead: 0, cacheWrite: 0, contextTokens: 7_000 });
  });

  it('空/缺失 usage 不抛, 全 0', () => {
    expect(normalizeUsageTokens(null).contextTokens).toBe(0);
    expect(normalizeUsageTokens(undefined).contextTokens).toBe(0);
    expect(normalizeUsageTokens({}).contextTokens).toBe(0);
  });

  it('两个家族在同样的真实上下文下必须得出同一个 contextTokens', () => {
    const anthropic = normalizeUsageTokens({
      prompt_tokens: 146, cache_read_input_tokens: 109_056,
    });
    const deepseek = normalizeUsageTokens({
      prompt_tokens: 109_202, prompt_cache_hit_tokens: 109_056,
    });
    expect(anthropic.contextTokens).toBe(deepseek.contextTokens);
  });
});
