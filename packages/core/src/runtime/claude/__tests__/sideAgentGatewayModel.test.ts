import { describe, expect, test, vi } from 'vitest';
import { ClaudeSideAgentService } from '../ClaudeSideAgentService';

vi.mock('../../../models/factory.js', () => ({
  createProviderAdapter: vi.fn((_protocol: string, config: any) => {
    if (!config.defaultModel || !config.defaultModel.trim()) {
      throw new Error('OpenAIAdapter: defaultModel is required (refusing silent fallback to "gpt-4o").');
    }
    return {
      chat: async (_messages: unknown, options: any) => ({
        choices: [{ message: { content: `title-for:${options.model}` } }],
      }),
    };
  }),
}));

const gateway = { id: 'neox-cloud', protocol: 'openai', apiKey: 'k', baseUrl: 'https://x', models: [] } as any;

const messages = [{ role: 'user', content: 'hi' }] as any;

describe('side-agent · 网关 provider 没有 defaultModel', () => {
  test('用本次选定的 model 构造 adapter, 请求能发出去', async () => {
    const service = new ClaudeSideAgentService(() => ({ provider: gateway, llmConfig: { model: 'deepseek-v4-flash' } }));
    const result = await service.query({
      providerId: 'neox-cloud',
      modelName: 'deepseek-v4-flash',
      messages,
      maxTokens: 64,
    });
    expect(result.text).toBe('title-for:deepseek-v4-flash');
  });

  test('provider 自带 defaultModel 时照旧原样传 (不改写用户配置)', async () => {
    const withDefault = { ...gateway, id: 'deepseek', defaultModel: 'deepseek-v4-flash' };
    const service = new ClaudeSideAgentService(() => ({ provider: withDefault, llmConfig: { model: 'deepseek-v4-pro' } }));
    const result = await service.query({
      providerId: 'deepseek',
      modelName: 'deepseek-v4-pro',
      messages,
      maxTokens: 64,
    });
    /* chat 那一发用 selected.modelName —— deepseek 家族的轻活会被降到同族 flash
     * (resolveSubAgentModelSelection), 所以这里是 flash 不是 pro; 关键是它没炸。 */
    expect(result.text).toBe('title-for:deepseek-v4-flash');
    expect(result.modelName).toBe('deepseek-v4-flash');
  });
});
