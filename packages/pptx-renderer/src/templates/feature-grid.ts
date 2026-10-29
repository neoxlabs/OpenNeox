/**
 * feature-grid — icon + 短说明 3-6 格 · 常用于产品特性 / 服务清单.
 *
 * 视觉架构 (Neox PDS):
 *   kicker + sectionTitle + 3 或 6 格 (每格: 装饰几何 icon 位 + 小标题 + 一句话说明).
 *   跟 imageGallery 区别: 这里 icon 位不放照片, 放装饰几何 (star/hexagon/chevron 等).
 *
 * 何时用: 产品特性 · 服务列表 · 团队角色 · "我们能做什么" 类
 * 何时不用: 需要真图片 (用 imageGallery) · 只是要点 (用 bulletList)
 */

import type { Presentation } from '../builder/index.js';
import { kicker, sectionTitle, h3Title, bodyText, footer, pageNumber } from '../design/primitives.js';
import { WARM_EDITORIAL, PAGE, SPACE, type NeoxTheme } from '../design/tokens.js';

const ICON_GEOMS = ['star5', 'hexagon', 'chevron', 'pentagon', 'triangle', 'rightArrow'] as const;

export const meta = {
  id: 'feature-grid',
  category: 'features',
  useWhen: 'product features, service list, team roles, "what we do" cards',
  avoidWhen: 'real photos needed (use image-gallery), simple bullets',
  slots: {
    kicker: { required: false, maxChars: 40 },
    title: { required: false, maxChars: 32 },
    items: {
      required: true, minItems: 3, maxItems: 6,
      kind: '[{title, desc, iconColor?}]',
      note: '每项: title ≤ 12 字, desc ≤ 40 字. 可选 iconColor (hex) 覆盖 accent 色',
    },
    pageNumber: { required: false },
    footerText: { required: false },
  },
  typographyBudget: { titlePt: 32, itemTitlePt: 18, itemDescPt: 14 },
  densityBudget: 'medium',
} as const;

export interface FeatureItem {
  title: string;
  desc: string;
  iconColor?: string;
}
export interface FeatureGridSlots {
  kicker?: string;
  title?: string;
  items: FeatureItem[];
  pageNumber?: string | number;
  footerText?: string;
  theme?: NeoxTheme;
}

export function featureGrid(ppt: Presentation, slots: FeatureGridSlots) {
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
    cursorY += 50 + SPACE.xl;
  }

  const n = slots.items.length;
  const cols = n <= 3 ? n : 3;
  const rows = Math.ceil(n / cols);
  const availW = W - PAGE.padH * 2;
  const availH = H - cursorY - PAGE.padBottom - SPACE.m;
  const gap = PAGE.gutter;
  const cellW = (availW - gap * (cols - 1)) / cols;
  const cellH = (availH - gap * (rows - 1)) / rows;
  const iconSize = 48;

  slots.items.forEach((item, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = PAGE.padH + col * (cellW + gap);
    const y = cursorY + row * (cellH + gap);
    const iconColor = item.iconColor ?? theme.palette.accent;

    /* 装饰 icon · 每个用不同 geometry 制造视觉变化 */
    const iconGeom = ICON_GEOMS[i % ICON_GEOMS.length];
    slide.shapes.add({
      geometry: iconGeom,
      position: { left: x, top: y, width: iconSize, height: iconSize },
      fill: iconColor,
      effects: {
        outerShadow: { blur: 20000, distance: 30000, angle: 90, color: '#000000', alpha: 0.15 },
      },
    });

    /* item title · icon 下方 */
    h3Title(slide, item.title,
      { l: x, t: y + iconSize + SPACE.m, w: cellW, h: 30 },
      { theme, color: theme.palette.ink },
    );

    /* item desc · 描述行 */
    bodyText(slide, item.desc,
      { l: x, t: y + iconSize + SPACE.m + 34, w: cellW, h: cellH - iconSize - 50 },
      { theme, color: theme.palette.muted },
    );
  });

  if (slots.footerText) {
    footer(slide, { width: W, height: H }, { left: slots.footerText, theme });
  }
  if (slots.pageNumber != null) {
    pageNumber(slide, slots.pageNumber, { width: W, height: H }, { theme });
  }

  return slide;
}
