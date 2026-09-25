/**
 * design/primitives — Neox 幻灯片设计系统的原子组件.
 *
 * 每个函数都是"往 slide 上添一段结构化内容", 内部用 tokens 里的字号/间距/颜色,
 * 保证跨模板视觉统一. 模板层就是这些原语的组合谱, 不再手写坐标 & 颜色.
 *
 * 命名规则:
 *   - 名词型 (kicker/heroTitle/caption): 独立文字元素
 *   - 复合名词 (photoCard/metricPill): 独立视觉单元 (含多个 sub-shape)
 *   - 动词型 (divider/pageNumber): 装饰/辅助元素
 */

import type { Slide, ShapeHandle } from '../builder/index.js';
import type { NeoxTheme, TypeSpec } from './tokens.js';
import { TYPE, SPACE, RADII, PAGE, WARM_EDITORIAL, kickerCase } from './tokens.js';

/** Position 简写: {l, t, w, h} px. */
export interface Pos {
  l: number;
  t: number;
  w: number;
  h: number;
}

/** 每个原语的公共 opts 兜底 */
interface PrimitiveBase {
  theme?: NeoxTheme;
  color?: string;
  align?: 'l' | 'ctr' | 'r' | 'just';
}

function T(opts?: { theme?: NeoxTheme }): NeoxTheme {
  return opts?.theme ?? WARM_EDITORIAL;
}

function styleFromSpec(spec: TypeSpec, theme: NeoxTheme, override?: { color?: string; bold?: boolean }) {
  /* 按 fontRole 分别指定 latin/east 字体 · 兼容旧 spec (走 display bool → theme.fonts.display).
   * OOXML 里 fontLatin 落到 <a:latin>, fontEast 落到 <a:ea>. 让"英文衬线 + 中文黑体"这类配对能真起作用. */
  let fontLatin: string | undefined;
  let fontEast: string | undefined;
  if (spec.fontRole === 'display') {
    fontLatin = theme.fonts.displayLatin;
    fontEast = theme.fonts.displayEast;
  } else if (spec.fontRole === 'text') {
    fontLatin = theme.fonts.textLatin;
    fontEast = theme.fonts.textEast;
  } else if (spec.fontRole === 'numeric') {
    fontLatin = theme.fonts.numeric;
    fontEast = theme.fonts.textEast; /* 中文没有 tabular figures 概念, 走 text */
  } else {
    /* 老 spec 只有 display bool. 落到 theme.fonts.display/text (legacy) */
    const legacy = spec.display ? theme.fonts.display : theme.fonts.text;
    fontLatin = legacy;
    fontEast = legacy;
  }
  return {
    fontLatin,
    fontEast,
    /* legacy 兼容: 有些消费方还看 fontFamily. 优先给 east 那个 (中文优先, 因为大多数场景中文更多) */
    fontFamily: fontEast || fontLatin,
    fontSize: spec.fontSize,
    bold: override?.bold ?? spec.weight >= 600,
    color: override?.color ?? theme.palette.ink,
    letterSpacingPt: spec.letterSpacingPt,
  };
}

/* ============================================================
 * TEXT PRIMITIVES · 排版核心
 * ============================================================ */

/** kicker · 眉标 (小字 + 大字距 + 常见于标题上方). 英文自动大写, 中文原样. */
export function kicker(slide: Slide, text: string, pos: Pos, opts?: PrimitiveBase): ShapeHandle {
  const theme = T(opts);
  return slide.shapes.addText(kickerCase(text), toXY(pos),
    styleFromSpec(TYPE.kicker, theme, { color: opts?.color ?? theme.palette.accent }),
  );
}

/** heroTitle · 巨型标题 (cover / hero slide). */
export function heroTitle(slide: Slide, text: string, pos: Pos, opts?: PrimitiveBase): ShapeHandle {
  const theme = T(opts);
  return slide.shapes.addText(text, toXY(pos),
    styleFromSpec(TYPE.hero, theme, { color: opts?.color }),
  );
}

/**
 * sectionTitle · 中标题 (section title), 底部自带一根短 accent bar (视觉锚点).
 * 返回文本 shape 引用 (bar 只是装饰).
 */
