/**
 * petWindowFactory — main 进程的桌宠 BrowserWindow 管理器
 *
 * 单例模式: 同时只有一只桌宠. 用户点 PetTab 启用 → spawnPetWindow, 禁用 → destroyPetWindow.
 *
 * 关键配置 (跟主窗口的反向):
 *   frame: false              — 无边框
 *   transparent: true         — 透明背景, 让桌宠浮在桌面之上
 *   alwaysOnTop: true         — 永远在所有 app 之上 (浏览器/编辑器/视频会议都遮不住)
 *   resizable: false          — 用户不能拽边框
 *   skipTaskbar: true         — 不进任务栏 / Dock (桌宠不是独立 app)
 *   hasShadow: false          — macOS 不要矩形阴影 (会破坏宠物 sprite 的圆形 silhouette)
 *   focusable: false          — 永远不抢键盘焦点 (用户主窗口该输入还输入)
 *
 * 性能:
 *   · 独立 renderer process — 桌宠 3D 渲染不影响主窗口 UI 60fps
 *   · webPreferences.sandbox 跟主窗口同款策略 (dev 关, prod 开)
 *   · 不传 backgroundColor — 透明窗口必须 backgroundColor: '#00000000' 才不闪
 *
 * 拖拽:
 *   · main 进程维护 drag session (起点 + 累计 delta)
 *   · pet renderer 每帧 IPC 推 dx/dy, main 用 setBounds 移
 *   · endDrag 时计算最近 corner, smoothMove 200ms 到位
 *
 * 多屏 / DPI:
 *   · 启动位置从持久化拿 (storageService), 没有则按 cfg.corner 算
 *   · 当前屏 (screen.getDisplayMatching) 已断电 → 回主屏右下
 *   · 位置以"屏 workArea (排除 dock / menu bar) 坐标"为准, 不会被任务栏挡
 */

import { BrowserWindow, screen, app } from 'electron';
import { existsSync } from 'fs';
import { join, resolve, relative, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { attachDevPreloadReloader, resolveElectronPreloadPath } from './devPreload.js';
import { resolveAppIconPath } from './appIcon.js';
import { resolveRendererDir } from './petRendererPlugins.js';

interface PetWindowOpts {
  isDev: boolean;
  /** main.ts 的 __dirname, 用于找 preload-pet.cjs 和 renderer/pet.html 路径 */
  dirname: string;
  /** 用户配置里的 size — 决定窗口宽高 */
  size: 'sm' | 'md' | 'lg';
  /** 默认贴靠的角落 — 启动时若没有持久化位置, 用这个 */
  corner: 'br' | 'bl' | 'tr' | 'tl';
  lastPosition?: { x: number; y: number };
  /** 渲染模式 — 3d 必须用 vibrancy widget (macOS WebGL+transparent 死结),
   *  2d/sprite 可以用真·透明窗口, 桌宠彻底"浮"在桌面上无边框. */
  mode: 'svg' | '3d' | '2d' | 'sprite';
}

const SIZE_PX: Record<PetWindowOpts['size'], number> = {
  sm: 96,
  md: 128,
  lg: 180,
};
const PADDING_PX = 24; /* 距屏幕边缘的安全距 */

let petWindow: BrowserWindow | null = null;

/* drag session: pet renderer 调 startDrag 后, main 用 setBounds 平滑 move 整个窗口 */
let dragActive = false;

/** 当前桌宠窗口 (null 表示未启用) */
export function getPetWindow(): BrowserWindow | null {
  return petWindow && !petWindow.isDestroyed() ? petWindow : null;
}

/** 算指定 corner 的窗口左上角坐标 — 基于当前 cursor 所在屏的 workArea */
function cornerPosition(size: number, corner: PetWindowOpts['corner']): { x: number; y: number } {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x: ax, y: ay, width: aw, height: ah } = display.workArea;
  switch (corner) {
    case 'br': return { x: ax + aw - size - PADDING_PX, y: ay + ah - size - PADDING_PX };
    case 'bl': return { x: ax + PADDING_PX,             y: ay + ah - size - PADDING_PX };
    case 'tr': return { x: ax + aw - size - PADDING_PX, y: ay + PADDING_PX };
    case 'tl': return { x: ax + PADDING_PX,             y: ay + PADDING_PX };
  }
}

