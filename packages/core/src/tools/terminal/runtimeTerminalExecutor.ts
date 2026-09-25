import type { PlatformLogger } from '@neoxlabs/platform/platform/services.js';
import { getTerminalExecutor as getTerminalExecutorFromRegistry, setTerminalExecutor as setTerminalExecutorToRegistry } from './executorRegistry.js';
import type { TerminalExecutor } from './executorRegistry.js';

export function setRuntimeTerminalExecutor(executor: TerminalExecutor | null, logger: PlatformLogger): void {
  setTerminalExecutorToRegistry(executor);
  if (executor) {
    logger.info('TOOLS', 'Terminal executor registered');
  } else {
    logger.info('TOOLS', 'Terminal executor unregistered');
  }
}

export function getRuntimeTerminalExecutor(): TerminalExecutor | null {
  return getTerminalExecutorFromRegistry();
}

export function createRuntimeTerminalExecutorBridge(getLogger: () => PlatformLogger): {
  getTerminalExecutor: () => TerminalExecutor | null;
  setTerminalExecutor: (executor: TerminalExecutor | null) => void;
} {
  return {
    getTerminalExecutor: getRuntimeTerminalExecutor,
    setTerminalExecutor: (executor: TerminalExecutor | null) => {
      setRuntimeTerminalExecutor(executor, getLogger());
    },
  };
}
