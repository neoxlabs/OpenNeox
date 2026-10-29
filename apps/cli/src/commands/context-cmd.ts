/**
 * Context Command Handlers
 * 上下文管理相关 CLI 命令
 */

import { colors } from '../constants.js';
import { saveConfig, type NeoxConfig, type ContextManagementConfig } from '@neoxlabs/platform/utils/config.js';
import type { SelectionChoice } from '../cliTypes.js';
import { cliPrintln } from '../utils/output.js';
import type { StreamedRunner } from '@neoxlabs/kernel/core/runner.js';
import type { InkUIAdapter } from '../ink/InkUIAdapter.js';
import type { MemoryPressureMonitor } from '@neoxlabs/kernel/compat/memoryPressure.js';
import { L } from '../i18n/index.js';

const menuHint = () => L('↑↓ 选择, Enter 确认, ESC 取消', '↑↓ select · Enter confirm · Esc cancel');
const backLabel = () => L('← 返回', '← Back');

/**
 * 压缩模式类型
 */
export type CompressionMode = 'sync' | 'async';

/**
 * Context command context
 */
export interface ContextCommandContext {
  userConfig: NeoxConfig;
  promptSelect: (
    question: string,
    choices: SelectionChoice[],
    defaultValue?: string,
    hint?: string
  ) => Promise<string>;
  logInfo: (message: string, details?: string) => void;
  updateConfig: (config: NeoxConfig) => void;
  runner: StreamedRunner | null;
  uiController?: InkUIAdapter | null;
  memoryPressure?: MemoryPressureMonitor;
  updateCompactionThreshold?: (thresholdPercent: number) => void;
  updateCompressionMode?: (mode: 'sync' | 'async') => void;
}

/**
 * 获取 Context 配置
 */
function getContextConfig(config: NeoxConfig): Required<ContextManagementConfig> {
  return {
    compressionMode: config.context?.compressionMode ?? 'sync',
    thresholdPercent: config.context?.thresholdPercent ?? 85,
    profile: config.context?.profile ?? 'full',
  };
}

/**
 * Handle /context command - 上下文管理
 */
export async function handleContextCommand(
  ctx: ContextCommandContext,
  actionArg?: string
): Promise<void> {
  const contextConfig = getContextConfig(ctx.userConfig);

  if (!actionArg) {
    try {
      const action = await ctx.promptSelect(
        L('上下文管理', 'Context'),
        [
          { label: L('查看当前用量', 'Current usage'), value: 'show' },
          { label: `${L('压缩阈值', 'Compact at')} — ${contextConfig.thresholdPercent}%`, value: 'threshold' },
          { label: `${L('压缩方式', 'Compaction')} — ${contextConfig.compressionMode === 'sync' ? L('同步', 'sync') : L('异步', 'async')}`, value: 'mode' },
        ],
        'show',
        menuHint()
      );

      actionArg = action;
    } catch (error: any) {
      if (error?.message !== 'cancelled') {
        ctx.logInfo(L('操作取消', 'Cancelled'), error?.message);
      }
      return;
    }
  }

  switch (actionArg) {
    case 'show':
      await showContextDetail(ctx, contextConfig);
      break;
    case 'threshold':
      await setCompressionThreshold(ctx, contextConfig);
      break;
    case 'mode':
      await switchCompressionMode(ctx, contextConfig);
      break;
    default:
      ctx.logInfo(L('无效的操作', 'Unknown action'), L('使用 /context 查看可用操作', 'Run /context to see what’s available'));
  }
}

/**
 * 显示上下文详细状态（等同于按 'c' 键的效果）
 */
