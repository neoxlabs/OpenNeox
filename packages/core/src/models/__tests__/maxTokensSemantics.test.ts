import { describe, it, expect } from 'vitest';
import { AnthropicAdapter } from '../adapters/anthropic.js';
import { OpenAIAdapter } from '../adapters/openai.js';

/**
 *  · max_tokens 语义混用回归钉 (用户三连已确认):
 * runner 传 maxInputTokens = 模型上下文窗口 (1M); 旧 adapter 把它冒充 max_tokens (输出上限)
 * 送本地校验 → "Invalid parameters: max_tokens (1000000) exceeds model context window
 * (400000) for gpt-5.4-mini" — **HTTP 未发, 本地预检自爆**, 上游 (new-api) 全程无记录。
 * 侧路 agent 用派生 mini 模型 + 主模型的 1M 预算, 是最高频触发组合。
 */
describe('max_tokens semantics — context budget must never masquerade as output cap', () => {
  it('anthropic adapter: 1M maxInputTokens + mini model passes validation with sane max_tokens', () => {
    const adapter = new AnthropicAdapter({ authToken: 'k', defaultModel: 'claude-opus-4-6' });
    const prepared = adapter.prepareRequest(
      [{ role: 'user', content: 'give this chat a title' }],
      { model: 'gpt-5.4-mini', maxInputTokens: 1_000_000 } as any,
    );
    expect(prepared.validation?.valid).toBe(true);
    expect(prepared.validation?.errors ?? []).toEqual([]);
    const maxTokens = (prepared.options as any).max_tokens;
    expect(maxTokens).toBeLessThanOrEqual(32000);
    expect(maxTokens).toBeGreaterThan(0);
  });

  it('openai adapter: 1M maxInputTokens passes validation (no fake max_tokens fed to validator)', () => {
    const adapter = new OpenAIAdapter({ apiKey: 'k', baseUrl: 'https://proxy.example.com/v1', defaultModel: 'gpt-5.5' });
    const prepared = adapter.prepareRequest(
      [{ role: 'user', content: 'hi' }],
      { model: 'gpt-5.4-mini', maxInputTokens: 1_000_000 } as any,
    );
    expect(prepared.validation?.valid).toBe(true);
    expect(prepared.validation?.errors ?? []).toEqual([]);
  });

  it('explicit BYOK output cap (maxTokens 8192) is honored, not clobbered by input budget', () => {
    const adapter = new AnthropicAdapter({ authToken: 'k', defaultModel: 'claude-opus-4-6' });
    const prepared = adapter.prepareRequest(
      [{ role: 'user', content: 'hi' }],
      { model: 'claude-opus-4-6', maxInputTokens: 1_000_000, maxTokens: 8192 } as any,
    );
    expect(prepared.validation?.valid).toBe(true);
    expect((prepared.options as any).max_tokens).toBe(8192);
  });
});
