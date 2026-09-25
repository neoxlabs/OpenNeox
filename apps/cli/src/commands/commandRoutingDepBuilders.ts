import { colors } from '../constants.js';
import type { SelectionChoice } from '../cliTypes.js';
import type { ProviderConfigEntry } from '@neoxlabs/platform/utils/config.js';
import { runHelpMenuFlow } from '../ui/helpMenu.js';
import { handleSchemaExampleCommand as schemaExampleHandler } from '../utils/index.js';
import { isSandboxEnabled, setSandboxEnabled } from '@neoxlabs/core/tools/runtimeTools.js';
import { handleModeCommand, handleRunModeCommand } from './modeRunSandboxCommands.js';
import { handleProviderRouting, handleModelRouting } from './providerModelRouting.js';
import type { KernelCommandContext } from './kernel-cmd.js';
import {
  handleRunConfigCommand,
  handleApprovalCommand,
  handleNotifyCommand,
  handleMcpCommand,
  handleRemoteCommand,
  handleSupervisorCommand,
  type CommandContext,
  type ConfigCommandContext,
  type ContextCommandContext,
  type IndexCommandContext,
  type InitCommandContext,
  type MemoryCommandContext,
  type SetupCommandContext,
  type StatisticCommandContext,
  type NotifyCommandContext,
  type McpCommandContext,
  type RemoteCommandContext,
  type SupervisorCommandContext,
  type RunConfigCommandContext,
} from './index.js';
import type { ProviderCommandContextWithOutput } from '../contexts/coreCommandContexts.js';
import type { AgentRunMode } from '@neoxlabs/core/runtime/modeFactory.js';
import type { InkUIAdapter } from '../ink/InkUIAdapter.js';

type PromptSelect = (
  question: string,
  choices: SelectionChoice[],
  defaultValue?: string,
) => Promise<string>;

interface BasicCommandRoutingDeps {
  handleExit: () => void;
  handleHelp: () => Promise<void>;
  handleSchemaExample: (schemaName?: string) => Promise<void>;
}

interface BuildBasicCommandRoutingDepsOptions {
  workDir: string;
  uiController: InkUIAdapter | null;
  getLastSelection: () => string;
  setLastSelection: (value: string) => void;
  executeCommand: (command: string) => Promise<void>;
  logInfo: (message: string, details?: string) => void;
  exitWithCleanup: (options: { skipProcessCheck: boolean; exitCode: number; reason: string }) => void;
}

export function buildBasicCommandRoutingDeps(
  options: BuildBasicCommandRoutingDepsOptions,
): BasicCommandRoutingDeps {
  return {
    handleExit: () => {
      console.log(colors.info('\n👋 Goodbye!'));
      options.exitWithCleanup({ skipProcessCheck: false, exitCode: 0, reason: 'command' });
    },
    handleHelp: async () => {
      await runHelpMenuFlow({
        uiController: options.uiController,
        getLastSelection: options.getLastSelection,
        setLastSelection: options.setLastSelection,
        executeCommand: options.executeCommand,
        logInfo: options.logInfo,
      });
    },
    handleSchemaExample: async (schemaName?: string) => {
      await schemaExampleHandler(options.workDir, schemaName);
    },
  };
}

interface ModeAndModelCommandRoutingDeps {
  handleMode: (actionArg?: string) => Promise<void>;
  handleRun: (actionArg?: string) => Promise<void>;
  handleRunConfig: (subCommand?: string) => Promise<void>;
  handleProvider: (args: string[]) => Promise<void>;
  handleModel: (args: string[]) => Promise<void>;
  handleModelProfile: (args: string[]) => Promise<void>;
  promptSelect: PromptSelect;
  logInfo: (message: string, details?: string) => void;
  getActiveProvider?: () => ProviderConfigEntry | undefined;
  getActiveModel?: () => string | undefined;
  onProviderChanged?: () => void;
}

