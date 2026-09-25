/**
 * step-figures — 阶梯箭头 / 折带流程 / 3D 讲台.
 *
 * 明康拿了三张稻壳图问"这样的组件我们能做到吗"。逐个拆开看:
 *   · 阶梯箭头 (01/02 → 03/04 → 05 大箭头)  纯多边形 + 线性渐变, 难度低
 *   · 折带流程 (折角丝带 + 末端箭头 + 引线)  纯多边形, 难度低
 *   · 椭圆轨道 + 3D 圆柱讲台                 椭圆弧 + 三段堆叠 + 径向渐变, 能做
 * 唯一做不到的是第三张里那块**玻璃质感**的半透明方块 —— 那是 backdrop blur,
 * 矢量画不出来, 硬凑只会像一块脏玻璃。这一条如实说, 不糊弄。
 *
 * 【为什么这三个是"图形"而不是"插画"】它们都在表达一个真实关系
 * (递进 / 顺序 / 环绕), 所以判据同 diagram-bits: 形状必须和内容对得上。
 * 阶梯的层数就是内容的层数, 折带的段数就是步骤数 —— 不能为了好看多画一节。
 */

import type { ComposeNode } from '../compose/types.js';
import { ZStack, Text, Shape } from '../compose/dsl.js';
import { activeTheme } from './theme.js';
import { mixHex, lighten, darken, withAlpha, bestTextOn, uniformTextOn, hueRotatePalette, nothing } from './motif-bits.js';
import { circlePath, type VectorPath } from './diagram-bits.js';
import { iconGlyph, hasIcon, type IconName } from './icon-bits.js';

/* ============================================================
 * 路径基元
 * ============================================================ */

/**
 * 只圆指定角的矩形。稻壳那批"一角圆一角方"的块全是这个 ——
 * 一对块左右各圆外侧两角, 合起来读成"一整块被切开", 而不是两个独立方块。
 */
export function tilePath(w: number, h: number, r: number, corners: {
  tl?: boolean; tr?: boolean; br?: boolean; bl?: boolean;
}): VectorPath {
  const k = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  const seg: string[] = [];
  seg.push(`M${corners.tl ? k : 0},0`);
  seg.push(`H${corners.tr ? w - k : w}`);
  if (corners.tr) seg.push(`A${k},${k} 0 0 1 ${w},${k}`);
  seg.push(`V${corners.br ? h - k : h}`);
  if (corners.br) seg.push(`A${k},${k} 0 0 1 ${w - k},${h}`);
  seg.push(`H${corners.bl ? k : 0}`);
  if (corners.bl) seg.push(`A${k},${k} 0 0 1 0,${h - k}`);
  seg.push(`V${corners.tl ? k : 0}`);
  if (corners.tl) seg.push(`A${k},${k} 0 0 1 ${k},0`);
  seg.push('Z');
  return { d: seg.join(' '), viewBox: { width: w, height: h } };
}

/** 向上的箭头 (箭身 + 箭头), 肩宽比 shoulder */
export function upArrowPath(w: number, h: number, shoulder = 0.46, headRatio = 0.52): VectorPath {
  const hh = h * headRatio;
  const bw = w * shoulder;
  const x0 = (w - bw) / 2, x1 = (w + bw) / 2;
  return {
    d: `M${w / 2},0 L${w},${hh} L${x1},${hh} L${x1},${h} L${x0},${h} L${x0},${hh} L0,${hh} Z`,
    viewBox: { width: w, height: h },
  };
}

/** 3D 圆柱的柱身 (上下都是椭圆封口的侧面) */
function cylinderBodyPath(w: number, h: number, ry: number): VectorPath {
  const rx = w / 2, x0 = 0, x1 = w;
  const yT = ry, yB = h - ry;
  return {
    d: `M${x0},${yT} L${x0},${yB} A${rx},${ry} 0 0 0 ${x1},${yB} L${x1},${yT} `
     + `A${rx},${ry} 0 0 0 ${x0},${yT} Z`,
    viewBox: { width: w, height: h },
  };
}

