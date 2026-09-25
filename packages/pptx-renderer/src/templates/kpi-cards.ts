/**
 * kpi-cards — 2-4 张 KPI 数字统计卡.
 *
 * 视觉架构 (Neox PDS):
 *   kicker + sectionTitle + N × metricPill (自带 boxed 卡背 / 数字大字 / label + sublabel)
 */

import type { Presentation } from '../builder/index.js';
import { kicker, sectionTitle, metricPill, footer, pageNumber } from '../design/primitives.js';
import { WARM_EDITORIAL, PAGE, SPACE, type NeoxTheme } from '../design/tokens.js';

export const meta = {
  id: 'kpi-cards',
  category: 'metrics',
  useWhen: 'stats, KPIs, results, big numbers with labels',
  avoidWhen: 'narrative content, tables (use data-table)',
  slots: {
    kicker: { required: false, maxChars: 40 },
    title: { required: false, maxChars: 32 },
    cards: { required: true, minItems: 2, maxItems: 4, kind: '[{value, label, subLabel?}]', maxCharsPerValue: 8 },
    pageNumber: { required: false },
    footerText: { required: false },
  },
  typographyBudget: { titlePt: 32, valuePt: 52, labelPt: 18 },
  densityBudget: 'low',
} as const;

export interface KpiCard {
  value: string;
  label: string;
  subLabel?: string;
}

export interface KpiCardsSlots {
  kicker?: string;
  title?: string;
  cards: KpiCard[];
  pageNumber?: string | number;
  footerText?: string;
  theme?: NeoxTheme;
}

export function kpiCards(ppt: Presentation, slots: KpiCardsSlots) {
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

  const n = slots.cards.length;
  const availW = W - PAGE.padH * 2;
  const gap = PAGE.gutter;
  const cardW = (availW - gap * (n - 1)) / n;
  const cardH = 220;

  slots.cards.forEach((card, i) => {
    const x = PAGE.padH + i * (cardW + gap);
    metricPill(slide, card.value, card.label,
      { l: x, t: cursorY, w: cardW, h: cardH },
      { theme, sublabel: card.subLabel },
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
