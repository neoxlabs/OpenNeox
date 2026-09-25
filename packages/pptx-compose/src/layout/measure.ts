/**
 * layout/measure — 第一遍 · 每 node 报告 preferred size.
 *
 * Bottom-up 递归. 每个 node 收到 Constraints (最大能占多大), 返回 Measured (它想占多大).
 * Container node 先测子, 再算自己. Leaf node (Text/Image/Shape/Table) 直接算.
 *
 * 关键: measure 只算尺寸, 不定位. 定位在 layout 阶段.
 */

import type { ComposeNode, Constraints, Measured, LayoutParams, TextParams } from '../compose/types.js';
import { measureText } from './text-metrics.js';
import { resolveTextFonts } from './text-fonts.js';
import { probeImageSize } from './image-size.js';
import { normalizeInsets, horizontalInsets, verticalInsets } from './insets.js';

/** node 的测量结果 · 存本节点尺寸 + 子节点 measurements (供 layout 阶段用) */
export interface MeasureResult {
  node: ComposeNode;
  size: Measured;
  children?: MeasureResult[];
}

export function measure(node: ComposeNode, constraints: Constraints): MeasureResult {
  const params = (node.layoutParams ?? {}) as LayoutParams;

  /* 1. 显式 width/height 短路 */
  const explicit = explicitSize(params, constraints);

  /* 2. 根据 kind 分发 */
  let r: MeasureResult;
  switch (node.kind) {
    case 'text':      r = measureLeaf(node, constraints, explicit, measureTextNode); break;
    case 'image':     r = measureLeaf(node, constraints, explicit, measureImageNode); break;
    case 'shape':     r = measureLeaf(node, constraints, explicit, measureShapeNode); break;
    case 'table':     r = measureLeaf(node, constraints, explicit, measureTableNode); break;
    /* minLength = 主轴上的最低尺寸。measure 不知道自己在哪根轴上, 所以两轴都给 ——
     * 交叉轴上它会被 stack 收敛回可用宽度, 不会撑坏版面。 */
    case 'spacer': {
      const min = (params as any).minLength ?? 0;
      r = { node, size: { width: params.width ?? min, height: params.height ?? min } };
      break;
    }
    case 'vstack':    r = measureVStack(node, constraints, explicit); break;
    case 'hstack':    r = measureHStack(node, constraints, explicit); break;
    case 'zstack':    r = measureZStack(node, constraints, explicit); break;
    case 'grid':      r = measureGrid(node, constraints, explicit); break;
  }

  /* 3. 约束下界收口：所有测量入口同时遵守 min/max，保证 flex 分配不会被自然尺寸覆盖。 */
  /* 出血节点不收口 : 一个从右侧出血的 936px 纹章被这里夹成 562×720,
   * 导出的 path 被非等比拉伸成竖椭圆。bleed 就是"我刻意画到版面外"的声明。 */
  if ((node.layoutParams as LayoutParams | undefined)?.bleed) return r;
  return {
    ...r,
    size: {
      width: clamp(r.size.width, constraints.minWidth, constraints.maxWidth),
      height: clamp(r.size.height, constraints.minHeight, constraints.maxHeight),
    },
  };
}