function ellipsePath(w: number, h: number): VectorPath {
  const rx = w / 2, ry = h / 2;
  return {
    d: `M0,${ry} A${rx},${ry} 0 0 1 ${w},${ry} A${rx},${ry} 0 0 1 0,${ry} Z`,
    viewBox: { width: w, height: h },
  };
}

/* ============================================================
 * 1 · stairArrow —— 阶梯箭头
 * ============================================================ */

export interface StairItem {
  label: string;
  desc?: string;
}

export interface StairArrowOptions {
  items: StairItem[];
  width: number;
  height: number;
  onDark?: boolean;
}

/**
 * 递进阶梯: 两个一层往上垒, **最后一项是顶端的箭头**。
 *
 * 层数由条目数决定, 不能为了对称多画一层 —— 图形的结构就是内容的结构。
 * 侧栏文字左右分流: 左块的说明在左 (右对齐), 右块的在右 (左对齐),
 * 这样每段文字都紧贴它标注的块, 而不是让观众去猜哪段配哪块。
 */
export function stairArrow(opts: StairArrowOptions): ComposeNode {
  const t = activeTheme();
  const n = opts.items.length;
  if (n === 0) return nothing();

  const W = opts.width, H = opts.height;
  const ground = opts.onDark ? t.ink : t.paper;
  const body = opts.items.slice(0, -1);        /* 成对垒的部分 */
  const top = opts.items[n - 1]!;              /* 顶端箭头 */
  const rows = Math.ceil(body.length / 2);
  const levels = rows + 1;                     /* 加上箭头那一层 */

  /* 中间那一柱的宽度 = 一对块的总宽; 两侧留给文字 */
  const colW = Math.min(Math.round(W * 0.30), 300);
  const tileW = Math.round(colW / 2);
  const rowH = Math.round(H / levels);
  const cx0 = Math.round((W - colW) / 2);
  const sideW = cx0 - 28;

  const layers: ComposeNode[] = [];

  const shade = (i: number) => mixHex(
    mixHex(t.accent, ground, 0.28), t.accentDeep,
    n === 1 ? 0 : i / (n - 1),
  );

  /** 侧栏文字: side='l' 贴左块, 'r' 贴右块 */
  const sideText = (item: StairItem, side: 'l' | 'r', yTop: number, color: string) => {
    const x = side === 'l' ? 0 : cx0 + colW + 28;
    layers.push(Text(item.label, {
      fontSize: 16, bold: true, color, width: sideW,
      textAlign: side === 'l' ? 'r' : 'l', singleLine: true,
      fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
      padding: { top: yTop, left: x, right: 0, bottom: 0 },
    }));
    if (item.desc) {
      layers.push(Text(item.desc, {
        fontSize: 14, color: opts.onDark ? mixHex(t.onInk, t.ink, 0.3) : t.muted,
        width: sideW, maxLines: 3, textAlign: side === 'l' ? 'r' : 'l',
        fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
        padding: { top: yTop + 26, left: x, right: 0, bottom: 0 },
      }));
    }
  };

  /* ── 成对的台阶, 从下往上 ─────────────────────────── */
  body.forEach((item, i) => {
    const row = Math.floor(i / 2);
    const isLeft = i % 2 === 0;
    const y = H - (row + 1) * rowH;
    const x = cx0 + (isLeft ? 0 : tileW);
    const c = shade(i);

    layers.push(Shape({
      geometry: 'custom', width: tileW, height: rowH, fill: c,
      /* 一对块各圆自己的外侧两角 —— 合起来是一块被切开的圆角板 */
      customPath: tilePath(tileW, rowH, Math.round(rowH * 0.22),
        isLeft ? { tl: true, bl: true } : { tr: true, br: true }),
      gradient: { stops: [{ pos: 0, color: lighten(c, 0.18) }, { pos: 1, color: c }], angleDeg: 120 },
      padding: { top: y, left: x, right: 0, bottom: 0 },
    }));

    layers.push(Text(String(i + 1).padStart(2, '0'), {
      fontSize: Math.max(16, Math.round(rowH * 0.30)), bold: true, color: bestTextOn(c),
      textAlign: 'ctr', singleLine: true, width: tileW,
      fontLatin: t.fonts.numeric, fontEast: t.fonts.textEast,
      padding: { top: y + Math.round(rowH * 0.32), left: x, right: 0, bottom: 0 },
    }));

    sideText(item, isLeft ? 'l' : 'r', y + Math.round(rowH * 0.14), c);
  });

  /* ── 顶端箭头 ───────────────────────────────────────── */
  const ay = H - levels * rowH;
  /* Keep the arrow on its own upper layer so its tail does not overlap the
   * highest step. */
  const ah = rowH + Math.round(rowH * 0.24);
  const ac = shade(n - 1);
  layers.push(Shape({
    geometry: 'custom', width: colW, height: ah, fill: ac,
    customPath: upArrowPath(colW, ah),
    gradient: { stops: [{ pos: 0, color: lighten(ac, 0.20) }, { pos: 1, color: ac }], angleDeg: 120 },
    padding: { top: Math.max(0, ay - Math.round(rowH * 0.24)), left: cx0, right: 0, bottom: 0 },
  }));
  layers.push(Text(String(n).padStart(2, '0'), {
    fontSize: Math.max(16, Math.round(rowH * 0.30)), bold: true, color: bestTextOn(ac),
    textAlign: 'ctr', singleLine: true, width: colW,
    fontLatin: t.fonts.numeric, fontEast: t.fonts.textEast,
    padding: { top: Math.max(0, ay - Math.round(rowH * 0.24)) + Math.round(ah * 0.56), left: cx0, right: 0, bottom: 0 },
  }));
  sideText(top, 'r', Math.max(0, ay - Math.round(rowH * 0.24)) + 8, ac);

  return ZStack({ align: 'start', width: W, height: H }, layers);
}

