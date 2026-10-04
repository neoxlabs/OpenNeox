import type { NeoxConfig } from '@neoxlabs/platform/utils/config.js';
import { buildContextCommandContextFromMain, buildIndexCommandContextFromMain, buildMemoryCommandContextFromMain } from './stateCommandContexts.js';
import type { IndexCommandContext, ContextCommandContext, MemoryCommandContext } from '../commands/index.js';
import type { ActionLogService } from '@neoxlabs/core/platform/actionLog/index.js';
import type { InkUIAdapter } from '../ink/InkUIAdapter.js';

export function buildIndexCommandContextFromMainState(params: {
  userConfig: NeoxConfig;
  workDir: string;
  promptSelect: IndexCommandContext['promptSelect'];
  logInfo: (message: string, details?: string) => void;
  updateConfig: (config: NeoxConfig) => void;
}) {
  return buildIndexCommandContextFromMain({
    userConfig: params.userConfig,
    workspacePath: params.workDir,
    promptSelect: params.promptSelect,
    logInfo: params.logInfo,
    updateConfig: params.updateConfig,
  });
}

export function buildContextCommandContextFromMainState(params: {
  userConfig: NeoxConfig;
  promptSelect: ContextCommandContext['promptSelect'];
  logInfo: (message: string, details?: string) => void;
  updateConfig: (config: NeoxConfig) => void;
  uiController: InkUIAdapter | null;
  memoryPressure: ContextCommandContext['memoryPressure'];
  updateCompactionThreshold: (thresholdPercent: number) => void;
  syncCompressionMode: (mode: 'sync' | 'async') => void;
}) {
  return buildContextCommandContextFromMain({
    userConfig: params.userConfig,
    promptSelect: params.promptSelect,
    logInfo: params.logInfo,
    updateConfig: params.updateConfig,
    uiController: params.uiController,
    memoryPressure: params.memoryPressure,
    updateCompactionThreshold: params.updateCompactionThreshold,
    syncCompressionMode: params.syncCompressionMode,
  });
}

export function buildMemoryCommandContextFromMainState(params: {
  actionLog: ActionLogService;
  userConfig: NeoxConfig;
  promptSelect: MemoryCommandContext['promptSelect'];
  promptText: MemoryCommandContext['promptText'];
  logInfo: (message: string, details?: string) => void;
  updateConfig: (config: NeoxConfig) => void;
  uiController: InkUIAdapter | null;
}) {
  return buildMemoryCommandContextFromMain({
    actionLog: params.actionLog,
    userConfig: params.userConfig,
    promptSelect: params.promptSelect,
    promptText: params.promptText,
    logInfo: params.logInfo,
    updateConfig: params.updateConfig,
    uiController: params.uiController,
  });
}