interface BuildModeAndModelCommandRoutingDepsOptions {
  getInteractionMode: () => 'agent' | 'ask';
  setInteractionMode: (mode: 'agent' | 'ask') => void;
  getCurrentRunMode: () => AgentRunMode;
  setRunMode: (mode: AgentRunMode) => void;
  promptSelect: PromptSelect;
  logInfo: (message: string, details?: string) => void;
  getRunConfigCommandContext: () => RunConfigCommandContext;
  getProviderCommandContext: () => ProviderCommandContextWithOutput;
  handleModelProfileCommand: (args: string[]) => Promise<void>;
  getActiveProvider?: () => ProviderConfigEntry | undefined;
  getActiveModel?: () => string | undefined;
  onProviderChanged?: () => void;
}

export function buildModeAndModelCommandRoutingDeps(
  options: BuildModeAndModelCommandRoutingDepsOptions,
): ModeAndModelCommandRoutingDeps {
  return {
    handleMode: async (actionArg?: string) => {
      await handleModeCommand(actionArg, {
        getInteractionMode: options.getInteractionMode,
        setInteractionMode: options.setInteractionMode,
        promptSelect: options.promptSelect,
        logInfo: options.logInfo,
      });
    },
    handleRun: async (actionArg?: string) => {
      await handleRunModeCommand(actionArg, {
        getCurrentRunMode: options.getCurrentRunMode,
        setRunMode: options.setRunMode,
        promptSelect: options.promptSelect,
        logInfo: options.logInfo,
      });
    },
    handleRunConfig: async (subCommand?: string) => {
      await handleRunConfigCommand(options.getRunConfigCommandContext(), subCommand);
    },
    handleProvider: async (args: string[]) => {
      await handleProviderRouting(args, options.getProviderCommandContext());
    },
    handleModel: async (args: string[]) => {
      await handleModelRouting(args, options.getProviderCommandContext());
    },
    handleModelProfile: async (args: string[]) => {
      await options.handleModelProfileCommand(args);
    },
    promptSelect: options.promptSelect,
    logInfo: options.logInfo,
    getActiveProvider: options.getActiveProvider,
    getActiveModel: options.getActiveModel,
    onProviderChanged: options.onProviderChanged,
  };
}

interface AttachmentCommandRoutingDeps {
  logInfo: (message: string, details?: string) => void;
  addPendingAttachment: (value: string) => Promise<void>;
  listPendingAttachments: () => void;
  clearPendingAttachments: () => void;
  removePendingAttachment: (index: number) => void;
}

export function buildAttachmentCommandRoutingDeps(
  options: AttachmentCommandRoutingDeps,
): AttachmentCommandRoutingDeps {
  return {
    logInfo: options.logInfo,
    addPendingAttachment: options.addPendingAttachment,
    listPendingAttachments: options.listPendingAttachments,
    clearPendingAttachments: options.clearPendingAttachments,
    removePendingAttachment: options.removePendingAttachment,
  };
}

interface UiUtilityCommandRoutingDeps {
  showSkillsScreen: () => Promise<void>;
  showLanguageMenu: () => Promise<void>;
  getCommandContext: () => CommandContext;
}

export function buildUiUtilityCommandRoutingDeps(
  options: UiUtilityCommandRoutingDeps,
): UiUtilityCommandRoutingDeps {
  return {
    showSkillsScreen: options.showSkillsScreen,
    showLanguageMenu: options.showLanguageMenu,
    getCommandContext: options.getCommandContext,
  };
}

interface ServiceCommandRoutingDeps {
  handleApproval: (args: string[]) => Promise<void>;
  handleWebSearch: (args: string[]) => Promise<void>;
  handleNotify: (actionArg?: string) => Promise<void>;
  handleMcp: (actionArg?: string) => Promise<void>;
  handleRemote: (actionArg?: string) => Promise<void>;
  handleSupervisor: (actionArg?: string) => Promise<void>;
}

interface BuildServiceCommandRoutingDepsOptions {
  getConfigCommandContext: () => ConfigCommandContext;
  getNotifyCommandContext: () => NotifyCommandContext;
  getMcpCommandContext: () => McpCommandContext;
  getRemoteCommandContext: () => RemoteCommandContext;
  getSupervisorCommandContext: () => SupervisorCommandContext;
  handleWebSearchCommand: (args: string[]) => Promise<void>;
}

