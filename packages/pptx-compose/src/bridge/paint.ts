/**
 * bridge/paint — walk 布局树, 把每 node 转成对应的 pptx builder 调用.
 *
 * VStack/HStack/ZStack/Grid 本身不产生 shape · 只递归 children.
 * Text/Image/Shape/Table/背景色 · 产生真正 pptx shape.
 *
 * 背景色/边框/阴影 · 在 container node 上先绘 (作为 rect 底), 再递 children.
 */

import type { Slide } from '@neoxlabs/pptx-renderer';
import type { LayoutBox } from '../layout/layout.js';
import type { ComposeNode, TextNode, ImageNode, ShapeNode, TableNode, LayoutParams } from '../compose/types.js';
import { tableRowHeights } from '../layout/measure.js';
import { truncateToLines } from '../layout/text-metrics.js';
import { resolveLineHeightPt } from '../layout/font-metrics.js';
import { resolveTextFonts } from '../layout/text-fonts.js';
import { probeImageSize } from '../layout/image-size.js';
import { activeTheme } from '../templates/theme.js';
import { mixHex } from '../templates/motif-bits.js';

export function paint(slide: Slide, box: LayoutBox): void {
  const params = (box.node.layoutParams ?? {}) as LayoutParams;

  /* 1. 背景色 · 作为 rect fill 绘 (放最底层) */
  if (params.background) {
    slide.shapes.add({
      geometry: 'rect',
      position: { left: box.frame.x, top: box.frame.y, width: box.frame.width, height: box.frame.height },
      fill: params.background,
      cornerRadius: params.cornerRadius,
      border: params.border ? { color: params.border.color, width: params.border.width } : undefined,
      effects: params.effects,
    });
  }

  /* 2. 按 kind 分发 */
  switch (box.node.kind) {
    case 'text':   paintText(slide, box, box.node as TextNode); return;
    case 'image':  paintImage(slide, box, box.node as ImageNode); return;
    case 'shape':  paintShape(slide, box, box.node as ShapeNode); return;
    case 'table':  paintTable(slide, box, box.node as TableNode); return;
    case 'spacer': return;
    default:       for (const c of box.children ?? []) paint(slide, c); return;
  }
}

function paintText(slide: Slide, box: LayoutBox, node: TextNode): void {
  const p = node.layoutParams ?? {};
  const raw = p.uppercase ? String(node.text).toUpperCase() : node.text;
  const displayText = p.maxLines && !p.singleLine
    ? truncateToLines(String(raw), p.fontSize ?? 16, box.frame.width, p.maxLines, {
        bold: p.bold, letterSpacingPt: p.letterSpacingPt, lineHeightPt: p.lineHeightPt,
        ...resolveTextFonts(p),
      })
    : raw;
  const fonts = resolveTextFonts(p);
  const fontSize = p.fontSize ?? 16;
  const lineSpacingPt = resolveLineHeightPt(fontSize, p.lineHeightPt);
  const handle = slide.shapes.addText(displayText, {
    left: box.frame.x, top: box.frame.y,
    width: box.frame.width, height: box.frame.height,
  }, {
    fontSize: p.fontSize,
    bold: p.bold,
    italic: p.italic,
    color: p.color,
    fontLatin: fonts.fontLatin,
    fontEast: fonts.fontEast,
    letterSpacingPt: p.letterSpacingPt,
    lineSpacingPt,
  });

  const shapeModel = (handle as any)._shape;
  /* 段落内水平对齐 + 垂直对齐 (TextParams 里早就声明了 · 现在真正接通) */
  if (shapeModel?.paragraphs && p.textAlign) {
    for (const para of shapeModel.paragraphs) para.align = p.textAlign;
  }
  if (p.vAlign) handle.vAlign = p.vAlign;

  if (shapeModel && p.singleLine) shapeModel.wrap = 'none';

  if (shapeModel && p.fontSize && p.fontSize >= 60) {
    shapeModel.autoFit = 'none';
  }
}

