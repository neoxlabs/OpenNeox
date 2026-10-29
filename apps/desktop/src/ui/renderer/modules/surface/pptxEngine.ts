/**
 * PPT 预览引擎接缝 —— 渲染层读 .pptx 只经过这里。
 *
 * PPT 引擎 (@neoxlabs/pptx-renderer) 不随公开树导出 (见 scripts/public-export.json),
 * 导出时本文件整体换成 scripts/public-overlay/files 下的同名空实现: parsePptx 直接抛,
 * 预览面板显示「此版本不含 PPT 预览」, 成品卡退回插画。共享代码不用改。
 * 导出写成具名 const / type (不用 `export { } from`): check-edition-boundaries 按名字核对两份。
 */
import { parsePptx as parse, SlideView as View } from '@neoxlabs/pptx-renderer';
import type { PresentationModel as Model } from '@neoxlabs/pptx-renderer';

export type PresentationModel = Model;
export type SlideModel = Model['slides'][number];
export const parsePptx = parse;
export const SlideView = View;
