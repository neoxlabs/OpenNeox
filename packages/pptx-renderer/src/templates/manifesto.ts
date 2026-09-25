/**
 * manifesto — 极大字宣言页. 一句话, 十几个字, 一整片 slide 全给它.
 *
 * 视觉架构 (Neox PDS):
 *   居中 · 巨大 (80pt · manifesto TYPE) · 显示衬线体 · 顶部 kicker · 底部 attribution.
 *   完全空旷 · 除了这一句话什么都不需要 · 观众看这一片 slide 只该读它一次.
 *
 * 何时用: 品牌宣言 · 章节收尾金句 · 结果 payoff 页 · 重要观点
 * 何时不用: 有数据 · 有图 · 有多个要点
 */

import type { Presentation } from '../builder/index.js';
import { kicker, pageNumber } from '../design/primitives.js';
import { WARM_EDITORIAL, TYPE, PAGE, type NeoxTheme } from '../design/tokens.js';

export const meta = {
  id: 'manifesto',
  category: 'emphasis',
  useWhen: 'brand manifesto, section closing statement, payoff, single-message page',
  avoidWhen: 'data, comparison, multiple points',
  slots: {
    text: { required: true, maxChars: 30, note: '一句话核心宣言, 极短' },
    kicker: { required: false, maxChars: 20 },
    attribution: { required: false, maxChars: 30, note: '出处/署名' },
    pageNumber: { required: false },
  },
  typographyBudget: { textPt: 80, kickerPt: 12, attribPt: 14 },
  densityBudget: 'low',
} as const;

export interface ManifestoSlots {
  text: string;
  kicker?: string;
  attribution?: string;
  pageNumber?: string | number;
  theme?: NeoxTheme;
}

export function manifesto(ppt: Presentation, slots: ManifestoSlots) {
  const theme = slots.theme ?? WARM_EDITORIAL;
  const W = ppt.model.slideWidth / 9525;
  const H = ppt.model.slideHeight / 9525;

  const slide = ppt.slides.add();
  slide.background.fill = theme.palette.paper;

  /* kicker · 顶部 */
  if (slots.kicker) {
    kicker(slide, slots.kicker,
      { l: PAGE.padH, t: PAGE.padTop, w: W - PAGE.padH * 2, h: 20 },
      { theme, color: theme.palette.accent, align: 'ctr' },
    );
  }

  /* 巨大文字 · manifesto TYPE (80pt) · display 衬线 · 居中 */
  const textH = 260;
  slide.shapes.addText(slots.text, {
    left: PAGE.padH,
    top: H / 2 - textH / 2,
    width: W - PAGE.padH * 2,
    height: textH,
  }, {
    fontSize: TYPE.manifesto.fontSize,
    bold: true,
    color: theme.palette.ink,
    letterSpacingPt: -1,
    fontLatin: theme.fonts.displayLatin,
    fontEast: theme.fonts.displayEast,
  });

  /* accent · 中心下方一根横线 */
  slide.shapes.add({
    geometry: 'rect',
    position: { left: W / 2 - 40, top: H / 2 + textH / 2 + 24, width: 80, height: 3 },
    fill: theme.palette.accent,
  });

  /* attribution · 底部 */
  if (slots.attribution) {
    slide.shapes.addText(`— ${slots.attribution}`,
      { left: PAGE.padH, top: H - PAGE.padBottom - 40, width: W - PAGE.padH * 2, height: 30 },
      {
        fontSize: 14,
        color: theme.palette.muted,
        letterSpacingPt: 0.3,
        fontLatin: theme.fonts.textLatin,
        fontEast: theme.fonts.textEast,
      });
  }

  if (slots.pageNumber != null) {
    pageNumber(slide, slots.pageNumber, { width: W, height: H }, { theme });
  }

  return slide;
}
