import { ipcMain } from './ipcMainBridged.js';
import { getDatabase } from '@neoxlabs/platform/platform/database.js';

function lastSessionKey(workspaceRoot: string): string {
  return `ui:lastActiveSession:${workspaceRoot}`;
}
function surfacesKey(sessionId: string): string {
  return `ui:surfaces:${sessionId}`;
}

function genericKey(key: string): string {
  return `ui:${key}`;
}

export function registerUiStateIpcHandlers(): void {
  /* 通用读 — 任意 key, 返 string | null */
  ipcMain.handle('ui-state:get', async (_event, key: string) => {
    try {
      const db = getDatabase();
      const value = db.getAppState<string | null>(genericKey(key), null);
      return { success: true, value };
    } catch (error: any) {
      return { success: false, value: null, error: error?.message };
    }
  });

  /* 通用写 — null 表示删除. */
  ipcMain.handle('ui-state:set', async (_event, key: string, value: string | null) => {
    try {
      const db = getDatabase();
      db.setAppState(genericKey(key), value);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error?.message };
    }
  });

  ipcMain.handle('ui-state:get-last-session', async (_event, workspaceRoot: string) => {
    try {
      const db = getDatabase();
      let id = db.getAppState<string | null>(lastSessionKey(workspaceRoot), null);
      if (!id) {
        const workspaces = db.getAppState<Array<{ path: string; lastSessionId?: string }>>('ui:workspaces', []) || [];
        id = workspaces.find((w) => w.path === workspaceRoot)?.lastSessionId ?? null;
      }
      return { success: true, id };
    } catch (error: any) {
      return { success: false, id: null, error: error?.message };
    }
  });

  ipcMain.handle('ui-state:set-last-session', async (_event, workspaceRoot: string, id: string | null) => {
    try {
      const db = getDatabase();
      if (id) {
        db.setAppState(lastSessionKey(workspaceRoot), id);
        const workspaces = db.getAppState<Array<{ path: string; name: string; lastOpened: number; lastSessionId?: string }>>('ui:workspaces', []) || [];
        const idx = workspaces.findIndex((w) => w.path === workspaceRoot);
        if (idx >= 0) {
          workspaces[idx] = {
            ...workspaces[idx],
            lastSessionId: id,
            lastOpened: Date.now(),
          };
          db.setAppState('ui:workspaces', workspaces);
        }
      } else {
      }
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error?.message };
    }
  });

  ipcMain.handle('ui-state:get-surfaces', async (_event, sessionId: string) => {
    try {
      const db = getDatabase();
      const state = db.getAppState<{ surfaces: any[]; activeId?: string } | null>(
        surfacesKey(sessionId),
        null,
      );
      return { success: true, state };
    } catch (error: any) {
      return { success: false, state: null, error: error?.message };
    }
  });

  ipcMain.handle('ui-state:set-surfaces', async (
    _event,
    sessionId: string,
    state: { surfaces: any[]; activeId?: string } | null,
  ) => {
    try {
      const db = getDatabase();
      if (state && state.surfaces && state.surfaces.length > 0) {
        db.setAppState(surfacesKey(sessionId), state);
      } else {
        /* 空数组 → 清除 key, 不留 noise */
        db.setAppState(surfacesKey(sessionId), null);
      }
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error?.message };
    }
  });
}
