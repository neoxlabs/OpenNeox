import type {
  CommandContext,
  ProviderCommandContext,
} from '../commands/index.js';
import { createCommandOutputLinesCallbacks } from '../utils/commandOutputLines.js';

export type ProviderCommandContextWithOutput = ProviderCommandContext & {
  outputFn?: (line: string) => void;
};

interface CommandContextDeps {
  sdkClient: CommandContext['sdkClient'];
  uiController: CommandContext['uiController'];
  colors: CommandContext['colors'];
  sessionEnabled: CommandContext['sessionEnabled'];
  sessionManager: CommandContext['sessionManager'];
  sessionSync: CommandContext['sessionSync'];
  currentSession: CommandContext['currentSession'];
  compatProfile: CommandContext['compatProfile'];
  autoCompactionInProgress: CommandContext['autoCompactionInProgress'];
  isRunning: CommandContext['isRunning'];
  workspacePath: CommandContext['workspacePath'];
  logInfo: CommandContext['logInfo'];
  activateSession: CommandContext['activateSession'];
  normalizeCheckpoints: CommandContext['normalizeCheckpoints'];
  withRuntimeEvents: CommandContext['withRuntimeEvents'];
  promptSelect: CommandContext['promptSelect'];
  promptText: CommandContext['promptText'];
  outputLines: CommandContext['outputLines'];
  clearOutputLines: CommandContext['clearOutputLines'];
}

interface ProviderContextDeps {
  providerId: ProviderCommandContext['providerId'];
  provider: ProviderCommandContext['provider'];
  model: ProviderCommandContext['model'];
  providerSettings: ProviderCommandContext['providerSettings'];
  getProviders: ProviderCommandContext['getProviders'];
  getProvider: ProviderCommandContext['getProvider'];
  getDefaultProvider: ProviderCommandContext['getDefaultProvider'];
  getProviderCount: ProviderCommandContext['getProviderCount'];
  resolveModel: ProviderCommandContext['resolveModel'];
  addProvider: ProviderCommandContext['addProvider'];
  updateProvider: ProviderCommandContext['updateProvider'];
  deleteProvider: ProviderCommandContext['deleteProvider'];
  renameProvider: ProviderCommandContext['renameProvider'];
  setDefaultProvider: ProviderCommandContext['setDefaultProvider'];
  setLastSelectedModel: ProviderCommandContext['setLastSelectedModel'];
  addModel: ProviderCommandContext['addModel'];
  removeModel: ProviderCommandContext['removeModel'];
  updateModelConfig: ProviderCommandContext['updateModelConfig'];
  promptText: ProviderCommandContext['promptText'];
  promptSelect: ProviderCommandContext['promptSelect'];
  promptYesNo: ProviderCommandContext['promptYesNo'];
  promptConfirmKeyword: ProviderCommandContext['promptConfirmKeyword'];
  selectProviderFromList: ProviderCommandContext['selectProviderFromList'];
  selectModelFromProvider: ProviderCommandContext['selectModelFromProvider'];
  selectModelFromCurrentProvider: ProviderCommandContext['selectModelFromCurrentProvider'];
  getProviderByIdentifier: ProviderCommandContext['getProviderByIdentifier'];
  applyProviderState: ProviderCommandContext['applyProviderState'];
  refreshProviderSettings: ProviderCommandContext['refreshProviderSettings'];
  getProviderDisplayName: ProviderCommandContext['getProviderDisplayName'];
  hasConversationContext: ProviderCommandContext['hasConversationContext'];
  clearConversationContext: ProviderCommandContext['clearConversationContext'];
  logInfo: ProviderCommandContext['logInfo'];
  updateProviderDisplay: ProviderCommandContext['updateProviderDisplay'];
  outputFn?: (line: string) => void;
}

interface CommandContextMainAdapterDeps {
  sdkClient: CommandContext['sdkClient'];
  uiController: CommandContext['uiController'];
  colors: CommandContext['colors'];
  sessionEnabled: CommandContext['sessionEnabled'];
  sessionManager: CommandContext['sessionManager'];
  currentSession: CommandContext['currentSession'];
  compatProfile: CommandContext['compatProfile'];
  autoCompactionInProgress: CommandContext['autoCompactionInProgress'];
  isRunning: CommandContext['isRunning'];
  workspacePath: CommandContext['workspacePath'];
  logInfo: CommandContext['logInfo'];
  activateSession: CommandContext['activateSession'];
  normalizeCheckpoints: CommandContext['normalizeCheckpoints'];
  withRuntimeEvents: CommandContext['withRuntimeEvents'];
  promptSelect: CommandContext['promptSelect'];
  promptText: CommandContext['promptText'];
}