/** 把 (x, y) 夹紧到 cursor 当前所在屏的 workArea 内 — 防拖出可视区 */
function clampToWorkArea(x: number, y: number, size: number): { x: number; y: number } {
  const display = screen.getDisplayNearestPoint({ x, y });
  const { x: ax, y: ay, width: aw, height: ah } = display.workArea;
  return {
    x: Math.max(ax, Math.min(x, ax + aw - size)),
    y: Math.max(ay, Math.min(y, ay + ah - size)),
  };
}

/** 找最近的角 (松手吸附用) */
function nearestCorner(x: number, y: number, size: number): PetWindowOpts['corner'] {
  const display = screen.getDisplayNearestPoint({ x, y });
  const { x: ax, y: ay, width: aw, height: ah } = display.workArea;
  const midX = ax + aw / 2;
  const midY = ay + ah / 2;
  /* 中心点到窗口中心比 — 用窗口中心 (x + size/2) 跟屏幕中线比 */
  const cx = x + size / 2;
  const cy = y + size / 2;
  if (cx < midX && cy < midY) return 'tl';
  if (cx >= midX && cy < midY) return 'tr';
  if (cx < midX && cy >= midY) return 'bl';
  return 'br';
}

/**
 * 创建桌宠窗口. 已存在则 focus + return existing — 不重复 spawn.
 */
