import { app, BrowserWindow, dialog, nativeTheme, screen, session } from 'electron';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, relative, resolve } from 'path';
import { applyApplicationMenuForMode } from './applicationMenu.js';
import { attachDevPreloadReloader, resolveElectronPreloadPath } from './devPreload.js';
import { ensureDevServer } from './devServerKeeper.js';
import { storageService } from '../../../platform-electron/storageService.js';
import { isSafeWebExternalUrl, openSafeWebExternalUrl } from '../ipc/safeExternalOpen.js';
import { loadAppNativeImage, resolveAppIconPath, logAppIconDiagnostics } from './appIcon.js';
import { isWindowsAppQuitting, isWindowsTrayActive } from './windowsTray.js';
import { reapplyAppBadge } from './appBadge.js';
import { registerSurfacePopout } from './surfacePopouts.js';

/**
 * 红绿灯位置 —— **唯一真相源**。
 *
 * 构造时给一次 (trafficLightPosition) 之外, 还要在全屏/换屏/恢复之后反复重设
 * (见下面的 applyTrafficLightPosition)。两处必须用同一个常量, 各写一份数字的话
 * 改了一处另一处就悄悄不一致 —— 而这种不一致只在做过全屏/换屏之后才看得见。
 */
const TRAFFIC_LIGHT_POSITION = { x: 16, y: 14 } as const;

const DARK_THEME_PACK_IDS = new Set([
  'anye',
  'muyunqing',
  'songyanmo',
  'wumoyan',
  'haiyue',
  'neonlight',
  'matrix',
  'jiguang',
  'vaporwave',
]);

const THEME_PACK_STARTUP_BG: Record<string, string> = {
  anye: '#1b1916',
  muyunqing: '#111216',
  songyanmo: '#1B1B1B',
  wumoyan: '#17181b',
  haiyue: '#101010',
  neonlight: '#181818',
  matrix: '#101010',
  jiguang: '#111216',
  vaporwave: '#17181b',
  liulibasic: '#fbfbfa',
};

async function resolveInitialBackgroundColor(): Promise<string> {
  try {
    const ui = await storageService.loadUIState();
    const packId = (ui as unknown as { themePackId?: string }).themePackId ?? await storageService.getThemePackId();
    if (packId) {
      if (THEME_PACK_STARTUP_BG[packId]) return THEME_PACK_STARTUP_BG[packId];
      return DARK_THEME_PACK_IDS.has(packId) ? '#111216' : '#fbfbfb';
    }
    const dark = ui.darkModePreference === 'light' ? false :
      ui.darkModePreference === 'dark' || ui.darkModePreference === 'midnight' || ui.darkModePreference === 'high-contrast' ? true :
      nativeTheme.shouldUseDarkColors; /* auto/undefined → 跟系统; 硬判 dark 会让浅色系统下标题栏控件白图标压浅 app */
    /* themePreset 是 v2 兼容字段. 没存 → undefined → 默认色. */
    const preset = (ui as unknown as { themePreset?: string }).themePreset;
    if (preset === 'nuanyang') return '#fbf7f0';
    if (preset === 'moye') return '#101115';
    return dark ? '#1e1f22' : '#fbfbfb';
  } catch {
    /* storage 没起 / 出错 → 走浅白默认, 避免首次启动闪暗色. */
    return '#fbfbfa';
  }
}

const appPageCsp = (): string =>
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' data: https://fonts.gstatic.com; " +
  "img-src 'self' data: blob: neox-asset: https:; " +
  "frame-src 'self' neox-plugin:; " +
  `connect-src 'self' ${cloudConnectSrc()}`;

