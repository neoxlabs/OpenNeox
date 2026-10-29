import path from 'node:path';
import fsSync from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';
import { findChromeExecutable } from './chromeLauncher.js';

/** 在目录里找 headless shell 可执行文件 (playwright 的目录结构随版本变, 按文件名找) */
function findHeadlessShell(dir: string, depth = 0): string | null {
  let entries: import('node:fs').Dirent[] = [];
  try { entries = fsSync.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && /^(headless_shell|chrome-headless-shell)(\.exe)?$/.test(e.name)) return full;
  }
  if (depth >= 4) return null;
  for (const e of entries) {
    if (e.isDirectory()) {
      const hit = findHeadlessShell(path.join(dir, e.name), depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** 拿到一个能 headless 启动的浏览器可执行文件路径; 没有就下载一次 (需要联网)。 */
export async function ensureHeadlessBrowser(): Promise<string> {
  const chrome = findChromeExecutable();
  if (chrome) return chrome;
  const dir = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'browsers');
  const existing = findHeadlessShell(dir);
  if (existing) return existing;
  /* cli.js 不在 playwright-core 的 exports 里, 直接 resolve 会被拒; 从 package.json 所在目录拼 */
  const cli = path.join(path.dirname(createRequire(import.meta.url).resolve('playwright-core/package.json')), 'cli.js');
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(process.execPath, [cli, 'install', 'chromium-headless-shell'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PLAYWRIGHT_BROWSERS_PATH: dir },
      stdio: 'ignore',
    });
    const timer = setTimeout(() => { proc.kill(); reject(new Error('download timed out')); }, 15 * 60_000);
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`install exited ${code}`)); });
  });
  const installed = findHeadlessShell(dir);
  if (!installed) throw new Error('browser download finished but the executable was not found');
  return installed;
}
