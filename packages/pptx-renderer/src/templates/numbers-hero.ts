/**
 * numbers-hero — 3-4 个大数字并列 hero · 比 kpi-cards 更"震撼"更"简洁".
 *
 * 视觉架构 (Neox PDS):
 *   kicker + 一句 headline + 3-4 个数字横排 (每个数字很大 · label 小 · 整片 slide 就为了这几个数字).
 *   跟 kpi-cards 区别: 这里没有卡片背景, 视觉更 flat editorial, 更适合 hero 页.
 *
 * 何时用: 业绩汇报 hero 页 · 品牌数字宣言 · 数据震撼开场
 * 何时不用: 单个数字 (用 data-focus) · 需要 sublabel/细节 (用 kpi-cards)
 */

import type { Presentation } from '../builder/index.js';
import { kicker, footer, pageNumber } from '../design/primitives.js';
import { WARM_EDITORIAL, PAGE, SPACE, type NeoxTheme } from '../design/tokens.js';

export const meta = {
  id: 'numbers-hero',
  category: 'metrics',
  useWhen: 'hero page with 3-4 headline numbers, brand stats declaration, opening stats',
  avoidWhen: 'single number (use data-focus), needs sublabels (use kpi-cards)',
  slots: {
    kicker: { required: false, maxChars: 30 },
    headline: { required: false, maxChars: 40, note: '一句 headline · 放数字上方' },
    numbers: {
      required: true, minItems: 3, maxItems: 4,
      kind: '[{value, label}]',
      note: 'value ≤ 6 字符 (含单位) · label ≤ 12 字',
    },
    pageNumber: { required: false },
    footerText: { required: false },
  },
  typographyBudget: { headlinePt: 24, valuePt: 88, labelPt: 14 },
  densityBudget: 'low',
} as const;

export interface NumbersHeroSlots {
  kicker?: string;
  headline?: string;
  numbers: Array<{ value: string; label: string }>;
  pageNumber?: string | number;
  footerText?: string;
  theme?: NeoxTheme;
}

export function numbersHero(ppt: Presentation, slots: NumbersHeroSlots) {
  const theme = slots.theme ?? WARM_EDITORIAL;
  const W = ppt.model.slideWidth / 9525;
  const H = ppt.model.slideHeight / 9525;

  const slide = ppt.slides.add();
  slide.background.fill = theme.palette.paper;

  let cursorY = PAGE.padTop;

  if (slots.kicker) {
    kicker(slide, slots.kicker, { l: PAGE.padH, t: cursorY, w: W - PAGE.padH * 2, h: 20 }, { theme });
    cursorY += SPACE.xl;
  }

  if (slots.headline) {
    slide.shapes.addText(slots.headline, {
      left: PAGE.padH, top: cursorY, width: W - PAGE.padH * 2, height: 40,
    }, {
      fontSize: 24,
      color: theme.palette.ink,
      fontLatin: theme.fonts.displayLatin,
      fontEast: theme.fonts.displayEast,
    });
    cursorY += 40 + SPACE.xxl;
  } else {
    cursorY += SPACE.xxl;
  }

  const n = slots.numbers.length;
  const availW = W - PAGE.padH * 2;
  const gap = PAGE.gutter;
  const colW = (availW - gap * (n - 1)) / n;
  const valueH = 120;
  const numY = (H - valueH - 60 - cursorY) / 2 + cursorY;

  slots.numbers.forEach((num, i) => {
    const x = PAGE.padH + i * (colW + gap);

    /* value · 大数字 · numeric 等宽 · accent 色 */
    slide.shapes.addText(num.value, {
      left: x, top: numY, width: colW, height: valueH,
    }, {
      fontSize: 88,
      bold: true,
      color: theme.palette.accent,
      letterSpacingPt: -1.5,
      fontLatin: theme.fonts.numeric,
      fontEast: theme.fonts.displayEast,
    });

    /* label 下面 · muted 色 */
    slide.shapes.addText(num.label, {
      left: x, top: numY + valueH + SPACE.s, width: colW, height: 30,
    }, {
      fontSize: 14,
      color: theme.palette.muted,
      letterSpacingPt: 0.3,
      fontLatin: theme.fonts.textLatin,
      fontEast: theme.fonts.textEast,
    });

    /* 每个数字下方一根短 accent · 视觉锚点 */
    slide.shapes.add({
      geometry: 'rect',
      position: { left: x, top: numY + valueH + 44, width: 28, height: 2 },
      fill: theme.palette.accent,
    });
  });

  if (slots.footerText) {
    footer(slide, { width: W, height: H }, { left: slots.footerText, theme });
  }
  if (slots.pageNumber != null) {
    pageNumber(slide, slots.pageNumber, { width: W, height: H }, { theme });
  }

  return slide;
}
