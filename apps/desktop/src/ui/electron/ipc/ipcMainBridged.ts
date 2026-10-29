
import { createRequire } from 'node:module';
import { registerBridgeRoute, type BridgeHandler } from '@neoxlabs/platform/shared/ipc.js';

/** 真 ipcMain —— 不在 Electron 宿主里时为 null。 */
const realIpcMain: {
  handle(channel: string, fn: BridgeHandler): void;
  handleOnce?(channel: string, fn: BridgeHandler): void;
  on?(channel: string, fn: (...a: any[]) => void): void;
  removeHandler?(channel: string): void;
} | null = (() => {
  if (!(process as any).versions?.electron) return null;
  try {
    const req = createRequire(import.meta.url);
    return req('electron')?.ipcMain ?? null;
  } catch {
    return null;
  }
})();

export const ipcMain = {
  handle(channel: string, fn: BridgeHandler): void {
    registerBridgeRoute(channel, fn);
    realIpcMain?.handle(channel, fn);
  },
  handleOnce(channel: string, fn: BridgeHandler): void {
    registerBridgeRoute(channel, fn);
    realIpcMain?.handleOnce?.(channel, fn);
  },
  /* on/removeHandler 只转发不登记 —— 它们不是"请求/响应"语义, 桥那边用不上。 */
  on(channel: string, fn: (...a: any[]) => void): void {
    realIpcMain?.on?.(channel, fn);
  },
  removeHandler(channel: string): void {
    realIpcMain?.removeHandler?.(channel);
  },
};

/** 当前是不是真的跑在 Electron 里 —— 少数 handler 需要按宿主分支时用。 */
export function isElectronHost(): boolean {
  return realIpcMain !== null;
}
