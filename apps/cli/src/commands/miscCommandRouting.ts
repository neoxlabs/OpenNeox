import {
  handleConfigClearCommand,
  handleIndexCommand,
  handleContextCommand,
  handleMemoryCommand,
  handleInitCommand,
  handleSetupCommand,
  handleStatisticCommand,
  type ConfigCommandContext,
  type IndexCommandContext,
  type ContextCommandContext,
  type MemoryCommandContext,
  type InitCommandContext,
  type SetupCommandContext,
  type StatisticCommandContext,
} from './index.js';
import { handleKernelCommand, type KernelCommandContext } from './kernel-cmd.js';

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

export async function handleMiscCommandRouting(
  cmd: string,
  args: string[],
  deps: MiscCommandRoutingDeps,
): Promise<boolean> {
  switch (cmd) {
    case '/clear':
      deps.clearConversationHistory();
      return true;
    case '/config-clear':
      await handleConfigClearCommand(deps.getConfigCommandContext());
      return true;
    case '/index':
      await handleIndexCommand(deps.getIndexCommandContext(), args[0]);
      return true;
    case '/context':
      await handleContextCommand(deps.getContextCommandContext(), args[0]);
      return true;
    case '/memory':
      await handleMemoryCommand(deps.getMemoryCommandContext(), args[0]);
      return true;
    case '/init':
      await handleInitCommand(deps.getInitCommandContext(), args[0], args[1]);
      return true;
    case '/setup':
      await handleSetupCommand(deps.getSetupCommandContext(), args);
      return true;
    case '/workspace':
      await deps.handleWorkspaceCommand(args);
      return true;
    case '/statistic':
      await handleStatisticCommand(deps.getStatisticCommandContext(), args[0]);
      return true;
    case '/cost':
    case '/pricing':
      await deps.handlePricingCommand(args[0]);
      return true;
    case '/stats':
      await deps.showStats();
      return true;
    case '/kernel':
    case '/os':
      // Agent OS 内核诊断面板 — 仅开发调试用, 默认不对最终用户暴露
      if (!process.env.NEOX_DEBUG && !process.env.CLI_DEBUG) return false;
      await handleKernelCommand(deps.getKernelCommandContext(), args[0]);
      return true;
    default:
      return false;
  }
}
