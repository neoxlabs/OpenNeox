import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { processManager } from '@neoxlabs/platform/platform/processManager.js';
import { spawn as nodeSpawn } from 'child_process';

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
    try {
      const wd = process.platform === 'win32'
        ? nodeSpawn(
            'cmd.exe',
            ['/c', `timeout /t 1 /nobreak >nul & taskkill /f /pid ${process.pid} >nul 2>&1`],
            { detached: true, stdio: 'ignore', windowsHide: true },
          )
        : nodeSpawn(
            '/bin/sh',
            ['-c', `sleep 0.3; kill -9 ${process.pid} 2>/dev/null`],
            { detached: true, stdio: 'ignore' },
          );
      wd.unref();
    } catch { /* ignore */ }
    process.exit(143);
  });
}
