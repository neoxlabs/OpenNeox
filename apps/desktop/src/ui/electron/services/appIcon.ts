/**
 * Resolve the NeoX app icon for BrowserWindow / Dock / taskbar.
 *
 * Windows packaged builds previously fell through to Electron's default atom
 * icon because candidates relied on `process.cwd()/build/icon.ico` (useless
 * after install) and asar PNG paths were flaky for taskbar. Prefer
 * `process.resourcesPath/icon.ico` (extraResources) then asar assets.
 */
import { app, nativeImage, type NativeImage } from 'electron';
import { existsSync } from 'fs';
import { dirname, join } from 'path';

export function resolveAppIconCandidates(electronDirname: string): string[] {
  const resources = process.resourcesPath;
  const exeDir = app.isPackaged ? dirname(app.getPath('exe')) : process.cwd();
  const assetRoot = join(electronDirname, '../renderer/assets');

  if (process.platform === 'win32') {
    return [
      join(resources, 'icon.ico'),
      /* Windows 口径的 PNG (近全出血) —— 跟 mac 那张彻底分开, 见 generate-win-icon.cjs */
      join(resources, 'icon-win.png'),
      join(assetRoot, 'icon-win.png'),
      join(resources, 'icon.png'),
      join(assetRoot, 'icon.ico'),
      join(assetRoot, 'icon.png'),
      join(exeDir, 'icon.ico'),
      join(process.cwd(), 'build', 'icon.ico'),
    ];
  }

  if (process.platform === 'darwin') {
    return [
      join(resources, 'icon.icns'),
      join(assetRoot, 'icon.icns'),
      join(resources, 'icon.png'),
      join(assetRoot, 'icon.png'),
    ];
  }

  return [
    join(resources, 'icon.png'),
    join(assetRoot, 'icon.png'),
    join(process.cwd(), 'build', 'icon.png'),
  ];
}

export function resolveAppIconPath(electronDirname: string): string | undefined {
  return resolveAppIconCandidates(electronDirname).find((p) => {
    try {
      return !!p && existsSync(p);
    } catch {
      return false;
    }
  });
}

export function logAppIconDiagnostics(electronDirname: string): void {
  try {
    const candidates = resolveAppIconCandidates(electronDirname);
    const chosen = resolveAppIconPath(electronDirname);
    const img = loadAppNativeImage(electronDirname);
    const size = img && !img.isEmpty() ? img.getSize() : null;
    console.log('[IconDiag] platform=%s packaged=%s exe=%s', process.platform, app.isPackaged, safeExePath());
    console.log('[IconDiag] resourcesPath=%s', process.resourcesPath);
    for (const c of candidates) {
      let exists = false;
      try { exists = existsSync(c); } catch { /* 权限等 */ }
      console.log('[IconDiag]   %s %s', exists ? 'HIT ' : 'miss', c);
    }
    console.log('[IconDiag] chosen=%s image=%s',
      chosen ?? '(none)',
      size ? `${size.width}x${size.height}` : '(empty/null — 任务栏会掉回 Electron 默认图标)');
  } catch (err: any) {
    console.warn('[IconDiag] 自检失败:', err?.message || err);
  }
}

function safeExePath(): string {
  try { return app.getPath('exe'); } catch { return '(unavailable)'; }
}

export function loadAppNativeImage(electronDirname: string): NativeImage | null {
  for (const candidate of resolveAppIconCandidates(electronDirname)) {
    try {
      if (!existsSync(candidate)) continue;
      const image = nativeImage.createFromPath(candidate);
      if (!image.isEmpty()) return image;
    } catch {
      /* try next */
    }
  }
  return null;
}
