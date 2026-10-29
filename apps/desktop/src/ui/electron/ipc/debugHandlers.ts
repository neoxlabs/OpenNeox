import { ipcMain } from './ipcMainBridged.js';
/* 类型是纯类型导入, 编译后完全擦除 —— 不会在运行时把 electron 拉进来。
 * 值 (ipcMain) 走桥的替身, 于是这个文件在纯 Node 后端里也 import 得动。 */
import type { IpcMainInvokeEvent } from 'electron';
import type { DebugService } from '../services/debugService.js';
import type { ProjectManager } from '../context/ProjectManager.js';
import { DEBUG_SERVICE } from '../context/tokens.js';

interface RegisterDebugIpcHandlersOptions {
  projectManager: ProjectManager;
}

/**
 * Per-project 隔离: 每个 project 自己的 DebugService (breakpoints / debug sessions).
 * 事件路由在 bootstrapProjectServices 里做 —— 这里只是 CRUD 分发.
 *
 * 没 project 打开时返回空 (breakpoints) 或 noop (mutations), 而不是抛错 ——
 * renderer 的 breakpoint UI 即使在无 project 的过渡期也会轮询.
 */
export function registerDebugIpcHandlers(options: RegisterDebugIpcHandlersOptions): void {
  const { projectManager } = options;

  const serviceOf = (event: IpcMainInvokeEvent): DebugService | undefined => {
    const scope = projectManager.getBySender(event?.sender as any) ?? projectManager.getFocused();
    return scope?.tryGetService(DEBUG_SERVICE);
  };

  ipcMain.handle('debug:add-breakpoint', async (event, breakpoint: { file: string; line: number; condition?: string; hitCondition?: string; logMessage?: string; source: 'user' | 'llm' }) => {
    return serviceOf(event)?.addBreakpoint(breakpoint.file, breakpoint.line, {
      condition: breakpoint.condition,
      hitCondition: breakpoint.hitCondition,
      logMessage: breakpoint.logMessage,
      source: breakpoint.source,
    });
  });

  ipcMain.handle('debug:remove-breakpoint', async (event, breakpointId: string) => {
    return serviceOf(event)?.removeBreakpointById(breakpointId);
  });

  ipcMain.handle('debug:toggle-breakpoint', async (event, file: string, line: number) => {
    return serviceOf(event)?.toggleBreakpoint(file, line);
  });

  ipcMain.handle('debug:get-breakpoints', async (event, file?: string) => {
    const svc = serviceOf(event);
    if (!svc) return [];
    if (file) return svc.getBreakpointsForFile(file);
    return svc.getAllBreakpoints();
  });

  ipcMain.handle('debug:clear-breakpoints', async (event, file?: string, source?: 'user' | 'llm') => {
    const svc = serviceOf(event);
    if (!svc) return;
    if (source) {
      svc.clearBreakpointsBySource(source);
    } else if (file) {
      const bps = svc.getBreakpointsForFile(file);
      for (const bp of bps) {
        svc.removeBreakpointById(bp.id);
      }
    } else {
      svc.clearAllBreakpoints();
    }
  });

  const LEGACY_DEBUG_UNAVAILABLE =
    'Legacy debug sessions are not available. Interactive debugging currently supports JVM targets via the debug:session-* channels; for other runtimes use execute_shell (e.g. `node --inspect`, `python -m pdb`) or add logging instead.';

  ipcMain.handle('debug:start-session', async (_event, _config: { type: 'node' | 'python' | 'java'; program: string; args?: string[]; cwd?: string; env?: Record<string, string> }) => {
    throw new Error(LEGACY_DEBUG_UNAVAILABLE);
  });

  for (const channel of [
    'debug:stop-session',
    'debug:continue',
    'debug:step-over',
    'debug:step-into',
    'debug:step-out',
    'debug:pause',
    'debug:get-variables',
    'debug:get-stack-trace',
    'debug:evaluate',
  ]) {
    ipcMain.handle(channel, async () => {
      throw new Error(LEGACY_DEBUG_UNAVAILABLE);
    });
  }
}
