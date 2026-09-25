interface EnsureProviderReadyForModernUIOptions {
  needsProviderConfiguration: () => boolean;
  showProviderConfigurationGuide: () => void;
  ensureProviderConfigured: () => Promise<void>;
  reloadProviderState: () => void;
}

export async function ensureProviderReadyForModernUI(
  options: EnsureProviderReadyForModernUIOptions,
): Promise<void> {
  if (!options.needsProviderConfiguration()) {
    return;
  }

  options.showProviderConfigurationGuide();
  await options.ensureProviderConfigured();
  options.reloadProviderState();
}
