import { app, dialog, ipcMain, BrowserWindow, nativeTheme } from 'electron';
import { storageService } from '../../../platform-electron/storageService.js';
import type { ProjectManager } from '../context/ProjectManager.js';
import fs from 'fs/promises';
import path from 'path';
import { rememberUserApprovedPath } from './userApprovedPaths.js';
import { setAppBadgeCount } from '../services/appBadge.js';
import { openPathWithFallback } from './openPathFallback.js';

interface RegisterUIIpcHandlersOptions {
  isDev: boolean;
  appVersion: string;
  projectManager: ProjectManager;
  consumeCachedUIState: () => Promise<any>;
}


const diagnosticsWriteChains = new Map<string, Promise<void>>();

const safeDiagnosticSessionId = (id: string): string => {
  const cleaned = String(id || 'session').replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 96);
  return cleaned || 'session';
};

const diagnosticsDir = (): string => path.join(app.getPath('userData'), 'logs', 'diagnostics');

const appendDiagnosticsLines = async (sessionId: string, lines: string[]): Promise<string> => {
  const dir = diagnosticsDir();
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${safeDiagnosticSessionId(sessionId)}.jsonl`);
  const safeLines = (Array.isArray(lines) ? lines : [])
    .filter((line) => typeof line === 'string' && line.length > 0)
    .map((line) => line.length > 80_000 ? `${line.slice(0, 80_000)}…` : line);
  if (!safeLines.length) return filePath;
  await fs.appendFile(filePath, `${safeLines.join('\n')}\n`, 'utf8');
  return filePath;
};

/** 把 rgb()/rgba()/#hex 规范成 #rrggbb 或 #rrggbbaa；失败返回 null。
 * 必须保留 alpha：Acrylic / 侧透依赖 #00000000，裁成 #000000 会把窗底盖成实黑。 */
function normalizeHexColor(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw) return null;
  const hex3 = raw.match(/^#([0-9a-fA-F]{3})$/);
  if (hex3) {
    const [r, g, b] = hex3[1].split('');
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  const hex6 = raw.match(/^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/);
  if (hex6) {
    const rgb = hex6[1].toLowerCase();
    const alpha = hex6[2]?.toLowerCase();
    return alpha ? `#${rgb}${alpha}` : `#${rgb}`;
  }
  const rgb = raw.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (rgb) {
    const toHex = (n: string) => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, '0');
    const base = `#${toHex(rgb[1])}${toHex(rgb[2])}${toHex(rgb[3])}`;
    if (rgb[4] === undefined) return base;
    const a = Math.round(Math.max(0, Math.min(1, Number(rgb[4]))) * 255)
      .toString(16)
      .padStart(2, '0');
    return `${base}${a}`;
  }
  return null;
}

function luminanceOfHex(hex: string): number {
  const m = hex.replace('#', '');
  if (m.length < 6) return 0;
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function pickSymbolColor(bgHex: string, isDarkFallback: boolean): string {
  const lum = luminanceOfHex(bgHex);
  if (Number.isFinite(lum) && lum > 0) {
    /* 反差拉高: 浅底用近黑, 深底用近白 — Win caption 细线图标需要更亮/更暗才清晰 */
    return lum > 140 ? '#111827' : '#f3f4f6';
  }
  return isDarkFallback ? '#f3f4f6' : '#111827';
}

/** Win11+ (10.0.22000+) 才有 DWM Mica/Acrylic; Win10 调 acrylic 会落成实黑底, 侧透全灭. */
function isWindows11OrNewer(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    const parts = process.getSystemVersion().split('.').map((x) => Number(x) || 0);
    const build = parts[2] ?? 0;
    return build >= 22000;
  } catch {
    return false;
  }
}

function applyWinTitleBarOverlay(
  win: BrowserWindow | null,
  opts: {
    color: string;
    symbolColor: string;
    height?: number;
    /** Win11 材质: acrylic 会跟实色 overlay 产生肉眼色差, 实色页用 none */
    backdrop?: 'acrylic' | 'none';
  },
): boolean {
  if (!win || win.isDestroyed()) return false;
  /* Win10: 只用 transparent 窗 + 全透 backgroundColor 做侧透, 禁止 acrylic.
   * Win11: acrylic 才是系统毛玻璃. */
  const wantAcrylic = opts.backdrop === 'acrylic' && isWindows11OrNewer();
  const backdrop = wantAcrylic ? 'acrylic' : 'none';
  /* 2026-07: Win 已改自绘窗控, 不再 setTitleBarOverlay (会重新叠出 OS 三大金刚).
   * 仍同步窗口底色 / 材质, 避免边缘透出另一层 DWM 色. */
  const key = `${opts.color}|bg|${backdrop}`;
  const prev = (win as Electron.BrowserWindow & { __neoxTitleBarKey?: string }).__neoxTitleBarKey;
  if (prev === key) return true;
  try {
    try {
      win.setBackgroundColor(opts.color);
    } catch { /* older electron */ }
    /* Win10 调 setBackgroundMaterial(acrylic|none) 都可能把分层窗锁回实底;
     * 仅 Win11 走 DWM 材质 API. */
    if (isWindows11OrNewer()) {
      try {
        (win as Electron.BrowserWindow & {
          setBackgroundMaterial?: (m: string) => void;
        }).setBackgroundMaterial?.(backdrop);
      } catch { /* platform / version */ }
    }
    (win as Electron.BrowserWindow & { __neoxTitleBarKey?: string }).__neoxTitleBarKey = key;
    return true;
  } catch {
    return false;
  }
}

