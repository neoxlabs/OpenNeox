/**
 * layout/layout — 第二遍 · 每 node 拿到 assigned frame 后, 计算所有 child 的绝对位置.
 *
 * Top-down 递归. 输入是 measure 结果 · 输出是每 node 的绝对 Frame.
 * 这一步保证:
 *   - VStack 里 children 垂直堆 (不叠)
 *   - HStack 里 children 水平堆 (不叠)
 *   - ZStack 里 children 按 align 定位
 *   - Grid 里 children 落到行列格子
 */

import type { ComposeNode, Frame } from '../compose/types.js';
import type { MeasureResult } from './measure.js';
import { normalizeInsets } from './insets.js';

/** 布局后每个 node 输出 · 携带绝对 Frame 供 bridge 转 pptx shape */
export interface LayoutBox {
  node: ComposeNode;
  frame: Frame;
  children?: LayoutBox[];
}

export function layout(result: MeasureResult, assigned: Frame): LayoutBox {
  const { node } = result;
  const p = (node.layoutParams ?? {}) as any;
  const padding = normalizeInsets(p.padding);
  const inner: Frame = {
    x: assigned.x + padding.left,
    y: assigned.y + padding.top,
    width: assigned.width - padding.left - padding.right,
    height: assigned.height - padding.top - padding.bottom,
  };

  /* padding 纳入外框尺寸；负的内容框立即报告，避免绘制阶段静默跳过节点。 */
  if (inner.width < 0 || inner.height < 0) {
    console.warn(
      `[compose] ${node.kind} 的 padding 超过了它自己的尺寸, 内容框成了负数 `
      + `(${Math.round(inner.width)}×${Math.round(inner.height)}), 里面的东西**不会被画出来**。`
      + ` 若本意是"把它挪到某个位置", padding 只在**叶子节点**上等价于偏移;`
      + ` 容器请改用外层 ZStack 定位, 或直接给叶子节点加 padding。`,
    );
  }

  switch (node.kind) {
    case 'vstack':  return layoutVStack(result, assigned, inner);
    case 'hstack':  return layoutHStack(result, assigned, inner);
    case 'zstack':  return layoutZStack(result, assigned, inner);
    case 'grid':    return layoutGrid(result, assigned, inner);
    case 'spacer':  return { node, frame: assigned };
    /* 【 修根】叶子节点 (text/image/shape/table) 的 padding 必须消费:
     * measureLeaf 把 padding 加进了 preferred size, 这里就要把 frame 按 padding 缩回去 —
     * 否则 padding 只撑大框不移动内容, 模板里"ZStack + padding 定位"的写法全部塌到 (0,0),
     * pptx 里文本也顶死框边. 消费后: frame = 纯内容区, paint 直接用. */
    default:        return { node, frame: inner };
  }
}

function layoutVStack(result: MeasureResult, assigned: Frame, inner: Frame): LayoutBox {
  const p = result.node.layoutParams as any;
  const gap = p?.gap ?? 0;
  const justify = p?.justify ?? 'start';
  const children = result.children ?? [];

  const totalChildH = children.reduce((s, r) => s + r.size.height, 0);
  const gapTotal = gap * Math.max(0, children.length - 1);
  const contentH = totalChildH + gapTotal;
  const freeH = Math.max(0, inner.height - contentH);

  const { offset: initialOffset, spacing } = justifySpacing(justify, gap, freeH, children.length);
  let cy = inner.y + initialOffset;

  const childBoxes: LayoutBox[] = [];
  for (const r of children) {
    const childW = crossAxisWidth(r, inner.width, p?.align ?? 'stretch');
    const childX = crossAxisX(inner.x, inner.width, childW, r.node, p?.align ?? 'stretch');
    const childFrame: Frame = { x: childX, y: cy, width: childW, height: r.size.height };
    childBoxes.push(layout(r, childFrame));
    cy += r.size.height + spacing;
  }

  return { node: result.node, frame: assigned, children: childBoxes };
}

