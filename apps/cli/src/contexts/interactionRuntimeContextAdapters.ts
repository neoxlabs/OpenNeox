import { buildSupervisorCommandContextFromMain } from './basicCommandContexts.js';
import { buildRunConfigCommandContextFromMain } from './runtimeCommandContexts.js';
import { buildRemoteCommandContextFromMain } from './stateCommandContexts.js';
import { buildInitCommandContextFromMain, buildSetupCommandContextFromMain } from './interactionCommandContexts.js';
import type { InitCommandContext, SetupCommandContext, RemoteCommandContext, RunConfigCommandContext } from '../commands/index.js';
import type { ActionLogService } from '@neoxlabs/core/platform/actionLog/index.js';
import type { ProviderConfigEntry } from '@neoxlabs/platform/utils/config.js';
import type { NeoxConfig } from '@neoxlabs/platform/utils/config.js';
import type { InkUIAdapter } from '../ink/InkUIAdapter.js';
import type { RuntimeAdapter } from '@neoxlabs/core/sdk/runtimeAdapter.js';
import type { ProviderStore } from '@neoxlabs/platform/utils/providerStore.js';

export function buildInitCommandContextFromMainState(params: {
  workDir: string;
  actionLog: ActionLogService;
  promptSelect: InitCommandContext['promptSelect'];
  logInfo: (message: string, details?: string) => void;
  setStatusText: (text: string) => void;
  providerSettings: ProviderConfigEntry;
  model: string;
}) {
  return buildInitCommandContextFromMain({
    workDir: params.workDir,
    actionLog: params.actionLog,
    promptSelect: params.promptSelect,
    logInfo: params.logInfo,
    setStatusText: params.setStatusText,
    providerSettings: params.providerSettings,
    model: params.model,
  });
}

export function buildSetupCommandContextFromMainState(params: {
  logInfo: (message: string, details?: string) => void;
  promptSelect: SetupCommandContext['promptSelect'];
  promptText: SetupCommandContext['promptText'];
  handleCommand: (cmd: string) => Promise<void>;
  current?: SetupCommandContext['current'];
}) {
  return buildSetupCommandContextFromMain({
    logInfo: params.logInfo,
    promptSelect: params.promptSelect,
    promptText: params.promptText,
    handleCommand: params.handleCommand,
    current: params.current,
  });
}

export function buildRemoteCommandContextFromMainState(params: {
  userConfig: NeoxConfig;
  promptSelect: RemoteCommandContext['promptSelect'];
  promptText: RemoteCommandContext['promptText'];
  logInfo: (message: string, details?: string) => void;
  updateConfig: RemoteCommandContext['updateConfig'];
  startRemote: () => Promise<void>;
  stopRemote: () => Promise<void>;
  regenerateToken: () => string;
  getStatus: RemoteCommandContext['getStatus'];
  uiController: InkUIAdapter | null;
}) {
  return buildRemoteCommandContextFromMain({
    userConfig: params.userConfig,
    promptSelect: params.promptSelect,
    promptText: params.promptText,
    logInfo: params.logInfo,
    updateConfig: params.updateConfig,
    startRemote: params.startRemote,
    stopRemote: params.stopRemote,
    regenerateToken: params.regenerateToken,
    getStatus: params.getStatus,
    uiController: params.uiController,
  });
}

export function buildSupervisorCommandContextFromMainState(params: {
  userConfig: any;
  logInfo: (message: string, details?: string) => void;
  updateConfig: (config: any) => void;
}) {
  return buildSupervisorCommandContextFromMain({
    userConfig: params.userConfig,
    logInfo: params.logInfo,
    updateConfig: params.updateConfig,
  });
}

export function buildRunConfigCommandContextFromMainState(params: {
  userConfig: NeoxConfig;
  promptSelect: RunConfigCommandContext['promptSelect'];
  promptText: RunConfigCommandContext['promptText'];
  providerStore: ProviderStore;
  activeProviderId: string;
  model: string;
  remoteAdapter: RuntimeAdapter | null;
  logInfo: (message: string, details?: string) => void;
  updateConfig: RunConfigCommandContext['updateConfig'];
  workDir: string;
  readFile: (path: string) => Promise<string | null>;
  listDir: (path: string) => Promise<string[]>;
}) {
  return buildRunConfigCommandContextFromMain({
    userConfig: params.userConfig,
    promptSelect: params.promptSelect,
    promptText: params.promptText,
    providerStore: params.providerStore,
    activeProviderId: params.activeProviderId,
    model: params.model,
    remoteAdapter: params.remoteAdapter,
    logInfo: params.logInfo,
    updateConfig: params.updateConfig,
    workDir: params.workDir,
    readFile: params.readFile,
    listDir: params.listDir,
  });
}
