import { buildServiceCommandRoutingDeps } from './commandRoutingDepBuilders.js';
import { handleWebSearchCommandFromMain } from './webSearchCommand.js';

export type ServiceRoutingDepsFromMain = {
  handleApproval: (args: string[]) => Promise<void>;
  handleWebSearch: (args: string[]) => Promise<void>;
  handleNotify: (actionArg?: string) => Promise<void>;
  handleMcp: (actionArg?: string) => Promise<void>;
  handleRemote: (actionArg?: string) => Promise<void>;
  handleSupervisor: (actionArg?: string) => Promise<void>;
};

export function buildServiceCommandRoutingDepsFromMain(params: {
  getConfigCommandContext: () => any;
  getNotifyCommandContext: () => any;
  getMcpCommandContext: () => any;
  getRemoteCommandContext: () => any;
  getSupervisorCommandContext: () => any;
  webSearch: {
    userConfig: any;
    promptSelect: (
      question: string,
      choices: any[],
      defaultValue?: string,
      hint?: string
    ) => Promise<string>;
    promptText: (
      question: string,
      options?: { allowEmpty?: boolean; defaultValue?: string }
    ) => Promise<string>;
    logInfo: (message: string, details?: string) => void;
    updateUserConfig: (config: any) => void;
    persistConfig: (config: any) => void;
    refreshTools: () => Promise<void>;
  };
}): ServiceRoutingDepsFromMain {
  return buildServiceCommandRoutingDeps({
    getConfigCommandContext: params.getConfigCommandContext,
    getNotifyCommandContext: params.getNotifyCommandContext,
    getMcpCommandContext: params.getMcpCommandContext,
    getRemoteCommandContext: params.getRemoteCommandContext,
    getSupervisorCommandContext: params.getSupervisorCommandContext,
    handleWebSearchCommand: async (args) => {
      await handleWebSearchCommandFromMain(args, {
        userConfig: params.webSearch.userConfig,
        promptSelect: params.webSearch.promptSelect,
        promptText: params.webSearch.promptText,
        logInfo: params.webSearch.logInfo,
        updateUserConfig: params.webSearch.updateUserConfig,
        persistConfig: params.webSearch.persistConfig,
        refreshTools: params.webSearch.refreshTools,
      });
    },
  });
}
