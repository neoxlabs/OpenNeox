import { handleAttachmentCommandRouting } from './attachmentCommands.js';
import { handleBasicCommandRouting } from './basicCommandRouting.js';
import { runCommandPipeline } from './commandPipeline.js';
import { handleMiscCommandRouting } from './miscCommandRouting.js';
import { handleModeAndModelCommandRouting } from './modeAndModelCommandRouting.js';
import { handleModeFeatureCommandRouting } from './modeFeatureCommandRouting.js';
import { handleServiceCommandRouting } from './serviceCommandRouting.js';
import { handleSessionProcessRouting } from './sessionProcessRouting.js';
import { handleUiUtilityCommandRouting } from './uiUtilityCommandRouting.js';
import { handleTargetCommandRouting } from './targetCommandRouting.js';
import { findCliSlashCommand, type CliSlashCommandDeps } from '../edition/index.js';

export type CommandDispatcherFromMainParams = {
  cmd: string;
  args: string[];
  getBasicCommandRoutingDeps: () => any;
  getModeAndModelCommandRoutingDeps: () => any;
  getAttachmentCommandRoutingDeps: () => any;
  getServiceCommandRoutingDeps: () => any;
  getUiUtilityCommandRoutingDeps: () => any;
  getModeFeatureCommandRoutingDeps: () => any;
  getMiscCommandRoutingDeps: () => any;
  getSessionProcessRoutingDeps: () => any;
  getAccountCommandRoutingDeps?: () => CliSlashCommandDeps;
  /** /target 命令 deps (target mission Phase 1 — 单 agent 长跑). */
  getTargetCommandRoutingDeps?: () => {
    logInfo: (title: string, message?: string) => void;
    logError?: (title: string, message?: string) => void;
  };
};

export async function dispatchCommandFromMain(
  params: CommandDispatcherFromMainParams,
): Promise<boolean> {
  return runCommandPipeline({
    handlers: [
      async () => {
        const editionCommand = findCliSlashCommand(params.cmd);
        if (!editionCommand) return false;
        await editionCommand.run(
          params.args,
          params.getAccountCommandRoutingDeps ? params.getAccountCommandRoutingDeps() : {},
        );
        return true;
      },
      /* /target 命令 — Target Mission Phase 1 (单 agent 长跑).
       * 放在 basic 之前避免和其他命令冲突. */
      async () => params.getTargetCommandRoutingDeps
        ? handleTargetCommandRouting(params.cmd, params.args, params.getTargetCommandRoutingDeps())
        : false,
      async () => handleBasicCommandRouting(params.cmd, params.args, params.getBasicCommandRoutingDeps()),
      async () => handleModeAndModelCommandRouting(params.cmd, params.args, params.getModeAndModelCommandRoutingDeps()),
      async () => handleAttachmentCommandRouting(params.cmd, params.args, params.getAttachmentCommandRoutingDeps()),
      async () => handleServiceCommandRouting(params.cmd, params.args, params.getServiceCommandRoutingDeps()),
      async () => handleUiUtilityCommandRouting({ cmd: params.cmd, ...params.getUiUtilityCommandRoutingDeps() }),
      async () => handleModeFeatureCommandRouting({ cmd: params.cmd, args: params.args, ...params.getModeFeatureCommandRoutingDeps() }),
      async () => handleMiscCommandRouting(params.cmd, params.args, params.getMiscCommandRoutingDeps()),
      async () => handleSessionProcessRouting(params.cmd, params.args, params.getSessionProcessRoutingDeps()),
    ],
  });
}
