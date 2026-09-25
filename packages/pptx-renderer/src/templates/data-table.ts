/**
 * data-table — 结构化数据表.
 *
 * 视觉架构 (Neox PDS):
 *   kicker + sectionTitle + 原生 pptx `<a:tbl>` (换真表) + footer
 *
 * 从伪表 (rect 拼行) 换成 slide.tables.add(...), 生成的 pptx 在
 *   PowerPoint / Keynote / WPS 里打开可以**直接编辑单元格**. 视觉也更精致 (真表有精确
 *   边框 · header 深底 · 隔行斑马 · 数字列可右对齐 · 精确内边距).
 */

import type { Presentation } from '../builder/index.js';
import { kicker, sectionTitle, footer, pageNumber } from '../design/primitives.js';
import { WARM_EDITORIAL, PAGE, SPACE, type NeoxTheme } from '../design/tokens.js';

export const meta = {
  id: 'data-table',
  category: 'data-table',
  useWhen: 'structured data, price list, feature matrix, schedule table, comparison rows',
  avoidWhen: 'narrative or single value display (use title-body or kpi-cards)',
  slots: {
    kicker: { required: false, maxChars: 40 },
    title: { required: false, maxChars: 32 },
    headers: { required: true, minItems: 2, maxItems: 6, kind: 'string[]' },
    rows: { required: true, minItems: 1, maxItems: 10, kind: 'string[][]' },
    columnWidths: { required: false, note: '每列相对权重 (自动归一化). 缺省等宽.' },
    pageNumber: { required: false },
    footerText: { required: false },
  },
  typographyBudget: { titlePt: 32, headerPt: 13, cellPt: 13 },
  densityBudget: 'high',
} as const;

export interface DataTableSlots {
  kicker?: string;
  title?: string;
  headers: string[];
  rows: string[][];
  columnWidths?: number[];
  /** 每列水平对齐. 长度需 = headers.length. 数字列建议 'r'. 缺省全 'l' */
  columnAlign?: Array<'l' | 'ctr' | 'r'>;
  pageNumber?: string | number;
  footerText?: string;
  theme?: NeoxTheme;
}

export function dataTable(ppt: Presentation, slots: DataTableSlots) {
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

  /* 原生 pptx 表格 · 可在 PowerPoint/Keynote/WPS 里编辑单元格 */
  const tableW = W - PAGE.padH * 2;
  const availH = H - cursorY - PAGE.padBottom - SPACE.m;
  slide.tables.add({
    position: { left: PAGE.padH, top: cursorY, width: tableW, height: availH },
    headers: slots.headers,
    rows: slots.rows,
    columnWidths: slots.columnWidths,
    columnAlign: slots.columnAlign,
    zebra: true,
    borderColor: theme.palette.subtle,
  });

  if (slots.footerText) {
    footer(slide, { width: W, height: H }, { left: slots.footerText, theme });
  }
  if (slots.pageNumber != null) {
    pageNumber(slide, slots.pageNumber, { width: W, height: H }, { theme });
  }

  return slide;
}
