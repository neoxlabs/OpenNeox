import { lazyElectron, isElectron } from '../lazyElectron.js';
import type { IpcMainInvokeEvent } from 'electron';

/* electron 走**运行时**取 —— 顶层静态 import 会让这个文件所在的整个 bundle
 * 在纯 Node 进程里加载失败, 把同包几十个跟 Electron 无关的 handler 一起带下水
 * (症状是极简版"桥上一条路由都没有", 报错里连 electron 三个字都没有)。
 * 见 lazyElectron.ts。Electron 宿主下拿到的是同一个对象, 行为一字不变。 */
const shell = lazyElectron<typeof import('electron').shell>('shell');
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { storageService } from '../../../platform-electron/storageService.js';
import type { ProjectManager } from '../context/ProjectManager.js';
import { findChromeExecutable } from '../services/externalChrome/chromeLauncher.js';
import { openPathWithFallback } from './openPathFallback.js';

const WEB_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function normalizeForCompare(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function realpathOrResolve(value: string): string {
  const resolved = path.resolve(value);
  try {
    return typeof fs.realpathSync.native === 'function'
      ? fs.realpathSync.native(resolved)
      : fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isPathInside(basePath: string, targetPath: string): boolean {
  const base = normalizeForCompare(realpathOrResolve(basePath));
  const target = normalizeForCompare(realpathOrResolve(targetPath));
  if (target === base) return true;
  const relative = path.relative(base, target);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function parseUrl(rawUrl: unknown): URL {
  if (typeof rawUrl !== 'string') {
    throw new Error('url must be a string');
  }
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 4096) {
    throw new Error('invalid url');
  }
  return new URL(trimmed);
}

export function isSafeWebExternalUrl(rawUrl: unknown): boolean {
  try {
    return WEB_EXTERNAL_PROTOCOLS.has(parseUrl(rawUrl).protocol);
  } catch {
    return false;
  }
}

/** Extra browsers beyond Chromium family (findChromeExecutable). */
function listFallbackBrowserExecutables(): string[] {
  const out: string[] = [];
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pfx86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const lad = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    out.push(
      path.join(pf, 'Mozilla Firefox', 'firefox.exe'),
      path.join(pfx86, 'Mozilla Firefox', 'firefox.exe'),
      path.join(lad, 'Mozilla Firefox', 'firefox.exe'),
      path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      path.join(lad, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    );
  } else if (process.platform === 'darwin') {
    out.push(
      '/Applications/Firefox.app/Contents/MacOS/firefox',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    );
  } else {
    out.push('/usr/bin/firefox', '/snap/bin/firefox', '/usr/bin/brave-browser');
  }
  return out;
}

function findAnyInstalledBrowser(): string | null {
  const chromium = findChromeExecutable();
  if (chromium) return chromium;
  for (const candidate of listFallbackBrowserExecutables()) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* next */
    }
  }
  return null;
}

/**
 * Win10 常见坑: 默认浏览器关联坏了 (Edge AppX 残留 / 2345 等),
 * shell.openExternal → SE_ERR_NOASSOC (0x483)。直接 spawn 已安装的
 * Chrome/Edge/Firefox, 绕过协议关联表。
 */
function openWithInstalledBrowser(href: string): Promise<void> {
  const exe = findAnyInstalledBrowser();
  if (!exe) {
    return Promise.reject(
      new Error(
        'No installed browser found (Chrome / Edge / Firefox). '
        + 'Install one or fix the Windows default browser association.',
      ),
    );
  }

  return new Promise((resolve, reject) => {
    try {
      const child = spawn(exe, [href], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.once('error', (err) => {
        reject(new Error(`spawn ${exe} failed: ${err.message}`));
      });
      /* spawn 同步成功时不会立刻 error; 给一点机会吃 ENOENT 再 resolve */
      child.unref();
      setImmediate(() => resolve());
    } catch (err: any) {
      reject(new Error(`spawn ${exe} failed: ${err?.message || err}`));
    }
  });
}

function isDefaultBrowserAssocError(err: unknown): boolean {
  const msg = String((err as any)?.message || err || '');
  return /没有应用程序与此操作的指定文件有关联|0x483|SE_ERR_NOASSOC|Failed to open|no application is associated/i.test(msg);
}

/**
 * 打开 http(s)/mailto。先走系统默认关联; 失败时对 http(s) 回退到本机浏览器可执行文件。
 */
export async function openSafeWebExternalUrl(rawUrl: unknown): Promise<void> {
  const url = parseUrl(rawUrl);
  if (!WEB_EXTERNAL_PROTOCOLS.has(url.protocol)) {
    throw new Error(`external url protocol not allowed: ${url.protocol}`);
  }

  const href = url.toString();

  /* 非 Electron 宿主 (极简版的 Node 后端) 没有 shell —— 直接用系统的默认打开命令。
   *
   * 这条路必须有: 浏览器登录 (auth:launch-oauth) 就靠它把授权页打开。
   * 少了它的表现极具误导性 —— 界面照常显示"已打开浏览器, 请在浏览器中完成登录",
   * 而浏览器根本没开, 用户只会以为是登录服务坏了。
   *
   * 用 `open` / `xdg-open` / `start` 而不是去猜浏览器可执行文件路径:
   * 这才是"用户的默认浏览器", 而下面那个 findAnyInstalledBrowser 是 Windows
   * 默认关联损坏时的兜底, 拿它当主路径会打开一个用户根本没在用的浏览器。 */
  if (!isElectron()) {
    const { spawn: spawnProc } = await import('node:child_process');
    const cmd = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'cmd'
      : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', href] : [href];
    await new Promise<void>((resolve, reject) => {
      const child = spawnProc(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
    return;
  }

  try {
    await shell.openExternal(href);
    return;
  } catch (err) {
    if (url.protocol === 'mailto:') throw err;

    console.warn(
      '[openExternal] shell.openExternal failed%s — falling back to installed browser:',
      isDefaultBrowserAssocError(err) ? ' (broken default-browser association)' : '',
      (err as Error)?.message || err,
    );

    try {
      await openWithInstalledBrowser(href);
      console.log('[openExternal] opened via installed browser fallback');
    } catch (fallbackErr) {
      const primary = (err as Error)?.message || String(err);
      const secondary = (fallbackErr as Error)?.message || String(fallbackErr);
      throw new Error(`Failed to open browser: ${primary} | fallback: ${secondary}`);
    }
  }
}

export async function openSafeExternalFromIpc(
  projectManager: ProjectManager,
  event: IpcMainInvokeEvent,
  rawUrl: unknown,
): Promise<void> {
  const url = parseUrl(rawUrl);

  if (WEB_EXTERNAL_PROTOCOLS.has(url.protocol)) {
    /* 复用 http(s) 回退逻辑, 避免 IPC openExternal 与 OAuth 行为分叉 */
    await openSafeWebExternalUrl(url.toString());
    return;
  }

  if (url.protocol !== 'file:') {
    throw new Error(`external url protocol not allowed: ${url.protocol}`);
  }

  const scope = projectManager.getBySender(event?.sender as any);
  if (!scope) {
    throw new Error('file url requires an active workspace');
  }

  const targetPath = realpathOrResolve(fileURLToPath(url));
  const roots = storageService.getWorkspaceRootsSync(scope.workspacePath);
  const allowedRoots = roots.length > 0 ? roots : [scope.workspacePath];
  if (!allowedRoots.some((root) => isPathInside(root, targetPath))) {
    throw new Error('file url must be inside the current workspace');
  }

  const stat = fs.statSync(targetPath);
  if (!stat.isFile() && !stat.isDirectory()) {
    throw new Error('file url must point to a regular file or directory');
  }

  const error = await openPathWithFallback(targetPath);
  if (error) {
    throw new Error(error);
  }
}
