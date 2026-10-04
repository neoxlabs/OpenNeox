import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import type { RemoteAccessConfig } from '@neoxlabs/platform/utils/config.js';

type SdkClientWithAuth = {
  setAuth: (auth: { enabled: boolean; token?: string }) => Promise<any>;
} | null;

export function regenerateRemoteTokenFromMain(params: {
  createToken: () => string;
  updateRemoteConfig: (updates: Partial<RemoteAccessConfig>) => void;
  sdkClient: SdkClientWithAuth;
}): string {
  const token = params.createToken();
  params.updateRemoteConfig({ token });
  params.sdkClient?.setAuth({ enabled: true, token }).catch((error) => {
    cliLogger.warn('REMOTE', 'Failed to sync regenerated remote token to runtime auth', {
      message: error instanceof Error ? error.message : String(error),
    });
  });
  return token;
}

export async function startRemoteServerFromMain(params: {
  config: Required<RemoteAccessConfig>;
  existing: RemoteAccessConfig;
  updateRemoteConfig: (updates: Partial<RemoteAccessConfig>) => void;
  sdkClient: SdkClientWithAuth;
  setRemoteEnabled: (value: boolean) => void;
}): Promise<void> {
  if (!params.config.enabled) {
    return;
  }
  if (!params.existing.token || !params.existing.host || !params.existing.port || !params.existing.networkMode) {
    params.updateRemoteConfig(params.config);
  }

  if (params.sdkClient) {
    try {
      await params.sdkClient.setAuth({ enabled: true, token: params.config.token });
      params.setRemoteEnabled(true);
      cliLogger.info(
        'REMOTE',
        `Remote auth enabled (${params.config.networkMode.toUpperCase()}), token: ${params.config.token.slice(0, 8)}...`,
      );
    } catch (e: any) {
      cliLogger.error('REMOTE', `Failed to enable auth on Main Server: ${e.message}`);
    }
  }
}

export async function stopRemoteServerFromMain(params: {
  remoteEnabled: boolean;
  sdkClient: SdkClientWithAuth;
  setRemoteEnabled: (value: boolean) => void;
}): Promise<void> {
  if (!params.remoteEnabled) {
    return;
  }
  if (params.sdkClient) {
    try {
      await params.sdkClient.setAuth({ enabled: false });
    } catch (e: any) {
      cliLogger.error('REMOTE', `Failed to disable auth: ${e.message}`);
    }
  }
  params.setRemoteEnabled(false);
}
