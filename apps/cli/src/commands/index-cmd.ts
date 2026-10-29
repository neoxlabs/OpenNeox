/**
 * Index Command Handlers
 * Handles code index-related CLI commands
 */

import { getLanguage, L } from '../i18n/index.js';
import { colors } from '../constants.js';
import { saveConfig, type NeoxConfig } from '@neoxlabs/platform/utils/config.js';
import type { SelectionChoice } from '../cliTypes.js';
import { cliPrintln } from '../utils/output.js';
import { createIndexManager, createSmartReader } from '@neoxlabs/core/tools/smart-read/index.js';

/**
 * Index command context
 */
export interface IndexCommandContext {
  userConfig: NeoxConfig;
  workspacePath: string;
  promptSelect: (
    question: string,
    choices: SelectionChoice[],
    defaultValue?: string,
    hint?: string
  ) => Promise<string>;
  logInfo: (message: string, details?: string) => void;
  updateConfig: (config: NeoxConfig) => void;
}

/**
 * Handle /index command - 代码索引管理
 */
export async function handleIndexCommand(
  ctx: IndexCommandContext,
  actionArg?: string
): Promise<void> {
  const indexManager = createIndexManager(ctx.workspacePath);

  // 获取当前索引状态
  const stats = await indexManager.getStats();

  if (!actionArg) {
    // 显示菜单
    try {
      const zhUI = getLanguage() === 'zh';
      const action = await ctx.promptSelect(
        zhUI ? '代码索引管理' : 'Code index',
        [
          {
            label: stats.hasIndex
              ? (zhUI
                  ? `状态 — ${stats.fileCount} 个文件, ${stats.symbolCount} 个符号`
                  : `Status — ${stats.fileCount} files, ${stats.symbolCount} symbols`)
              : (zhUI ? '状态 — 未建立索引' : 'Status — not built'),
            value: 'status',
          },
          { label: zhUI ? '建立索引' : 'Build index', value: 'build' },
          { label: zhUI ? '重建索引' : 'Rebuild index', value: 'rebuild' },
          { label: zhUI ? 'x 清除索引' : 'x Clear index', value: 'clear' },
          { label: zhUI ? '配置' : 'Configure', value: 'config' },
        ],
        'status',
        L('↑↓ 选择, Enter 确认, ESC 取消', '↑↓ select · Enter confirm · Esc cancel')
      );

      actionArg = action;
    } catch (error: any) {
      if (error?.message !== 'cancelled') {
        ctx.logInfo(L('索引操作失败', 'Index action failed'), error?.message);
      }
      return;
    }
  }

  switch (actionArg) {
    case 'status':
      await showIndexStatus(ctx, indexManager);
      break;
    case 'build':
      await buildIndex(ctx, indexManager, false);
      break;
    case 'rebuild':
      await buildIndex(ctx, indexManager, true);
      break;
    case 'clear':
      await clearIndex(ctx, indexManager);
      break;
    case 'config':
      await configureIndex(ctx);
      break;
    default:
      ctx.logInfo(L('无效的操作', 'Unknown action'), L('使用 /index 查看可用操作', 'Run /index to see what’s available'));
  }
}

/**
 * 显示索引状态
 */
async function showIndexStatus(
  ctx: IndexCommandContext,
  indexManager: ReturnType<typeof createIndexManager>
): Promise<void> {
  const stats = await indexManager.getStats();

  // 构建状态信息
  const lines: string[] = [];

  if (!stats.hasIndex) {
    lines.push(colors.warning(L('状态: 未构建', 'Status: not built')));
    lines.push('');
    lines.push(colors.dim(L('运行 /index build 构建索引', 'Run /index build to build it')));
  } else {
    lines.push(colors.success(L('状态: 已构建 ✓', 'Status: built ✓')));
    lines.push(`${L('文件数', 'Files')}: ${stats.fileCount}`);
    lines.push(`${L('符号数', 'Symbols')}: ${stats.symbolCount}`);

    const sizeKB = (stats.size / 1024).toFixed(1);
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    const sizeDisplay = stats.size > 1024 * 1024 ? `${sizeMB}MB` : `${sizeKB}KB`;
    lines.push(`${L('索引大小', 'Size')}: ${sizeDisplay}`);

    if (stats.lastUpdated) {
      lines.push(`${L('最后更新', 'Updated')}: ${stats.lastUpdated.toLocaleString(getLanguage() === 'zh' ? 'zh-CN' : 'en-US')}`);
    }
  }

  // 通过 logInfo 在 timeline 区域显示，不会覆盖输入框
  ctx.logInfo(L('代码索引状态', 'Code index'), lines.join('\n'));
}

/**
 * 构建索引
 */
