
import type { Slide } from '@neoxlabs/pptx-renderer';
import type { ComposeNode } from '../compose/types.js';
import { render } from '../bridge/render.js';
import { ZStack, Shape } from '../compose/dsl.js';
import { activeTheme, activeSpec } from './theme.js';
import { withAlpha, mixHex } from './motif-bits.js';
import type { VectorPath } from './diagram-bits.js';
import { rosettePath, guillochePath } from './ornaments.js';

/* ============================================================
 * 定种子 PRNG —— 同一份 deck 每次导出必须一模一样
 * ============================================================ */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ============================================================
 * blobPath —— 闭合流体块
 * ============================================================ */

/**
 * 按半径扰动生成一条闭合的三次贝塞尔曲线 (Catmull-Rom 转 Bezier)。
 *
 * points 少 (4~5) 出来是"大圆润块", 多 (8~10) 出来是"有起伏的水滴"。
 * wobble 是半径扰动幅度: 超过 0.30 就开始出现凹陷, 读起来像溅开的墨点而不是色块。
 */
export function blobPath(w: number, h: number, opts?: {
  seed?: number; points?: number; wobble?: number;
}): VectorPath {
  const n = Math.max(3, opts?.points ?? 6);
  const wobble = opts?.wobble ?? 0.16;
  const rnd = mulberry32(opts?.seed ?? 1);
  const cx = w / 2, cy = h / 2;

  const pts: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const k = 1 + (rnd() * 2 - 1) * wobble;
    pts.push([cx + Math.cos(a) * cx * k, cy + Math.sin(a) * cy * k]);
  }

  /* Catmull-Rom → 三次贝塞尔 (闭合): 控制点由前后邻点的差分给出,
   * 所以每个节点处切线连续 —— 这正是"手画接不上"的那一段。 */
  const at = (i: number) => pts[((i % n) + n) % n]!;
  const f = (v: number) => Math.round(v * 100) / 100;
  let d = `M${f(at(0)[0])},${f(at(0)[1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    const c1: [number, number] = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: [number, number] = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${f(c1[0])},${f(c1[1])} ${f(c2[0])},${f(c2[1])} ${f(p2[0])},${f(p2[1])}`;
  }
  return { d: d + ' Z', viewBox: { width: w, height: h } };
}

/** 圆点阵 —— 几十个点合成**一个** shape, 免得往 slide 上塞几十个图形 */
export function dotFieldPath(cols: number, rows: number, step: number, dot: number): VectorPath {
  const r = dot / 2;
  const parts: string[] = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const cx = x * step + r, cy = y * step + r;
      /* 单段 360° 弧在 SVG 里是退化的, 必须两段半弧 */
      parts.push(`M${cx - r},${cy} A${r},${r} 0 0 1 ${cx + r},${cy} A${r},${r} 0 0 1 ${cx - r},${cy} Z`);
    }
  }
  return {
    d: parts.join(' '),
    viewBox: { width: (cols - 1) * step + dot, height: (rows - 1) * step + dot },
  };
}

