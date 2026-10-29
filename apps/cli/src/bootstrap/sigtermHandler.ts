import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { processManager } from '@neoxlabs/platform/platform/processManager.js';
import { spawnExitWatchdog } from '../utils/exitWatchdog.js';

export function registerSigtermCleanupHandler(): void {
  process.on('SIGTERM', () => {
    cliLogger.debug('TTY_STATE', '🔴 [CRITICAL] SIGTERM received');
    processManager.killAll(true);

    if (process.stdin.isTTY) {
      cliLogger.debug('TTY_STATE', '🔴 [CRITICAL] About to call setRawMode(false) in SIGTERM handler');
      cliLogger.debug('TTY_STATE', `  Stack: ${new Error().stack?.split('\n').slice(1, 4).join(' -> ')}`);
      process.stdin.setRawMode(false);
      cliLogger.debug('TTY_STATE', '✅ setRawMode(false) completed in SIGTERM');
    }
    spawnExitWatchdog();
    process.exit(143);
  });
}
