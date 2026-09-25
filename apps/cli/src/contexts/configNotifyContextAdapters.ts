import { AgentMode } from '@neoxlabs/kernel/core/runner.js';
import type { NeoxConfig } from '@neoxlabs/platform/utils/config.js';
import { buildNotifyCommandContextFromMain } from './basicCommandContexts.js';
import { buildConfigCommandContextFromMain } from './stateCommandContexts.js';
import type { ConfigCommandContext, NotifyCommandContext } from '../commands/index.js';

export function buildConfigCommandContextFromMainState(params: {
  approvalMode: 'auto' | 'manual' | 'dangerous';
  userConfig: NeoxConfig;
  promptSelect: ConfigCommandContext['promptSelect'];
  logInfo: (message: string, details?: string) => void;
  cleanup: () => Promise<void>;
  setApprovalMode: (mode: 'auto' | 'manual' | 'dangerous') => void;
  setCurrentMode: (mode: AgentMode) => void;
  syncSdkApprovalMode: ConfigCommandContext['setApprovalMode'];
  updateConfig: (config: NeoxConfig) => void;
}) {
  return buildConfigCommandContextFromMain({
    approvalMode: params.approvalMode,
    userConfig: params.userConfig,
    promptSelect: params.promptSelect,
    logInfo: params.logInfo,
    cleanup: params.cleanup,
    applyGlobalApprovalMode: (mode) => {
      params.setApprovalMode(mode);
      if (mode === 'dangerous') {
        params.setCurrentMode(AgentMode.AUTO);
      } else {
        params.setCurrentMode(AgentMode.AGENT);
      }
    },
    syncSdkApprovalMode: (mode, options) => {
      params.syncSdkApprovalMode(mode, options);
    },
    updateConfig: params.updateConfig,
  });
}

export function buildNotifyCommandContextFromMainState(params: {
  userConfig: NeoxConfig;
  promptSelect: NotifyCommandContext['promptSelect'];
  logInfo: (message: string, details?: string) => void;
  updateConfig: (config: NeoxConfig) => void;
}) {
  return buildNotifyCommandContextFromMain({
    userConfig: params.userConfig,
    promptSelect: params.promptSelect,
    logInfo: params.logInfo,
    updateConfig: params.updateConfig,
  });
}
