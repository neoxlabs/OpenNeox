/**
 * data-focus — 一个巨大数字 + 一段故事. 单点数据 hero 页.
 *
 * 视觉架构 (Neox PDS):
 *   kicker + 巨大数字 (numeric font · 120pt · accent 色) + 数字上方 label + 下方 一段解释
 *   非常单一焦点 · 观众只需要记住"那个数字" · 效果远超挤 4 个 KPI 卡.
 *
 * 何时用: 有一个足够震撼的单点数据 · 汇报里想"钉一根数字进观众脑"
 * 何时不用: 有 3 个以上要比的数字 (用 kpi-cards) · 数据背后是长故事 (用 title-body)
 */

import type { Presentation } from '../builder/index.js';
import { kicker, footer, pageNumber } from '../design/primitives.js';
import { WARM_EDITORIAL, TYPE, PAGE, SPACE, textMetrics, type NeoxTheme } from '../design/tokens.js';

export const meta = {
  id: 'data-focus',
  category: 'metrics',
  useWhen: 'single hero number, one shocking stat, headline metric, business milestone',
  avoidWhen: 'multiple KPIs (use kpi-cards), narrative content',
  slots: {
    kicker: { required: false, maxChars: 30 },
    label: { required: false, maxChars: 30, note: '数字上方小字标签, e.g. "总收入"' },
    number: { required: true, maxChars: 10, note: '主数字 · 建议 <= 8 字符 (含单位), 太长会溢出' },
    unit: { required: false, maxChars: 8, note: '数字后缀单位, e.g. "亿"/"%". 会用较小字号并列' },
    story: { required: true, maxCharsPerItem: 220, note: '数字下方一段故事 · 解释数字 · string 或 string[]' },
    pageNumber: { required: false },
    footerText: { required: false },
  },
  typographyBudget: { numberPt: 140, labelPt: 16, unitPt: 40, storyPt: 18 },
  densityBudget: 'low',
} as const;

export interface DataFocusSlots {
  kicker?: string;
  label?: string;
  number: string;
  unit?: string;
  story: string | string[];
  pageNumber?: string | number;
  footerText?: string;
  theme?: NeoxTheme;
}

export function dataFocus(ppt: Presentation, slots: DataFocusSlots) {
  const theme = slots.theme ?? WARM_EDITORIAL;
  const W = ppt.model.slideWidth / 9525;
  const H = ppt.model.slideHeight / 9525;

  const slide = ppt.slides.add();
  slide.background.fill = theme.palette.paper;

  let cursorY = PAGE.padTop;

  if (slots.kicker) {
    kicker(slide, slots.kicker,
      { l: PAGE.padH, t: cursorY, w: W - PAGE.padH * 2, h: 20 },
      { theme, color: theme.palette.accent },
    );
    cursorY += SPACE.xl;
  }

  /* label · 数字上方小字, 常用于"这个数字是啥" (总收入/UV/日活等) */
  if (slots.label) {
    slide.shapes.addText(slots.label, { left: PAGE.padH, top: cursorY, width: W - PAGE.padH * 2, height: 24 }, {
      fontSize: 16,
      color: theme.palette.muted,
      letterSpacingPt: 0.5,
      fontLatin: theme.fonts.textLatin,
      fontEast: theme.fonts.textEast,
    });
    cursorY += 32;
  }

  /* 主数字 · 巨大 · 走 numeric font (等宽 tabular figures) · accent 深色.
   * unit 拼在同一个 textrun 里, 让引擎自己布局 · 避免手算宽度. */
  const numberH = 180;
  const numberWithUnit = slots.unit ? `${slots.number}${slots.unit}` : slots.number;
  slide.shapes.addText(numberWithUnit, { left: PAGE.padH, top: cursorY, width: W - PAGE.padH * 2, height: numberH }, {
    fontSize: 140,
    bold: true,
    color: theme.palette.accent,
    letterSpacingPt: -2,
    fontLatin: theme.fonts.numeric,
    fontEast: theme.fonts.displayEast,
  });
  cursorY += numberH + SPACE.xl;

  /* accent bar · 数字与故事之间视觉隔断 */
  slide.shapes.add({
    geometry: 'rect',
    position: { left: PAGE.padH, top: cursorY, width: 72, height: 4 },
    fill: theme.palette.accent,
  });
  cursorY += SPACE.l;

  /* story 段落使用 pt 到 CSS px 的统一换算。 */
  const stories = Array.isArray(slots.story) ? slots.story : [slots.story];
  const storyY = cursorY;
  const storyH = H - storyY - PAGE.padBottom - SPACE.m;
  const { lineH, charWidth } = textMetrics(18, { charKind: 'mixed' });
  const perLine = Math.max(1, Math.floor((W - PAGE.padH * 2) / charWidth));
  let cy = storyY;
  const maxY = storyY + storyH;

  stories.forEach((para, i) => {
    if (!para.trim()) return;
    if (cy >= maxY - lineH) return;
    const lines = Math.max(1, Math.ceil(para.length / perLine));
    const paraH = Math.min(lines * lineH + 8, maxY - cy);
    slide.shapes.addText(para, { left: PAGE.padH, top: cy, width: W - PAGE.padH * 2, height: paraH }, {
      fontSize: 18,
      color: theme.palette.ink,
      fontLatin: theme.fonts.textLatin,
      fontEast: theme.fonts.textEast,
    });
    cy += paraH + (i < stories.length - 1 ? SPACE.m : 0);
  });

  if (slots.footerText) {
    footer(slide, { width: W, height: H }, { left: slots.footerText, theme });
  }
  if (slots.pageNumber != null) {
    pageNumber(slide, slots.pageNumber, { width: W, height: H }, { theme });
  }

  void TYPE;
  return slide;
}
