import type { PlatformLogger } from '@neoxlabs/platform/platform/services.js';
import type { TerminalExecutor } from '../terminal/executorRegistry.js';
import { formatTerminalUiResult } from './executeShellMessages.js';

type RunTerminalUiShellCommandArgs = {
  command: string;
  workspaceRoot: string;
  terminalExecutor: TerminalExecutor | null;
  logger: PlatformLogger;
};

export async function runTerminalUiShellCommand({
  command,
  workspaceRoot,
  terminalExecutor,
  logger,
}: RunTerminalUiShellCommandArgs): Promise<string | null> {
  if (!terminalExecutor) {
    return null;
  }

  try {
    logger.debug('SHELL', 'Using terminal executor (UI mode)');
    const result = await terminalExecutor({
      command,
      cwd: workspaceRoot,
      timeout: 600000,
    });

    return formatTerminalUiResult(
      { workspaceRoot, command },
      result.output,
      result.exitCode
    );
  } catch (error: any) {
    logger.warn('SHELL', 'Terminal executor failed', { error: error.message });
    return null;
  }
}
