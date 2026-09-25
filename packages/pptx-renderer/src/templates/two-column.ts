/**
 * two-column — 对比 / 双栏叙事。Flat editorial 排版。
 *
 * 视觉架构 (Neox PDS):
 *   kicker + sectionTitle + [左栏 h3Title + body] + verticalDivider + [右栏 h3Title + body]
 *
 * 两栏共享 paper 底，中间用 verticalDivider 分隔；每栏标题使用 accent 色和顶部
 * accentBar，正文按 TYPE.body 的实际字号估算换行。
 */

import type { Presentation } from '../builder/index.js';
import {
  kicker, sectionTitle, h3Title, bodyText, accentBar,
  verticalDivider, footer, pageNumber,
} from '../design/primitives.js';
import { WARM_EDITORIAL, PAGE, SPACE, TYPE, textMetrics, type NeoxTheme } from '../design/tokens.js';

export const meta = {
  id: 'two-column',
  category: 'two-column',
  useWhen: 'comparison, before/after, pros/cons, side-by-side content',
  avoidWhen: 'single-topic slide, dense table (use data-table)',
  slots: {
    kicker: { required: false, maxChars: 40 },
    title: { required: false, maxChars: 36 },
    leftTitle: { required: true, maxChars: 20 },
    leftBody: { required: true, maxCharsPerItem: 220, note: 'string 或 string[] (每项一段)' },
    rightTitle: { required: true, maxChars: 20 },
    rightBody: { required: true, maxCharsPerItem: 220 },
    pageNumber: { required: false },
    footerText: { required: false },
  },
  typographyBudget: { titlePt: 32, colTitlePt: 18, bodyPt: 16 },
  densityBudget: 'medium',
} as const;

export interface TwoColumnSlots {
  kicker?: string;
  title?: string;
  leftTitle: string;
  leftBody: string | string[];
  rightTitle: string;
  rightBody: string | string[];
  pageNumber?: string | number;
  footerText?: string;
  theme?: NeoxTheme;
}

export function twoColumn(ppt: Presentation, slots: TwoColumnSlots) {
  const theme = slots.theme ?? WARM_EDITORIAL;
  const W = ppt.model.slideWidth / 9525;
  const H = ppt.model.slideHeight / 9525;

  const slide = ppt.slides.add();
  slide.background.fill = theme.palette.paper;

  let cursorY = PAGE.padTop;

  if (slots.kicker) {
    kicker(slide, slots.kicker,
      { l: PAGE.padH, t: cursorY, w: W - PAGE.padH * 2, h: 20 },
      { theme },
    );
    cursorY += SPACE.xl + 4; /* 加宽 kicker→title 呼吸 (原 28px → 36px), 避免部分 viewer 视觉贴脸 */
  }

  if (slots.title) {
    sectionTitle(slide, slots.title,
      { l: PAGE.padH, t: cursorY, w: W - PAGE.padH * 2, h: 50 },
      { theme },
    );
    cursorY += 50 + SPACE.xl + 8;
  }

  const availW = W - PAGE.padH * 2;
  const gap = PAGE.gutter;
  const colW = (availW - gap) / 2;
  const colH = H - cursorY - PAGE.padBottom - SPACE.m;

  const leftX = PAGE.padH;
  const rightX = PAGE.padH + colW + gap;

  /* Flat editorial: 每栏顶部一根 accentBar (accent 短横), 视觉锚点+分栏识别.
   * 宽/高从 opts 传 (accentBar 不看 pos.w/h, 从 opts.width/height 拿) */
  accentBar(slide, { l: leftX, t: cursorY, w: 0, h: 0 }, { theme, width: 40, height: 4 });
  accentBar(slide, { l: rightX, t: cursorY, w: 0, h: 0 }, { theme, width: 40, height: 4 });
  const contentStart = cursorY + SPACE.m + 4;

  /* Left title + body */
  h3Title(slide, slots.leftTitle,
    { l: leftX, t: contentStart, w: colW, h: 32 },
    { theme, color: theme.palette.accent },
  );
  renderBody(slide, slots.leftBody,
    { l: leftX, t: contentStart + 40, w: colW, h: colH - (contentStart - cursorY) - 40 },
    theme,
  );

  /* Right title + body */
  h3Title(slide, slots.rightTitle,
    { l: rightX, t: contentStart, w: colW, h: 32 },
    { theme, color: theme.palette.accent },
  );
  renderBody(slide, slots.rightBody,
    { l: rightX, t: contentStart + 40, w: colW, h: colH - (contentStart - cursorY) - 40 },
    theme,
  );

  /* 中间垂直分割线 · muted 淡色, 只在两栏都有内容时画 */
  const dividerX = leftX + colW + gap / 2;
  verticalDivider(slide, { l: dividerX - 0.5, t: contentStart, w: 1, h: colH - (contentStart - cursorY) - SPACE.m }, { theme });

  if (slots.footerText) {
    footer(slide, { width: W, height: H }, { left: slots.footerText, theme });
  }
  if (slots.pageNumber != null) {
    pageNumber(slide, slots.pageNumber, { width: W, height: H }, { theme });
  }

  return slide;
}

/**
 * renderBody — 字号=TYPE.body (被上调过, 现在 18pt), 换行估算跟随实际字号.
 * 加溢出保护: 累计高度接近 pos.h 时停画, 不再继续贴文字 (避免超出画布/跑到 footer 底下).
 */
function renderBody(slide: any, body: string | string[], pos: { l: number; t: number; w: number; h: number }, theme: NeoxTheme): void {
  const paragraphs = Array.isArray(body) ? body : [body];
  /* 使用 textMetrics 将字号换算为 CSS px，保持换行和渲染单位一致。 */
  const { lineH, charWidth } = textMetrics(TYPE.body.fontSize, { charKind: 'mixed' });
  const perLine = Math.max(1, Math.floor(pos.w / charWidth));
  const maxY = pos.t + pos.h;
  let cy = pos.t;
  paragraphs.forEach((para, i) => {
    if (!para.trim()) return;
    if (cy >= maxY - lineH) return;
    const lines = Math.max(1, Math.ceil(para.length / perLine));
    const paraH = lines * lineH + 8;
    const clampedH = Math.min(paraH, maxY - cy);
    bodyText(slide, para, { l: pos.l, t: cy, w: pos.w, h: clampedH }, { theme });
    cy += clampedH + (i < paragraphs.length - 1 ? SPACE.m : 0);
  });
}
