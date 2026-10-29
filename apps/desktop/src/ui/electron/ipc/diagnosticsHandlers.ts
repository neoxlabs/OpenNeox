import { ipcMain } from './ipcMainBridged.js';
import { readRequestLog, summarizeRequests } from '@neoxlabs/core';

export function registerDiagnosticsIpcHandlers(): void {
  ipcMain.handle('diagnostics:summary', async (_event, hours: unknown) => {
    const h = typeof hours === 'number' && hours > 0 ? Math.min(hours, 24 * 7) : 24;
    const since = Date.now() - h * 3600_000;
    return summarizeRequests(readRequestLog(since), since);
  });
}
