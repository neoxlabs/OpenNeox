/**
 * three-column — 3 栏并列 · 常用于服务概览 / 竞品对比 / 三段式议论.
 *
 * 视觉架构 (Neox PDS):
 *   kicker + sectionTitle + 3 栏 flat editorial (无 card 底 · 顶部 accent 短横 · 中间竖 divider).
 *   跟 twoColumn 区别: 三档不是两档 · 每栏字数上限更严格.
 */

import type { Presentation } from '../builder/index.js';
import { kicker, sectionTitle, h3Title, bodyText, accentBar, verticalDivider, footer, pageNumber, threeColumnLayout } from '../design/primitives.js';
import { WARM_EDITORIAL, PAGE, SPACE, TYPE, textMetrics, type NeoxTheme } from '../design/tokens.js';

export const meta = {
  id: 'three-column',
  category: 'multi-column',
  useWhen: 'three-way comparison, service triad, three-part argument, market segments',
  avoidWhen: 'two items (use two-column), 4+ items (use bullet-list or two pages)',
  slots: {
    kicker: { required: false, maxChars: 40 },
    title: { required: false, maxChars: 36 },
    columns: {
      required: true, minItems: 3, maxItems: 3,
      kind: '[{title, body}]', note: '每栏 title ≤ 16 字, body ≤ 140 字',
    },
    pageNumber: { required: false },
    footerText: { required: false },
  },
  typographyBudget: { titlePt: 32, colTitlePt: 20, bodyPt: 16 },
  densityBudget: 'medium',
} as const;

export interface ThreeColumnItem {
  title: string;
  body: string | string[];
}
export interface ThreeColumnSlots {
  kicker?: string;
  title?: string;
  columns: [ThreeColumnItem, ThreeColumnItem, ThreeColumnItem];
  pageNumber?: string | number;
  footerText?: string;
  theme?: NeoxTheme;
}

export function threeColumn(ppt: Presentation, slots: ThreeColumnSlots) {
  const theme = slots.theme ?? WARM_EDITORIAL;
  const W = ppt.model.slideWidth / 9525;
  const H = ppt.model.slideHeight / 9525;

  const slide = ppt.slides.add();
  slide.background.fill = theme.palette.paper;

  let cursorY = PAGE.padTop;

  if (slots.kicker) {
    kicker(slide, slots.kicker, { l: PAGE.padH, t: cursorY, w: W - PAGE.padH * 2, h: 20 }, { theme });
    cursorY += SPACE.xl + 4;
  }
  if (slots.title) {
    sectionTitle(slide, slots.title, { l: PAGE.padH, t: cursorY, w: W - PAGE.padH * 2, h: 50 }, { theme });
    cursorY += 50 + SPACE.xl + 8;
  }

  const contentH = H - cursorY - PAGE.padBottom - SPACE.m;
  const { columns, dividers } = threeColumnLayout(W, cursorY, contentH);

  columns.forEach((col, i) => {
    const item = slots.columns[i]!;
    /* accent bar top */
    accentBar(slide, { l: col.left, t: col.top, w: 0, h: 0 }, { theme, width: 36, height: 4 });
    /* col title */
    h3Title(slide, item.title,
      { l: col.left, t: col.top + SPACE.m + 4, w: col.width, h: 32 },
      { theme, color: theme.palette.accent },
    );
    /* col body */
    const paragraphs = Array.isArray(item.body) ? item.body : [item.body];
    const bodyStart = col.top + SPACE.m + 4 + 40;
    const bodyH = col.height - (bodyStart - col.top);
    /* 使用 textMetrics 将字号从 pt 转为 CSS px。 */
    const { lineH, charWidth } = textMetrics(TYPE.body.fontSize, { charKind: 'mixed' });
    const perLine = Math.max(1, Math.floor(col.width / charWidth));
    const maxY = bodyStart + bodyH;
    let cy = bodyStart;
    paragraphs.forEach((para, idx) => {
      if (!para.trim() || cy >= maxY - lineH) return;
      const lines = Math.max(1, Math.ceil(para.length / perLine));
      const paraH = Math.min(lines * lineH + 8, maxY - cy);
      bodyText(slide, para, { l: col.left, t: cy, w: col.width, h: paraH }, { theme });
      cy += paraH + (idx < paragraphs.length - 1 ? SPACE.m : 0);
    });
  });

  /* 中间竖分隔 */
  dividers.forEach((d) => {
    verticalDivider(slide, { l: d.x, t: d.y, w: 1, h: d.h - SPACE.m }, { theme });
  });

  if (slots.footerText) {
    footer(slide, { width: W, height: H }, { left: slots.footerText, theme });
  }
  if (slots.pageNumber != null) {
    pageNumber(slide, slots.pageNumber, { width: W, height: H }, { theme });
  }

  return slide;
}
