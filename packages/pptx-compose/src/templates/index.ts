/**
 * templates (compose 版) — 20 个 declarative DSL 模板.
 *
 * Phase 1 POC: coverHero / titleBody / twoColumn
 * Phase 2 完整迁移: 17 更多 (bulletList / timeline / kpiCards / dataTable / quotePage /
 *   sectionDivider / chartFocus / imageGallery / manifesto / featureGrid /
 *   photoSpread / editorialSplit / threeColumn / numbersHero / contrast /
 *   heroImageQuote / dataFocus)
 */

export { coverHero } from './cover-hero.js';
export type { CoverHeroSlots } from './cover-hero.js';
export { titleBody } from './title-body.js';
export type { TitleBodySlots } from './title-body.js';
export { twoColumn } from './two-column.js';
export type { TwoColumnSlots } from './two-column.js';
export { bulletList } from './bullet-list.js';
export type { BulletListSlots } from './bullet-list.js';
export { timeline } from './timeline.js';
export type { TimelineSlots } from './timeline.js';
export { kpiCards } from './kpi-cards.js';
export type { KpiCardsSlots } from './kpi-cards.js';
export { dataTable } from './data-table.js';
export type { DataTableSlots } from './data-table.js';
export { quotePage } from './quote-page.js';
export type { QuotePageSlots } from './quote-page.js';
export { sectionDivider } from './section-divider.js';
export type { SectionDividerSlots } from './section-divider.js';
export { chartFocus } from './chart-focus.js';
export type { ChartFocusSlots } from './chart-focus.js';
export { imageGallery } from './image-gallery.js';
export type { ImageGallerySlots } from './image-gallery.js';
export { manifesto } from './manifesto.js';
export type { ManifestoSlots } from './manifesto.js';
export { featureGrid } from './feature-grid.js';
export type { FeatureGridSlots, FeatureItem } from './feature-grid.js';
export { photoSpread } from './photo-spread.js';
export type { PhotoSpreadSlots } from './photo-spread.js';
export { editorialSplit } from './editorial-split.js';
export type { EditorialSplitSlots } from './editorial-split.js';
export { threeColumn } from './three-column.js';
export type { ThreeColumnSlots } from './three-column.js';
export { numbersHero } from './numbers-hero.js';
export type { NumbersHeroSlots } from './numbers-hero.js';
export { contrast } from './contrast.js';
export type { ContrastSlots } from './contrast.js';
export { heroImageQuote } from './hero-image-quote.js';
export type { HeroImageQuoteSlots } from './hero-image-quote.js';
export { dataFocus } from './data-focus.js';
export type { DataFocusSlots } from './data-focus.js';
export { agenda } from './agenda.js';
export type { AgendaSlots } from './agenda.js';

export {
  NEOX_THEME, contentBounds, PAGE,
  activeTheme, setActiveTheme, withActiveTheme,
  activeSpec, setActiveSpec, withActiveStyle, applyStyleTransition,
} from './theme.js';

/* Footer and page number are applied once per slide by the caller. */
export { slideChrome } from './motif-bits.js';
export { lighten, darken, bestTextOn, uniformTextOn, hueRotatePalette } from './motif-bits.js';

/* 语义图示组件 —— 内容级, 和 motif-bits 的装饰级分开 */
export {
  flowArrow, versusBlock, pyramidStack, funnelStack,
  slabPath, circlePath, chevronPath, trapezoidPath,
} from './diagram-bits.js';
export type {
  FlowStep, FlowArrowOptions, VersusSide, VersusBlockOptions,
  StackLevel, VectorPath,
} from './diagram-bits.js';

/* 阶梯箭头 / 折带流程 / 3D 讲台 */
export { stairArrow, foldRibbon, chevronFlow, podium3D, tilePath, upArrowPath } from './step-figures.js';
export type { StairItem, StairArrowOptions, FoldRibbonOptions, ChevronFlowOptions, Podium3DOptions } from './step-figures.js';

/* 节点链 —— 轨道 × 节点 × 连接器 × 标注 (稻壳那批流程图的通用语法) */
export { nodeChain, chainCaptions, ribbonArrowPath } from './chain-bits.js';
export type { ChainStep, NodeChainOptions, TrackKind, RibbonArrowOptions } from './chain-bits.js';

/* 数值的形状 —— 进度环/评分点阵/迷你趋势线/占比条/目标条. 必须准确表达, 不许微调 */
export { progressRing, ratingDots, sparkline, proportionBar, bulletBar, arcPath } from './dataviz-bits.js';
export type {
  ProgressRingOptions, RatingDotsOptions, SparklineOptions,
  ProportionBarOptions, ProportionSegment, BulletBarOptions,
} from './dataviz-bits.js';

/* 矢量装饰层 —— 无语义, 只负责让版面有分量。必须在内容之前调用 (z 序=调用序) */
export { pageDecor, blobPath, dotFieldPath, concentricArcsPath } from './decor-vector.js';
/* 内置精细纹样 (钞票细线纹 / 纹章 / 同心环) —— 纯矢量, 秒出, 跟主题色走 */
export { guillochePath, rosettePath, ringsPath } from './ornaments.js';
export type { RosetteRing } from './ornaments.js';
export type { PageDecorOptions, DecorVariant, DecorCorner } from './decor-vector.js';

/* 语义图标系统 —— 只在图标和内容有真实对应关系时用 */
export { iconMark, iconGlyph, ICON_NAMES, hasIcon } from './icon-bits.js';
export type { IconName, IconMarkOptions } from './icon-bits.js';

/* 以图示为主体的四个页型 —— 组件必须有页型才到得了 agent 手里 */
export { processFlow, versusPage, hierarchyPage, funnelPage, orbitPage } from './diagram-pages.js';
export type {
  ProcessFlowSlots, VersusPageSlots, TaperPageSlots, OrbitPageSlots,
} from './diagram-pages.js';
/** Adjust the theme accent for a caller-provided background while preserving
 * the small-text contrast requirement. */
export { readableAccent } from './motif-bits.js';
