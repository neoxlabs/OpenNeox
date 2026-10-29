import { ipcMain } from './ipcMainBridged.js';
import { loadConfig, saveConfig } from '@neoxlabs/platform/utils/config.js';
import { listOutputStyles } from '@neoxlabs/core';
import type { ProjectManager } from '../context/ProjectManager.js';
import { makeWorkspaceResolver } from './scopeResolvers.js';

export function registerOutputStyleIpcHandlers(options: { projectManager: ProjectManager }): void {
  const workspaceOf = makeWorkspaceResolver(options.projectManager);

  ipcMain.handle('output-style:list', async (event) => ({
    styles: listOutputStyles(workspaceOf(event)),
    current: loadConfig().outputStyle || 'standard',
  }));

  ipcMain.handle('output-style:set', async (_event, id: unknown) => {
    if (typeof id !== 'string' || !id.trim()) return { success: false, error: 'bad style id' };
    try {
      const config = loadConfig();
      saveConfig({ ...config, outputStyle: id === 'standard' ? undefined : id });
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error?.message ?? String(error) };
    }
  });
}
