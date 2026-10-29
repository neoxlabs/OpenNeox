import type { BrowserWindow } from 'electron';
import { existsSync, watchFile, unwatchFile } from 'fs';
import { join, resolve } from 'path';

interface ResolvePreloadPathOptions {
  isDev: boolean;
  dirname: string;
  fileName: string;
}

interface AttachDevPreloadReloaderOptions {
  isDev: boolean;
  preloadPath: string;
  windowLabel: string;
}

export function resolveElectronPreloadPath(options: ResolvePreloadPathOptions): string {
  const distPath = join(options.dirname, options.fileName);
  if (!options.isDev) return distPath;

  /* dirname = apps/cli/dist/ui-electron/electron —— 上四级就是 apps/ */
  const sourcePath = resolve(
    options.dirname,
    '../../../../desktop/src/ui/electron',
    options.fileName,
  );
  return existsSync(sourcePath) ? sourcePath : distPath;
}

export function attachDevPreloadReloader(
  window: BrowserWindow,
  options: AttachDevPreloadReloaderOptions,
): void {
  if (!options.isDev || !existsSync(options.preloadPath)) return;

  let reloadTimer: NodeJS.Timeout | null = null;
  const scheduleReload = () => {
    if (window.isDestroyed()) return;
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      if (window.isDestroyed()) return;
      console.info(`[${options.windowLabel}] preload changed, reloading window`);
      window.webContents.reloadIgnoringCache();
    }, 120);
  };

  watchFile(options.preloadPath, { interval: 300 }, (curr, prev) => {
    if (curr.mtimeMs === 0) return;
    if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return;
    scheduleReload();
  });

  window.once('closed', () => {
    unwatchFile(options.preloadPath);
    if (reloadTimer) clearTimeout(reloadTimer);
  });
}
