/**
 * keymapSettingsHandlers - 全局 Keymap 绑定持久化 IPC
 *
 * 设计哲学:
 *   - 不使用 localStorage(renderer 私有,易丢失)
 *   - 走 SQLite app_state 表(跟 UIState/sessions 同套机制)
 *   - 落盘到 ~/Library/Application Support/Neox/neox.db
 *   - 跟 IDEA 写 ~/Library/.../JetBrains/.../keymaps/*.xml 设计哲学一致
 */
import { ipcMain } from './ipcMainBridged.js';
import { getDatabase } from '@neoxlabs/platform/platform/database.js';

const KEY = 'keymap:bindings';

/** Partial keymap bindings - 只保留用户改过的字段,默认值由 renderer 端 merge */
type KeymapBindings = Record<string, string>;

export function registerKeymapSettingsIpcHandlers(): void {
  /** 读取所有用户自定义 binding(只返回用户改过的,默认在 renderer 端 merge) */
  ipcMain.handle('keymap-bindings:get', async () => {
    try {
      const db = getDatabase();
      const stored = db.getAppState<KeymapBindings>(KEY, {});
      return { success: true, bindings: stored ?? {} };
    } catch (error: any) {
      console.error('[keymap-bindings:get] failed:', error);
      return { success: true, bindings: {} };
    }
  });

  /** 写入全部 binding(全量覆盖,只存储跟默认值不同的字段由调用方决定) */
  ipcMain.handle('keymap-bindings:set', async (_event, bindings: KeymapBindings) => {
    try {
      const db = getDatabase();
      db.setAppState(KEY, bindings ?? {});
      return { success: true };
    } catch (error: any) {
      console.error('[keymap-bindings:set] failed:', error);
      return { success: false, error: error?.message || String(error) };
    }
  });

  /** 重置所有(清空 storage,renderer 端会回退到 defaults) */
  ipcMain.handle('keymap-bindings:reset', async () => {
    try {
      const db = getDatabase();
      db.setAppState(KEY, {});
      return { success: true };
    } catch (error: any) {
      console.error('[keymap-bindings:reset] failed:', error);
      return { success: false, error: error?.message || String(error) };
    }
  });
}
