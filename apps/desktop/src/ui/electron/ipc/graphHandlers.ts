/**
 * Graph State IPC Handlers
 * 持久化 Worker/Team 编排状态到 SQLite (app_state KV 表)
 *
 * 替代之前的 IndexedDB graphStateDB，确保数据随 neox.db 一起持久化。
 * Key 格式: graph:{sessionId}
 */

import { ipcMain } from './ipcMainBridged.js';
import { getDatabase } from '@neoxlabs/platform/platform/database.js';

const GRAPH_KEY_PREFIX = 'graph:';

export function registerGraphIpcHandlers(): void {
  /**
   * 保存 graph 快照 (upsert)
   */
  ipcMain.handle(
    'graph:save-snapshot',
    async (_event, sessionId: string, workers: any[], teams: any[], communications?: any[]) => {
      if (!sessionId) return;
      if (workers.length === 0 && teams.length === 0) return;

      const db = getDatabase();
      const key = `${GRAPH_KEY_PREFIX}${sessionId}`;
      db.setAppState(key, {
        workers,
        teams,
        communications: (communications || []).slice(-100),
        savedAt: Date.now(),
      });
    },
  );

  /**
   * 读取 graph 快照
   */
  ipcMain.handle(
    'graph:load-snapshot',
    async (_event, sessionId: string) => {
      if (!sessionId) return null;

      const db = getDatabase();
      const key = `${GRAPH_KEY_PREFIX}${sessionId}`;
      const snapshot = db.getAppState<{
        workers: any[];
        teams: any[];
        communications?: any[];
        savedAt: number;
      }>(key);

      if (!snapshot) return null;

      return {
        workers: snapshot.workers || [],
        teams: snapshot.teams || [],
        communications: snapshot.communications || [],
      };
    },
  );

  /**
   * 删除 graph 快照
   */
  ipcMain.handle(
    'graph:delete-snapshot',
    async (_event, sessionId: string) => {
      if (!sessionId) return;
      const db = getDatabase();
      db.deleteAppState(`${GRAPH_KEY_PREFIX}${sessionId}`);
    },
  );
}
