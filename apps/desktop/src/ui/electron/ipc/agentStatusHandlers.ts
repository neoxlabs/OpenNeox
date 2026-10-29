/**
 * agentStatusHandlers — 主进程暴露 agent 运行时状态给 renderer。
 *
 * 目前暴露:
 *   · agent:wakeups      — 所有 session 的 pending schedule_wakeup 列表
 *   · agent:budget-snapshot — 当前 active session 的 budget snapshot(如果有)
 *
 * 注意:我们不在每个 IPC 都 require runtime 模块(避免 renderer 侧打包),
 * 这些 handler 只在 Electron main 加载时注册。
 */

import { ipcMain } from './ipcMainBridged.js';
import { getScheduledWakeupRegistry } from '@neoxlabs/core/runtime/shell/scheduledWakeupRegistry.js';
import { getAgentBudgetAccessor } from '@neoxlabs/core/runtime/agentBudgetAccessor.js';

export function registerAgentStatusIpcHandlers(): void {
  ipcMain.handle('agent:wakeups', async () => {
    try {
      return getScheduledWakeupRegistry().listAllPending();
    } catch (err: any) {
      return { error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle('agent:budget-snapshot', async () => {
    try {
      // IPC 在 ALS 外触发,必须用 getLatestSnapshot 兜底读
      const snap = getAgentBudgetAccessor().getLatestSnapshot();
      return snap ?? null;
    } catch (err: any) {
      return { error: err?.message ?? String(err) };
    }
  });
}
