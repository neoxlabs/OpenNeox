/**
 * 品牌 spinner —— 三片叶子绕圈转, 呼应 vortex mark。
 *
 * 2 格宽的盲文点阵 (4×4 点): 外圈 12 个点位, 3 片叶子各占 2 点、间隔 2 点, 每帧顺时针走一格;
 * 颜色沿 mark 的紫→蓝渐变来回流。只用盲文 (U+2800 段), 各平台字体都有, Windows 也不用降级。
 */
import React, { useEffect, useState } from 'react';
import { Text } from '../../../vendor/ink/src/index.js';
import { NeoxTheme } from '../theme.js';

/* 外圈点位, 顺时针从左上角开始 */
const RING: Array<[number, number]> = [
  [0, 0], [1, 0], [2, 0], [3, 0], [3, 1], [3, 2], [3, 3], [2, 3], [1, 3], [0, 3], [0, 2], [0, 1],
];
const BRAILLE_BIT = [[0x1, 0x8], [0x2, 0x10], [0x4, 0x20], [0x40, 0x80]];

function frameGlyph(step: number): string {
  const cells = [0, 0];
  for (let blade = 0; blade < 3; blade++) {
    for (let k = 0; k < 2; k++) {
      const [x, y] = RING[(step + blade * 4 + k) % RING.length]!;
      cells[x >> 1]! |= BRAILLE_BIT[y]![x & 1]!;
    }
  }
  return String.fromCharCode(0x2800 + cells[0]!) + String.fromCharCode(0x2800 + cells[1]!);
}

/* 三重对称: 走 4 格就回到原样 */
export const VORTEX_SPINNER_FRAMES = [0, 1, 2, 3].map(frameGlyph);

export const VortexSpinner: React.FC<{ interval?: number }> = ({ interval = 110 }) => {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), interval);
    return () => clearInterval(id);
  }, [interval]);
  const g = NeoxTheme.logoGradient;
  /* 颜色来回流 (ping-pong), 不从蓝跳回紫 */
  const span = g.length - 1;
  const pos = Math.floor(tick / 2) % (span * 2);
  const color = g[pos <= span ? pos : span * 2 - pos]!;
  return <Text color={color}>{VORTEX_SPINNER_FRAMES[tick % VORTEX_SPINNER_FRAMES.length]}</Text>;
};
