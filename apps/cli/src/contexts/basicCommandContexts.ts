import type {
  ThinkingCommandContext,
  NotifyCommandContext,
  SupervisorCommandContext,
} from '../commands/index.js';

interface ThinkingContextDeps {
  model: string;
  providerSettings: ThinkingCommandContext['providerSettings'];
  thinkingMode: ThinkingCommandContext['thinkingMode'];
  llmProvider: ThinkingCommandContext['llmProvider'];
  setThinkingMode: (mode: ThinkingCommandContext['thinkingMode']) => void;
  promptSelect: ThinkingCommandContext['promptSelect'];
  logInfo: ThinkingCommandContext['logInfo'];
}

interface NotifyContextDeps {
  userConfig: NotifyCommandContext['userConfig'];
  promptSelect: NotifyCommandContext['promptSelect'];
  logInfo: NotifyCommandContext['logInfo'];
  updateConfig: NotifyCommandContext['updateConfig'];
}

interface SupervisorContextDeps {
  userConfig: SupervisorCommandContext['userConfig'];
  logInfo: SupervisorCommandContext['logInfo'];
  updateConfig: SupervisorCommandContext['updateConfig'];
}

interface NotifyMainAdapterDeps {
  userConfig: NotifyCommandContext['userConfig'];
  promptSelect: NotifyCommandContext['promptSelect'];
  logInfo: NotifyCommandContext['logInfo'];
  updateConfig: NotifyCommandContext['updateConfig'];
}

interface SupervisorMainAdapterDeps {
  userConfig: SupervisorCommandContext['userConfig'];
  logInfo: SupervisorCommandContext['logInfo'];
  updateConfig: SupervisorCommandContext['updateConfig'];
}

interface ThinkingMainAdapterDeps {
  model: string;
  providerSettings: ThinkingCommandContext['providerSettings'];
  thinkingMode: ThinkingCommandContext['thinkingMode'];
  llmProvider: ThinkingCommandContext['llmProvider'];
  setThinkingMode: (mode: ThinkingCommandContext['thinkingMode']) => void;
  promptSelect: ThinkingCommandContext['promptSelect'];
  logInfo: ThinkingCommandContext['logInfo'];
}

export function buildThinkingCommandContext(deps: ThinkingContextDeps): ThinkingCommandContext {
  return {
    model: deps.model,
    providerSettings: deps.providerSettings,
    thinkingMode: deps.thinkingMode,
    llmProvider: deps.llmProvider,
    setThinkingMode: deps.setThinkingMode,
    promptSelect: deps.promptSelect,
    logInfo: deps.logInfo,
  };
}

export function buildThinkingCommandContextFromMain(
  deps: ThinkingMainAdapterDeps,
): ThinkingCommandContext {
  return buildThinkingCommandContext({
    model: deps.model,
    providerSettings: deps.providerSettings,
    thinkingMode: deps.thinkingMode,
    llmProvider: deps.llmProvider,
    setThinkingMode: deps.setThinkingMode,
    promptSelect: deps.promptSelect,
    logInfo: deps.logInfo,
  });
}

export function buildNotifyCommandContext(deps: NotifyContextDeps): NotifyCommandContext {
  return {
    userConfig: deps.userConfig,
    promptSelect: deps.promptSelect,
    logInfo: deps.logInfo,
    updateConfig: deps.updateConfig,
  };
}

export function buildNotifyCommandContextFromMain(
  deps: NotifyMainAdapterDeps,
): NotifyCommandContext {
  return buildNotifyCommandContext({
    userConfig: deps.userConfig,
    promptSelect: deps.promptSelect,
    logInfo: deps.logInfo,
    updateConfig: deps.updateConfig,
  });
}

export function buildSupervisorCommandContext(deps: SupervisorContextDeps): SupervisorCommandContext {
  return {
    userConfig: deps.userConfig,
    logInfo: deps.logInfo,
    updateConfig: deps.updateConfig,
  };
}

export function buildSupervisorCommandContextFromMain(
  deps: SupervisorMainAdapterDeps,
): SupervisorCommandContext {
  return buildSupervisorCommandContext({
    userConfig: deps.userConfig,
    logInfo: deps.logInfo,
    updateConfig: deps.updateConfig,
  });
}
