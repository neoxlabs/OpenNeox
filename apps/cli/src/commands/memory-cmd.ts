/**
 * Memory Command Handlers
 * 记忆系统相关 CLI 命令
 */

import type { ActionLogService, MemoryStats } from '@neoxlabs/core/platform/actionLog/index.js';
import type { InkUIAdapter } from '../ink/InkUIAdapter.js';
import type { SelectionChoice } from '../cliTypes.js';
import { colors } from '../constants.js';
import { cliPrintln } from '../utils/output.js';
import { saveConfig, type NeoxConfig } from '@neoxlabs/platform/utils/config.js';
import type { MemoryCategory } from '@neoxlabs/platform/platform/memory/index.js';

export interface MemoryCommandContext {
  actionLog: ActionLogService;
  userConfig: NeoxConfig;
  promptSelect: (
    question: string,
    choices: SelectionChoice[],
    defaultValue?: string,
    hint?: string
  ) => Promise<string>;
  promptText: (
    question: string,
    options?: {
      defaultValue?: string;
      hint?: string;
      allowEmpty?: boolean;
    }
  ) => Promise<string>;
  logInfo: (message: string, details?: string) => void;
  updateConfig: (config: NeoxConfig) => void;
  uiController?: InkUIAdapter | null;
}

export async function handleMemoryCommand(
  ctx: MemoryCommandContext,
  actionArg?: string
): Promise<void> {
  let action = actionArg?.toLowerCase();

  if (!action) {
    try {
      action = await ctx.promptSelect(
        '记忆系统',
        [
          /* 标题「记忆系统」是中文而选项全英文 —— 同一菜单两种语言 */
          { label: '查看统计', value: 'show' },
          { label: '存储路径', value: 'paths' },
          { label: '自动记忆开关', value: 'config' },
          { label: '调试注入内容', value: 'debug' },
          { label: '清除记忆', value: 'clear' },
        ],
        'show',
        '↑↓ 选择, Enter 确认, ESC 取消'
      );
    } catch (error: any) {
      if (error?.message !== 'cancelled') {
        ctx.logInfo('操作取消', error?.message);
      }
      return;
    }
  }

  switch (action) {
    case 'show':
    case 'stats':
      await showMemoryStats(ctx);
      break;
    case 'paths':
      await showMemoryPaths(ctx);
      break;
    case 'config':
    case 'configure':
      await configureMemory(ctx);
      break;
    case 'debug':
      await showMemoryDebug(ctx);
      break;
    case 'clear':
      await clearMemory(ctx);
      break;
    default:
      ctx.logInfo('无效的操作', '使用 /memory 查看可用操作');
  }
}

async function configureMemory(ctx: MemoryCommandContext): Promise<void> {
  const enabled = ctx.userConfig.memory?.autoMemoryEnabled !== false;
  let value: string;
  try {
    value = await ctx.promptSelect(
      '自动记忆 (需开启 Jev: 每轮先判断有没有值得记的, 有才用当前模型记下)',
      [
        { label: '开启', value: 'on' },
        { label: '关闭', value: 'off' },
      ],
      enabled ? 'on' : 'off'
    );
  } catch (error: any) {
    if (error?.message !== 'cancelled') {
      ctx.logInfo('操作取消', error?.message);
    }
    return;
  }
  updateMemoryConfig(ctx, { autoMemoryEnabled: value === 'on' });
  ctx.logInfo('自动记忆已更新', value === 'on' ? '已开启' : '已关闭');
}

function updateMemoryConfig(
  ctx: MemoryCommandContext,
  updates: Partial<NonNullable<NeoxConfig['memory']>>
): void {
  const memory = { ...(ctx.userConfig.memory ?? {}), ...updates };

  const nextConfig: NeoxConfig = {
    ...ctx.userConfig,
    memory,
  };
  ctx.updateConfig(nextConfig);
  saveConfig(nextConfig);
}

async function showMemoryStats(ctx: MemoryCommandContext): Promise<void> {
  const stats = await ctx.actionLog.getMemoryStats();
  const lines = buildStatsLines(stats);
  outputLines(ctx, lines);
}

async function showMemoryPaths(ctx: MemoryCommandContext): Promise<void> {
  const stats = await ctx.actionLog.getMemoryStats();
  const lines = buildPathLines(stats);
  outputLines(ctx, lines);
}

async function showMemoryDebug(ctx: MemoryCommandContext): Promise<void> {
  const summary = await ctx.actionLog.getMemoryInjectionSummary({
    language: ctx.userConfig.language ?? 'zh',
    includePersistent: true,
    includeLastRun: true,
  });

  const lines: string[] = [];
  lines.push('');
  lines.push(colors.highlight('  记忆注入预览'));
  lines.push('');
  if (!summary) {
    lines.push(colors.dim('  (无可用记忆)'));
  } else {
    summary.split('\n').forEach(line => {
      lines.push(colors.info(`  ${line}`));
    });
  }
  lines.push('');
  outputLines(ctx, lines);
}

