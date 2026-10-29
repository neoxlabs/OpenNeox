import { app, BrowserWindow, Menu, Tray } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { loadAppNativeImage, resolveAppIconPath } from './appIcon.js';

let tray: Tray | null = null;
let quitting = false;

export function isWindowsTrayActive(): boolean {
  return process.platform === 'win32' && tray !== null;
}

export function isWindowsAppQuitting(): boolean {
  return quitting;
}

export function markWindowsAppQuitting(): void {
  quitting = true;
}

function getMainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) ?? null;
}

function showMainWindow(openWindow?: () => Promise<unknown>): void {
  const win = getMainWindow();
  if (!win) {
    void openWindow?.().catch((error: any) => {
      console.warn('[Tray] Failed to reopen main window:', error?.message || error);
    });
    return;
  }
  try {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } catch {
    /* Window may be closing. */
  }
}

type TrayMenuAction =
  | 'menu:go-home'
  | 'menu:new-session'
  | 'menu:open-settings'
  | 'menu:open-account'
  | 'menu:open-about'
  | 'menu:open-settings-providers'
  | 'menu:open-settings-remote';

export function buildWindowsTrayMenu(options: {
  showWindow: () => void;
  sendAction: (action: TrayMenuAction) => void;
  quit: () => void;
}): MenuItemConstructorOptions[] {
  const { showWindow, sendAction, quit } = options;
  const action = (name: TrayMenuAction): (() => void) => () => {
    showWindow();
    sendAction(name);
  };
  return [
    { label: '显示 Neox', click: showWindow },
    { label: '新建会话', click: action('menu:new-session') },
    { label: '回到主页', click: action('menu:go-home') },
    { type: 'separator' },
    { label: '账户与登录', click: action('menu:open-account') },
    {
      label: '设置',
      submenu: [
        { label: '打开设置', click: action('menu:open-settings') },
        { label: '模型与服务商', click: action('menu:open-settings-providers') },
        { label: '远程连接', click: action('menu:open-settings-remote') },
      ],
    },
    { label: '关于 Neox', click: action('menu:open-about') },
    { type: 'separator' },
    { label: '退出 Neox', click: quit },
  ];
}

/** Install the Windows notification-area entry once per main process. */
export function setupWindowsTray(dirname: string, openWindow?: () => Promise<unknown>): void {
  if (process.platform !== 'win32' || tray || !app.isReady()) return;

  const iconPath = resolveAppIconPath(dirname);
  const icon = loadAppNativeImage(dirname);
  if (!iconPath && (!icon || icon.isEmpty())) {
    console.warn('[Tray] Windows tray icon unavailable');
    return;
  }

  try {
    tray = new Tray(iconPath || icon!);
    tray.setToolTip('Neox');
    const sendMenuAction = (action: 'menu:go-home' | 'menu:new-session' | 'menu:open-settings' | 'menu:open-account' | 'menu:open-about' | 'menu:open-settings-providers' | 'menu:open-settings-remote'): void => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
        try { win.webContents.send('menu:action', action); } catch { /* window is closing */ }
      }
    };
    const menuItems = buildWindowsTrayMenu({
      showWindow: () => showMainWindow(openWindow),
      sendAction: sendMenuAction,
      quit: () => {
        quitting = true;
        app.quit();
      },
    });
    tray.setContextMenu(Menu.buildFromTemplate(menuItems));
    tray.on('click', () => showMainWindow(openWindow));
    tray.on('double-click', () => showMainWindow(openWindow));
    app.once('will-quit', () => {
      quitting = true;
      tray?.destroy();
      tray = null;
    });
    console.log('[Tray] Windows notification-area icon ready');
  } catch (error) {
    console.warn('[Tray] Failed to create Windows notification-area icon:', error);
    tray = null;
  }
}
