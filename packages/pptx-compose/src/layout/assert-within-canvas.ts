/**
 * assert-within-canvas — 内容有没有画到版面外.
 *
 * 只检查内容叶子是否超出版面；装饰层和显式 bleed 节点允许越界。
 * 检查使用布局框，而不是具体渲染 bounds。
 */

import type { LayoutBox } from './layout.js';
import type { ComposeNode } from '../compose/types.js';

export interface OverflowItem {
  kind: string;
  /** 超出版面最多的那一边, px */
  by: number;
  side: 'top' | 'right' | 'bottom' | 'left';
  text?: string;
}

export interface OverflowReport {
  hasOverflow: boolean;
  items: OverflowItem[];
}

/** 容差: 圆整和字形侧边距会带来亚像素级的溢出, 不值得报 */
const EPS = 2;

export function assertWithinCanvas(
  root: LayoutBox,
  canvas: { width: number; height: number },
): OverflowReport {
  const items: OverflowItem[] = [];
  collect(root, canvas, items);
  items.sort((a, b) => b.by - a.by);
  return { hasOverflow: items.length > 0, items };
}

function collect(box: LayoutBox, canvas: { width: number; height: number }, out: OverflowItem[]): void {
  const kind = box.node.kind;
  if (kind === 'vstack' || kind === 'hstack' || kind === 'zstack' || kind === 'grid') {
    for (const c of box.children ?? []) collect(c, canvas, out);
    return;
  }
  if (box.frame.width <= 0 || box.frame.height <= 0) return;
  if (!isContent(box.node)) return;
  if ((box.node.layoutParams as any)?.bleed) return;

  const f = box.frame;
  const sides: Array<[OverflowItem['side'], number]> = [
    ['left', -f.x],
    ['top', -f.y],
    ['right', f.x + f.width - canvas.width],
    ['bottom', f.y + f.height - canvas.height],
  ];
  let worst: [OverflowItem['side'], number] = ['bottom', 0];
  for (const s of sides) if (s[1] > worst[1]) worst = s;
  if (worst[1] <= EPS) return;

  out.push({
    kind,
    by: Math.round(worst[1]),
    side: worst[0],
    text: kind === 'text' ? String((box.node as any).text ?? '').slice(0, 28) : undefined,
  });
}

function isContent(node: ComposeNode): boolean {
  return node.kind === 'text' || node.kind === 'image' || node.kind === 'table';
}
