
import { ipcMain } from './ipcMainBridged.js';
import { lazyElectron } from '../lazyElectron.js';
import type { WebContents } from 'electron';

/* electron 运行时取 —— 顶层静态 import 会让整个 bundle 在纯 Node 后端里加载失败。 */
const BrowserWindow = lazyElectron<typeof import('electron').BrowserWindow>('BrowserWindow');
import { isDiagLogEnabled } from '@neoxlabs/kernel/platform/diagLogGate.js';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fsSync from 'node:fs';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';
import {
  type WorkspaceFsEventKind,
  type WorkspaceWatchBackend,
  preferNativeRecursiveFsWatch,
  translateNativeFsWatchEvent,
  translateParcelWatchEvent,
  watchPathLooksIgnored,
  workspaceWatchParcelIgnoreGlobs,
  createNativeWatchCoalescer,
} from './workspaceWatchOptions.js';

type ActiveWatch = {
  root: string;
  backend: WorkspaceWatchBackend;
  close: () => Promise<void> | void;
};

/* watcher 池: sender webContents.id → 当前活跃 watcher (+ 路径).
 * 用 id 当 key 而不是 webContents 对象本身, 是因为 contents 可能在某些 reload 路径下被复用,
 * 但 id 在生命周期内稳定. */
const watchers = new Map<number, ActiveWatch>();
const destroyedHookInstalled = new Set<number>();

type WatcherLogger = (tag: string, msg: string) => void;

const LOG_FILE = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'logs', 'workspace-watcher.log');
const LOG_MAX_BYTES = 8 * 1024 * 1024;
const LOG_SIZE_CHECK_EVERY = 500;
let _logEnsured = false;
let _logWriteCount = 0;
function rotateLogIfOversized(): void {
  try {
    const st = fsSync.statSync(LOG_FILE);
    if (st.size > LOG_MAX_BYTES) {
      try { fsSync.renameSync(LOG_FILE, `${LOG_FILE}.1`); } catch { /* 并发滚动竞争 — 忽略 */ }
    }
  } catch { /* 文件还不存在 */ }
}
const WATCHER_LOG_ON = isDiagLogEnabled('workspace-watcher');
const log: WatcherLogger = (tag, msg) => {
  if (!WATCHER_LOG_ON) return;
  try {
    if (!_logEnsured) {
      fsSync.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
      _logEnsured = true;
      rotateLogIfOversized();
    }
    if (++_logWriteCount % LOG_SIZE_CHECK_EVERY === 0) rotateLogIfOversized();
    fsSync.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [${tag}] ${msg}\n`, { mode: 0o600 });
  } catch { /* ignore */ }
};

function safeIsDirectory(absPath: string): boolean {
  try { return fsSync.statSync(absPath).isDirectory(); } catch { return false; }
}

function lifecycleLog(level: 'info' | 'warn', tag: string, msg: string): void {
  try {
    if (!_logEnsured) {
      fsSync.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
      _logEnsured = true;
      rotateLogIfOversized();
    }
    if (++_logWriteCount % LOG_SIZE_CHECK_EVERY === 0) rotateLogIfOversized();
    fsSync.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [${tag}] ${msg}\n`, { mode: 0o600 });
  } catch { /* 日志失败不能影响监听本身 */ }
  /* 开发/前台跑时同步到终端 —— 这是状态不是用户面向输出。 */
  if (level === 'warn') console.warn(`[workspace-watcher] ${tag} ${msg}`);
  else console.info(`[workspace-watcher] ${tag} ${msg}`);
}

/* 事件速率护栏 —— 只观测, 不改行为。目的是让"事件风暴"在下一次现场里一眼可见:
 * 每秒统计一次, 超阈值每分钟最多报一条 (带 workspace 路径以外的信息, 不落用户文件名)。 */
const WATCH_EVENT_RATE_WARN_PER_SEC = 3000;
const WATCH_EVENT_RATE_WARN_INTERVAL_MS = 60_000;

function createWatchRateWatchdog(label: string): { count: () => void; dispose: () => void } {
  let events = 0;
  let lastWarnAt = 0;
  const timer = setInterval(() => {
    const perSec = events;
    events = 0;
    if (perSec >= WATCH_EVENT_RATE_WARN_PER_SEC && Date.now() - lastWarnAt >= WATCH_EVENT_RATE_WARN_INTERVAL_MS) {
      lastWarnAt = Date.now();
      lifecycleLog('warn', 'watch-event-storm', `${label}: ${perSec} fs events/s — 已按 50ms 合批 + 200 条上限折叠上报; 若同时伴随高 CPU 请带上本条日志`);
    }
  }, 1000);
  timer.unref?.();
  return { count: () => { events += 1; }, dispose: () => clearInterval(timer) };
}

