/**
 * assert-no-overlap — layout 断言 · 遍历所有 leaf box 检测 pairwise overlap.
 *
 * 目的：在导出前发现内容框之间的意外重叠；渲染器的字体差异仍由导出校验处理。
 *
 * 检测规则:
 *   · 只查 leaf (text/image/table/shape) · 装饰 rect (fill 类) 允许叠 (背景 + 上层内容天然要叠)
 *   · pairwise · O(n²), n < 50 一般, 性能 OK
 *   · IoU > 5% 视为"意外重叠"
 *   · 允许**尺寸为 0**的 placeholder shape (compose 里用 Shape({width:0,height:0}) 做 empty slot)
 */

import type { LayoutBox } from './layout.js';
import type { ComposeNode } from '../compose/types.js';

export interface OverlapReport {
  hasOverlap: boolean;
  overlaps: Array<{
    a: { kind: string; frame: Rect };
    b: { kind: string; frame: Rect };
    iou: number;
  }>;
}
interface Rect { x: number; y: number; width: number; height: number }

/**
 * 遍历布局树, 收集所有 leaf content box, 报告 pairwise overlap.
 * Container 本身不检查 (它们只是布局工具).
 */
export function assertNoOverlap(root: LayoutBox): OverlapReport {
  const leafs: Array<{ kind: string; frame: Rect }> = [];
  collectLeafs(root, leafs);

  const overlaps: OverlapReport['overlaps'] = [];
  for (let i = 0; i < leafs.length; i++) {
    for (let j = i + 1; j < leafs.length; j++) {
      const A = leafs[i]!.frame;
      const B = leafs[j]!.frame;
      const iou = iouOf(A, B);
      if (iou > 0.05) {
        overlaps.push({ a: leafs[i]!, b: leafs[j]!, iou });
      }
    }
  }
  return { hasOverlap: overlaps.length > 0, overlaps };
}

function collectLeafs(box: LayoutBox, out: Array<{ kind: string; frame: Rect }>): void {
  const kind = box.node.kind;
  const isContainer = kind === 'vstack' || kind === 'hstack' || kind === 'zstack' || kind === 'grid';
  if (isContainer) {
    for (const c of box.children ?? []) collectLeafs(c, out);
    return;
  }
  /* 忽略尺寸 0 的 placeholder */
  if (box.frame.width <= 0 || box.frame.height <= 0) return;
  /* 允许背景色 rect 叠 (容器背景+content 天然要叠) */
  const isDecorativeBg = kind === 'shape' && !hasContent(box.node);
  if (isDecorativeBg) return;

  /* bleed 节点是显式声明的背景层，允许与内容重叠。 */
  if ((box.node.layoutParams as any)?.bleed) return;
  out.push({
    kind,
    frame: {
      x: box.frame.x, y: box.frame.y,
      width: box.frame.width, height: box.frame.height,
    },
  });
}

function hasContent(node: ComposeNode): boolean {
  /* Text/Image/Table 是内容; Shape 通常是装饰 */
  return node.kind === 'text' || node.kind === 'image' || node.kind === 'table';
}

function iouOf(a: Rect, b: Rect): number {
  const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const inter = ix * iy;
  if (inter <= 0) return 0;
  const areaA = a.width * a.height;
  const areaB = b.width * b.height;
  return inter / Math.min(areaA, areaB);
}
