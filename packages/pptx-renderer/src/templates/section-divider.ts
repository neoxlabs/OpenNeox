/**
 * section-divider — 章节分节 · 大编号 + 章节标题.
 *
 * 视觉架构 (Neox PDS):
 *   深色 ink 底 + 巨型编号 (accent 色) + 章节标题 (onInk) + 副标题 (muted)
 */

import type { Presentation } from '../builder/index.js';
import { accentBar, caption } from '../design/primitives.js';
import { WARM_EDITORIAL, PAGE, SPACE, type NeoxTheme } from '../design/tokens.js';

export const meta = {
  id: 'section-divider',
  category: 'divider',
  useWhen: 'chapter break, section opener, phase transition, "Part 1/2/3" markers',
  avoidWhen: 'first slide (use cover-hero), content slide',
  slots: {
    sectionNumber: { required: true, maxChars: 4, note: '章节序号, "01" / "Part 2"' },
    title: { required: true, maxChars: 24 },
    subtitle: { required: false, maxChars: 60 },
    pageNumber: { required: false },
  },
  typographyBudget: { numberPt: 160, titlePt: 40, subPt: 16 },
  densityBudget: 'low',
} as const;

export interface SectionDividerSlots {
  sectionNumber: string;
  title: string;
  subtitle?: string;
  pageNumber?: string | number;
  theme?: NeoxTheme;
}

export function sectionDivider(ppt: Presentation, slots: SectionDividerSlots) {
  const theme = slots.theme ?? WARM_EDITORIAL;
  const W = ppt.model.slideWidth / 9525;
  const H = ppt.model.slideHeight / 9525;

  const slide = ppt.slides.add();
  slide.background.fill = theme.palette.ink;

  /* 巨型编号 · 左上区域 */
  slide.shapes.addText(slots.sectionNumber,
    { left: PAGE.padH, top: H * 0.12, width: W * 0.6, height: 200 },
    { fontFamily: theme.fonts.display, fontSize: 160, bold: true, color: theme.palette.accent },
  );

  /* 分节小 bar */
  accentBar(slide,
    { l: PAGE.padH, t: H * 0.58, w: 60, h: 4 },
    { theme },
  );

  /* 章节标题 */
  slide.shapes.addText(slots.title,
    { left: PAGE.padH, top: H * 0.62, width: W * 0.85, height: 80 },
    { fontFamily: theme.fonts.display, fontSize: 40, bold: true, color: theme.palette.onInk },
  );

  /* 副标题 */
  if (slots.subtitle) {
    caption(slide, slots.subtitle,
      { l: PAGE.padH, t: H * 0.8, w: W * 0.7, h: 40 },
      { theme, color: theme.palette.muted },
    );
  }

  /* 页码 · 右下 onInk */
  if (slots.pageNumber != null) {
    slide.shapes.addText(String(slots.pageNumber).padStart(2, '0'),
      { left: W - PAGE.padH - 40, top: H - PAGE.padBottom, width: 40, height: 24 },
      { fontFamily: theme.fonts.mono, fontSize: 11, color: theme.palette.muted, letterSpacingPt: 1 },
    );
  }

  void SPACE;
  return slide;
}
