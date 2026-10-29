import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron';
import { buildWindowsTrayMenu } from './windowsTray.js';

const MARK_18 = 'iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAABv0lEQVR42n3UTYiOURgG4Ot7B1PSlIaIYvxOTMLKipSU0hDNQpmFnYWVNZGthAWi7LCTJYVkOZKkLEx+Gj8LM8ZPovzMfGNzf9Px+vLU6XTOud/7Oc997uft8HdUmCrWK7EBy7L+krmjhvuHBDpxFCMBt8Zn3MWOGn6aubXZxHpcRDdu4TbeYSHmYTkG88398mYdaORgCTbjJl5gUfbe40bmjZjANrzG45KskcUCHK6V9BTXcB4DOJ79SYxicTttzhQET7CppmE35uBKgTuUW0/HQJHpGeYXGs4otIQefIumJ9GPrirAIzlo4gA+YGaIJzK3iEcwFEl+R8u+Cn0ZFe4EVAVUj0bGcCp4haXordCb7PAwFpiqlVOP2SF8hN1otvwjdX/FvhBVbQiaOduJ63H+WjyXsibwA3swnlvCrBA2oiXsx8t46i3G0NV6/qFk2xrvDMfF9ViFU9iVsqZwoQT0Z/NEYYVRHItmc7ECB3EaH4P5noSNst8u5bAHVwvTTeb64/hZa+TBsmcbBdnZ9Nk6nMOv2oet8akdidofYDv24kFaYgtW58nHcA+X8SYkk+38UXpnTZ63Mwk7/4P1B/RHfw+xUQInAAAAAElFTkSuQmCC';
const MARK_36 = 'iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAAEcUlEQVR42q2YW4hVdRTGf/ucmXEmaizHbmIKU1KpWVlZRKX10GAmET1MFwopIiiywhKlICKiXswiokCS6sEohOihIFCDeSsaHIxIrewm4aU0jTqO5+y9e/lWrBb7nM4+ZzZs9u1/+da31n+t77+h3FEBekq2TcpMkJRoVwFS9+5CYAEwF5gB1IFDwPfA18CvAVzGFB1Vd38B8BywE2gAeZPzT+BT4B7HaHUqwQwBLwPHw8QpcAKoAZNiKQ1tvgRunApQZtkI8JuboAYcEQuRmYYAZbo3FjPgqW5AWae1GvArYB1wHXAO0Af0A+cBtwCvAb8EYBFkDrzQCShr/AzwA3Br+D4HuAa4CVgsd9pxN7CvAFQGnNT9Q2VAWaM7gE3u/UpgiwDGGKkDe4ENYgzgFRdjmQPVUMxd1M4qt4+zgFEXP+MFgZy3ON8GBoBVjqnMgc+BjzT+Ke0wNFf3GwOIuhuwBnygSa8ChmX1CuB14F1gNvBggfuMtUvE6KnNmEq0sirA1oJVY1a+D1z8P4ZNB24GpgFvBlBm1Iti8jaXPAvjZ5M6nHS+N1CPhPZmgJ3VUFqmAYNagTaOuXyX2qxXmPwnpgzMvQVgLAZGXX6qtFFqEjfuwwXxVBPg+4DVPvdZ5xmqRd4Ko/lxdegtmc9s7OkaOy6KYeBSYJt3m1H8dPCxgfmkQzCR/S1ufGPpMuB04CBwrreiV7kkC0H8NzDPVftOS1Di3FZ3DC1Qxk+V8anowyJNjJMZCfAe8K2s7FQ+2OR7Q+DWgAMCVLGVa1Yv0TV1NKfAZtGalhVaBccf4Xkf8DuwUM9neUDzXMNMk09IZC2VhZUuAfUHo3foerv/bpPMDIBQ5A+piHZzGLOzQwLcDJwG3KXnuv+YFww0rlSwVHIj69Jti12Qb5MH1rjVddQDOhD0L3KX5ZARge5EXKUac8Ql2tXAmcpv5sLdvtMqtyQtcV0NXKtBxjvcRZgBy1xee0LvPgyFe9h3nO/yj+WJ5VKHBvB5te1rE1Tiku6Yxtig52f1PKnrFy6r/5v0JgToRCgXPzpQDzjLq22UDICX1HdNqAgNZ/xjvpaZFY/qowHaqvevhoK7vmAzWHEgDMiAJMYuJd4+4J0ga1LloiG/Im2QQWC/c91hDXq+LPFifTtwfQuGZkk5jCq/jAI/NdFF64o0tj3cGVgyF73hWPLq7zMxeyVwtvLKTKnI5cCTwDcFu5GG00T9juHCFfGWs+A76d4zdO9XYha09DGlioO6z5tshazvX3IlzaqACapebYNtsI36foX8HSVKvQCcX85pE4ZWtrMdsngakHbOg+uWKM7ysDPNnWTJCgCmzohjbq/XU/aPyFpRmzuZOeiSmt+bNcLqaRQwNOaqe0/Zgmh+XejY2qHtNLp+HARXs3MCuN8ZW+30/1DV1ZpFUn3LgJ+1IfxcOuYGxdgcMTipAN+pQjrmVETLf0VJm3/CvCxJgMtVbjJgj1Tl8RLGdf0HDbf3arQoopmTMlWNn4f3LY9/AKzlzclvDYGpAAAAAElFTkSuQmCC';

let tray: Tray | null = null;

/** 18pt 模板图, 带 @2x 表示 —— 视网膜屏用 36px 那张, 不会糊。 */
export function buildMenuBarTemplateImage(): Electron.NativeImage {
  const image = nativeImage.createFromBuffer(Buffer.from(MARK_18, 'base64'), { scaleFactor: 1 });
  image.addRepresentation({ scaleFactor: 2, buffer: Buffer.from(MARK_36, 'base64') });
  image.setTemplateImage(true);
  return image;
}

function showMainWindow(openWindow?: () => Promise<unknown>): void {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!win) {
    /* 窗口都关了 (Mac 上关窗 App 还在) —— 从菜单栏点「显示」要能重新开出来 */
    void openWindow?.().catch((error: any) => {
      console.warn('[MenuBar] Failed to reopen main window:', error?.message || error);
    });
    return;
  }
  try {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    app.focus({ steal: true });
  } catch {
    /* Window may be closing. */
  }
}

/** 装一次菜单栏图标 (主进程生命周期内)。 */
export function setupMacMenuBarTray(openWindow?: () => Promise<unknown>): void {
  if (process.platform !== 'darwin' || tray || !app.isReady()) return;
  try {
    tray = new Tray(buildMenuBarTemplateImage());
    tray.setToolTip('Neox');
    const sendAction = (action: string): void => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
        try { win.webContents.send('menu:action', action); } catch { /* window is closing */ }
      }
    };
    tray.setContextMenu(Menu.buildFromTemplate(buildWindowsTrayMenu({
      showWindow: () => showMainWindow(openWindow),
      sendAction,
      quit: () => app.quit(),
    })));
    app.once('will-quit', () => {
      tray?.destroy();
      tray = null;
    });
    console.log('[MenuBar] macOS menu bar icon ready');
  } catch (error) {
    console.warn('[MenuBar] Failed to create macOS menu bar icon:', error);
    tray = null;
  }
}
