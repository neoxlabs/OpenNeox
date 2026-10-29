/**
 * explorerSettingsHandlers - Project View 视图设置持久化 IPC
 *
 * 设计哲学:
 *   - 不使用 localStorage(localStorage 是 renderer 私有的、有大小限制、易丢失)
 *   - 走 SQLite app_state 表(跟 UIState/sessions 同套机制)
 *   - 落盘到 ~/Library/Application Support/Neox/neox.db
 *   - 跨窗口共享、跨重启稳定、可以从 main 进程读到
 *
 * 跟 IntelliJ IDEA 写 ~/Library/Application Support/JetBrains/.../options/*.xml
 * 的设计哲学一致。
 */
import { ipcMain } from './ipcMainBridged.js';
import { getDatabase } from '@neoxlabs/platform/platform/database.js';

const KEY = 'explorer:settings';

interface ExplorerSettings {
  showHiddenFiles: boolean;
  showExcludedFiles: boolean;
  sortBy: 'name' | 'type' | 'time-asc' | 'time-desc';
  foldersFirst: boolean;
  compactMiddleDirs: boolean;
}

const DEFAULTS: ExplorerSettings = {
  // 跟 IDEA 默认一致: 显示 dotfile (.claude / .github / .gitignore 等)
  showHiddenFiles: true,
  showExcludedFiles: true,
  sortBy: 'name',
  foldersFirst: true,
  compactMiddleDirs: false,
};

export function registerExplorerSettingsIpcHandlers(): void {
  /** 读取当前设置(不存在时返回 IDEA-style 默认值) */
  ipcMain.handle('explorer-settings:get', async () => {
    try {
      const db = getDatabase();
      const stored = db.getAppState<ExplorerSettings>(KEY, DEFAULTS);
      // merge defaults 防止旧版本字段不全
      return { success: true, settings: { ...DEFAULTS, ...stored } };
    } catch (error: any) {
      console.error('[explorer-settings:get] failed:', error);
      return { success: true, settings: DEFAULTS };
    }
  });

  /** 写入设置(全量覆盖) */
  ipcMain.handle('explorer-settings:set', async (_event, settings: ExplorerSettings) => {
    try {
      const db = getDatabase();
      const merged = { ...DEFAULTS, ...settings };
      db.setAppState(KEY, merged);
      return { success: true };
    } catch (error: any) {
      console.error('[explorer-settings:set] failed:', error);
      return { success: false, error: error?.message || String(error) };
    }
  });
}
