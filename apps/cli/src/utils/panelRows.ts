/**
 * 文本面板 (/stats /ps /help 等 commandOutput 输出) 的统一行格式:
 *   粗体标题 + 灰色副标题
 *   两格缩进 · 灰色标签 (按显示宽度补齐, 中文占 2 列) · 值
 * 跟 /usage 面板和 hero 信息区同一种排法, 别再各写各的 "Key:   value"。
 */
import stringWidth from 'string-width';
import { colors } from '../constants.js';

export const LABEL_COLS = 10;

export function panelTitle(title: string, sub?: string): string {
  return `  \x1b[1m${title}\x1b[22m${sub ? `  ${colors.dim(sub)}` : ''}`;
}

export function panelRow(label: string, value: string, labelCols = LABEL_COLS): string {
  const pad = Math.max(1, labelCols - stringWidth(label));
  return `  ${colors.dim(label + ' '.repeat(pad))}${value}`;
}
