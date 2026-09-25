/**
 * contrast — 明显不对称对比页 · 一深一浅 · 一大一小 · 强对立感.
 *
 * 视觉架构 (Neox PDS):
 *   左半深色 (ink 底) 右半 paper 底. 左边一句"before / 传统", 右边一句"after / 现代".
 *   比 twoColumn 更**戏剧化**, 一眼看出对立. 强适合"新旧对比" / "问题→答案".
 *
 * 何时用: 前后对比 · 传统 vs 创新 · 问题 vs 方案 · 数据前后
 * 何时不用: 平级两点 (用 two-column) · 三点及以上 (用 three-column)
 */

import type { Presentation } from '../builder/index.js';
import { kicker, footer, pageNumber } from '../design/primitives.js';
import { WARM_EDITORIAL, PAGE, TYPE, SPACE, type NeoxTheme } from '../design/tokens.js';

export const meta = {
  id: 'contrast',
  category: 'comparison',
  useWhen: 'before/after, traditional vs innovative, problem vs solution, dramatic contrast',
  avoidWhen: 'flat comparison (use two-column), three or more items',
  slots: {
    left: {
      required: true,
      kind: '{ label, headline, body? }',
      note: 'label ≤ 12 字 (BEFORE / 传统 / 问题), headline ≤ 20 字, body ≤ 100 字',
    },
    right: {
      required: true,
      kind: '{ label, headline, body? }',
      note: 'label ≤ 12 字 (AFTER / 现代 / 方案), headline ≤ 20 字, body ≤ 100 字',
    },
    pageNumber: { required: false },
    footerText: { required: false },
  },
  typographyBudget: { headlinePt: 32, labelPt: 12, bodyPt: 16 },
  densityBudget: 'medium',
} as const;

interface ContrastSide {
  label: string;
  headline: string;
  body?: string | string[];
}
export interface ContrastSlots {
  left: ContrastSide;
  right: ContrastSide;
  pageNumber?: string | number;
  footerText?: string;
  theme?: NeoxTheme;
}

export function contrast(ppt: Presentation, slots: ContrastSlots) {
  const theme = slots.theme ?? WARM_EDITORIAL;
  const W = ppt.model.slideWidth / 9525;
  const H = ppt.model.slideHeight / 9525;

  const slide = ppt.slides.add();

  const halfW = W / 2;

  /* 左半 · 深底 · 白字 */
  slide.shapes.add({
    geometry: 'rect',
    position: { left: 0, top: 0, width: halfW, height: H },
    fill: theme.palette.ink,
  });
  /* 装饰 · 左半竖 accent bar */
  slide.shapes.add({
    geometry: 'rect',
    position: { left: 40, top: 40, width: 4, height: H * 0.4 },
    fill: theme.palette.accent,
  });

  /* 右半 · paper 底, 让 slide.background 自动填 · 只加装饰 */
  slide.background.fill = theme.palette.paper;

  /* 左侧 · label + headline + body */
  const leftX = 72;
  const leftW = halfW - 144;
  const contentY = H * 0.34;

  slide.shapes.addText(slots.left.label.toUpperCase(), {
    left: leftX, top: contentY - 40, width: leftW, height: 20,
  }, {
    fontSize: 12, bold: true,
    color: theme.palette.accent,
    letterSpacingPt: 2.4,
    fontLatin: theme.fonts.textLatin,
    fontEast: theme.fonts.textEast,
  });

  slide.shapes.addText(slots.left.headline, {
    left: leftX, top: contentY, width: leftW, height: 100,
  }, {
    fontSize: TYPE.h1.fontSize,
    bold: true,
    color: '#FFFFFF',
    fontLatin: theme.fonts.displayLatin,
    fontEast: theme.fonts.displayEast,
  });

  if (slots.left.body) {
    const leftBody = Array.isArray(slots.left.body) ? slots.left.body.join('\n') : slots.left.body;
    slide.shapes.addText(leftBody, {
      left: leftX, top: contentY + 110, width: leftW, height: 160,
    }, {
      fontSize: 16,
      color: '#F1F5F9',
      fontLatin: theme.fonts.textLatin,
      fontEast: theme.fonts.textEast,
    });
  }

  /* 右侧 · 同结构 · 深色字 */
  const rightX = halfW + 72;
  const rightW = halfW - 144;

  slide.shapes.addText(slots.right.label.toUpperCase(), {
    left: rightX, top: contentY - 40, width: rightW, height: 20,
  }, {
    fontSize: 12, bold: true,
    color: theme.palette.accent,
    letterSpacingPt: 2.4,
    fontLatin: theme.fonts.textLatin,
    fontEast: theme.fonts.textEast,
  });

  slide.shapes.addText(slots.right.headline, {
    left: rightX, top: contentY, width: rightW, height: 100,
  }, {
    fontSize: TYPE.h1.fontSize,
    bold: true,
    color: theme.palette.ink,
    fontLatin: theme.fonts.displayLatin,
    fontEast: theme.fonts.displayEast,
  });

  if (slots.right.body) {
    const rightBody = Array.isArray(slots.right.body) ? slots.right.body.join('\n') : slots.right.body;
    slide.shapes.addText(rightBody, {
      left: rightX, top: contentY + 110, width: rightW, height: 160,
    }, {
      fontSize: 16,
      color: theme.palette.ink,
      fontLatin: theme.fonts.textLatin,
      fontEast: theme.fonts.textEast,
    });
  }

  /* 中间强 divider · 深色 accent 竖线 */
  slide.shapes.add({
    geometry: 'rect',
    position: { left: halfW - 1, top: H * 0.15, width: 2, height: H * 0.7 },
    fill: theme.palette.accent,
  });

  if (slots.footerText) {
    footer(slide, { width: W, height: H }, { left: slots.footerText, theme });
  }
  if (slots.pageNumber != null) {
    pageNumber(slide, slots.pageNumber, { width: W, height: H }, { theme });
  }

  void kicker;
  void SPACE;
  return slide;
}
