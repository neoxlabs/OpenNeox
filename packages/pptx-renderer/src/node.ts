/**
 * @neoxlabs/pptx-renderer/node — Node/agent-shell 专用出口
 *
 * 只暴露 isomorphic 部分 (builder / exporter / model / design / templates);
 * 不 re-export renderer (React) / parser (JSZip 会拉但 DOMParser 缺少),
 * 让 agent 从纯 Node .mjs 里 dynamic import 这个模块时零外部依赖.
 *
 * 用法 (agent 生成的 deck.mjs):
 *   const lib = await import(process.env.NEOX_PPTX_LIB);
 *   const { Presentation, exportPptx, cover-hero, bulletList, ... } = lib;
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

export {
  Presentation, Slide, ShapeHandle, ImageHandle,
  ShapesCollection, ImagesCollection, SlidesCollection,
} from './builder/index.js';
export type { PresentationOptions, ShapeAddOptions, ImageAddOptions, ImageSource, TextStyleInput } from './builder/index.js';

export { exportPptx, PresentationFile } from './exporter/index.js';

export { parsePptx } from './parser/index.js';
export { renderSlideToHtml, renderSlidesToHtml } from './renderer/slide-html.js';
export type { SlideHtmlOptions } from './renderer/slide-html.js';

export * from './design/tokens.js';
export * from './design/primitives.js';

export * from './templates/index.js';