async function showContextDetail(
  ctx: ContextCommandContext,
  config: Required<ContextManagementConfig>
): Promise<void> {
  if (ctx.uiController && 'showContextMenu' in ctx.uiController) {
    /* 打开面板就结束 (Esc 关)。以前紧接着 await handleContextCommand() 想"关了再回主菜单",
     * 但 showContextMenu 不等关闭就返回 —— 主菜单立刻重开, 跟面板抢同一块区域, 结果面板一闪就没。 */
    await ctx.uiController.showContextMenu();
    return;
  }

  // Format numbers
  const formatK = (n: number): string => {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return n.toString();
  };

  // Build detail message
  const lines: string[] = [];
  lines.push('╭───────────────────────────────────────────────────────╮');
  lines.push('│ Context Window Details                                │');
  lines.push('╰───────────────────────────────────────────────────────╯');
  lines.push('');

  let hasData = false;
  if (ctx.memoryPressure) {
    const snapshot = ctx.memoryPressure.getSnapshot();
    if (snapshot && snapshot.profile && snapshot.pressure !== undefined) {
      hasData = true;
      const { profile, tokensUsed, pressure } = snapshot;
      const percentage = Math.round(pressure * 100);
      const contextWindow = profile.contextWindow || 0;
      const remaining = contextWindow - tokensUsed;
      const compactionLimit = Math.floor(contextWindow * (config.thresholdPercent / 100));
      const tokensUntilCompaction = Math.max(0, compactionLimit - tokensUsed);

      // Total usage
      lines.push(`Total: ${formatK(tokensUsed)} / ${formatK(contextWindow)} tokens (${percentage}%)`);
      lines.push(`Remaining: ${formatK(remaining)} tokens`);
      lines.push('');

      // Compression mode
      const modeText = config.compressionMode === 'sync' ? 'Sync LLM' : 'Async LLM';
      lines.push(`Compression: ${modeText} (${config.thresholdPercent}% threshold)`);
      lines.push('');

      // Compaction warning
      if (tokensUntilCompaction > 0) {
        lines.push(`Compaction in: ${formatK(tokensUntilCompaction)} tokens`);
      } else {
        lines.push('⚠ Compaction threshold reached!');
      }
      lines.push('');

      //   对商业产品是误导. 真实分段统计 (calculateTokenBreakdown) 需要 memory
      //   消息历史, 而本 CLI fallback 路径拿不到 (memory 是 runner 私有, snapshot
      //   只带 totals). 宁可只显示真实总量, 不编造精确分段.
      lines.push('Prompt / Completion:');
      lines.push(`  ■ Prompt:     ${formatK(snapshot.promptTokens)} tokens`);
      lines.push(`  ■ Completion: ${formatK(snapshot.completionTokens)} tokens`);
      lines.push('');
    }
  }

  // Show compression settings even when no usage data available
  if (!hasData) {
    lines.push('Total: 0 / -- tokens (0%)');
    lines.push('Remaining: -- tokens');
    lines.push('');

    // Compression mode (always show)
    const modeText = config.compressionMode === 'sync' ? 'Sync LLM' : 'Async LLM';
    lines.push(`Compression: ${modeText} (${config.thresholdPercent}% threshold)`);
    lines.push('');

    lines.push('Send a message to see context usage details');
    lines.push('');
  }

  // Use UI's addInfo to display the message
  const detailText = lines.join('\n');
  ctx.logInfo('Context Details', detailText);

  try {
    const action = await ctx.promptSelect(
      '',
      [
        { label: backLabel(), value: 'back' },
      ],
      'back',
      L('按 Enter 返回', 'Enter to go back')
    );

    if (action === 'back') {
      // Return to main menu
      await handleContextCommand(ctx);
    }
  } catch (error: any) {
    // User cancelled - that's fine
  }
}

/**
 * 切换压缩模式
 */
