import { processManager } from '@neoxlabs/platform/platform/processManager.js';

interface CliSigintFallbackHandler {
  handleSigintFallback(): void;
}

interface RegisterSigintFallbackHandlerOptions {
  isInkUIActive: () => boolean;
  getActiveCliInstance: () => CliSigintFallbackHandler | null;
}

export function registerSigintFallbackHandler(options: RegisterSigintFallbackHandlerOptions): void {
  const { isInkUIActive, getActiveCliInstance } = options;

  process.on('SIGINT', () => {
    const bgCount = processManager.getBackgroundRunning().length;
    if (bgCount > 0) {
      processManager.killAll(true);
    }

    const activeCliInstance = getActiveCliInstance();
    if (isInkUIActive() && activeCliInstance) {
      activeCliInstance.handleSigintFallback();
      return;
    }

    if (!isInkUIActive()) {
      process.exit(130);
    }
  });
}
