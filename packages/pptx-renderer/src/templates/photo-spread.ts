/**
 * photo-spread — 3-4 图错落黄金比例拼贴 · 杂志感.
 *
 * 视觉架构 (Neox PDS):
 *   一张大图 (占黄金比例 61.8%) + 2-3 张小图 (错落分布), 一个 kicker 和一个短标题浮在图上.
 *   跟 imageGallery 均匀网格区别: 这里是**不对称**布局, 视觉更编辑感.
 *
 * 何时用: 旅行/生活方式 · 品牌视觉展示 · 章节封面组图
 * 何时不用: 需要每图配文 (用 imageGallery) · 纯数据 · 单图 hero (用 heroImageQuote)
 */

import type { Presentation } from '../builder/index.js';
import { kicker, footer, pageNumber } from '../design/primitives.js';
import { WARM_EDITORIAL, PAGE, TYPE, goldenSplit, type NeoxTheme } from '../design/tokens.js';

export const meta = {
  id: 'photo-spread',
  category: 'gallery',
  useWhen: 'editorial photo spread, brand visuals, travel imagery, chapter cover with multiple photos',
  avoidWhen: 'per-image captions needed (use image-gallery), text-heavy, single hero image',
  slots: {
    kicker: { required: false, maxChars: 20 },
    title: { required: false, maxChars: 24, note: '短标题 · 覆盖在大图上' },
    images: {
      required: true, minItems: 3, maxItems: 4,
      kind: 'image[]', note: '第 1 张为大图, 其余为副图',
    },
    pageNumber: { required: false },
    footerText: { required: false },
  },
  typographyBudget: { titlePt: 40, kickerPt: 12 },
  densityBudget: 'low',
} as const;

export interface PhotoSpreadSlots {
  kicker?: string;
  title?: string;
  images: Array<
    | { blob: ArrayBuffer | Uint8Array; contentType: string }
    | { dataUrl: string }
    | { uri: string }
  >;
  pageNumber?: string | number;
  footerText?: string;
  theme?: NeoxTheme;
}

export function photoSpread(ppt: Presentation, slots: PhotoSpreadSlots) {
  const theme = slots.theme ?? WARM_EDITORIAL;
  const W = ppt.model.slideWidth / 9525;
  const H = ppt.model.slideHeight / 9525;

  const slide = ppt.slides.add();
  slide.background.fill = theme.palette.paper;

  const { major, minor } = goldenSplit(W); /* major = 61.8% */

  /* 大图 · 左半黄金比例 · 满出血高度 */
  slide.images.add({
    source: slots.images[0]!,
    position: { left: 0, top: 0, width: major, height: H },
    fit: 'cover',
  });

  /* 大图右下角浮层 · 深色渐变盖底部, 让 title 白字浮上来 */
  if (slots.title) {
    slide.shapes.add({
      geometry: 'rect',
      position: { left: 0, top: H * 0.55, width: major, height: H * 0.45 },
      fill: 'rgba(0, 0, 0, 0.55)',
    });
    if (slots.kicker) {
      kicker(slide, slots.kicker,
        { l: 40, t: H * 0.62, w: major - 80, h: 20 },
        { theme, color: theme.palette.accent },
      );
    }
    slide.shapes.addText(slots.title,
      { left: 40, top: H * 0.62 + 32, width: major - 80, height: 100 },
      {
        fontSize: TYPE.h1.fontSize,
        bold: true,
        color: '#FFFFFF',
        fontLatin: theme.fonts.displayLatin,
        fontEast: theme.fonts.displayEast,
      });
  }

  /* 副图 · 右半栏 · 2-3 张竖排 · 错落 */
  const subImages = slots.images.slice(1);
  const subW = minor - PAGE.padH;
  const subX = major + PAGE.gutter;
  const totalGap = 12;
  const subH = (H - totalGap * (subImages.length - 1)) / subImages.length;

  subImages.forEach((img, i) => {
    const y = i * (subH + totalGap);
    slide.images.add({
      source: img,
      position: { left: subX, top: y, width: subW, height: subH },
      fit: 'cover',
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
