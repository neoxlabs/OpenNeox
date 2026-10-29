import { ipcMain } from './ipcMainBridged.js';
import { lazyElectron } from '../lazyElectron.js';

/* electron 运行时取 —— 顶层静态 import 会让整个 bundle 在纯 Node 后端里加载失败,
 * 连累同包所有 handler (见 lazyElectron.ts, 方法必须 bind 回宿主)。ipcMain 走桥的替身。 */
const BrowserWindow = lazyElectron<typeof import('electron').BrowserWindow>('BrowserWindow');
import { realpathSync, readdirSync, statSync, existsSync } from 'fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'path';
import { storageService } from '../../../platform-electron/storageService.js';
import type { ProjectManager } from '../context/ProjectManager.js';

interface RegisterWorkspaceIpcHandlersOptions {
  projectManager: ProjectManager;
}

const normalizeWorkspacePath = (workspacePath: string): string => {
  const resolved = resolve(workspacePath);
  let normalized = resolved;
  try {
    normalized = typeof realpathSync.native === 'function'
      ? realpathSync.native(resolved)
      : realpathSync(resolved);
  } catch {
    normalized = resolved;
  }
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

export function registerWorkspaceIpcHandlers(options: RegisterWorkspaceIpcHandlersOptions): void {
  const { projectManager } = options;

  /**
   * workspace:set ——
   *   1. 创建 / 切换发起 IPC 的窗口的 ProjectScope (projectManager.attachWindowToScope)
   *   2. 持久化 lastWorkspace, 调整窗口尺寸
   */
  ipcMain.handle('workspace:set', async (event, workspacePath: string) => {
    if (typeof workspacePath !== 'string' || !workspacePath.trim()) {
      throw new Error('工作区路径无效：请选择一个存在的文件夹。');
    }
    const normalizedWorkspacePath = normalizeWorkspacePath(workspacePath);
    if (!existsSync(normalizedWorkspacePath)) {
      throw new Error(`工作区路径不存在：${workspacePath}`);
    }
    try {
      if (!statSync(normalizedWorkspacePath).isDirectory()) {
        throw new Error(`工作区路径不是文件夹：${workspacePath}`);
      }
    } catch (err: any) {
      if (err?.message?.startsWith('工作区路径')) throw err;
      throw new Error(`无法访问工作区路径：${workspacePath}`);
    }
    const senderWindow = BrowserWindow.fromWebContents(event?.sender);
    if (senderWindow) {
      await projectManager.attachWindowToScope(senderWindow, normalizedWorkspacePath);
    }

    await storageService.setLastWorkspace(normalizedWorkspacePath);

    // 工作区显示名: 自定义名优先, 否则 basename
    const workspaceName = storageService.getWorkspaceName(normalizedWorkspacePath) || basename(normalizedWorkspacePath) || 'Unknown';
    // 多根: 恢复该工作区记忆的全部根 (无记录则单根 = [primary])
    const roots = await storageService.getWorkspaceRoots(normalizedWorkspacePath);

    if (senderWindow) {
      senderWindow.setTitle(workspaceName);
    }

    const result = {
      path: normalizedWorkspacePath,
      name: workspaceName,
      status: 'idle' as const,
      lastOpened: Date.now(),
      roots,
    };

    try {
      const { notifyDesktopSessionsChanged } = await import('../mobile-bridge/index.js');
      notifyDesktopSessionsChanged();
    } catch (err: any) {
      console.warn('[workspace:set] broadcast failed:', err?.message ?? err);
    }

    try {
      if (!event.sender.isDestroyed()) event.sender.send('neox:workspace-changed', result);
    } catch (err: any) {
      console.warn('[workspace:set] workspace-changed send failed:', err?.message ?? err);
    }

    return result;
  });

  /**
   * workspace:get-roots —— 读 primary root 对应工作区的全部根目录 (含 primary, 有序)。
   * primaryPath 可缺省：回落到 lastWorkspace / 最近工作区, 避免 renderer 裸调崩 TypeError.
   */
  ipcMain.handle('workspace:get-roots', async (_event, primaryPath?: string) => {
    let path = typeof primaryPath === 'string' ? primaryPath.trim() : '';
    if (!path) {
      const state = await storageService.loadUIState();
      path = state.lastWorkspace || state.workspaces?.[0]?.path || '';
    }
    if (!path) return [];
    return storageService.getWorkspaceRoots(normalizeWorkspacePath(path));
  });

  /**
   * workspace:set-roots —— 写工作区根目录列表 (增/删根都走这里)。
   * roots 里的每个路径都归一化; 返回归一化+去重后的最终列表 (primary 首位)。
   */
  ipcMain.handle('workspace:set-roots', async (_event, primaryPath: string, roots: string[]) => {
    const normPrimary = normalizeWorkspacePath(primaryPath);
    const normRoots = (Array.isArray(roots) ? roots : []).map(normalizeWorkspacePath);
    await storageService.setWorkspaceRoots(normPrimary, normRoots);
    return storageService.getWorkspaceRoots(normPrimary);
  });

  /** 工作区实体: 重命名 / 删除 / 设主 / 列举(带 saved 标记) */
  ipcMain.handle('workspace:set-name', async (_event, primaryPath: string, name: string) => {
    await storageService.setWorkspaceName(normalizeWorkspacePath(primaryPath), name);
    return storageService.getWorkspaceName(normalizeWorkspacePath(primaryPath));
  });
  ipcMain.handle('workspace:delete', async (_event, primaryPath: string) => {
    await storageService.deleteWorkspace(normalizeWorkspacePath(primaryPath));
  });
  ipcMain.handle('workspace:set-primary', async (_event, oldPrimary: string, newPrimary: string) => {
    return storageService.setPrimaryRoot(normalizeWorkspacePath(oldPrimary), normalizeWorkspacePath(newPrimary));
  });
  ipcMain.handle('workspace:list', async () => {
    return storageService.listWorkspacesEnriched();
  });

  /** 最近打开的文件 (欢迎页用) —— 按 workspace 分桶。 */
  ipcMain.handle('files:add-recent', async (_event, workspacePath: string, filePath: string) => {
    await storageService.addRecentFile(workspacePath, filePath);
  });
  ipcMain.handle('files:get-recent', async (_event, workspacePath: string, limit?: number) => {
    return storageService.getRecentFiles(workspacePath, limit ?? 12);
  });

  ipcMain.handle('library:list', async (_event, dirPath: string) => {
    try {
      const root = resolve(String(dirPath || ''));
      /* 边界判定用 path.relative 而非 startsWith — 后者会把 ~/Documents/Neoxevil 这类
       * 同前缀兄弟目录误放行. rel === '' 即 root 就是产出物根目录本身, 允许. */
      const { getNeoxUserRoot } = await import('@neoxlabs/core/runtime/modeHome.js');
      const base = getNeoxUserRoot();
      const rel = relative(base, root);
      if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) return { files: [] };
      const out: Array<{ name: string; path: string; size: number; mtime: number; ext: string }> = [];
      const walk = (dir: string, depth: number): void => {
        if (depth > 4 || out.length >= 800) return;
        let entries;
        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (out.length >= 800) return;
          if (e.name.startsWith('.')) continue;
          const p = join(dir, e.name);
          if (e.isDirectory()) { walk(p, depth + 1); continue; }
          if (!e.isFile()) continue;
          try {
            const st = statSync(p);
            out.push({ name: e.name, path: p, size: st.size, mtime: st.mtimeMs, ext: extname(e.name).slice(1).toLowerCase() });
          } catch { /* 单文件 stat 失败跳过 */ }
        }
      };
      walk(root, 0);
      out.sort((a, b) => b.mtime - a.mtime);
      return { files: out };
    } catch (e) {
      return { files: [], error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle('workspace:clear-last', async (event, opts?: { detach?: boolean }) => {
    const senderWindow = BrowserWindow.fromWebContents(event?.sender);
    if (senderWindow && opts?.detach === true) {
      try {
        await projectManager.detachWindow(senderWindow);
      } catch (err) {
        console.error('[workspace:clear-last] detachWindow failed:', err);
      }
    }

    await storageService.clearLastWorkspace();

    if (senderWindow) {
      senderWindow.setTitle('Neox');
    }
  });
}
