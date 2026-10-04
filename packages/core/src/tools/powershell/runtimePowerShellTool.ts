/**
 * Runtime PowerShell Tool — 运行时绑定工厂
 *
 * 对标 runtimeShellTool.ts，复用 shell 执行基础设施
 */

import type { PlatformLogger, PlatformServices } from '@neoxlabs/platform/platform/services.js';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import type { TerminalExecutor } from '../terminal/executorRegistry.js';
import { createPowerShellTool } from './powershellTool.js';
import { runBackgroundShellCommand } from '../shell/backgroundShellExecution.js';
import { runForegroundShellCommand } from '../shell/foregroundShellExecution.js';
import { getBackgroundTaskCallback, getShellOutputStreamCallback } from '../shell/shellUiCallbacks.js';

interface RuntimePowerShellToolDeps {
  getSandboxEnabled: () => boolean;
  getTerminalExecutor: () => TerminalExecutor | null;
  getToolLogger: () => PlatformLogger;
  getToolServices: () => PlatformServices;
  getWorkspaceRoot: () => string;
}

export function createRuntimePowerShellTool({
  getSandboxEnabled,
  getTerminalExecutor,
  getToolLogger,
  getToolServices,
  getWorkspaceRoot,
}: RuntimePowerShellToolDeps): Tool {
  return createPowerShellTool({
    getWorkspaceRoot,
    getSandboxEnabled,
    getToolLogger,
    getToolServices,
    getTerminalExecutor,
    getShellOutputStreamCallback,
    getBackgroundTaskCallback,
    runForegroundShellCommand,
    runBackgroundShellCommand,
  });
}
