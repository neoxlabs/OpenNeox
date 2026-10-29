import { ipcMain } from './ipcMainBridged.js';
import { loadConfig, saveConfig } from '@neoxlabs/platform/utils/config.js';
import type { ProjectManager } from '../context/ProjectManager.js';
import { makeOptionalBridgeResolver } from './scopeResolvers.js';
import type { IpcMainInvokeEvent } from 'electron';
import { discoverExternalMemories, importExternalMemories } from '@neoxlabs/core/migrate/index.js';

interface RegisterMemoryIpcHandlersOptions {
  projectManager: ProjectManager;
}

function emptyMemoryStats() {
  return {
    shortTerm: { count: 0, sizeBytes: 0 },
    session: { count: 0, sizeBytes: 0 },
    longTerm: {
      total: { count: 0, sizeBytes: 0 },
      progress: { count: 0, sizeBytes: 0 },
      standard: { count: 0, sizeBytes: 0 },
      lesson: { count: 0, sizeBytes: 0 },
    },
    pinned: { count: 0, sizeBytes: 0 },
    totals: { count: 0, sizeBytes: 0 },
  };
}

export function registerMemoryIpcHandlers(options: RegisterMemoryIpcHandlersOptions): void {
  const bridgeOf = makeOptionalBridgeResolver(options.projectManager);

  ipcMain.handle('memory:get-stats', async (event) => {
    try {
      const actionLog = bridgeOf(event)?.getActionLog();
      if (!actionLog) {
        return emptyMemoryStats();
      }
      return await actionLog.getMemoryStats();
    } catch (error: any) {
      console.error('Failed to get memory stats:', error);
      return emptyMemoryStats();
    }
  });

  ipcMain.handle('memory:get-config', async () => {
    const config = loadConfig();
    return {
      autoMemoryEnabled: config.memory?.autoMemoryEnabled !== false,
    };
  });

  ipcMain.handle('memory:set-config', async (_event, updates: { autoMemoryEnabled?: boolean }) => {
    const config = loadConfig();
    const memory = { ...(config.memory ?? {}) };
    if (typeof updates.autoMemoryEnabled === 'boolean') {
      memory.autoMemoryEnabled = updates.autoMemoryEnabled;
    }
    saveConfig({ ...config, memory });
  });

  ipcMain.handle('memory:get-injection-preview', async (event) => {
    try {
      const actionLog = bridgeOf(event)?.getActionLog();
      if (!actionLog) return null;
      const config = loadConfig();
      return await actionLog.getMemoryInjectionSummary({
        language: config.language ?? 'zh',
        includePersistent: true,
        includeLastRun: true,
      });
    } catch (error: any) {
      console.error('Failed to get memory injection preview:', error);
      return null;
    }
  });

  ipcMain.handle('memory:browse', async (event, options: {
    type?: 'all' | 'shortTerm' | 'session' | 'longTerm' | 'pinned';
    query?: string;
    limit?: number;
  }) => {
    try {
      const actionLog = bridgeOf(event)?.getActionLog();
      if (!actionLog) return [];
      return await actionLog.getMemoryEntries({
        type: options.type,
        query: options.query,
        limit: options.limit,
      });
    } catch (error: any) {
      console.error('Failed to browse memory:', error);
      return [];
    }
  });

  const scanExternal = async (event: IpcMainInvokeEvent) => {
    const bridge = bridgeOf(event);
    const actionLog = bridge?.getActionLog();
    if (!actionLog) return null;
    const existing = await actionLog.getMemoryEntries({ type: 'all', limit: 10_000 });
    return {
      actionLog,
      candidates: discoverExternalMemories({
        workDir: bridge?.getWorkspacePath() ?? undefined,
        existing: existing.map((e) => e.content),
      }),
    };
  };

  ipcMain.handle('memory:discover-external', async (event) => {
    try {
      return (await scanExternal(event))?.candidates ?? [];
    } catch (error: any) {
      console.error('Failed to discover external memories:', error);
      return [];
    }
  });

  ipcMain.handle('memory:import-external', async (event, keys: string[]) => {
    try {
      const scan = await scanExternal(event);
      if (!scan) return { success: false, imported: 0, error: 'No active session' };
      const want = new Set(Array.isArray(keys) ? keys : []);
      const imported = importExternalMemories(scan.actionLog, scan.candidates.filter((c) => want.has(c.key)));
      await scan.actionLog.flush();
      return { success: true, imported };
    } catch (error: any) {
      console.error('Failed to import external memories:', error);
      return { success: false, imported: 0, error: error?.message ?? String(error) };
    }
  });

  /* 删一条 (设置页每条记忆上的 ×) —— 记错的要能单独删, 不必全清 */
  ipcMain.handle('memory:delete', async (event, id: string) => {
    try {
      const actionLog = bridgeOf(event)?.getActionLog();
      if (!actionLog || typeof id !== 'string' || !id) return { success: false, error: 'No active session' };
      const ok = await actionLog.deleteMemoryEntry(id);
      return ok ? { success: true } : { success: false, error: 'Not found' };
    } catch (error: any) {
      console.error('Failed to delete memory entry:', error);
      return { success: false, error: error?.message ?? String(error) };
    }
  });

  ipcMain.handle('memory:clear', async (event, type?: 'shortTerm' | 'session' | 'longTerm' | 'all') => {
    try {
      const actionLog = bridgeOf(event)?.getActionLog();
      if (!actionLog) return { success: false, error: 'No active session' };

      const effectiveType = type || 'all';
      const results: string[] = [];
      const errors: string[] = [];

      // Clear long-term memory items stored in actionLog files
      if (effectiveType === 'longTerm' || effectiveType === 'all') {
        const clearResult = await actionLog.clearMemoryItems();
        results.push(...clearResult.cleared.map(c => `longTerm/${c}`));
        errors.push(...clearResult.errors);
      }

      if (effectiveType === 'shortTerm' || effectiveType === 'session' || effectiveType === 'all') {
        const kind = effectiveType === 'all' ? 'both' : effectiveType;
        const volatileResult = await actionLog.clearVolatileSummaries(kind);
        results.push(...volatileResult.cleared);
        errors.push(...volatileResult.errors);
      }

      if (errors.length > 0) {
        return { success: false, error: `Partial clear. Errors: ${errors.join('; ')}` };
      }

      return { success: true, message: `Cleared: ${results.join(', ')}` };
    } catch (error: any) {
      console.error('Failed to clear memory:', error);
      return { success: false, error: error.message };
    }
  });
}
