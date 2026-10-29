/**
 * computerOverlayWindowFactory — main 进程的 "computer use 被操控" 叠加层窗口管理器
 *
 * 单例模式: 同时只有一层叠加. agent 开始操作 → showOverlay(), 结束 → hideOverlay()/destroyOverlay().
 *
 * 跟桌宠窗口 (petWindowFactory) 的关键差异:
 *   · 尺寸 = 虚拟屏整屏 (所有显示器的并集), 不是角落小窗
 *   · 点击永远穿透, 好让桥的 SendInput 打到下面的真实应用.
 *     用户鼠标由桥的低级钩子拦住, 不是靠这层窗去吞.
 *     Windows「退出」热区在桥里 (跟 overlay-entry #overlay-stop 同尺寸).
 *     mac 没有钩子, 才按按钮 hover 临时关掉穿透.
 *   · 不可移动 / 不可缩放 / 无阴影 —— 它是一层画, 不是窗
 *
 * 窗口配置 (跟桌宠同款的最小干扰组合):
 *   frame:false / transparent:true / alwaysOnTop:true / skipTaskbar:true
 *   hasShadow:false / focusable:false / show:false(等 ready-to-show) / backgroundColor:'#00000000'
 *
 * 崩溃兜底: renderer 进程崩掉时销毁窗口 —— 崩掉的透明 always-on-top 全屏窗会变成
 * "幽灵窗", 持续吞掉整屏鼠标事件, 比桌宠那种角落窗危害更大, 必须清干净.
 */