function layoutHStack(result: MeasureResult, assigned: Frame, inner: Frame): LayoutBox {
  const p = result.node.layoutParams as any;
  const gap = p?.gap ?? 0;
  const justify = p?.justify ?? 'start';
  const children = result.children ?? [];

  const totalChildW = children.reduce((s, r) => s + r.size.width, 0);
  const gapTotal = gap * Math.max(0, children.length - 1);
  const contentW = totalChildW + gapTotal;
  const freeW = Math.max(0, inner.width - contentW);

  const { offset: initialOffset, spacing } = justifySpacing(justify, gap, freeW, children.length);
  let cx = inner.x + initialOffset;

  const childBoxes: LayoutBox[] = [];
  for (const r of children) {
    const childH = crossAxisHeight(r, inner.height, p?.align ?? 'stretch');
    const childY = crossAxisY(inner.y, inner.height, childH, r.node, p?.align ?? 'stretch');
    const childFrame: Frame = { x: cx, y: childY, width: r.size.width, height: childH };
    childBoxes.push(layout(r, childFrame));
    cx += r.size.width + spacing;
  }

  return { node: result.node, frame: assigned, children: childBoxes };
}

function layoutZStack(result: MeasureResult, assigned: Frame, inner: Frame): LayoutBox {
  const p = result.node.layoutParams as any;
  const align = p?.align ?? 'center';
  const children = result.children ?? [];

  const childBoxes: LayoutBox[] = children.map((r) => {
    /* 声明了 bleed 的子节点不夹到父框里。
     * 装饰层和背景构成的形状是**刻意**画到版面外的 (被页边裁掉才读成"底"), 而这里一律
     * Math.min 到父框: 一个 936×936 从右侧出血的纹章被夹成 562×720, 导出时 path 被非等比拉伸,
     * 圆章变成竖着的椭圆、还缺了一截。bleed 本来就是"这是出血背景"的声明, 夹它等于没声明。 */
    const bleedsOut = !!((r.node.layoutParams as any)?.bleed);
    const w = bleedsOut ? r.size.width : Math.min(r.size.width, inner.width);
    const h = bleedsOut ? r.size.height : Math.min(r.size.height, inner.height);
    let x = inner.x;
    let y = inner.y;
    if (align === 'center') { x += (inner.width - w) / 2; y += (inner.height - h) / 2; }
    else if (align === 'end') { x += inner.width - w; y += inner.height - h; }
    /* stretch: 子占满 inner */
    /* ZStack 没有"父 align 决定子尺寸"这回事 (它的 align 是定位, 不是分配),
     * 所以这里保留"子节点自己声明 stretch 就铺满"的老约定, 同时认 alignSelf。 */
    const lp = (r.node.layoutParams as any) ?? {};
    const isStretch = (lp.alignSelf ?? lp.align) === 'stretch';
    if (isStretch) {
      return layout(r, { x: inner.x, y: inner.y, width: inner.width, height: inner.height });
    }
    return layout(r, { x, y, width: w, height: h });
  });

  return { node: result.node, frame: assigned, children: childBoxes };
}

function layoutGrid(result: MeasureResult, assigned: Frame, inner: Frame): LayoutBox {
  const p = result.node.layoutParams as any;
  const cols = p.columns ?? 3;
  const rowGap = p.rowGap ?? 12;
  const colGap = p.colGap ?? 12;
  const children = result.children ?? [];

  const cellW = (inner.width - colGap * (cols - 1)) / cols;

  /* 按行组算行高 */
  const rowCount = Math.ceil(children.length / cols);
  const rowHeights: number[] = [];
  for (let r = 0; r < rowCount; r++) {
    let maxH = 0;
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (idx < children.length) maxH = Math.max(maxH, children[idx]!.size.height);
    }
    rowHeights.push(maxH);
  }

  const rowYs: number[] = [];
  let curY = inner.y;
  for (const h of rowHeights) {
    rowYs.push(curY);
    curY += h + rowGap;
  }

  const childBoxes: LayoutBox[] = children.map((r, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = inner.x + col * (cellW + colGap);
    const y = rowYs[row] ?? inner.y;
    const cellH = rowHeights[row] ?? r.size.height;
    return layout(r, { x, y, width: cellW, height: cellH });
  });

  return { node: result.node, frame: assigned, children: childBoxes };
}