export async function spawnPetWindow(opts: PetWindowOpts): Promise<BrowserWindow> {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.show();
    return petWindow;
  }

  /* 完整性检查 — preload-pet.cjs 必须存在, 否则 BrowserWindow 起来但 window.petBridge
   * undefined, pet 窗口空白. 提前 throw 把错误暴露给 renderer (走 IPC 错误回包). */
  const preloadPath = resolveElectronPreloadPath({
    isDev: opts.isDev,
    dirname: opts.dirname,
    fileName: 'preload-pet.cjs',
  });
  if (!existsSync(preloadPath)) {
    throw new Error(`preload-pet.cjs not found at ${preloadPath}. Run 'npm run ui:build-electron' to refresh.`);
  }
  console.log(`[petWindowFactory] spawning pet window: size=${opts.size}, corner=${opts.corner}, dirname=${opts.dirname}`);

  const size = SIZE_PX[opts.size];
  const pos = opts.lastPosition
    ? clampToWorkArea(opts.lastPosition.x, opts.lastPosition.y, size)
    : cornerPosition(size, opts.corner);

  const needsVibrancy = opts.mode === '3d';
  const newWin = new BrowserWindow({
    width: size,
    height: size,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: !needsVibrancy,   /* 3d=opaque vibrancy, 2d/sprite=fully transparent */
    alwaysOnTop: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: needsVibrancy,        /* 透明窗口不要 macOS 阴影, 那个阴影是方形的会暴露窗口形状 */
    roundedCorners: needsVibrancy,   /* 透明模式不要圆角 (无意义); 3d 模式保留圆角 widget 边缘 */
    /* vibrancy material — 'hud' 是深色半透明, 跟暖阳/晨光浅色主题严重冲突 (用户报"右下角
     *  深色块 跟编辑器背景割裂"). 改 'sidebar' (Finder sidebar 那种浅色 vibrancy), 在 light
     *  theme 下浅, dark theme 下系统会自动加暗滤镜, 双向中性可接受.
     *  vibrancy 是 BrowserWindow 创建时锁定的, 主题切换不能动态换 — 选最中性的一个一劳永逸. */
    vibrancy: needsVibrancy && process.platform === 'darwin' ? 'sidebar' : undefined,
    type: process.platform === 'darwin' ? 'panel' : undefined,
    focusable: false,
    show: false,                       /* 等 ready-to-show, 防初帧白闪 */
    /* Win10 Alt+Tab 会列出 skipTaskbar 窗口; 没设 icon 时就是 Electron 原子标。 */
    icon: resolveAppIconPath(opts.dirname),
    backgroundColor: needsVibrancy
      ? (process.platform === 'darwin' ? undefined : '#1e1e22')
      : '#00000000',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      /* WebGL — Three.js 必需; 失败由 r3f 自带 fallback 处理 */
      webgl: true,
      backgroundThrottling: false,     /* 桌宠失焦时也要继续动画 (default 是失焦降帧) */
      /* 桌宠永远不开 DevTools — Electron 默认菜单的 Cmd+Opt+I 会作用到任意聚焦窗口,
       * 切 mode 触发 respawn 时 pet 窗口短暂聚焦, 用户误触不知不觉就开了一个孤立的
       * DevTools 浮着. 桌宠不是 debug 入口, 直接 false 关 webContents.openDevTools 全路径. */
      devTools: false,
    },
  });
  petWindow = newWin;
  attachDevPreloadReloader(newWin, {
    isDev: opts.isDev,
    preloadPath,
    windowLabel: 'petWindow',
  });

  newWin.once('ready-to-show', () => {
    console.log('[petWindowFactory] ready-to-show fired, showing window');
    newWin.show();
    /* DevTools 自动打开已撤掉 — 老用打扰. 需要时手动: pet 窗口聚焦 Cmd+Opt+I. */
  });

  newWin.once('closed', () => {
    /* 关键: 只在 petWindow 还是 *自己* 时才 null. 否则可能正在 respawn —
     * 老 callback 不能擦掉新 window 的引用. */
    if (petWindow === newWin) {
      petWindow = null;
      dragActive = false;
    }
  });

  /* 监听 webContents 错误事件 — 失败时打 log, 不要静默. */
  newWin.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[petWindowFactory] did-fail-load: ${code} ${desc} (${url})`);
  });
  newWin.webContents.on('preload-error', (_e, preloadPath, err) => {
    console.error(`[petWindowFactory] preload-error in ${preloadPath}:`, err);
  });
  newWin.webContents.on('render-process-gone', (_e, details) => {
    console.error('[petWindowFactory] render-process-gone:', details);
    if (details.reason === 'clean-exit') return;
    if (!newWin.isDestroyed()) {
      try { newWin.destroy(); } catch { /* ignore */ }
    }
    if (petWindow === newWin) {
      petWindow = null;
      dragActive = false;
    }
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
          win.webContents.send('pet:dismissed-by-user');
        }
      } catch { /* 单窗失败不影响其它 */ }
    }
  });

  /* 加载内容 — dev 走 vite server, prod 走打包文件. 3D 模式加载独立的 pet3d.html
   * (three 只在那个 bundle), 其余模式加载核心 pet.html (不含 three).
   * 3D 页面优先用从统一商店下载到 userData 的插件副本, 否则回退核心内置. */
  const petPage = opts.mode === '3d' ? 'pet3d.html' : 'pet.html';
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;

  const allowedFileRoots = [
    resolve(join(opts.dirname, '../renderer')),
    resolve(join(app.getPath('userData'), 'pet-renderers')),
  ];
  const isAllowedPetNavigation = (navUrl: string): boolean => {
    try {
      const parsed = new URL(navUrl);
      if (opts.isDev && devServerUrl && parsed.origin === new URL(devServerUrl).origin) return true;
      if (parsed.protocol !== 'file:') return false;
      const target = resolve(fileURLToPath(parsed));
      return allowedFileRoots.some((root) => {
        const rel = relative(root, target);
        return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
      });
    } catch {
      return false;
    }
  };
  newWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  newWin.webContents.on('will-navigate', (event, navUrl) => {
    if (isAllowedPetNavigation(navUrl)) return;
    event.preventDefault();
    console.warn(`[petWindowFactory] blocked navigation: ${navUrl}`);
  });

  try {
    if (opts.isDev && devServerUrl) {
      const url = `${devServerUrl.replace(/\/+$/, '')}/${petPage}`;
      console.log(`[petWindowFactory] loading dev URL: ${url}`);
      await newWin.loadURL(url);
    } else {
      const bundledRendererDir = join(opts.dirname, '../renderer');
      const rendererDir = resolveRendererDir(opts.mode, bundledRendererDir);
      const filePath = join(rendererDir, petPage);
      console.log(`[petWindowFactory] loading file: ${filePath}`);
      if (!existsSync(filePath)) {
        throw new Error(`${petPage} not found at ${filePath}`);
      }
      await newWin.loadFile(filePath);
    }
  } catch (err) {
    console.error('[petWindowFactory] load failed, destroying pet window:', err);
    if (!newWin.isDestroyed()) newWin.destroy();
    if (petWindow === newWin) petWindow = null;
    throw err;
  }

  return newWin;
}

export function destroyPetWindow(): void {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.close();
  }
  petWindow = null;
  dragActive = false;
}

/* ---------- drag session ---------- */

export function petStartDrag(): void {
  if (!getPetWindow()) return;
  dragActive = true;
}

export function petDrag(dx: number, dy: number): void {
  if (!dragActive) return;
  const win = getPetWindow();
  if (!win) return;
  const [x, y] = win.getPosition();
  const [w] = win.getSize();
  const clamped = clampToWorkArea(x + dx, y + dy, w);
  win.setPosition(Math.round(clamped.x), Math.round(clamped.y), false);
}

export function petEndDrag(opts: { snapToCorner: boolean }): PetWindowOpts['corner'] | null {
  dragActive = false;
  const win = getPetWindow();
  if (!win) return null;
  const [x, y] = win.getPosition();
  const [w] = win.getSize();
  if (!opts.snapToCorner) return nearestCorner(x, y, w);
  const targetCorner = nearestCorner(x, y, w);
  const target = cornerPosition(w, targetCorner);
  /* 简易缓动 — 8 步 / 200ms. 没用 Electron 的 setBounds animate (那是 macOS 限定), 自己做能跨平台. */
  const steps = 8;
  const stepDuration = 200 / steps;
  let i = 0;
  const sx = x;
  const sy = y;
  const dx = target.x - x;
  const dy = target.y - y;
  const interval = setInterval(() => {
    i++;
    const t = i / steps;
    /* easeOutCubic — 接近终点慢, 自然弹一下 */
    const eased = 1 - Math.pow(1 - t, 3);
    const nx = Math.round(sx + dx * eased);
    const ny = Math.round(sy + dy * eased);
    const w2 = getPetWindow();
    if (!w2) { clearInterval(interval); return; }
    w2.setPosition(nx, ny, false);
    if (i >= steps) clearInterval(interval);
  }, stepDuration);
  return targetCorner;
}

export function getPetPosition(): { x: number; y: number } | null {
  const win = getPetWindow();
  if (!win) return null;
  const [x, y] = win.getPosition();
  return { x, y };
}

/** 把桌宠拉到 cursor 所在屏的中间 — debug 用 */
export function recenterPet(): void {
  const win = getPetWindow();
  if (!win) return;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x: ax, y: ay, width: aw, height: ah } = display.workArea;
  const [w, h] = win.getSize();
  win.setPosition(Math.round(ax + (aw - w) / 2), Math.round(ay + (ah - h) / 2), false);
}

/** app 退出时一并清掉桌宠, 不留孤儿 */
app.on('before-quit', () => {
  destroyPetWindow();
});
