/**
 * semanticHandlers —— SemanticBridge / TsServerBridge ↔ renderer 的 IPC 桥.
 *
 * **Per-project 隔离**:
 * 每个 ProjectScope 拥有自己的 SemanticBridge 和 TsServerBridge 实例 (per-window).
 * 所有 handler 通过 `projectManager.getBySender(event?.sender as any)` 反查发起窗口的 scope,
 * 然后 `scope.getService(SEMANTIC_BRIDGE / TS_SERVER_BRIDGE)`. 多个 project 窗口
 * 各自有独立 index, 不再互相覆盖.
 *
 * 没 scope 时 (welcome page 没选 workspace) 直接返回空结果, 不抛错.
 */

import { ipcMain } from './ipcMainBridged.js';
/* 类型是纯类型导入, 编译后完全擦除 —— 不会在运行时把 electron 拉进来。
 * 值 (ipcMain) 走桥的替身, 于是这个文件在纯 Node 后端里也 import 得动。 */
import type { IpcMainInvokeEvent } from 'electron';
import { SEMANTIC_BRIDGE, TS_SERVER_BRIDGE } from '../context/tokens.js';
import type { ProjectManager } from '../context/ProjectManager.js';
import type { SemanticBridge } from '../services/semanticBridge.js';
import type { TsServerBridge } from '../services/tsServerBridge.js';

export interface RegisterSemanticIpcHandlersOptions {
  projectManager: ProjectManager;
}

