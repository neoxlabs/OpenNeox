/**
 * Embedding IPC Handlers — codebase index + semantic search
 *
 * Per-project 隔离：EmbeddingBridge 挂在 ProjectScope 上，跟 SemanticBridge
 * 一样按 sender 反查，避免不同 workspace 间串状态。
 */

import { ipcMain } from './ipcMainBridged.js';
/* 类型是纯类型导入, 编译后完全擦除 —— 不会在运行时把 electron 拉进来。
 * 值 (ipcMain) 走桥的替身, 于是这个文件在纯 Node 后端里也 import 得动。 */
import type { IpcMainInvokeEvent } from 'electron';
import { EMBEDDING_BRIDGE } from '../context/tokens.js';
import type { ProjectManager } from '../context/ProjectManager.js';
import type { EmbeddingBridge } from '../services/embeddingBridge.js';

export interface RegisterEmbeddingIpcHandlersOptions {
  projectManager: ProjectManager;
}

const progressBindings = new Map<string, (data: unknown) => void>();

export function registerEmbeddingIpcHandlers(options: RegisterEmbeddingIpcHandlersOptions): void {
  const { projectManager } = options;

  const bridgeOf = (event: IpcMainInvokeEvent): EmbeddingBridge | null => {
    const scope = projectManager.getBySender(event?.sender as any);
    return scope?.tryGetService(EMBEDDING_BRIDGE) ?? null;
  };

  const peekBridgeOf = (event: IpcMainInvokeEvent): EmbeddingBridge | null => {
    const scope = projectManager.getBySender(event?.sender as any);
    return scope?.peekService(EMBEDDING_BRIDGE) ?? null;
  };

  async function ensureBridge(event: IpcMainInvokeEvent, startBackground = true): Promise<EmbeddingBridge | null> {
    const scope = projectManager.getBySender(event?.sender as any);
    const bridge = scope?.tryGetService(EMBEDDING_BRIDGE) ?? null;
    if (!scope || !bridge) return null;
    await bridge.setWorkspace(scope.workspacePath, { startBackground });
    return bridge;
  }

  function bindProgress(event: IpcMainInvokeEvent, bridge: EmbeddingBridge): void {
    const scope = projectManager.getBySender(event?.sender as any);
    const workspacePath = scope?.workspacePath ?? '__unknown__';
    const key = `${workspacePath}:${event?.sender.id}`;
    const previous = progressBindings.get(key);
    if (previous) {
      bridge.off('progress', previous);
    }

    const listener = (data: unknown) => {
      try {
        if (!event?.sender.isDestroyed()) {
          event?.sender.send('embedding:progress', data);
        }
      } catch {
        // closed
      }
    };

    progressBindings.set(key, listener);
    bridge.on('progress', listener);
    event?.sender.once('destroyed', () => {
      const current = progressBindings.get(key);
      if (current === listener) {
        bridge.off('progress', listener);
        progressBindings.delete(key);
      }
    });
  }

  ipcMain.handle(
    'embedding:init',
    async (event: IpcMainInvokeEvent, _cwd: string): Promise<void> => {
      const scope = projectManager.getBySender(event?.sender as any);
      const bridge = scope?.tryGetService(EMBEDDING_BRIDGE) ?? null;
      if (!scope || !bridge) return;
      bindProgress(event, bridge);
      void bridge.setWorkspace(scope.workspacePath).catch(() => {});
    },
  );

  ipcMain.handle(
    'embedding:build',
    async (event: IpcMainInvokeEvent, _cwd: string, force?: boolean): Promise<{
      success: boolean; filesIndexed: number; chunksCreated: number; timeMs: number;
    }> => {
      const bridge = await ensureBridge(event, false);
      if (!bridge) return { success: false, filesIndexed: 0, chunksCreated: 0, timeMs: 0 };
      bindProgress(event, bridge);
      try {
        const result = await bridge.buildIndex(force ?? false);
        return { success: true, ...result };
      } catch {
        return { success: false, filesIndexed: 0, chunksCreated: 0, timeMs: 0 };
      }
    },
  );

  ipcMain.handle(
    'embedding:status',
    async (event: IpcMainInvokeEvent, _cwd: string): Promise<{
      ready: boolean; fileCount: number; chunkCount: number;
      lastBuilt: number | null; indexing: boolean;
    }> => {
      const bridge = peekBridgeOf(event);
      return bridge?.getStatus() ?? {
        ready: false, fileCount: 0, chunkCount: 0, lastBuilt: null, indexing: false,
      };
    },
  );

  ipcMain.handle(
    'embedding:search',
    async (event: IpcMainInvokeEvent, _cwd: string, query: string, topK?: number): Promise<{
      chunks: Array<{
        file: string; startLine: number; endLine: number; content: string; score: number;
        relatedSymbols?: Array<{
          name: string; kind: string; startLine: number; endLine: number; signature?: string; containerName?: string;
        }>;
      }>;
    }> => {
      const bridge = await ensureBridge(event);
      const chunks = bridge ? await bridge.search(query, topK ?? 5) : [];
      return { chunks };
    },
  );

  ipcMain.handle(
    'embedding:clear',
    async (event: IpcMainInvokeEvent, _cwd: string): Promise<{ success: boolean }> => {
      const bridge = await ensureBridge(event, false);
      if (!bridge) return { success: false };
      try {
        bridge.clear();
        return { success: true };
      } catch {
        return { success: false };
      }
    },
  );
}
