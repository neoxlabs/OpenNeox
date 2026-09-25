/**
 * chart-focus — bar/column 图占位.
 *
 * 视觉架构 (Neox PDS):
 *   kicker + sectionTitle + 图 + 底部数据标签
 * Phase 3 换 native <c:chart>. 目前用 rect 组合模拟, 但配色 / 字号跟其它模板一致.
 */

import type { Presentation } from '../builder/index.js';
import { kicker, sectionTitle, caption, footer, pageNumber } from '../design/primitives.js';
import { WARM_EDITORIAL, PAGE, SPACE, type NeoxTheme, TYPE } from '../design/tokens.js';

export const meta = {
  id: 'chart-focus',
  category: 'chart',
  useWhen: 'trend, comparison of quantities, ranked data, KPI over time',
  avoidWhen: 'single big number (use kpi-cards), text-heavy content',
  slots: {
    kicker: { required: false, maxChars: 40 },
    title: { required: false, maxChars: 32 },
    chartType: { required: true, enum: ['bar', 'column'] },
    data: { required: true, kind: '[{label, value}]', minItems: 2, maxItems: 8 },
    unit: { required: false, note: '数值单位, "%" / "人" / "¥"' },
    pageNumber: { required: false },
    footerText: { required: false },
  },
  typographyBudget: { titlePt: 32, labelPt: 12, valuePt: 14 },
  densityBudget: 'high',
} as const;

export interface ChartFocusSlots {
  kicker?: string;
  title?: string;
  chartType: 'bar' | 'column';
  data: Array<{ label: string; value: number }>;
  unit?: string;
  pageNumber?: string | number;
  footerText?: string;
  theme?: NeoxTheme;
}

export function chartFocus(ppt: Presentation, slots: ChartFocusSlots) {
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

  const maxValue = Math.max(...slots.data.map(d => d.value));
  const chartL = PAGE.padH;
  const chartTop = cursorY;
  const chartW = W - PAGE.padH * 2;
  const chartH = H - cursorY - PAGE.padBottom - 24;

  if (slots.chartType === 'column') {
    const barW = (chartW / slots.data.length) * 0.55;
    const gapW = (chartW / slots.data.length) * 0.45;
    slots.data.forEach((d, i) => {
      const bh = (d.value / maxValue) * (chartH - 44);
      const x = chartL + i * (barW + gapW) + gapW / 2;
      const y = chartTop + (chartH - 44) - bh;
      /* 柱条 */
      slide.shapes.addRoundRect({ left: x, top: y, width: barW, height: bh }, theme.palette.accent, 4);
      /* value 标签 */
      slide.shapes.addText(`${d.value}${slots.unit ?? ''}`,
        { left: x, top: y - 24, width: barW, height: 20 },
        { fontFamily: theme.fonts.text, fontSize: TYPE.caption.fontSize, bold: true, color: theme.palette.ink },
      );
      /* label */
      caption(slide, d.label,
        { l: x - 24, t: chartTop + chartH - 20, w: barW + 48, h: 20 },
        { theme, color: theme.palette.muted },
      );
    });
  } else {
    const rowH = (chartH / slots.data.length) * 0.7;
    const rowGap = (chartH / slots.data.length) * 0.3;
    const labelW = 120;
    const barMaxW = chartW - labelW - 80;
    slots.data.forEach((d, i) => {
      const y = chartTop + i * (rowH + rowGap) + rowGap / 2;
      const bw = (d.value / maxValue) * barMaxW;
      /* label */
      slide.shapes.addText(d.label,
        { left: chartL, top: y + 4, width: labelW, height: rowH },
        { fontFamily: theme.fonts.text, fontSize: TYPE.body.fontSize, color: theme.palette.ink },
      );
      /* bar */
      slide.shapes.addRoundRect({ left: chartL + labelW + SPACE.m, top: y, width: bw, height: rowH }, theme.palette.accent, 4);
      /* value */
      slide.shapes.addText(`${d.value}${slots.unit ?? ''}`,
        { left: chartL + labelW + SPACE.m + bw + SPACE.s, top: y + 4, width: 80, height: rowH },
        { fontFamily: theme.fonts.text, fontSize: TYPE.caption.fontSize, bold: true, color: theme.palette.ink },
      );
    });
  }

  if (slots.footerText) {
    footer(slide, { width: W, height: H }, { left: slots.footerText, theme });
  }
  if (slots.pageNumber != null) {
    pageNumber(slide, slots.pageNumber, { width: W, height: H }, { theme });
  }

  return slide;
}