export function registerSemanticIpcHandlers(options: RegisterSemanticIpcHandlersOptions): void {
  const { projectManager } = options;

  // 拿当前发起请求窗口的 SemanticBridge. 没 scope 时返回 null.
  const semanticOf = (event: IpcMainInvokeEvent): SemanticBridge | null => {
    const scope = projectManager.getBySender(event?.sender as any);
    return scope?.tryGetService(SEMANTIC_BRIDGE) ?? null;
  };
  const ensureSemanticBridge = async (event: IpcMainInvokeEvent): Promise<SemanticBridge | null> => {
    const scope = projectManager.getBySender(event?.sender as any);
    const bridge = scope?.tryGetService(SEMANTIC_BRIDGE) ?? null;
    if (!scope || !bridge) return null;
    await bridge.setWorkspace(scope.workspacePath, { startBackground: false });
    return bridge;
  };
  // 同上, TsServerBridge 版本
  const ensureTsServer = async (event: IpcMainInvokeEvent): Promise<TsServerBridge | null> => {
    const scope = projectManager.getBySender(event?.sender as any);
    const bridge = scope?.tryGetService(TS_SERVER_BRIDGE) ?? null;
    if (!scope || !bridge) return null;
    await bridge.start(scope.workspacePath);
    return bridge;
  };

  // --------------------------------------------------------------------------
  // Lifecycle / status
  // --------------------------------------------------------------------------

  ipcMain.handle('semantic:progress', async (event) => {
    const sb = semanticOf(event);
    if (!sb) return { success: true, progress: { state: 'idle', filesIndexed: 0, filesTotal: 0, symbolsTotal: 0 } };
    return { success: true, progress: sb.getProgress() };
  });

  ipcMain.handle('semantic:is-ready', async (event) => {
    const sb = semanticOf(event);
    return { success: true, ready: sb?.isReady() ?? false };
  });

  ipcMain.handle('semantic:init', async (event, _cwd?: string) => {
    const sb = await ensureSemanticBridge(event);
    if (!sb) return { success: false, started: false };
    void sb.startBootstrapIfNeeded('renderer-idle');
    return { success: true, started: true };
  });

  // --------------------------------------------------------------------------
  // Search
  // --------------------------------------------------------------------------

  ipcMain.handle(
    'semantic:search-files',
    async (event, query: string, limit?: number) => {
      try {
        const sb = semanticOf(event);
        const items = sb ? sb.searchFiles(query, limit) : [];
        return { success: true, items };
      } catch (error: any) {
        return { success: false, error: error.message, items: [] };
      }
    },
  );

  ipcMain.handle(
    'semantic:search-symbols',
    async (event, query: string, limit?: number) => {
      try {
        const sb = semanticOf(event);
        const items = sb ? sb.searchSymbols(query, limit) : [];
        return { success: true, items };
      } catch (error: any) {
        return { success: false, error: error.message, items: [] };
      }
    },
  );

  ipcMain.handle(
    'semantic:search-palette',
    async (event, query: string, limit?: number) => {
      try {
        const sb = semanticOf(event);
        const items = sb ? sb.searchPalette(query, limit) : [];
        return { success: true, items };
      } catch (error: any) {
        return { success: false, error: error.message, items: [] };
      }
    },
  );

  // --------------------------------------------------------------------------
  // Symbol queries
  // --------------------------------------------------------------------------

  ipcMain.handle(
    'semantic:file-outline',
    async (event, filePath: string) => {
      try {
        const sb = semanticOf(event);
        const symbols = sb ? sb.getFileOutline(filePath) : [];
        return { success: true, symbols };
      } catch (error: any) {
        return { success: false, error: error.message, symbols: [] };
      }
    },
  );

  ipcMain.handle(
    'semantic:get-symbol',
    async (event, symbolId: number) => {
      try {
        const sb = semanticOf(event);
        const symbol = sb ? sb.getSymbolById(symbolId) : null;
        return { success: true, symbol };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    },
  );

  ipcMain.handle(
    'semantic:find-symbols-by-name',
    async (event, name: string, limit?: number) => {
      try {
        const sb = semanticOf(event);
        const symbols = sb ? sb.findSymbolsByName(name, limit) : [];
        return { success: true, symbols };
      } catch (error: any) {
        return { success: false, error: error.message, symbols: [] };
      }
    },
  );

  // --------------------------------------------------------------------------
  // Find Usages
  // --------------------------------------------------------------------------

  ipcMain.handle(
    'semantic:find-usages',
    async (
      event,
      name: string,
      options?: { includeDeclarations?: boolean; limit?: number },
    ) => {
      try {
        const sb = semanticOf(event);
        const usages = sb ? sb.findUsagesByName(name, options) : [];
        return { success: true, usages };
      } catch (error: any) {
        return { success: false, error: error.message, usages: [] };
      }
    },
  );

  // --------------------------------------------------------------------------
  // Rename
  // --------------------------------------------------------------------------

  ipcMain.handle(
    'semantic:rename-edits',
    async (event, oldName: string, newName: string) => {
      try {
        const sb = semanticOf(event);
        const edits = sb ? sb.getRenameEdits(oldName, newName) : [];
        return { success: true, edits };
      } catch (error: any) {
        return { success: false, error: error.message, edits: [] };
      }
    },
  );

  // --------------------------------------------------------------------------
  // TypeScript Language Server (真实语义引用)
  // --------------------------------------------------------------------------

  ipcMain.handle(
    'tsserver:references',
    async (event, filePath: string, line: number, offset: number) => {
      try {
        const ts = await ensureTsServer(event);
        const refs = ts ? await ts.findReferences(filePath, line, offset) : [];
        return { success: true, refs };
      } catch (error: any) {
        return { success: false, error: error.message, refs: [] };
      }
    },
  );

  ipcMain.handle(
    'tsserver:definition',
    async (event, filePath: string, line: number, offset: number) => {
      try {
        const ts = await ensureTsServer(event);
        const defs = ts ? await ts.findDefinition(filePath, line, offset) : [];
        return { success: true, defs };
      } catch (error: any) {
        return { success: false, error: error.message, defs: [] };
      }
    },
  );

  ipcMain.handle(
    'tsserver:quickinfo',
    async (event, filePath: string, line: number, offset: number) => {
      try {
        const ts = await ensureTsServer(event);
        const info = ts ? await ts.quickInfo(filePath, line, offset) : null;
        return { success: true, info };
      } catch (error: any) {
        return { success: false, error: error.message, info: null };
      }
    },
  );

  // --------------------------------------------------------------------------
  // Debug / introspection
  // --------------------------------------------------------------------------

  ipcMain.handle('semantic:list-indexed-files', async (event) => {
    try {
      const sb = semanticOf(event);
      const files = sb ? sb.listIndexedFiles() : [];
      return { success: true, files };
    } catch (error: any) {
      return { success: false, error: error.message, files: [] };
    }
  });
}