async function closeWatcher(senderId: number, reason: string): Promise<void> {
  const entry = watchers.get(senderId);
  if (!entry) return;
  watchers.delete(senderId);
  try {
    await entry.close();
    log('close', `senderId=${senderId} root=${entry.root} backend=${entry.backend} reason=${reason}`);
  } catch (e) {
    log('close-error', `senderId=${senderId} err=${(e as Error).message}`);
  }
}

function sendEvent(
  webContents: WebContents,
  kind: WorkspaceFsEventKind,
  filePath: string,
): void {
  log('fs-event', `kind=${kind} path=${filePath}`);
  if (webContents.isDestroyed()) {
    log('send-skip', `webContents-destroyed kind=${kind} path=${filePath}`);
    return;
  }
  try {
    webContents.send('workspace:fs-event', { kind, path: filePath });
  } catch (e) {
    log('send-error', `kind=${kind} path=${filePath} err=${(e as Error).message}`);
  }
}

function startNativeRecursiveWatch(
  root: string,
  sender: WebContents,
  onFatal?: (err: Error) => void,
): ActiveWatch {
  const watchdog = createWatchRateWatchdog('fs-watch-recursive');
  const coalescer = createNativeWatchCoalescer((batch) => {
    if (batch.collapsed) {
      /* 事件风暴: 折叠成父目录 change —— 渲染层对任何事件都是 refreshDir(parent),
       * 重新列一次目录就能看到新增/删除, 而主线程不再做上万次同步 stat。 */
      log('coalesce-collapse', `raw=${batch.droppedPaths} parents=${batch.paths.length}`);
      for (const abs of batch.paths) {
        if (watchPathLooksIgnored(abs)) continue;
        sendEvent(sender, 'change', abs);
      }
      return;
    }
    for (const abs of batch.paths) {
      if (watchPathLooksIgnored(abs)) continue;
      const exists = fsSync.existsSync(abs);
      const kind = translateNativeFsWatchEvent('rename', exists, exists && safeIsDirectory(abs));
      sendEvent(sender, kind, abs);
    }
  });
  const watcher = fsSync.watch(root, { recursive: true, persistent: true }, (_eventType, filename) => {
    if (!filename) return;
    watchdog.count();
    const abs = path.resolve(root, filename.toString());
    if (watchPathLooksIgnored(abs)) return;
    coalescer.push(abs);
  });
  watcher.on('error', (err) => {
    const e = err as Error;
    log('fs-watch-error', e.message);
    onFatal?.(e);
  });
  return {
    root,
    backend: 'fs-watch-recursive',
    close: () => {
      coalescer.dispose();
      watchdog.dispose();
      watcher.close();
    },
  };
}

async function startParcelWatch(root: string, sender: WebContents): Promise<ActiveWatch> {
  const pw = await import('@parcel/watcher');
  const ignore = workspaceWatchParcelIgnoreGlobs();
  const sub = await pw.subscribe(
    root,
    (err, events) => {
      if (err) {
        log('parcel-error', `root=${root} err=${err.message}`);
        return;
      }
      for (const ev of events) {
        const abs = path.resolve(ev.path);
        const kind = translateParcelWatchEvent(ev.type, ev.type === 'create' && safeIsDirectory(abs));
        sendEvent(sender, kind, abs);
      }
    },
    { ignore },
  );
  return {
    root,
    backend: 'parcel',
    close: () => sub.unsubscribe(),
  };
}

async function startWorkspaceWatchWithFallback(
  root: string,
  sender: WebContents,
  senderId: number,
  opts?: { skipNative?: boolean; onNativeFatal?: (err: Error) => void },
): Promise<{ handle: ActiveWatch | null; failures: string[] }> {
  const failures: string[] = [];
  if (!opts?.skipNative && preferNativeRecursiveFsWatch(process.platform)) {
    try {
      const handle = startNativeRecursiveWatch(root, sender, opts?.onNativeFatal);
      log('native-recursive', `senderId=${senderId}`);
      return { handle, failures };
    } catch (nativeErr) {
      failures.push(`fs-watch-recursive: ${(nativeErr as Error).message}`);
      log('native-fallback', `senderId=${senderId} err=${(nativeErr as Error).message}`);
    }
  }
  try {
    const handle = await startParcelWatch(root, sender);
    log('parcel-subscribed', `senderId=${senderId}`);
    return { handle, failures };
  } catch (parcelErr) {
    failures.push(`parcel: ${(parcelErr as Error).message}`);
    log('parcel-fallback', `senderId=${senderId} err=${(parcelErr as Error).message}`);
  }
  return { handle: null, failures };
}

