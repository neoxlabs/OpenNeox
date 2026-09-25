/**
 * quote-page — 引言 / 金句页.
 *
 * 视觉架构 (Neox PDS):
 *   accentBar (装饰) + 大字引文 (h1) + 归属 (caption) + pageNumber
 *   居中垂直排布, 上下留大量白空间, 视觉呼吸.
 */

import type { Presentation } from '../builder/index.js';
import {
  accentBar, sectionTitle, caption, pageNumber, footer,
} from '../design/primitives.js';
import { WARM_EDITORIAL, PAGE, SPACE, RADII, type NeoxTheme } from '../design/tokens.js';

export const meta = {
  id: 'quote-page',
  category: 'emphasis',
  useWhen: 'testimonial, key message, chapter closing thought, editorial breakpoint',
  avoidWhen: 'content-heavy slide, data',
  slots: {
    quote: { required: true, maxChars: 120 },
    attribution: { required: false, maxChars: 40, note: '"— 姓名, 头衔" 格式' },
    kicker: { required: false, maxChars: 40 },
    pageNumber: { required: false },
    footerText: { required: false },
  },
  typographyBudget: { quotePt: 32, attribPt: 14 },
  densityBudget: 'low',
} as const;

export interface QuotePageSlots {
  quote: string;
  attribution?: string;
  kicker?: string;
  pageNumber?: string | number;
  footerText?: string;
  theme?: NeoxTheme;
}

export function quotePage(ppt: Presentation, slots: QuotePageSlots) {
  const theme = slots.theme ?? WARM_EDITORIAL;
  const W = ppt.model.slideWidth / 9525;
  const H = ppt.model.slideHeight / 9525;

  const slide = ppt.slides.add();
  slide.background.fill = theme.palette.paper;

  const contentW = W * 0.7;
  const contentL = (W - contentW) / 2;
  const centerY = H * 0.4;

  /* 顶部装饰: 短 accent bar 居中 */
  accentBar(slide,
    { l: (W - 48) / 2, t: centerY - 100, w: 48, h: 4 },
    { theme },
  );

  /* 引文正文 (作为 sectionTitle, 但不显 bar) */
  sectionTitle(slide, slots.quote,
    { l: contentL, t: centerY - 60, w: contentW, h: 160 },
    { theme, showBar: false },
  );

  /* 归属 */
  if (slots.attribution) {
    caption(slide, slots.attribution,
      { l: contentL, t: centerY + 120, w: contentW, h: 24 },
      { theme, color: theme.palette.muted },
    );
  }

  if (slots.footerText) {
    footer(slide, { width: W, height: H }, { left: slots.footerText, theme });
  }
  if (slots.pageNumber != null) {
    pageNumber(slide, slots.pageNumber, { width: W, height: H }, { theme });
  }

  void SPACE;
  void RADII;
  return slide;
}