export function sectionTitle(slide: Slide, text: string, pos: Pos, opts?: PrimitiveBase & { showBar?: boolean }): ShapeHandle {
  const theme = T(opts);
  const h = slide.shapes.addText(text, toXY(pos),
    styleFromSpec(TYPE.h1, theme, { color: opts?.color }),
  );
  if (opts?.showBar !== false) {
    /* accent bar 位于标题正下方. 用 max(box_h, font_line_height) 保证不管 caller 传多小的 box_h
     * 都能落到字体基线下方 (font 36pt · line-height 1.25 ≈ 45px). 再加 SPACE.s 呼吸. */
    const titleFontPx = TYPE.h1.fontSize; /* 36 */
    const barTop = pos.t + Math.max(pos.h, titleFontPx * 1.25) + SPACE.s;
    slide.shapes.addRect({
      left: pos.l,
      top: barTop,
      width: 48,
      height: 4,
    }, theme.palette.accent);
  }
  return h;
}

/** h2Title · 小节标题 (无 bar) */
export function h2Title(slide: Slide, text: string, pos: Pos, opts?: PrimitiveBase): ShapeHandle {
  const theme = T(opts);
  return slide.shapes.addText(text, toXY(pos),
    styleFromSpec(TYPE.h2, theme, { color: opts?.color }),
  );
}

/** h3Title · 卡内标题 */
export function h3Title(slide: Slide, text: string, pos: Pos, opts?: PrimitiveBase): ShapeHandle {
  const theme = T(opts);
  return slide.shapes.addText(text, toXY(pos),
    styleFromSpec(TYPE.h3, theme, { color: opts?.color }),
  );
}

/** bodyText · 正文 · 默认 muted 色更沉着 */
export function bodyText(slide: Slide, text: string, pos: Pos, opts?: PrimitiveBase): ShapeHandle {
  const theme = T(opts);
  return slide.shapes.addText(text, toXY(pos),
    styleFromSpec(TYPE.body, theme, { color: opts?.color ?? theme.palette.ink }),
  );
}

/** bodyLarge · 强调正文 (cover subtitle 常用) */
export function bodyLarge(slide: Slide, text: string, pos: Pos, opts?: PrimitiveBase): ShapeHandle {
  const theme = T(opts);
  return slide.shapes.addText(text, toXY(pos),
    styleFromSpec(TYPE.bodyLarge, theme, { color: opts?.color ?? theme.palette.ink }),
  );
}

/** caption · 说明字, 默认 muted */
export function caption(slide: Slide, text: string, pos: Pos, opts?: PrimitiveBase): ShapeHandle {
  const theme = T(opts);
  return slide.shapes.addText(text, toXY(pos),
    styleFromSpec(TYPE.caption, theme, { color: opts?.color ?? theme.palette.muted }),
  );
}

/** overline · 极小水印字 */
export function overline(slide: Slide, text: string, pos: Pos, opts?: PrimitiveBase): ShapeHandle {
  const theme = T(opts);
  return slide.shapes.addText(kickerCase(text), toXY(pos),
    styleFromSpec(TYPE.overline, theme, { color: opts?.color ?? theme.palette.muted }),
  );
}

/** numeric · 巨型数字 (KPI 卡用) */
export function numeric(slide: Slide, text: string, pos: Pos, opts?: PrimitiveBase): ShapeHandle {
  const theme = T(opts);
  return slide.shapes.addText(text, toXY(pos),
    styleFromSpec(TYPE.numeric, theme, { color: opts?.color ?? theme.palette.accent }),
  );
}

/* ============================================================
 * DECORATION PRIMITIVES · 装饰元素
 * ============================================================ */

/** accentBar · 短彩色横条 (视觉锚点). 默认 accent 色, 宽 48px 高 4px */
export function accentBar(slide: Slide, pos: Pos, opts?: PrimitiveBase & { width?: number; height?: number }): ShapeHandle {
  const theme = T(opts);
  const w = opts?.width ?? 48;
  const h = opts?.height ?? 4;
  return slide.shapes.addRect({ left: pos.l, top: pos.t, width: w, height: h }, opts?.color ?? theme.palette.accent);
}

/** divider · 长细分割线. 默认 subtle 色, 高 1px */
export function divider(slide: Slide, pos: Pos, opts?: PrimitiveBase & { thickness?: number }): ShapeHandle {
  const theme = T(opts);
  return slide.shapes.addRect({
    left: pos.l, top: pos.t, width: pos.w, height: opts?.thickness ?? 1,
  }, opts?.color ?? theme.palette.subtle);
}