async function clearMemory(ctx: MemoryCommandContext): Promise<void> {
  let target: string;
  try {
    target = await ctx.promptSelect(
      '选择要清空的记忆类别',
      [
        { label: '全部', value: 'all', description: '所有长期记忆' },
        { label: '进展', value: 'progress', description: 'progress' },
        { label: '经验', value: 'lesson', description: 'lesson' },
        { label: '规范', value: 'standard', description: 'standard' },
        { label: '置顶', value: 'pinned', description: 'pinned' },
      ],
      'all',
      '↑↓ 选择, Enter 确认, ESC 取消'
    );
  } catch (error: any) {
    if (error?.message !== 'cancelled') {
      ctx.logInfo('操作取消', error?.message);
    }
    return;
  }

  // 二次确认
  const label = target === 'all' ? '全部长期记忆' : target;
  let confirm: string;
  try {
    confirm = await ctx.promptSelect(
      `确认清空 [${label}]？此操作不可撤销`,
      [
        { label: '取消', value: 'no' },
        { label: '确认清空', value: 'yes', description: '不可撤销' },
      ],
      'no'
    );
  } catch {
    return;
  }

  if (confirm !== 'yes') {
    ctx.logInfo('已取消', '');
    return;
  }

  const category = target === 'all' ? undefined : target as MemoryCategory;
  const { cleared, errors } = await ctx.actionLog.clearMemoryItems(category);

  if (errors.length > 0) {
    ctx.logInfo('部分清空失败', errors.join('; '));
  } else {
    ctx.logInfo('记忆已清空', `已清空: ${cleared.join(', ')}`);
  }
}

function buildStatsLines(stats: MemoryStats): string[] {
  const formatCount = (value: number) => value.toLocaleString('en-US');
  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb.toFixed(2)} MB`;
    return `${(mb / 1024).toFixed(2)} GB`;
  };

  const longTermTotal = stats.longTerm.total;
  const lines: string[] = [];
  lines.push('');
  lines.push(colors.highlight('  记忆统计'));
  lines.push('');
  lines.push(
    colors.dim('  短期 (recent): ') +
    colors.info(`${formatCount(stats.shortTerm.count)} 条, ${formatBytes(stats.shortTerm.sizeBytes)}`)
  );
  lines.push(
    colors.dim('  中期 (session): ') +
    colors.info(`${formatCount(stats.session.count)} 条, ${formatBytes(stats.session.sizeBytes)}`)
  );
  lines.push(
    colors.dim('  长期 (progress/standard/lesson): ') +
    colors.info(`${formatCount(longTermTotal.count)} 条, ${formatBytes(longTermTotal.sizeBytes)}`)
  );
  lines.push(
    colors.dim('    - progress: ') +
    colors.info(`${formatCount(stats.longTerm.progress.count)} 条, ${formatBytes(stats.longTerm.progress.sizeBytes)}`)
  );
  lines.push(
    colors.dim('    - standard: ') +
    colors.info(`${formatCount(stats.longTerm.standard.count)} 条, ${formatBytes(stats.longTerm.standard.sizeBytes)}`)
  );
  lines.push(
    colors.dim('    - lesson:   ') +
    colors.info(`${formatCount(stats.longTerm.lesson.count)} 条, ${formatBytes(stats.longTerm.lesson.sizeBytes)}`)
  );
  lines.push(
    colors.dim('  永久 (pinned): ') +
    colors.info(`${formatCount(stats.pinned.count)} 条, ${formatBytes(stats.pinned.sizeBytes)}`)
  );
  lines.push('');
  lines.push(
    colors.dim('  总计: ') +
    colors.info(`${formatCount(stats.totals.count)} 条, ${formatBytes(stats.totals.sizeBytes)}`)
  );
  lines.push('');

  return lines;
}

function buildPathLines(stats: MemoryStats): string[] {
  const lines: string[] = [];
  lines.push('');
  lines.push(colors.highlight('  记忆路径'));
  lines.push('');
  if (stats.shortTerm.path) {
    lines.push(colors.dim('  短期:   ') + colors.info(stats.shortTerm.path));
  }
  if (stats.session.path) {
    lines.push(colors.dim('  中期:   ') + colors.info(stats.session.path));
  }
  if (stats.longTerm.progress.path) {
    lines.push(colors.dim('  进度:   ') + colors.info(stats.longTerm.progress.path));
  }
  if (stats.longTerm.standard.path) {
    lines.push(colors.dim('  规范:   ') + colors.info(stats.longTerm.standard.path));
  }
  if (stats.longTerm.lesson.path) {
    lines.push(colors.dim('  教训:   ') + colors.info(stats.longTerm.lesson.path));
  }
  if (stats.pinned.path) {
    lines.push(colors.dim('  永久:   ') + colors.info(stats.pinned.path));
  }
  lines.push('');
  return lines;
}

function outputLines(ctx: MemoryCommandContext, lines: string[]): void {
  if (ctx.uiController) {
    const controller = ctx.uiController;
    if (typeof controller.setCommandOutputLines === 'function') {
      controller.setCommandOutputLines(lines);
      return;
    }
    if (typeof controller.printCommandOutput === 'function') {
      for (const line of lines) {
        controller.printCommandOutput(line);
      }
      return;
    }
  }
  for (const line of lines) {
    cliPrintln(line);
  }
}
