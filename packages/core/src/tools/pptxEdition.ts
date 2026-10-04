/**
 * PPT tools edition seam. The open-source build ships without the PPTX engine,
 * so there are no PPT tools and no delivery gate for .pptx surfaces.
 */
import type { Tool } from '@neoxlabs/kernel/types/index.js';

export const PPTX_TOOLS: Tool[] = [];

export type PptxDeliveryVerdict =
  | { status: 'blocked'; report: { mustFixCount: number; slideCount: number; issues: unknown } }
  | { status: 'pass' | 'external' | 'unavailable' };

export interface PptxDeliveryGate {
  inspectPptxForDelivery(pptxPath: string): Promise<PptxDeliveryVerdict>;
  describeVerdict(verdict: PptxDeliveryVerdict): Record<string, unknown>;
}

export const loadPptxDeliveryGate: (() => Promise<PptxDeliveryGate>) | null = null;