/* ============================================================
 * 2 · foldRibbon —— 折带流程
 * ============================================================ */

export interface FoldRibbonOptions {
  items: StairItem[];
  width: number;
  height: number;
  /**
   * 每段一个色相 (稻壳那批图的默认长相)。
   * 默认关: 流程各段是同一类东西, 给不同色相等于说它们分属不同种类。
   * 真要彩色时走 hueRotatePalette: 明度饱和度锁死, 只让**色相**走一段 ——
   * 五段颜色不同但重量相同, 读起来是"一套"。(用 seriesPalette 是错的,
   * 那是给图表系列设计的, 靠拉开明度来区分, 放这里成了黑白闪。)
   */
  multicolor?: boolean;
  onDark?: boolean;
}

/**
 * 折角丝带: 一条纸带被折成几段, 段与段之间露出**折痕的暗面**, 末端收成箭头。
 *
 * Use restrained band thickness, subtle fold shadows, a narrow tonal range,
 * and a closed arrow end so the ribbon supports the steps without dominating
 * the content.
 */
export function foldRibbon(opts: FoldRibbonOptions): ComposeNode {
  const t = activeTheme();
  const n = opts.items.length;
  if (n === 0) return nothing();

  const W = opts.width, H = opts.height;
  const ground = opts.onDark ? t.ink : t.paper;
  const bandH = Math.round(H * 0.24);
  const bandY = Math.round(H * 0.42);
  /* 【 明康: "箭头不一样的"】折痕只有 0.15 带高, 而末端箭头是 0.52 ——
   * 两者的斜率差了三倍多, 于是同一条带子上出现两种角度的尖, 看着不是一套。
   * 折痕加宽到 0.26, 末端箭头取**同一个宽度**, 斜率就完全一致了。 */
  const fold = Math.round(bandH * 0.26);
  const headW = fold;
  const segW = Math.round((W - headW) / n);

  /* 色阶只在**浅色到 accent** 之间走, 不碰 accentDeep ——
   * 五段横跨整个明度区间会让后两段闷成一团, 而"一步步往前"只需要一点点递进。 */
  const palette = opts.multicolor ? hueRotatePalette(n) : null;
  const shade = (i: number) => palette
    ? palette[i]!
    : mixHex(lighten(t.accent, 0.34), t.accent, n === 1 ? 0 : i / (n - 1));

  const layers: ComposeNode[] = [];

  opts.items.forEach((item, i) => {
    const x = i * segW;
    const c = shade(i);
    const fg = bestTextOn(c);

    /* 主面是实心矩形, 段与段严丝合缝 —— 折带的说服力全在"带子是连续的"。
     * 首段左侧一个 V 形书签口, 那是带子的起手。 */
    const d = i === 0
      ? `M${fold},0 H${segW} V${bandH} H${fold} L0,${bandH / 2} Z`
      : `M0,0 H${segW} V${bandH} H0 Z`;

    layers.push(Shape({
      geometry: 'custom', width: segW, height: bandH, fill: c,
      customPath: { d, viewBox: { width: segW, height: bandH } },
      gradient: { stops: [{ pos: 0, color: lighten(c, 0.12) }, { pos: 1, color: c }], angleDeg: 100 },
      /* 一层很轻的投影, 把带子从纸面上托起来。没有它带子是"印上去的" */
      effects: { outerShadow: { blur: 26000, distance: 26000, angle: 90, color: t.ink, alpha: 0.10 } },
      padding: { top: bandY, left: x, right: 0, bottom: 0 },
    }));

    /* 折痕暗面 —— 折的是同一张纸, 取本段颜色压深一点点即可。
     * 压太深 (第一版 0.34) 整排就成了黑锯齿。 */
    if (i < n - 1) {
      layers.push(Shape({
        geometry: 'custom', width: fold, height: bandH,
        fill: darken(c, 0.15),
        customPath: {
          d: `M${fold},0 V${bandH} L0,${bandH / 2} Z`,
          viewBox: { width: fold, height: bandH },
        },
        padding: { top: bandY, left: x + segW - fold, right: 0, bottom: 0 },
      }));
    }

    layers.push(Text(String(i + 1).padStart(2, '0'), {
      fontSize: Math.max(13, Math.round(bandH * 0.28)), bold: true, color: fg,
      textAlign: 'ctr', singleLine: true, width: segW - fold,
      letterSpacingPt: 0.4,
      fontLatin: t.fonts.numeric, fontEast: t.fonts.textEast,
      padding: { top: bandY + Math.round(bandH * 0.32), left: x, right: 0, bottom: 0 },
    }));

    /* 引线 + 标注: 上下交替。线是**发丝级**的浅色, 端点一个小圆 ——
     * 引线的职责是"把文字和这一段连起来", 不是自己成为一根显眼的竖杠。 */
    const up = i % 2 === 0;
    const lineX = x + Math.round(segW * 0.16);
    const lineH = Math.round(H * 0.16);
    const hair = mixHex(ground, c, 0.55);
    layers.push(Shape({
      geometry: 'custom', width: 1, height: lineH, fill: hair,
      customPath: { d: `M0,0 H1 V${lineH} H0 Z`, viewBox: { width: 1, height: lineH } },
      padding: { top: up ? bandY - lineH : bandY + bandH, left: lineX, right: 0, bottom: 0 },
    }));
    layers.push(Shape({
      geometry: 'custom', width: 6, height: 6, fill: c,
      customPath: circlePath(6),
      padding: { top: (up ? bandY - lineH : bandY + bandH + lineH) - 3, left: lineX - 3, right: 0, bottom: 0 },
    }));

    const capW = Math.round(segW * 1.02);
    layers.push(Text(item.label, {
      fontSize: 14, bold: true, color: c, width: capW, singleLine: true,
      fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
      padding: {
        top: up ? Math.max(0, bandY - lineH - 44) : bandY + bandH + lineH + 10,
        left: lineX, right: 0, bottom: 0,
      },
    }));
    if (item.desc) {
      layers.push(Text(item.desc, {
        fontSize: 14, color: opts.onDark ? mixHex(t.onInk, t.ink, 0.3) : t.muted,
        width: capW, maxLines: 2,
        fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
        padding: {
          top: up ? Math.max(0, bandY - lineH - 24) : bandY + bandH + lineH + 30,
          left: lineX, right: 0, bottom: 0,
        },
      }));
    }
  });

  /* 末端箭头。左边是**平的** —— 第一版沿用了段面的 V 形凹口, 于是它和最后一段
   * 之间露出一道白色的 V, 带子在终点断掉了。 */
  const lastC = shade(n - 1);
  layers.push(Shape({
    geometry: 'custom', width: headW, height: bandH, fill: lastC,
    customPath: {
      d: `M0,0 L${headW},${bandH / 2} L0,${bandH} Z`,
      viewBox: { width: headW, height: bandH },
    },
    padding: { top: bandY, left: n * segW, right: 0, bottom: 0 },
  }));

  return ZStack({ align: 'start', width: W, height: H }, layers);
}

