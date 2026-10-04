import type { ProviderConfigEntry, ProviderProtocol } from '@neoxlabs/platform/utils/config.js';
import { getCliEdition } from '../edition/index.js';

const NEOX_CLOUD_ID = 'neox-cloud';

/**
 * resolveInitialModel — 启动期 / 切 provider 时定 model.
 *
 *   BYOK provider: 走 ProviderStore.resolveModel(provider.models[] / lastSelected / defaultModel).
 *   sentinel neox-cloud: provider.models 永远空, 由账号插槽按订阅套餐挑
 *     (商业版实现见 auth/registerEdition.ts; 公开版没有 sentinel, 退回 BYOK 规则)。
 */
export function resolveInitialModel(
  provider: ProviderConfigEntry,
  providerStore: { resolveModel: (id: string, requested?: string) => string | undefined },
): string | undefined {
  const account = getCliEdition().account;
  if (provider.id !== NEOX_CLOUD_ID || !account) {
    return providerStore.resolveModel(provider.id);
  }
  return account.resolveManagedInitialModel(provider);
}

export function resolveProviderByIdentifierForCli(
  providerId: string | undefined,
  providerStore: {
    getProvider: (id: string) => ProviderConfigEntry | null | undefined;
    getProviders: () => ProviderConfigEntry[];
  },
  currentProviderSettings: ProviderConfigEntry | undefined,
): ProviderConfigEntry | null {
  if (providerId) {
    const byId = providerStore.getProvider(providerId);
    if (byId) {
      return byId;
    }
    const byProtocol = providerStore.getProviders().find(
      (provider) => provider.protocol === (providerId as ProviderProtocol),
    );
    if (byProtocol) {
      return byProtocol;
    }
    return null;
  }
  return currentProviderSettings || null;
}

export function resolveProviderForCli(
  providerStore: {
    getProvider: (id: string) => ProviderConfigEntry | null | undefined;
    getProviders: () => ProviderConfigEntry[];
    getDefaultProvider: () => ProviderConfigEntry | null | undefined;
  },
  providerId?: string,
): ProviderConfigEntry {
  if (providerId) {
    const byId = providerStore.getProvider(providerId);
    if (byId) {
      return byId;
    }
    const protocolCandidate = providerId as ProviderProtocol;
    const byProtocol = providerStore.getProviders().find(
      (provider) => provider.protocol === protocolCandidate,
    );
    if (byProtocol) {
      return byProtocol;
    }
  }

  const existing = providerStore.getDefaultProvider();
  if (!existing) {
    throw new Error('No LLM providers configured. Run /provider add to set up a provider.');
  }
  return existing;
}

export function getProviderDisplayNameForCli(
  providerSettings: ProviderConfigEntry | undefined,
  protocolLabels: Record<string, string>,
): string {
  if (!providerSettings) {
    return 'Not configured';
  }
  const protocolName = protocolLabels[providerSettings.protocol] || 'OpenAI';
  return `${providerSettings.name} (${protocolName})`;
}

export function getModelShortNameForCli(model: string): string {
  const m = model.toLowerCase();
  if (m.includes('claude-3-opus') || m.includes('opus')) return 'opus';
  if (m.includes('claude-3-sonnet') || m.includes('sonnet')) return 'sonnet';
  if (m.includes('claude-3-haiku') || m.includes('haiku')) return 'haiku';
  if (m.includes('claude')) return 'claude';
  if (m.includes('gpt-4o')) return 'gpt-4o';
  if (m.includes('gpt-4')) return 'gpt-4';
  if (m.includes('gpt-3.5')) return 'gpt-3.5';
  if (m.includes('gpt')) return 'gpt';
  if (m.includes('gemini-pro')) return 'gemini-pro';
  if (m.includes('gemini')) return 'gemini';
  if (m.includes('deepseek')) return 'deepseek';
  if (m.includes('qwen')) return 'qwen';
  return model.length > 10 ? model.substring(0, 10) : model;
}