function explicitSize(p: LayoutParams, c: Constraints): Partial<Measured> {
  const out: Partial<Measured> = {};
  /* bleed 声明的节点 (出血装饰/背景) 按声明尺寸量, 不夹进父约束 —— 见 layoutZStack 同名注释 */
  const free = !!p.bleed;
  if (p.width != null) out.width = free ? p.width : clamp(p.width, c.minWidth, c.maxWidth);
  if (p.height != null) out.height = free ? p.height : clamp(p.height, c.minHeight, c.maxHeight);
  return out;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/* ============================================================
 * Leaf 通用: 根据自身 kind 算尺寸, 显式覆盖优先
 * ============================================================ */

function measureLeaf(
  node: ComposeNode,
  constraints: Constraints,
  explicit: Partial<Measured>,
  measurer: (node: any, availableWidth: number) => { width: number; height: number },
): MeasureResult {
  /* 显式尺寸的叶子也把 padding 纳入外框尺寸，layout 再从同一外框中扣除 padding。 */
  const pad = normalizeInsets(node.layoutParams?.padding);
  const innerW = explicit.width ?? (constraints.maxWidth - horizontalInsets(pad));
  const natural = measurer(node, Math.max(0, innerW));
  const w = explicit.width != null
    ? explicit.width + horizontalInsets(pad)
    : Math.min(constraints.maxWidth, natural.width + horizontalInsets(pad));
  const h = explicit.height != null
    ? explicit.height + verticalInsets(pad)
    : Math.min(constraints.maxHeight, natural.height + verticalInsets(pad));
  return {
    node,
    size: {
      width: Math.max(constraints.minWidth, w),
      height: Math.max(constraints.minHeight, h),
    },
  };
}

function measureTextNode(node: any, availableWidth: number): Measured {
  const p = (node.layoutParams ?? {}) as TextParams;
  const fontSize = p.fontSize ?? 16;
  const displayText = p.uppercase ? String(node.text).toUpperCase() : node.text;
  const fonts = resolveTextFonts(p);
  /* 精准测量: 真实字体 advance 断行 + 钉死行高 (paint 会把同一行高写进 pptx lnSpc) */
  const m = measureText(displayText, fontSize, availableWidth, {
    singleLine: p.singleLine,
    maxLines: p.maxLines,
    bold: p.bold,
    fontLatin: fonts.fontLatin,
    fontEast: fonts.fontEast,
    letterSpacingPt: p.letterSpacingPt,
    lineHeightPt: p.lineHeightPt,
  });
  /* 宽度 +4px 微量余量: 框宽若正好 == 文字宽, 下游任何复测 (inspect 的 2px 断行安全边 /
   * EMU 圆整 / office 自己的 hinting) 都会把恰好塞下的行判成换行. 4px > 所有这些扰动,
   * 且视觉不可见. 这不是旧世界的 25% buffer — 是圆整余量. */
  return { width: Math.min(availableWidth, m.width + 4), height: m.height };
}

function measureImageNode(node: any, availableWidth: number): Measured {
  const p = node.layoutParams ?? {};
  const w = availableWidth;
  /* 纵横比优先级: 显式 aspectRatio > 从图片字节真读 > 4:3 兜底 (uri 等拿不到字节的场景) */
  let ratio: number | null = p.aspectRatio ?? null;
  if (ratio == null) {
    const dims = probeImageSize(node.source);
    if (dims) ratio = dims.width / dims.height;
  }
  const h = ratio ? w / ratio : w * 0.75;
  return { width: w, height: h };
}

function measureShapeNode(node: any, availableWidth: number): Measured {
  const p = node.layoutParams ?? {};
  return { width: availableWidth, height: p.height ?? 48 };
}

/* 表格测量 — 镜像 exporter tableShapeXml 的真实参数:
 *   cell 内边距 marL/marR=72000 EMU (7.5px each) · marT/marB=36000 EMU (3.78px each)
 *   header 字号 15pt · 正文 14pt · <a:tr h> 是最小行高, office 按内容自动长高.
 * 所以行高必须按内容测, 否则单元格换行时整表比我们分配的框高 → 溢出. */
const TABLE_CELL_PAD_H = 15.1;  /* px · marL+marR */
const TABLE_CELL_PAD_V = 7.6;   /* px · marT+marB */
const TABLE_MIN_ROW_H = 42;     /* px · exporter 默认 <a:tr h=400000 EMU> */
const TABLE_HEADER_PT = 15;
const TABLE_BODY_PT = 14;
const PT_TO_PX_TBL = 96 / 72;

/**
 * 表格每一行的自然高度 (px) · [表头, ...数据行].
 *
 * 【 抽出来】这套逐格测量本来只服务于"这张表要占多高", 算完就丢了;
 * paint 只把总高传给 builder, builder 于是按写死的 44/40px 写 <a:tr h> ——
 * 那是"每格只有一行"的假设。单元格一折行, Office 自动撑高, 表格真实高度就超过
 * 我们预留的框。测量早就知道答案, 只是从没传下去。
 */
export function tableRowHeights(node: any, availableWidth: number): number[] {
  const p = node.layoutParams ?? {};
  const headers: string[] = node.headers ?? [];
  const rows: string[][] = node.rows ?? [];
  const colCount = Math.max(headers.length, ...rows.map((r: string[]) => r.length), 1);
  const weights: number[] = Array.isArray(p.columnWidths) && p.columnWidths.length === colCount
    ? p.columnWidths
    : Array(colCount).fill(1);
  const totalW = weights.reduce((s: number, w: number) => s + w, 0) || 1;
  const colWidths = weights.map((w: number) => (w / totalW) * availableWidth);

  const rowHeight = (cells: string[], fontPt: number, bold: boolean): number => {
    let maxH = 0;
    for (let c = 0; c < colCount; c++) {
      const cellW = Math.max(8, colWidths[c]! - TABLE_CELL_PAD_H);
      const m = measureText(String(cells[c] ?? ''), fontPt, cellW, { bold });
      maxH = Math.max(maxH, m.height);
    }
    return Math.max(TABLE_MIN_ROW_H, maxH + TABLE_CELL_PAD_V);
  };

  const out: number[] = [];
  if (headers.length > 0) out.push(rowHeight(headers, TABLE_HEADER_PT, true));
  for (const row of rows) out.push(rowHeight(row, TABLE_BODY_PT, false));
  return out;
}

function measureTableNode(node: any, availableWidth: number): Measured {
  /* 走同一份逐行计算 —— 两处各写一遍公式迟早漂移 */
  let height = tableRowHeights(node, availableWidth).reduce((a, b) => a + b, 0);
  /* 保底: 空表也占一行 */
  if (height === 0) height = TABLE_MIN_ROW_H;

  return { width: availableWidth, height };
}

/* ============================================================
 * VStack: 主轴 = 垂直. 交叉轴 = 水平.
 * 算法:
 *   1. 收集显式尺寸 + 无 flex 子的 preferred height
 *   2. 用剩余高度按 flex 权重瓜分给 flex 子
 *   3. 每个子的宽度 = 容器宽 (or align='start/center/end' 时按其 preferred)
 * ============================================================ */

function measureVStack(
  node: any, constraints: Constraints, explicit: Partial<Measured>,
): MeasureResult {
  const p = node.layoutParams ?? {};
  const padding = normalizeInsets(p.padding);
  const gap = p.gap ?? 0;
  const availW = (explicit.width ?? constraints.maxWidth) - horizontalInsets(padding);
  const availH = (explicit.height ?? constraints.maxHeight) - verticalInsets(padding);

  const children = node.children as ComposeNode[];
  const gapTotal = gap * Math.max(0, children.length - 1);

  /* 第一次测: 无约束高 · 拿 preferred height + 记 flex 权重 */
  const firstPass: MeasureResult[] = children.map((c) =>
    measure(c, { minWidth: 0, maxWidth: availW, minHeight: 0, maxHeight: Infinity }),
  );

  const flexTotal = children.reduce((s, c) => s + ((c.layoutParams as any)?.flex ?? 0), 0);
  const inflexHeight = firstPass.reduce((s, r, i) => {
    const flex = (children[i]!.layoutParams as any)?.flex ?? 0;
    return flex > 0 ? s : s + r.size.height;
  }, 0);
  const flexAvail = Math.max(0, availH - inflexHeight - gapTotal);

  /* 第二次测: flex 子按权重分配 */
  const results: MeasureResult[] = firstPass.map((r, i) => {
    const flex = (children[i]!.layoutParams as any)?.flex ?? 0;
    if (flex <= 0) return r;
    const allocated = flexTotal > 0 ? (flex / flexTotal) * flexAvail : 0;
    return measure(children[i]!, {
      minWidth: 0, maxWidth: availW,
      minHeight: allocated, maxHeight: allocated,
    });
  });

  const contentH = results.reduce((s, r) => s + r.size.height, 0) + gapTotal;
  const maxChildW = results.reduce((s, r) => Math.max(s, r.size.width), 0);

  return {
    node,
    /* 容器同样尊重 constraints.min*，使父级 flex 分配与叶子节点使用一致的约束口径。 */
    size: {
      width: Math.max(constraints.minWidth, explicit.width ?? Math.min(constraints.maxWidth,
        maxChildW + horizontalInsets(padding))),
      height: Math.max(constraints.minHeight, explicit.height ?? Math.min(constraints.maxHeight,
        contentH + verticalInsets(padding))),
    },
    children: results,
  };
}

/* HStack: 镜像 VStack · 主轴 = 水平 */
function measureHStack(
  node: any, constraints: Constraints, explicit: Partial<Measured>,
): MeasureResult {
  const p = node.layoutParams ?? {};
  const padding = normalizeInsets(p.padding);
  const gap = p.gap ?? 0;
  const availW = (explicit.width ?? constraints.maxWidth) - horizontalInsets(padding);
  const availH = (explicit.height ?? constraints.maxHeight) - verticalInsets(padding);

  const children = node.children as ComposeNode[];
  const gapTotal = gap * Math.max(0, children.length - 1);

  const firstPass: MeasureResult[] = children.map((c) =>
    measure(c, { minWidth: 0, maxWidth: Infinity, minHeight: 0, maxHeight: availH }),
  );

  const flexTotal = children.reduce((s, c) => s + ((c.layoutParams as any)?.flex ?? 0), 0);
  const inflexWidth = firstPass.reduce((s, r, i) => {
    const flex = (children[i]!.layoutParams as any)?.flex ?? 0;
    return flex > 0 ? s : s + r.size.width;
  }, 0);
  const flexAvail = Math.max(0, availW - inflexWidth - gapTotal);

  const results: MeasureResult[] = firstPass.map((r, i) => {
    const flex = (children[i]!.layoutParams as any)?.flex ?? 0;
    if (flex <= 0) return r;
    const allocated = flexTotal > 0 ? (flex / flexTotal) * flexAvail : 0;
    return measure(children[i]!, {
      minWidth: allocated, maxWidth: allocated,
      minHeight: 0, maxHeight: availH,
    });
  });

  const contentW = results.reduce((s, r) => s + r.size.width, 0) + gapTotal;
  const maxChildH = results.reduce((s, r) => Math.max(s, r.size.height), 0);

  return {
    node,
    size: {
      width: Math.max(constraints.minWidth, explicit.width ?? Math.min(constraints.maxWidth,
        contentW + horizontalInsets(padding))),
      height: Math.max(constraints.minHeight, explicit.height ?? Math.min(constraints.maxHeight,
        maxChildH + verticalInsets(padding))),
    },
    children: results,
  };
}

function measureZStack(
  node: any, constraints: Constraints, explicit: Partial<Measured>,
): MeasureResult {
  const p = node.layoutParams ?? {};
  const padding = normalizeInsets(p.padding);
  const availW = (explicit.width ?? constraints.maxWidth) - horizontalInsets(padding);
  const availH = (explicit.height ?? constraints.maxHeight) - verticalInsets(padding);

  const children = node.children as ComposeNode[];
  const results: MeasureResult[] = children.map((c) =>
    measure(c, { minWidth: 0, maxWidth: availW, minHeight: 0, maxHeight: availH }),
  );

  const maxW = results.reduce((s, r) => Math.max(s, r.size.width), 0);
  const maxH = results.reduce((s, r) => Math.max(s, r.size.height), 0);

  return {
    node,
    size: {
      width: explicit.width ?? Math.min(constraints.maxWidth, maxW + horizontalInsets(padding)),
      height: explicit.height ?? Math.min(constraints.maxHeight, maxH + verticalInsets(padding)),
    },
    children: results,
  };
}

function measureGrid(
  node: any, constraints: Constraints, explicit: Partial<Measured>,
): MeasureResult {
  const p = node.layoutParams ?? {};
  const padding = normalizeInsets(p.padding);
  const cols = p.columns ?? 3;
  const rowGap = p.rowGap ?? 12;
  const colGap = p.colGap ?? 12;
  const availW = (explicit.width ?? constraints.maxWidth) - horizontalInsets(padding);
  const cellW = (availW - colGap * (cols - 1)) / cols;

  const children = node.children as ComposeNode[];
  const results = children.map((c) =>
    measure(c, { minWidth: cellW, maxWidth: cellW, minHeight: 0, maxHeight: Infinity }),
  );

  const rowCount = Math.ceil(children.length / cols);
  const rowHeights: number[] = [];
  for (let r = 0; r < rowCount; r++) {
    let maxH = 0;
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (idx < results.length) maxH = Math.max(maxH, results[idx]!.size.height);
    }
    rowHeights.push(maxH);
  }
  const contentH = rowHeights.reduce((s, h) => s + h, 0) + rowGap * Math.max(0, rowCount - 1);

  return {
    node,
    size: {
      width: explicit.width ?? Math.min(constraints.maxWidth, availW + horizontalInsets(padding)),
      height: explicit.height ?? Math.min(constraints.maxHeight,
        contentH + verticalInsets(padding)),
    },
    children: results,
  };
}
