/**
 * editorial-split — 杂志式左小图右大字 (或反向).
 *
 * 视觉架构 (Neox PDS):
 *   左 40% 位置一张竖构图小图 + kicker, 右 60% 大字标题 + 正文.
 *   跟 twoColumn 区别: 这里是"图+字"不对称, 不是"文字+文字"对称.
 *
 * 何时用: 单个主题深度介绍 (品牌故事 / 人物访谈 / 深度报道) · 一段图配一段字
 * 何时不用: 多个平级要点 (用 twoColumn) · 只有图 (用 imageGallery)
 */

import type { Presentation } from '../builder/index.js';
import { kicker, sectionTitle, bodyText, footer, pageNumber } from '../design/primitives.js';
import { WARM_EDITORIAL, PAGE, SPACE, textMetrics, type NeoxTheme } from '../design/tokens.js';

export const meta = {
  id: 'editorial-split',
  category: 'editorial',
  useWhen: 'deep single-topic story (brand narrative, interview, feature), one image + one paragraph',
  avoidWhen: 'multiple equal points (use two-column), image-heavy (use image-gallery)',
  slots: {
    kicker: { required: false, maxChars: 30 },
    title: { required: true, maxChars: 30 },
    body: { required: true, note: 'string 或 string[]', maxCharsPerItem: 220 },
    image: { required: false, kind: 'image', note: '左侧图 · 无则左半 accent 底色装饰' },
    imageSide: { required: false, note: "'left' (默认) | 'right' · 图放哪边" },
    pageNumber: { required: false },
    footerText: { required: false },
  },
  typographyBudget: { titlePt: 36, bodyPt: 18, kickerPt: 12 },
  densityBudget: 'medium',
} as const;

export interface EditorialSplitSlots {
  kicker?: string;
  title: string;
  body: string | string[];
  image?:
    | { blob: ArrayBuffer | Uint8Array; contentType: string }
    | { dataUrl: string }
    | { uri: string };
  imageSide?: 'left' | 'right';
  pageNumber?: string | number;
  footerText?: string;
  theme?: NeoxTheme;
}

export function editorialSplit(ppt: Presentation, slots: EditorialSplitSlots) {
  const theme = slots.theme ?? WARM_EDITORIAL;
  const W = ppt.model.slideWidth / 9525;
  const H = ppt.model.slideHeight / 9525;

  const slide = ppt.slides.add();
  slide.background.fill = theme.palette.paper;

  const imageOnLeft = slots.imageSide !== 'right';
  const imageW = W * 0.4;
  const imageX = imageOnLeft ? 0 : W - imageW;
  const textX = imageOnLeft ? imageW + PAGE.padH : PAGE.padH;
  const textW = W - imageW - PAGE.padH * 2;

  /* 左半 · 图或装饰 · 满出血 */
  if (slots.image) {
    slide.images.add({
      source: slots.image,
      position: { left: imageX, top: 0, width: imageW, height: H },
      fit: 'cover',
    });
  } else {
    slide.shapes.add({
      geometry: 'rect',
      position: { left: imageX, top: 0, width: imageW, height: H },
      fill: theme.palette.surface,
    });
    /* 装饰 · 一根竖 accent bar */
    slide.shapes.add({
      geometry: 'rect',
      position: { left: imageX + 30, top: H * 0.35, width: 6, height: H * 0.3 },
      fill: theme.palette.accent,
    });
  }

  /* 右半 · 文字区 */
  let cy = PAGE.padTop + 40;
  if (slots.kicker) {
    kicker(slide, slots.kicker, { l: textX, t: cy, w: textW, h: 20 }, { theme });
    cy += SPACE.xl;
  }
  /* 根据标题换行行数计算文本框高度，确保正文从标题框之后开始布局。 */
  const titleFontPx = 36 * 96 / 72; /* h1 CSS px */
  const titleLineH = titleFontPx * 1.25;
  const titleCharWidth = titleFontPx * 0.75;
  const titlePerLine = Math.max(1, Math.floor(textW / titleCharWidth));
  const titleLines = Math.max(1, Math.ceil(slots.title.length / titlePerLine));
  const titleBoxH = Math.max(60, titleLines * titleLineH + 16);
  sectionTitle(slide, slots.title, { l: textX, t: cy, w: textW, h: titleBoxH }, { theme });
  cy += titleBoxH + SPACE.xl;

  /* 正文使用 textMetrics 转换 pt 到 CSS px，保持段落布局的单位一致。 */
  const paragraphs = Array.isArray(slots.body) ? slots.body : [slots.body];
  const { lineH, charWidth } = textMetrics(18, { charKind: 'mixed' });
  const maxY = H - PAGE.padBottom;
  paragraphs.forEach((para, i) => {
    if (!para.trim()) return;
    if (cy >= maxY - lineH) return;
    const perLine = Math.max(1, Math.floor(textW / charWidth));
    const lines = Math.max(1, Math.ceil(para.length / perLine));
    const paraH = Math.min(lines * lineH + 8, maxY - cy);
    bodyText(slide, para, { l: textX, t: cy, w: textW, h: paraH }, { theme });
    cy += paraH + (i < paragraphs.length - 1 ? SPACE.m : 0);
  });

  if (slots.footerText) {
    footer(slide, { width: W, height: H }, { left: slots.footerText, theme });
  }
  if (slots.pageNumber != null) {
    pageNumber(slide, slots.pageNumber, { width: W, height: H }, { theme });
  }

  return slide;
}
