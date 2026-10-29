/**
 * Ripgrep binary resolver —— main 进程里复用的 rg 可执行路径获取.
 *
 * 查找顺序:
 *   1. @vscode/ripgrep npm 包 (Electron asar-unpacked 情况下会被 unpack)
 *   2. 系统常见路径: /opt/homebrew/bin, /usr/local/bin, /usr/bin
 *   3. 裸 `rg` (祈祷 PATH 里有)
 *
 * 结果进程级缓存, 只 resolve 一次.
 *
 * 这个逻辑最早在 fileSystemHandlers.ts 的 closure 里, 第二次用的时候
 * (runConfigIpcHandlers 的 package.json 扫描) 抽了出来.
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';

let resolvedRgPath: string | null = null;

/** Win 上 X_OK 跟 ACL 搅在一起, 能跑的 rg.exe 也会被判 not executable。只查存在。 */
async function rgLooksRunnable(candidate: string): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      return fsSync.existsSync(candidate);
    }
    await fs.access(candidate, 1 /* X_OK */);
    return true;
  } catch {
    return false;
  }
}

export async function getRgPath(): Promise<string> {
  if (resolvedRgPath) return resolvedRgPath;

  /* 打包版 extraFiles 把 rg.exe 放在 Neox.exe 旁边。dev 下 electron.exe 同目录没有,
   * 这条 miss 再走 @vscode/ripgrep。 */
  try {
    const sidecar = path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'rg.exe' : 'rg');
    if (fsSync.existsSync(sidecar)) {
      resolvedRgPath = sidecar;
      return sidecar;
    }
  } catch {
    /* ignore */
  }

  // 1. Try bundled @vscode/ripgrep
  try {
    const { rgPath } = (await import('@vscode/ripgrep')) as { rgPath: string };
    let candidate = rgPath;
    // Electron asar-unpacked fix
    if (candidate.includes('app.asar') && !candidate.includes('app.asar.unpacked')) {
      const unpacked = candidate.replace('app.asar', 'app.asar.unpacked');
      if (await rgLooksRunnable(unpacked)) candidate = unpacked;
    }
    if (await rgLooksRunnable(candidate)) {
      resolvedRgPath = candidate;
      return candidate;
    }
  } catch {
    /* @vscode/ripgrep 包不可用 */
  }

  // 2. 系统常见路径
  const candidates = ['/opt/homebrew/bin/rg', '/usr/local/bin/rg', '/usr/bin/rg'];
  for (const c of candidates) {
    if (await rgLooksRunnable(c)) {
      resolvedRgPath = c;
      return c;
    }
  }

  // 3. Bare rg —— 让 spawn 自己 throw 如果 PATH 里没有
  resolvedRgPath = 'rg';
  return 'rg';
}