/** verticalDivider · 竖分割线 */
export function verticalDivider(slide: Slide, pos: Pos, opts?: PrimitiveBase & { thickness?: number }): ShapeHandle {
  const theme = T(opts);
  return slide.shapes.addRect({
    left: pos.l, top: pos.t, width: opts?.thickness ?? 1, height: pos.h,
  }, opts?.color ?? theme.palette.subtle);
}

/**
 * card · 卡片背景 (圆角矩形). 默认 surface 色, md 圆角.
 * 返回 shape 引用 (可以后续挂 border 等), 但通常直接调完不再改.
 */
export function card(slide: Slide, pos: Pos, opts?: PrimitiveBase & { fill?: string; radius?: number }): ShapeHandle {
  const theme = T(opts);
  return slide.shapes.addRoundRect(toXY(pos), opts?.fill ?? theme.palette.surface, opts?.radius ?? RADII.md);
}

/* ============================================================
 * COMPOSITE PRIMITIVES · 复合视觉单元
 * ============================================================ */

/**
 * heroPhotoBackdrop · 全屏背景图 + gradient 遮罩 (让上层文字对比度够).
 * 用于 cover-hero / section-divider 有图版本.
 */
export function heroPhotoBackdrop(
  slide: Slide,
  source:
    | { blob: ArrayBuffer | Uint8Array; contentType: string }
    | { dataUrl: string }
    | { uri: string },
  slideSize: { width: number; height: number },
  opts?: { overlayColor?: string; overlayFromY?: number; theme?: NeoxTheme },
): void {
  slide.background.fill = '#000000';
  slide.images.add({
    source: source as any,
    position: { left: 0, top: 0, width: slideSize.width, height: slideSize.height },
    fit: 'cover',
  });
  /* 使用全屏微暗遮罩和底部深色遮罩，在保留图片细节的同时确保白色文字可读。 */
  slide.shapes.add({
    geometry: 'rect',
    position: { left: 0, top: 0, width: slideSize.width, height: slideSize.height },
    fill: 'rgba(0, 0, 0, 0.15)', /* 整屏微暗 · 保图片可辨识 */
  });
  const overlayColor = opts?.overlayColor ?? 'rgba(0, 0, 0, 0.72)';
  const fromY = opts?.overlayFromY ?? slideSize.height * 0.5;
  slide.shapes.add({
    geometry: 'rect',
    position: { left: 0, top: fromY, width: slideSize.width, height: slideSize.height - fromY },
    fill: overlayColor,
  });
}

/**
 * bleedBackdrop  · 满出血 · 图 / 色块贴到 slide 边缘, 无 padH 边距.
 * 常用于杂志感 hero. bleedSide 决定哪些边贴 (默认全贴).
 */
export function bleedBackdrop(
  slide: Slide,
  slideSize: { width: number; height: number },
  fill: string,
  opts?: {
    theme?: NeoxTheme;
    bleedSide?: { top?: boolean; right?: boolean; bottom?: boolean; left?: boolean };
    inset?: number; /* 从边缘缩进 · 默认 0 = 完全满出血 */
  },
): void {
  const inset = opts?.inset ?? 0;
  const t = opts?.bleedSide?.top !== false ? inset : PAGE.padTop;
  const l = opts?.bleedSide?.left !== false ? inset : PAGE.padH;
  const r = opts?.bleedSide?.right !== false ? inset : PAGE.padH;
  const b = opts?.bleedSide?.bottom !== false ? inset : PAGE.padBottom;
  slide.shapes.add({
    geometry: 'rect',
    position: {
      left: l,
      top: t,
      width: slideSize.width - l - r,
      height: slideSize.height - t - b,
    },
    fill,
  });
}

/**
 * threeColumnLayout  · 3 栏均分内容布局辅助 · 返回每栏的 { left, top, width, height }.
 * 调用方按位置放 h3Title + bodyText, 中间自动加 verticalDivider.
 * 命名尾巴带 Layout 避免跟 templates/three-column 的 threeColumn 函数撞.
 */
