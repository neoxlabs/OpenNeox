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
import { L, getLanguage } from '../i18n/index.js';

const menuHint = () => L('↑↓ 选择, Enter 确认, ESC 取消', '↑↓ select · Enter confirm · Esc cancel');

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
        L('记忆系统', 'Memory'),
        [
          { label: L('查看统计', 'Stats'), value: 'show' },
          { label: L('存储路径', 'Storage paths'), value: 'paths' },
          { label: L('自动记忆开关', 'Auto memory on/off'), value: 'config' },
          { label: L('调试注入内容', 'Preview injected memory'), value: 'debug' },
          { label: L('清除记忆', 'Clear memory'), value: 'clear' },
        ],
        'show',
        menuHint()
      );
    } catch (error: any) {
      if (error?.message !== 'cancelled') {
        ctx.logInfo(L('操作取消', 'Cancelled'), error?.message);
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
      ctx.logInfo(L('无效的操作', 'Unknown action'), L('使用 /memory 查看可用操作', 'Run /memory to see what’s available'));
  }
}

async function configureMemory(ctx: MemoryCommandContext): Promise<void> {
  const enabled = ctx.userConfig.memory?.autoMemoryEnabled !== false;
  let value: string;
  try {
    value = await ctx.promptSelect(
      L('自动记忆 (需开启 Jev: 每轮先判断有没有值得记的, 有才用当前模型记下)',
        'Auto memory (needs Jev: each turn checks for something worth keeping, then saves it with the current model)'),
      [
        { label: L('开启', 'On'), value: 'on' },
        { label: L('关闭', 'Off'), value: 'off' },
      ],
      enabled ? 'on' : 'off'
    );
  } catch (error: any) {
    if (error?.message !== 'cancelled') {
      ctx.logInfo(L('操作取消', 'Cancelled'), error?.message);
    }
    return;
  }
  updateMemoryConfig(ctx, { autoMemoryEnabled: value === 'on' });
  ctx.logInfo(L('自动记忆已更新', 'Auto memory updated'), value === 'on' ? L('已开启', 'On') : L('已关闭', 'Off'));
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
    language: getLanguage(),
    includePersistent: true,
    includeLastRun: true,
  });

  const lines: string[] = [];
  lines.push('');
  lines.push(colors.highlight(L('  记忆注入预览', '  Injected memory preview')));
  lines.push('');
  if (!summary) {
    lines.push(colors.dim(L('  (无可用记忆)', '  (no memory yet)')));
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
      L('选择要清空的记忆类别', 'Which memory to clear?'),
      [
        { label: L('全部', 'All'), value: 'all', description: L('所有长期记忆', 'all long-term memory') },
        { label: L('进展', 'Progress'), value: 'progress', description: 'progress' },
        { label: L('经验', 'Lessons'), value: 'lesson', description: 'lesson' },
        { label: L('规范', 'Standards'), value: 'standard', description: 'standard' },
        { label: L('置顶', 'Pinned'), value: 'pinned', description: 'pinned' },
      ],
      'all',
      menuHint()
    );
  } catch (error: any) {
    if (error?.message !== 'cancelled') {
      ctx.logInfo(L('操作取消', 'Cancelled'), error?.message);
    }
    return;
  }

  // 二次确认
  const label = target === 'all' ? L('全部长期记忆', 'all long-term memory') : target;
  let confirm: string;
  try {
    confirm = await ctx.promptSelect(
      L(`确认清空 [${label}]？此操作不可撤销`, `Clear [${label}]? This can’t be undone`),
      [
        { label: L('取消', 'Cancel'), value: 'no' },
        { label: L('确认清空', 'Clear'), value: 'yes', description: L('不可撤销', 'can’t be undone') },
      ],
      'no'
    );
  } catch {
    return;
  }

  if (confirm !== 'yes') {
    ctx.logInfo(L('已取消', 'Cancelled'), '');
    return;
  }

  const category = target === 'all' ? undefined : target as MemoryCategory;
  const { cleared, errors } = await ctx.actionLog.clearMemoryItems(category);

  if (errors.length > 0) {
    ctx.logInfo(L('部分清空失败', 'Some items failed to clear'), errors.join('; '));
  } else {
    ctx.logInfo(L('记忆已清空', 'Memory cleared'), `${L('已清空', 'Cleared')}: ${cleared.join(', ')}`);
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
  const item = (n: number, bytes: number) => `${formatCount(n)} ${L('条', 'items')}, ${formatBytes(bytes)}`;
  const lines: string[] = [];
  lines.push('');
  lines.push(colors.highlight(L('  记忆统计', '  Memory stats')));
  lines.push('');
  lines.push(colors.dim(L('  短期 (recent): ', '  Short-term (recent): ')) + colors.info(item(stats.shortTerm.count, stats.shortTerm.sizeBytes)));
  lines.push(colors.dim(L('  中期 (session): ', '  Mid-term (session): ')) + colors.info(item(stats.session.count, stats.session.sizeBytes)));
  lines.push(colors.dim(L('  长期 (progress/standard/lesson): ', '  Long-term (progress/standard/lesson): ')) + colors.info(item(longTermTotal.count, longTermTotal.sizeBytes)));
  lines.push(colors.dim('    - progress: ') + colors.info(item(stats.longTerm.progress.count, stats.longTerm.progress.sizeBytes)));
  lines.push(colors.dim('    - standard: ') + colors.info(item(stats.longTerm.standard.count, stats.longTerm.standard.sizeBytes)));
  lines.push(colors.dim('    - lesson:   ') + colors.info(item(stats.longTerm.lesson.count, stats.longTerm.lesson.sizeBytes)));
  lines.push(colors.dim(L('  永久 (pinned): ', '  Pinned: ')) + colors.info(item(stats.pinned.count, stats.pinned.sizeBytes)));
  lines.push('');
  lines.push(colors.dim(L('  总计: ', '  Total: ')) + colors.info(item(stats.totals.count, stats.totals.sizeBytes)));
  lines.push('');

  return lines;
}

function buildPathLines(stats: MemoryStats): string[] {
  const lines: string[] = [];
  lines.push('');
  lines.push(colors.highlight(L('  记忆路径', '  Memory paths')));
  lines.push('');
  const row = (zh: string, en: string, p: string) => colors.dim(L(`  ${zh}:   `, `  ${en.padEnd(10)}`)) + colors.info(p);
  if (stats.shortTerm.path) lines.push(row('短期', 'Short:', stats.shortTerm.path));
  if (stats.session.path) lines.push(row('中期', 'Session:', stats.session.path));
  if (stats.longTerm.progress.path) lines.push(row('进度', 'Progress:', stats.longTerm.progress.path));
  if (stats.longTerm.standard.path) lines.push(row('规范', 'Standard:', stats.longTerm.standard.path));
  if (stats.longTerm.lesson.path) lines.push(row('教训', 'Lessons:', stats.longTerm.lesson.path));
  if (stats.pinned.path) lines.push(row('永久', 'Pinned:', stats.pinned.path));
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
