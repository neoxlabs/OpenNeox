import { ipcMain } from './ipcMainBridged.js';
import { loadConfig, saveConfig } from '@neoxlabs/platform/utils/config.js';
import { wrapApiKey, unwrapApiKey } from '@neoxlabs/platform/utils/apiKeyCrypto.js';
import { testR2Share } from '@neoxlabs/core';

const MASK = '••••••••';
type R2 = { accountId?: string; bucket?: string; accessKeyId?: string; secretAccessKey?: string; publicBaseUrl?: string };

export function registerShareIpcHandlers(): void {
  ipcMain.handle('share:get-config', async () => {
    const r2: R2 = { ...((loadConfig() as any).share?.r2 ?? {}) };
    return { ...r2, secretAccessKey: r2.secretAccessKey ? MASK : '' };
  });

  ipcMain.handle('share:set-config', async (_event, input: R2) => {
    try {
      const config = loadConfig() as any;
      const prev: R2 = config.share?.r2 ?? {};
      const next: R2 = {};
      for (const k of ['accountId', 'bucket', 'accessKeyId', 'publicBaseUrl'] as const) {
        const v = typeof input?.[k] === 'string' ? input[k]!.trim() : '';
        if (v) next[k] = k === 'publicBaseUrl' ? v.replace(/\/+$/, '') : v;
      }
      const secret = typeof input?.secretAccessKey === 'string' ? input.secretAccessKey.trim() : '';
      /* 打码回显原样提交回来 = 没改, 沿用旧的密文 */
      if (secret === MASK) { if (prev.secretAccessKey) next.secretAccessKey = prev.secretAccessKey; }
      else if (secret) next.secretAccessKey = wrapApiKey(secret);
      saveConfig({ ...config, share: { ...(config.share ?? {}), r2: next } });
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error?.message ?? String(error) };
    }
  });

  ipcMain.handle('share:test', async () => {
    const r2: R2 = (loadConfig() as any).share?.r2 ?? {};
    return testR2Share({ ...r2, secretAccessKey: unwrapApiKey(r2.secretAccessKey) } as any);
  });
}
