import { ipcMain } from './ipcMainBridged.js';
/* 类型是纯类型导入, 编译后完全擦除 —— 不会在运行时把 electron 拉进来。
 * 值 (ipcMain) 走桥的替身, 于是这个文件在纯 Node 后端里也 import 得动。 */
import type { IpcMainInvokeEvent } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TerminalService } from '../../../platform-electron/terminalService.js';
import { storageService } from '../../../platform-electron/storageService.js';
import type { ProjectManager } from '../context/ProjectManager.js';
import type { ProjectScope } from '../context/ProjectScope.js';
import { OWNED_IDS_TRACKER, TERMINAL_SERVICE } from '../context/tokens.js';

interface RegisterTerminalIpcHandlersOptions {
  projectManager: ProjectManager;
}

interface TerminalCreateOptions {
  cwd?: string;
  shell?: string;
  cols?: number;
  rows?: number;
}

const normalizeForCompare = (value: string): string =>
  process.platform === 'win32' ? value.toLowerCase() : value;

const realpathOrResolve = (value: string): string => {
  const resolved = path.resolve(value);
  try {
    return typeof fs.realpathSync.native === 'function'
      ? fs.realpathSync.native(resolved)
      : fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
};

const isPathInside = (basePath: string, targetPath: string): boolean => {
  const base = normalizeForCompare(realpathOrResolve(basePath));
  const target = normalizeForCompare(realpathOrResolve(targetPath));
  if (target === base) return true;
  const relative = path.relative(base, target);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const clampDimension = (value: unknown, fallback: number, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
};

const resolveTerminalCwd = (scope: ProjectScope, requestedCwd?: string): string => {
  const roots = storageService.getWorkspaceRootsSync(scope.workspacePath);
  const allowedRoots = roots.length > 0 ? roots : [scope.workspacePath];
  const requested = typeof requestedCwd === 'string' ? requestedCwd.trim() : '';
  const candidate = requested
    ? realpathOrResolve(requested)
    : realpathOrResolve(scope.workspacePath);

  if (!allowedRoots.some(root => isPathInside(root, candidate))) {
    throw new Error('Terminal cwd must be inside the current workspace');
  }

  const stat = fs.statSync(candidate);
  if (!stat.isDirectory()) {
    throw new Error('Terminal cwd must be an existing directory');
  }
  return candidate;
};

const sanitizeTerminalOptions = (scope: ProjectScope, options?: TerminalCreateOptions): TerminalCreateOptions => ({
  cwd: resolveTerminalCwd(scope, options?.cwd),
  cols: clampDimension(options?.cols, 120, 20, 300),
  rows: clampDimension(options?.rows, 30, 8, 120),
  // Renderer-provided shell is intentionally ignored. Main process owns shell choice.
});

/**
 * Per-project 隔离: 每个 ProjectScope 自己的 TerminalService.
 * data/exit 事件的路由不在这里 —— 每个 scope 在 bootstrapProjectServices 里创建
 * TerminalService 时已经订阅了自己的 window.
 *
 * 没 project 打开时 terminal:* 调用会抛 "No active project" —— welcome page
 * 从不创建 terminal, 所以这个限制不影响正常路径.
 */
export function registerTerminalIpcHandlers(options: RegisterTerminalIpcHandlersOptions): void {
  const { projectManager } = options;

  const scopeOfOrThrow = (event: IpcMainInvokeEvent) => {
    const scope = projectManager.getBySender(event?.sender as any);
    if (!scope) throw new Error('No active project — terminal unavailable');
    return scope;
  };

  /** 反查 owner scope → service. 用于 write/resize/destroy/execute 这些传 sessionId 的操作. */
  const serviceForSession = (event: IpcMainInvokeEvent, sessionId: string): TerminalService => {
    const scope = projectManager.getByOwnedId('terminal', sessionId);
    const callerScope = projectManager.getBySender(event?.sender as any);
    if (!scope || !callerScope || scope !== callerScope) {
      throw new Error(`Terminal session ${sessionId} is not owned by the current project`);
    }
    const svc = scope?.tryGetService(TERMINAL_SERVICE);
    if (!svc) throw new Error(`Terminal session ${sessionId} not owned by any project`);
    return svc;
  };

  ipcMain.handle('terminal:create', async (event, options?: TerminalCreateOptions) => {
    const scope = scopeOfOrThrow(event);
    const service = scope.getService(TERMINAL_SERVICE);
    const sanitizedOptions = sanitizeTerminalOptions(scope, options);
    const sessionId = service.createSession(sanitizedOptions);
    const session = service.getSession(sessionId);
    scope.tryGetService(OWNED_IDS_TRACKER)?.claim('terminal', sessionId);
    return {
      sessionId,
      cwd: session?.cwd || sanitizedOptions.cwd || scope.workspacePath,
      shell: session?.shell || (process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || 'bash'),
      windowsPty: process.platform === 'win32'
        ? { backend: 'conpty' as const, buildNumber: Number(os.release().split('.')[2]) || 0 }
        : undefined,
    };
  });

  ipcMain.handle('terminal:write', async (event, sessionId: string, data: string) => {
    serviceForSession(event, sessionId).write(sessionId, data);
  });

  ipcMain.handle('terminal:resize', async (event, sessionId: string, cols: number, rows: number) => {
    serviceForSession(event, sessionId).resize(sessionId, cols, rows);
  });

  ipcMain.handle('terminal:destroy', async (event, sessionId: string) => {
    serviceForSession(event, sessionId).destroy(sessionId);
    // OwnedIdsTracker.release 在 bootstrap 的 'exit' 事件里触发
  });

  ipcMain.handle('terminal:execute', async (event, sessionId: string, command: string, timeout?: number) => {
    return serviceForSession(event, sessionId).executeCommand(sessionId, command, timeout);
  });
}
