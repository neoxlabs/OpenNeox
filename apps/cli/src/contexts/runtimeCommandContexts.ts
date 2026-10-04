import type {
  RunConfigCommandContext,
  StatisticCommandContext,
  PricingCommandContext,
} from '../commands/index.js';
import type { ProviderStore } from '@neoxlabs/platform/utils/providerStore.js';
import { createCommandOutputLinesCallbacks } from '../utils/commandOutputLines.js';
import { promptInputFlow } from '../utils/legacyPrompts.js';

interface RunConfigContextDeps {
  userConfig: RunConfigCommandContext['userConfig'];
  promptSelect: RunConfigCommandContext['promptSelect'];
  promptText: RunConfigCommandContext['promptText'];
  getProviders: RunConfigCommandContext['getProviders'];
  activeProviderId: RunConfigCommandContext['activeProviderId'];
  logInfo: RunConfigCommandContext['logInfo'];
  updateConfig: RunConfigCommandContext['updateConfig'];
  workDir: RunConfigCommandContext['workDir'];
  llmCall: RunConfigCommandContext['llmCall'];
  readFile: RunConfigCommandContext['readFile'];
  listDir: RunConfigCommandContext['listDir'];
}

interface StatisticContextDeps {
  promptSelect: StatisticCommandContext['promptSelect'];
  logInfo: StatisticCommandContext['logInfo'];
  outputLines: StatisticCommandContext['outputLines'];
  clearOutputLines: StatisticCommandContext['clearOutputLines'];
  userConfig: StatisticCommandContext['userConfig'];
}

interface PricingContextDeps {
  userConfig: PricingCommandContext['userConfig'];
  promptSelect: PricingCommandContext['promptSelect'];
  promptInput: PricingCommandContext['promptInput'];
  logInfo: PricingCommandContext['logInfo'];
  updateConfig: PricingCommandContext['updateConfig'];
}

interface RunConfigMainAdapterDeps {
  userConfig: RunConfigCommandContext['userConfig'];
  promptSelect: RunConfigCommandContext['promptSelect'];
  promptText: RunConfigCommandContext['promptText'];
  providerStore: ProviderStore;
  activeProviderId: string;
  model: string;
  remoteAdapter: { chat: (payload: any) => Promise<any> } | null;
  logInfo: RunConfigCommandContext['logInfo'];
  updateConfig: RunConfigCommandContext['updateConfig'];
  workDir: RunConfigCommandContext['workDir'];
  readFile: RunConfigCommandContext['readFile'];
  listDir: RunConfigCommandContext['listDir'];
}

interface StatisticMainAdapterDeps {
  promptSelect: StatisticCommandContext['promptSelect'];
  logInfo: StatisticCommandContext['logInfo'];
  userConfig: StatisticCommandContext['userConfig'];
  uiController: any;
}

interface PricingMainAdapterDeps {
  userConfig: PricingCommandContext['userConfig'];
  promptSelect: PricingCommandContext['promptSelect'];
  acquirePromptLock: () => Promise<void>;
  releasePromptLock: () => void;
  uiController: any;
  logInfo: PricingCommandContext['logInfo'];
  updateConfig: PricingCommandContext['updateConfig'];
}

export function buildRunConfigCommandContext(deps: RunConfigContextDeps): RunConfigCommandContext {
  return {
    userConfig: deps.userConfig,
    promptSelect: deps.promptSelect,
    promptText: deps.promptText,
    getProviders: deps.getProviders,
    activeProviderId: deps.activeProviderId,
    logInfo: deps.logInfo,
    updateConfig: deps.updateConfig,
    workDir: deps.workDir,
    llmCall: deps.llmCall,
    readFile: deps.readFile,
    listDir: deps.listDir,
  };
}

export function buildRunConfigCommandContextFromMain(
  deps: RunConfigMainAdapterDeps,
): RunConfigCommandContext {
  return buildRunConfigCommandContext({
    userConfig: deps.userConfig,
    promptSelect: deps.promptSelect,
    promptText: deps.promptText,
    getProviders: () => deps.providerStore.getProviders(),
    activeProviderId: deps.activeProviderId,
    logInfo: deps.logInfo,
    updateConfig: deps.updateConfig,
    workDir: deps.workDir,
    llmCall: async (system: string, prompt: string) => {
      const modelEntry = deps.providerStore.getProviders()
        .find((provider) => provider.id === deps.activeProviderId)
        ?.models?.[0];
      if (!modelEntry) {
        throw new Error('未配置可用的 LLM 模型');
      }
      if (!deps.remoteAdapter) {
        throw new Error('Server not connected');
      }
      await deps.remoteAdapter.chat({
        sessionId: `llm-call-${Date.now()}`,
        prompt: `${system}\n\n${prompt}`,
        mode: 'agentic',
        providerId: deps.activeProviderId,
        modelName: deps.model,
      });
      return '';
    },
    readFile: deps.readFile,
    listDir: deps.listDir,
  });
}

export function buildStatisticCommandContext(deps: StatisticContextDeps): StatisticCommandContext {
  return {
    promptSelect: deps.promptSelect,
    logInfo: deps.logInfo,
    outputLines: deps.outputLines,
    clearOutputLines: deps.clearOutputLines,
    userConfig: deps.userConfig,
  };
}

export function buildStatisticCommandContextFromMain(
  deps: StatisticMainAdapterDeps,
): StatisticCommandContext {
  const outputCallbacks = createCommandOutputLinesCallbacks(deps.uiController);
  return buildStatisticCommandContext({
    promptSelect: deps.promptSelect,
    logInfo: deps.logInfo,
    outputLines: outputCallbacks.outputLines,
    clearOutputLines: outputCallbacks.clearOutputLines,
    userConfig: deps.userConfig,
  });
}

export function buildPricingCommandContext(deps: PricingContextDeps): PricingCommandContext {
  return {
    userConfig: deps.userConfig,
    promptSelect: deps.promptSelect,
    promptInput: deps.promptInput,
    logInfo: deps.logInfo,
    updateConfig: deps.updateConfig,
  };
}

export function buildPricingCommandContextFromMain(
  deps: PricingMainAdapterDeps,
): PricingCommandContext {
  return buildPricingCommandContext({
    userConfig: deps.userConfig,
    promptSelect: deps.promptSelect,
    promptInput: (prompt, defaultValue) =>
      promptInputFlow({
        prompt,
        defaultValue,
        acquirePromptLock: deps.acquirePromptLock,
        releasePromptLock: deps.releasePromptLock,
        uiPromptInput:
          deps.uiController && typeof deps.uiController.promptInput === 'function'
            ? (params) => deps.uiController.promptInput(params)
            : undefined,
      }),
    logInfo: deps.logInfo,
    updateConfig: deps.updateConfig,
  });
}
