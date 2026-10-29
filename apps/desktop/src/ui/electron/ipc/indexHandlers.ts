import { ipcMain } from './ipcMainBridged.js';
import { loadConfig, saveConfig } from '@neoxlabs/platform/utils/config.js';
import type { ProjectManager } from '../context/ProjectManager.js';
import { makeOptionalBridgeResolver } from './scopeResolvers.js';

interface RegisterIndexIpcHandlersOptions {
  projectManager: ProjectManager;
}

/**
 * Index (符号/代码索引) 是 per-project 状态. client 通过 sender 窗口反查的
 * AgentBridge 拿到; 没 project 打开时返回空.
 */
export function registerIndexIpcHandlers(options: RegisterIndexIpcHandlersOptions): void {
  const bridgeOf = makeOptionalBridgeResolver(options.projectManager);

  ipcMain.handle('index:get-stats', async (event) => {
    const client = await bridgeOf(event)?.getClientAsync();
    if (!client) return { hasIndex: false, fileCount: 0, symbolCount: 0, lastUpdated: null, size: 0 };
    try { return await client.getIndexStats(); } catch { return { hasIndex: false, fileCount: 0, symbolCount: 0, lastUpdated: null, size: 0 }; }
  });

  ipcMain.handle('index:build', async (event, force?: boolean) => {
    const client = await bridgeOf(event)?.getClientAsync();
    if (!client) return { success: false, filesIndexed: 0, symbolsFound: 0, timeMs: 0, errors: [] };
    try { return await client.buildIndex(force); }
    catch (e: any) { return { success: false, filesIndexed: 0, symbolsFound: 0, timeMs: 0, errors: [{ file: '', error: e.message }] }; }
  });

  ipcMain.handle('index:clear', async (event) => {
    const client = await bridgeOf(event)?.getClientAsync();
    if (!client) return { success: false };
    try { await client.clearIndex(); return { success: true }; }
    catch (e: any) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('index:search', async (event, query: string, kind?: string, limit?: number) => {
    const client = await bridgeOf(event)?.getClientAsync();
    if (!client) return [];
    try { return await client.searchIndex(query, kind, limit); } catch { return []; }
  });

  ipcMain.handle('index:get-config', async () => {
    const config = loadConfig();
    return {
      excludePatterns: config.indexing?.excludePatterns || [
        'node_modules/**', '.git/**', 'dist/**', 'build/**', '*.min.js',
      ],
      autoIndex: config.indexing?.autoIndex ?? false,
      maxFileSize: config.indexing?.maxFileSize ?? 1024 * 1024,
    };
  });

  ipcMain.handle('index:set-config', async (_event, updates: {
    excludePatterns?: string[];
    autoIndex?: boolean;
    maxFileSize?: number;
  }) => {
    const config = loadConfig();
    if (!config.indexing) {
      config.indexing = {};
    }
    if (updates.excludePatterns !== undefined) {
      config.indexing.excludePatterns = updates.excludePatterns;
    }
    if (updates.autoIndex !== undefined) {
      config.indexing.autoIndex = updates.autoIndex;
    }
    if (updates.maxFileSize !== undefined) {
      config.indexing.maxFileSize = updates.maxFileSize;
    }
    saveConfig(config);
    return { success: true };
  });
}