export function threeColumnLayout(
  slideWidth: number,
  cursorY: number,
  contentH: number,
): {
  columns: Array<{ left: number; top: number; width: number; height: number }>;
  dividers: Array<{ x: number; y: number; h: number }>;
} {
  const innerW = slideWidth - PAGE.padH * 2;
  const gap = PAGE.gutter;
  const colW = (innerW - gap * 2) / 3;
  const columns = [0, 1, 2].map((i) => ({
    left: PAGE.padH + i * (colW + gap),
    top: cursorY,
    width: colW,
    height: contentH,
  }));
  const dividers = [1, 2].map((i) => ({
    x: PAGE.padH + i * (colW + gap) - gap / 2,
    y: cursorY,
    h: contentH,
  }));
  return { columns, dividers };
}

/**
 * heroGradientBackdrop 在没有图片时生成覆盖整页的品牌几何背景，
 * 通过多层椭圆、横条和底色保持左右两侧的视觉重量平衡。
 */
export function heroGradientBackdrop(slide: Slide, slideSize: { width: number; height: number }, opts?: { theme?: NeoxTheme }): void {
  const theme = T(opts);
  const { width: W, height: H } = slideSize;
  slide.background.fill = theme.palette.ink;

  /* 右上主椭圆 · accent 淡 · 从边缘溢出 */
  slide.shapes.addEllipse({
    left: W * 0.5, top: -H * 0.25,
    width: W * 0.7, height: W * 0.7,
  }, hexWithAlpha(theme.palette.accent, 0.18));

  /* 右侧中部第二椭圆 · accentSoft */
  slide.shapes.addEllipse({
    left: W * 0.62, top: H * 0.28,
    width: W * 0.42, height: W * 0.42,
  }, hexWithAlpha(theme.palette.accentSoft, 0.12));

  /* 左上一根粗大 accent bar (垂直, 视觉平衡左半区) */
  slide.shapes.addRect({
    left: W * 0.06, top: -H * 0.05,
    width: 8, height: H * 0.45,
  }, hexWithAlpha(theme.palette.accent, 0.85));

  /* 左中一根短 accentSoft 横线 (纹理感) */
  slide.shapes.addRect({
    left: W * 0.06, top: H * 0.52,
    width: W * 0.14, height: 3,
  }, hexWithAlpha(theme.palette.accentSoft, 0.55));

  /* 底部横跨的 accentDeep 细条 (锚脚, 4px 精致感) */
  slide.shapes.addRect({
    left: 0, top: H - 4,
    width: W, height: 4,
  }, hexWithAlpha(theme.palette.accentDeep, 0.9));
}

/**
 * metricPill · KPI 单元 (大数字 + label + 可选 sublabel).
 * 布局: 数字大字上, label 中, sublabel 下. 全部左对齐.
 */
export function metricPill(
  slide: Slide, value: string, label: string, pos: Pos,
  opts?: { sublabel?: string; theme?: NeoxTheme; accentColor?: string; boxed?: boolean; radius?: number },
): void {
  const theme = T(opts);
  const accent = opts?.accentColor ?? theme.palette.accent;

  if (opts?.boxed !== false) {
    card(slide, pos, { theme, fill: '#FFFFFF', radius: opts?.radius ?? RADII.md });
  }

  const padX = SPACE.l;
  const padY = SPACE.l;
  const innerL = pos.l + padX;
  const innerW = pos.w - padX * 2;

  /* 数字 */
  numeric(slide, value, { l: innerL, t: pos.t + padY, w: innerW, h: 66 }, { theme, color: accent });
  /* label */
  bodyLarge(slide, label, { l: innerL, t: pos.t + padY + 74, w: innerW, h: 28 }, { theme, color: theme.palette.ink });
  /* sublabel */
  if (opts?.sublabel) {
    caption(slide, opts.sublabel, { l: innerL, t: pos.t + padY + 108, w: innerW, h: 40 }, { theme, color: theme.palette.muted });
  }
}

/**
 * photoCard · 图片卡片 (可选 caption). 图片 cover 铺满, caption 在底部 overlay.
 */