/* ============================================================
 * 3 · podium3D —— 立体圆柱讲台
 * ============================================================ */

export interface Podium3DOptions {
  width: number;
  /** 柱身高 (不含椭圆封口) */
  height: number;
  /** 椭圆封口的半高 = 透视强度. 越大越"俯视" */
  perspective?: number;
  onDark?: boolean;
}

/**
 * 一个立体台子。稻壳那张图中间托着主视觉的就是它。
 *
 * 三段堆叠: 柱身 (侧面渐变, 左右暗中间亮 = 圆柱的光影) + 顶面椭圆 (最亮) +
 * 顶面上再压一圈更亮的内椭圆 (台沿高光)。这三层是圆柱观感的最小集合,
 * 少一层就塌成一个圆角矩形。
 */
export function podium3D(opts: Podium3DOptions): ComposeNode {
  const t = activeTheme();
  const W = opts.width;
  const ry = opts.perspective ?? Math.round(W * 0.13);
  const H = opts.height + ry * 2;
  const ground = opts.onDark ? t.ink : t.paper;
  const base = mixHex(t.accent, ground, 0.52);

  return ZStack({ align: 'start', width: W, height: H }, [
    /* 落地投影: 柱底再往下一点的一片淡椭圆。台子不落影就像浮在半空,
     * 立体感差的一半在这里 —— 阴影是"它站在某个面上"的唯一证据。 */
    Shape({
      geometry: 'custom', width: Math.round(W * 1.06), height: Math.round(ry * 2.1),
      fill: withAlpha(t.ink, opts.onDark ? 0.22 : 0.10),
      customPath: ellipsePath(Math.round(W * 1.06), Math.round(ry * 2.1)),
      padding: { top: Math.round(H - ry * 1.5), left: Math.round(-W * 0.03), right: 0, bottom: 0 },
    }),
    /* 柱身: 横向渐变模拟圆柱的明暗 (左暗 → 中亮 → 右暗) */
    Shape({
      geometry: 'custom', width: W, height: H, fill: base,
      customPath: cylinderBodyPath(W, H, ry),
      gradient: {
        stops: [
          { pos: 0, color: mixHex(base, t.ink, 0.22) },
          { pos: 0.42, color: lighten(base, 0.22) },
          { pos: 1, color: mixHex(base, t.ink, 0.26) },
        ],
        angleDeg: 0,
      },
    }),
    /* 顶面 */
    Shape({
      geometry: 'custom', width: W, height: ry * 2,
      fill: lighten(base, 0.34),
      customPath: ellipsePath(W, ry * 2),
    }),
    /* 台沿高光: 顶面内缩一圈的更亮椭圆。没有它顶面是一块平的椭圆色块 */
    Shape({
      geometry: 'custom', width: Math.round(W * 0.84), height: Math.round(ry * 2 * 0.84),
      fill: lighten(base, 0.56),
      customPath: ellipsePath(Math.round(W * 0.84), Math.round(ry * 2 * 0.84)),
      padding: {
        top: Math.round(ry * 2 * 0.08), left: Math.round(W * 0.08), right: 0, bottom: 0,
      },
    }),
  ]);
}

