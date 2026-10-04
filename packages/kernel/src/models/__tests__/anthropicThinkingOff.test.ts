import { describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../anthropic.js';
import { isDeepSeekAnthropicTarget } from '../anthropicMessageCompat.js';

const build = (baseUrl: string, model: string) =>
  (new AnthropicProvider({ authToken: 'k', baseUrl, defaultModel: model } as any) as any)
    .buildPayload([{ role: 'user', content: 'hi' }], { model, effortLevel: 'off' });

describe('off 档的 thinking 字段', () => {
  it('DeepSeek 官方端点: 明发 disabled', () => {
    const p = build('https://api.deepseek.com/anthropic', 'deepseek-flash');
    expect(p.thinking).toEqual({ type: 'disabled' });
  });

  it('经转发的 deepseek-* 模型也明发 disabled', () => {
    const p = build('https://relay.example.com', 'deepseek-v4.1-flash');
    expect(p.thinking).toEqual({ type: 'disabled' });
  });

  it('识别规则: 模型名或 deepseek.com 域名', () => {
    expect(isDeepSeekAnthropicTarget('deepseek-flash', 'https://x.com')).toBe(true);
    expect(isDeepSeekAnthropicTarget('glm-5', 'https://api.deepseek.com/anthropic')).toBe(true);
    expect(isDeepSeekAnthropicTarget('claude-sonnet-5', 'https://api.anthropic.com')).toBe(false);
  });
});