export function registerUIIpcHandlers(options: RegisterUIIpcHandlersOptions): void {
  const { isDev, appVersion, projectManager, consumeCachedUIState } = options;

  ipcMain.handle('diagnostics:append', async (_event, payload: { sessionId?: string; lines?: string[] }) => {
    const sessionId = safeDiagnosticSessionId(payload?.sessionId || `diag-${Date.now()}`);
    const lines = Array.isArray(payload?.lines) ? payload.lines : [];
    const prev = diagnosticsWriteChains.get(sessionId) || Promise.resolve();
    let filePath = '';
    const next = prev
      .catch(() => { /* keep chain alive */ })
      .then(async () => {
        filePath = await appendDiagnosticsLines(sessionId, lines);
      });
    diagnosticsWriteChains.set(sessionId, next);
    try {
      await next;
      return { ok: true, path: filePath };
    } catch (error: any) {
      return { ok: false, error: error?.message || String(error) };
    } finally {
      if (diagnosticsWriteChains.get(sessionId) === next) diagnosticsWriteChains.delete(sessionId);
    }
  });

  ipcMain.handle('diagnostics:open-folder', async () => {
    const dir = diagnosticsDir();
    await fs.mkdir(dir, { recursive: true });
    await openPathWithFallback(dir);
    return dir;
  });

  /* ui:get-last-state / ui:get-theme 搬到了 uiReadHandlers.ts。
   *
   * 它们只从 storageService 读, 不碰 Electron, 而 renderer 启动第一步就要调 ——
   * 留在这个文件里就等于绑死在 Electron 宿主上 (本文件顶部 import 了 app/BrowserWindow/dialog,
   * 非 Electron 进程连 import 都过不去)。搬出去之后两个宿主共用同一份实现。
   * 这里**不能**再注册一遍: 真 ipcMain 对同一个 channel 重复 handle 会直接抛。 */

  /**
   * `ui:save-editor-layout`
   *
   * 保存当前窗口的编辑器布局.
   * 通过 sender scope 反查 workspacePath, 如果有 scope → 存 per-workspace,
   * 没 scope → 存 global (welcome page 场景).
   */
  ipcMain.handle('ui:save-editor-layout', async (
    event,
    layout: {
      openFiles?: string[];
      activeFile?: string;
      viewMode?: 'agent' | 'editor';
      sidebarVisible?: boolean;
      terminalVisible?: boolean;
    },
  ) => {
    const scope = projectManager.getBySender(event?.sender as any);
    if (scope) {
      // Per-workspace save
      await storageService.saveWorkspaceLayout(scope.workspacePath, {
        editorOpenFiles: layout.openFiles,
        editorActiveFile: layout.activeFile,
        editorViewMode: layout.viewMode,
        sidebarVisible: layout.sidebarVisible,
        terminalVisible: layout.terminalVisible,
      });
    } else {
      // Global fallback
      await storageService.saveUIState({
        editorOpenFiles: layout.openFiles,
        editorActiveFile: layout.activeFile,
        editorViewMode: layout.viewMode,
        sidebarVisible: layout.sidebarVisible,
        terminalVisible: layout.terminalVisible,
      });
    }
  });

  ipcMain.handle('ui:set-theme', async (event, darkMode: string, colorTheme: string) => {
    await storageService.setThemePreference(darkMode, colorTheme);
    if (process.platform === 'win32') {
      const isDark = darkMode === 'dark' || (darkMode === 'auto' && nativeTheme.shouldUseDarkColors);
      applyWinTitleBarOverlay(BrowserWindow.fromWebContents(event?.sender), {
        color: isDark ? '#191919' : '#ffffff',
        symbolColor: isDark ? '#d4d4d4' : '#3a3f4b',
      });
    }
  });


  /* 超级调色盘 — themePack id (16 张内置 + 自定义).
   * themePack 是当前主题真相源; legacy themePreset 只保留给老入口和老版本兜底. */

  ipcMain.handle('ui:set-window-vibrancy', (event, payload: { enabled?: boolean; opaqueColor?: string }) => {
    if (process.platform !== 'darwin') return false;
    const win = BrowserWindow.fromWebContents(event?.sender);
    if (!win || win.isDestroyed()) return false;
    const enabled = payload?.enabled !== false;
    try {
      if (enabled) {
        win.setBackgroundColor('#00000000');
        win.setVibrancy('fullscreen-ui');
      } else {
        win.setVibrancy(null);
        if (payload?.opaqueColor) win.setBackgroundColor(payload.opaqueColor);
      }
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('ui:sync-titlebar', (event, payload: boolean | {
    isDark?: boolean;
    color?: string;
    symbolColor?: string;
    height?: number;
    backdrop?: 'acrylic' | 'none';
  }) => {
    if (process.platform !== 'win32') return { ok: false, reason: 'not-win32' };
    const opts = typeof payload === 'boolean'
      ? { isDark: payload }
      : (payload && typeof payload === 'object' ? payload : {});
    const isDark = !!opts.isDark;
    const wantAcrylic = opts.backdrop === 'acrylic' && isWindows11OrNewer();
    let color = normalizeHexColor(opts.color)
      ?? (isDark ? '#181818' : '#ffffff');
    /* Win10 无 acrylic: 绝不能把窗底刷成 #00000000, 否则整窗透穿桌面. */
    if (!wantAcrylic && /^#[0-9a-f]{6}00$/i.test(color)) {
      color = isDark ? '#181818' : '#ffffff';
    }
    const symbolColor = normalizeHexColor(opts.symbolColor)
      ?? pickSymbolColor(color, isDark);
    const backdrop = wantAcrylic ? 'acrylic' : 'none';
    const applied = applyWinTitleBarOverlay(BrowserWindow.fromWebContents(event?.sender), {
      color,
      symbolColor,
      height: typeof opts.height === 'number' && opts.height > 0 ? Math.round(opts.height) : 44,
      backdrop,
    });
    return { ok: applied, color, symbolColor, backdrop };
  });

  /* ui:set-onboarding-completed 搬到了 uiReadHandlers.ts —— 它只写 storageService,
   * 不碰 Electron, 而极简版走完引导必须能记下来 (记不下就每次启动都重来一遍)。 */

  /* macOS Dock badge + Windows taskbar overlay (右下角角标). count<=0 清除. */
  ipcMain.handle('ui:set-app-badge', async (_event, count: unknown) => {
    const n = typeof count === 'number' ? count : Number(count);
    setAppBadgeCount(Number.isFinite(n) ? n : 0);
  });

  ipcMain.handle('dialog:open-folder', async (event) => {
    // dialog parent 用发起 IPC 的那个窗口 —— 多窗口时弹在用户点击的窗口上
    const senderWindow = BrowserWindow.fromWebContents(event?.sender);
    if (!senderWindow) return null;
    const result = await dialog.showOpenDialog(senderWindow, {
      properties: ['openDirectory'],
      title: 'Select Project Folder',
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    rememberUserApprovedPath(event?.sender, result.filePaths[0], 'read');
    return result.filePaths[0];
  });

  /* 单文件选择器 — Surface 右栏 "+ 打开 → 源码" 用. defaultPath/filters 透传 Electron dialog. */
  ipcMain.handle('dialog:open-file', async (event, opts) => {
    const senderWindow = BrowserWindow.fromWebContents(event?.sender);
    if (!senderWindow) return null;
    const result = await dialog.showOpenDialog(senderWindow, {
      properties: ['openFile'],
      title: 'Select File',
      defaultPath: opts?.defaultPath,
      filters: opts?.filters,
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    rememberUserApprovedPath(event?.sender, result.filePaths[0], 'read');
    return result.filePaths[0];
  });

  /* 保存文件路径选择器 — Surface 右栏 "+ 打开 → 表格" 新建空表格时, 让用户选 .xlsx 保存位置.
   * 只返路径不写盘, 调用方自己 fs.writeFile (renderer 通过 surfaceWriteFile 走). */
  ipcMain.handle('dialog:save-file', async (event, opts) => {
    const senderWindow = BrowserWindow.fromWebContents(event?.sender);
    if (!senderWindow) return null;
    const result = await dialog.showSaveDialog(senderWindow, {
      title: opts?.title ?? 'Save File',
      defaultPath: opts?.defaultPath,
      filters: opts?.filters,
    });
    if (result.canceled || !result.filePath) {
      return null;
    }
    rememberUserApprovedPath(event?.sender, result.filePath, 'write');
    return result.filePath;
  });

  ipcMain.handle('app:get-info', () => ({
    name: 'Neox',
    version: appVersion,
    environment: isDev ? 'dev' : 'prod',
    platform: process.platform,
    arch: process.arch,
  }));
}
