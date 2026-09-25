/**
 * @openneox/pptx-renderer — 主出口
 *
 * 三条 API 面向不同消费者:
 *   · builder (isomorphic) — agent 用来生成 pptx (Node/Electron 主进程/浏览器都能跑)
 *   · exporter (isomorphic) — 把 Presentation 转成真 .pptx 字节
 *   · parser + renderer (browser) — 用户端预览: 解 pptx → React 组件绘 DOM
 */

/* ---------- model (类型层, 避免和 builder Presentation 类重名) ----------
 * model/types 里的 Presentation interface 重新导出为 PresentationModel;
 * builder/index.ts 的 Presentation class 保持原名 (对齐 Codex API 心智).
 * 其它类型 (Slide/Shape/TextShape 等) 直接 re-export.
 */
export type {
  Presentation as PresentationModel,
  Slide as SlideModel,
  Shape, TextShape, PictureShape, ShapeRect, ShapeBase,
  Paragraph, TextRun, TextRunStyle, Frame, Fill, Theme, MediaMap,
  SlideMaster, SlideLayout, Placeholder,
} from './model/types.js';
export * from './model/units.js';
export * from './model/defaults.js';
export * from './model/schema.js';

/* ---------- builder (isomorphic) ---------- */
export {
  Presentation, Slide, ShapeHandle, ImageHandle,
  ShapesCollection, ImagesCollection, SlidesCollection,
} from './builder/index.js';
export type { PresentationOptions, ShapeAddOptions, ImageAddOptions, ImageSource, TextStyleInput } from './builder/index.js';

/* ---------- exporter (isomorphic) ---------- */
export { exportPptx, PresentationFile } from './exporter/index.js';

/* SVG path → OOXML custGeom + 路径圆角化 —— 让上层 (compose / skill / 模型产出)
 * 能直接用任意矢量形状, 不再被 prstGeom 的 180 个预设卡住。 */
export {
  svgPathToCustGeom, roundPathCorners, SvgPathParseError, CUST_GEOM_SPACE,
} from './exporter/ooxml/svgPathToCustGeom.js';

/* ---------- parser (browser-side, 需要 DOMParser) ---------- */
export { parsePptx } from './parser/index.js';

/* ---------- renderer (browser-side, 需要 React) ---------- */
export { SlideView, emuToPx } from './renderer/index.js';

/* deck 构建态预览 —— 边生成边在 Surface 右侧看着 PPT 一页页长出来  */
export { renderDeckPreviewHtml } from './renderer/deck-preview.js';
export type { DeckPreviewSlide, DeckPreviewOptions, SlideBuildState } from './renderer/deck-preview.js';
export { renderSlideToHtml, renderSlidesToHtml, renderSlideBodyHtml } from './renderer/slide-html.js';

/* ---------- design system (Neox PDS) ---------- */
export * from './design/tokens.js';
export * from './design/primitives.js';

/* ---------- templates ---------- */
export * from './templates/index.js';

/* 图片尺寸探测 (header 解析) —— exporter 的 cover 裁剪和 compose 的测量共用同一份 */
export { probeImageSize, type ImageDims } from './model/image-size.js';