function coverSrcRect(source: unknown, frameW: number, frameH: number):
  { l: number; t: number; r: number; b: number } | undefined {
  if (frameW <= 0 || frameH <= 0) return undefined;
  const dims = probeImageSize(source);
  if (!dims || !dims.width || !dims.height) return undefined;
  const imgAR = dims.width / dims.height;
  const boxAR = frameW / frameH;
  if (Math.abs(imgAR - boxAR) < 0.001) return undefined;
  if (imgAR > boxAR) {
    /* 图比框宽 —— 裁左右 */
    const keep = boxAR / imgAR;
    const cut = (1 - keep) / 2;
    return { l: cut, t: 0, r: cut, b: 0 };
  }
  /* 图比框高 —— 裁上下 */
  const keep = imgAR / boxAR;
  const cut = (1 - keep) / 2;
  return { l: 0, t: cut, r: 0, b: cut };
}

function paintImage(slide: Slide, box: LayoutBox, node: ImageNode): void {
  if (!node.source) {
    if (box.frame.width <= 0 || box.frame.height <= 0) return;
    const t = activeTheme();
    slide.shapes.add({
      geometry: 'rect',
      position: { left: box.frame.x, top: box.frame.y, width: box.frame.width, height: box.frame.height },
      fill: t.subtle,
      cornerRadius: (node.layoutParams as any)?.cornerRadius ?? 0,
      border: { color: mixHex(t.subtle, t.ink, 0.14), width: 1 },
    } as any);
    return;
  }
  const fit = (node.layoutParams as any)?.fit ?? 'cover';
  slide.images.add({
    source: node.source as any,
    position: { left: box.frame.x, top: box.frame.y, width: box.frame.width, height: box.frame.height },
    fit,
    srcRect: fit === 'cover'
      ? coverSrcRect(node.source, box.frame.width, box.frame.height)
      : undefined,
    filter: (node.layoutParams as any)?.filter,
    effects: (node.layoutParams as any)?.effects,
  });
}

function paintShape(slide: Slide, box: LayoutBox, node: ShapeNode): void {
  const p = node.layoutParams ?? {};
  /* 零/负尺寸 = 模板里的条件占位 (三元里的空 Shape) · 不产生 pptx shape,
   * 否则 inspect 报 zero-size error. */
  if (box.frame.width <= 0 || box.frame.height <= 0) return;
  slide.shapes.add({
    geometry: p.geometry ?? 'rect',
    position: { left: box.frame.x, top: box.frame.y, width: box.frame.width, height: box.frame.height },
    fill: p.fill,
    cornerRadius: p.cornerRadius,
    border: p.border ? { color: p.border.color, width: p.border.width } : undefined,
    effects: p.effects,
    flipH: (p as any).flipH,
    flipV: (p as any).flipV,
    ...(p.geometry === 'custom' && p.customPath ? { customPath: p.customPath } : {}),
    ...((p as any).gradient ? { fillGradient: (p as any).gradient } : {}),
  } as any);
}

function paintTable(slide: Slide, box: LayoutBox, node: TableNode): void {
  const p = node.layoutParams ?? {};
  const rowH = tableRowHeights(node, box.frame.width);
  const needH = rowH.reduce((a, b) => a + b, 0);
  if (needH > box.frame.height + 2) {
    console.warn(`[compose] table overflow: ${node.rows?.length ?? 0} 行内容需要 `
      + `${Math.round(needH)}px, 但这一页只给了 ${Math.round(box.frame.height)}px —— `
      + `超出的行会画到版面外。减少行数、缩短单元格文字, 或拆成两页。`);
  }
  slide.tables.add({
    position: { left: box.frame.x, top: box.frame.y, width: box.frame.width, height: box.frame.height },
    headers: node.headers,
    rows: node.rows,
    headerFill: (p as any).headerFill,
    zebraFill: (p as any).zebraFill,
    /* 逐行自然高度 —— 不传的话 builder 按写死的 44/40px 写 <a:tr h>,
     * 单元格一折行 Office 就自动撑高, 表格跑出版面 (英文长词最容易触发)。
     * 用的是 measure 那份计算, 单一事实源。 */
    rowHeights: rowH,
    columnWidths: p.columnWidths,
    columnAlign: p.columnAlign,
    zebra: p.zebra !== false,
    borderColor: p.borderColor,
  });
}
