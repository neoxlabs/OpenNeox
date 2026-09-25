/**
 * Node platform service implementation.
 */

import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { getShellEnv, preloadShellEnv } from './shellEnv.js';
import { processManager } from './processManager.js';
import type { PlatformServices } from './services.js';
import { nodeToolCapabilities } from './toolCapabilities.js';
import { tokenUsageService } from './tokenUsageService.js';

export function createNodeServices(): PlatformServices {
  return {
    logger: cliLogger,
    shellEnv: {
      preloadShellEnv,
      getShellEnv,
    },
    processManager,
    capabilities: nodeToolCapabilities,
    tokenUsage: tokenUsageService,
  };
}
