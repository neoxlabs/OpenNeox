/**
 * 一轮结束那条淡线的文字 (陶土稿): 「2:41 · 输入 38.2k · 输出 2.1k · $0.21」
 * 两侧的 ── 由渲染端按终端宽度补。没干什么的轮 (没有用量) 返回 null, 不画线。
 */
import { L } from '../../i18n/index.js';
import { formatCost } from '@neoxlabs/platform/platform/modelPricingTable.js';
import { formatTtft } from '../../utils/turnPerf.js';

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}

/* ttftMs: 这一轮的首字延迟 (run_result.iterationPerf, 见 utils/turnPerf)。
 * 没测到就 不写这一段 —— 不拿 0 充数。 */
export function formatTurnEndLine(durationMs: number, input: number, output: number, costUsd: number, ttftMs?: number | null): string | null {
  if (input <= 0 && output <= 0) return null;
  const parts = [clock(durationMs)];
  if (typeof ttftMs === 'number') parts.push(L(`首字 ${formatTtft(ttftMs)}`, `ttft ${formatTtft(ttftMs)}`));
  parts.push(L(`输入 ${tokens(input)}`, `in ${tokens(input)}`), L(`输出 ${tokens(output)}`, `out ${tokens(output)}`));
  if (costUsd > 0.00005) parts.push(formatCost(costUsd));
  return parts.join(' · ');
}