export function buildCommandContext(deps: CommandContextDeps): CommandContext {
  return {
    runtimeHost: null as any,
    sdkClient: deps.sdkClient,
    uiController: deps.uiController,
    colors: deps.colors,
    sessionEnabled: deps.sessionEnabled,
    sessionManager: deps.sessionManager,
    sessionSync: deps.sessionSync,
    currentSession: deps.currentSession,
    compatProfile: deps.compatProfile,
    autoCompactionInProgress: deps.autoCompactionInProgress,
    isRunning: deps.isRunning,
    workspacePath: deps.workspacePath,
    logInfo: deps.logInfo,
    activateSession: deps.activateSession,
    normalizeCheckpoints: deps.normalizeCheckpoints,
    withRuntimeEvents: deps.withRuntimeEvents,
    promptSelect: deps.promptSelect,
    promptText: deps.promptText,
    outputLines: deps.outputLines,
    clearOutputLines: deps.clearOutputLines,
  };
}

export function buildCommandContextFromMain(
  deps: CommandContextMainAdapterDeps,
): CommandContext {
  const outputCallbacks = createCommandOutputLinesCallbacks(deps.uiController);
  return buildCommandContext({
    sdkClient: deps.sdkClient,
    uiController: deps.uiController,
    colors: deps.colors,
    sessionEnabled: deps.sessionEnabled,
    sessionManager: deps.sessionManager,
    sessionSync: null,
    currentSession: deps.currentSession,
    compatProfile: deps.compatProfile,
    autoCompactionInProgress: deps.autoCompactionInProgress,
    isRunning: deps.isRunning,
    workspacePath: deps.workspacePath,
    logInfo: deps.logInfo,
    activateSession: deps.activateSession,
    normalizeCheckpoints: deps.normalizeCheckpoints,
    withRuntimeEvents: deps.withRuntimeEvents,
    promptSelect: deps.promptSelect,
    promptText: deps.promptText,
    outputLines: outputCallbacks.outputLines,
    clearOutputLines: outputCallbacks.clearOutputLines,
  });
}

export function buildProviderCommandContext(
  deps: ProviderContextDeps,
): ProviderCommandContextWithOutput {
  return {
    providerId: deps.providerId,
    provider: deps.provider,
    model: deps.model,
    providerSettings: deps.providerSettings,
    getProviders: deps.getProviders,
    getProvider: deps.getProvider,
    getDefaultProvider: deps.getDefaultProvider,
    getProviderCount: deps.getProviderCount,
    resolveModel: deps.resolveModel,
    addProvider: deps.addProvider,
    updateProvider: deps.updateProvider,
    deleteProvider: deps.deleteProvider,
    renameProvider: deps.renameProvider,
    setDefaultProvider: deps.setDefaultProvider,
    setLastSelectedModel: deps.setLastSelectedModel,
    addModel: deps.addModel,
    removeModel: deps.removeModel,
    updateModelConfig: deps.updateModelConfig,
    promptText: deps.promptText,
    promptSelect: deps.promptSelect,
    promptYesNo: deps.promptYesNo,
    promptConfirmKeyword: deps.promptConfirmKeyword,
    selectProviderFromList: deps.selectProviderFromList,
    selectModelFromProvider: deps.selectModelFromProvider,
    selectModelFromCurrentProvider: deps.selectModelFromCurrentProvider,
    getProviderByIdentifier: deps.getProviderByIdentifier,
    applyProviderState: deps.applyProviderState,
    refreshProviderSettings: deps.refreshProviderSettings,
    getProviderDisplayName: deps.getProviderDisplayName,
    hasConversationContext: deps.hasConversationContext,
    clearConversationContext: deps.clearConversationContext,
    logInfo: deps.logInfo,
    updateProviderDisplay: deps.updateProviderDisplay,
    outputFn: deps.outputFn,
  };
}
