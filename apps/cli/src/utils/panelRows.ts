/**
 * 文本面板 (/stats /ps /help 等 commandOutput 输出) 的统一行格式:
 *   粗体标题 + 灰色副标题
 *   两格缩进 · 灰色标签 (按显示宽度补齐, 中文占 2 列) · 值
 * 跟 /usage 面板和 hero 信息区同一种排法, 别再各写各的 "Key:   value"。
 */
import stringWidth from 'string-width';
import chalk from 'chalk';
import { colors } from '../constants.js';
import { NeoxTheme } from '../ink/theme.js';

export const LABEL_COLS = 10;

export function panelTitle(title: string, sub?: string): string {
  return `  \x1b[1m${title}\x1b[22m${sub ? `  ${colors.dim(sub)}` : ''}`;
}

/** 10 格进度条 ▰▰▱▱▱▱▱▱▱▱ 32% —— 70% 起琥珀, 90% 起红; 跟底栏上下文条同一个样子 */
export function meterBar(percent: number): string {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  const n = Math.round(p / 10);
  const c = p >= 90 ? NeoxTheme.functional.error : p >= 70 ? NeoxTheme.functional.warning : NeoxTheme.brand.blue;
  const paint = (hex: string, s: string) => (hex.startsWith('#') ? chalk.hex(hex)(s) : (chalk as any)[hex]?.(s) ?? s);
  return paint(c, '▰'.repeat(n)) + paint(NeoxTheme.text.faint, '▱'.repeat(10 - n)) + ' ' + (p >= 70 ? paint(c, `${p}%`) : `${p}%`);
}

export function panelRow(label: string, value: string, labelCols = LABEL_COLS): string {
  const pad = Math.max(1, labelCols - stringWidth(label));
  return `  ${colors.dim(label + ' '.repeat(pad))}${value}`;
}
