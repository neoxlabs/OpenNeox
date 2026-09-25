/**
 * title-body — 通用标题 + 正文段落. 最常用的信息页.
 *
 * 视觉架构 (Neox PDS):
 *   kicker (可选) + sectionTitle (自带 accent bar) + bodyText 段落 + pageNumber
 *
 * 密度控制: body 用 array-of-string 分段, 每段间距 SPACE.m, 视觉不再是一大段黏在一起.
 */

import type { Presentation } from '../builder/index.js';
import { kicker, sectionTitle, bodyText, pageNumber, footer } from '../design/primitives.js';
import { WARM_EDITORIAL, PAGE, SPACE, TYPE, type NeoxTheme } from '../design/tokens.js';

export const meta = {
  id: 'title-body',
  category: 'general',
  useWhen: 'standard content slide, explanation, single-topic body text',
  avoidWhen: 'daily schedule (use timeline), photo grid (use image-gallery), data comparison',
  slots: {
    kicker: { required: false, maxChars: 40, note: '标题上方眉标, 品牌/章节名' },
    title: { required: true, maxChars: 36 },
    body: { required: true, note: 'string 或 string[] (每项一段, 段间自动加空隙)', maxItems: 6, maxCharsPerItem: 180 },
    pageNumber: { required: false },
    footerText: { required: false },
  },
  typographyBudget: { titlePt: 32, bodyPt: 16, kickerPt: 11 },
  densityBudget: 'medium',
} as const;

export interface TitleBodySlots {
  kicker?: string;
  title: string;
  body: string | string[];
  pageNumber?: string | number;
  footerText?: string;
  theme?: NeoxTheme;
}

export function titleBody(ppt: Presentation, slots: TitleBodySlots) {
  const theme = slots.theme ?? WARM_EDITORIAL;
  const W = ppt.model.slideWidth / 9525;
  const H = ppt.model.slideHeight / 9525;

  const slide = ppt.slides.add();
  slide.background.fill = theme.palette.paper;

  let cursorY = PAGE.padTop;

  /* Kicker (可选) */
  if (slots.kicker) {
    kicker(slide, slots.kicker,
      { l: PAGE.padH, t: cursorY, w: W - PAGE.padH * 2, h: 20 },
      { theme },
    );
    cursorY += SPACE.xl + 4; /* 加宽 kicker→title 呼吸 (原 28px → 36px), 避免部分 viewer 视觉贴脸 */
  }

  /* Section title + accent bar */
  sectionTitle(slide, slots.title,
    { l: PAGE.padH, t: cursorY, w: W - PAGE.padH * 2, h: 50 },
    { theme },
  );
  cursorY += 50 + SPACE.l + 8;

  /* Body 段落 · 逐段渲染, 段间 SPACE.m 间距 */
  const paragraphs = Array.isArray(slots.body) ? slots.body : [slots.body];
  const bodyLineHeight = TYPE.body.fontSize * 1.55;
  paragraphs.forEach((para, i) => {
    if (!para.trim()) return;
    /* 段落估高 = 字数 × 单字宽估算 × 换行数 · 简易, 保底 3 行 */
    const charWidth = TYPE.body.fontSize * 0.65;
    const containerW = W - PAGE.padH * 2;
    const perLine = Math.floor(containerW / charWidth);
    const lines = Math.max(1, Math.ceil(para.length / Math.max(1, perLine)));
    const paraH = lines * bodyLineHeight + 8;
    bodyText(slide, para,
      { l: PAGE.padH, t: cursorY, w: containerW, h: paraH },
      { theme },
    );
    cursorY += paraH + (i < paragraphs.length - 1 ? SPACE.m : 0);
  });

  /* Footer + page number */
  if (slots.footerText) {
    footer(slide, { width: W, height: H }, { left: slots.footerText, theme });
  }
  if (slots.pageNumber != null) {
    pageNumber(slide, slots.pageNumber, { width: W, height: H }, { theme });
  }

  return slide;
}
