/**
 * Debug Session IPC handlers (新, M0 起).
 *
 * 跟老的 debugHandlers.ts 区别:
 *   - debugHandlers.ts 只管 breakpoints 内存存储 (DebugService), session 全是 stub
 *   - 这里管真实的 DebugSession 生命周期 (DebuggerManager + JvmDapBackend)
 *
 * 命名约定: `debug:session-*` 是新通道, 老的 `debug:start-session` /
 * `debug:continue` 等保留给 legacy DebugPanel 兼容(现在直接转发到这边).
 */

import { ipcMain } from './ipcMainBridged.js';
/* 类型是纯类型导入, 编译后完全擦除 —— 不会在运行时把 electron 拉进来。
 * 值 (ipcMain) 走桥的替身, 于是这个文件在纯 Node 后端里也 import 得动。 */
import type { IpcMainInvokeEvent } from 'electron';
import type { ProjectManager } from '../context/ProjectManager.js';
import { DEBUGGER_MANAGER } from '../context/tokens.js';
import type {
  DebuggerManager,
  DebugLaunchConfig,
  LineBreakpoint,
} from '../../../ide/debug/index.js';

interface RegisterDebugSessionIpcHandlersOptions {
  projectManager: ProjectManager;
}

export function registerDebugSessionIpcHandlers(options: RegisterDebugSessionIpcHandlersOptions): void {
  const { projectManager } = options;

  const managerOf = (event: IpcMainInvokeEvent): DebuggerManager | undefined => {
    const scope = projectManager.getBySender(event?.sender as any) ?? projectManager.getFocused();
    return scope?.tryGetService(DEBUGGER_MANAGER);
  };

  const sessionOf = (event: IpcMainInvokeEvent, sessionId: string) => {
    const dm = managerOf(event);
    if (!dm) throw new Error('No debugger manager (project not open?)');
    const s = dm.get(sessionId);
    if (!s) throw new Error(`No debug session: ${sessionId}`);
    return s;
  };

  // ─── 生命周期 ─────────────────────────────────────────────────────────

  ipcMain.handle('debug:session-start', async (event, config: DebugLaunchConfig) => {
    const dm = managerOf(event);
    if (!dm) throw new Error('No debugger manager available (project not open?)');
    const session = await dm.start(config);
    return {
      sessionId: session.id,
      config: session.config,
      capabilities: session.capabilities,
      status: session.status(),
    };
  });

  ipcMain.handle('debug:session-disconnect', async (event, sessionId: string, terminate?: boolean) => {
    await sessionOf(event, sessionId).disconnect(terminate);
  });

  ipcMain.handle('debug:session-list', async (event) => {
    const dm = managerOf(event);
    if (!dm) return [];
    return dm.getActive().map((s) => ({
      sessionId: s.id,
      config: s.config,
      capabilities: s.capabilities,
      status: s.status(),
    }));
  });

  // ─── 执行控制 ─────────────────────────────────────────────────────────

  ipcMain.handle('debug:session-resume', async (event, sessionId: string, threadId?: number) => {
    await sessionOf(event, sessionId).resume(threadId);
  });

  ipcMain.handle('debug:session-pause', async (event, sessionId: string, threadId?: number) => {
    await sessionOf(event, sessionId).pause(threadId);
  });

  ipcMain.handle('debug:session-step-over', async (event, sessionId: string, threadId: number) => {
    await sessionOf(event, sessionId).stepOver(threadId);
  });

  ipcMain.handle('debug:session-step-into', async (event, sessionId: string, threadId: number) => {
    await sessionOf(event, sessionId).stepInto(threadId);
  });

  ipcMain.handle('debug:session-step-out', async (event, sessionId: string, threadId: number) => {
    await sessionOf(event, sessionId).stepOut(threadId);
  });

  // ─── 暂停时检查 ──────────────────────────────────────────────────────

  ipcMain.handle('debug:session-threads', async (event, sessionId: string) => {
    return sessionOf(event, sessionId).threads();
  });

  ipcMain.handle('debug:session-stack-trace', async (event, sessionId: string, threadId: number) => {
    return sessionOf(event, sessionId).stackFrames(threadId);
  });

  ipcMain.handle('debug:session-scopes', async (event, sessionId: string, frameId: number) => {
    return sessionOf(event, sessionId).scopes(frameId);
  });

  ipcMain.handle('debug:session-variables', async (event, sessionId: string, variablesReference: number) => {
    return sessionOf(event, sessionId).variables(variablesReference);
  });

  ipcMain.handle(
    'debug:session-evaluate',
    async (event, sessionId: string, expression: string, frameId?: number) => {
      return sessionOf(event, sessionId).evaluate(expression, frameId);
    },
  );

  // ─── 断点 ────────────────────────────────────────────────────────────

  ipcMain.handle(
    'debug:session-set-line-breakpoints',
    async (event, sessionId: string, file: string, breakpoints: LineBreakpoint[]) => {
      return sessionOf(event, sessionId).setLineBreakpoints(file, breakpoints);
    },
  );
}
