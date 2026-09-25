import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

export function registerTtySuspensionMonitoringHandlers(): void {
  // MUST use 'ignore', not empty handler, to prevent signal issues
  // This will be handled by signalManager in the future
  try {
    cliLogger.debug('TTY_STATE', '🛡️  Registering SIGTSTP ignore handler');

    process.on('SIGTSTP', () => {
      cliLogger.error('TTY_STATE', '🚨🚨🚨 SIGTSTP (Ctrl+Z) RECEIVED! This should have been ignored!');
      cliLogger.error('TTY_STATE', `  Stack: ${new Error().stack}`);
    });

    // Keep the ignore handler as well
    // process.on('SIGTSTP', 'ignore' as any);
    cliLogger.debug('TTY_STATE', '✅ SIGTSTP monitoring handler registered');
  } catch {
    // Windows doesn't support SIGTSTP
    cliLogger.debug('TTY_STATE', '⚠️  SIGTSTP not supported on this platform');
  }

  // SIGTTIN is sent when a background process tries to read from the terminal
  // This can happen during ESC interrupt handling or when Ink tries to read input
  try {
    cliLogger.debug('TTY_STATE', '🛡️  [CRITICAL] Registering SIGTTIN ignore handler');

    process.on('SIGTTIN', () => {
      cliLogger.error('TTY_STATE', '🚨🚨🚨 SIGTTIN RECEIVED! This should have been ignored!');
      cliLogger.error('TTY_STATE', `  stdin.isTTY: ${process.stdin.isTTY}`);
      cliLogger.error('TTY_STATE', `  stdin.isRaw: ${(process.stdin as any).isRaw}`);
      cliLogger.error('TTY_STATE', `  stdin.destroyed: ${process.stdin.destroyed}`);
      cliLogger.error('TTY_STATE', `  Stack: ${new Error().stack}`);
    });

    // Then try to ignore it (but the handler above will still fire if it's received)
    // process.on('SIGTTIN', 'ignore' as any);
    cliLogger.debug('TTY_STATE', '✅ SIGTTIN monitoring handler registered');
  } catch {
    // Some platforms don't support SIGTTIN
    cliLogger.debug('TTY_STATE', '⚠️  SIGTTIN not supported on this platform');
  }

  // SIGTTOU is sent when a background process tries to write to the terminal
  try {
    cliLogger.debug('TTY_STATE', '🛡️  [CRITICAL] Registering SIGTTOU ignore handler');

    process.on('SIGTTOU', () => {
      cliLogger.error('TTY_STATE', '🚨🚨🚨 SIGTTOU RECEIVED! This should have been ignored!');
      cliLogger.error('TTY_STATE', `  stdout.isTTY: ${process.stdout.isTTY}`);
      cliLogger.error('TTY_STATE', `  Stack: ${new Error().stack}`);
    });

    // Then try to ignore it (but the handler above will still fire if it's received)
    // process.on('SIGTTOU', 'ignore' as any);
    cliLogger.debug('TTY_STATE', '✅ SIGTTOU monitoring handler registered');
  } catch {
    // Some platforms don't support SIGTTOU
    cliLogger.debug('TTY_STATE', '⚠️  SIGTTOU not supported on this platform');
  }
}

export function registerSigcontRecoveryHandler(): void {
  // When user switches windows (command+→) and comes back, stdin may need recovery
  process.on('SIGCONT', () => {
    cliLogger.debug('TTY_STATE', '🔄 [CRITICAL] SIGCONT received (process resumed)');
    if (process.stdin.isTTY && !process.stdin.destroyed) {
      try {
        // Restore raw mode if we were in raw mode before
        const wasRaw = (process.stdin as any).isRaw;
        cliLogger.debug('TTY_STATE', `  wasRaw: ${wasRaw}`);
        if (wasRaw !== false) {
          cliLogger.debug('TTY_STATE', '🔴 About to call setRawMode(true) in SIGCONT');
          process.stdin.setRawMode(true);
          cliLogger.debug('TTY_STATE', '✅ setRawMode(true) completed in SIGCONT');
        }
        process.stdin.resume();
        cliLogger.debug('SIGNAL', 'SIGCONT: stdin recovered after resume');
      } catch (e) {
        cliLogger.warn('SIGNAL', 'SIGCONT: failed to recover stdin', { error: e });
      }
    }
  });
}

export function registerExitRawModeCleanupHandler(): void {
  // Cleanup on exit
  process.on('exit', (code) => {
    cliLogger.debug('BOOT', `process.exit event, code=${code}`);
    cliLogger.debug('TTY_STATE', '🔴 [CRITICAL] exit event triggered');
    if (process.stdin.isTTY) {
      cliLogger.debug('TTY_STATE', '🔴 [CRITICAL] About to call setRawMode(false) in exit handler');
      process.stdin.setRawMode(false);
      cliLogger.debug('TTY_STATE', '✅ setRawMode(false) completed in exit');
    }
  });
}
