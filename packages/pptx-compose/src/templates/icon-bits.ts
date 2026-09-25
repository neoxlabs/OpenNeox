/**
 * icon-bits — 语义图标系统.
 *
 * Icons are semantic markers: each icon must correspond to a distinction in
 * the content rather than an arbitrary item index.
 *
 * Linear icons use custom paths with `strokeOnly` and an explicit border;
 * the border supplies the visible line and keeps stroke weight consistent.
 */

import type { ComposeNode } from '../compose/types.js';
import { ZStack, Shape } from '../compose/dsl.js';
import { activeTheme, activeSpec } from './theme.js';
import { withAlpha, bestTextOn } from './motif-bits.js';
import { slabPath } from './diagram-bits.js';
import { TABLER_ICONS } from './icons.generated.js';

/* ============================================================
 * 图标路径 —— 统一 24×24 viewBox · 全部按**描边**设计
 * ============================================================
 * 按线性而不是实心剪影画, 是因为剪影在小尺寸下糊成一团黑块, 而且和版面上
 * 已有的实色图示 (箭头链/金字塔) 抢分量 —— 图标是标签, 不该比它标注的内容更重。
 *
 * 每条 d 可以含多段子路径 (M 开头), 一个 Shape 就画完一个图标。
 */
/**
 * The icon map uses the bundled Tabler paths so semantic names share a
 * consistent visual vocabulary.
 *
 * 语义名仍然是我们自己的 (warning / truck / gear …), 不暴露 Tabler 的文件名:
 * 语义名是**我们对内容的分类**, 和某个图标库的命名习惯是两件事; 将来换库或
 * 换某个图标的画法, deckTools / SKILL / 调用方都不该受影响。
 * 映射表和烘焙脚本在 scripts/bake-icons.mjs。
 */
const ICONS = TABLER_ICONS;

export type IconName = keyof typeof ICONS;

/** 图标清单 —— agent 和文档共用同一份, 免得文档列的名字引擎里没有 */
export const ICON_NAMES = Object.keys(ICONS) as IconName[];

export function hasIcon(name: string): name is IconName {
  return Object.prototype.hasOwnProperty.call(ICONS, name);
}

/* ============================================================
 * iconMark —— 图标 + 底板
 * ============================================================ */

export interface IconMarkOptions {
  /** 底板尺寸 px, 默认 56 */
  size?: number;
  /** 画在深底上 (底板和线色要反过来) */
  onDark?: boolean;
  /**
   * 底板样式. 默认按风格挑:
   *   solid 实色底板 + 白线 (稻壳观感, 分量重)
   *   soft 淡色底板 + accent 线 (克制)
   *   none 只有线, 没有底板 (line 风格)
   */
  tone?: 'solid' | 'soft' | 'none';
}

function defaultTone(): 'solid' | 'soft' | 'none' {
  switch (activeSpec()?.motif ?? 'none') {
    case 'line': return 'none';      /* 细线风格塞一排实色方块就毁了 */
    case 'capsule': return 'soft';
    default: return 'solid';
  }
}

function plateRadius(size: number): number {
  switch (activeSpec()?.motif ?? 'none') {
    case 'capsule': return Math.round(size * 0.5);  /* 正圆 */
    case 'ribbon': return 2;
    case 'chevron': return Math.round(size * 0.16);
    default: return Math.round(size * 0.22);
  }
}

/**
 * iconGlyph —— 只要图标本身 (一个叶子 Shape), 不带底板。
 *
 * Return the glyph as a leaf node so callers can position it with padding
 * without applying container insets to the explicit icon dimensions.
 */
export function iconGlyph(name: IconName, opts?: {
  size?: number; color?: string; padding?: { top: number; left: number };
}): ComposeNode {
  const t = activeTheme();
  const size = opts?.size ?? 32;
  const color = opts?.color ?? t.accent;
  return Shape({
    geometry: 'custom', width: size, height: size, fill: color,
    customPath: { d: ICONS[name], viewBox: { width: 24, height: 24 }, strokeOnly: true },
    border: { color, width: Math.max(1.5, Math.round(size / 16 * 10) / 10) },
    ...(opts?.padding
      ? { padding: { top: opts.padding.top, left: opts.padding.left, right: 0, bottom: 0 } }
      : {}),
  });
}

/**
 * 一个语义图标。**只在图标和内容有真实对应关系时用** ——
 * 没想到该配哪个就别配, 硬凑一个等于告诉观众一个不存在的意思。
 */
export function iconMark(name: IconName, opts?: IconMarkOptions): ComposeNode {
  const t = activeTheme();
  const size = opts?.size ?? 56;
  const tone = opts?.tone ?? defaultTone();
  const d = ICONS[name];

  /* 图标本体占底板的 56% —— 再大就顶到底板边缘, 一排看下来像挤在框里 */
  const iconD = Math.round(size * (tone === 'none' ? 0.86 : 0.56));
  const off = Math.round((size - iconD) / 2);

  const lineColor = tone === 'solid'
    ? (opts?.onDark ? t.ink : bestTextOn(t.accent))
    : t.accent;

  const layers: ComposeNode[] = [];

  if (tone !== 'none') {
    layers.push(Shape({
      geometry: 'custom', width: size, height: size,
      fill: tone === 'solid' ? t.accent : withAlpha(t.accent, opts?.onDark ? 0.26 : 0.14),
      customPath: slabPath(size, size, plateRadius(size)),
    }));
  }

  /* Pair strokeOnly with a border; the minimum width keeps the outline visible
   * at presentation scale. */
  layers.push(Shape({
    geometry: 'custom', width: iconD, height: iconD,
    fill: lineColor,
    customPath: { d, viewBox: { width: 24, height: 24 }, strokeOnly: true },
    border: { color: lineColor, width: Math.max(1.6, Math.round(iconD / 16 * 10) / 10) },
    padding: { top: off, left: off, right: 0, bottom: 0 },
  }));

  return ZStack({ align: 'start', width: size, height: size }, layers);
}
