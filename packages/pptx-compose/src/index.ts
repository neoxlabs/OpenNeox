/**
 * @openneox/pptx-compose — 声明式 pptx 布局引擎.
 *
 * 心智: SwiftUI / Compose / React Native Flexbox. Agent 写声明式树, 布局引擎
 * 自动测量 · 分配 · 定位. Overlap 在架构上不可能发生, 内容自适应.
 *
 * 主入口:
 *   · render(slide, tree, opts?) — 一句话把 ComposeNode 树画到 slide
 *   · VStack / HStack / ZStack / Grid / Spacer — 容器 node
 *   · Text / Image / Shape / Table — 内容 node
 *
 * 建立在 @openneox/pptx-renderer 之上 (低层 OOXML builder).
 * 独立包, 后期可完全解耦.
 */

export * from './compose/types.js';
export * from './compose/dsl.js';
export { render, withLayoutReport } from './bridge/render.js';
export type { SlideLayoutReport } from './bridge/render.js';
export type { RenderOptions } from './bridge/render.js';
export { measure } from './layout/measure.js';
export type { MeasureResult } from './layout/measure.js';
export { layout } from './layout/layout.js';
export { fitToBounds, scaleDensity } from './layout/fit.js';
export type { FitReport, FitResult } from './layout/fit.js';
export type { LayoutBox } from './layout/layout.js';
export { paint } from './bridge/paint.js';
export { assertNoOverlap } from './layout/assert-no-overlap.js';
export type { OverlapReport } from './layout/assert-no-overlap.js';
export { measureText, estimateCharWidth, estimateLineHeight } from './layout/text-metrics.js';
export type { TextMeasureOptions, TextMeasureResult } from './layout/text-metrics.js';

/* 精准测量基座 (架构升级): 真实字体 metrics + 行高策略 + 图片尺寸探测.
 * inspect / renderSlides 等外部脚本 import 这些做和 layout 引擎一致的精确判定. */
export {
  resolveFontMetrics,
  resolveLineHeightPt,
  charAdvanceEm,
  isEastAsianChar,
} from './layout/font-metrics.js';
export type { FontMetricsRecord } from './layout/font-metrics.js';
export { resolveTextFonts } from './layout/text-fonts.js';
export { probeImageSize } from './layout/image-size.js';

/* 模板 (compose 版 · 20 个全套) */
export * from './templates/index.js';
export * from './templates/themes.js';

/* HTML → PNG 装饰嵌入 pipeline (WPS 稻壳级视觉的钥匙) */
export * from './decor/index.js';

/* 风格系统 —— 冻结的设计 token + 形态语言  */
export * from './style/index.js';
