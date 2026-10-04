import type {
  ConfigCommandContext,
  IndexCommandContext,
  ContextCommandContext,
  MemoryCommandContext,
  RemoteCommandContext,
} from '../commands/index.js';
import { createCommandOutputLinesCallbacks } from '../utils/commandOutputLines.js';

interface ConfigContextDeps {
  approvalMode: ConfigCommandContext['approvalMode'];
  userConfig: ConfigCommandContext['userConfig'];
  promptSelect: ConfigCommandContext['promptSelect'];
  logInfo: ConfigCommandContext['logInfo'];
  cleanup: ConfigCommandContext['cleanup'];
  getScopedApprovalMode: ConfigCommandContext['getScopedApprovalMode'];
  setApprovalMode: ConfigCommandContext['setApprovalMode'];
  updateConfig: ConfigCommandContext['updateConfig'];
}

interface IndexContextDeps {
  userConfig: IndexCommandContext['userConfig'];
  workspacePath: IndexCommandContext['workspacePath'];
  promptSelect: IndexCommandContext['promptSelect'];
  logInfo: IndexCommandContext['logInfo'];
  updateConfig: IndexCommandContext['updateConfig'];
}

interface ContextContextDeps {
  userConfig: ContextCommandContext['userConfig'];
  promptSelect: ContextCommandContext['promptSelect'];
  logInfo: ContextCommandContext['logInfo'];
  updateConfig: ContextCommandContext['updateConfig'];
  runner: ContextCommandContext['runner'];
  uiController: ContextCommandContext['uiController'];
  memoryPressure: ContextCommandContext['memoryPressure'];
  updateCompactionThreshold: ContextCommandContext['updateCompactionThreshold'];
  updateCompressionMode: ContextCommandContext['updateCompressionMode'];
}

interface MemoryContextDeps {
  actionLog: MemoryCommandContext['actionLog'];
  userConfig: MemoryCommandContext['userConfig'];
  promptSelect: MemoryCommandContext['promptSelect'];
  promptText: MemoryCommandContext['promptText'];
  logInfo: MemoryCommandContext['logInfo'];
  updateConfig: MemoryCommandContext['updateConfig'];
  uiController: MemoryCommandContext['uiController'];
}

interface RemoteContextDeps {
  userConfig: RemoteCommandContext['userConfig'];
  promptSelect: RemoteCommandContext['promptSelect'];
  promptText: RemoteCommandContext['promptText'];
  logInfo: RemoteCommandContext['logInfo'];
  updateConfig: RemoteCommandContext['updateConfig'];
  startRemote: RemoteCommandContext['startRemote'];
  stopRemote: RemoteCommandContext['stopRemote'];
  regenerateToken: RemoteCommandContext['regenerateToken'];
  getStatus: RemoteCommandContext['getStatus'];
  outputLines: RemoteCommandContext['outputLines'];
  clearOutputLines: RemoteCommandContext['clearOutputLines'];
}

interface RemoteMainAdapterDeps {
  userConfig: RemoteCommandContext['userConfig'];
  promptSelect: RemoteCommandContext['promptSelect'];
  promptText: RemoteCommandContext['promptText'];
  logInfo: RemoteCommandContext['logInfo'];
  updateConfig: RemoteCommandContext['updateConfig'];
  startRemote: RemoteCommandContext['startRemote'];
  stopRemote: RemoteCommandContext['stopRemote'];
  regenerateToken: RemoteCommandContext['regenerateToken'];
  getStatus: RemoteCommandContext['getStatus'];
  uiController: any;
}

interface IndexMainAdapterDeps {
  userConfig: IndexCommandContext['userConfig'];
  workspacePath: IndexCommandContext['workspacePath'];
  promptSelect: IndexCommandContext['promptSelect'];
  logInfo: IndexCommandContext['logInfo'];
  updateConfig: IndexCommandContext['updateConfig'];
}

interface ContextMainAdapterDeps {
  userConfig: ContextCommandContext['userConfig'];
  promptSelect: ContextCommandContext['promptSelect'];
  logInfo: ContextCommandContext['logInfo'];
  updateConfig: ContextCommandContext['updateConfig'];
  uiController: ContextCommandContext['uiController'];
  memoryPressure: ContextCommandContext['memoryPressure'];
  updateCompactionThreshold: ContextCommandContext['updateCompactionThreshold'];
  syncCompressionMode: ContextCommandContext['updateCompressionMode'];
}

interface MemoryMainAdapterDeps {
  actionLog: MemoryCommandContext['actionLog'];
  userConfig: MemoryCommandContext['userConfig'];
  promptSelect: MemoryCommandContext['promptSelect'];
  promptText: MemoryCommandContext['promptText'];
  logInfo: MemoryCommandContext['logInfo'];
  updateConfig: MemoryCommandContext['updateConfig'];
  uiController: MemoryCommandContext['uiController'];
}

interface ConfigMainAdapterDeps {
  approvalMode: ConfigCommandContext['approvalMode'];
  userConfig: ConfigCommandContext['userConfig'];
  promptSelect: ConfigCommandContext['promptSelect'];
  logInfo: ConfigCommandContext['logInfo'];
  cleanup: ConfigCommandContext['cleanup'];
  applyGlobalApprovalMode: (mode: ConfigCommandContext['approvalMode']) => void;
  syncSdkApprovalMode: ConfigCommandContext['setApprovalMode'];
  updateConfig: ConfigCommandContext['updateConfig'];
}