/** 同心弧 —— 几何构成里的"环" (strokeOnly 用, 配 border) */
export function concentricArcsPath(radii: number[], startDeg: number, sweepDeg: number): VectorPath {
  const max = Math.max(...radii);
  const cx = max, cy = max;
  const p = (r: number, deg: number) => {
    const a = (deg * Math.PI) / 180;
    return `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
  };
  const large = Math.abs(sweepDeg) > 180 ? 1 : 0;
  const d = radii
    .map((r) => `M${p(r, startDeg)} A${r},${r} 0 ${large} 1 ${p(r, startDeg + sweepDeg)}`)
    .join(' ');
  return { d, viewBox: { width: max * 2, height: max * 2 } };
}

/* ============================================================
 * pageDecor —— 页面级装饰层
 * ============================================================ */

export type DecorVariant = 'fluid' | 'geometric' | 'auto';
export type DecorCorner = 'tr' | 'br' | 'bl' | 'tl';

export interface PageDecorOptions {
  variant?: DecorVariant;
  /** 装饰从哪个角出血, 默认右上 */
  corner?: DecorCorner;
  /** 强度. subtle 几乎只是让底不平; bold 是封面/章节页那种分量 */
  intensity?: 'subtle' | 'normal' | 'bold';
  /** 画在深底上 */
  onDark?: boolean;
  /** 同一份 deck 里逐页给不同 seed, 形状就不会页页雷同 (但每次导出仍然一致) */
  seed?: number;
  slideW?: number;
  slideH?: number;
}

const LINE_MIX: Record<'subtle' | 'normal' | 'bold', { arc: number; dot: number }> = {
  subtle: { arc: 0.16, dot: 0.14 },
  normal: { arc: 0.30, dot: 0.24 },
  bold:   { arc: 0.52, dot: 0.38 },
};

const ALPHA: Record<'subtle' | 'normal' | 'bold', [number, number, number]> = {
  /* 三层各自的不透明度。底层最淡最大, 顶层最实最小 —— 反过来就变成
   * "一块实色上盖了层雾", 层次是塌的。 */
  subtle: [0.05, 0.07, 0.10],
  normal: [0.09, 0.13, 0.20],
  bold: [0.14, 0.22, 0.34],
};

/**
 * 在这一页底上画一层装饰。**必须在内容之前调用** —— z 序就是调用顺序,
 * 画在内容之后会盖住文字。
 *
 * 和 slideChrome 一样是页面级副作用函数, 不进 ComposeNode 树:
 * 装饰是"这一页的底", 不是版心里的一个节点, 塞进树里会参与布局分配空间。
 */
export function pageDecor(slide: Slide, opts?: PageDecorOptions): void {
  const t = activeTheme();
  const W = opts?.slideW ?? 1280;
  const H = opts?.slideH ?? 720;
  const corner = opts?.corner ?? 'tr';
  const onDark = opts?.onDark ?? false;
  const ground = onDark ? t.ink : t.paper;
  const alphas = ALPHA[opts?.intensity ?? 'normal'];
  const mix = LINE_MIX[opts?.intensity ?? 'normal'];
  const seed = opts?.seed ?? 7;

  const motif = activeSpec()?.motif ?? 'none';
  const variant: Exclude<DecorVariant, 'auto'> = (opts?.variant ?? 'auto') !== 'auto'
    ? (opts!.variant as Exclude<DecorVariant, 'auto'>)
    /* line 风格走几何线场, 塞流体色块就把它那套克制毁了 (同 icon-bits 的 tone) */
    : (motif === 'line' || motif === 'chevron' ? 'geometric' : 'fluid');

  /* 有纹样的风格 (finance-navy) 装饰层画纹样 —— 同一套纹样贯穿封面和内容页, 才是"一套" */
  const ornament = (opts?.variant ?? 'auto') === 'auto' ? activeSpec()?.ornament : undefined;
  const layers = ornament === 'guilloche'
    ? guillocheLayers({ W, H, corner, ground, alphas, seed, onDark, mix }, opts?.intensity ?? 'normal')
    : variant === 'fluid'
      ? fluidLayers({ W, H, corner, ground, alphas, seed, onDark, mix })
      : geoLayers({ W, H, corner, ground, alphas, onDark, mix });

  if (layers.length === 0) return;

  render(slide, ZStack({ align: 'start', width: W, height: H }, layers), {
    bounds: { x: 0, y: 0, width: W, height: H },
    assertNoOverlap: false,
    /* 装饰层本来就是互相叠着、且刻意画出版面的, 求解器不该动它 */
    fit: false,
  });
}

interface LayerCtx {
  W: number; H: number; corner: DecorCorner; ground: string;
  alphas: [number, number, number]; onDark: boolean; seed?: number;
  mix: { arc: number; dot: number };
}

/** 角落定位: 返回一个把 (w,h) 的形状按 ratio 挂到指定角外侧的 padding */
function cornerPad(ctx: LayerCtx, w: number, h: number, outX: number, outY: number) {
  const left = ctx.corner === 'tr' || ctx.corner === 'br' ? ctx.W - w + outX : -outX;
  const top = ctx.corner === 'tr' || ctx.corner === 'tl' ? -outY : ctx.H - h + outY;
  return { top: Math.round(top), left: Math.round(left), right: 0, bottom: 0 };
}

function fluidLayers(ctx: LayerCtx): ComposeNode[] {
  const t = activeTheme();
  const [a0, a1, a2] = ctx.alphas;
  const seed = ctx.seed ?? 7;

  /* 三块尺寸递减、扰动递增: 大块负责"底有厚度", 小块负责"有个焦点".
   * 三块都比版面小的话就成了三个贴上去的图形 —— 最大那块必须超出版面。 */
  const specs: Array<{ w: number; h: number; ox: number; oy: number; a: number; pts: number; wob: number; hue: string }> = [
    { w: Math.round(ctx.W * 0.86), h: Math.round(ctx.H * 1.10), ox: 150, oy: 190, a: a0, pts: 5, wob: 0.10, hue: t.accent },
    { w: Math.round(ctx.W * 0.54), h: Math.round(ctx.H * 0.78), ox: 60, oy: 110, a: a1, pts: 6, wob: 0.16, hue: t.accent },
    { w: Math.round(ctx.W * 0.30), h: Math.round(ctx.H * 0.42), ox: 30, oy: 40, a: a2, pts: 7, wob: 0.22, hue: t.accentDeep },
  ];

  return specs.map((s, i) => Shape({
    geometry: 'custom', width: s.w, height: s.h, bleed: true,
    /* 颜色先跟底色混一道再上 alpha —— 直接用主题亮色就是 heroBackdropLayers
     * 第一版那坨"亮色团"。混合让它只比底色亮一两档, 才读成"底有厚度"。 */
    fill: withAlpha(mixHex(ctx.ground, s.hue, ctx.onDark ? 0.72 : 0.86), s.a),
    customPath: blobPath(s.w, s.h, { seed: seed * 31 + i * 7, points: s.pts, wobble: s.wob }),
    padding: cornerPad(ctx, s.w, s.h, s.ox, s.oy),
  }));
}

/**
 * 纹样装饰 (内容页): 角上出血的纹章, normal/bold 再加一条贴页顶的细线纹带。
 * 纹章只露出一半多一点 —— 完整的圆摆在版面里会被读成"一个图案", 被页边切掉才读成"底"。
 * 纹带贴在页顶 (标题上方的页边), 不放页底: 页底是页脚和页码的位置。
 */
function guillocheLayers(ctx: LayerCtx, intensity: 'subtle' | 'normal' | 'bold'): ComposeNode[] {
  const t = activeTheme();
  const k = { subtle: 0.22, normal: 0.32, bold: 0.44 }[intensity];
  const line = mixHex(ctx.ground, ctx.onDark ? mixHex(t.accent, t.onInk, 0.35) : t.accent, k);
  const RS = Math.round(ctx.H * ({ subtle: 0.62, normal: 0.80, bold: 1.0 }[intensity]));
  const out: ComposeNode[] = [Shape({
    geometry: 'custom', width: RS, height: RS, bleed: true,
    customPath: { ...rosettePath(RS), strokeOnly: true },
    border: { color: line, width: 0.7 },
    padding: cornerPad(ctx, RS, RS, Math.round(RS * 0.42), Math.round(RS * 0.42)),
  })];
  if (intensity !== 'subtle') {
    const bw = ctx.W - 144;
    out.push(Shape({
      geometry: 'custom', width: bw, height: 22, bleed: true,
      customPath: { ...guillochePath(bw, 22, { strands: 5, waves: 14 }), strokeOnly: true },
      border: { color: line, width: 0.5 },
      padding: { top: 14, left: 72, right: 0, bottom: 0 },
    }));
  }
  return out;
}

function geoLayers(ctx: LayerCtx): ComposeNode[] {
  const t = activeTheme();
  const [a0] = ctx.alphas;
  const out: ComposeNode[] = [];

  const line = (k: number) => mixHex(ctx.ground, t.accent, k);

  /* 1. 同心弧 —— 从角上出血的一组环 */
  const R = Math.round(Math.min(ctx.W, ctx.H) * 0.62);
  const radii = [R, Math.round(R * 0.78), Math.round(R * 0.56), Math.round(R * 0.34)];
  const arcs = concentricArcsPath(radii, 90, 180);
  out.push(Shape({
    geometry: 'custom', width: R * 2, height: R * 2, bleed: true,
    fill: line(ctx.mix.arc),
    customPath: { ...arcs, strokeOnly: true },
    border: { color: line(ctx.mix.arc), width: 1.4 },
    padding: cornerPad(ctx, R * 2, R * 2, Math.round(R * 0.78), Math.round(R * 0.82)),
  }));

  /* 2. 一块斜向色带, 从对角出血 —— 环是"轻"的, 需要一块"重"的压住,
   * 否则整页只有几条细线, 读起来像没画完。 */
  const bw = Math.round(ctx.W * 0.42), bh = Math.round(ctx.H * 1.4);
  out.unshift(Shape({
    geometry: 'custom', width: bw, height: bh, bleed: true,
    fill: withAlpha(mixHex(ctx.ground, t.accent, ctx.onDark ? 0.7 : 0.85), a0),
    customPath: {
      /* 平行四边形: 上边比下边右移 = 斜切, 和 chevron 那套形态语言同向 */
      d: `M${Math.round(bw * 0.34)},0 H${bw} L${Math.round(bw * 0.66)},${bh} H0 Z`,
      viewBox: { width: bw, height: bh },
    },
    padding: cornerPad(ctx, bw, bh, Math.round(bw * 0.18), Math.round(bh * 0.22)),
  }));

  /* 3. 圆点阵 —— 放在色带对面的角, 给版面另一头一点重量 */
  const cols = 9, rows = 6, step = 22, dot = 4;
  const dots = dotFieldPath(cols, rows, step, dot);
  const dw = dots.viewBox.width, dh = dots.viewBox.height;
  const opp: DecorCorner = ({ tr: 'bl', br: 'tl', bl: 'tr', tl: 'br' } as const)[ctx.corner];
  out.push(Shape({
    geometry: 'custom', width: dw, height: dh, bleed: true,
    fill: line(ctx.mix.dot),
    customPath: dots,
    padding: cornerPad({ ...ctx, corner: opp }, dw, dh, -64, -64),
  }));

  return out;
}
