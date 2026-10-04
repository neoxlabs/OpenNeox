
import chalk from 'chalk';
import { getGlobalCostTracker } from '@neoxlabs/platform/platform/costTracker.js';
import { formatCost } from '@neoxlabs/platform/platform/modelPricingTable.js';
import { getDisplayWidth, getLanguage } from '../i18n/index.js';

/**
 * 生成 Session 结束摘要文本
 * @param sessionId - 当前会话 ID，用于显示 resume 提示
 */
export function generateSessionSummary(sessionId?: string): string | null {
  const tracker = getGlobalCostTracker();
  const snapshot = tracker.getSnapshot();

  const hasRequests = snapshot.requestCount > 0;
  // 没有请求也没有 sessionId，无需显示
  if (!hasRequests && !sessionId) return null;

  let zh = false;
  try { zh = getLanguage() === 'zh'; } catch { /* */ }
  const L = zh
    ? { title: '本次会话', cost: '花费', tokens: 'Token', cache: '缓存', byModel: '按模型', resume: '接着聊' }
    : { title: 'Session', cost: 'Cost', tokens: 'Tokens', cache: 'Cache', byModel: 'By model', resume: 'Resume' };
  const labelW = Math.max(...Object.values(L).slice(1).map(s => getDisplayWidth(s))) + 2;
  const row = (label: string, value: string) => `  ${chalk.dim(label)}${' '.repeat(Math.max(1, labelW - getDisplayWidth(label)))}${value}`;
  const brand = chalk.hex('#8A6CFF');

  const lines: string[] = [];
  lines.push('');
  lines.push(`${brand('◆')} ${chalk.bold('Neox')}  ${chalk.dim(L.title)}`);

  // 费用统计（仅当有请求时）
  if (hasRequests) {
    lines.push(row(L.cost, `${formatCost(snapshot.totalCostUsd)} ${chalk.dim(zh ? `· ${snapshot.requestCount} 次请求` : `· ${snapshot.requestCount} requests`)}`));

    const fmtNum = (n: number): string => {
      if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
      if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
      return String(n);
    };

    lines.push(row(L.tokens, zh
      ? `${fmtNum(snapshot.totalInputTokens)} 入 ${chalk.dim('·')} ${fmtNum(snapshot.totalOutputTokens)} 出`
      : `${fmtNum(snapshot.totalInputTokens)} in ${chalk.dim('·')} ${fmtNum(snapshot.totalOutputTokens)} out`));

    if (snapshot.totalCachedTokens > 0) {
      const totalFedIn = snapshot.totalInputTokens + snapshot.totalCachedTokens;
      const cacheRate = totalFedIn > 0
        ? Math.min(100, (snapshot.totalCachedTokens / totalFedIn) * 100).toFixed(0)
        : '0';
      lines.push(row(L.cache, zh
        ? `命中 ${cacheRate}% ${chalk.dim(`· ${fmtNum(snapshot.totalCachedTokens)} · 省 ${formatCost(snapshot.cacheSavingsUsd)}`)}`
        : `${cacheRate}% hit ${chalk.dim(`· ${fmtNum(snapshot.totalCachedTokens)} · saved ${formatCost(snapshot.cacheSavingsUsd)}`)}`));
    }

    // 按模型分桶
    const models = Object.entries(snapshot.byModel).sort((a, b) => b[1].costUsd - a[1].costUsd);
    if (models.length > 1) {
      models.forEach(([model, stats], i) => {
        const shortModel = model.length > 30 ? model.substring(0, 29) + '…' : model;
        lines.push(row(i === 0 ? L.byModel : '', `${shortModel} ${chalk.dim(`· ${formatCost(stats.costUsd)} · ${stats.requests} req`)}`));
      });
    }
  }

  // Resume 提示 — 始终显示（只要有 sessionId）
  if (sessionId) {
    lines.push(row(L.resume, brand(`neox --resume ${sessionId}`)));
  }
  lines.push('');

  return lines.join('\n');
}
