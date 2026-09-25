/**
 * cover-hero — 大图封面 / 品牌开篇.
 *
 * 视觉架构 (Neox PDS):
 *   heroPhotoBackdrop (若有图) 或 heroGradientBackdrop (无图) + kicker + heroTitle +
 *   subtitle + 底部装饰 accent bar + pageNumber
 *
 * 一次调用 5-6 个 primitives 组合完成, 没有硬编码颜色 / 字号.
 */

import type { Presentation } from '../builder/index.js';
import {
  heroPhotoBackdrop, heroGradientBackdrop,
  kicker, heroTitle, bodyLarge, accentBar, pageNumber, caption,
} from '../design/primitives.js';
import { WARM_EDITORIAL, PAGE, SPACE, type NeoxTheme } from '../design/tokens.js';

export const meta = {
  id: 'cover-hero',
  category: 'cover',
  useWhen: 'first slide, section opener, product launch, strong single-image message',
  avoidWhen: 'data-heavy slide, multi-point content, comparison',
  slots: {
    title: { required: true, maxChars: 24 },
    subtitle: { required: false, maxChars: 60 },
    tag: { required: false, maxChars: 40, note: 'small kicker above title, e.g. "SUMMER 2026 · 5 DAYS"' },
    backgroundImage: { required: false, kind: 'image', note: 'omit for gradient fallback' },
    pageNumber: { required: false, note: 'e.g. "01" bottom-right' },
    footerText: { required: false, note: '底部小字, brand / attribution' },
  },
  typographyBudget: { titlePt: 56, subtitlePt: 18, kickerPt: 11 },
  densityBudget: 'low',
} as const;

export interface CoverHeroSlots {
  title: string;
  subtitle?: string;
  tag?: string;
  backgroundImage?:
    | { blob: ArrayBuffer | Uint8Array; contentType: string }
    | { dataUrl: string }
    | { uri: string };
  pageNumber?: string | number;
  footerText?: string;
  theme?: NeoxTheme;
}

export function coverHero(ppt: Presentation, slots: CoverHeroSlots) {
  const theme = slots.theme ?? WARM_EDITORIAL;
  const W = ppt.model.slideWidth / 9525;
  const H = ppt.model.slideHeight / 9525;

  const slide = ppt.slides.add();

  const hasImage = !!slots.backgroundImage;
  if (hasImage) {
    heroPhotoBackdrop(slide, slots.backgroundImage!, { width: W, height: H });
    /* heroPhotoBackdrop 内部会加双层遮罩: 整屏 15% + 底部 72% dark, 保证白字浮出来 */
  } else {
    heroGradientBackdrop(slide, { width: W, height: H }, { theme });
  }

  /* 文字颜色: 一律亮白 (深色底) */
  const textColor = '#FFFFFF';

  /* 内容起点: 下沉到 62% 高度, 确保在 heroPhotoBackdrop 的深遮罩区内 (fromY = 50%) */
  const contentStartY = H * 0.62;

  if (slots.tag) {
    kicker(slide, slots.tag,
      { l: PAGE.padH, t: contentStartY, w: W * 0.7, h: 20 },
      { theme, color: theme.palette.accent },
    );
  }

  /* 主标题 · Hero size */
  heroTitle(slide, slots.title,
    { l: PAGE.padH, t: contentStartY + SPACE.l, w: W * 0.85, h: 90 },
    { theme, color: textColor },
  );

  /* accent bar · 分割标题与副标题 */
  accentBar(slide,
    { l: PAGE.padH, t: contentStartY + SPACE.l + 100, w: 48, h: 4 },
    { theme },
  );

  /* 副标题 */
  if (slots.subtitle) {
    bodyLarge(slide, slots.subtitle,
      { l: PAGE.padH, t: contentStartY + SPACE.l + 120, w: W * 0.7, h: 60 },
      { theme, color: textColor },
    );
  }

  /* 底部品牌行 (可选) */
  if (slots.footerText) {
    caption(slide, slots.footerText,
      { l: PAGE.padH, t: H - PAGE.padBottom, w: W * 0.6, h: 20 },
      { theme, color: theme.palette.onInk },
    );
  }

  /* 页码 */
  if (slots.pageNumber != null) {
    pageNumber(slide, slots.pageNumber, { width: W, height: H }, { theme });
  }

  return slide;
}
