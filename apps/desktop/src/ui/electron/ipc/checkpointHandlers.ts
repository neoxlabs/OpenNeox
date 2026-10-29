import { ipcMain } from './ipcMainBridged.js';
import type { ProjectManager } from '../context/ProjectManager.js';
import { makeBridgeResolver } from './scopeResolvers.js';

interface RegisterCheckpointIpcHandlersOptions {
  projectManager: ProjectManager;
}

/**
 * File checkpoint 状态绑定到 workspace (watching 某个目录的文件变化), 天然 per-project.
 * 多项目并行时每个 project 自己的 AgentBridge 管自己的 checkpoint 状态机.
 */
export function registerCheckpointIpcHandlers(options: RegisterCheckpointIpcHandlersOptions): void {
  const bridgeOf = makeBridgeResolver(options.projectManager);

  ipcMain.handle('checkpoint:start-watching', async (event, sessionId: string) => {
    try {
      const beforeCheckpointId = await bridgeOf(event).startCheckpointWatching(sessionId);
      return { success: true, beforeCheckpointId };
    } catch (error) {
      console.error('[Main] Failed to start checkpoint watching:', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('checkpoint:stop-watching', async (event) => {
    try {
      await bridgeOf(event).stopCheckpointWatching();
      return { success: true };
    } catch (error) {
      console.error('[Main] Failed to stop checkpoint watching:', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('checkpoint:create', async (event, sessionId: string, label?: string) => {
    try {
      const checkpoint = await bridgeOf(event).createCheckpoint(sessionId, label);
      return { success: true, checkpoint };
    } catch (error) {
      console.error('[Main] Failed to create checkpoint:', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('checkpoint:rollback', async (event, checkpointId: string) => {
    try {
      return await bridgeOf(event).rollbackToCheckpoint(checkpointId);
    } catch (error) {
      console.error('[Main] Failed to rollback checkpoint:', error);
      return { success: false, restored: [], errors: [String(error)] };
    }
  });

  ipcMain.handle('checkpoint:list', async (event, limit?: number, sessionId?: string) => {
    try {
      const checkpoints = await bridgeOf(event).getCheckpoints(limit, sessionId);
      return { success: true, checkpoints };
    } catch (error) {
      console.error('[Main] Failed to get checkpoints:', error);
      return { success: false, checkpoints: [], error: String(error) };
    }
  });

  ipcMain.handle('checkpoint:get-stats', async (event) => {
    try {
      const stats = await bridgeOf(event).getCurrentChangeStats();
      return { success: true, stats };
    } catch (error) {
      console.error('[Main] Failed to get change stats:', error);
      return { success: false, stats: { created: 0, modified: 0, deleted: 0, directories: 0, total: 0 } };
    }
  });

  ipcMain.handle('checkpoint:get-changes', async (event) => {
    try {
      const bridge = bridgeOf(event);
      const changes = await bridge.getCurrentChanges();
      let afterCheckpointId: string | null = null;
      if (changes.length > 0) {
        try {
          const checkpoint = await bridge.createCheckpoint('', 'auto-after-changes');
          if (checkpoint?.id) {
            afterCheckpointId = checkpoint.id;
          }
        } catch {
          // ignore
        }
      }
      return { success: true, changes, afterCheckpointId };
    } catch (error) {
      console.error('[Main] Failed to get changes:', error);
      return { success: false, changes: [], afterCheckpointId: null };
    }
  });

  ipcMain.handle('checkpoint:set-enabled', async (event, enabled: boolean) => {
    bridgeOf(event).setCheckpointEnabled(enabled);
    return { success: true };
  });

  ipcMain.handle('checkpoint:is-enabled', async (event) => {
    return { enabled: await bridgeOf(event).isCheckpointEnabled() };
  });

  ipcMain.handle('checkpoint:cleanup', async (event) => {
    try {
      await bridgeOf(event).cleanupCheckpoints();
      return { success: true };
    } catch (error) {
      console.error('[Main] Failed to cleanup checkpoints:', error);
      return { success: false, error: String(error) };
    }
  });
}
