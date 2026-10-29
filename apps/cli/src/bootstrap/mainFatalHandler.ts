import chalk from 'chalk';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { cliErrorln } from '../utils/output.js';

export function runMainWithFatalCatch(mainFn: () => Promise<void>): void {
  mainFn().catch((error) => {
    cliLogger.error('BOOT', `main() top-level catch: ${error.message}`, { stack: error.stack });
    cliLogger.debug('TTY_STATE', '🔴 [CRITICAL] Unhandled error in main()');
    if (process.stdin.isTTY) {
      cliLogger.debug('TTY_STATE', '🔴 [CRITICAL] About to call setRawMode(false) in main() catch');
      cliLogger.debug('TTY_STATE', `  Error: ${error.message}`);
      process.stdin.setRawMode(false);
      cliLogger.debug('TTY_STATE', '✅ setRawMode(false) completed in main() catch');
    }
    cliErrorln(`${chalk.red('\n  [x] Unexpected error:')} ${error.message}`);
    process.exit(1);
  });
}