export function registerWorkspaceWatcherIpcHandlers(): void {
  ipcMain.handle('workspace:watch-start', async (event, rawRoot: unknown) => {
    if (typeof rawRoot !== 'string' || !rawRoot) {
      return { ok: false, error: 'invalid root' };
    }
    const root = path.resolve(rawRoot);
    const senderId = event?.sender.id;

    /* 旧 watcher 先关 — 切 workspace 或 reload 时常见.
     * 同路径也重启一次 (用户可能手动触发 re-watch). */
    await closeWatcher(senderId, 'replaced');

    if (!fsSync.existsSync(root)) {
      log('start-skip', `path-not-exist root=${root}`);
      return { ok: false, error: 'path does not exist' };
    }

    const t0 = Date.now();
    log('watcher-init-begin', `senderId=${senderId} root=${root}`);

    try {
      /* native 异步致命错误 → 原地换 parcel (窗口不重启, 用户无感)。 */
      const upgradeToParcel = (err: Error) => {
        lifecycleLog('warn', 'native-watch-error', `fs.watch recursive 报错, 换 @parcel/watcher: ${err.message} (root=${root})`);
        void startWorkspaceWatchWithFallback(root, event.sender, senderId, { skipNative: true })
          .then(async ({ handle: next }) => {
            if (!next) {
              watchers.delete(senderId);
              lifecycleLog('warn', 'watch-degraded', `换 parcel 也失败, 文件树不会自动刷新 (root=${root})`);
              return;
            }
            const prev = watchers.get(senderId);
            watchers.set(senderId, next);
            try { await prev?.close(); } catch { /* 旧句柄已失效, 关不掉也不影响新后端 */ }
            lifecycleLog('info', 'watcher-switched', `backend=${next.backend} root=${root}`);
          });
      };

      const { handle, failures } = await startWorkspaceWatchWithFallback(
        root,
        event.sender,
        senderId,
        { onNativeFatal: upgradeToParcel },
      );

      /* 都失败 → 显式降级。这里**没有也不要有**轮询兜底: 全树 polling 在大仓库上是
       * 满 1 核的常驻负载, 换来的只是"文件树自动刷新"。宁可它不刷新。 */
      if (!handle) {
        const backend: WorkspaceWatchBackend = 'none';
        lifecycleLog('warn', 'watch-degraded', `文件树不会自动刷新 (所有监听后端都失败) — root=${root} failures=${failures.join(' | ')}`);
        log('watcher-init-end', `senderId=${senderId} backend=${backend} total=${Date.now() - t0}ms`);
        return { ok: true, root, backend, degraded: true };
      }
      watchers.set(senderId, handle);
      /* 选中哪条后端**无条件落盘**。上一版把它藏在默认关闭的诊断日志后面, 现场只剩
       * "CPU 高但查不到谁在扫" —— 每个 workspace 一次, 没有体积问题。 */
      lifecycleLog('info', 'watcher-init-end', `backend=${handle.backend} total=${Date.now() - t0}ms root=${root}`);
      log('watcher-init-end', `senderId=${senderId} backend=${handle.backend} total=${Date.now() - t0}ms`);

      /* window 关时自动 dispose. 用 webContents 'destroyed' 比 BrowserWindow 'closed'
       * 更靠近真实生命周期 (reload 也会 destroy).
       * 每个 sender 只挂一次 — closeWatcher 幂等, 重复 watch-start 不再累积 listener. */
      if (!destroyedHookInstalled.has(senderId)) {
        destroyedHookInstalled.add(senderId);
        event?.sender.once('destroyed', () => {
          destroyedHookInstalled.delete(senderId);
          void closeWatcher(senderId, 'webContents-destroyed');
        });
      }

      return { ok: true, root, backend: handle.backend };
    } catch (e) {
      log('start-error', `senderId=${senderId} root=${root} err=${(e as Error).message}`);
      return { ok: false, error: (e as Error).message };
    }
  });

  ipcMain.handle('workspace:watch-stop', async (event) => {
    await closeWatcher(event?.sender.id, 'explicit-stop');
    return { ok: true };
  });

  /* app quit 时关全部 watcher (兜底) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).__neox_closeAllWorkspaceWatchers__ = () => {
    for (const id of Array.from(watchers.keys())) {
      void closeWatcher(id, 'app-quit');
    }
  };
}

/** 调试 / 测试用 — 当前活跃 watcher 数. */
export function getActiveWatcherCount(): number {
  return watchers.size;
}

/** main entry app.on('before-quit') 调一次, 清干净再退. */
export function shutdownAllWorkspaceWatchers(): void {
  for (const id of Array.from(watchers.keys())) {
    void closeWatcher(id, 'shutdown');
  }
}

// 让 BrowserWindow 引用 (避免 unused import warning 编译报错)
void BrowserWindow;