async function buildIndex(
  ctx: IndexCommandContext,
  indexManager: ReturnType<typeof createIndexManager>,
  force: boolean
): Promise<void> {
  ctx.logInfo(force ? L('正在重建索引...', 'Rebuilding index…') : L('正在构建索引...', 'Building index…'));

  const startTime = Date.now();

  const result = await indexManager.buildIndex({
    force,
    onProgress: (current, total, file) => {
      // 进度通过状态更新显示，不用单独输出
    },
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

  // 构建结果信息
  const lines: string[] = [];
  lines.push(`${L('文件数', 'Files')}: ${result.filesIndexed}`);
  lines.push(`${L('符号数', 'Symbols')}: ${result.symbolsFound}`);
  lines.push(`${L('耗时', 'Took')}: ${elapsed}s`);

  if (result.errors.length > 0) {
    lines.push('');
    lines.push(colors.warning(L('错误:', 'Errors:')));
    for (const err of result.errors.slice(0, 3)) {
      lines.push(colors.dim(`  ${err.file}: ${err.error}`));
    }
    if (result.errors.length > 3) {
      lines.push(colors.dim(L(`  ... 还有 ${result.errors.length - 3} 个错误`, `  ... ${result.errors.length - 3} more errors`)));
    }
  }

  const title = result.success
    ? colors.success(L('✓ 索引构建完成', '✓ Index built'))
    : colors.warning(L('⚠ 索引构建完成 (有错误)', '⚠ Index built (with errors)'));

  ctx.logInfo(title, lines.join('\n'));

  // 更新配置，启用索引
  const updatedConfig: NeoxConfig = {
    ...ctx.userConfig,
    smartRead: {
      ...ctx.userConfig.smartRead,
      enabled: true,
    },
  };
  ctx.updateConfig(updatedConfig);
  saveConfig(updatedConfig);
}

/**
 * 清除索引
 */
async function clearIndex(
  ctx: IndexCommandContext,
  indexManager: ReturnType<typeof createIndexManager>
): Promise<void> {
  const stats = await indexManager.getStats();

  if (!stats.hasIndex) {
    ctx.logInfo(L('索引不存在', 'No index'), L('无需清除', 'Nothing to clear'));
    return;
  }

  try {
    const confirmed = await ctx.promptSelect(
      L('确定清除索引?', 'Clear the index?'),
      [
        { label: L('← 取消', '← Cancel'), value: 'no' },
        { label: L('x 确认清除', 'x Clear'), value: 'yes' },
      ],
      'no',
      L('按 ↑↓ 选择', '↑↓ to select')
    );

    if (confirmed !== 'yes') {
      ctx.logInfo(L('操作已取消', 'Cancelled'));
      return;
    }

    await indexManager.clear();
    ctx.logInfo(colors.success(L('✓ 索引已清除', '✓ Index cleared')));
  } catch (error: any) {
    if (error?.message !== 'cancelled') {
      ctx.logInfo(L('清除失败', 'Clear failed'), error?.message);
    }
  }
}

/**
 * 配置索引
 */
async function configureIndex(ctx: IndexCommandContext): Promise<void> {
  const currentConfig = ctx.userConfig.smartRead || { enabled: true };

  // 使用预设的语言组合选择，避免 prompts.multiselect 和 Ink UI 冲突
  const languagePresets = [
    { label: L('Web 开发 (TS + JS)', 'Web (TS + JS)'), value: 'web', languages: ['typescript', 'javascript'] },
    { label: 'Full Stack (TS + JS + Python)', value: 'fullstack', languages: ['typescript', 'javascript', 'python'] },
    { label: L('全部语言', 'All languages'), value: 'all', languages: ['typescript', 'javascript', 'python', 'java', 'go', 'rust'] },
    { label: L('仅 TypeScript', 'TypeScript only'), value: 'ts', languages: ['typescript'] },
    { label: L('仅 Python', 'Python only'), value: 'python', languages: ['python'] },
    { label: L('仅 Go', 'Go only'), value: 'go', languages: ['go'] },
  ];

  try {
    const selected = await ctx.promptSelect(
      L('选择要索引的语言', 'Languages to index'),
      languagePresets.map(preset => ({
        label: `${preset.label} — ${preset.languages.join(', ')}`,
        value: preset.value,
      })),
      'fullstack',
      L('↑↓ 选择, Enter 确认, ESC 取消', '↑↓ select · Enter confirm · Esc cancel')
    );

    const preset = languagePresets.find(p => p.value === selected);
    if (!preset) {
      ctx.logInfo(L('配置已取消', 'Cancelled'));
      return;
    }

    // 保存配置
    const updatedConfig: NeoxConfig = {
      ...ctx.userConfig,
      smartRead: {
        ...currentConfig,
        enabled: true,
        languages: preset.languages,
      },
    };

    ctx.updateConfig(updatedConfig);
    saveConfig(updatedConfig);

    ctx.logInfo(
      colors.success(L('✓ 配置已保存', '✓ Saved')),
      `${L('语言', 'Languages')}: ${preset.languages.join(', ')}\n${L('运行 /index rebuild 以应用新配置', 'Run /index rebuild to apply')}`
    );
  } catch (error: any) {
    if (error?.message !== 'cancelled') {
      ctx.logInfo(L('配置失败', 'Configure failed'), error?.message);
    }
  }
}

/**
 * Handle /index-build shortcut
 */
export async function handleIndexBuildCommand(ctx: IndexCommandContext): Promise<void> {
  return handleIndexCommand(ctx, 'build');
}

/**
 * Handle /index-status shortcut
 */
export async function handleIndexStatusCommand(ctx: IndexCommandContext): Promise<void> {
  return handleIndexCommand(ctx, 'status');
}
