/**
 * hero-image-quote — 大图 + 引言双联页 (杂志编辑感).
 *
 * 视觉架构 (Neox PDS):
 *   左半 slide 满出血图片 + 底部 gradient 保护, 右半 slide paper 底 + 一句大字引言 (衬线) + 出处.
 *   左右不对称 · 图片贯穿上下无边距 · 引言字体走 display serif · 出处走 kicker.
 *
 * 何时用: 章节开篇 · 视觉停顿页 · 想给观众"读一句然后思考一下"的时刻.
 * 何时不用: 数据密集页 · 多点要点 · 常规内容页.
 */

import type { Presentation } from '../builder/index.js';
import { kicker, footer, pageNumber } from '../design/primitives.js';
import { WARM_EDITORIAL, TYPE, PAGE, SPACE, type NeoxTheme } from '../design/tokens.js';

export const meta = {
  id: 'hero-image-quote',
  category: 'editorial',
  useWhen: 'chapter opener, editorial breath, quote emphasis, section pause with strong visual',
  avoidWhen: 'data-heavy slide, multi-point content, comparison',
  slots: {
    image: { required: false, kind: 'image', note: 'omit for gradient fallback (仍然保持左半 accent 色块)' },
    quote: { required: true, maxChars: 90, note: '一句话大字引言 · 衬线体渲染' },
    attribution: { required: false, maxChars: 40, note: '出处/署名 · 显示在引言下方' },
    kicker: { required: false, maxChars: 30 },
    pageNumber: { required: false },
    footerText: { required: false },
  },
  typographyBudget: { quotePt: 40, attribPt: 14, kickerPt: 12 },
  densityBudget: 'low',
} as const;

export interface HeroImageQuoteSlots {
  image?:
    | { blob: ArrayBuffer | Uint8Array; contentType: string }
    | { dataUrl: string }
    | { uri: string };
  quote: string;
  attribution?: string;
  kicker?: string;
  pageNumber?: string | number;
  footerText?: string;
  theme?: NeoxTheme;
}

export function heroImageQuote(ppt: Presentation, slots: HeroImageQuoteSlots) {
  const theme = slots.theme ?? WARM_EDITORIAL;
  const W = ppt.model.slideWidth / 9525;
  const H = ppt.model.slideHeight / 9525;

  const slide = ppt.slides.add();
  slide.background.fill = theme.palette.paper;

  /* 左半 · 满出血图 · 40% 宽 (三分法 · 图片占左三分, 文字占右三分二) */
  const imageW = W * 0.4;

  const hasImage = !!slots.image;
  if (hasImage) {
    slide.images.add({
      source: slots.image!,
      position: { left: 0, top: 0, width: imageW, height: H },
      fit: 'cover',
    });
    /* 图上顶部渐变 · 从 accent 深色到透明, 视觉锚点 */
    slide.shapes.add({
      geometry: 'rect',
      position: { left: 0, top: 0, width: imageW, height: 120 },
      fill: `rgba(29,42,47,0.35)`,
    });
  } else {
    /* 无图: 左半用深色 ink 底 + accent 装饰 (跟 heroGradientBackdrop 呼应) */
    slide.shapes.add({
      geometry: 'rect',
      position: { left: 0, top: 0, width: imageW, height: H },
      fill: theme.palette.ink,
    });
    /* 装饰: 大椭圆 accent 淡叠 */
    slide.shapes.add({
      geometry: 'ellipse',
      position: { left: imageW * 0.15, top: H * 0.35, width: imageW * 0.7, height: imageW * 0.7 },
      fill: `rgba(192,86,33,0.22)`,
    });
    /* 竖 accent bar */
    slide.shapes.add({
      geometry: 'rect',
      position: { left: 32, top: 40, width: 6, height: H * 0.4 },
      fill: theme.palette.accent,
    });
  }

  /* 右半 · 引言区 */
  const rightX = imageW + PAGE.padH;
  const rightW = W - imageW - PAGE.padH * 2;
  const quoteY = H * 0.28;

  if (slots.kicker) {
    kicker(slide, slots.kicker,
      { l: rightX, t: quoteY - 40, w: rightW, h: 20 },
      { theme, color: theme.palette.accent },
    );
  }

  /* 引言大字 · pullQuote (32pt · display 衬线) */
  slide.shapes.addText(
    `"${slots.quote}"`,
    { left: rightX, top: quoteY, width: rightW, height: 260 },
    {
      fontSize: TYPE.pullQuote.fontSize,
      bold: false,
      italic: true,
      color: theme.palette.ink,
      fontLatin: theme.fonts.displayLatin,
      fontEast: theme.fonts.displayEast,
    },
  );

  /* 出处 · 引言下方 */
  if (slots.attribution) {
    slide.shapes.addText(
      `— ${slots.attribution}`,
      { left: rightX, top: quoteY + 260, width: rightW, height: 30 },
      {
        fontSize: 14,
        color: theme.palette.muted,
        letterSpacingPt: 0.3,
        fontLatin: theme.fonts.textLatin,
        fontEast: theme.fonts.textEast,
      },
    );
  }

  /* 底部 accent 短横 · 视觉锚脚 */
  slide.shapes.add({
    geometry: 'rect',
    position: { left: rightX, top: H - 80, width: 48, height: 3 },
    fill: theme.palette.accent,
  });

  if (slots.footerText) {
    footer(slide, { width: W, height: H }, { left: slots.footerText, theme });
  }
  if (slots.pageNumber != null) {
    pageNumber(slide, slots.pageNumber, { width: W, height: H }, { theme });
  }

  void SPACE;
  return slide;
}
