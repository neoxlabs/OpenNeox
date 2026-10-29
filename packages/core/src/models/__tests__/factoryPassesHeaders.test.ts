import { describe, it, expect } from 'vitest';
import { ProviderFactory } from '../factory.js';

describe('ProviderFactory → OpenAIProvider 透传', () => {
  it('extraHeaders (按量计费头) 到达真正发请求的 client', () => {
    const adapter = ProviderFactory.createAdapter('openai', {
      id: 'neox-cloud', name: 'Neox', protocol: 'openai', apiKey: 'sk-test', baseUrl: 'https://example.test/v1',
      models: [], defaultModel: 'gpt-6.1-sol', extraHeaders: { 'X-Neox-Billing': 'payg' },
    } as any);
    const headers = (adapter as any).provider.client.defaults.headers;
    expect(headers['X-Neox-Billing']).toBe('payg');
  });
});
