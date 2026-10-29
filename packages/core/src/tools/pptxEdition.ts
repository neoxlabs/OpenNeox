import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { createSlidesTool, listSlideTemplatesTool } from './pptx/createSlidesTool.js';
import { DECK_TOOLS } from './pptx/deckTools.js';
import { PPTX_EDIT_TOOLS } from './pptx/pptxEditTools.js';
import { importStyleTool } from './pptx/importStyleTool.js';

export const PPTX_TOOLS: Tool[] = [
  createSlidesTool, listSlideTemplatesTool, ...DECK_TOOLS, ...PPTX_EDIT_TOOLS, importStyleTool,
];

/** open_surface 只用到闸门结论的这几个字段 (完整类型在 pptx/pptxDeliveryGate.ts) */
export type PptxDeliveryVerdict =
  | { status: 'blocked'; report: { mustFixCount: number; slideCount: number; issues: unknown } }
  | { status: 'pass' | 'external' | 'unavailable' };

/** work:H-19 — 拦截时回给模型的压缩 issue 清单 (实现见 pptx/pptxDeliveryGate.ts) */
export interface CompactPptxIssues {
  issues: string[];
  shown: number;
  dropped: number;
  mustFixCount: number;
  /** 已装进 1.5K 预算的完整返回体 (含 error / next), 调用方直接序列化 */
  payload: Record<string, unknown>;
}

export interface PptxDeliveryGate {
  inspectPptxForDelivery(pptxPath: string): Promise<PptxDeliveryVerdict>;
  describeVerdict(verdict: PptxDeliveryVerdict): Record<string, unknown>;
  /** 把 blocked 报告压成 ≤1.5K 的带定位清单 */
  blockedPptxIssues(report: { issues: unknown; mustFixCount: number }): CompactPptxIssues;
}

/** open_surface 的 pptx 交付闸门; null = 本发行版没有 PPT 引擎, 不拦 */
export const loadPptxDeliveryGate: (() => Promise<PptxDeliveryGate>) | null =
  () => import('./pptx/pptxDeliveryGate.js');