async function switchCompressionMode(
  ctx: ContextCommandContext,
  config: Required<ContextManagementConfig>
): Promise<void> {
  try {
    const newMode = await ctx.promptSelect(
      L('选择压缩模式', 'Compaction mode'),
      [
        { label: L('同步 (推荐) — 压缩时暂停', 'Sync (recommended) — pauses while compacting'), value: 'sync' },
        { label: L('异步 — 后台压缩', 'Async — compacts in the background'), value: 'async' },
        { label: backLabel(), value: 'back' },
      ],
      config.compressionMode,
      menuHint()
    );

    if (newMode === 'back') {
      // Return to main menu
      await handleContextCommand(ctx);
      return;
    }



    if (newMode === config.compressionMode) {
      ctx.logInfo(L('压缩模式未改变', 'Compaction mode unchanged'));
    } else {
      // 更新配置
      const updatedUserConfig: NeoxConfig = {
        ...ctx.userConfig,
        context: {
          ...config,
          compressionMode: newMode as CompressionMode,
        },
      };
      ctx.updateConfig(updatedUserConfig);
      saveConfig(updatedUserConfig);

      // 更新 runner
      if (ctx.runner) {
        ctx.runner.setCompressionMode(newMode as CompressionMode);
      }

      if (ctx.uiController && 'setCompressionMode' in ctx.uiController) {
        ctx.uiController.setCompressionMode(newMode as CompressionMode);
      }

      if (ctx.updateCompressionMode) {
        ctx.updateCompressionMode(newMode as CompressionMode);
      }

      ctx.logInfo(newMode === 'sync' ? L('✓ 压缩模式已切换为: 同步', '✓ Compaction is now sync') : L('✓ 压缩模式已切换为: 异步', '✓ Compaction is now async'));
    }

    await handleContextCommand(ctx);
  } catch (error: any) {
    if (error?.message !== 'cancelled') {
      ctx.logInfo(L('切换失败', 'Switch failed'), error?.message);
    }
    // Cancelled - don't return to menu
  }
}

/**
 * 设置压缩阈值
 */
async function setCompressionThreshold(
  ctx: ContextCommandContext,
  config: Required<ContextManagementConfig>
): Promise<void> {
  try {
    const threshold = await ctx.promptSelect(
      L('选择触发压缩的阈值', 'Compact when context reaches'),
      [
        { label: `20% — ${L('测试用', 'testing')}`, value: '20' },
        { label: `70% — ${L('积极压缩', 'aggressive')}`, value: '70' },
        { label: `80% — ${L('平衡', 'balanced')}`, value: '80' },
        { label: `85% — ${L('推荐', 'recommended')}`, value: '85' },
        { label: `90% — ${L('保留更多上下文', 'keep more context')}`, value: '90' },
        { label: backLabel(), value: 'back' },
      ],
      String(config.thresholdPercent),
      menuHint()
    );

    if (threshold === 'back') {
      // Return to main menu
      await handleContextCommand(ctx);
      return;
    }



    const newThreshold = parseInt(threshold, 10);
    if (newThreshold === config.thresholdPercent) {
      ctx.logInfo(L('阈值未改变', 'Threshold unchanged'));
    } else {
      // 更新配置
      const updatedUserConfig: NeoxConfig = {
        ...ctx.userConfig,
        context: {
          ...config,
          thresholdPercent: newThreshold,
        },
      };
      ctx.updateConfig(updatedUserConfig);
      saveConfig(updatedUserConfig);

      if (ctx.uiController && 'setCompactionThreshold' in ctx.uiController) {
        ctx.uiController.setCompactionThreshold(newThreshold);
      }

      if (ctx.updateCompactionThreshold) {
        ctx.updateCompactionThreshold(newThreshold);
      }

      ctx.logInfo(L(`✓ 压缩阈值已设置为: ${newThreshold}%`, `✓ Compaction threshold set to ${newThreshold}%`));
    }

    await handleContextCommand(ctx);
  } catch (error: any) {
    if (error?.message !== 'cancelled') {
      ctx.logInfo(L('设置失败', 'Couldn’t save'), error?.message);
    }
    // Cancelled - don't return to menu
  }
}
