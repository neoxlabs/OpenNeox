/**
 * bullet-list — 项目符号列表. 3-8 条要点.
 *
 * 视觉架构 (Neox PDS):
 *   kicker + sectionTitle + 项目符号行 (accent 小圆点 + body 文字, 每行独立占位)
 */

import type { Presentation } from '../builder/index.js';
import { kicker, sectionTitle, bodyText, footer, pageNumber } from '../design/primitives.js';
import { WARM_EDITORIAL, PAGE, SPACE, TYPE, type NeoxTheme } from '../design/tokens.js';

export const meta = {
  id: 'bullet-list',
  category: 'general',
  useWhen: 'itemized list, feature enumeration, requirements, principles, key takeaways (3-8 items)',
  avoidWhen: 'narrative flow (use title-body), comparison (use two-column), sequential (use timeline)',
  slots: {
    kicker: { required: false, maxChars: 40 },
    title: { required: false, maxChars: 32 },
    items: { required: true, minItems: 2, maxItems: 8, kind: 'string[]', maxCharsPerItem: 100 },
    pageNumber: { required: false },
    footerText: { required: false },
  },
  typographyBudget: { titlePt: 32, itemPt: 18 },
  densityBudget: 'medium',
} as const;

export interface BulletListSlots {
  kicker?: string;
  title?: string;
  items: string[];
  pageNumber?: string | number;
  footerText?: string;
  theme?: NeoxTheme;
}

export function bulletList(ppt: Presentation, slots: BulletListSlots) {
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

  const availH = H - cursorY - PAGE.padBottom - SPACE.m;
  const itemH = Math.min(72, availH / slots.items.length);
  const bulletSize = 8;
  const bulletOffset = 24;

  slots.items.forEach((item, i) => {
    const y = cursorY + i * itemH;
    /* accent 小圆点 */
    slide.shapes.addEllipse({
      left: PAGE.padH,
      top: y + itemH / 2 - bulletSize / 2 - 2,
      width: bulletSize,
      height: bulletSize,
    }, theme.palette.accent);
    /* 文字 */
    bodyText(slide, item,
      { l: PAGE.padH + bulletOffset, t: y + 4, w: W - PAGE.padH * 2 - bulletOffset, h: itemH - 8 },
      { theme },
    );
  });

  if (slots.footerText) {
    footer(slide, { width: W, height: H }, { left: slots.footerText, theme });
  }
  if (slots.pageNumber != null) {
    pageNumber(slide, slots.pageNumber, { width: W, height: H }, { theme });
  }

  void TYPE;
  return slide;
}
