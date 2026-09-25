import { stopServer } from '@neoxlabs/core/server/processManager.js';
import { cliLogger, cliHealthMonitor } from '@neoxlabs/kernel/platform/cliLogger.js';
import { handleBackgroundProcessExitPrompt } from '../utils/backgroundProcessExit.js';
import { runCleanupSequence } from './cleanupSequence.js';

export async function cleanupCliLifecycleFromMain(params: {
  skipProcessCheck: boolean;
  uiController: any;
  setInkConsolePatch: (enabled: boolean) => void;
  setInkUIActive: (active: boolean) => void;
  stopRemoteServer: () => Promise<void>;
  remoteAdapter: any;
  clearRemoteAdapter: () => void;
  serverConnection: any;
  clearServerConnection: () => void;
  shutdownActionLog: () => Promise<void>;
}): Promise<void> {
  cliLogger.debug('DEBUG', `NeoxCLI.cleanup() called, skipProcessCheck=${params.skipProcessCheck}`);

  cliLogger.debug('DEBUG', 'Stopping health monitor');
  cliHealthMonitor.stop();

  await runCleanupSequence({
    stopUi: () => {
      if (!params.uiController) {
        return;
      }
      cliLogger.debug('DEBUG', 'Calling uiController.stop()');
      params.uiController.stop();
      params.setInkConsolePatch(false);
      params.setInkUIActive(false);
      cliLogger.debug('DEBUG', 'uiController.stop() returned');
    },
    stopRemoteServer: () => params.stopRemoteServer(),
    disposeRemoteAdapter: () => {
      if (!params.remoteAdapter) {
        return;
      }
      params.remoteAdapter.dispose();
      params.clearRemoteAdapter();
    },
    stopServerConnection: () => {
      if (!params.serverConnection) {
        return;
      }
      stopServer(params.serverConnection);
      params.clearServerConnection();
    },
    shutdownActionLog: () => params.shutdownActionLog(),
    handleBackgroundProcesses: () => handleBackgroundProcessExitPrompt(params.skipProcessCheck),
  });
}
