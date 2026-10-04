import type { CommandContext } from '../commands/index.js';
import { buildCommandContextFromMain, type ProviderCommandContextWithOutput } from './coreCommandContexts.js';
import { buildProviderContextFromMain } from './providerContextAdapter.js';
import type { ProviderConfigEntry, ProviderProtocol } from '@neoxlabs/platform/utils/config.js';
import type { ProviderCommandContext } from '../commands/providerTypes.js';
import type { ProviderStore } from '@neoxlabs/platform/utils/providerStore.js';
import type { NeoxClient } from '@neoxlabs/core/sdk/client.js';
import type { InkUIAdapter } from '../ink/InkUIAdapter.js';

export function buildCommandContextFromMainState(params: {
  sdkClient: any;
  uiController: any;
  colors: any;
  sessionEnabled: boolean;
  sessionManager: any;
  currentSession: any;
  compatProfile: any;
  autoCompactionInProgress: boolean;
  isTaskRunning: boolean;
  workDir: string;
  logInfo: (message: string, details?: string) => void;
  activateSession: (session: any, options?: { loadHistory?: boolean }) => Promise<number>;
  normalizeCheckpoints: (rawCheckpoints: any) => any[];
  promptSelect: CommandContext['promptSelect'];
  promptText: CommandContext['promptText'];
}): CommandContext {
  return buildCommandContextFromMain({
    sdkClient: params.sdkClient,
    uiController: params.uiController,
    colors: params.colors,
    sessionEnabled: params.sessionEnabled,
    sessionManager: params.sessionManager,
    currentSession: params.currentSession,
    compatProfile: params.compatProfile,
    autoCompactionInProgress: params.autoCompactionInProgress,
    isRunning: params.isTaskRunning,
    workspacePath: params.workDir,
    logInfo: params.logInfo,
    activateSession: params.activateSession,
    normalizeCheckpoints: params.normalizeCheckpoints,
    withRuntimeEvents: async (action) => await action(),
    promptSelect: params.promptSelect,
    promptText: params.promptText,
  });
}

export function buildProviderCommandContextFromMainState(params: {
  providerId: string;
  provider: ProviderProtocol;
  model: string;
  providerSettings: ProviderConfigEntry;
  providerStore: ProviderStore;
  promptText: ProviderCommandContext['promptText'];
  promptSelect: ProviderCommandContext['promptSelect'];
  promptYesNo: ProviderCommandContext['promptYesNo'];
  promptConfirmKeyword: ProviderCommandContext['promptConfirmKeyword'];
  selectProviderFromList: ProviderCommandContext['selectProviderFromList'];
  selectModelFromProvider: ProviderCommandContext['selectModelFromProvider'];
  selectModelFromCurrentProvider: (message: string) => Promise<string | null>;
  getProviderByIdentifier: ProviderCommandContext['getProviderByIdentifier'];
  setProviderState: (state: { providerId: string; provider: ProviderProtocol; model: string; providerSettings: ProviderCommandContext['providerSettings'] }) => void;
  refreshProviderSettings: () => void;
  rebuildCompatProfile: () => void;
  rebuildAgentAndRunner: () => Promise<void>;
  updateContextWindowDisplay: () => void;
  getProviderDisplayName: () => string;
  sdkClient: NeoxClient | null;
  getSdkSessionId: () => string;
  logInfo: (message: string, details?: string) => void;
  uiController: InkUIAdapter | null;
  getActiveReasoningEffort: (model?: string) => string | undefined;
}): ProviderCommandContextWithOutput {
  return buildProviderContextFromMain({
    providerId: params.providerId,
    provider: params.provider,
    model: params.model,
    providerSettings: params.providerSettings,
    providerStore: params.providerStore,
    promptText: params.promptText,
    promptSelect: params.promptSelect,
    promptYesNo: params.promptYesNo,
    promptConfirmKeyword: params.promptConfirmKeyword,
    selectProviderFromList: params.selectProviderFromList,
    selectModelFromProvider: params.selectModelFromProvider,
    selectModelFromCurrentProvider: params.selectModelFromCurrentProvider,
    getProviderByIdentifier: params.getProviderByIdentifier,
    setProviderState: params.setProviderState,
    refreshProviderSettings: params.refreshProviderSettings,
    rebuildCompatProfile: params.rebuildCompatProfile,
    rebuildAgentAndRunner: params.rebuildAgentAndRunner,
    updateContextWindowDisplay: params.updateContextWindowDisplay,
    getProviderDisplayName: params.getProviderDisplayName,
    sdkClient: params.sdkClient,
    getSdkSessionId: params.getSdkSessionId,
    logInfo: params.logInfo,
    uiController: params.uiController,
    getActiveReasoningEffort: params.getActiveReasoningEffort,
  });
}

export function buildProviderCommandContextGetterFromMainState(params: {
  providerId: string;
  provider: ProviderProtocol;
  model: string;
  providerSettings: ProviderConfigEntry;
  providerStore: ProviderStore;
  promptText: ProviderCommandContext['promptText'];
  promptSelect: ProviderCommandContext['promptSelect'];
  promptYesNo: (question: string, initialYes?: boolean) => Promise<boolean>;
  promptConfirmKeyword: (message: string, keyword: string) => Promise<boolean>;
  selectProviderFromList: ProviderCommandContext['selectProviderFromList'];
  selectModelFromProvider: ProviderCommandContext['selectModelFromProvider'];
  getProviderByIdentifier: ProviderCommandContext['getProviderByIdentifier'];
  setProviderState: (state: { providerId: string; provider: ProviderProtocol; model: string; providerSettings: ProviderCommandContext['providerSettings'] }) => void;
  refreshProviderSettings: () => void;
  rebuildCompatProfile: () => void;
  rebuildAgentAndRunner: () => Promise<void>;
  updateContextWindowDisplay: () => void;
  getProviderDisplayName: () => string;
  sdkClient: NeoxClient | null;
  getSdkSessionId: () => string;
  logInfo: (message: string, details?: string) => void;
  uiController: InkUIAdapter | null;
  getActiveReasoningEffort: (model?: string) => string | undefined;
}): () => ProviderCommandContextWithOutput {
  return () => buildProviderCommandContextFromMainState({
    providerId: params.providerId,
    provider: params.provider,
    model: params.model,
    providerSettings: params.providerSettings,
    providerStore: params.providerStore,
    promptText: params.promptText,
    promptSelect: params.promptSelect,
    promptYesNo: params.promptYesNo,
    promptConfirmKeyword: params.promptConfirmKeyword,
    selectProviderFromList: params.selectProviderFromList,
    selectModelFromProvider: params.selectModelFromProvider,
    selectModelFromCurrentProvider: async (message) => {
      if (!params.providerSettings) {
        params.logInfo('No provider configured', 'Add a provider before managing models.');
        return null;
      }
      return params.selectModelFromProvider(params.providerSettings, message);
    },
    getProviderByIdentifier: params.getProviderByIdentifier,
    setProviderState: params.setProviderState,
    refreshProviderSettings: params.refreshProviderSettings,
    rebuildCompatProfile: params.rebuildCompatProfile,
    rebuildAgentAndRunner: params.rebuildAgentAndRunner,
    updateContextWindowDisplay: params.updateContextWindowDisplay,
    getProviderDisplayName: params.getProviderDisplayName,
    sdkClient: params.sdkClient,
    getSdkSessionId: params.getSdkSessionId,
    logInfo: params.logInfo,
    uiController: params.uiController,
    getActiveReasoningEffort: params.getActiveReasoningEffort,
  });
}