function cloudConnectSrc(): string {
  const origins = new Set<string>();
  const add = (raw: string | undefined): void => {
    if (!raw) return;
    try {
      const u = new URL(raw);
      origins.add(u.origin);
      /* http(s) 对应的 ws(s) — 云端中继 / 实时通道走 WebSocket 时同样受 connect-src 管 */
      origins.add(u.origin.replace(/^http/, 'ws'));
    } catch { /* 配歪了就跳过, 不能让 CSP 拼装本身炸掉窗口创建 */ }
  };
  add(process.env.NEOX_API_BASE);
  add(process.env.NEOX_GATEWAY_BASE);
  add(process.env.NEOX_WEB_BASE);
  /* 本地控制面 — dev 起本机 NeoxCloud 时用, 跟线上互不影响 */
  add('http://localhost:3721');
  add('http://127.0.0.1:3721');
  return [...origins].join(' ');
}

/** 请求是否属于 app 自身页面 — 打包后的 file:// 页面, 或 Vite dev server 同源页面. */
function isAppPageUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === 'file:') return true;
    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    if (!devServerUrl) return false;
    return url.origin === new URL(devServerUrl).origin;
  } catch {
    return false;
  }
}

/* onHeadersReceived 每个 session 只能挂一个 listener (再挂会覆盖前一个),
 * 用模块级标志保证多窗口场景只注册一次. 主窗永远先于桌宠/BrowserView 创建
 * (后两者都由主窗 renderer 通过 IPC 触发), 首窗注册即覆盖全部. */
let appPageCspInstalled = false;

function installAppPageCspOnce(): void {
  if (appPageCspInstalled) return;
  appPageCspInstalled = true;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (!isAppPageUrl(details.url)) {
      callback({}); /* 非 app 页面 (BrowserView 外站等) — 不动任何 header */
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [appPageCsp()],
        /* 允许主进程在窗口「未响应」时抓 JS 栈 (bootstrap/hangMonitor.ts) */
        'Document-Policy': ['include-js-call-stacks-in-crash-reports'],
      },
    });
  });
}

interface CreateMainWindowOptions {
  isDev: boolean;
  dirname: string;
  /**
   * 可选: 让新窗口启动时自动打开这个 workspace.
   * 通过 URL query param `?workspace=<encoded>` 传给 renderer,
   * AppShell 在 useEffect 里读取并调 setWorkspace.
   * 用于 IDEA 的 "在新窗口打开项目" 场景.
   */
  initialWorkspacePath?: string;
}

// 保留 window, 但在某些 macOS + 多窗口场景下 JS 侧缺失引用会触发奇怪的
// sandbox init 问题. 这里显式 pin 住, window close 时自动清掉.
const liveWindows = new Set<BrowserWindow>();

function normalizeForCompare(filePath: string): string {
  return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
}

function isPathInside(basePath: string, targetPath: string): boolean {
  const base = normalizeForCompare(resolve(basePath));
  const target = normalizeForCompare(resolve(targetPath));
  if (base === target) return true;
  const rel = relative(base, target);
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
}

function isSameOriginUrl(rawUrl: string, rawBaseUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const base = new URL(rawBaseUrl);
    return url.origin === base.origin;
  } catch {
    return false;
  }
}

function isAllowedRendererFileUrl(rawUrl: string, rendererRoot: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'file:') return false;
    return isPathInside(rendererRoot, fileURLToPath(url));
  } catch {
    return false;
  }
}

/** 窗口在启动过程中被销毁 —— 不是故障, 是用户关掉了 / 单实例竞态 / 渲染进程带走了它。
 *  用独立类型标记, 让启动链的 catch 能区分"真的起不来"和"窗口没了", 后者不该弹错误框。 */
export class WindowGoneError extends Error {
  readonly windowGone = true;
  constructor(message: string) {
    super(message);
    this.name = 'WindowGoneError';
  }
}

