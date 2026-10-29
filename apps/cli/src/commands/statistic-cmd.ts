/**
 * Statistic Command Handlers
 * Token 使用统计相关 CLI 命令
 */

import { colors } from '../constants.js';
import type { SelectionChoice } from '../cliTypes.js';
import { cliPrintln } from '../utils/output.js';
import { tokenUsageService, type ProviderUsageStats, type TokenUsageRecord, type UsageStatistics } from '@neoxlabs/platform/platform/tokenUsageService.js';
import { findPricingForModel, calculateCost } from './pricing-cmd.js';
import type { NeoxConfig } from '@neoxlabs/platform/utils/config.js';
import { t, isZh, L } from '../i18n/index.js';

/**
 * Statistic command context
 */
export interface StatisticCommandContext {
  promptSelect: (
    question: string,
    choices: SelectionChoice[],
    defaultValue?: string,
    hint?: string
  ) => Promise<string>;
  logInfo: (message: string, details?: string) => void;
  outputLines?: (lines: string[]) => void;
  clearOutputLines?: () => void;
  userConfig?: NeoxConfig;
}

/* 菜单通用文案 —— 函数而不是常量, 切语言后马上生效 */
const navHint = () => L('上下键选择，回车确认，ESC 返回', '↑↓ select · Enter confirm · Esc back');
const moreTitle = () => L('继续查看', 'More');
const backLabel = () => L('← 返回', '← Back');
const providerStatsLabel = () => L('按 Provider 统计', 'Provider stats');
const recordsLabel = () => L('详细记录', 'Detail records');
const savesText = (pct: number) => L(` (${pct}% 节省)`, ` (${pct}% saved)`);

/**
 * 格式化数字（带 K/M 后缀）
 */
function formatNumber(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}

function outputToUI(ctx: StatisticCommandContext, lines: string[]): void {
  if (ctx.outputLines) {
    // Ink UI: Use commandOutput system
    ctx.outputLines(lines);
  } else {
    // CLI output: Use cliPrintln
    lines.forEach(line => cliPrintln(line));
  }
}