export function buildConfigCommandContext(deps: ConfigContextDeps): ConfigCommandContext {
  return {
    approvalMode: deps.approvalMode,
    userConfig: deps.userConfig,
    promptSelect: deps.promptSelect,
    logInfo: deps.logInfo,
    cleanup: deps.cleanup,
    getScopedApprovalMode: deps.getScopedApprovalMode,
    setApprovalMode: deps.setApprovalMode,
    updateConfig: deps.updateConfig,
  };
}

export function buildConfigCommandContextFromMain(
  deps: ConfigMainAdapterDeps,
): ConfigCommandContext {
  return buildConfigCommandContext({
    approvalMode: deps.approvalMode,
    userConfig: deps.userConfig,
    promptSelect: deps.promptSelect,
    logInfo: deps.logInfo,
    cleanup: deps.cleanup,
    getScopedApprovalMode: (scopeKey) => {
      const map = deps.userConfig.agentApprovalScopes || {};
      return map[scopeKey.trim().toLowerCase()];
    },
    setApprovalMode: async (mode, options) => {
      if (!options || options.scope === 'global') {
        deps.applyGlobalApprovalMode(mode);
      }
      /* 必须 await — daemon sync 失败时 caller (config.ts /approve 流) 才能 catch
       * 并显错误给用户. 不能 fire-and-forget, 否则 "已切换 dangerous" 是谎言. */
      await deps.syncSdkApprovalMode(mode, options);
    },
    updateConfig: deps.updateConfig,
  });
}

export function buildIndexCommandContext(deps: IndexContextDeps): IndexCommandContext {
  return {
    userConfig: deps.userConfig,
    workspacePath: deps.workspacePath,
    promptSelect: deps.promptSelect,
    logInfo: deps.logInfo,
    updateConfig: deps.updateConfig,
  };
}

export function buildIndexCommandContextFromMain(
  deps: IndexMainAdapterDeps,
): IndexCommandContext {
  return buildIndexCommandContext({
    userConfig: deps.userConfig,
    workspacePath: deps.workspacePath,
    promptSelect: deps.promptSelect,
    logInfo: deps.logInfo,
    updateConfig: deps.updateConfig,
  });
}

export function buildContextCommandContext(deps: ContextContextDeps): ContextCommandContext {
  return {
    userConfig: deps.userConfig,
    promptSelect: deps.promptSelect,
    logInfo: deps.logInfo,
    updateConfig: deps.updateConfig,
    runner: deps.runner,
    uiController: deps.uiController,
    memoryPressure: deps.memoryPressure,
    updateCompactionThreshold: deps.updateCompactionThreshold,
    updateCompressionMode: deps.updateCompressionMode,
  };
}

export function buildContextCommandContextFromMain(
  deps: ContextMainAdapterDeps,
): ContextCommandContext {
  return buildContextCommandContext({
    userConfig: deps.userConfig,
    promptSelect: deps.promptSelect,
    logInfo: deps.logInfo,
    updateConfig: deps.updateConfig,
    runner: null,
    uiController: deps.uiController,
    memoryPressure: deps.memoryPressure,
    updateCompactionThreshold: deps.updateCompactionThreshold,
    updateCompressionMode: (mode) => {
      deps.syncCompressionMode?.(mode);
    },
  });
}

export function buildMemoryCommandContext(deps: MemoryContextDeps): MemoryCommandContext {
  return {
    actionLog: deps.actionLog,
    userConfig: deps.userConfig,
    promptSelect: deps.promptSelect,
    promptText: deps.promptText,
    logInfo: deps.logInfo,
    updateConfig: deps.updateConfig,
    uiController: deps.uiController,
  };
}

export function buildMemoryCommandContextFromMain(
  deps: MemoryMainAdapterDeps,
): MemoryCommandContext {
  return buildMemoryCommandContext({
    actionLog: deps.actionLog,
    userConfig: deps.userConfig,
    promptSelect: deps.promptSelect,
    promptText: deps.promptText,
    logInfo: deps.logInfo,
    updateConfig: deps.updateConfig,
    uiController: deps.uiController,
  });
}

export function buildRemoteCommandContext(deps: RemoteContextDeps): RemoteCommandContext {
  return {
    userConfig: deps.userConfig,
    promptSelect: deps.promptSelect,
    promptText: deps.promptText,
    logInfo: deps.logInfo,
    updateConfig: deps.updateConfig,
    startRemote: deps.startRemote,
    stopRemote: deps.stopRemote,
    regenerateToken: deps.regenerateToken,
    getStatus: deps.getStatus,
    outputLines: deps.outputLines,
    clearOutputLines: deps.clearOutputLines,
  };
}

export function buildRemoteCommandContextFromMain(
  deps: RemoteMainAdapterDeps,
): RemoteCommandContext {
  const outputCallbacks = createCommandOutputLinesCallbacks(deps.uiController);
  return buildRemoteCommandContext({
    userConfig: deps.userConfig,
    promptSelect: deps.promptSelect,
    promptText: deps.promptText,
    logInfo: deps.logInfo,
    updateConfig: deps.updateConfig,
    startRemote: deps.startRemote,
    stopRemote: deps.stopRemote,
    regenerateToken: deps.regenerateToken,
    getStatus: deps.getStatus,
    outputLines: outputCallbacks.outputLines,
    clearOutputLines: outputCallbacks.clearOutputLines,
  });
}