export function photoCard(
  slide: Slide,
  source:
    | { blob: ArrayBuffer | Uint8Array; contentType: string }
    | { dataUrl: string }
    | { uri: string },
  pos: Pos,
  opts?: { caption?: string; theme?: NeoxTheme },
): void {
  const theme = T(opts);
  /* source 必须包含可解析的图片地址或数据；缺失时抛错，让调用方选择显式无图模板。 */
  const hasContent = !!source && (
    typeof source === 'string' || (typeof source === 'object' && (
      !!(source as any).blob || !!(source as any).dataUrl
      || !!(source as any).uri || !!(source as any).url
      || !!(source as any).src || !!(source as any).href
      || !!(source as any).imageUrl || !!(source as any).image_url
    ))
  );
  if (!hasContent) {
    throw new Error(
      'photoCard: source 无效 (缺 uri/blob/dataUrl). 有图必须传有效 source; '
      + '无图请走模板的显式无图变体 (heroImageQuote / cover-hero else 分支), '
      + '不要在 photoCard 空手 —— 无 fallback 假占位.',
    );
  }
  slide.images.add({
    source: source as any,
    position: { left: pos.l, top: pos.t, width: pos.w, height: pos.h },
    fit: 'cover',
  });
  if (opts?.caption) {
    /* caption bar 底部 overlay · 半透明黑 */
    const capH = 40;
    slide.shapes.add({
      geometry: 'rect',
      position: { left: pos.l, top: pos.t + pos.h - capH, width: pos.w, height: capH },
      fill: 'rgba(0, 0, 0, 0.55)',
    });
    caption(slide, opts.caption,
      { l: pos.l + SPACE.m, t: pos.t + pos.h - capH + SPACE.s, w: pos.w - SPACE.m * 2, h: capH - SPACE.s * 2 },
      { theme, color: theme.palette.onInk },
    );
  }
}

/**
 * timelineTrack · 水平时间轴 · 圆点 + label + detail.
 * steps 数量 2-6, 均匀分布.
 */
export function timelineTrack(
  slide: Slide,
  steps: Array<{ label: string; detail?: string }>,
  pos: Pos,
  opts?: { theme?: NeoxTheme; accentColor?: string },
): void {
  const theme = T(opts);
  const accent = opts?.accentColor ?? theme.palette.accent;
  const n = steps.length;
  if (n < 1) return;

  const trackY = pos.t + pos.h / 2;
  const trackLeft = pos.l + 20;
  const trackRight = pos.l + pos.w - 20;
  const trackW = trackRight - trackLeft;

  /* 主轴 · 细线 subtle */
  slide.shapes.addRect({
    left: trackLeft, top: trackY - 1, width: trackW, height: 2,
  }, theme.palette.subtle);

  const stepGap = n > 1 ? trackW / (n - 1) : 0;
  steps.forEach((step, i) => {
    const cx = trackLeft + i * stepGap;
    /* 圆点 · accent */
    slide.shapes.addEllipse({
      left: cx - 8, top: trackY - 7, width: 16, height: 16,
    }, accent);
    /* 内白点 (类似钉子高光) */
    slide.shapes.addEllipse({
      left: cx - 3, top: trackY - 2, width: 6, height: 6,
    }, '#FFFFFF');
    /* label 上方 — 首尾两个 step 的 label box 会溢出 slide 边缘, 对齐方式改为端对齐并夹到 slide 内.
     * 中间 step 保持 center 对齐. slide 宽度不从 pos 拿 (拿不到), 用启发式: pos.l 是起点, pos.w 是可用宽. */
    let labelL = cx - 90;
    let labelW = 180;
    let labelAlign: 'ctr' | 'l' | 'r' = 'ctr';
    const slideRight = pos.l + pos.w;
    if (i === 0 && labelL < pos.l) {
      /* 首个 step: 左对齐 label, box 起于 pos.l */
      labelL = pos.l;
      labelW = 180;
      labelAlign = 'l';
    } else if (i === n - 1 && labelL + labelW > slideRight) {
      /* 末个 step: 右对齐 label, box 收到 slideRight */
      labelL = slideRight - 180;
      labelW = 180;
      labelAlign = 'r';
    }
    h3Title(slide, step.label,
      { l: labelL, t: trackY - 60, w: labelW, h: 28 },
      { theme, align: labelAlign },
    );
    /* detail 下方 · 同规则夹到 slide 内 */
    if (step.detail) {
      let detailL = cx - 100;
      let detailW = 200;
      let detailAlign: 'ctr' | 'l' | 'r' = 'ctr';
      if (i === 0 && detailL < pos.l) { detailL = pos.l; detailAlign = 'l'; }
      else if (i === n - 1 && detailL + detailW > slideRight) { detailL = slideRight - 200; detailAlign = 'r'; }
      caption(slide, step.detail,
        { l: detailL, t: trackY + 20, w: detailW, h: 44 },
        { theme, color: theme.palette.muted, align: detailAlign },
      );
    }
  });
}

