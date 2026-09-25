import type { ProviderCommandContext } from '../commands/index.js';
import type { ProviderStore } from '@neoxlabs/platform/utils/providerStore.js';
import type { ProviderCommandContextWithOutput } from './coreCommandContexts.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

interface ProviderContextAdapterDeps {
  providerId: ProviderCommandContext['providerId'];
  provider: ProviderCommandContext['provider'];
  model: ProviderCommandContext['model'];
  providerSettings: ProviderCommandContext['providerSettings'];
  providerStore: ProviderStore;
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
  sdkClient: { getSessionInfo: (sessionId: string) => Promise<any>; clearMemory: (sessionId: string) => Promise<any> } | null;
  getSdkSessionId: () => string;
  logInfo: ProviderCommandContext['logInfo'];
  uiController: { updateProvider?: (providerName: string, model: string, effort?: string) => void; printCommandOutput?: (line: string) => void } | null;
  getActiveReasoningEffort: (model?: string) => string | undefined;
}

interface ProviderContextMainAdapterDeps {
  providerId: ProviderCommandContext['providerId'];
  provider: ProviderCommandContext['provider'];
  model: ProviderCommandContext['model'];
  providerSettings: ProviderCommandContext['providerSettings'];
  providerStore: ProviderStore;
  promptText: ProviderCommandContext['promptText'];
  promptSelect: ProviderCommandContext['promptSelect'];
  promptYesNo: ProviderCommandContext['promptYesNo'];
  promptConfirmKeyword: ProviderCommandContext['promptConfirmKeyword'];
  selectProviderFromList: ProviderCommandContext['selectProviderFromList'];
  selectModelFromProvider: ProviderCommandContext['selectModelFromProvider'];
  selectModelFromCurrentProvider: ProviderCommandContext['selectModelFromCurrentProvider'];
  getProviderByIdentifier: ProviderCommandContext['getProviderByIdentifier'];
  setProviderState: (state: Parameters<ProviderCommandContext['applyProviderState']>[0]) => void;
  refreshProviderSettings: ProviderCommandContext['refreshProviderSettings'];
  rebuildCompatProfile: () => void;
  rebuildAgentAndRunner: () => Promise<void>;
  updateContextWindowDisplay: () => void;
  getProviderDisplayName: ProviderCommandContext['getProviderDisplayName'];
  sdkClient: { getSessionInfo: (sessionId: string) => Promise<any>; clearMemory: (sessionId: string) => Promise<any> } | null;
  getSdkSessionId: () => string;
  logInfo: ProviderCommandContext['logInfo'];
  uiController: { updateProvider?: (providerName: string, model: string, effort?: string) => void; printCommandOutput?: (line: string) => void } | null;
  getActiveReasoningEffort: (model?: string) => string | undefined;
}

export function buildProviderContextFromAdapter(
  deps: ProviderContextAdapterDeps,
): ProviderCommandContextWithOutput {
  return {
    providerId: deps.providerId,
    provider: deps.provider,
    model: deps.model,
    providerSettings: deps.providerSettings,
    getProviders: () => deps.providerStore.getProviders(),
    getProvider: (id) => deps.providerStore.getProvider(id),
    getDefaultProvider: () => deps.providerStore.getDefaultProvider(),
    getProviderCount: () => deps.providerStore.getProviderCount(),
    resolveModel: (providerId) => deps.providerStore.resolveModel(providerId),
    addProvider: (opts) => deps.providerStore.addProvider(opts),
    updateProvider: (id, updates) => deps.providerStore.updateProvider(id, updates),
    deleteProvider: (id) => deps.providerStore.deleteProvider(id),
    renameProvider: (oldId, newId) => deps.providerStore.renameProvider(oldId, newId),
    setDefaultProvider: (id) => deps.providerStore.setDefaultProvider(id),
    setLastSelectedModel: (providerId, model) => deps.providerStore.setLastSelectedModel(providerId, model),
    addModel: (providerId, modelName, makeDefault, modelConfig) =>
      deps.providerStore.addModel(providerId, modelName, makeDefault, modelConfig),
    removeModel: (providerId, modelName) => deps.providerStore.removeModel(providerId, modelName),
    updateModelConfig: (providerId, modelName, updates) => deps.providerStore.updateModelConfig(providerId, modelName, updates),
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
    hasConversationContext: async () => {
      if (!deps.sdkClient) return false;
      const info = await deps.sdkClient.getSessionInfo(deps.getSdkSessionId()).catch(() => null);
      const messages = Array.isArray(info?.messages) ? info.messages : [];
      if (messages.length > 0) {
        return messages.some((msg: any) => msg?.role === 'user' || msg?.role === 'assistant' || msg?.role === 'tool');
      }
      return Number(info?.messageCount || 0) > 0;
    },
    clearConversationContext: async () => {
      if (!deps.sdkClient) return;
      try {
        await deps.sdkClient.clearMemory(deps.getSdkSessionId());
      } catch (error) {
        cliLogger.warn('CLI_PROVIDER', 'Failed to clear conversation context for provider switch', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    logInfo: deps.logInfo,
    updateProviderDisplay: (providerName, model) => {
      deps.uiController?.updateProvider?.(providerName, model, deps.getActiveReasoningEffort(model));
    },
    outputFn: deps.uiController?.printCommandOutput
      ? (line: string) => deps.uiController!.printCommandOutput!(line)
      : undefined,
  };
}

export function buildProviderContextFromMain(
  deps: ProviderContextMainAdapterDeps,
): ProviderCommandContextWithOutput {
  return buildProviderContextFromAdapter({
    providerId: deps.providerId,
    provider: deps.provider,
    model: deps.model,
    providerSettings: deps.providerSettings,
    providerStore: deps.providerStore,
    promptText: deps.promptText,
    promptSelect: deps.promptSelect,
    promptYesNo: deps.promptYesNo,
    promptConfirmKeyword: deps.promptConfirmKeyword,
    selectProviderFromList: deps.selectProviderFromList,
    selectModelFromProvider: deps.selectModelFromProvider,
    selectModelFromCurrentProvider: deps.selectModelFromCurrentProvider,
    getProviderByIdentifier: deps.getProviderByIdentifier,
    applyProviderState: async (state) => {
      deps.setProviderState(state);
      deps.refreshProviderSettings();
      deps.rebuildCompatProfile();
      await deps.rebuildAgentAndRunner();
      deps.updateContextWindowDisplay();
    },
    refreshProviderSettings: deps.refreshProviderSettings,
    getProviderDisplayName: deps.getProviderDisplayName,
    sdkClient: deps.sdkClient,
    getSdkSessionId: deps.getSdkSessionId,
    logInfo: deps.logInfo,
    uiController: deps.uiController,
    getActiveReasoningEffort: deps.getActiveReasoningEffort,
  });
}
