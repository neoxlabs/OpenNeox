import { describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../anthropic.js';

const baseUrlOf = (baseUrl: string): string =>
  (new AnthropicProvider({ authToken: 'k', baseUrl, defaultModel: 'm' }) as any).baseUrl;

describe('AnthropicProvider baseUrl 规范化', () => {
  it('base 带 /v1 时剥掉 —— 路径里写死的 /v1/messages 会补回来', () => {
    expect(baseUrlOf('https://opencode.ai/zen/go/v1/')).toBe('https://opencode.ai/zen/go');
    expect(baseUrlOf('https://opencode.ai/zen/go/v1')).toBe('https://opencode.ai/zen/go');
    expect(baseUrlOf('https://proxy.com/v1')).toBe('https://proxy.com');
  });

  it('base 不带 /v1 时原样保留 —— 两种填法最终打到同一个地址', () => {
    expect(baseUrlOf('https://opencode.ai/zen/go/')).toBe('https://opencode.ai/zen/go');
    expect(baseUrlOf('https://api.anthropic.com')).toBe('https://api.anthropic.com');
  });

  it('只剥末尾那一段 —— 路径中间的 /v1 是人家真实路由的一部分, 不许动', () => {
    expect(baseUrlOf('https://proxy.com/v1/relay')).toBe('https://proxy.com/v1/relay');
    /* relay-g 之类把 /api 当路由前缀的, 之前就专门保过 */
    expect(baseUrlOf('https://relay-g.example/api')).toBe('https://relay-g.example/api');
  });
});
