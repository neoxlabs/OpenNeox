/* ipcMain 走桥的替身; BrowserWindow 是纯类型导入, 编译后完全擦除,
 * 不会把 electron 拉进纯 Node 后端的运行时 (见 lazyElectron.ts)。 */
import { ipcMain } from './ipcMainBridged.js';
import type { BrowserWindow } from 'electron';
import type { ProjectManager } from '../context/ProjectManager.js';

const pendingTerminalRequests = new Map<string, {
  resolve: (result: { output: string; exitCode: number }) => void;
  reject: (error: Error) => void;
}>();

let resolveWindow: () => BrowserWindow | null = () => null;

export function configureTerminalRequestBridge(options: {
  projectManager: ProjectManager;
}): void {
  // 把 terminal:request 事件发给 focused project 的 window —— 它才是触发 tool
  // 调用的那个窗口. 没 project 打开时 resolve null, caller 会 reject.
  resolveWindow = () => options.projectManager.getFocused()?.window ?? null;
}

export async function requestTerminalExecution(options: {
  command: string;
  cwd: string;
  timeout?: number;
}): Promise<{ output: string; exitCode: number }> {
  const requestId = `terminal-req-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return new Promise((resolve, reject) => {
    pendingTerminalRequests.set(requestId, { resolve, reject });

    const target = resolveWindow();
    if (target && !target.isDestroyed()) {
      target.webContents.send('terminal:request', {
        requestId,
        command: options.command,
        cwd: options.cwd,
        timeout: options.timeout,
      });
    } else {
      pendingTerminalRequests.delete(requestId);
      reject(new Error('No active project window for terminal request'));
    }

    const timeoutMs = options.timeout || 600000;
    setTimeout(() => {
      if (pendingTerminalRequests.has(requestId)) {
        pendingTerminalRequests.delete(requestId);
        reject(new Error(`Terminal request timeout after ${timeoutMs}ms`));
      }
    }, timeoutMs);
  });
}

export function registerTerminalRequestIpcHandlers(): void {
  ipcMain.handle('terminal:request-complete', async (_event, requestId: string, result: { output: string; exitCode: number; error?: string }) => {
    const pending = pendingTerminalRequests.get(requestId);
    if (pending) {
      pendingTerminalRequests.delete(requestId);
      if (result.error) {
        pending.reject(new Error(result.error));
      } else {
        pending.resolve({ output: result.output, exitCode: result.exitCode });
      }
    }
  });
}
