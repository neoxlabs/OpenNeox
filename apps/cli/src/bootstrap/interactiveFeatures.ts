import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { startEventLoopMonitoring } from '../utils/eventLoopMonitor.js';

interface InteractiveFeaturesConfig {
  debug?: boolean;
  eventLoopMonitoring?: boolean;
  useInputWorker?: boolean;
}

export function setupInteractiveFeatures(config: InteractiveFeaturesConfig): void {
  if (config.debug) {
    cliLogger.info('CLI', 'Experimental features', config);
  }

  if (config.eventLoopMonitoring) {
    const eventLoopMonitor = startEventLoopMonitoring({
      checkInterval: 1000,
      warnThreshold: 5000,
      criticalThreshold: 10000,
      autoRecover: true,
    });

    eventLoopMonitor.onRecovery((stats) => {
      cliLogger.error('CLI', '🚨 Event loop critical delay detected, attempting recovery', { stats });
    });

    cliLogger.info('CLI', '✓ Event Loop monitoring enabled');
  }

  if (config.useInputWorker) {
    cliLogger.debug('CLI', 'InputWorker skipped in Ink UI mode (Ink has own stdin handling)');
  }
}
