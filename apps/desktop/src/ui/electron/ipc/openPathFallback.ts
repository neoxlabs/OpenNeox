import { lazyElectron } from '../lazyElectron.js';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';

const shell = lazyElectron<typeof import('electron').shell>('shell');

/** Windows 兜底命令 (纯函数, 便于单测): 目录用资源管理器, 文件用系统默认程序处理器。 */
export function windowsOpenFallback(absPath: string, isDirectory: boolean): { cmd: string; args: string[] } {
  return isDirectory
    ? { cmd: 'explorer.exe', args: [absPath] }
    : { cmd: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', absPath] };
}

/** Windows 定位命令: explorer /select, 是资源管理器的参数, 跟文件关联无关。
 *  `/select,` 与路径必须是两个参数: 拼成一个的话路径带空格时 Node 会把整段加引号成
 *  `"/select,C:\a b\c"`, explorer 认不出来, 直接打开「文档」—— 任务目录名恰好都带空格。 */
export function windowsRevealFallback(absPath: string): { cmd: string; args: string[] } {
  return { cmd: 'explorer.exe', args: ['/select,', absPath] };
}

function isDirectorySync(absPath: string): boolean {
  try {
    return fs.statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

/** spawn 一个分离进程; ENOENT 这类启动失败会 reject, 而不是像 shell.* 那样吞掉。 */
function spawnDetached(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', (err) => reject(err));
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    } catch (err: any) {
      reject(err);
    }
  });
}

/**
 * 打开文件或文件夹。成功返 null, 失败返可直接展示给用户的错误串。
 * 非 Windows 平台只走 shell.openPath —— mac/linux 没有"关联表坏掉"这类系统性问题。
 */
export async function openPathWithFallback(absPath: string): Promise<string | null> {
  if (process.platform === 'win32' && isDirectorySync(absPath)) {
    const { cmd, args } = windowsOpenFallback(absPath, true);
    try {
      await spawnDetached(cmd, args);
      return null;
    } catch (err: any) {
      return `${cmd}: ${err?.message || String(err)}`;
    }
  }
  let primaryError = '';
  try {
    primaryError = await shell.openPath(absPath);
  } catch (err: any) {
    primaryError = err?.message || String(err);
  }
  if (!primaryError) return null;
  if (process.platform !== 'win32') return primaryError;

  const { cmd, args } = windowsOpenFallback(absPath, isDirectorySync(absPath));
  try {
    await spawnDetached(cmd, args);
    return null;
  } catch (err: any) {
    return `${primaryError} | ${cmd}: ${err?.message || String(err)}`;
  }
}

/**
 * 在文件管理器里定位一个文件。成功返 null, 失败返错误串。
 *
 * Windows 上不再用 shell.showItemInFolder: 它不返回错误, 出错时界面完全没有线索,
 * 而 explorer /select, 是同一个效果且失败能看见。
 */
export async function revealPathWithFallback(absPath: string): Promise<string | null> {
  if (process.platform === 'win32') {
    const { cmd, args } = windowsRevealFallback(absPath);
    try {
      await spawnDetached(cmd, args);
      return null;
    } catch (err: any) {
      return `${cmd}: ${err?.message || String(err)}`;
    }
  }
  try {
    shell.showItemInFolder(absPath);
    return null;
  } catch (err: any) {
    return err?.message || String(err);
  }
}
