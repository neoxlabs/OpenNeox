import { startEventLoopWatchdog } from './eventLoopWatchdog.js';
import { registerSigintFallbackHandler } from './sigintHandler.js';
import { registerSigtermCleanupHandler } from './sigtermHandler.js';
import {
  registerExitRawModeCleanupHandler,
  registerSigcontRecoveryHandler,
  registerTtySuspensionMonitoringHandlers,
} from './ttySignalFallback.js';

interface CliSigintFallbackHandler {
  handleSigintFallback(): void;
}

interface RegisterCliFallbackHandlersOptions {
  isInkUIActive: () => boolean;
  getActiveCliInstance: () => CliSigintFallbackHandler | null;
}

export function registerCliFallbackHandlers(options: RegisterCliFallbackHandlersOptions): void {
  registerSigintFallbackHandler(options);
  startEventLoopWatchdog();
  registerSigtermCleanupHandler();
  registerTtySuspensionMonitoringHandlers();
  registerSigcontRecoveryHandler();
  registerExitRawModeCleanupHandler();
}