/* ============================================================
 * helpers
 * ============================================================ */

/* 显式尺寸的图形保持自身宽高比；stretch 仅适用于没有固有尺寸的内容，例如可换行文本。 */
function explicitCross(node: ComposeNode, axis: 'width' | 'height'): number | undefined {
  const v = (node.layoutParams as any)?.[axis];
  return typeof v === 'number' ? v : undefined;
}

/* 交叉轴尺寸由父容器的 align 决定，子节点仅通过 alignSelf 单独覆盖父级选择。 */
function selfAlign(r: MeasureResult, defaultAlign: string): string {
  return (r.node.layoutParams as any)?.alignSelf ?? defaultAlign;
}

/* 显式尺寸的外框与 measure 使用相同的 padding 口径，保证内容交叉轴尺寸不会变成负数。 */
function explicitPlusInsets(r: MeasureResult, axis: 'width' | 'height'): number | undefined {
  const explicit = explicitCross(r.node, axis);
  if (explicit == null) return undefined;
  const pad = normalizeInsets((r.node.layoutParams as any)?.padding);
  return explicit + (axis === 'width' ? pad.left + pad.right : pad.top + pad.bottom);
}

function crossAxisWidth(r: MeasureResult, availW: number, defaultAlign: string): number {
  const explicit = explicitPlusInsets(r, 'width');
  if (explicit != null) return Math.min(explicit, availW);
  if (selfAlign(r, defaultAlign) === 'stretch') return availW;
  return Math.min(r.size.width, availW);
}
function crossAxisHeight(r: MeasureResult, availH: number, defaultAlign: string): number {
  const explicit = explicitPlusInsets(r, 'height');
  if (explicit != null) return Math.min(explicit, availH);
  if (selfAlign(r, defaultAlign) === 'stretch') return availH;
  return Math.min(r.size.height, availH);
}
function crossAxisX(baseX: number, availW: number, childW: number, node: ComposeNode, defaultAlign: string): number {
  const align = (node.layoutParams as any)?.alignSelf ?? defaultAlign;
  if (align === 'center') return baseX + (availW - childW) / 2;
  if (align === 'end') return baseX + availW - childW;
  return baseX;
}
function crossAxisY(baseY: number, availH: number, childH: number, node: ComposeNode, defaultAlign: string): number {
  const align = (node.layoutParams as any)?.alignSelf ?? defaultAlign;
  if (align === 'center') return baseY + (availH - childH) / 2;
  if (align === 'end') return baseY + availH - childH;
  return baseY;
}

function justifySpacing(
  justify: string, baseGap: number, freeSpace: number, itemCount: number,
): { offset: number; spacing: number } {
  /* 单个子节点也遵守 center/end 对齐；仅对需要除以节点数量的分布模式做零数量兜底。 */
  if (itemCount <= 0) return { offset: 0, spacing: 0 };
  switch (justify) {
    case 'center':      return { offset: freeSpace / 2, spacing: baseGap };
    case 'end':         return { offset: freeSpace, spacing: baseGap };
    case 'spaceBetween': return itemCount <= 1
      ? { offset: 0, spacing: baseGap }
      : { offset: 0, spacing: baseGap + freeSpace / (itemCount - 1) };
    case 'spaceAround':  return { offset: freeSpace / (itemCount * 2), spacing: baseGap + freeSpace / itemCount };
    case 'spaceEvenly':  return { offset: freeSpace / (itemCount + 1), spacing: baseGap + freeSpace / (itemCount + 1) };
    default:             return { offset: 0, spacing: baseGap };
  }
}