/* ============================================================
 * 4 · chevronFlow —— 分离式箭头流程 (带回声轮廓)
 * ============================================================ */

export interface ChevronFlowOptions {
  items: Array<StairItem & { icon?: IconName }>;
  width: number;
  height: number;
  multicolor?: boolean;
  onDark?: boolean;
}

/**
 * 【 明康: "这是人家的箭头, 这是你的, 你没发现你的箭头不好看吗"】
 *
 * 对着参照图逐条量, 差的不是颜色也不是技术, 是**图形语言**。同样五个箭头,
 * 人家用了三个我一个都没用的手法:
 *
 *   1. **分离而不是连成一条**。五个独立的箭头之间留空气, 每一个都是完整的形;
 *      连成一条实心带就成了"一根横杠", 形没了, 只剩色块分段。
 *   2. **回声轮廓**。每个实心箭头右后方跟一个**空心的同形箭头** ——
 *      这是整张图艺术感的主要来源: 它给了形状一个"影子/余像", 暗示运动方向,
 *      而且让箭头之间的空气变成构图的一部分而不是没画满。
 *   3. **锐角**。参照的箭尖缺口约占高度 45%, 我原来是 15% ——
 *      钝角箭头读起来是"砖块上剜了个小口", 锐角才有速度感。
 *   4. **斜引线**。引线和箭头斜边**同角度**, 于是引线不是外挂的一根杆,
 *      而是这个形状延伸出去的一笔; 我原来用竖直线, 和图形毫无关系。
 *
 * 再加投影和沿运动方向的渐变。这几样都不需要新技术 —— 全是 custGeom,
 * 缺的一直是设计词汇, 不是渲染能力。
 */
