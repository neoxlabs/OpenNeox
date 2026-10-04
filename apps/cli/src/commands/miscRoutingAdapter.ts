import { isSandboxEnabled } from '@neoxlabs/core/tools/runtimeTools.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import {
  buildPricingCommandContextFromMain,
  buildStatisticCommandContextFromMain,
} from '../contexts/runtimeCommandContexts.js';
import { buildMiscCommandRoutingDeps } from './commandRoutingDepBuilders.js';
import { handlePricingCommand } from './pricing-cmd.js';
import { handleStatsCommandFromMain } from './statsCommand.js';
import { colors } from '../constants.js';

export type MiscRoutingDepsFromMain = ReturnType<typeof buildMiscCommandRoutingDeps>;

export function buildMiscCommandRoutingDepsFromMain(params: {
  sdkClient: { clearMemory: (sessionId: string) => Promise<any>; getSessionInfo: (sessionId: string) => Promise<any> } | null;
  getSdkSessionId: () => string;
  uiController?: {
    clear?: () => void;
    clearCommandOutputLines?: () => void;
    /* /clear 的确认走这条 (Static 计数吞掉 logInfo, 见 clearConversationHistory 里的说明) */
    setCommandOutputLines?: (lines: string[]) => void;
  } | null;
  logInfo: (message: string, details?: string) => void;
  getConfigCommandContext: () => any;
  getIndexCommandContext: () => any;
  getContextCommandContext: () => any;
  getMemoryCommandContext: () => any;
  getInitCommandContext: () => any;
  getSetupCommandContext: () => any;
  handleWorkspaceCommand: (args: string[]) => Promise<void>;
  statistic: {
    promptSelect: (question: string, choices: any[], defaultValue?: string, hint?: string) => Promise<string>;
    userConfig: any;
    uiController: any;
  };
  pricing: {
    userConfig: any;
    promptSelect: (question: string, choices: any[], defaultValue?: string, hint?: string) => Promise<string>;
    acquirePromptLock: () => Promise<void>;
    releasePromptLock: () => void;
    uiController: any;
    updateConfig: (config: any) => void;
  };
  stats: {
    workDir: string;
    providerDisplayName: string;
    model: string;
    providerSettings?: any;
    memoryLength: number;
    toolsLength: number;
    sessionRequests: number;
    interactionMode: any;
    userConfig: any;
    thinkingMode?: string;
    sdkClient: { getSessionInfo: (sessionId: string) => Promise<any> } | null;
    uiController: any;
  };
  getKernelDiagnostics?: () => any | null;
}): MiscRoutingDepsFromMain {
  return buildMiscCommandRoutingDeps({
    clearConversationHistory: () => {
      params.sdkClient?.clearMemory(params.getSdkSessionId()).catch((error) => {
        cliLogger.warn('CLI_MISC', 'Failed to clear conversation history in SDK runtime', {
          message: error instanceof Error ? error.message : String(error),
        });
      });
      /* /clear 同步清 CLI Ink 侧状态 — audit 找出原版只清 daemon 不清前端,
       * 时间线 / commandOutput / streaming 状态留旧, 用户预期是"白板从头". */
      try {
        params.uiController?.clear?.();
        params.uiController?.clearCommandOutputLines?.();
      } catch (err: any) {
        cliLogger.debug('CLI_MISC', `clear UI failed: ${err?.message ?? err}`);
      }
      try {
        params.uiController?.setCommandOutputLines?.([
          '',
          '  ✓ 已清空对话上下文 (模型不再记得之前的对话)',
          '    终端上已有的内容不会消失 —— 要清屏用 Ctrl+L 或 clear',
          '',
        ]);
      } catch {
        params.logInfo('Conversation history cleared', '对话历史已清空');
      }
    },
    getConfigCommandContext: params.getConfigCommandContext,
    getIndexCommandContext: params.getIndexCommandContext,
    getContextCommandContext: params.getContextCommandContext,
    getMemoryCommandContext: params.getMemoryCommandContext,
    getInitCommandContext: params.getInitCommandContext,
    getSetupCommandContext: params.getSetupCommandContext,
    handleWorkspaceCommand: params.handleWorkspaceCommand,
    getStatisticCommandContext: () =>
      buildStatisticCommandContextFromMain({
        promptSelect: params.statistic.promptSelect,
        logInfo: params.logInfo,
        userConfig: params.statistic.userConfig,
        uiController: params.statistic.uiController,
      }),
    handlePricingCommand: async (actionArg?: string) => {
      const ctx = buildPricingCommandContextFromMain({
        userConfig: params.pricing.userConfig,
        promptSelect: params.pricing.promptSelect,
        acquirePromptLock: params.pricing.acquirePromptLock,
        releasePromptLock: params.pricing.releasePromptLock,
        uiController: params.pricing.uiController,
        logInfo: params.logInfo,
        updateConfig: params.pricing.updateConfig,
      });
      await handlePricingCommand(ctx, actionArg);
    },
    showStats: async () => {
      await handleStatsCommandFromMain({
        workDir: params.stats.workDir,
        providerDisplayName: params.stats.providerDisplayName,
        model: params.stats.model,
        providerSettings: params.stats.providerSettings,
        memoryLength: params.stats.memoryLength,
        toolsLength: params.stats.toolsLength,
        sessionRequests: params.stats.sessionRequests,
        interactionMode: params.stats.interactionMode,
        sandboxEnabled: isSandboxEnabled(),
        approvalMode: params.stats.userConfig.agentApprovalMode || params.stats.userConfig.approvalMode || 'auto',
        thinkingMode: params.stats.thinkingMode,
        sdkClient: params.stats.sdkClient,
        getSdkSessionId: params.getSdkSessionId,
        uiController: params.stats.uiController,
      });
    },
    getKernelCommandContext: () => ({
      getKernelDiagnostics: params.getKernelDiagnostics ?? (() => null),
      colors: {
        highlight: colors.highlight,
        info: colors.info,
        dim: colors.dim,
        success: colors.success,
        warning: colors.warning,
        error: colors.error,
      },
      logInfo: params.logInfo,
      outputLines: params.stats.uiController?.setCommandOutputLines
        ? (lines: string[]) => params.stats.uiController?.setCommandOutputLines(lines)
        : undefined,
    }),
  });
}
