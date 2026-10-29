import { ipcMain } from './ipcMainBridged.js';
/* 类型是纯类型导入, 编译后完全擦除 —— 不会在运行时把 electron 拉进来。
 * 值 (ipcMain) 走桥的替身, 于是这个文件在纯 Node 后端里也 import 得动。 */
import type { IpcMainInvokeEvent } from 'electron';
import { flushPendingReadyReplay } from '../main.js';
import { PROJECT_STARTUP_COORDINATOR } from '../context/tokens.js';
import type { ProjectManager } from '../context/ProjectManager.js';

export interface RegisterProjectStartupIpcHandlersOptions {
  projectManager: ProjectManager;
}

export function registerProjectStartupIpcHandlers(options: RegisterProjectStartupIpcHandlersOptions): void {
  const { projectManager } = options;

  const coordinatorOf = (event: IpcMainInvokeEvent) => {
    const scope = projectManager.getBySender(event?.sender as any);
    return scope?.tryGetService(PROJECT_STARTUP_COORDINATOR) ?? null;
  };

  ipcMain.handle('project-startup:renderer-ready', async (event, _cwd?: string) => {
    try { flushPendingReadyReplay(); } catch { /* 补发失败不能挡住启动流程 */ }
    const coordinator = coordinatorOf(event);
    if (!coordinator) return { started: false };
    return coordinator.notifyRendererReady('renderer-ready');
  });

  ipcMain.handle('project-startup:status', async (event, _cwd?: string) => {
    const scope = projectManager.getBySender(event?.sender as any);
    const coordinator = scope?.peekService(PROJECT_STARTUP_COORDINATOR) ?? null;
    return coordinator?.getStatus() ?? {
      phase: 'opening',
      rendererReady: false,
      started: false,
      completed: false,
      semantic: 'idle',
      embedding: 'idle',
      error: null,
    };
  });
}
