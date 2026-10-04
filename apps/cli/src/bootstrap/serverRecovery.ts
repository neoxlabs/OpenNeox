import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

export async function tryRecoverServerConnectionFromMain(params: {
  reason: string;
  disposeRemoteAdapter: () => void;
  resetConnectionState: () => void;
  initServerConnection: () => Promise<void>;
  hasRemoteAdapter: () => boolean;
}): Promise<boolean> {
  cliLogger.warn('INPUT', `Attempting server connection recovery: ${params.reason}`);

  try {
    params.disposeRemoteAdapter();
  } catch {
    // ignore dispose errors
  }

  params.resetConnectionState();

  try {
    await params.initServerConnection();
    const recovered = params.hasRemoteAdapter();
    if (recovered) {
      cliLogger.info('INPUT', 'Server connection recovery succeeded');
    } else {
      cliLogger.warn('INPUT', 'Server connection recovery did not produce adapter');
    }
    return recovered;
  } catch (error: any) {
    cliLogger.error('INPUT', 'Server connection recovery failed', {
      error: error?.message || String(error),
    });
    return false;
  }
}
