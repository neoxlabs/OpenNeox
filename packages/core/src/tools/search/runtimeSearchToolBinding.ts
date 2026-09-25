import type { PlatformLogger } from '@neoxlabs/platform/platform/services.js';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { createRuntimeSearchTool } from './runtimeSearchTool.js';

type RunCommand = (
  command: string,
  args: string[],
  cwd: string,
  options?: { timeoutMs?: number; signal?: AbortSignal }
) => Promise<{ stdout: string; stderr: string; exitCode: number; durationMs: number }>;

interface RuntimeSearchToolBindingDeps {
  formatDisplayPath: (absPath: string) => string;
  getLogger: () => PlatformLogger;
  getWorkspaceRoot: () => string;
  resolveWorkspacePath: (requestedPath?: string) => string;
  runCommand: RunCommand;
}

export function createRuntimeSearchToolBinding({
  formatDisplayPath,
  getLogger,
  getWorkspaceRoot,
  resolveWorkspacePath,
  runCommand,
}: RuntimeSearchToolBindingDeps): Tool {
  return createRuntimeSearchTool({
    resolveWorkspacePath,
    formatDisplayPath,
    getWorkspaceRoot,
    runCommand,
    logger: {
      debug: (scope, message, data) => getLogger().debug(scope, message, data),
      info: (scope, message, data) => getLogger().info(scope, message, data),
      warn: (scope, message, data) => getLogger().warn(scope, message, data),
    },
  });
}
