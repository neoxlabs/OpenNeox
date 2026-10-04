import { getExperimentalConfig } from '../config/experimentalFeatures.js';
import { runOnboardingIfNeeded } from '../ui/skillsAndLanguageMenus.js';
import { setupInteractiveFeatures } from './interactiveFeatures.js';

export async function runInteractiveFlowFromMain(params: {
  hasSeenOnboarding: boolean;
  hasUiController: boolean;
  promptSelect: (question: string, choices: any[], defaultValue?: string, hint?: string) => Promise<string>;
  logInfo: (message: string, details?: string) => void;
  markOnboardingSeen: () => void;
  runModernUI: () => Promise<void>;
}): Promise<void> {
  await runOnboardingIfNeeded({
    hasSeenOnboarding: params.hasSeenOnboarding,
    hasUiController: params.hasUiController,
    promptSelect: (question, choices, defaultValue, hint) =>
      params.promptSelect(question, choices, defaultValue, hint),
    logInfo: (message, details) => params.logInfo(message, details),
    markOnboardingSeen: () => {
      params.markOnboardingSeen();
    },
  });

  //  加载实验性功能配置
  const experimentalConfig = getExperimentalConfig();
  setupInteractiveFeatures(experimentalConfig);

  return params.runModernUI();
}
