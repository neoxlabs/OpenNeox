import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

export function bootstrapDebugFlagsFromArgv(argv: string[] = process.argv): void {
  const rawArgs = argv.slice(2);
  const hasDebug = rawArgs.includes('--debug') || rawArgs.includes('--debug-console');
  const hasDebugConsole = rawArgs.includes('--debug') || rawArgs.includes('--debug-console');

  if (hasDebug) {
    process.env.CLI_DEBUG = '1';
  }
  if (hasDebugConsole) {
    process.env.CLI_DEBUG_CONSOLE = '1';
  }
}

const originalConsole = {
  log: console.log.bind(console),
  error: console.error.bind(console),
  warn: console.warn.bind(console),
};

let inkConsolePatched = false;

function formatConsoleArgs(args: unknown[]): string {
  return args.map((arg) => {
    if (typeof arg === 'string') return arg;
    if (arg === null || typeof arg !== 'object') {
      if (typeof arg === 'bigint') {
        return arg.toString();
      }
      return String(arg);
    }
    const seen = new WeakSet<object>();
    try {
      return JSON.stringify(arg, (_key, value) => {
        if (typeof value === 'bigint') {
          return value.toString();
        }
        if (value instanceof Error) {
          return {
            name: value.name,
            message: value.message,
            stack: value.stack,
          };
        }
        if (typeof value === 'function') {
          return '[Function]';
        }
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) {
            return '[Circular]';
          }
          seen.add(value);
        }
        return value;
      });
    } catch {
      try {
        return String(arg);
      } catch {
        return '[Unserializable]';
      }
    }
  }).join(' ');
}

export function setInkConsolePatch(enabled: boolean): void {
  if (process.env.CLI_DEBUG === '1') {
    return;
  }
  if (enabled) {
    if (inkConsolePatched) {
      return;
    }
    console.log = (...args: unknown[]) => {
      const message = formatConsoleArgs(args);
      cliLogger.info('CONSOLE', message);
    };
    console.error = (...args: unknown[]) => {
      const message = formatConsoleArgs(args);
      cliLogger.error('CONSOLE', message);
    };
    console.warn = (...args: unknown[]) => {
      const message = formatConsoleArgs(args);
      cliLogger.warn('CONSOLE', message);
    };
    inkConsolePatched = true;
    return;
  }
  if (!inkConsolePatched) {
    return;
  }
  console.log = originalConsole.log;
  console.error = originalConsole.error;
  console.warn = originalConsole.warn;
  inkConsolePatched = false;
}

export function installDebugConsoleInterceptor(): void {
  if (process.env.CLI_DEBUG !== '1') {
    return;
  }
  console.log = (...args: unknown[]) => {
    const message = formatConsoleArgs(args);
    cliLogger.debug('CONSOLE', message);
  };
  console.error = (...args: unknown[]) => {
    const message = formatConsoleArgs(args);
    cliLogger.error('CONSOLE', message);
  };
  console.warn = (...args: unknown[]) => {
    const message = formatConsoleArgs(args);
    cliLogger.warn('CONSOLE', message);
  };
}
