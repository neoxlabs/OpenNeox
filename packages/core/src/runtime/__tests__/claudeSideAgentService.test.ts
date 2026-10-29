import { afterEach, describe, expect, it, vi } from 'vitest';
import * as factory from '../../models/factory.js';
import { AnthropicAdapter } from '../../models/adapters/anthropic.js';
import { ClaudeSideAgentService } from '../claude/ClaudeSideAgentService.js';

const response = {
  id: 'resp_1',
  choices: [{ message: { role: 'assistant' as const, content: '{"type":"wait"}' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

afterEach(() => {
  vi.restoreAllMocks();
});

function createService(models: string[], baseUrl = 'https://api.anthropic.com') {
  return new ClaudeSideAgentService(() => ({
    provider: {
      id: 'anthropic-main',
      name: 'Anthropic',
      protocol: 'anthropic',
      apiKey: 'test-key',
      baseUrl,
      models: models.map(name => ({ name })),
    },
    llmConfig: null,
  }));
}

describe('ClaudeSideAgentService', () => {
  it('uses Anthropic non-stream fast-path with thinking disabled', async () => {
    const adapter = new AnthropicAdapter({
      authToken: 'test-key',
      baseUrl: 'https://api.anthropic.com',
      defaultModel: 'claude-opus-4-6',
    });
    const providerChat = vi.spyOn(adapter.getProvider(), 'chat').mockResolvedValue(response as any);
    const adapterChat = vi.spyOn(adapter, 'chat');
    vi.spyOn(factory, 'createProviderAdapter').mockReturnValue(adapter as any);

    const service = createService(['claude-opus-4-6']);
    const result = await service.query({
      providerId: 'anthropic-main',
      modelName: 'claude-opus-4-6',
      maxTokens: 600,
      messages: [{ role: 'user', content: 'return json' }],
    });

    expect(result).toMatchObject({
      providerId: 'anthropic-main',
      modelName: 'claude-haiku-4-5-20251001',
      text: '{"type":"wait"}',
    });
    expect(providerChat).toHaveBeenCalledWith(
      [{ role: 'user', content: 'return json' }],
      expect.objectContaining({
        model: 'claude-haiku-4-5-20251001',
        maxTokens: 600,
        stream: false,
        disableCaching: true,
        thinking: { type: 'disabled' },
      }),
    );
    expect(adapterChat).not.toHaveBeenCalled();
  });

  it('does not auto-fallback to Opus when the flag is disabled', async () => {
    const adapter = new AnthropicAdapter({
      authToken: 'test-key',
      baseUrl: 'https://api.anthropic.com',
      defaultModel: 'claude-sonnet-4-5-20250929',
    });
    const providerChat = vi.spyOn(adapter.getProvider(), 'chat').mockResolvedValue(response as any);
    vi.spyOn(factory, 'createProviderAdapter').mockReturnValue(adapter as any);

    const service = createService(['claude-sonnet-4-5-20250929', 'claude-opus-4-6'], 'https://proxy.example.com');
    const result = await service.query({
      providerId: 'anthropic-main',
      modelName: 'claude-sonnet-4-5-20250929',
      maxTokens: 300,
      messages: [{ role: 'user', content: 'return json' }],
    });

    expect(result).toMatchObject({
      providerId: 'anthropic-main',
      modelName: 'claude-sonnet-4-5-20250929',
    });
    expect(providerChat).toHaveBeenCalledWith(
      [{ role: 'user', content: 'return json' }],
      expect.objectContaining({ model: 'claude-sonnet-4-5-20250929' }),
    );
  });

  it('falls back to Opus only when the flag is enabled', async () => {
    const adapter = new AnthropicAdapter({
      authToken: 'test-key',
      baseUrl: 'https://api.anthropic.com',
      defaultModel: 'claude-sonnet-4-5-20250929',
    });
    const providerChat = vi.spyOn(adapter.getProvider(), 'chat').mockResolvedValue(response as any);
    vi.spyOn(factory, 'createProviderAdapter').mockReturnValue(adapter as any);

    const service = createService(['claude-sonnet-4-5-20250929', 'claude-opus-4-6'], 'https://proxy.example.com');
    const result = await service.query({
      providerId: 'anthropic-main',
      modelName: 'claude-sonnet-4-5-20250929',
      maxTokens: 300,
      allowOpusFallback: true,
      messages: [{ role: 'user', content: 'return json' }],
    });

    expect(result).toMatchObject({
      providerId: 'anthropic-main',
      modelName: 'claude-opus-4-6',
    });
    expect(providerChat).toHaveBeenCalledWith(
      [{ role: 'user', content: 'return json' }],
      expect.objectContaining({ model: 'claude-opus-4-6' }),
    );
  });
});
