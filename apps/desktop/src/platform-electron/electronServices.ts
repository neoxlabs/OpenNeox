/**
 * Electron platform services.
 *
 * Currently identical to Node services; split kept for future UI-specific overrides.
 */

import { createNodeServices } from '@neoxlabs/platform/platform/nodeServices.js';
import type { PlatformServices } from '@neoxlabs/platform/platform/services.js';
import { electronToolCapabilities } from '@neoxlabs/platform/platform/toolCapabilities.js';

export function createElectronServices(): PlatformServices {
  const base = createNodeServices();
  return {
    ...base,
    capabilities: electronToolCapabilities,
  };
}
