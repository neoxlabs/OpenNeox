/**
 * computerOverlayHandlers — "computer use 被操控" 叠加层的 IPC
 *
 * 状态机见 computerOverlaySession.ts. 这里只负责执行 show / hide:
 *   driving → 亮罩, 整层穿透 (注入打到下面的应用; 停靠 Esc / 左上角退出钮)
 *   idle    → 立刻关罩, 鼠标归用户
 *
 * 通道:
 *   overlay:show / overlay:hide     生命周期
 *   overlay:state / overlay:pointer 主→叠加层
 *   overlay:hello / overlay:stop    叠加层→main
 *   overlay:set-ignore-mouse        仅 mac: 停在「退出」钮上时窗口收点击
 */

import { ipcMain, BrowserWindow, screen, app } from 'electron';
import { onComputerPointer } from '@neoxlabs/platform/shared/computerPointerBus.js';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  showOverlay,
  hideOverlay,
  getOverlayWindow,
  prewarmOverlay,
  setOverlayWanted,
  isOverlayWanted,
  setOverlayClickThrough,
} from '../services/computerOverlayWindowFactory.js';
import {
  classifyPointerAction,
  createOverlaySession,
  overlayHoldMs,
  reduceOverlaySession,
  type OverlaySessionState,
} from './computerOverlaySession.js';

export interface OverlayStatePayload {
  visible: boolean;
  app?: string;
  steps?: string[];
  activeIndex?: number;
}

export interface OverlayPointerPayload {
  app: string;
  action: string;
  label: string;
  x: number;
  y: number;
  phase: 'move' | 'act' | 'done';
  risk?: 'safe' | 'high';
}

interface RegisterComputerOverlayIpcHandlersOpts {
  isDev: boolean;
  dirname: string;
  onUserStop?: () => void;
}

let lastState: OverlayStatePayload = { visible: false };
let lastPointer: OverlayPointerPayload | null = null;
let overlaySession: OverlaySessionState = createOverlaySession();

export function pushOverlayState(win: BrowserWindow | null, state: OverlayStatePayload): void {
  lastState = {
    visible: !!state.visible,
    app: state.app,
    steps: state.steps,
    activeIndex: state.activeIndex,
  };
  const target = win && !win.isDestroyed() ? win : getOverlayWindow();
  if (target && !target.isDestroyed()) {
    target.webContents.send('overlay:state', lastState);
  }
}

export function pushOverlayPointer(win: BrowserWindow | null, evt: OverlayPointerPayload): void {
  lastPointer = evt;
  const target = win && !win.isDestroyed() ? win : getOverlayWindow();
  if (target && !target.isDestroyed()) {
    target.webContents.send('overlay:pointer', evt);
  }
}

