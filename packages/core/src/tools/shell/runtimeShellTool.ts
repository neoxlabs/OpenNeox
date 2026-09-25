import type { PlatformLogger, PlatformServices } from '@neoxlabs/platform/platform/services.js';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import type { TerminalExecutor } from '../terminal/executorRegistry.js';
import { createExecuteShellTool } from './executeShellTool.js';
import { runBackgroundShellCommand } from './backgroundShellExecution.js';
import { runForegroundShellCommand } from './foregroundShellExecution.js';
import { executeShellInWorker } from './shellWorkerClient.js';
import { getBackgroundTaskCallback, getShellOutputStreamCallback } from './shellUiCallbacks.js';
import { runTerminalUiShellCommand } from './terminalUiExecution.js';
import { validateShellCommandForSandbox, warnBackgroundCommandSyntax } from './shellCommandGuards.js';

interface RuntimeShellToolDeps {
  getSandboxEnabled: () => boolean;
  getTerminalExecutor: () => TerminalExecutor | null;
  getToolLogger: () => PlatformLogger;
  getToolServices: () => PlatformServices;
  getWorkspaceRoot: () => string;
  shellOption: string | boolean;
}

export function createRuntimeShellTool({
  getSandboxEnabled,
  getTerminalExecutor,
  getToolLogger,
  getToolServices,
  getWorkspaceRoot,
  shellOption,
}: RuntimeShellToolDeps): Tool {
  return createExecuteShellTool({
    shellOption,
    getWorkspaceRoot,
    getSandboxEnabled,
    getToolLogger,
    getToolServices,
    getTerminalExecutor,
    getShellOutputStreamCallback,
    getBackgroundTaskCallback,
    validateShellCommandForSandbox,
    warnBackgroundCommandSyntax,
    runTerminalUiShellCommand,
    executeShellInWorker,
    runBackgroundShellCommand,
    runForegroundShellCommand,
  });
}
