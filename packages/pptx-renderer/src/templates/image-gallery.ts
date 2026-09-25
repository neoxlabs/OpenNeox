/**
 * image-gallery — 2/3/4/6 图网格. 景点图鉴 / 产品图 / 团队合影.
 *
 * 视觉架构 (Neox PDS):
 *   kicker + sectionTitle + photoCard 网格 + footer
 */

import type { Presentation } from '../builder/index.js';
import { kicker, sectionTitle, photoCard, footer, pageNumber } from '../design/primitives.js';
import { WARM_EDITORIAL, PAGE, SPACE, RADII, type NeoxTheme } from '../design/tokens.js';

export const meta = {
  id: 'image-gallery',
  category: 'gallery',
  useWhen: 'photo grid (2/3/4/6 images), product showcase, team photos, travel scenery, food/scene coverage',
  avoidWhen: 'single hero image (use cover-hero), text-only slide',
  slots: {
    kicker: { required: false, maxChars: 40 },
    title: { required: false, maxChars: 32 },
    images: { required: true, minItems: 2, maxItems: 6, kind: 'image[]' },
    captions: { required: false, note: '每图 caption; 长度需要跟 images 一致 (可留空字符串)' },
    pageNumber: { required: false },
    footerText: { required: false },
  },
  typographyBudget: { titlePt: 32, captionPt: 12 },
  densityBudget: 'medium',
  layoutHint: '2 → 1x2; 3 → 1x3; 4 → 2x2; 5-6 → 2x3',
} as const;

export interface ImageGallerySlots {
  kicker?: string;
  title?: string;
  images: Array<
    | { blob: ArrayBuffer | Uint8Array; contentType: string }
    | { dataUrl: string }
    | { uri: string }
  >;
  captions?: string[];
  pageNumber?: string | number;
  footerText?: string;
  theme?: NeoxTheme;
}

export function imageGallery(ppt: Presentation, slots: ImageGallerySlots) {
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
    cursorY += 50 + SPACE.xl;
  }

  const n = slots.images.length;
  /* 布局决策: 2→1x2; 3→1x3; 4→2x2; 5-6→2x3 */
  const cols = n <= 3 ? n : n <= 4 ? 2 : 3;
  const rows = Math.ceil(n / cols);
  const gap = PAGE.gutter;
  const gridW = W - PAGE.padH * 2;
  const gridH = H - cursorY - PAGE.padBottom - SPACE.m;
  const cellW = (gridW - gap * (cols - 1)) / cols;
  const cellH = (gridH - gap * (rows - 1)) / rows;

  slots.images.forEach((img, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = PAGE.padH + col * (cellW + gap);
    const y = cursorY + row * (cellH + gap);
    photoCard(slide, img,
      { l: x, t: y, w: cellW, h: cellH },
      { theme, caption: slots.captions?.[i] },
    );
  });

  if (slots.footerText) {
    footer(slide, { width: W, height: H }, { left: slots.footerText, theme });
  }
  if (slots.pageNumber != null) {
    pageNumber(slide, slots.pageNumber, { width: W, height: H }, { theme });
  }

  /* placeholder ref to silence unused */
  void RADII;
  return slide;
}