export function registerComputerOverlayIpcHandlers(opts: RegisterComputerOverlayIpcHandlersOpts): void {
  ipcMain.handle('overlay:show', async () => {
    try {
      const win = await showOverlay({ isDev: opts.isDev, dirname: opts.dirname });
      if (!win) return { ok: false, error: 'overlay window unavailable' };
      setOverlayClickThrough(win, true);
      return { ok: true, windowId: win.id };
    } catch (err: any) {
      console.error('[computerOverlayHandlers] show failed:', err);
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle('overlay:hide', async () => {
    try {
      forceIdle();
      return { ok: true };
    } catch (err: any) {
      console.error('[computerOverlayHandlers] hide failed:', err);
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  ipcMain.on('overlay:hello', (e) => {
    if (!isFromOverlayWindow(e.sender.id)) return;
    const win = getOverlayWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send('overlay:state', lastState);
    if (lastPointer) win.webContents.send('overlay:pointer', lastPointer);
    console.log(`[computerOverlay] 叠加层就绪, 补推 state(visible=${lastState.visible}) + pointer(${lastPointer ? lastPointer.action : '无'})`);
  });

  /* Windows: 整层永远穿透, 退出靠桥的钩子. mac 没有钩子, 才按热区关穿透. */
  ipcMain.on('overlay:set-ignore-mouse', (e, ignore: unknown) => {
    if (!isFromOverlayWindow(e.sender.id)) return;
    if (process.platform === 'win32') return;
    const win = getOverlayWindow();
    if (!win || win.isDestroyed()) return;
    setOverlayClickThrough(win, ignore !== false);
  });

  ipcMain.on('overlay:stop', (e) => {
    if (!isFromOverlayWindow(e.sender.id)) return;
    console.log('[computerOverlay] 用户点了停止');
    try { opts.onUserStop?.(); } catch (err) {
      console.warn('[computerOverlay] onUserStop failed:', err);
    }
    applySessionEvent('user_stop');
  });

  ipcMain.on('overlay:pointer', (_e, evt: OverlayPointerPayload) => {
    if (!evt || typeof evt.x !== 'number' || typeof evt.y !== 'number') return;
    pushOverlayPointer(getOverlayWindow(), evt);
  });

  attachToOsPointerBridge(opts);
  const warm = (): void => { void prewarmOverlay({ isDev: opts.isDev, dirname: opts.dirname }); };
  if (app.isReady()) warm();
  else void app.whenReady().then(warm);
}

const USER_STOP_FLAG = join(tmpdir(), 'neox-os-bridge.user-stop');

let idleTimer: NodeJS.Timeout | null = null;
let stopFlagTimer: NodeJS.Timeout | null = null;
let lastStopFlagMtime = 0;
let optsCached: RegisterComputerOverlayIpcHandlersOpts | null = null;
let offPointerBridge: (() => void) | null = null;

function toOverlayLocal(x: number, y: number): { x: number; y: number } {
  const win = getOverlayWindow();
  const b = win && !win.isDestroyed() ? win.getBounds() : { x: 0, y: 0 };
  if (process.platform === 'win32') {
    const dip = screen.screenToDipPoint({ x, y });
    return { x: dip.x - b.x, y: dip.y - b.y };
  }
  return { x: x - b.x, y: y - b.y };
}

function cursorOnOverlay(): { x: number; y: number } {
  const pt = screen.getCursorScreenPoint();
  const win = getOverlayWindow();
  const b = win && !win.isDestroyed() ? win.getBounds() : { x: 0, y: 0 };
  return { x: pt.x - b.x, y: pt.y - b.y };
}

function clearWatchdog(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function armWatchdog(ms: number): void {
  clearWatchdog();
  idleTimer = setTimeout(() => {
    idleTimer = null;
    applySessionEvent('session_end');
  }, ms);
}

function forceIdle(): void {
  overlaySession = createOverlaySession();
  lastPointer = null;
  lastState = { visible: false, app: lastState.app };
  setOverlayWanted(false);
  clearWatchdog();
  const win = getOverlayWindow();
  if (win && !win.isDestroyed()) {
    pushOverlayState(win, lastState);
    setOverlayClickThrough(win, true);
  }
  hideOverlay();
}

function hideNow(): void {
  lastPointer = null;
  lastState = { visible: false, app: lastState.app };
  setOverlayWanted(false);
  clearWatchdog();
  const win = getOverlayWindow();
  if (win && !win.isDestroyed()) {
    pushOverlayState(win, lastState);
    setOverlayClickThrough(win, true);
  }
  hideOverlay();
}

function applySessionEvent(event: 'session_start' | 'session_end' | 'user_stop' | 'action'): 'show' | 'hide' | 'stay' {
  const next = reduceOverlaySession(overlaySession, event);
  overlaySession = next.state;
  if (next.command === 'hide') hideNow();
  return next.command;
}

function armUserStopFlagWatch(onStop: () => void): void {
  if (stopFlagTimer) return;
  try { writeFileSync(USER_STOP_FLAG, '0'); } catch { /* ignore */ }
  try { lastStopFlagMtime = statSync(USER_STOP_FLAG).mtimeMs; } catch { lastStopFlagMtime = Date.now(); }
  stopFlagTimer = setInterval(() => {
    try {
      const st = statSync(USER_STOP_FLAG);
      if (st.mtimeMs <= lastStopFlagMtime) return;
      lastStopFlagMtime = st.mtimeMs;
      const v = readFileSync(USER_STOP_FLAG, 'utf8').trim();
      if (!v || v === '0') return;
      onStop();
    } catch { /* 旗标还没写 */ }
  }, 16);
}

function attachToOsPointerBridge(opts: RegisterComputerOverlayIpcHandlersOpts): void {
  if (optsCached) return;
  optsCached = opts;
  armUserStopFlagWatch(() => {
    try { opts.onUserStop?.(); } catch { /* ignore */ }
    applySessionEvent('user_stop');
  });
  try {
    const off = onComputerPointer((e) => {
      const kind = classifyPointerAction(e.action);
      if (kind === 'ignore') return;

      if (kind === 'user_stop') {
        try { opts.onUserStop?.(); } catch { /* ignore */ }
        applySessionEvent('user_stop');
        return;
      }

      const appName = e.app ?? lastState.app ?? '';
      const command = applySessionEvent(kind);

      if (kind === 'session_end') {
        return;
      }

      if (command === 'hide') return;

      lastState = { visible: true, app: appName };
      setOverlayWanted(true);
      const hold = overlayHoldMs(kind, e.label);
      if (hold != null) armWatchdog(hold);

      const { x: px, y: py } = e;
      const local = typeof px === 'number' && typeof py === 'number' && px >= 0 && py >= 0
        ? toOverlayLocal(px, py)
        : cursorOnOverlay();
      const payload: OverlayPointerPayload = {
        app: appName,
        action: e.action,
        label: e.label ?? '',
        x: local.x,
        y: local.y,
        phase: e.phase === 'move' ? 'move' : e.phase === 'done' ? 'done' : 'act',
        risk: e.risk ?? 'safe',
      };
      lastPointer = payload;

      void showOverlay(opts).then((win) => {
        if (!win || win.isDestroyed() || !isOverlayWanted()) return;
        setOverlayClickThrough(win, true);
        pushOverlayState(win, lastState);
        pushOverlayPointer(win, payload);
      });
    });
    offPointerBridge = off;
  } catch (err: any) {
    console.warn('[computerOverlayHandlers] 指针事件订阅失败:', err?.message ?? err);
  }
}

export function detachComputerOverlayFromOsBridge(): void {
  offPointerBridge?.();
  offPointerBridge = null;
  clearWatchdog();
  if (stopFlagTimer) {
    clearInterval(stopFlagTimer);
    stopFlagTimer = null;
  }
  optsCached = null;
  overlaySession = createOverlaySession();
}

function isFromOverlayWindow(senderId: number): boolean {
  const win = getOverlayWindow();
  return win !== null && win.webContents.id === senderId;
}
