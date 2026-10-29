import { describe, expect, it, vi } from 'vitest';
import type { ProviderConfigEntry } from '@neoxlabs/platform/utils/config.js';
import { resolveProviderByIdentifierForCli, resolveProviderForCli } from './providerPresentation.js';
import { refreshProviderSettingsFromMainState } from './providerModelState.js';

const cloud: ProviderConfigEntry = {
  id: 'neox-cloud', name: 'Neox Cloud', protocol: 'openai',
  apiKey: 'neox-managed', baseUrl: 'https://example.invalid/v1', models: [],
};
const byok: ProviderConfigEntry = {
  id: 'byok', name: 'BYOK', protocol: 'openai', apiKey: 'test',
  baseUrl: 'https://example.invalid/v1', models: [],
};
const store = (withCloud = true) => ({
  getProvider: (id: string | undefined | null) => id === 'neox-cloud' && withCloud ? cloud : id === 'byok' ? byok : undefined,
  getProviders: () => withCloud ? [byok, cloud] : [byok],
  getDefaultProvider: () => byok,
});

describe('CLI account pay-as-you-go provider', () => {
  it('resolves explicit PAYG to account settings, not the default BYOK provider', () => {
    expect(resolveProviderForCli(store(), 'neox-cloud-payg')).toBe(cloud);
    expect(resolveProviderByIdentifierForCli('neox-cloud-payg', store(), byok)).toBe(cloud);
  });

  it('refuses to fall back to BYOK when the account provider is absent', () => {
    expect(() => resolveProviderForCli(store(false), 'neox-cloud-payg')).toThrow('signed-in');
    expect(resolveProviderByIdentifierForCli('neox-cloud-payg', store(false), byok)).toBeNull();
  });

  it('refreshes account settings and labels PAYG without mutating stored settings', () => {
    const getProvider = vi.fn(store().getProvider);
    const setProviderSettings = vi.fn();
    const rebuildCompatProfile = vi.fn();
    refreshProviderSettingsFromMainState({ providerId: 'neox-cloud-payg', providerStore: { getProvider }, setProviderSettings, rebuildCompatProfile });
    expect(getProvider).toHaveBeenCalledWith('neox-cloud');
    expect(setProviderSettings.mock.calls[0][0].id).toBe('neox-cloud');
    expect(setProviderSettings.mock.calls[0][0].name).toContain('按量');
    expect(cloud.name).toBe('Neox Cloud');
    expect(rebuildCompatProfile).toHaveBeenCalledOnce();
  });

  it('keeps subscription and BYOK resolution unchanged', () => {
    expect(resolveProviderForCli(store(), 'neox-cloud')).toBe(cloud);
    expect(resolveProviderForCli(store(), 'byok')).toBe(byok);
    expect(resolveProviderForCli(store())).toBe(byok);
    const setProviderSettings = vi.fn();
    refreshProviderSettingsFromMainState({ providerId: 'neox-cloud', providerStore: store(), setProviderSettings, rebuildCompatProfile: vi.fn() });
    expect(setProviderSettings).toHaveBeenCalledWith(cloud);
  });
});
