import { ipcMain } from './ipcMainBridged.js';
import type { ProjectManager } from '../context/ProjectManager.js';
import { AGENT_BRIDGE } from '../context/tokens.js';

interface RegisterServerStatusIpcHandlersOptions {
  projectManager: ProjectManager;
}

export function registerServerStatusIpcHandlers(options: RegisterServerStatusIpcHandlersOptions): void {
  ipcMain.handle('server:get-status', async (event) => {
    try {
      const scope = options.projectManager.getBySender(event?.sender as any);
      const bridge = scope?.peekService(AGENT_BRIDGE);
      if (!bridge) return { activeSessions: [] };
      const client = await bridge.getClientAsync();
      if (!client) return { activeSessions: [] };
      return await client.getStatus();
    } catch {
      return { activeSessions: [] };
    }
  });
}
