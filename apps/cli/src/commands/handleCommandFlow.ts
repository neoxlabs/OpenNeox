import { dispatchCommandFromMain } from './commandDispatcher.js';
import { handleCommandPreludeFromMain } from './commandPreludeAdapter.js';

export async function handleCommandFlowFromMain(params: {
  command: string;
  workDir: string;
  addSkillError: (message: string) => void;
  executeSkillOutput: (output: string) => Promise<void>;
  getThinkingCommandContext: () => any;
  getBasicCommandRoutingDeps: () => any;
  getModeAndModelCommandRoutingDeps: () => any;
  getAttachmentCommandRoutingDeps: () => any;
  getServiceCommandRoutingDeps: () => any;
  getUiUtilityCommandRoutingDeps: () => any;
  getModeFeatureCommandRoutingDeps: () => any;
  getMiscCommandRoutingDeps: () => any;
  getSessionProcessRoutingDeps: () => any;
  getAccountCommandRoutingDeps?: () => { refreshAccountStatus?: () => void };
  /** /target 命令 (Target Mission Phase 1). optional. */
  getTargetCommandRoutingDeps?: () => {
    logInfo: (title: string, message?: string) => void;
    logError?: (title: string, message?: string) => void;
  };
  logUnknownCommand: (cmdRaw: string) => void;
}): Promise<void> {
  const trimmed = params.command.trim();
  if (!trimmed) {
    return;
  }

  const [cmdRaw, ...args] = trimmed.split(/\s+/);
  const cmd = cmdRaw.toLowerCase();

  //    catch 住报给用户 (addSkillError → uiController.addError), 然后 return.
  try {
    if (await handleCommandPreludeFromMain({
      trimmed,
      workDir: params.workDir,
      addSkillError: (message) => {
        params.addSkillError(message);
      },
      executeSkillOutput: async (output) => params.executeSkillOutput(output),
      getThinkingCommandContext: () => params.getThinkingCommandContext(),
    })) {
      return;
    }

    const handled = await dispatchCommandFromMain({
      cmd,
      args,
      getBasicCommandRoutingDeps: () => params.getBasicCommandRoutingDeps(),
      getModeAndModelCommandRoutingDeps: () => params.getModeAndModelCommandRoutingDeps(),
      getAttachmentCommandRoutingDeps: () => params.getAttachmentCommandRoutingDeps(),
      getServiceCommandRoutingDeps: () => params.getServiceCommandRoutingDeps(),
      getUiUtilityCommandRoutingDeps: () => params.getUiUtilityCommandRoutingDeps(),
      getModeFeatureCommandRoutingDeps: () => params.getModeFeatureCommandRoutingDeps(),
      getMiscCommandRoutingDeps: () => params.getMiscCommandRoutingDeps(),
      getSessionProcessRoutingDeps: () => params.getSessionProcessRoutingDeps(),
      getAccountCommandRoutingDeps: params.getAccountCommandRoutingDeps,
      getTargetCommandRoutingDeps: params.getTargetCommandRoutingDeps,
    });
    if (handled) {
      return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'cancelled') {
      return;
    }
    params.addSkillError(`Command failed: ${cmdRaw} — ${message}`);
    return;
  }

  params.logUnknownCommand(cmdRaw);
}
