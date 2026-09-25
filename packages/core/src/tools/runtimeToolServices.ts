import { createNodeServices } from '@neoxlabs/platform/platform/nodeServices.js';
import type { PlatformLogger, PlatformServices } from '@neoxlabs/platform/platform/services.js';

const defaultServices = createNodeServices();
let toolServices: PlatformServices = defaultServices;
let toolLogger: PlatformLogger = toolServices.logger;

export function setToolServices(services: PlatformServices): void {
  toolServices = services;
  toolLogger = services.logger;
}

export function getToolServices(): PlatformServices {
  return toolServices;
}

export function getToolLogger(): PlatformLogger {
  return toolLogger;
}

export async function preloadShellEnv(services?: PlatformServices): Promise<void> {
  const target = services ?? toolServices;
  await target.shellEnv.preloadShellEnv();
}