export async function createMainWindow(options: CreateMainWindowOptions): Promise<BrowserWindow> {
  const {
    isDev,
    dirname,
    initialWorkspacePath,
  } = options;

  /* Win/mac/linux: resolveAppIconPath 优先 resources/ 再 asar assets。
   * 旧 Win 路径依赖 process.cwd()/build/icon.ico，安装后 cwd 不对 → 任务栏掉回 Electron 原子标。 */
  const iconPath = resolveAppIconPath(dirname);
  const appIconImage = loadAppNativeImage(dirname);

  /* Windows 上无条件打一次图标自检 —— 用户仍在 3.1.7 上看到 Electron 原子标, 而代码层面
   * 该走的路都走了, 缺的是现场数据。其它平台只在真的解不出图时才打, 免得刷屏。 */
  if (process.platform === 'win32' || !appIconImage || appIconImage.isEmpty()) {
    logAppIconDiagnostics(dirname);
  }

  if (process.platform === 'darwin' && app.dock) {
    try {
      /* Electron / 未签名包 Dock 不会自动套 squircle，图标必须自带圆角+透明四角。
       * PNG 优先：createFromPath 对带透明的 icns 偶发 empty，PNG 更稳。 */
      if (appIconImage && !appIconImage.isEmpty()) {
        app.dock.setIcon(appIconImage);
      } else {
        console.error('[Icon] Dock icon not found / empty');
      }
    } catch (error) {
      console.error('[Icon] Failed to set dock icon:', error);
    }
  }

  const initialBg = await resolveInitialBackgroundColor();
  const preloadPath = resolveElectronPreloadPath({ isDev, dirname, fileName: 'preload.cjs' });

  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const defaultWidth = Math.max(1350, Math.min(1500, workArea.width - 80));
  const defaultHeight = Math.max(760, Math.min(880, workArea.height - 60));

  const mainWindow = new BrowserWindow({
    width: defaultWidth,
    height: defaultHeight,
    minWidth: 800,
    minHeight: 540,
    title: 'Neox',
    backgroundColor: initialBg,
    ...(process.platform === 'darwin'
      ? {
        titleBarStyle: 'hiddenInset' as const,
        trafficLightPosition: { ...TRAFFIC_LIGHT_POSITION },
      }
      : {}),
    ...(process.platform === 'win32'
      ? {
        /* hidden 无原生标题栏; 不用 titleBarOverlay —
         * OS 三大金刚永远叠在网页上无法融入 UI, 改由 renderer 自绘 WinWindowControls. */
        titleBarStyle: 'hidden' as const,
        backgroundMaterial: 'none' as const,
        autoHideMenuBar: true,
      }
      : {}),
    show: false,
    icon: iconPath,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  liveWindows.add(mainWindow);
  mainWindow.once('closed', () => { liveWindows.delete(mainWindow); });

  if (process.platform === 'win32') {
    mainWindow.on('close', (event) => {
      if (isWindowsTrayActive() && !isWindowsAppQuitting()) {
        event.preventDefault();
        mainWindow.hide();
      }
    });
  }

  /* Win taskbar / alt-tab: re-apply icon after construct.
   *
   * Win10: MUST pass the .ico **file path string** to setIcon. Passing a
   * NativeImage decoded from a multi-size ICO often leaves the taskbar on the
   * Electron atom (Win11 is more forgiving with NativeImage). Prefer the path
   * we already resolved for BrowserWindow({ icon }). */
  try {
    if (process.platform === 'win32' && iconPath) {
      mainWindow.setIcon(iconPath);
    } else if (appIconImage && !appIconImage.isEmpty()) {
      mainWindow.setIcon(appIconImage);
    } else if (process.platform === 'win32') {
      console.error('[Icon] Windows app icon missing — taskbar may show Electron default');
    }
  } catch (err) {
    console.warn('[Icon] setIcon failed:', err);
  }
  reapplyAppBadge();

  /* Win 自绘窗控：把 maximize 状态推给 renderer */
  if (process.platform === 'win32') {
    const pushMaximized = () => {
      if (mainWindow.isDestroyed()) return;
      try {
        mainWindow.webContents.send('window:maximized-changed', mainWindow.isMaximized());
      } catch { /* ignore */ }
    };
    mainWindow.on('maximize', pushMaximized);
    mainWindow.on('unmaximize', pushMaximized);
  }

  const pushFullScreen = () => {
    if (mainWindow.isDestroyed()) return;
    try {
      mainWindow.webContents.send('window:fullscreen-changed', mainWindow.isFullScreen());
    } catch { /* ignore */ }
  };
  mainWindow.on('enter-full-screen', pushFullScreen);
  mainWindow.on('leave-full-screen', pushFullScreen);
  /* 首帧: renderer 可能在窗口已是全屏时才挂载 (譬如 reload), 事件早就过去了 */
  mainWindow.webContents.on('did-finish-load', pushFullScreen);

  if (process.platform === 'darwin') {
    const applyTrafficLightPosition = (): void => {
      if (mainWindow.isDestroyed()) return;
      try {
        mainWindow.setWindowButtonPosition(
          mainWindow.isFullScreen() ? null : { ...TRAFFIC_LIGHT_POSITION },
        );
      } catch { /* 老版本 Electron 没有这个 API —— 保持构造参数给的位置 */ }
    };
    mainWindow.on('enter-full-screen', applyTrafficLightPosition);
    mainWindow.on('leave-full-screen', applyTrafficLightPosition);
    mainWindow.on('restore', applyTrafficLightPosition);
    mainWindow.on('show', applyTrafficLightPosition);
    /* 换屏: 'moved' 在拖动中会高频触发, 但这个调用足够便宜, 不额外做节流 ——
     * 加节流反而会在"拖到另一块屏后松手"那一刻留下一个错位的窗口。 */
    mainWindow.on('moved', applyTrafficLightPosition);
    const onDisplayChanged = (): void => applyTrafficLightPosition();
    screen.on('display-metrics-changed', onDisplayChanged);
    screen.on('display-added', onDisplayChanged);
    screen.on('display-removed', onDisplayChanged);
    mainWindow.on('closed', () => {
      screen.removeListener('display-metrics-changed', onDisplayChanged);
      screen.removeListener('display-added', onDisplayChanged);
      screen.removeListener('display-removed', onDisplayChanged);
    });
  }

  if (app.isPackaged && process.env.NEOX_DEV_ALLOW !== '1') {
    mainWindow.webContents.on('devtools-opened', () => {
      try { mainWindow.webContents.closeDevTools(); } catch { /* ignore */ }
    });
  }
  attachDevPreloadReloader(mainWindow, {
    isDev,
    preloadPath,
    windowLabel: 'mainWindow',
  });

  /* 诊断: 主窗口生命周期事件全打日志 — 桌宠开启后主窗口消失这种症状,
   * 是真 close / 还是 hide / 还是 minimize / 还是被推到 Space 外, 日志一看便知.
   * 生产默认静音 (审计 P2): 高频窗口事件刷 stdout 无意义, NEOX_DEBUG/CLI_DEBUG 显式开. */
  if (process.env.NEOX_DEBUG || process.env.CLI_DEBUG) {
    mainWindow.on('hide',     () => { console.log('[mainWindow] hide event'); });
    mainWindow.on('show',     () => { console.log('[mainWindow] show event'); });
    mainWindow.on('minimize', () => { console.log('[mainWindow] minimize event'); });
    mainWindow.on('restore',  () => { console.log('[mainWindow] restore event'); });
    mainWindow.on('blur',     () => { console.log('[mainWindow] blur (lost focus)'); });
    mainWindow.on('focus',    () => { console.log('[mainWindow] focus (gained focus)'); });
    mainWindow.on('close',    () => { console.log('[mainWindow] close event'); });
  }
  if (process.platform === 'win32') {
    let imeComposing = false;
    mainWindow.webContents.on('before-input-event', (_event, input) => {
      if (typeof input.isComposing === 'boolean') imeComposing = input.isComposing;
    });
    mainWindow.on('focus', () => {
      try {
        if (imeComposing) return;
        if (mainWindow.webContents.isFocused()) return;
        mainWindow.webContents.focus();
      } catch { /* 窗口销毁竞态, 忽略 */ }
    });
  }
  const CRASH_LOOP_WINDOW_MS = 60_000;
  const CRASH_LOOP_MAX = 3;
  let crashTimestamps: number[] = [];
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[mainWindow] render-process-gone:', details);
    /* clean-exit = 正常销毁 (关窗/reload 自身), 不干预 */
    if (details.reason === 'clean-exit' || mainWindow.isDestroyed()) return;
    const now = Date.now();
    crashTimestamps = crashTimestamps.filter((t) => now - t < CRASH_LOOP_WINDOW_MS);
    crashTimestamps.push(now);
    if (crashTimestamps.length < CRASH_LOOP_MAX) {
      console.warn(`[mainWindow] renderer crashed (${details.reason}), auto-reloading (${crashTimestamps.length}/${CRASH_LOOP_MAX})`);
      try { mainWindow.webContents.reload(); } catch { /* webContents 同时被销毁 — 忽略 */ }
      return;
    }
    void dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: '界面进程已崩溃',
      message: `Neox 界面进程短时间内多次崩溃 (${details.reason})`,
      detail: '会话数据保存在本地数据库中, 不会丢失。可尝试重新加载; 若反复崩溃, 请重启应用并反馈 ~/.neox/logs 下的崩溃档案。',
      buttons: ['重新加载', '关闭窗口'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (mainWindow.isDestroyed()) return;
      if (response === 0) {
        crashTimestamps = [];
        try { mainWindow.webContents.reload(); } catch { /* ignore */ }
      } else {
        mainWindow.close();
      }
    }).catch(() => { /* 窗口销毁中弹框失败 — 忽略 */ });
  });

  /* 生产 CSP — session 级一次性注册, 覆盖主窗 + 桌宠 (都走 defaultSession 的 file:// 页面).
   * dev 不挂: Vite HMR / react-refresh 需要 inline script + ws, 会被 script-src 'self' 拦死. */
  if (!isDev) {
    installAppPageCspOnce();
  }

  applyApplicationMenuForMode();

  // chat:stream 订阅 + token/memory 副作用已迁到 main.ts 的 per-scope AGENT_BRIDGE
  // factory. 这里不再订阅 legacy bridge —— 否则多窗口会 N× 触发副作用.

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  const devServerUrlForNavigation = process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5180';
  const rendererRoot = resolve(join(dirname, '../renderer'));

  mainWindow.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (url === 'about:blank' && frameName.startsWith('neox-sfc-pop:')) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          minWidth: 320,
          minHeight: 220,
          show: true,
          fullscreenable: true,
          titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
          trafficLightPosition: { x: 14, y: 13 },
          backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1f22' : '#fbf7f0',
          autoHideMenuBar: true,
        },
      };
    }
    if (isSafeWebExternalUrl(url)) {
      void openSafeWebExternalUrl(url).catch((err) => {
        console.warn('[Main] external open blocked/failed:', err?.message || err);
      });
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-create-window', (child, details) => {
    /* 层级 / 收到屏幕边上 / 探出 / 钉住 / 挪动事件, 见 surfacePopouts.ts */
    if (details.frameName?.startsWith('neox-sfc-pop:')) registerSurfacePopout(child, details.frameName, mainWindow);
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (
      (isDev && isSameOriginUrl(url, devServerUrlForNavigation))
      || (!isDev && isAllowedRendererFileUrl(url, rendererRoot))
    ) {
      return;
    }
    event.preventDefault();
    if (isSafeWebExternalUrl(url)) {
      void openSafeWebExternalUrl(url).catch((err) => {
        console.warn('[Main] external navigate open blocked/failed:', err?.message || err);
      });
    }
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;

  // 如果有 initialWorkspacePath, 拼 query param; renderer AppShell 启动时读.
  const workspaceQuery = initialWorkspacePath
    ? `workspace=${encodeURIComponent(initialWorkspacePath)}`
    : '';

  const devBase = (devServerUrl || 'http://127.0.0.1:5180').replace(/\/+$/, '');

  /**
   * 加载 dev server URL。vite 不在就先把它拉起来 (见 devServerKeeper) 再 load,
   * 而不是干等或退回生产产物 —— dev 流程根本不生成 `../renderer/index.html`,
   * 退回去只会得到一句误导人的 ERR_FILE_NOT_FOUND.
   */
  const loadDevUrl = async (): Promise<void> => {
    // 关键: 用 `${base}/?q=...` 而不是 `${base}?q=...` —— 后者在部分 HTTP
    // 客户端/服务器组合下 (Vite + base:'./' 配置) 会被判定为畸形, 直接 ERR_FAILED.
    const fullUrl = workspaceQuery ? `${devBase}/?${workspaceQuery}` : devBase;
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await ensureDevServer(devBase, dirname);
      try {
        await mainWindow.loadURL(fullUrl);
        return;
      } catch (err: any) {
        if (mainWindow.isDestroyed()) throw err;
        if (attempt === maxAttempts) throw err;
        console.warn(`[Main] loadURL attempt ${attempt}/${maxAttempts} failed: ${err?.message}. Retrying...`);
        await new Promise(r => setTimeout(r, 500));
      }
    }
  };

  // dev 模式: vite 在运行期间死掉 (改配置自杀 / 端口被抢 / 被 kill) 会让 renderer
  // 变白屏。这里盯着 did-fail-load, 把 vite 拉回来后自动重载, 不用手动重启桌面。
  if (isDev) {
    let reviving = false;
    mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDesc, failedUrl, isMainFrame) => {
      if (!isMainFrame || reviving || mainWindow.isDestroyed()) return;
      if (failedUrl && !failedUrl.startsWith(devBase)) return;
      reviving = true;
      console.warn(`[Main] dev renderer 加载失败 (${errorCode} ${errorDesc}) —— 尝试拉回 vite 并重载`);
      void ensureDevServer(devBase, dirname)
        .then(ok => {
          if (ok && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
        })
        .finally(() => {
          reviving = false;
        });
    });
  }

  try {
    if (isDev && process.env.NEOX_PROD_RENDERER !== '1') {
      await loadDevUrl();
    } else {
      await mainWindow.loadFile(join(dirname, '../renderer/index.html'), {
        search: workspaceQuery || undefined,
      });
    }
  } catch (error) {
    if (isDev) {
      // dev 下没有生产产物可退 —— 退回去只会把「vite 没起来」伪装成「打包坏了」。
      console.error(
        `[Main] dev renderer 加载失败, 且 ${devBase} 上的 vite 拉不起来。` +
          `手动看一眼: \`npm run ui:dev\` 或 \`lsof -i:5180\`。原始错误:`,
        error,
      );
      throw error;
    }
    if (mainWindow.isDestroyed()) {
      console.warn('[Main] renderer 加载中窗口已销毁 (关闭/单实例竞态), 跳过 fallback');
      throw new WindowGoneError('window destroyed during initial load');
    }
    console.error('[Main] Failed to load renderer, trying fallback index.html:', error);
    try {
      await mainWindow.loadFile(join(dirname, '../renderer/index.html'), {
        search: workspaceQuery || undefined,
      });
    } catch (fallbackErr) {
      if (mainWindow.isDestroyed()) {
        console.warn('[Main] fallback 期间窗口已销毁, 安静退出');
        throw new WindowGoneError('window destroyed during fallback load');
      }
      console.error('[Main] Fallback loadFile failed:', fallbackErr);
      throw fallbackErr;
    }
  }

  return mainWindow;
}
