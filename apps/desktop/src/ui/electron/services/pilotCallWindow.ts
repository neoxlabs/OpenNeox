
import { BrowserWindow, screen } from 'electron';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { attachDevPreloadReloader, resolveElectronPreloadPath } from './devPreload.js';
import { resolveAppIconPath } from './appIcon.js';

export interface CallWindowOpts {
  isDev: boolean;
  dirname: string;
}

export const CALL_CARD_PAD = { top: 14, x: 26, bottom: 36 } as const;
export const CALL_WINDOW_SIZE = {
  ringing: { w: 368 + CALL_CARD_PAD.x * 2, h: 136 + CALL_CARD_PAD.top + CALL_CARD_PAD.bottom },
  active: { w: 328 + CALL_CARD_PAD.x * 2, h: 100 + CALL_CARD_PAD.top + CALL_CARD_PAD.bottom },
} as const;
/* 卡片 (不是窗口) 离屏幕右边 20 / 上边 14; 窗口本身比卡片多出阴影留白 */
const EDGE_X = 20 - CALL_CARD_PAD.x;
const EDGE_Y = Math.max(0, 14 - CALL_CARD_PAD.top);

let callWindow: BrowserWindow | null = null;

export function getCallWindow(): BrowserWindow | null {
  return callWindow && !callWindow.isDestroyed() ? callWindow : null;
}

/** 光标所在屏的右上角 (workArea, 不压菜单栏) */
function topRight(w: number): { x: number; y: number } {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  return { x: d.workArea.x + d.workArea.width - w - EDGE_X, y: d.workArea.y + EDGE_Y };
}

export async function openCallWindow(opts: CallWindowOpts): Promise<BrowserWindow> {
  const existing = getCallWindow();
  if (existing) return existing;

  const preloadPath = resolveElectronPreloadPath({ isDev: opts.isDev, dirname: opts.dirname, fileName: 'preload-call.cjs' });
  if (!existsSync(preloadPath)) {
    throw new Error(`preload-call.cjs not found at ${preloadPath}. Run 'npm run ui:build-electron' to refresh.`);
  }
  const { w, h } = CALL_WINDOW_SIZE.ringing;
  const pos = topRight(w);
  const win = new BrowserWindow({
    x: pos.x,
    y: pos.y,
    width: w,
    height: h,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    show: false,
    icon: resolveAppIconPath(opts.dirname),
    title: 'neox-pilot-call',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      /* 响铃要准时: 窗口没焦点也不许把计时器节流成 1 秒一跳 */
      backgroundThrottling: false,
      devTools: opts.isDev,
    },
  });
  callWindow = win;
  /* 全屏应用 / 其它桌面上也要看得见 —— 电话不能只在当前桌面响 */
  try { win.setAlwaysOnTop(true, 'pop-up-menu'); } catch { /* ignore */ }
  try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true }); } catch { /* ignore */ }

  attachDevPreloadReloader(win, { isDev: opts.isDev, preloadPath, windowLabel: 'pilotCallWindow' });
  win.once('closed', () => { if (callWindow === win) callWindow = null; });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('render-process-gone', () => {
    /* 置顶透明窗崩了会变成一块点不掉的空白, 直接销毁 */
    if (!win.isDestroyed()) win.destroy();
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (opts.isDev && devServerUrl) {
    await win.loadURL(`${devServerUrl.replace(/\/+$/, '')}/call.html`);
  } else {
    const file = join(resolve(join(opts.dirname, '../renderer')), 'call.html');
    if (!existsSync(file)) {
      win.destroy();
      throw new Error(`call.html not found at ${file}`);
    }
    await win.loadFile(file);
  }
  return win;
}

/** 响铃态 / 通话态两种尺寸, 始终贴右上角 */
export function setCallWindowLayout(layout: 'ringing' | 'active'): void {
  const win = getCallWindow();
  if (!win) return;
  const { w, h } = CALL_WINDOW_SIZE[layout];
  const b = win.getBounds();
  /* 用户拖过就留在他拖的那一列, 只改尺寸; 没拖过贴回右上角 */
  const pos = topRight(w);
  const dragged = Math.abs(b.x + b.width - (pos.x + w)) > 4 || Math.abs(b.y - pos.y) > 4;
  win.setBounds(dragged ? { x: b.x + b.width - w, y: b.y, width: w, height: h } : { ...pos, width: w, height: h });
  if (!win.isVisible()) win.showInactive();
}

export function closeCallWindow(): void {
  const win = getCallWindow();
  if (win) {
    try { win.destroy(); } catch { /* ignore */ }
  }
  callWindow = null;
}
