/**
 * Refresh Windows desktop / Start-menu shortcuts after update so they pick up
 * the current exe icon + AppUserModelId (otherwise Explorer keeps a cached
 * Electron/old icon on the .lnk).
 *
 * Cover both per-user and per-machine install locations: NSIS may land in
 * Program Files with Public Desktop + ProgramData Start Menu shortcuts that
 * the previous refresh path never touched.
 */
import { execFile } from 'child_process';
import { app, shell } from 'electron';
import { copyFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';

const APP_USER_MODEL_ID = 'com.mk.neox';

/**
 * unpackaged `electron.exe` 会在「开始菜单」写 Electron.lnk, 并把 AUMID 设成
 * 当时进程的值. 开发曾经跟安装版共用 com.mk.neox → Get-StartApps 把生产身份
 * 登记成 Name=Electron, 任务栏永远跟原子标绑在一起. 每次启动先拆掉这个贼.
 */
function removeStolenElectronShortcut(): void {
  const appData = app.getPath('appData');
  const desktop = app.getPath('desktop');
  const stolen = [
    join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Electron.lnk'),
    join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'electron.lnk'),
    join(desktop, 'Electron.lnk'),
    join(desktop, 'electron.lnk'),
  ];
  for (const p of stolen) {
    if (!existsSync(p)) continue;
    try {
      unlinkSync(p);
    } catch (err) {
      console.warn('[WinShortcut] cannot remove stolen Electron.lnk:', p, err);
    }
  }
}

function resolveShortcutIcon(exePath: string): { icon: string; iconIndex: number } {
  /* Prefer resources\icon.ico over exe,0 — Win10 Explorer/taskbar grouping is
   * more reliable when the .lnk points at an explicit multi-size ICO. */
  const ico = join(process.resourcesPath, 'icon.ico');
  if (existsSync(ico)) {
    return { icon: versionedIconCopy(ico) ?? ico, iconIndex: 0 };
  }
  return { icon: exePath, iconIndex: 0 };
}

function versionedIconCopy(srcIco: string): string | null {
  try {
    const dir = join(app.getPath('userData'), 'shortcut-icons');
    const dest = join(dir, `neox-${app.getVersion()}.ico`);
    if (!existsSync(dest)) {
      mkdirSync(dir, { recursive: true });
      copyFileSync(srcIco, dest);
    }
    return dest;
  } catch (err) {
    console.warn('[WinShortcut] versioned icon copy failed:', err);
    return null;
  }
}

function writeShortcut(linkPath: string, exePath: string, operation: 'create' | 'update'): void {
  try {
    const { icon, iconIndex } = resolveShortcutIcon(exePath);
    const ok = shell.writeShortcutLink(linkPath, operation, {
      target: exePath,
      cwd: dirname(exePath),
      appUserModelId: APP_USER_MODEL_ID,
      icon,
      iconIndex,
      description: 'NeoX — local-first Agent Workstation',
    });
    if (!ok) {
      console.warn('[WinShortcut] write failed:', operation, linkPath);
    }
  } catch (err) {
    console.warn('[WinShortcut] write error:', operation, linkPath, err);
  }
}

function updateShortcut(linkPath: string, exePath: string): void {
  if (!existsSync(linkPath)) return;
  writeShortcut(linkPath, exePath, 'update');
}

export function refreshWindowsShortcuts(): void {
  if (process.platform !== 'win32' || !app.isPackaged) return;

  removeStolenElectronShortcut();

  const exePath = app.getPath('exe');
  const desktop = app.getPath('desktop');
  const appData = app.getPath('appData'); /* %APPDATA% — per-user Start Menu */
  const publicDesktop = join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop');
  const programData = process.env.ProgramData || 'C:\\ProgramData';

  const candidates = [
    join(desktop, 'Neox.lnk'),
    join(desktop, 'neox.lnk'),
    join(publicDesktop, 'Neox.lnk'),
    join(publicDesktop, 'neox.lnk'),
    join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Neox.lnk'),
    join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Neox', 'Neox.lnk'),
    join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Neox.lnk'),
    join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Neox', 'Neox.lnk'),
    join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar', 'Neox.lnk'),
    join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'StartMenu', 'Neox.lnk'),
  ];

  for (const p of candidates) {
    updateShortcut(p, exePath);
  }

  /* Get-StartApps 按「开始菜单里带该 AUMID 的 .lnk」认应用名. 拆掉 Electron.lnk
   * 之后如果用户侧没有 Neox.lnk, 身份会空一截, 任务栏还是对不上. */
  const userStartMenu = join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Neox.lnk');
  if (!existsSync(userStartMenu)) {
    writeShortcut(userStartMenu, exePath, 'create');
  }

  /* Win10 Explorer 把图标缓存在 IconCache 里, 只改 .lnk 不够 —— 不通知的话
   * 桌面/开始菜单会一直显示上一次的 Electron 原子标。ie4uinit -show 刷新缓存
   * 且不杀 explorer.exe。 */
  notifyExplorerIconsChanged();
}

function notifyExplorerIconsChanged(): void {
  try {
    execFile('ie4uinit.exe', ['-show'], { windowsHide: true }, () => { /* fire-and-forget */ });
  } catch {
    /* ignore — 刷新失败只是缓存多留一会儿, 不能挡启动 */
  }
}