export function chevronFlow(opts: ChevronFlowOptions): ComposeNode {
  const t = activeTheme();
  const n = opts.items.length;
  if (n === 0) return nothing();

  const W = opts.width, H = opts.height;
  const ground = opts.onDark ? t.ink : t.paper;

  const h = Math.round(Math.min(88, H * 0.20));
  const tip = Math.round(h * 0.46);                 /* 锐角: 缺口占高度 46% */
  const gap = Math.round(tip * 1.15);               /* 箭头之间的空气 (回声正好落在这里) */
  const w = Math.round((W - gap * (n - 1)) / n);
  const bandY = Math.round(H * 0.44);

  const palette = opts.multicolor ? hueRotatePalette(n) : null;
  const shade = (i: number) => palette
    ? palette[i]!
    : mixHex(lighten(t.accent, 0.20), t.accent, n === 1 ? 0 : i / (n - 1));

  /** 箭头本体: 左侧凹口 + 右侧尖, 两者同深度才能咬合成一套 */
  const chev = (ww: number): VectorPath => ({
    d: `M0,0 H${ww - tip} L${ww},${h / 2} L${ww - tip},${h} H0 L${tip},${h / 2} Z`,
    viewBox: { width: ww, height: h },
  });

  /* 同排 (上排 0,2,4 / 下排 1,3) 相邻两条说明会对着伸, 必然撞。
   * 所以要按**同排下一个徽章**的位置夹宽度 —— 这需要能算出任意 i 的徽章 x,
   * 于是把它抽出来。第一版没抽, 结果第 3 条往右伸、第 5 条往左伸, 在中间撞成一团。 */
  const badgeD = 42;
  const badgeX = (i: number) => {
    const runY = Math.round(H * 0.17);
    const runX = Math.round((runY * tip) / (h / 2));
    return i * (w + gap) + w - Math.round(tip * 0.9) - runX - badgeD - 6;
  };

  /* 字色**整排定一次** —— 逐个算会出现"前两个白字后三个深字", 一排里跳色
   * 比某一格对比度略低难看得多, 还会被读成"这几格不是同类"。 */
  const fg = uniformTextOn(opts.items.map((_, i) => shade(i)));

  const layers: ComposeNode[] = [];

  opts.items.forEach((item, i) => {
    const x = i * (w + gap);
    const c = shade(i);

    /* ── 回声轮廓: 同形状、只描边、右后方错开 ──────────────
     * 画在实心之前, 所以实心会压住它的左半 —— 露出来的正好是右边那一段,
     * 读成"箭头刚从这儿走过去"。 */
    layers.push(Shape({
      geometry: 'custom', width: w, height: h,
      fill: mixHex(ground, c, 0.55),
      customPath: { ...chev(w), strokeOnly: true },
      border: { color: mixHex(ground, c, 0.55), width: 1.4 },
      padding: { top: bandY, left: x + Math.round(tip * 1.5), right: 0, bottom: 0 },
    }));

    /* ── 实心箭头 ────────────────────────────────────── */
    layers.push(Shape({
      geometry: 'custom', width: w, height: h, fill: c,
      customPath: chev(w),
      /* 渐变**沿运动方向** (0° = 从左到右), 不是竖直 ——
       * 竖直渐变只是让色块有点起伏, 横向渐变才和"往前走"这件事同向。 */
      gradient: { stops: [{ pos: 0, color: lighten(c, 0.26) }, { pos: 1, color: c }], angleDeg: 0 },
      effects: { outerShadow: { blur: 34000, distance: 22000, angle: 90, color: t.ink, alpha: 0.16 } },
      padding: { top: bandY, left: x, right: 0, bottom: 0 },
    }));

    layers.push(Text(item.label, {
      fontSize: Math.max(13, Math.round(h * 0.21)), bold: true, color: fg,
      textAlign: 'ctr', singleLine: true, width: w - tip,
      fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
      padding: { top: bandY + Math.round(h * 0.36), left: x + Math.round(tip * 0.6), right: 0, bottom: 0 },
    }));

    /* ── 斜引线 + 徽章 + 说明 ───────────────────────────
     * 引线和箭头斜边**同角度** (方向向量 (tip, h/2) 的镜像), 于是它读起来是
     * 这个形状延伸出去的一笔, 而不是外挂的一根杆。
     *
     * Keep captions on the badge's right side. When space is limited, move the
     * badge along the leader direction and preserve the leader slope so each
     * caption keeps a monotonic, non-overlapping position. */
    const up = i % 2 === 0;
    const slope = (h / 2) / tip;                          /* 斜边斜率 */
    const runY0 = Math.round(H * 0.17);
    const x0 = x + w - Math.round(tip * 0.9);
    const y0 = up ? bandY : bandY + h;

    let x1 = x0 - Math.round(runY0 / slope);
    let y1 = up ? y0 - runY0 : y0 + runY0;

    /* 文字下限 —— 中文说明窄于这个宽度就会被压成一条竖字带 */
    const MIN_TW = 190;
    const wantW = Math.round(w * 1.35);
    /* 右边界: 同排下一个徽章的左缘 (最后一个到版面右缘) */
    const nextLimit = i + 2 < n ? badgeX(i + 2) - 16 : W;
    const need = badgeD + 12 + MIN_TW;
    const over = (x1 - badgeD - 6) + need - Math.min(nextLimit, W);
    if (over > 0) {
      /* 沿引线往左拉 over, 同时按斜率抬 y —— 保持和箭尖平行 */
      x1 -= over;
      y1 += (up ? -1 : 1) * Math.round(over * slope);
    }

    layers.push(Shape({
      geometry: 'custom', width: W, height: H,
      fill: mixHex(ground, c, 0.62),
      customPath: {
        d: `M${x0},${y0} L${x1},${y1}`,
        viewBox: { width: W, height: H }, strokeOnly: true,
      },
      border: { color: mixHex(ground, c, 0.62), width: 1.3 },
    }));

    /* 引线尽头的图标徽章: 浅色光晕 + 白底圆 + accent 图标 */
    const bd = badgeD;
    const bx = x1 - bd - 6, by = y1 - bd / 2;
    layers.push(Shape({
      geometry: 'custom', width: bd + 14, height: bd + 14,
      fill: withAlpha(c, 0.16),
      customPath: circlePath(bd + 14),
      padding: { top: by - 7, left: bx - 7, right: 0, bottom: 0 },
    }));
    layers.push(Shape({
      geometry: 'custom', width: bd, height: bd, fill: ground,
      customPath: circlePath(bd),
      padding: { top: by, left: bx, right: 0, bottom: 0 },
    }));
    if (item.icon && hasIcon(item.icon)) {
      layers.push(iconGlyph(item.icon, {
        size: Math.round(bd * 0.52), color: c,
        padding: { top: by + Math.round(bd * 0.24), left: bx + Math.round(bd * 0.24) },
      }));
    }

    const tw = Math.max(MIN_TW, Math.min(wantW, Math.min(nextLimit, W) - (bx + bd + 12)));
    layers.push(Text(item.desc ?? '', {
      fontSize: 14, color: opts.onDark ? mixHex(t.onInk, t.ink, 0.28) : t.muted,
      width: tw, maxLines: 3,
      fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
      padding: { top: by - 4, left: bx + bd + 12, right: 0, bottom: 0 },
    }));
  });

  return ZStack({ align: 'start', width: W, height: H }, layers);
}