import { BrowserWindow, screen, app } from 'electron';
import { existsSync } from 'fs';
import { join, resolve, relative, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { attachDevPreloadReloader, resolveElectronPreloadPath } from './devPreload.js';
import { resolveAppIconPath } from './appIcon.js';

interface OverlayWindowOpts {
  isDev: boolean;
  /** main.ts 的 __dirname, 用于找 preload-overlay.cjs 和 renderer/overlay.html 路径 */
  dirname: string;
}

let overlayWindow: BrowserWindow | null = null;

/**
 * Win10/11 透明窗的 CSS/canvas 半透明经常合成成「全透明」—— 用户看到的就是没遮罩。
 * 改用实色窗 + DWM 窗口级 opacity, 这条路径系统一定画得出来。
 */
const WIN_DIM = process.platform === 'win32';
/** 窗口级透明度: 太高就是一块实色蓝; 0.25 能看见下面的应用, 像一层薄罩. */
const SHOW_OPACITY = WIN_DIM ? 0.18 : 1;

/** 当前这一轮还要不要给人看. ready-to-show / 截图恢复都看这个, 免得会话已经结束还把窗弹出来闪一下. */
let overlayWanted = false;

export function setOverlayWanted(wanted: boolean): void {
  overlayWanted = wanted;
}

export function isOverlayWanted(): boolean {
  return overlayWanted;
}

/** 当前叠加层窗口 (null 表示不存在) */
export function getOverlayWindow(): BrowserWindow | null {
  return overlayWindow && !overlayWindow.isDestroyed() ? overlayWindow : null;
}

function applyShowOpacity(win: BrowserWindow): void {
  try { win.setOpacity(SHOW_OPACITY); } catch { /* ignore */ }
}

/** Windows 上 {forward:true} 无效还可能让穿透失败, 实色半透明窗就会把所有点击吃掉. */
export function setOverlayClickThrough(win: BrowserWindow, through: boolean): void {
  try {
    if (process.platform === 'win32') win.setIgnoreMouseEvents(through);
    else win.setIgnoreMouseEvents(through, { forward: true });
  } catch {
    try { win.setIgnoreMouseEvents(through); } catch { /* ignore */ }
  }
}

function virtualScreenBounds(): { x: number; y: number; width: number; height: number } {
  const ds = screen.getAllDisplays();
  if (ds.length === 0) return screen.getPrimaryDisplay().bounds;
  const x = Math.min(...ds.map((d) => d.bounds.x));
  const y = Math.min(...ds.map((d) => d.bounds.y));
  const right = Math.max(...ds.map((d) => d.bounds.x + d.bounds.width));
  const bottom = Math.max(...ds.map((d) => d.bounds.y + d.bounds.height));
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * 创建叠加层窗口. 已存在则直接返回, 不重复 spawn.
 */
export async function spawnOverlayWindow(opts: OverlayWindowOpts): Promise<BrowserWindow> {
  const existing = getOverlayWindow();
  if (existing) return existing;

  /* 完整性检查 — preload-overlay.cjs 必须存在, 否则窗口起来但 window.overlayBridge
   * undefined, 叠加层永远收不到事件 (静默失效). 提前 throw 把错误暴露给调用方. */
  const preloadPath = resolveElectronPreloadPath({
    isDev: opts.isDev,
    dirname: opts.dirname,
    fileName: 'preload-overlay.cjs',
  });
  if (!existsSync(preloadPath)) {
    throw new Error(`preload-overlay.cjs not found at ${preloadPath}. Run 'npm run ui:build-electron' to refresh.`);
  }

  const bounds = virtualScreenBounds();
  console.log(`[computerOverlayWindowFactory] spawning overlay window: ${bounds.width}x${bounds.height} @ ${bounds.x},${bounds.y}`);

  /* 局部 ref + 'closed'/'render-process-gone' 身份校验, 修 destroy/spawn race —
   * 跟 petWindowFactory 同一套写法. */
  const newWin = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: !WIN_DIM,
    opacity: SHOW_OPACITY,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    /* 永不抢焦点 — 叠加层只是画, 输入仍由桥的 SendInput 打到目标应用 */
    focusable: false,
    /* Win10 Alt+Tab 会列出 skipTaskbar 窗口; 没设 icon 时就是 Electron 原子标 */
    icon: resolveAppIconPath(opts.dirname),
    show: false,                        /* 等 ready-to-show, 防初帧闪 */
    /* Win: 石板蓝底 + 窗口级 opacity. 纯 #1e3a8a 太艳, canvas 不再叠一层渐变. */
    backgroundColor: WIN_DIM ? '#1e293b' : '#00000000',
    title: 'neox-computer-overlay',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,                   /* 跟 pet 保持出厂行为 —— preload 只 require('electron') */
      backgroundThrottling: false,
      devTools: false,
    },
  });
  overlayWindow = newWin;
  try { newWin.setContentProtection(true); } catch { /* older Electron / 未支持则忽略 */ }
  try { newWin.setAlwaysOnTop(true, 'screen-saver'); } catch {
    try { newWin.setAlwaysOnTop(true); } catch { /* ignore */ }
  }

  /* 永远穿透, 让 SendInput 落到真实应用. Windows 退出靠钩子; mac 才临时关穿透. */
  setOverlayClickThrough(newWin, true);

  attachDevPreloadReloader(newWin, {
    isDev: opts.isDev,
    preloadPath,
    windowLabel: 'overlayWindow',
  });

  newWin.once('ready-to-show', () => {
    console.log(`[computerOverlayWindowFactory] ready-to-show fired, wanted=${overlayWanted}`);
    if (newWin.isDestroyed() || !overlayWanted) return;
    applyShowOpacity(newWin);
    newWin.showInactive();
  });

  newWin.once('closed', () => {
    if (overlayWindow === newWin) overlayWindow = null;
  });

  newWin.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[computerOverlayWindowFactory] did-fail-load: ${code} ${desc} (${url})`);
  });
  newWin.webContents.on('preload-error', (_e, failedPath, err) => {
    console.error(`[computerOverlayWindowFactory] preload-error in ${failedPath}:`, err);
  });
  newWin.webContents.on('render-process-gone', (_e, details) => {
    console.error('[computerOverlayWindowFactory] render-process-gone:', details);
    if (details.reason === 'clean-exit') return;
    /* 全屏透明置顶的"幽灵窗"会持续吞掉整屏鼠标事件 —— 崩溃即销毁, 不做自动 respawn */
    if (!newWin.isDestroyed()) {
      try { newWin.destroy(); } catch { /* ignore */ }
    }
    if (overlayWindow === newWin) overlayWindow = null;
  });

  /* 导航守卫 — 叠加层只显示本地 overlay 页面, 页面内任何跳转都不合法;
   * window.open 一律 deny. */
  newWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  const rendererDir = resolve(join(opts.dirname, '../renderer'));
  const isAllowedNav = (navUrl: string): boolean => {
    try {
      const parsed = new URL(navUrl);
      if (opts.isDev && devServerUrl && parsed.origin === new URL(devServerUrl).origin) return true;
      if (parsed.protocol !== 'file:') return false;
      const target = resolve(fileURLToPath(parsed));
      const rel = relative(rendererDir, target);
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    } catch {
      return false;
    }
  };
  newWin.webContents.on('will-navigate', (event, navUrl) => {
    if (isAllowedNav(navUrl)) return;
    event.preventDefault();
    console.warn(`[computerOverlayWindowFactory] blocked navigation: ${navUrl}`);
  });

  try {
    if (opts.isDev && devServerUrl) {
      const url = `${devServerUrl.replace(/\/+$/, '')}/overlay.html`;
      console.log(`[computerOverlayWindowFactory] loading dev URL: ${url}`);
      await newWin.loadURL(url);
    } else {
      const filePath = join(rendererDir, 'overlay.html');
      console.log(`[computerOverlayWindowFactory] loading file: ${filePath}`);
      if (!existsSync(filePath)) {
        throw new Error(`overlay.html not found at ${filePath}`);
      }
      await newWin.loadFile(filePath);
    }
  } catch (err) {
    console.error('[computerOverlayWindowFactory] load failed, destroying overlay window:', err);
    if (!newWin.isDestroyed()) newWin.destroy();
    if (overlayWindow === newWin) overlayWindow = null;
    throw err;
  }

  return newWin;
}

/** 启动时先把窗建好藏着, 第一次 session_start 就不用等 load. */
export async function prewarmOverlay(opts: OverlayWindowOpts): Promise<void> {
  try {
    await spawnOverlayWindow(opts);
  } catch (err) {
    console.warn('[computerOverlayWindowFactory] prewarm failed:', err);
  }
}

/** 显示叠加层 — 不存在则先创建. 失败时返回 null, 不抛. */
export async function showOverlay(opts: OverlayWindowOpts): Promise<BrowserWindow | null> {
  overlayWanted = true;
  try {
    const win = await spawnOverlayWindow(opts);
    if (!win.isDestroyed()) {
      try { win.webContents.setBackgroundThrottling(false); } catch { /* ignore */ }
      applyShowOpacity(win);
      setOverlayClickThrough(win, true);
      try { win.setAlwaysOnTop(true, 'screen-saver'); } catch { try { win.setAlwaysOnTop(true); } catch { /* ignore */ } }
      if (!win.isVisible()) win.showInactive();
      else win.moveTop();
    }
    return win;
  } catch (err) {
    console.error('[computerOverlayWindowFactory] showOverlay failed:', err);
    return null;
  }
}

/** 隐藏 (但不销毁) 叠加层 — 下次 show 复用同一个窗口, 省一次启动. */
export function hideOverlay(): void {
  overlayWanted = false;
  const win = getOverlayWindow();
  if (win && !win.isDestroyed()) {
    captureHidden = false;
    try { win.setOpacity(0); } catch { /* ignore */ }
    try { win.setAlwaysOnTop(false); } catch { /* ignore */ }
    try { win.webContents.setBackgroundThrottling(true); } catch { /* ignore */ }
    if (win.isVisible()) win.hide();
  }
}

let captureHidden = false;

/** 截图前把 overlay 从屏幕合成里拿掉 (BitBlt 回退会把它拍进去). */
export function hideOverlayForCapture(): void {
  const win = getOverlayWindow();
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  try { win.setOpacity(0); } catch { /* ignore */ }
  captureHidden = true;
}

export function restoreOverlayAfterCapture(): void {
  if (!captureHidden) return;
  captureHidden = false;
  if (!overlayWanted) return;
  const win = getOverlayWindow();
  if (!win || win.isDestroyed()) return;
  applyShowOpacity(win);
}

/** 彻底销毁叠加层窗口 — agent 操作结束后或 app 退出时调用. */
export function destroyOverlayWindow(): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.close();
  }
  overlayWindow = null;
}

/** app 退出时一并清掉叠加层, 不留孤儿 (跟 petWindowFactory 的 before-quit 同款) */
app.on('before-quit', () => {
  destroyOverlayWindow();
});
