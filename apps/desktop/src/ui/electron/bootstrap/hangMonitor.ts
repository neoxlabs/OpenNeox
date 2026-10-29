
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';
import type { CrashReporter } from '@neoxlabs/platform/platform/crashReport/index.js';

const LOG_MAX_BYTES = 5 * 1024 * 1024;
const MAIN_LAG_SAMPLE_MS = 500;
const MAIN_LAG_WARN_MS = 1000;
const MAIN_LAG_IGNORE_MS = 120_000;
const RENDERER_FRAME_REPORT_MS = 3000; /* 长帧 ≥1s 都记日志, ≥3s 才上报 */
const STACK_TIMEOUT_MS = 2000;

export function hangLogPath(): string {
  return path.join(os.homedir(), NEOX_HOME_DIRNAME, 'logs', 'hang.log');
}

/** 追加一行; 超过 5MB 先把旧的挪成 hang.log.1。失败一律吞掉 —— 记录本身不能制造卡顿或崩溃。 */
export function appendHangLog(entry: Record<string, unknown>, file = hangLogPath()): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`);
    } catch { /* 文件还不存在 */ }
    fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...entry })}\n`);
  } catch { /* ignore */ }
}

/** 渲染进程 LoAF 报上来的脚本归属 (preload 原样转发, 这里再收一遍口子) */
export interface LongFrameScript {
  invoker?: string;
  invokerType?: string;
  sourceURL?: string;
  sourceFunctionName?: string;
  sourceCharPosition?: number;
  duration?: number;
  forcedStyleAndLayoutDuration?: number;
}
export interface LongFramePayload {
  duration: number;
  blockingDuration?: number;
  styleAndLayoutDuration?: number;
  scripts?: LongFrameScript[];
  /** 当前页面路由 (hash), 不含查询参数 */
  route?: string;
}

/** 脚本 URL 只留文件名 (bundle 名带 hash, 足够对上 sourcemap), 不留本机路径 */
function scriptFile(url: string | undefined): string {
  if (!url) return '?';
  try { return path.posix.basename(new URL(url).pathname) || '?'; } catch { return path.basename(String(url)) || '?'; }
}

/** LoAF 脚本 → 「at 函数 (文件:位置)」栈帧, 按耗时降序, 给上报的 stack 用 */
export function longFrameToStack(scripts: LongFrameScript[] | undefined): string {
  return (scripts ?? [])
    .slice()
    .sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))
    .slice(0, 10)
    .map((s) => `at ${s.sourceFunctionName || s.invoker || '(anonymous)'} (${scriptFile(s.sourceURL)}:${s.sourceCharPosition ?? 0}) [${Math.round(s.duration ?? 0)}ms]`)
    .join('\n');
}

export function sanitizeLongFrame(raw: unknown): LongFramePayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const duration = Number(r.duration);
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : undefined);
  const str = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : undefined);
  const scripts = Array.isArray(r.scripts) ? r.scripts.slice(0, 20).map((s: any) => ({
    invoker: str(s?.invoker, 120),
    invokerType: str(s?.invokerType, 40),
    sourceURL: scriptFile(str(s?.sourceURL, 500)),
    sourceFunctionName: str(s?.sourceFunctionName, 120),
    sourceCharPosition: num(s?.sourceCharPosition),
    duration: num(s?.duration),
    forcedStyleAndLayoutDuration: num(s?.forcedStyleAndLayoutDuration),
  })) : [];
  return {
    duration: Math.round(duration),
    blockingDuration: num(r.blockingDuration),
    styleAndLayoutDuration: num(r.styleAndLayoutDuration),
    scripts,
    route: str(r.route, 120)?.split('?')[0],
  };
}

interface ElectronLike {
  app: { on(event: string, listener: (...args: any[]) => void): unknown };
  BrowserWindow: { getAllWindows(): any[] };
  ipcMain: { on(channel: string, listener: (...args: any[]) => void): unknown };
}

/**
 * 装上三类记录。只在主进程装一次; 任何一步失败都不能挡住启动。
 * reporter 可空 (上报器装不上时照样写本地日志)。
 */
