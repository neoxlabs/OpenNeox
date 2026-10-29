
import { stat } from 'node:fs/promises';
import { lazyElectron } from '../lazyElectron.js';
import { watchSingleFile, type SingleFileWatcher } from './watchSingleFile.js';

/* electron 走**运行时**取 —— 顶层静态 import 会让这个文件所在的整个 bundle
 * 在纯 Node 进程里加载失败, 把同包几十个跟 Electron 无关的 handler 一起带下水
 * (症状是极简版"桥上一条路由都没有", 报错里连 electron 三个字都没有)。
 * 见 lazyElectron.ts。Electron 宿主下拿到的是同一个对象, 行为一字不变。 */
const BrowserWindow = lazyElectron<typeof import('electron').BrowserWindow>('BrowserWindow');
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

let watcher: SingleFileWatcher | null = null;
let debounceTimer: NodeJS.Timeout | null = null;
let lastSelfBroadcastMs = 0;
let currentAuthFilePath: string | null = null;

const DEBOUNCE_MS = 200;
const SELF_BROADCAST_DEDUP_WINDOW_MS = 1000;

/** Desktop main 自己 set/clear auth.enc 后调用. 在 dedup 窗口内的 fs.watch 触发被忽略. */
export function markAuthSelfBroadcast(): void {
  lastSelfBroadcastMs = Date.now();
}

export function installAuthFileWatcher(authFilePath: string, authDirPath: string): void {
  if (watcher) return; /* idempotent */
  currentAuthFilePath = authFilePath;
  try {
    watcher = watchSingleFile(authFilePath, () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => { void handleAuthFileChange(); }, DEBOUNCE_MS);
    });
    cliLogger.info('AUTH_WATCHER', `installed (file=${authFilePath} dir=${authDirPath} mode=${watcher.mode()})`);
  } catch (err: any) {
    cliLogger.warn('AUTH_WATCHER', `install failed: ${err?.message ?? err}`);
  }
}

export function uninstallAuthFileWatcher(): void {
  if (watcher) {
    try { watcher.close(); } catch { /* ignore */ }
    watcher = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  currentAuthFilePath = null;
}

async function handleAuthFileChange(): Promise<void> {
  if (!currentAuthFilePath) return;

  /* dedup: main 自己刚 set/clear 触发的 fs 事件, 忽略 (renderer 已经被 set/clear IPC 内广播过) */
  if (Date.now() - lastSelfBroadcastMs < SELF_BROADCAST_DEDUP_WINDOW_MS) {
    return;
  }

  let exists = false;
  let mtimeMs = 0;
  try {
    const st = await stat(currentAuthFilePath);
    exists = true;
    mtimeMs = st.mtimeMs;
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      exists = false;
    } else {
      cliLogger.warn('AUTH_WATCHER', `stat failed: ${err?.message ?? err}`);
      return;
    }
  }

  const type = exists ? 'external-login' : 'external-logout';
  try {
    let broadcasted = 0;
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) {
        w.webContents.send('auth:changed', { type, source: 'fs-watch', mtimeMs });
        broadcasted++;
      }
    }
    cliLogger.info('AUTH_WATCHER', `external auth change → broadcast (type=${type}, windows=${broadcasted})`);
  } catch (err: any) {
    cliLogger.warn('AUTH_WATCHER', `broadcast failed: ${err?.message ?? err}`);
  }
}
