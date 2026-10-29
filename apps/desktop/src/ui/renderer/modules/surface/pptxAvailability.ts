/**
 * 这个构建有没有 PPT 引擎 —— 文案和快捷入口按它决定提不提 PPT。
 *
 * 单独一个文件, 不并进 pptxEngine.ts: 那边 re-export 了渲染器, 首页文案 import 它会把
 * 整个 PPT 渲染器拖进首屏 chunk。公开树里本文件由覆盖层换成 false (PPT 引擎不开源)。
 */
export const PPTX_AVAILABLE: boolean = true;
