import { ipcMain } from './ipcMainBridged.js';
import { configService } from '@neoxlabs/platform/platform/configService.js';

export function registerRoutingIpcHandlers(): void {
  ipcMain.handle('routing:get-enabled', () => {
    return configService.getModelRoutingEnabled();
  });

  ipcMain.handle('routing:set-enabled', (_event, enabled: boolean) => {
    configService.setModelRoutingEnabled(enabled);
  });

  ipcMain.handle('routing:get-config', () => {
    return configService.getModelRoutingConfig();
  });

  ipcMain.handle('routing:get-routes', () => {
    return configService.getModelRoutes();
  });

  ipcMain.handle('routing:get-route', (_event, modelAlias: string) => {
    return configService.getModelRoute(modelAlias);
  });

  ipcMain.handle('routing:set-route', (_event, modelAlias: string, route: any) => {
    configService.setModelRoute(modelAlias, route);
  });

  ipcMain.handle('routing:delete-route', (_event, modelAlias: string) => {
    return configService.deleteModelRoute(modelAlias);
  });

  ipcMain.handle('routing:auto-detect', (_event, modelName: string) => {
    return configService.autoDetectModelRoutes(modelName);
  });

  ipcMain.handle('routing:get-auto-models', () => {
    return configService.getAutoRoutedModels();
  });
}
