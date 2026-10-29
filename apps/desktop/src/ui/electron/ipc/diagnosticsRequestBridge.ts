/**
 * diagnosticsRequestBridge — main → renderer 拉 Monaco getModelMarkers.
 * 模式同 terminalRequestBridge.
 */

/* ipcMain 走桥的替身; BrowserWindow 是纯类型导入, 编译后完全擦除,
 * 不会把 electron 拉进纯 Node 后端的运行时 (见 lazyElectron.ts)。 */
import { ipcMain } from './ipcMainBridged.js';
import type { BrowserWindow } from 'electron';

export type DiagnosticItem = {
  path: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  source?: string;
  code?: string;
};

type Pending = {
  resolve: (items: DiagnosticItem[]) => void;
  reject: (error: Error) => void;
};

const pending = new Map<string, Pending>();
let resolveWindow: () => BrowserWindow | null = () => null;

export function configureDiagnosticsRequestBridge(options: {
  getWindow: () => BrowserWindow | null;
}): void {
  resolveWindow = options.getWindow;
}

export async function requestEditorDiagnostics(options: {
  paths?: string[];
  limit?: number;
}): Promise<DiagnosticItem[]> {
  const requestId = `diag-req-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    const target = resolveWindow();
    if (target && !target.isDestroyed()) {
      target.webContents.send('editor:diagnostics-request', {
        requestId,
        paths: options.paths,
        limit: options.limit ?? 80,
      });
    } else {
      pending.delete(requestId);
      reject(new Error('No active window for diagnostics request'));
    }

    setTimeout(() => {
      if (pending.has(requestId)) {
        pending.delete(requestId);
        reject(new Error('Diagnostics request timeout after 8s'));
      }
    }, 8000);
  });
}

export function registerDiagnosticsRequestIpcHandlers(): void {
  ipcMain.handle(
    'editor:diagnostics-complete',
    async (_event, requestId: string, result: { diagnostics?: DiagnosticItem[]; error?: string }) => {
      const p = pending.get(requestId);
      if (!p) return;
      pending.delete(requestId);
      if (result?.error) p.reject(new Error(result.error));
      else p.resolve(Array.isArray(result?.diagnostics) ? result.diagnostics : []);
    },
  );
}
