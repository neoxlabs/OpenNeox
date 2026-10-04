import type { ProviderConfigEntry, ProviderModelConfig } from '@neoxlabs/platform/utils/config.js';

export function refreshProviderSettingsFromMainState(params: {
  providerId: string | undefined;
  providerStore: { getProvider: (id: string | undefined) => ProviderConfigEntry | undefined };
  setProviderSettings: (provider: ProviderConfigEntry) => void;
  rebuildCompatProfile: () => void;
}): void {
  if (!params.providerId) return;
  const latest = params.providerStore.getProvider(params.providerId);
  if (latest) {
    params.setProviderSettings(latest);
    params.rebuildCompatProfile();
  }
}

export function getActiveModelConfigForCli(
  providerSettings: ProviderConfigEntry | undefined,
  model: string,
): ProviderModelConfig | undefined {
  return providerSettings?.models?.find((entry) => entry.name === model);
}

export function getActiveReasoningEffortForCli(
  providerSettings: ProviderConfigEntry | undefined,
  targetModel: string,
): string | undefined {
  const modelConfig = providerSettings?.models?.find((entry) => entry.name === targetModel);
  return modelConfig?.reasoning?.effort;
}
