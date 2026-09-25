import type { NeoxConfig, RemoteAccessConfig } from '@neoxlabs/platform/utils/config.js';
import { getDefaultServerPort } from '@neoxlabs/platform/utils/config.js';

interface NormalizeRemoteConfigOptions {
  generateToken?: boolean;
  createToken: () => string;
}

export function getRemoteConfig(userConfig: NeoxConfig): RemoteAccessConfig {
  return userConfig.remote ?? {};
}

export function normalizeRemoteConfig(
  remoteConfig: RemoteAccessConfig,
  options: NormalizeRemoteConfigOptions,
): Required<RemoteAccessConfig> {
  const { generateToken = false, createToken } = options;
  return {
    enabled: remoteConfig.enabled ?? false,
    networkMode: remoteConfig.networkMode === 'vps' ? 'vps' : 'lan',
    host: remoteConfig.host || '0.0.0.0',
    port: remoteConfig.port || getDefaultServerPort(),
    token: remoteConfig.token || (generateToken ? createToken() : ''),
    allowVoice: remoteConfig.allowVoice ?? true,
    autoApprove: remoteConfig.autoApprove ?? true,
    corsOrigins: remoteConfig.corsOrigins ?? [],
  };
}

export function applyRemoteConfigUpdates(
  userConfig: NeoxConfig,
  currentConfig: Required<RemoteAccessConfig>,
  updates: Partial<RemoteAccessConfig>,
): NeoxConfig {
  const next: RemoteAccessConfig = { ...currentConfig, ...updates };
  return {
    ...userConfig,
    remote: next,
  };
}