export function installHangMonitor(electron: ElectronLike, reporter: Pick<CrashReporter, 'reportHang'> | null): void {
  const report = (p: Parameters<CrashReporter['reportHang']>[0]) => {
    try { reporter?.reportHang(p); } catch { /* ignore */ }
  };

  /* ── 最近的 IPC 通道 (只记名字), 主进程卡顿时带上 ── */
  const recentIpc: string[] = [];
  const noteIpc = (channel: unknown) => {
    if (typeof channel !== 'string') return;
    recentIpc.push(channel);
    if (recentIpc.length > 12) recentIpc.shift();
  };

  /* ── 1. 窗口未响应 / 恢复 ── */
  const watched = new WeakSet<object>();
  const watchWindow = (win: any) => {
    if (!win || watched.has(win)) return;
    watched.add(win);
    let since = 0;
    try {
      win.webContents?.on?.('ipc-message', (_e: unknown, channel: unknown) => noteIpc(channel));
      win.webContents?.on?.('ipc-message-sync', (_e: unknown, channel: unknown) => noteIpc(`sync:${String(channel)}`));
    } catch { /* ignore */ }
    win.on('unresponsive', async () => {
      since = Date.now();
      const route = (() => { try { return new URL(win.webContents.getURL()).hash.split('?')[0].slice(0, 120); } catch { return ''; } })();
      let stack: string | undefined;
      try {
        const frame = win.webContents?.mainFrame;
        if (frame && typeof frame.collectJavaScriptCallStack === 'function') {
          stack = await Promise.race([
            frame.collectJavaScriptCallStack() as Promise<string | void>,
            new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), STACK_TIMEOUT_MS)),
          ]) || undefined;
        }
      } catch { /* 实验接口, 拿不到就算了 */ }
      appendHangLog({ type: 'window-unresponsive', route, recentIpc: [...recentIpc], stack: stack?.split('\n').slice(0, 40) });
      /* 当下就入队 (落盘), 用户关掉程序也能下次启动补发 */
      report({ message: '窗口未响应', stack, durationMs: 5000, role: 'renderer' });
    });
    win.on('responsive', () => {
      if (!since) return;
      const durationMs = Date.now() - since;
      since = 0;
      appendHangLog({ type: 'window-recovered', durationMs });
    });
  };
  try {
    for (const w of electron.BrowserWindow.getAllWindows()) watchWindow(w);
    electron.app.on('browser-window-created', (_e: unknown, win: unknown) => watchWindow(win));
  } catch { /* ignore */ }

  /* ── 2. 渲染进程自报的长帧 ── */
  try {
    electron.ipcMain.on('hang:long-frame', (_e: unknown, raw: unknown) => {
      const frame = sanitizeLongFrame(raw);
      if (!frame) return;
      appendHangLog({ type: 'renderer-long-frame', ...frame });
      if (frame.duration >= RENDERER_FRAME_REPORT_MS) {
        const top = frame.scripts?.slice().sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))[0];
        report({
          message: `界面一帧卡住${top ? `: ${top.sourceFunctionName || top.invoker || '?'}` : ''}`,
          stack: longFrameToStack(frame.scripts) || undefined,
          durationMs: frame.duration,
          role: 'renderer',
        });
      }
    });
  } catch { /* ignore */ }

  /* ── 3. 主进程事件循环卡顿 ── */
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - last - MAIN_LAG_SAMPLE_MS;
    last = now;
    if (lag < MAIN_LAG_WARN_MS) return;
    /* 睡眠 / 合盖 / 改系统时间会让定时器「迟到」几分钟 —— 不是卡顿 */
    if (lag > MAIN_LAG_IGNORE_MS) return;
    appendHangLog({ type: 'main-loop-lag', lagMs: lag, recentIpc: [...recentIpc] });
    if (lag >= RENDERER_FRAME_REPORT_MS) {
      /* 上报只带最后一条 IPC 当「栈」: 去重键按它分组, 不会因为前面几条顺序不同变成无数个新键 */
      const lastIpc = recentIpc[recentIpc.length - 1];
      report({
        message: '主进程卡住',
        stack: lastIpc ? `at ipc ${lastIpc}` : undefined,
        durationMs: lag,
        role: 'main',
      });
    }
  }, MAIN_LAG_SAMPLE_MS);
  (timer as { unref?: () => void }).unref?.();
}