/**
 * tableRow · 一行水平表格.
 *   cells: 每列文本
 *   widths: 每列宽度 px, 长度需 = cells.length
 *   opts.isHeader: 表头行 (背景 accent 白字)
 *   opts.zebra: 斑马纹 (奇数行浅背景)
 */
export function tableRow(
  slide: Slide,
  cells: string[],
  y: number, x: number, widths: number[],
  opts?: { theme?: NeoxTheme; isHeader?: boolean; zebra?: boolean; rowIndex?: number; rowHeight?: number },
): void {
  const theme = T(opts);
  const rowH = opts?.rowHeight ?? 40;
  const isHeader = opts?.isHeader === true;
  const zebra = opts?.zebra === true;
  const rowIdx = opts?.rowIndex ?? 0;
  const totalW = widths.reduce((s, w) => s + w, 0);

  /* 行背景 */
  if (isHeader) {
    slide.shapes.addRect({ left: x, top: y, width: totalW, height: rowH }, theme.palette.accent);
  } else if (zebra && rowIdx % 2 === 1) {
    slide.shapes.addRect({ left: x, top: y, width: totalW, height: rowH }, theme.palette.surface);
  }

  /* 每列文字 */
  let cx = x;
  cells.forEach((cell, ci) => {
    const cw = widths[ci] ?? 100;
    const style = isHeader
      ? { fontFamily: theme.fonts.text, fontSize: 13, bold: true, color: theme.palette.onInk }
      : { fontFamily: theme.fonts.text, fontSize: 13, color: theme.palette.ink };
    slide.shapes.addText(cell,
      { left: cx + SPACE.m, top: y + rowH * 0.28, width: cw - SPACE.m * 2, height: rowH * 0.6 },
      style,
    );
    cx += cw;
  });
}

/**
 * footer · 底部品牌行. 左侧品牌 / 主题, 右侧页码.
 * 默认在 slide 底部 padBottom 位置.
 */
export function footer(
  slide: Slide, slideSize: { width: number; height: number },
  opts?: { left?: string; right?: string; theme?: NeoxTheme },
): void {
  const theme = T(opts);
  const y = slideSize.height - PAGE.padBottom + SPACE.s;
  if (opts?.left) {
    overline(slide, opts.left,
      { l: PAGE.padH, t: y, w: slideSize.width * 0.5, h: 20 },
      { theme, color: theme.palette.muted },
    );
  }
  if (opts?.right) {
    overline(slide, opts.right,
      { l: slideSize.width * 0.5 - PAGE.padH, t: y, w: slideSize.width * 0.5, h: 20 },
      { theme, color: theme.palette.muted, align: 'r' },
    );
  }
}

/**
 * pageNumber · 右下角小页码 (自带小前缀).
 */
export function pageNumber(
  slide: Slide, num: number | string, slideSize: { width: number; height: number },
  opts?: { theme?: NeoxTheme; total?: number },
): void {
  const theme = T(opts);
  const text = opts?.total ? `${num} / ${opts.total}` : String(num).padStart(2, '0');
  slide.shapes.addText(text,
    { left: slideSize.width - PAGE.padH - 40, top: slideSize.height - PAGE.padBottom, width: 40, height: 24 },
    { fontFamily: theme.fonts.mono, fontSize: 11, color: theme.palette.muted, letterSpacingPt: 1 },
  );
}

/* ============================================================
 * 工具
 * ============================================================ */

function toXY(pos: Pos): { left: number; top: number; width: number; height: number } {
  return { left: pos.l, top: pos.t, width: pos.w, height: pos.h };
}

/** #RRGGBB + alpha (0-1) → rgba(...) */
function hexWithAlpha(hex: string, alpha: number): string {
  const h = hex.startsWith('#') ? hex.slice(1) : hex;
  const r = parseInt(h.substr(0, 2), 16);
  const g = parseInt(h.substr(2, 2), 16);
  const b = parseInt(h.substr(4, 2), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
