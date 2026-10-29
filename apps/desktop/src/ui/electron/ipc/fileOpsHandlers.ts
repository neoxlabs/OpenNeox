/**
 * fileOpsHandlers - Project View 文件操作 IPC 处理
 *
 * 设计参考: IntelliJ IDEA Project View 的文件操作动作
 * (rename / create / duplicate / copy / move / trash / reveal / open-in-terminal)
 *
 * 所有路径必须经 validateWorkspacePath 校验,防 path traversal。
 *
 * 关联:
 *   - preload.js: window.neox.{renameFile, createFileItem, duplicateFile, ...}
 *   - renderer: src/ui/renderer/services/fileSystemService.ts
 */
import { ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import * as path from 'path';
import { realpathSync } from 'fs';
import { homedir } from 'os';
import { spawn } from 'child_process';
import { validateWorkspacePath, validateAgainstWorkspaceRoots } from './fileEditHandlers.js';
import type { ProjectManager } from '../context/ProjectManager.js';
import { makeWorkspaceResolver } from './scopeResolvers.js';
import { storageService } from '../../../platform-electron/storageService.js';
import { hasUserApprovedPath } from './userApprovedPaths.js';
import { recoverRenamedTaskPath } from './recoverRenamedTaskPath.js';
import { revealPathWithFallback } from './openPathFallback.js';
import { isSensitiveReadPath } from '../../shared/localReadPolicy.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

interface RegisterFileOpsIpcHandlersOptions {
  projectManager: ProjectManager;
}

/** base 是否包含 target (含相等). 用 path.relative 判定, 防前缀字符串绕过. */
function isPathInsideDir(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * external 源路径的敏感目录防线 — external=true 跳过 workspace 沙箱后, 被注入的
 * renderer 可借此把任意可读文件复制进 workspace 再回读 (等于任意文件读). 凭据类
 * 目录直接拒绝. 先 realpathSync 解析 symlink, 防 "~/Desktop/link → ~/.ssh/id_rsa" 绕过.
 * 源不存在时 realpathSync 抛 ENOENT, 跟后续 fs.stat 的失败语义一致, 直接透传.
 */
function assertExternalSrcAllowed(absoluteSrc: string): void {
  const real = realpathSync(absoluteSrc);
  const home = homedir();
  const forbiddenDirs = [
    path.join(home, '.ssh'),
    path.join(home, '.aws'),
    path.join(home, '.gnupg'),
    path.join(home, 'Library', 'Keychains'),
    '/etc',
    '/private/etc',
  ];
  for (const dir of forbiddenDirs) {
    if (isPathInsideDir(dir, real)) {
      throw new Error('external source is inside a protected directory');
    }
  }
  /* ~/.neox 里混放普通产物和凭据 (auth.enc / token / credential) — 只拦凭据类文件名 */
  if (isPathInsideDir(path.join(home, NEOX_HOME_DIRNAME), real)) {
    const base = path.basename(real).toLowerCase();
    if (/auth|secret|token|credential/.test(base)) {
      throw new Error('external source is a protected Neox credential file');
    }
  }
}

export function registerFileOpsIpcHandlers(options: RegisterFileOpsIpcHandlersOptions): void {
  const resolveWorkspace = makeWorkspaceResolver(options.projectManager);

  function workspaceOf(event: IpcMainInvokeEvent): string {
    const wp = resolveWorkspace(event);
    if (!wp) throw new Error('No workspace set');
    return wp;
  }

  function getValidatedPath(event: IpcMainInvokeEvent, filePath: string): string {
    const primary = workspaceOf(event);
    return validateAgainstWorkspaceRoots(primary, filePath, storageService.getWorkspaceRootsSync(primary) || []);
  }

  /**
   * file:rename — 重命名文件 / 文件夹
   * 不允许跨目录(IDEA Rename 也只是改 basename,跨目录是 Move)
   */
  ipcMain.handle('file:rename', async (event, oldPath: string, newName: string) => {
    try {
      if (!newName || typeof newName !== 'string') {
        return { success: false, error: 'Invalid new name' };
      }
      // 校验 newName 不含路径分隔符 / 不为 . / ..
      if (newName.includes('/') || newName.includes('\\') || newName === '.' || newName === '..') {
        return { success: false, error: 'New name cannot contain path separators or be . / ..' };
      }
      const fs = await import('fs/promises');
      const absoluteOld = getValidatedPath(event, oldPath);
      const parentDir = path.dirname(absoluteOld);
      const absoluteNew = path.join(parentDir, newName);
      // 校验新路径仍在 workspace 内
      getValidatedPath(event, absoluteNew);
      // 同名文件已存在则报错(不覆盖)
      try {
        await fs.access(absoluteNew);
        return { success: false, error: `A file or folder named "${newName}" already exists` };
      } catch {
        // ENOENT 是期望
      }
      await fs.rename(absoluteOld, absoluteNew);
      return { success: true, newPath: absoluteNew };
    } catch (error: any) {
      console.error('[file:rename] failed:', error);
      return { success: false, error: error?.message || String(error) };
    }
  });

  /**
   * file:create — 在指定目录创建新文件 / 新文件夹
   * 跟 IDEA "New File..." / "New Directory..." 对齐
   */
  ipcMain.handle(
    'file:create',
    async (event, parentDir: string, name: string, isDirectory: boolean) => {
      try {
        if (!name || typeof name !== 'string') {
          return { success: false, error: 'Invalid name' };
        }
        if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
          return { success: false, error: 'Name cannot contain path separators or be . / ..' };
        }
        const fs = await import('fs/promises');
        const absoluteParent = getValidatedPath(event, parentDir);
        const absoluteNew = path.join(absoluteParent, name);
        getValidatedPath(event, absoluteNew);
        // 已存在 → 报错
        try {
          await fs.access(absoluteNew);
          return { success: false, error: `"${name}" already exists` };
        } catch {
          // ENOENT 期望
        }
        if (isDirectory) {
          await fs.mkdir(absoluteNew, { recursive: false });
        } else {
          // 确保父目录存在(IDEA 的 New File 支持 sub/path/to/file.txt 自动建中间目录)
          // 但因为我们禁了 / 在 name 里,这里 parent 一定存在
          await fs.writeFile(absoluteNew, '', 'utf-8');
        }
        return { success: true, newPath: absoluteNew };
      } catch (error: any) {
        console.error('[file:create] failed:', error);
        return { success: false, error: error?.message || String(error) };
      }
    }
  );

  /**
   * file:duplicate — 复制文件,新名字 = 原名 + " copy"(再有冲突就 " copy 2")
   * 跟 IDEA "Copy" → 弹对话框输新名一致,但走快捷动作不弹对话框
   */
  ipcMain.handle('file:duplicate', async (event, srcPath: string) => {
    try {
      const fs = await import('fs/promises');
      const absoluteSrc = getValidatedPath(event, srcPath);
      const stat = await fs.stat(absoluteSrc);
      const parentDir = path.dirname(absoluteSrc);
      const ext = path.extname(absoluteSrc);
      const base = path.basename(absoluteSrc, ext);
      // 找一个不冲突的名字
      let candidate = path.join(parentDir, `${base} copy${ext}`);
      let counter = 2;
      while (true) {
        try {
          await fs.access(candidate);
          candidate = path.join(parentDir, `${base} copy ${counter}${ext}`);
          counter++;
        } catch {
          break;
        }
      }
      getValidatedPath(event, candidate);
      if (stat.isDirectory()) {
        await fs.cp(absoluteSrc, candidate, { recursive: true, errorOnExist: true });
      } else {
        await fs.copyFile(absoluteSrc, candidate);
      }
      return { success: true, newPath: candidate };
    } catch (error: any) {
      console.error('[file:duplicate] failed:', error);
      return { success: false, error: error?.message || String(error) };
    }
  });

  ipcMain.handle('file:copy-to', async (event, srcPath: string, destDir: string, opts?: { external?: boolean }) => {
    try {
      const fs = await import('fs/promises');
      const isExternal = opts?.external === true;
      /* external 模式: src 只做 path.resolve 归一化 + 存在校验, 不校验 workspace 归属.
       * 非 external 模式: src 与 dest 都必须在 workspace 内 (老语义). */
      const absoluteSrc = isExternal
        ? path.resolve(srcPath)
        : getValidatedPath(event, srcPath);
      /* external 源加敏感目录防线; 用户经原生对话框显式选过的路径 (userApprovedPaths)
       * 视为明确授权, 跳过 denylist — 跟 fileSystemHandlers 的 surface 校验同款策略. */
      if (isExternal && !hasUserApprovedPath(event?.sender, absoluteSrc, 'read')) {
        assertExternalSrcAllowed(absoluteSrc);
      }
      const absoluteDestDir = getValidatedPath(event, destDir);
      const stat = await fs.stat(absoluteSrc);
      const ext = path.extname(absoluteSrc);
      const base = path.basename(absoluteSrc, ext);
      let candidate = path.join(absoluteDestDir, path.basename(absoluteSrc));
      // 防覆盖: 如果目标已存在,加 copy 后缀
      let counter = 1;
      while (true) {
        try {
          await fs.access(candidate);
          candidate = path.join(
            absoluteDestDir,
            counter === 1 ? `${base} copy${ext}` : `${base} copy ${counter}${ext}`
          );
          counter++;
        } catch {
          break;
        }
      }
      getValidatedPath(event, candidate);   // 目标最终路径永远在 workspace 内
      if (stat.isDirectory()) {
        await fs.cp(absoluteSrc, candidate, { recursive: true });
      } else {
        await fs.copyFile(absoluteSrc, candidate);
      }
      return { success: true, newPath: candidate };
    } catch (error: any) {
      console.error('[file:copy-to] failed:', error);
      return { success: false, error: error?.message || String(error) };
    }
  });

  /**
   * file:move-to — 把文件移动到目标目录(用于剪贴板 Cut + Paste)
   * 同名时自动加 copy 后缀(跟 macOS Finder 一样)
   */
  ipcMain.handle('file:move-to', async (event, srcPath: string, destDir: string) => {
    try {
      const fs = await import('fs/promises');
      const absoluteSrc = getValidatedPath(event, srcPath);
      const absoluteDestDir = getValidatedPath(event, destDir);
      const ext = path.extname(absoluteSrc);
      const base = path.basename(absoluteSrc, ext);
      let candidate = path.join(absoluteDestDir, path.basename(absoluteSrc));
      // 防同源同目录(no-op)
      if (candidate === absoluteSrc) {
        return { success: true, newPath: absoluteSrc, noop: true };
      }
      let counter = 1;
      while (true) {
        try {
          await fs.access(candidate);
          candidate = path.join(
            absoluteDestDir,
            counter === 1 ? `${base} copy${ext}` : `${base} copy ${counter}${ext}`
          );
          counter++;
        } catch {
          break;
        }
      }
      getValidatedPath(event, candidate);
      await fs.rename(absoluteSrc, candidate);
      return { success: true, newPath: candidate };
    } catch (error: any) {
      console.error('[file:move-to] failed:', error);
      return { success: false, error: error?.message || String(error) };
    }
  });

  /**
   * file:trash — 移到系统回收站(IDEA "Move to Trash" / Safe Delete 入口)
   * 用 Electron shell.trashItem,跨平台
   * 跟 file:delete (永久删除) 区分,这是 SAFE 路径
   */
  ipcMain.handle('file:trash', async (event, filePath: string) => {
    try {
      const absolutePath = getValidatedPath(event, filePath);
      await shell.trashItem(absolutePath);
      return { success: true };
    } catch (error: any) {
      console.error('[file:trash] failed:', error);
      return { success: false, error: error?.message || String(error) };
    }
  });

  /**
   * file:reveal-in-finder — 跟 IDEA "Show in Finder/Explorer" 对齐
   * macOS: Finder 高亮文件,Win: Explorer 高亮,Linux: nautilus / dolphin / xdg-open
   */
  ipcMain.handle('file:reveal-in-finder', async (event, filePath: string) => {
    try {
      let absolutePath: string;
      try {
        absolutePath = getValidatedPath(event, filePath);
      } catch (validationErr) {
        const abs = path.resolve(String(filePath ?? ''));
        if (!path.isAbsolute(String(filePath ?? '')) || isSensitiveReadPath(abs, homedir(), process.platform)) {
          throw validationErr;
        }
        absolutePath = abs;
      }
      absolutePath = recoverRenamedTaskPath(absolutePath) ?? '';
      if (!absolutePath) return { success: false, error: 'not-found' };
      if (process.platform === 'darwin') spawn('open', ['-R', absolutePath], { detached: true, stdio: 'ignore' }).unref();
      else {
        const err = await revealPathWithFallback(absolutePath);
        if (err) return { success: false, error: err };
      }
      return { success: true };
    } catch (error: any) {
      console.error('[file:reveal-in-finder] failed:', error);
      return { success: false, error: error?.message || String(error) };
    }
  });

  /**
   * file:open-in-terminal — 在系统终端打开目录
   * macOS: open -a Terminal
   * Windows: start cmd
   * Linux: x-terminal-emulator / gnome-terminal / konsole
   */
  ipcMain.handle('file:open-in-terminal', async (event, dirPath: string) => {
    try {
      const fs = await import('fs/promises');
      const absolutePath = getValidatedPath(event, dirPath);
      const stat = await fs.stat(absolutePath);
      // 如果传入是文件,打开它的父目录
      const targetDir = stat.isDirectory() ? absolutePath : path.dirname(absolutePath);

      if (process.platform === 'darwin') {
        spawn('open', ['-a', 'Terminal', targetDir], { detached: true, stdio: 'ignore' }).unref();
      } else if (process.platform === 'win32') {
        /* 注入面收敛 (审计 P2): 路径不再拼进 /K 的 cmd 字符串 (目录名含 " 或 & 可逃逸执行任意命令),
         * 改用 spawn cwd 定起始目录 — start 起的新 cmd 窗口继承当前目录, 行为不变. 跟 Linux 分支同款. */
        spawn('cmd.exe', ['/c', 'start', 'cmd.exe'], {
          cwd: targetDir,
          detached: true,
          stdio: 'ignore',
        }).unref();
      } else {
        // Linux: 按优先级试几个常见 terminal
        const terminals = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm'];
        for (const term of terminals) {
          try {
            spawn(term, [], { cwd: targetDir, detached: true, stdio: 'ignore' }).unref();
            break;
          } catch {
            // 试下一个
          }
        }
      }
      return { success: true };
    } catch (error: any) {
      console.error('[file:open-in-terminal] failed:', error);
      return { success: false, error: error?.message || String(error) };
    }
  });

  /**
   * file:exists — 检查文件 / 文件夹是否存在(用于 Rename / New File 的前置校验)
   */
  ipcMain.handle('file:exists', async (event, filePath: string) => {
    try {
      const fs = await import('fs/promises');
      const absolutePath = getValidatedPath(event, filePath);
      try {
        await fs.access(absolutePath);
        return { success: true, exists: true };
      } catch {
        return { success: true, exists: false };
      }
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) };
    }
  });
}
