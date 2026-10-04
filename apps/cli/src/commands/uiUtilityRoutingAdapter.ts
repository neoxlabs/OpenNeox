import { showLanguageMenuFlow, showSkillsScreenFlow } from '../ui/skillsAndLanguageMenus.js';
import { buildUiUtilityCommandRoutingDeps } from './commandRoutingDepBuilders.js';

export type UiUtilityRoutingDepsFromMain = {
  showSkillsScreen: () => Promise<void>;
  showLanguageMenu: () => Promise<void>;
  getCommandContext: () => any;
};

export function buildUiUtilityCommandRoutingDepsFromMain(params: {
  hasUiController: boolean;
  workDir: string;
  promptSelect: (
    question: string,
    choices: any[],
    defaultValue?: string,
    hint?: string
  ) => Promise<string>;
  promptText: (label: string, options?: any) => Promise<string>;
  logInfo: (message: string, details?: string) => void;
  executeSkillById: (skillId: string) => Promise<void>;
  getCommandContext: () => any;
}): UiUtilityRoutingDepsFromMain {
  return buildUiUtilityCommandRoutingDeps({
    showSkillsScreen: async () => {
      await showSkillsScreenFlow({
        hasUiController: params.hasUiController,
        workDir: params.workDir,
        promptSelect: params.promptSelect,
        promptText: params.promptText,
        logInfo: params.logInfo,
        executeSkillById: params.executeSkillById,
      });
    },
    showLanguageMenu: async () => {
      await showLanguageMenuFlow({
        hasUiController: params.hasUiController,
        promptSelect: params.promptSelect,
        logInfo: params.logInfo,
      });
    },
    getCommandContext: params.getCommandContext,
  });
}
