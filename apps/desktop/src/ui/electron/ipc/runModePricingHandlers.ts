import { ipcMain } from './ipcMainBridged.js';
import { configService } from '@neoxlabs/platform/platform/configService.js';
import type { ProjectManager } from '../context/ProjectManager.js';
import { AGENT_BRIDGE } from '../context/tokens.js';
import { normalizeRunMode } from '@neoxlabs/core/runtime/modeFactory.js';

interface RegisterRunModePricingIpcHandlersOptions {
  projectManager: ProjectManager;
}

export function registerRunModePricingIpcHandlers(
  options: RegisterRunModePricingIpcHandlersOptions,
): void {
  const { projectManager } = options;

  ipcMain.handle('pricing:get-all', () => {
    return configService.getModelPricing();
  });

  ipcMain.handle('pricing:set-all', (_event, pricing: Array<{ pattern: string; inputPrice: number; outputPrice: number; cachedInputPrice?: number; currency?: string }>) => {
    configService.setModelPricing(pricing);
  });

  ipcMain.handle('pricing:upsert', (_event, pricing: { pattern: string; inputPrice: number; outputPrice: number; cachedInputPrice?: number; currency?: string }) => {
    configService.upsertModelPricing(pricing);
  });

  ipcMain.handle('pricing:delete', (_event, pattern: string) => {
    configService.deleteModelPricing(pattern);
  });

  ipcMain.handle('config:get-run-mode', () => {
    const mode = normalizeRunMode(configService.getRunMode());
    return mode;
  });

  ipcMain.handle('config:set-run-mode', (_event, mode: 'agentic') => {
    const normalizedMode = normalizeRunMode(mode);
    configService.setRunMode(normalizedMode);
    // Broadcast 到所有打开的 project bridge —— run mode 是全局设置
    for (const scope of projectManager.listAll()) {
      scope.peekService(AGENT_BRIDGE)?.onRunModeChanged(normalizedMode);
    }
  });
}
