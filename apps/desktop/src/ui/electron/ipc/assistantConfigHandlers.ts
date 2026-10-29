import { ipcMain } from './ipcMainBridged.js';
import { configService } from '@neoxlabs/platform/platform/configService.js';

export function registerAssistantConfigIpcHandlers(): void {
  ipcMain.handle('config:get-assistant-config', () => {
    return configService.getAssistantConfig();
  });

  ipcMain.handle('config:set-assistant-config', (_event, updates: Parameters<typeof configService.setAssistantConfig>[0]) => {
    configService.setAssistantConfig(updates);
  });

  ipcMain.handle('config:get-main-agent', () => {
    return configService.getMainAgent();
  });

  ipcMain.handle('config:set-main-agent', (_event, agent: Parameters<typeof configService.setMainAgent>[0]) => {
    configService.setMainAgent(agent);
  });

  ipcMain.handle('config:get-worker-pool', () => {
    return configService.getWorkerPool();
  });

  ipcMain.handle('config:set-worker-pool', (_event, pool: Parameters<typeof configService.setWorkerPool>[0]) => {
    configService.setWorkerPool(pool);
  });

  ipcMain.handle('config:add-worker-to-pool', (_event, worker: Parameters<typeof configService.addWorkerToPool>[0]) => {
    configService.addWorkerToPool(worker);
  });

  ipcMain.handle('config:remove-worker-from-pool', (_event, providerId: string, model: string) => {
    configService.removeWorkerFromPool(providerId, model);
  });
}