export function buildServiceCommandRoutingDeps(
  options: BuildServiceCommandRoutingDepsOptions,
): ServiceCommandRoutingDeps {
  return {
    handleApproval: async (args: string[]) => {
      await handleApprovalCommand(options.getConfigCommandContext(), args);
    },
    handleWebSearch: async (args: string[]) => {
      await options.handleWebSearchCommand(args);
    },
    handleNotify: async (actionArg?: string) => {
      await handleNotifyCommand(options.getNotifyCommandContext(), actionArg);
    },
    handleMcp: async (actionArg?: string) => {
      await handleMcpCommand(options.getMcpCommandContext(), actionArg);
    },
    handleRemote: async (actionArg?: string) => {
      await handleRemoteCommand(options.getRemoteCommandContext(), actionArg);
    },
    handleSupervisor: async (actionArg?: string) => {
      await handleSupervisorCommand(options.getSupervisorCommandContext(), actionArg);
    },
  };
}

interface MiscCommandRoutingDeps {
  clearConversationHistory: () => void;
  getConfigCommandContext: () => ConfigCommandContext;
  getIndexCommandContext: () => IndexCommandContext;
  getContextCommandContext: () => ContextCommandContext;
  getMemoryCommandContext: () => MemoryCommandContext;
  getInitCommandContext: () => InitCommandContext;
  getSetupCommandContext: () => SetupCommandContext;
  handleWorkspaceCommand: (args: string[]) => Promise<void>;
  getStatisticCommandContext: () => StatisticCommandContext;
  handlePricingCommand: (actionArg?: string) => Promise<void>;
  showStats: () => Promise<void>;
  getKernelCommandContext: () => KernelCommandContext;
}

export function buildMiscCommandRoutingDeps(
  options: MiscCommandRoutingDeps,
): MiscCommandRoutingDeps {
  return {
    clearConversationHistory: options.clearConversationHistory,
    getConfigCommandContext: options.getConfigCommandContext,
    getIndexCommandContext: options.getIndexCommandContext,
    getContextCommandContext: options.getContextCommandContext,
    getMemoryCommandContext: options.getMemoryCommandContext,
    getInitCommandContext: options.getInitCommandContext,
    getSetupCommandContext: options.getSetupCommandContext,
    handleWorkspaceCommand: options.handleWorkspaceCommand,
    getStatisticCommandContext: options.getStatisticCommandContext,
    handlePricingCommand: options.handlePricingCommand,
    showStats: options.showStats,
    getKernelCommandContext: options.getKernelCommandContext,
  };
}

interface ModeFeatureCommandRoutingDeps {
  model: string;
  promptSelect: PromptSelect;
  logInfo: (message: string, details?: string) => void;
  isSandboxEnabled: () => boolean;
  setSandboxEnabled: (enabled: boolean) => void;
  syncSandboxMode: (enabled: boolean) => Promise<void>;
  syncTtsEnabled: (enabled: boolean) => void;
}

interface BuildModeFeatureCommandRoutingDepsOptions {
  model: string;
  promptSelect: PromptSelect;
  logInfo: (message: string, details?: string) => void;
  syncSandboxMode: (enabled: boolean) => Promise<void>;
  syncTtsEnabled: (enabled: boolean) => void;
}

export function buildModeFeatureCommandRoutingDeps(
  options: BuildModeFeatureCommandRoutingDepsOptions,
): ModeFeatureCommandRoutingDeps {
  return {
    model: options.model,
    promptSelect: options.promptSelect,
    logInfo: options.logInfo,
    isSandboxEnabled: () => isSandboxEnabled(),
    setSandboxEnabled: (enabled: boolean) => setSandboxEnabled(enabled),
    syncSandboxMode: options.syncSandboxMode,
    syncTtsEnabled: options.syncTtsEnabled,
  };
}
