/**
 * Index Command Handlers
 * Handles code index-related CLI commands
 */

import { getLanguage } from '../i18n/index.js';
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
        '↑↓ 选择, Enter 确认, ESC 取消'
      );

      actionArg = action;
    } catch (error: any) {
      if (error?.message !== 'cancelled') {
        ctx.logInfo('索引操作失败', error?.message);
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
      ctx.logInfo('无效的操作', '使用 /index 查看可用操作');
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
    lines.push(colors.warning('状态: 未构建'));
    lines.push('');
    lines.push(colors.dim('运行 /index build 构建索引'));
  } else {
    lines.push(colors.success('状态: 已构建 ✓'));
    lines.push(`文件数: ${stats.fileCount}`);
    lines.push(`符号数: ${stats.symbolCount}`);

    const sizeKB = (stats.size / 1024).toFixed(1);
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    const sizeDisplay = stats.size > 1024 * 1024 ? `${sizeMB}MB` : `${sizeKB}KB`;
    lines.push(`索引大小: ${sizeDisplay}`);

    if (stats.lastUpdated) {
      lines.push(`最后更新: ${stats.lastUpdated.toLocaleString()}`);
    }
  }

  // 通过 logInfo 在 timeline 区域显示，不会覆盖输入框
  ctx.logInfo('代码索引状态', lines.join('\n'));
}

/**
 * 构建索引
 */
async function buildIndex(
  ctx: IndexCommandContext,
  indexManager: ReturnType<typeof createIndexManager>,
  force: boolean
): Promise<void> {
  ctx.logInfo(force ? '正在重建索引...' : '正在构建索引...');

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
  lines.push(`文件数: ${result.filesIndexed}`);
  lines.push(`符号数: ${result.symbolsFound}`);
  lines.push(`耗时: ${elapsed}s`);

  if (result.errors.length > 0) {
    lines.push('');
    lines.push(colors.warning('错误:'));
    for (const err of result.errors.slice(0, 3)) {
      lines.push(colors.dim(`  ${err.file}: ${err.error}`));
    }
    if (result.errors.length > 3) {
      lines.push(colors.dim(`  ... 还有 ${result.errors.length - 3} 个错误`));
    }
  }

  const title = result.success
    ? colors.success('✓ 索引构建完成')
    : colors.warning('⚠ 索引构建完成 (有错误)');

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
    ctx.logInfo('索引不存在', '无需清除');
    return;
  }

  try {
    const confirmed = await ctx.promptSelect(
      '确定清除索引?',
      [
        { label: '← Cancel', value: 'no' },
        { label: 'x Confirm clear', value: 'yes' },
      ],
      'no',
      '按 ↑↓ 选择'
    );

    if (confirmed !== 'yes') {
      ctx.logInfo('操作已取消');
      return;
    }

    await indexManager.clear();
    ctx.logInfo(colors.success('✓ 索引已清除'));
  } catch (error: any) {
    if (error?.message !== 'cancelled') {
      ctx.logInfo('清除失败', error?.message);
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
    { label: 'Web 开发 (TS + JS)', value: 'web', languages: ['typescript', 'javascript'] },
    { label: 'Full Stack (TS + JS + Python)', value: 'fullstack', languages: ['typescript', 'javascript', 'python'] },
    { label: '全部语言', value: 'all', languages: ['typescript', 'javascript', 'python', 'java', 'go', 'rust'] },
    { label: '仅 TypeScript', value: 'ts', languages: ['typescript'] },
    { label: '仅 Python', value: 'python', languages: ['python'] },
    { label: '仅 Go', value: 'go', languages: ['go'] },
  ];

  try {
    const selected = await ctx.promptSelect(
      '选择要索引的语言',
      languagePresets.map(preset => ({
        label: `${preset.label} — ${preset.languages.join(', ')}`,
        value: preset.value,
      })),
      'fullstack',
      '↑↓ 选择, Enter 确认, ESC 取消'
    );

    const preset = languagePresets.find(p => p.value === selected);
    if (!preset) {
      ctx.logInfo('配置已取消');
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
      colors.success('✓ 配置已保存'),
      `语言: ${preset.languages.join(', ')}\n运行 /index rebuild 以应用新配置`
    );
  } catch (error: any) {
    if (error?.message !== 'cancelled') {
      ctx.logInfo('配置失败', error?.message);
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
