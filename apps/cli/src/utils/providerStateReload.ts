import type { NeoxConfig, ProviderConfigEntry, ProviderProtocol } from '@neoxlabs/platform/utils/config.js';
import { loadConfig } from '@neoxlabs/platform/utils/config.js';
import { ProviderStore } from '@neoxlabs/platform/utils/providerStore.js';
import { resolveProviderForCli } from './providerPresentation.js';

export type ReloadedProviderStateForCli = {
  userConfig: NeoxConfig;
  providerStore: ProviderStore;
  providerSettings: ProviderConfigEntry;
  providerId: string;
  provider: ProviderProtocol;
  model: string;
};

export function reloadProviderStateForModernUiFromCli(): ReloadedProviderStateForCli {
  const userConfig = loadConfig();
  const providerStore = new ProviderStore(userConfig);
  const initialProvider = resolveProviderForCli(providerStore, undefined);
  const resolvedModel = providerStore.resolveModel(initialProvider.id);
  if (!resolvedModel) {
    throw new Error(
      `Provider "${initialProvider.name}" does not have any models configured. Use /model add to configure one.`,
    );
  }
  providerStore.setLastSelectedModel(initialProvider.id, resolvedModel);
  return {
    userConfig,
    providerStore,
    providerSettings: initialProvider,
    providerId: initialProvider.id,
    provider: initialProvider.protocol,
    model: resolvedModel,
  };
}
