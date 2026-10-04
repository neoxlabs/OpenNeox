import { describe, expect, it } from 'vitest';
import type { ProviderConfigEntry } from '@neoxlabs/platform/utils/config.js';
import { estimateContextWindow, resolveModelCapabilities } from '@neoxlabs/platform/platform/modelCapabilities.js';

function provider(overrides: Partial<ProviderConfigEntry>): ProviderConfigEntry {
  return {
    id: 'byok',
    name: 'BYOK',
    protocol: 'openai',
    apiKey: 'sk-test',
    baseUrl: 'https://example.test/v1',
    models: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('resolveModelCapabilities', () => {
  it('uses registry metadata for concrete BYOK models', () => {
    const capabilities = resolveModelCapabilities(provider({
      models: [{ name: 'qwen3.7-max', createdAt: '2026-01-01T00:00:00.000Z' }],
      maxInputTokens: 128000,
    }), 'qwen3.7-max');

    expect(capabilities.contextWindow).toBe(1000000);
    expect(capabilities.maxOutputTokens).toBe(128000);
    expect(capabilities.compatProfile.contextWindow).toBe(1000000);
    expect(capabilities.compatProfile.maxOutputTokens).toBe(128000);
  });

  it('lets per-model compat override registry and provider defaults', () => {
    const capabilities = resolveModelCapabilities(provider({
      models: [{
        name: 'qwen3.7-max',
        createdAt: '2026-01-01T00:00:00.000Z',
        compat: {
          contextWindow: 64000,
          maxOutputTokens: 12000,
        },
      }],
      maxInputTokens: 128000,
      maxTokens: 16000,
    }), 'qwen3.7-max');

    expect(capabilities.contextWindow).toBe(64000);
    expect(capabilities.maxOutputTokens).toBe(12000);
    expect(capabilities.compatProfile.contextWindow).toBe(64000);
    expect(capabilities.compatProfile.maxOutputTokens).toBe(12000);
  });

  it('falls back to provider-level limits for unregistered custom models', () => {
    const capabilities = resolveModelCapabilities(provider({
      models: [{ name: 'custom-agent-model', createdAt: '2026-01-01T00:00:00.000Z' }],
      maxInputTokens: 512000,
      maxTokens: 32000,
    }), 'custom-agent-model');

    expect(capabilities.contextWindow).toBe(512000);
    expect(capabilities.maxOutputTokens).toBe(32000);
    expect(capabilities.compatProfile.contextWindow).toBe(512000);
    expect(capabilities.compatProfile.maxOutputTokens).toBe(32000);
  });

  it('uses 128K as the safe fallback for unknown BYOK models without metadata', () => {
    const capabilities = resolveModelCapabilities(provider({
      models: [{ name: 'mimo-v2.5-pro', createdAt: '2026-01-01T00:00:00.000Z' }],
    }), 'mimo-v2.5-pro');

    expect(capabilities.contextWindow).toBe(128000);
    expect(capabilities.compatProfile.contextWindow).toBe(128000);
  });
});

describe('lookupRegistryModel (fuzzy registry match)', () => {
  it('matches date/channel variant names to registry entries', async () => {
    const { lookupRegistryModel } = await import('@neoxlabs/platform/platform/modelCapabilities.js');
    expect(lookupRegistryModel('gpt-5.5-preview-0624')?.id).toBe('gpt-5.5');
    expect(lookupRegistryModel('my-glm-5.2-custom')?.id).toBe('glm-5.2');
  });

  it('prefers the most specific (longest) registry entry', async () => {
    const { lookupRegistryModel } = await import('@neoxlabs/platform/platform/modelCapabilities.js');
    expect(lookupRegistryModel('gpt-5.4-mini-2026-06-01')?.id).toBe('gpt-5.4-mini');
    expect(lookupRegistryModel('gpt-5.5-pro-2026-04-23')?.id).toBe('gpt-5.5-pro');
  });

  it('returns undefined for names no registry entry covers', async () => {
    const { lookupRegistryModel } = await import('@neoxlabs/platform/platform/modelCapabilities.js');
    expect(lookupRegistryModel('totally-unknown-llm')).toBeUndefined();
    expect(lookupRegistryModel('')).toBeUndefined();
  });
});

describe('estimateContextWindow (registry-backed)', () => {
  it('resolves variant names through fuzzy registry match instead of the legacy chain', async () => {
    const { estimateContextWindow } = await import('@neoxlabs/platform/platform/modelCapabilities.js');
    expect(estimateContextWindow('gpt-5.5-preview-0624')).toBe(272000);
    expect(estimateContextWindow('gpt-5.5-pro-2026-04-23')).toBe(272000);
    expect(estimateContextWindow('unknown-model-xyz')).toBe(128000);
  });
});

describe('resolveModelCapabilities — 上游少报窗口的对账', () => {
  it('上游报 200K 但 registry 精确命中 1M → 取 1M', async () => {
    const { resolveModelCapabilities } = await import('@neoxlabs/platform/platform/modelCapabilities.js');
    const caps = resolveModelCapabilities(
      { models: [{ name: 'claude-opus-4-8', contextWindow: 200000 }] } as any,
      'claude-opus-4-8',
    );
    expect(caps.contextWindow).toBe(1000000);
  });

  it('claude-opus-4-7 上游少报 200K → 取 registry 1M', async () => {
    const { resolveModelCapabilities } = await import('@neoxlabs/platform/platform/modelCapabilities.js');
    const caps = resolveModelCapabilities(
      { models: [{ name: 'claude-opus-4-7', contextWindow: 200000 }] } as any,
      'claude-opus-4-7',
    );
    expect(caps.contextWindow).toBe(1000000);
  });

  it('grok-4.5 上游少报 28K → 取 registry 500K', async () => {
    const { resolveModelCapabilities } = await import('@neoxlabs/platform/platform/modelCapabilities.js');
    const caps = resolveModelCapabilities(
      { models: [{ name: 'grok-4.5', contextWindow: 28000 }] } as any,
      'grok-4.5',
    );
    expect(caps.contextWindow).toBe(500000);
  });

  it('显式 compat 覆盖仍然赢过 registry(用户主动收窄的意图要尊重)', async () => {
    const { resolveModelCapabilities } = await import('@neoxlabs/platform/platform/modelCapabilities.js');
    const caps = resolveModelCapabilities(
      { models: [{ name: 'claude-opus-4-8', compat: { contextWindow: 64000 } }] } as any,
      'claude-opus-4-8',
    );
    expect(caps.contextWindow).toBe(64000);
  });

  it('registry 不认识的模型 → 仍尊重上游报回值', async () => {
    const { resolveModelCapabilities } = await import('@neoxlabs/platform/platform/modelCapabilities.js');
    const caps = resolveModelCapabilities(
      { models: [{ name: 'some-unknown-model-xyz', contextWindow: 500000 }] } as any,
      'some-unknown-model-xyz',
    );
    expect(caps.contextWindow).toBe(500000);
  });
});

describe('lookupRegistryModel — 版本安全模糊匹配', () => {
  it('claude-opus-4-7 不得误命中旧版 claude-opus-4 (200K)', async () => {
    const { lookupRegistryModel, estimateContextWindow } = await import('@neoxlabs/platform/platform/modelCapabilities.js');
    expect(lookupRegistryModel('claude-opus-4-7')?.id).toBe('claude-opus-4-7');
    expect(estimateContextWindow('claude-opus-4-7')).toBe(1000000);
  });

  it('provider 前缀名仍能命中', async () => {
    const { lookupRegistryModel } = await import('@neoxlabs/platform/platform/modelCapabilities.js');
    expect(lookupRegistryModel('neox-cloud:claude-opus-4-7')?.id).toBe('claude-opus-4-7');
    expect(lookupRegistryModel('x-ai/grok-4.5')?.id).toBe('grok-4.5');
  });
});

describe('还没进 registry 的新模型 —— 按同家族最新那个推断窗口', () => {
  it('新版本不会比同家族前一代更小', () => {
    expect(estimateContextWindow('gpt-6')).toBeGreaterThanOrEqual(
      estimateContextWindow('gpt-5.6-sol'),
    );
    expect(estimateContextWindow('glm-6')).toBeGreaterThan(200_000);
    expect(estimateContextWindow('deepseek-v5')).toBeGreaterThan(128_000);
    expect(estimateContextWindow('claude-opus-5')).toBeGreaterThanOrEqual(1_000_000);
  });

  it('已知模型的值一个都不许变', () => {
    /* 推断只在 registry miss 时生效 —— 命中的照旧走 registry */
    expect(estimateContextWindow('gpt-4o')).toBe(128_000);
    expect(estimateContextWindow('gpt-5.6-sol')).toBe(372_000);
  });

  it('认不出家族就老实给保守值', () => {
    expect(estimateContextWindow('some-random-llm')).toBe(128_000);
  });
});
