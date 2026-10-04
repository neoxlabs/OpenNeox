/**
 * 品牌渐变进度条 —— 已完成的格子沿 mark 的紫→蓝渐变着色, 未完成的灰。
 * 用在压缩等"有真实进度"的过程上 (不装匀速: 进度只随真实阶段推进)。
 *
 * 输入沿用 compactProgress 的电量条文本 "[▰▰▰▱▱▱▱▱▱▱] 30% 1/4 …" —— 不另起一套进度协议。
 */
import React from 'react';
import { Text } from '../../../vendor/ink/src/index.js';
import { NeoxTheme } from '../theme.js';

const FILLED = /[▰█#]/;

/** 拆 "[▰▰▱▱] 50% 1/2 summarizing" → 格子串 + 尾巴; 不是这个格式返回 null */
export function splitBatteryText(text: string): { cells: string; rest: string } | null {
  const m = /^\s*\[([^\]]*)\]\s*(.*)$/s.exec(text || '');
  if (!m) return null;
  return { cells: m[1]!, rest: m[2]!.trim() };
}

export const GradientBar: React.FC<{ cells: string }> = ({ cells }) => {
  const g = NeoxTheme.logoGradient;
  const chars = [...cells];
  return (
    <Text>
      {chars.map((ch, i) => (
        <Text
          key={i}
          color={FILLED.test(ch) ? g[Math.round((i / Math.max(1, chars.length - 1)) * (g.length - 1))] : NeoxTheme.text.dim}
        >{ch}</Text>
      ))}
    </Text>
  );
};
