import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NeoxConfig, ProviderConfigEntry } from '@neoxlabs/platform/utils/config.js';
import { setProviderResolver } from '@neoxlabs/platform/platform/providerResolver.js';
import { ProviderResolver } from '../services/providerResolver.js';

const timestamp = '2026-01-01T00:00:00.000Z';

function provider(overrides: Partial<ProviderConfigEntry>): ProviderConfigEntry {
  return {
    id: 'provider',
    name: 'Provider',
    protocol: 'openai',
    apiKey: 'sk-test',
    baseUrl: 'https://example.test/v1',
    models: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function createResolver(providers: ProviderConfigEntry[], defaultProviderId = providers[0]?.id): ProviderResolver {
  const config: NeoxConfig = {
    defaultProviderId,
    providers: Object.fromEntries(providers.map(entry => [entry.id, entry])),
  };
  return new ProviderResolver(config);
}

describe('server ProviderResolver', () => {
  beforeEach(() => {
    setProviderResolver((entry) => entry);
  });

  afterEach(() => {
    setProviderResolver(null);
  });

  it('keeps subscription models on neox-cloud while resolving runtime capabilities', () => {
    const resolver = createResolver([
      provider({
        id: 'neox-cloud',
        name: 'Neox Cloud',
        apiKey: 'neox-managed',
        baseUrl: '',
        models: [],
        lastSelectedModel: 'claude-opus-4-6',
      }),
    ], 'neox-cloud');

    const resolved = resolver.resolve('neox-cloud', 'claude-opus-4-6');

    expect(resolved.provider?.id).toBe('neox-cloud');
    expect(resolved.llmConfig?.model).toBe('claude-opus-4-6');
    expect(resolved.llmConfig?.maxInputTokens).toBe(1000000);
    expect(resolved.llmConfig?.compatProfile?.contextWindow).toBe(1000000);
  });

  it('keeps BYOK providers direct and resolves the selected model capability', () => {
    const resolver = createResolver([
      provider({
        id: 'qwen-main',
        name: 'Qwen BYOK',
        protocol: 'qwen',
        models: [{ name: 'qwen3.7-max', createdAt: timestamp }],
        defaultModel: 'qwen3.7-max',
        lastSelectedModel: 'qwen3.7-max',
        maxInputTokens: 128000,
      }),
    ], 'qwen-main');

    const resolved = resolver.resolve('qwen-main', 'qwen3.7-max');

    expect(resolved.provider?.id).toBe('qwen-main');
    expect(resolved.provider?.apiKey).toBe('sk-test');
    expect(resolved.llmConfig?.model).toBe('qwen3.7-max');
    expect(resolved.llmConfig?.maxInputTokens).toBe(1000000);
    expect(resolved.llmConfig?.compatProfile?.contextWindow).toBe(1000000);
  });
});
