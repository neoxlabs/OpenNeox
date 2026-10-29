import type { NeoxConfig, RemoteAccessConfig } from '@neoxlabs/platform/utils/config.js';
import {
  applyRemoteConfigUpdates,
  getRemoteConfig as getRemoteConfigUtil,
  normalizeRemoteConfig as normalizeRemoteConfigUtil,
} from './remoteConfig.js';

export function getNormalizedRemoteConfigFromMainState(params: {
  userConfig: NeoxConfig;
  generateToken?: boolean;
  createToken: () => string;
}): Required<RemoteAccessConfig> {
  return normalizeRemoteConfigUtil(getRemoteConfigUtil(params.userConfig), {
    generateToken: params.generateToken,
    createToken: params.createToken,
  });
}

export function updateRemoteConfigFromMainState(params: {
  userConfig: NeoxConfig;
  updates: Partial<RemoteAccessConfig>;
  createToken: () => string;
}): NeoxConfig {
  const current = getNormalizedRemoteConfigFromMainState({
    userConfig: params.userConfig,
    createToken: params.createToken,
  });
  return applyRemoteConfigUpdates(params.userConfig, current, params.updates);
}

export function getRawRemoteConfigFromMainState(userConfig: NeoxConfig): RemoteAccessConfig {
  return getRemoteConfigUtil(userConfig);
}
