/**
 * templates — Codex Grid 精简版 10 模板, 覆盖 80% 场景.
 *
 * 每模板 export:
 *   · meta — agent 决策元数据 (useWhen/avoidWhen/slots/typographyBudget/densityBudget)
 *   · <name>() — build 函数, 加一张 slide 到 Presentation
 *
 * Agent 使用模式: 读 ALL_TEMPLATE_METAS → 按内容意图匹配 → 调对应 build 函数.
 */

export { coverHero, meta as coverHeroMeta } from './cover-hero.js';
export { titleBody, meta as titleBodyMeta } from './title-body.js';
export { twoColumn, meta as twoColumnMeta } from './two-column.js';
export { imageGallery, meta as imageGalleryMeta } from './image-gallery.js';
export { timeline, meta as timelineMeta } from './timeline.js';
export { kpiCards, meta as kpiCardsMeta } from './kpi-cards.js';
export { dataTable, meta as dataTableMeta } from './data-table.js';
export { quotePage, meta as quotePageMeta } from './quote-page.js';
export { sectionDivider, meta as sectionDividerMeta } from './section-divider.js';
export { bulletList, meta as bulletListMeta } from './bullet-list.js';
export { chartFocus, meta as chartFocusMeta } from './chart-focus.js';
/* 【 · 设计师模板】 */
export { heroImageQuote, meta as heroImageQuoteMeta } from './hero-image-quote.js';
export { dataFocus, meta as dataFocusMeta } from './data-focus.js';
export { manifesto, meta as manifestoMeta } from './manifesto.js';
export { featureGrid, meta as featureGridMeta } from './feature-grid.js';
export { photoSpread, meta as photoSpreadMeta } from './photo-spread.js';
export { editorialSplit, meta as editorialSplitMeta } from './editorial-split.js';
export { threeColumn, meta as threeColumnMeta } from './three-column.js';
export { numbersHero, meta as numbersHeroMeta } from './numbers-hero.js';
export { contrast, meta as contrastMeta } from './contrast.js';

import { meta as coverHeroMeta } from './cover-hero.js';
import { meta as titleBodyMeta } from './title-body.js';
import { meta as twoColumnMeta } from './two-column.js';
import { meta as imageGalleryMeta } from './image-gallery.js';
import { meta as timelineMeta } from './timeline.js';
import { meta as kpiCardsMeta } from './kpi-cards.js';
import { meta as dataTableMeta } from './data-table.js';
import { meta as quotePageMeta } from './quote-page.js';
import { meta as sectionDividerMeta } from './section-divider.js';
import { meta as bulletListMeta } from './bullet-list.js';
import { meta as chartFocusMeta } from './chart-focus.js';
import { meta as heroImageQuoteMeta } from './hero-image-quote.js';
import { meta as dataFocusMeta } from './data-focus.js';
import { meta as manifestoMeta } from './manifesto.js';
import { meta as featureGridMeta } from './feature-grid.js';
import { meta as photoSpreadMeta } from './photo-spread.js';
import { meta as editorialSplitMeta } from './editorial-split.js';
import { meta as threeColumnMeta } from './three-column.js';
import { meta as numbersHeroMeta } from './numbers-hero.js';
import { meta as contrastMeta } from './contrast.js';

/** Agent 挑模板用: 全套 metadata 一次给, 让 LLM 按 useWhen/avoidWhen 匹配内容意图. */
export const ALL_TEMPLATE_METAS = [
  coverHeroMeta,
  titleBodyMeta,
  twoColumnMeta,
  imageGalleryMeta,
  timelineMeta,
  kpiCardsMeta,
  dataTableMeta,
  quotePageMeta,
  sectionDividerMeta,
  bulletListMeta,
  chartFocusMeta,
  /* 设计师模板 ·  */
  heroImageQuoteMeta,
  dataFocusMeta,
  manifestoMeta,
  featureGridMeta,
  photoSpreadMeta,
  editorialSplitMeta,
  threeColumnMeta,
  numbersHeroMeta,
  contrastMeta,
] as const;

/** 按 template id 找 build 函数 (给 create_slides JSON tool 用). */
import { coverHero } from './cover-hero.js';
import { titleBody } from './title-body.js';
import { twoColumn } from './two-column.js';
import { imageGallery } from './image-gallery.js';
import { timeline } from './timeline.js';
import { kpiCards } from './kpi-cards.js';
import { dataTable } from './data-table.js';
import { quotePage } from './quote-page.js';
import { sectionDivider } from './section-divider.js';
import { bulletList } from './bullet-list.js';
import { chartFocus } from './chart-focus.js';
import { heroImageQuote } from './hero-image-quote.js';
import { dataFocus } from './data-focus.js';
import { manifesto } from './manifesto.js';
import { featureGrid } from './feature-grid.js';
import { photoSpread } from './photo-spread.js';
import { editorialSplit } from './editorial-split.js';
import { threeColumn } from './three-column.js';
import { numbersHero } from './numbers-hero.js';
import { contrast } from './contrast.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TEMPLATE_BUILDERS: Record<string, (ppt: any, slots: any) => any> = {
  'cover-hero': coverHero,
  'title-body': titleBody,
  'two-column': twoColumn,
  'image-gallery': imageGallery,
  'timeline': timeline,
  'kpi-cards': kpiCards,
  'data-table': dataTable,
  'quote-page': quotePage,
  'section-divider': sectionDivider,
  'bullet-list': bulletList,
  'chart-focus': chartFocus,
  'hero-image-quote': heroImageQuote,
  'data-focus': dataFocus,
  'manifesto': manifesto,
  'feature-grid': featureGrid,
  'photo-spread': photoSpread,
  'editorial-split': editorialSplit,
  'three-column': threeColumn,
  'numbers-hero': numbersHero,
  'contrast': contrast,
};
