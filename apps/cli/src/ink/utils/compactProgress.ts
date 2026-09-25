/**
 * CLI compact status — desktop CompactionView 同款「电量条」进度。
 * Windows 终端用 ▰/▱ 的 ASCII 后备 (# / .)。
 */

import { getLanguage } from '../../i18n/index.js';
import { sym } from './winSymbols.js';

const BAR_WIDTH = 10;

function isZh(): boolean {
  return getLanguage() === 'zh';
}

/** `[▰▰▰▱▱▱▱▱▱▱] 30% 1/4` */
export function formatCompactBatteryBar(
  completed: number,
  total: number,
  width: number = BAR_WIDTH,
): string {
  const fill = sym('▰');
  const empty = sym('▱');
  if (!Number.isFinite(total) || total <= 0) {
    return `[${empty.repeat(width)}]`;
  }
  const clamped = Math.max(0, Math.min(Math.floor(completed), Math.floor(total)));
  const filled = Math.round((clamped / total) * width);
  const pct = Math.round((clamped / total) * 100);
  return `[${fill.repeat(filled)}${empty.repeat(Math.max(0, width - filled))}] ${pct}% ${clamped}/${total}`;
}

export function parseCompactProgress(
  text: string,
  details?: string,
): { completed: number; total: number } | null {
  const src = `${text || ''} ${details || ''}`;
  const m = src.match(/(\d+)\s*\/\s*(\d+)/);
  if (!m) return null;
  const completed = Number.parseInt(m[1], 10);
  const total = Number.parseInt(m[2], 10);
  if (!Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) return null;
  return { completed, total };
}

/** 终态文案 — 提交静态卡并清 busy */
export function isCompactTerminalMessage(text: string): boolean {
  return /压缩完成|无需压缩|未获收益|compaction\s*complete|no\s*compaction|gained\s*nothing|compact(ion)?\s*fail/i.test(
    text || '',
  );
}

function stripCompactDecorators(text: string): string {
  return (text || '')
    .replace(/^[✓✗ℹ️ℹ■◆⚡▸●○◇[~\]\s]+/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** StatusLine / ToolCard 前缀词 — 避免再拼一次导致 "Compact Compact" */
export function compactLabel(): string {
  return isZh() ? '压缩' : 'Compact';
}

/**
 * StatusLine 单行：前缀 + 电量条 + 阶段（中文界面全中文）。
 * 已有 bar 的原文原样返回。
 */
export function buildCompactStatusLine(text: string, details?: string): string {
  const raw = text || '';
  if (/\[[^\]]*[▰▱█░#.]/.test(raw) && /^(压缩|Compact)\s+\[/i.test(raw.trim())) {
    return raw;
  }

  const label = compactLabel();
  if (isCompactTerminalMessage(raw)) {
    return stripCompactDecorators(raw) || raw;
  }

  const progress = parseCompactProgress(raw, details);
  if (progress) {
    const phase = isZh()
      ? (/摘要|summar/i.test(`${raw} ${details || ''}`) ? ' 生成摘要…'
        : /保存|sav/i.test(raw) ? ' 保存中…' : '')
      : (/摘要|summar/i.test(`${raw} ${details || ''}`) ? ' summarizing…'
        : /保存|sav/i.test(raw) ? ' saving…' : '');
    return `${label} ${formatCompactBatteryBar(progress.completed, progress.total)}${phase}`;
  }

  const blob = `${raw} ${details || ''}`;
  if (/分析|categor|分组|started|starting|manual\s*compact|auto-?compact|压缩前|压缩方式|准备/i.test(blob)) {
    return `${label} ${formatCompactBatteryBar(0, 0)} ${isZh() ? '准备中…' : 'preparing…'}`;
  }
  if (/保存|saving/i.test(blob)) {
    return `${label} ${formatCompactBatteryBar(1, 1)} ${isZh() ? '保存中…' : 'saving…'}`;
  }

  const phase = stripCompactDecorators(raw);
  return phase
    ? `${label} ${formatCompactBatteryBar(0, 0)} ${phase}`
    : `${label} ${formatCompactBatteryBar(0, 0)} …`;
}

/**
 * Timeline 卡片正文 — 不要带 "压缩/Compact" 前缀（ToolCard 自己有 prefix）。
 */
export function buildCompactCardText(text: string, details?: string): string {
  const raw = text || '';
  if (isCompactTerminalMessage(raw)) {
    // "压缩未获收益" → "未获收益", 避免 "压缩 压缩未获收益"
    return stripCompactDecorators(raw)
      .replace(/^(压缩|Compact)\s*/i, '')
      .trim() || (isZh() ? '完成' : 'done');
  }

  const progress = parseCompactProgress(raw, details);
  if (progress) {
    const phase = isZh()
      ? (/摘要|summar/i.test(`${raw} ${details || ''}`) ? '生成摘要' : '进行中')
      : (/摘要|summar/i.test(`${raw} ${details || ''}`) ? 'summarizing' : 'compacting');
    return `${formatCompactBatteryBar(progress.completed, progress.total)} ${phase}`;
  }

  const blob = `${raw} ${details || ''}`;
  if (/分析|categor|分组|started|starting|manual\s*compact|auto-?compact|压缩前|压缩方式|准备/i.test(blob)) {
    return `${formatCompactBatteryBar(0, 0)} ${isZh() ? '准备中…' : 'preparing…'}`;
  }
  if (/保存|saving/i.test(blob)) {
    return `${formatCompactBatteryBar(1, 1)} ${isZh() ? '保存中…' : 'saving…'}`;
  }

  return stripCompactDecorators(raw).replace(/^(压缩|Compact)\s*/i, '').trim()
    || (isZh() ? '进行中…' : 'Compacting…');
}