/**
 * 格式化时间戳
 */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now.getTime() - timestamp;

  // 小于 1 分钟
  if (diff < 60000) return isZh() ? '刚刚' : 'just now';
  // 小于 1 小时
  if (diff < 3600000) return isZh() ? `${Math.floor(diff / 60000)} 分钟前` : `${Math.floor(diff / 60000)}m ago`;
  // 小于 1 天
  if (diff < 86400000) return isZh() ? `${Math.floor(diff / 3600000)} 小时前` : `${Math.floor(diff / 3600000)}h ago`;
  // 小于 7 天
  if (diff < 604800000) return isZh() ? `${Math.floor(diff / 86400000)} 天前` : `${Math.floor(diff / 86400000)}d ago`;

  // 超过 7 天，显示日期
  return date.toLocaleString(isZh() ? 'zh-CN' : 'en-US', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

interface CostInfo {
  totalCost: number;
  modelCount: number;
  unmatchedModels: string[];
}

async function calculateTotalCost(config: NeoxConfig): Promise<CostInfo> {
  const result: CostInfo = {
    totalCost: 0,
    modelCount: 0,
    unmatchedModels: [],
  };

  try {
    const providerStats = await tokenUsageService.getProviderStats();
    const seenModels = new Set<string>();
    const unmatchedSet = new Set<string>();

    for (const stats of providerStats) {
      // 获取该 Provider 的所有记录以获取模型信息
      const records = await tokenUsageService.getProviderRecords(stats.provider);

      // 按模型分组计算
      const modelStats = new Map<string, { input: number; output: number; cached: number }>();
      for (const record of records) {
        const existing = modelStats.get(record.model) || { input: 0, output: 0, cached: 0 };
        existing.input += record.inputTokens;
        existing.output += record.outputTokens;
        existing.cached += record.cachedTokens || 0;
        modelStats.set(record.model, existing);
      }

      // 计算每个模型的费用
      for (const [model, tokens] of modelStats) {
        const pricing = findPricingForModel(config, model);
        if (pricing) {
          const cost = calculateCost(pricing, tokens.input, tokens.output, tokens.cached);
          result.totalCost += cost;
          if (!seenModels.has(model)) {
            seenModels.add(model);
            result.modelCount++;
          }
        } else {
          if (!seenModels.has(model)) {
            seenModels.add(model);
            unmatchedSet.add(model);
          }
        }
      }
    }

    result.unmatchedModels = Array.from(unmatchedSet);
  } catch (error) {
    // 静默处理错误
  }

  return result;
}

/**
 * 显示统计总览
 */
async function showSummary(ctx: StatisticCommandContext): Promise<void> {
  try {
    if (ctx.clearOutputLines) {
      ctx.clearOutputLines();
    }

    const summary = await tokenUsageService.getSummary();

    if (summary.totalRequests === 0) {
      ctx.logInfo(L('暂无使用记录', 'No usage recorded yet'));
      return;
    }

    const lines: string[] = [];

    lines.push('');
    lines.push(colors.highlight(L('Token 使用统计总览', 'Token usage overview')));
    lines.push('');

    // 基本统计
    lines.push(colors.primary(L('  总请求数:     ', '  Requests:     ')) + colors.success(formatNumber(summary.totalRequests) + L(' 次', '')));
    lines.push(colors.primary(L('  总 Tokens:    ', '  Tokens:       ')) + colors.success(formatNumber(summary.totalTokens)));
    lines.push(colors.primary('  Input:        ') + colors.dim(formatNumber(summary.totalInputTokens)));
    lines.push(colors.primary('  Output:       ') + colors.dim(formatNumber(summary.totalOutputTokens)));

    // 缓存统计
    if (summary.totalCachedTokens > 0) {
      lines.push('');
      lines.push(colors.highlight(L('  缓存统计:', '  Cache:')));

      const cacheHitRate = (summary.cacheHitRate * 100).toFixed(1);
      lines.push(colors.primary(L('  总缓存命中:   ', '  Cache hits:   ')) + colors.success(formatNumber(summary.totalCachedTokens)) + colors.dim(L(` (${cacheHitRate}% 命中率)`, ` (${cacheHitRate}% hit rate)`)));

      // OpenAI 缓存
      if (summary.totalOpenaiCachedTokens > 0) {
        lines.push(colors.primary(L('  OpenAI 缓存:  ', '  OpenAI cache: ')) + colors.dim(formatNumber(summary.totalOpenaiCachedTokens)) + colors.success(savesText(50)));
      }

      // Anthropic 缓存读取
      if (summary.totalAnthropicCacheReadTokens > 0) {
        lines.push(colors.primary('  Claude Read:  ') + colors.dim(formatNumber(summary.totalAnthropicCacheReadTokens)) + colors.success(savesText(90)));
      }

      // Anthropic 缓存创建
      if (summary.totalAnthropicCacheCreationTokens > 0) {
        lines.push(colors.primary('  Claude Write: ') + colors.dim(formatNumber(summary.totalAnthropicCacheCreationTokens)) + colors.warning(L(' (+25% 成本)', ' (+25% cost)')));
      }
    }

    // 其他信息
    lines.push('');
    lines.push(colors.primary(L('  Provider 数:  ', '  Providers:    ')) + colors.dim(summary.providerCount.toString()));
    lines.push(colors.primary(L('  最后请求:     ', '  Last request: ')) + colors.dim(formatTime(summary.lastRequestTime)));

    if (ctx.userConfig?.modelPricing && ctx.userConfig.modelPricing.length > 0) {
      const costInfo = await calculateTotalCost(ctx.userConfig);
      if (costInfo.totalCost > 0) {
        lines.push('');
        lines.push(colors.highlight(isZh() ? '  费用统计:' : '  Cost Summary:'));
        lines.push(colors.primary(isZh() ? '  预估总费用:  ' : '  Estimated:    ') + colors.success(`$${costInfo.totalCost.toFixed(4)}`));
        if (costInfo.modelCount > 0) {
          lines.push(colors.dim(isZh() ? `    (${costInfo.modelCount} 个模型有定价配置)` : `    (${costInfo.modelCount} models with pricing)`));
        }
        if (costInfo.unmatchedModels.length > 0 && costInfo.unmatchedModels.length <= 3) {
          lines.push(colors.dim(isZh() ? `    未配置定价: ${costInfo.unmatchedModels.join(', ')}` : `    No pricing: ${costInfo.unmatchedModels.join(', ')}`));
        } else if (costInfo.unmatchedModels.length > 3) {
          lines.push(colors.dim(isZh() ? `    未配置定价: ${costInfo.unmatchedModels.length} 个模型` : `    No pricing: ${costInfo.unmatchedModels.length} models`));
        }
      }
    }

    lines.push('');

    outputToUI(ctx, lines);

    // 询问是否继续查看其他统计
    const action = await ctx.promptSelect(
      moreTitle(),
      [
        { label: providerStatsLabel(), value: 'providers' },
        { label: recordsLabel(), value: 'records' },
        { label: backLabel(), value: 'back' },
      ],
      'back',
      navHint()
    );

    if (action === 'back') {
      if (ctx.clearOutputLines) {
        ctx.clearOutputLines();
      }
      // Return to main menu
      await handleStatisticCommand(ctx);
      return;
    }

    if (action === 'providers') {
      await showProviderStats(ctx);
    } else if (action === 'records') {
      await showProviderRecords(ctx);
    }

  } catch (err: any) {
    if (ctx.clearOutputLines) {
      ctx.clearOutputLines();
    }

    if (err.message !== 'cancelled' && err.message !== 'User cancelled') {
      outputToUI(ctx, [colors.error(L('加载统计失败: ', 'Failed to load stats: ') + err.message)]);
    }
    // Cancelled - don't return to menu
  }
}

/**
 * 移除颜色代码，返回实际显示宽度
 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * 构建单个 Provider 的统计显示内容
 */
function buildProviderStatsLines(stat: ProviderUsageStats): string[] {
  const lines: string[] = [];

  lines.push(colors.success('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  lines.push(colors.primary(`${stat.provider}`) + colors.dim(L(` (${stat.totalRequests} 次请求)`, ` (${stat.totalRequests} requests)`)));
  lines.push('');

  // Token 统计
  lines.push(
    colors.dim('Input:  ') + colors.primary(formatNumber(stat.totalInputTokens).padEnd(8)) +
    colors.dim('Output: ') + colors.success(formatNumber(stat.totalOutputTokens).padEnd(8)) +
    colors.dim('Total:  ') + colors.warning(formatNumber(stat.totalTokens))
  );

  // 缓存统计
  if (stat.totalCachedTokens > 0) {
    lines.push('');
    if (stat.totalOpenaiCachedTokens > 0) {
      lines.push(colors.dim(L('OpenAI 缓存:  ', 'OpenAI cache: ')) + colors.code(formatNumber(stat.totalOpenaiCachedTokens)) + colors.success(savesText(50)));
    }
    if (stat.totalAnthropicCacheReadTokens > 0) {
      lines.push(colors.dim('Claude Read:  ') + colors.info(formatNumber(stat.totalAnthropicCacheReadTokens)) + colors.success(savesText(90)));
    }
    if (stat.totalAnthropicCacheCreationTokens > 0) {
      lines.push(colors.dim('Claude Write: ') + colors.code(formatNumber(stat.totalAnthropicCacheCreationTokens)) + colors.warning(L(' (+25% 成本)', ' (+25% cost)')));
    }
  }

  // 成功率和平均耗时
  const successRate = stat.totalRequests > 0
    ? ((stat.successRequests / stat.totalRequests) * 100).toFixed(1)
    : '0';
  lines.push('');
  lines.push(
    colors.dim(L('成功率: ', 'Success: ')) + colors.success(successRate + '%') +
    colors.dim(L('    平均耗时: ', '    Avg time: ')) + colors.warning(stat.avgDuration + 'ms')
  );

  // 模型分布
  const models = Object.entries(stat.models);
  if (models.length > 0) {
    lines.push('');
    lines.push(colors.dim(L('模型分布:', 'By model:')));
    for (const [model, modelStat] of models.slice(0, 3)) {
      const modelName = model.length > 30 ? model.slice(0, 27) + '...' : model;
      lines.push(
        colors.dim(`  ${modelName.padEnd(30)} `) +
        colors.primary(formatNumber(modelStat.totalTokens).padEnd(8)) +
        colors.dim(L(` (${modelStat.requests} 次)`, ` (${modelStat.requests} req)`))
      );
    }
    if (models.length > 3) {
      lines.push(colors.dim(L(`  ... 还有 ${models.length - 3} 个模型`, `  ... ${models.length - 3} more models`)));
    }
  }

  lines.push('');

  return lines;
}

/**
 * 显示 Provider 统计列表（支持分页）
 */
async function showProviderStats(ctx: StatisticCommandContext): Promise<void> {
  try {
    const providerStats = await tokenUsageService.getProviderStats();

    if (providerStats.length === 0) {
      ctx.logInfo(L('暂无 Provider 统计', 'No provider stats yet'));
      return;
    }

    const termRows = process.stdout.rows || 24;
    const PAGE_SIZE = Math.max(2, Math.floor((termRows - 14) / 6));
    const totalPages = Math.ceil(providerStats.length / PAGE_SIZE);
    let currentPage = 0;

    // 分页循环
    while (true) {
      if (ctx.clearOutputLines) {
        ctx.clearOutputLines();
      }

      const startIdx = currentPage * PAGE_SIZE;
      const endIdx = Math.min(startIdx + PAGE_SIZE, providerStats.length);
      const currentStats = providerStats.slice(startIdx, endIdx);

      const lines: string[] = [];

      lines.push('');
      lines.push(colors.highlight(L('Provider 统计', 'Provider stats')) + colors.dim(L(` (第 ${currentPage + 1}/${totalPages} 页)`, ` (page ${currentPage + 1}/${totalPages})`)));
      lines.push('');

      // 显示当前页的 Provider 统计
      for (const stat of currentStats) {
        lines.push(...buildProviderStatsLines(stat));
      }

      lines.push(colors.success('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
      lines.push('');

      outputToUI(ctx, lines);

      // 构建分页导航选项
      const choices: SelectionChoice[] = [];

      // 上一页
      if (currentPage > 0) {
        choices.push({ label: L(`← 第 ${currentPage} 页`, `← Page ${currentPage}`), value: 'prev' });
      }

      // 下一页
      if (currentPage < totalPages - 1) {
        choices.push({ label: L(`→ 第 ${currentPage + 2} 页`, `→ Page ${currentPage + 2}`), value: 'next' });
      }

      // 其他操作
      choices.push({ label: recordsLabel(), value: 'records' });
      choices.push({ label: backLabel(), value: 'back' });

      // 询问下一步操作
      const action = await ctx.promptSelect(
        moreTitle(),
        choices,
        'back',
        navHint()
      );

      // 处理分页
      if (action === 'prev') {
        currentPage--;
        continue;
      } else if (action === 'next') {
        currentPage++;
        continue;
      }

      // 处理其他操作
      if (action === 'back') {
        if (ctx.clearOutputLines) {
          ctx.clearOutputLines();
        }
        // Return to main menu
        await handleStatisticCommand(ctx);
        return;
      }

      if (action === 'records') {
        await showProviderRecords(ctx);
        return;
      }
    }

  } catch (err: any) {
    if (ctx.clearOutputLines) {
      ctx.clearOutputLines();
    }

    if (err.message !== 'cancelled' && err.message !== 'User cancelled') {
      outputToUI(ctx, [colors.error(L('加载 Provider 统计失败: ', 'Failed to load provider stats: ') + err.message)]);
    }
    // Cancelled - don't return to menu
  }
}

/**
 * 显示指定 Provider 的详细记录
 */
async function showProviderRecords(ctx: StatisticCommandContext): Promise<void> {
  try {
    if (ctx.clearOutputLines) {
      ctx.clearOutputLines();
    }

    const providerStats = await tokenUsageService.getProviderStats();

    if (providerStats.length === 0) {
      ctx.logInfo(L('暂无 Provider 统计', 'No provider stats yet'));
      return;
    }

    // 选择 Provider
    const choices: SelectionChoice[] = providerStats.map(stat => ({
      label: L(`${stat.provider} — ${stat.totalRequests} 次, ${formatNumber(stat.totalTokens)} tokens`, `${stat.provider} — ${stat.totalRequests} reqs, ${formatNumber(stat.totalTokens)} tokens`),
      value: stat.provider,
    }));

    choices.push({ label: backLabel(), value: '__back__' });

    const selectedProvider = await ctx.promptSelect(
      L('选择 Provider 查看详细记录', 'Pick a provider to see its records'),
      choices,
      providerStats[0].provider,
      navHint()
    );

    if (selectedProvider === '__back__') {
      if (ctx.clearOutputLines) {
        ctx.clearOutputLines();
      }
      await handleStatisticCommand(ctx);
      return;
    }

    if (ctx.clearOutputLines) {
      ctx.clearOutputLines();
    }

    // 获取记录
    const records = await tokenUsageService.getProviderRecords(selectedProvider, 50);

    if (records.length === 0) {
      ctx.logInfo(L('该 Provider 暂无记录', 'No records for this provider'));
      return;
    }

    const lines: string[] = [];

    lines.push('');
    lines.push(colors.highlight(L(`${selectedProvider} - 最近 ${records.length} 条记录`, `${selectedProvider} — last ${records.length} records`)));
    lines.push('');

    // 表头
    lines.push(
      colors.dim(L('  类型      ', '  Type      ')) +
      colors.dim(L('模型              ', 'Model           ')) +
      colors.dim('Input   ') +
      colors.dim('Output  ') +
      colors.dim('Cache   ') +
      colors.dim(L('耗时    ', 'Time    ')) +
      colors.dim(L('状态  ', 'OK    ')) +
      colors.dim(L('时间', 'When'))
    );
    lines.push(colors.dim('  ────────────────────────────────────────────────────────────────────'));

    // 记录行
    for (const record of records) {
      const type = record.requestType === 'health-check' ? L('测试', 'test') : L('对话', 'chat');
      const modelName = record.model.length > 14 ? record.model.slice(0, 11) + '...' : record.model;
      const input = formatNumber(record.inputTokens).padEnd(7);
      const output = formatNumber(record.outputTokens).padEnd(7);
      const cached = record.cachedTokens ? formatNumber(record.cachedTokens).padEnd(7) : '-'.padEnd(7);
      const duration = (record.duration + 'ms').padEnd(7);
      const status = record.success ? colors.success('✓') : colors.error('✗');
      const time = formatTime(record.timestamp);

      lines.push(
        colors.dim('  ' + type.padEnd(8)) +
        colors.primary(modelName.padEnd(16)) +
        colors.dim(input) +
        colors.success(output) +
        colors.code(cached) +
        colors.warning(duration) +
        status + '     ' +
        colors.dim(time)
      );
    }

    lines.push('');

    outputToUI(ctx, lines);

    try {
      const action = await ctx.promptSelect(
        moreTitle(),
        [
          { label: backLabel(), value: 'back' },
          { label: providerStatsLabel(), value: 'providers' },
          { label: L('其他 Provider', 'Other provider'), value: 'other' },
        ],
        'back',
        navHint()
      );

      if (ctx.clearOutputLines) {
        ctx.clearOutputLines();
      }

      if (action === 'other') {
        // 查看其他 Provider 的记录
        await showProviderRecords(ctx);
      } else if (action === 'providers') {
        // 返回 Provider 统计
        await showProviderStats(ctx);
      } else if (action === 'back') {
        // 返回主菜单
        await handleStatisticCommand(ctx);
      }
    } catch (backErr: any) {
      // User cancelled (ESC) - that's fine, just clear output
      if (ctx.clearOutputLines) {
        ctx.clearOutputLines();
      }
    }

  } catch (err: any) {
    // (before records are shown). If error occurs after showing records,
    // the inner catch block has already handled it.
    if (err.message === 'cancelled' || err.message === 'User cancelled') {
      // User cancelled during provider selection - clear any output
      if (ctx.clearOutputLines) {
        ctx.clearOutputLines();
      }
    } else {
      // Real error - show error message
      ctx.logInfo(L('加载详细记录失败', 'Failed to load records'), err.message);
    }
    // Cancelled - don't return to menu
  }
}

/**
 * 清除统计数据
 */
async function clearStatistics(ctx: StatisticCommandContext): Promise<void> {
  try {
    const providerStats = await tokenUsageService.getProviderStats();

    const choices: SelectionChoice[] = [
      { label: L('x 全部清除', 'x Clear all'), value: 'all' },
    ];

    if (providerStats.length > 0) {
      for (const stat of providerStats) {
        choices.push({
          label: L(`x 清除 ${stat.provider} — ${stat.totalRequests} 条`, `x Clear ${stat.provider} — ${stat.totalRequests} records`),
          value: stat.provider,
        });
      }
    }

    choices.push({ label: L('← 取消', '← Cancel'), value: 'cancel' });

    const action = await ctx.promptSelect(
      L('清除统计数据', 'Clear usage data'),
      choices,
      'cancel',
      L('⚠ 此操作不可恢复', '⚠ This can’t be undone')
    );

    if (action === 'cancel') {
      return;
    }

    if (action === 'all') {
      await tokenUsageService.clearAll();
      ctx.logInfo(L('已清除所有统计数据', 'All usage data cleared'));
    } else {
      await tokenUsageService.clearProvider(action);
      ctx.logInfo(L(`已清除 ${action} 的统计数据`, `Usage data for ${action} cleared`));
    }

  } catch (err: any) {
    outputToUI(ctx, [colors.error(L('清除统计失败: ', 'Failed to clear stats: ') + err.message)]);
  }
}

/**
 * Handle /statistic command - Token 使用统计
 */
export async function handleStatisticCommand(
  ctx: StatisticCommandContext,
  actionArg?: string
): Promise<void> {
  // 直接指定了操作
  if (actionArg) {
    switch (actionArg) {
      case 'summary':
        await showSummary(ctx);
        return;
      case 'providers':
        await showProviderStats(ctx);
        return;
      case 'records':
        await showProviderRecords(ctx);
        return;
      case 'clear':
        await clearStatistics(ctx);
        return;
      default:
        outputToUI(ctx, [
          colors.error(`${L('未知操作', 'Unknown action')}: ${actionArg}`),
          colors.dim(`${L('可用操作', 'Available')}: summary, providers, records, clear`),
        ]);
        return;
    }
  }

  // 交互式菜单
  try {
    const action = await ctx.promptSelect(
      L('Token 使用统计', 'Token usage'),
      [
        { label: L('总览', 'Summary'), value: 'summary' },
        { label: providerStatsLabel(), value: 'providers' },
        { label: recordsLabel(), value: 'records' },
        { label: L('x 清除数据', 'x Clear data'), value: 'clear' },
        { label: backLabel(), value: 'back' },
      ],
      'summary',
      L('上下键选择，回车确认，ESC 退出', '↑↓ select · Enter confirm · Esc exit')
    );

    // 处理返回
    if (action === 'back') {
      return;
    }

    switch (action) {
      case 'summary':
        await showSummary(ctx);
        break;
      case 'providers':
        await showProviderStats(ctx);
        break;
      case 'records':
        await showProviderRecords(ctx);
        break;
      case 'clear':
        await clearStatistics(ctx);
        break;
    }

  } catch (err: any) {
    // which causes input box to shift down

    // ESC 或其他错误，静默返回
    if (err.message !== 'User cancelled' && err.message !== 'cancelled') {
      outputToUI(ctx, [colors.error(L('统计命令失败: ', 'Stats command failed: ') + err.message)]);
    }
    // User cancelled (ESC) - just return without clearing
  }
}
