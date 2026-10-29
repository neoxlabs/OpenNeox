/**
 * Rate Limit IPC Handlers
 * 暴露 rateLimitTracker 数据到 Electron renderer
 */

import { ipcMain } from './ipcMainBridged.js';
import { getGlobalRateLimitTracker } from '@neoxlabs/platform/platform/rateLimitTracker.js';

export function registerRateLimitIpcHandlers(): void {
  // 获取所有窗口的使用统计
  ipcMain.handle('rate-limit:get-usage', (_event, provider?: string) => {
    const tracker = getGlobalRateLimitTracker();
    return tracker.getUsage(provider);
  });

  // 获取是否接近限额
  ipcMain.handle('rate-limit:is-near-limit', (_event, provider?: string) => {
    const tracker = getGlobalRateLimitTracker();
    return tracker.isNearLimit(provider);
  });

  // 获取格式化摘要
  ipcMain.handle('rate-limit:get-summary', (_event, provider?: string) => {
    const tracker = getGlobalRateLimitTracker();
    return tracker.getStatusSummary(provider);
  });
}
