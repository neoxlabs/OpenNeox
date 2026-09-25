/**
 * diagram-bits — 语义图示组件 (流程 / 对比 / 层级 / 漏斗).
 *
 * This module renders content relationships as editable vector components:
 *   flowArrow    步骤有先后  → 箭头链
 *   versusBlock  两者对立    → 左右分栏 + 中缝徽章
 *   pyramidStack 有层级高低  → 金字塔
 *   funnelStack  逐级收窄    → 漏斗
 * Component choice follows the relationship expressed by the content rather
 * than serving as arbitrary decoration.
 *
 * Vector paths keep diagrams editable and render without a runtime bridge:
 *   · 在 pptx 里仍是可编辑图形 (客户要改字改色)
 *   · 同步生成, 不依赖任何运行时桥 (agent 的 node 子进程里未必有)
 * 所以全部走 geometry:'custom' + customPath, 落到 pptx 是 custGeom。
 *
 * All layered shapes use custom paths because padded preset geometry is not
 * preserved inside a ZStack.
 *
 * Layered components offset a translucent backdrop, solid body, and badge so
 * the result has depth without confusing the semantic shape.
 * 所以这里统一的做法是 backdrop 占满整格 · body 缩一圈并压在左上,
 * 让 backdrop 只从右下露出来。
 */

import type { ComposeNode } from '../compose/types.js';
import { VStack, HStack, ZStack, Text, Shape } from '../compose/dsl.js';
import { activeTheme, activeSpec } from './theme.js';
import { withAlpha, mixHex, bestTextOn, nothing } from './motif-bits.js';

export interface VectorPath {
  d: string;
  viewBox: { width: number; height: number };
}

/* ============================================================
 * 路径基元 —— 一律按**真实 px** 出坐标, viewBox 就等于形状自己的宽高.
 * ============================================================
 * 不用 100×100 的归一化坐标系, 是因为图示里的框大多不是正方形:
 * 归一化之后 Shape 会把路径拉伸, 箭头的斜边角度、圆角的圆度全都跟着变形 ——
 * 同一个 chevron 在宽格子里是钝角、窄格子里是锐角, 一排下来根本不像一套。
 * 按真实 px 出坐标, 斜边角度和圆角半径就是我们说了算的。
 */

/** 圆角矩形. ZStack 里 prst roundRect 会被丢, 所以自己用弧线画 */
export function slabPath(w: number, h: number, r = 12): VectorPath {
  const k = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  const d = k <= 0
    ? `M0,0 H${w} V${h} H0 Z`
    : `M${k},0 H${w - k} A${k},${k} 0 0 1 ${w},${k} V${h - k} `
    + `A${k},${k} 0 0 1 ${w - k},${h} H${k} A${k},${k} 0 0 1 0,${h - k} `
    + `V${k} A${k},${k} 0 0 1 ${k},0 Z`;
  return { d, viewBox: { width: w, height: h } };
}

/** 正圆 (两段半弧 —— 单段 360° 弧在 SVG 里是退化的, 画不出来) */
export function circlePath(d: number): VectorPath {
  const r = d / 2;
  return {
    d: `M0,${r} A${r},${r} 0 0 1 ${d},${r} A${r},${r} 0 0 1 0,${r} Z`,
    viewBox: { width: d, height: d },
  };
}

/**
 * 流程链的一节: 右端出尖, 左端凹进去和上一节互锁.
 * notch 同时是尖端长度和凹口深度 —— 两者相等才能严丝合缝地咬住。
 */
export function chevronPath(w: number, h: number, notch: number, flatStart = false): VectorPath {
  const k = Math.max(0, Math.min(notch, w / 2));
  const mid = h / 2;
  const d = flatStart
    ? `M0,0 H${w - k} L${w},${mid} L${w - k},${h} H0 Z`
    : `M0,0 H${w - k} L${w},${mid} L${w - k},${h} H0 L${k},${mid} Z`;
  return { d, viewBox: { width: w, height: h } };
}

/** 梯形 (金字塔 / 漏斗的一层) —— 顶宽 topW · 底宽 botW · 在 w 里居中 */
export function trapezoidPath(w: number, h: number, topW: number, botW: number): VectorPath {
  const t0 = (w - topW) / 2, t1 = (w + topW) / 2;
  const b0 = (w - botW) / 2, b1 = (w + botW) / 2;
  return {
    d: `M${t0},0 H${t1} L${b1},${h} H${b0} Z`,
    viewBox: { width: w, height: h },
  };
}

/* ============================================================
 * Style adaptation: motif parameters control notch depth, corner radius, and
 * backdrop strength so diagrams match the active theme.
 * ============================================================ */
interface DiagramTone {
  /** 箭头斜切深度占高度的比例 */
  notchRatio: number;
  /** 圆角半径 px */
  radius: number;
  /** 半透明背衬的不透明度 */
  backdropAlpha: number;
  /** body 相对整格缩进多少 px (= backdrop 从右下露出来的量) */
  inset: number;
}

function diagramTone(): DiagramTone {
  const motif = activeSpec()?.motif ?? 'none';
  switch (motif) {
    case 'chevron': return { notchRatio: 0.30, radius: 4, backdropAlpha: 0.20, inset: 10 };
    case 'ribbon':  return { notchRatio: 0.22, radius: 2, backdropAlpha: 0.24, inset: 12 };
    case 'capsule': return { notchRatio: 0.16, radius: 22, backdropAlpha: 0.18, inset: 9 };
    /* line 风格刻意**不要**实色大块: 它整套语言是细线和留白, 塞一排实心箭头
     * 就把这套风格的克制毁掉了。改成描边 + 极淡底。 */
    case 'line':    return { notchRatio: 0.14, radius: 6, backdropAlpha: 0.10, inset: 0 };
    default:        return { notchRatio: 0.18, radius: 8, backdropAlpha: 0.16, inset: 8 };
  }
}

/** line 风格走描边而不是实心 —— 判据集中在一处, 免得各组件各判各的 */
function isOutlineStyle(): boolean {
  return (activeSpec()?.motif ?? 'none') === 'line';
}

/* ============================================================
 * 1 · flowArrow —— 流程箭头链
 * ============================================================ */

export interface FlowStep {
  label: string;
  desc?: string;
}

export interface FlowArrowOptions {
  steps: FlowStep[];
  width: number;
  height: number;
  /** 序号白圆. 步骤本来就有先后, 默认开 */
  numbered?: boolean;
}

export function flowArrow(opts: FlowArrowOptions): ComposeNode {
  const t = activeTheme();
  const tone = diagramTone();
  const outline = isOutlineStyle();
  const n = opts.steps.length;
  if (n === 0) return nothing();

  const H = opts.height;
  const notch = Math.round(H * tone.notchRatio);
  /* 咬合式排列: 每节右端的尖正好插进下一节的凹口, 所以水平间距是**负的 notch**。
   * HStack 没有负 gap, 用 0 gap + 每节自己让出 notch 的宽度来等效。 */
  const stepW = Math.round(opts.width / n) + notch;

  const bodyFill = outline ? t.paper : t.accent;
  const labelColor = outline ? t.ink : bestTextOn(t.accent);
  /* desc 不用 alpha —— 文本 alpha 在 LibreOffice 里会吃掉尾字符, Keynote 直接忽略。
   * 预先把颜色混好, 落到 pptx 就是一个普通实色。 */
  const descColor = outline ? t.muted : mixHex(labelColor, bodyFill, 0.30);

  const cells = opts.steps.map((s, i) => {
    const layers: ComposeNode[] = [];

    /* 半透明大箭羽: 占满整格 */
    layers.push(Shape({
      geometry: 'custom', width: stepW, height: H,
      fill: withAlpha(t.accent, tone.backdropAlpha),
      customPath: chevronPath(stepW, H, notch, i === 0),
    }));

    /* 实色本体: 缩一圈并压在左上, 让背衬只从右下露出来 —— 错位才有纵深 */
    const bw = stepW - tone.inset, bh = H - tone.inset;
    layers.push(Shape({
      geometry: 'custom', width: bw, height: bh,
      fill: bodyFill,
      customPath: chevronPath(bw, bh, notch, i === 0),
      /* 描边走 ShapeParams.border —— paint 只认这一个字段。
       * (第一版写了 stroke/strokeWidth, 那两个名字根本不存在, 会被静默丢掉:
       *  TS 不报错是因为我自己加了 as any, 等于亲手关掉了唯一的守卫。) */
      ...(outline ? { border: { color: t.accent, width: 1.5 } } : {}),
      padding: { top: 0, left: 0, right: 0, bottom: 0 },
    }));

    /* 文字区: 躲开左右两个斜切, 否则字会压在尖角上 */
    const padL = notch + 18;
    const textW = Math.max(40, bw - notch * 2 - 30);
    let cy = Math.round(H * 0.17);

    if (opts.numbered !== false) {
      const d = Math.round(H * 0.24);
      layers.push(Shape({
        geometry: 'custom', width: d, height: d,
        fill: outline ? t.accent : t.paper,
        customPath: circlePath(d),
        padding: { top: cy, left: padL, right: 0, bottom: 0 },
      }));
      layers.push(Text(String(i + 1), {
        fontSize: Math.max(11, Math.round(d * 0.46)), bold: true,
        color: outline ? t.paper : t.accent,
        textAlign: 'ctr', singleLine: true, width: d,
        fontLatin: t.fonts.numeric, fontEast: t.fonts.textEast,
        padding: { top: cy + Math.round(d * 0.21), left: padL, right: 0, bottom: 0 },
      }));
      cy += d + 12;
    }

    layers.push(Text(s.label, {
      fontSize: 17, bold: true, color: labelColor, width: textW, maxLines: 2,
      fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
      padding: { top: cy, left: padL, right: 0, bottom: 0 },
    }));

    if (s.desc) {
      layers.push(Text(s.desc, {
        fontSize: 14, color: descColor, width: textW, maxLines: 2,
        fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
        padding: { top: cy + 26, left: padL, right: 0, bottom: 0 },
      }));
    }

    return ZStack({ align: 'start', width: stepW, height: H }, layers);
  });

  return HStack({ gap: -notch, align: 'start', width: opts.width, height: H }, cells);
}

/* ============================================================
 * 2 · versusBlock —— 对比 (两者对立)
 * ============================================================ */

export interface VersusSide {
  title: string;
  items?: string[];
}

export interface VersusBlockOptions {
  left: VersusSide;
  right: VersusSide;
  /** 中缝徽章, 默认 VS */
  label?: string;
  width: number;
  height: number;
}

export function versusBlock(opts: VersusBlockOptions): ComposeNode {
  const t = activeTheme();
  const tone = diagramTone();
  const W = opts.width, H = opts.height;

  const badgeD = Math.round(Math.min(96, H * 0.30));
  /* 两块面板在中缝**留出徽章的一半**, 徽章骑在缝上 —— 骑缝才是"对立"的样子,
   * 摆在缝旁边只是三个并排的块。 */
  const gap = Math.round(badgeD * 0.55);
  const panelW = Math.round((W - gap) / 2);

  /* 左深右浅: 对比要靠**明度**分开, 只靠颜色在灰度打印和色盲眼里就没了 */
  const fills: [string, string] = [t.ink, t.surface];

  const panel = (side: VersusSide, fill: string, x: number): ComposeNode[] => {
    const fg = bestTextOn(fill);
    const sub = mixHex(fg, fill, 0.32);
    const out: ComposeNode[] = [
      Shape({
        geometry: 'custom', width: panelW, height: H, fill,
        customPath: slabPath(panelW, H, tone.radius),
        padding: { top: 0, left: x, right: 0, bottom: 0 },
      }),
    ];
    const padX = x + 28;
    const innerW = panelW - 56;
    out.push(Text(side.title, {
      fontSize: 22, bold: true, color: fg, width: innerW, maxLines: 2,
      fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
      padding: { top: 28, left: padX, right: 0, bottom: 0 },
    }));
    /* 分隔短线: 标题和条目之间需要一个停顿, 靠间距不够 —— 面板里的留白
     * 会被读成"没写完", 一条线才读成"分节"。 */
    out.push(Shape({
      geometry: 'custom', width: 40, height: 3, fill: mixHex(fg, fill, 0.45),
      customPath: slabPath(40, 3, 1.5),
      padding: { top: 74, left: padX, right: 0, bottom: 0 },
    }));
    let y = 96;
    for (const item of side.items ?? []) {
      out.push(Shape({
        geometry: 'custom', width: 7, height: 7, fill: mixHex(fg, fill, 0.25),
        customPath: circlePath(7),
        padding: { top: y + 7, left: padX, right: 0, bottom: 0 },
      }));
      out.push(Text(item, {
        fontSize: 14, color: sub, width: innerW - 20, maxLines: 2,
        fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
        padding: { top: y, left: padX + 20, right: 0, bottom: 0 },
      }));
      y += 34;
    }
    return out;
  };

  const layers: ComposeNode[] = [
    ...panel(opts.left, fills[0], 0),
    ...panel(opts.right, fills[1], panelW + gap),
  ];

  /* 骑缝徽章: 外圈用 paper 描白边, 把它从两块面板上"抬起来" */
  const bx = Math.round((W - badgeD) / 2), by = Math.round((H - badgeD) / 2);
  const ringD = badgeD + 12;
  layers.push(Shape({
    geometry: 'custom', width: ringD, height: ringD, fill: t.paper,
    customPath: circlePath(ringD),
    padding: { top: by - 6, left: bx - 6, right: 0, bottom: 0 },
  }));
  layers.push(Shape({
    geometry: 'custom', width: badgeD, height: badgeD, fill: t.accent,
    customPath: circlePath(badgeD),
    padding: { top: by, left: bx, right: 0, bottom: 0 },
  }));
  layers.push(Text(opts.label ?? 'VS', {
    fontSize: Math.max(14, Math.round(badgeD * 0.30)), bold: true,
    color: bestTextOn(t.accent), textAlign: 'ctr', singleLine: true, width: badgeD,
    letterSpacingPt: 0.6,
    fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
    padding: { top: by + Math.round(badgeD * 0.32), left: bx, right: 0, bottom: 0 },
  }));

  return ZStack({ align: 'start', width: W, height: H }, layers);
}

/* ============================================================
 * 3 · pyramidStack / 4 · funnelStack —— 层级 与 逐级收窄
 * ============================================================
 * 两者共用一套梯形堆叠, 只有宽度序列相反, 所以走同一个实现:
 *   金字塔 顶尖底宽 · 层间不留缝 (它是一个整体的塔)
 *   漏斗    顶宽底窄 · 层间留缝   (它是分段的流失)
 */

export interface StackLevel {
  label: string;
  desc?: string;
}

interface TaperOptions {
  levels: StackLevel[];
  width: number;
  height: number;
}

function taperStack(opts: TaperOptions, mode: 'pyramid' | 'funnel'): ComposeNode {
  const t = activeTheme();
  const n = opts.levels.length;
  if (n === 0) return nothing();

  /* 【 明康: 漏斗"有点积压"】6px 的缝太窄, 四层挤成一坨深色;
   * 而 0.55 的收缩幅度让底层窄到文字几乎贴着斜边。缝放到 12, 收缩收到 0.40 ——
   * 漏斗要读出"逐级变少", 靠的是**趋势**不是"最后一层有多窄"。 */
  const gap = mode === 'funnel' ? 12 : 0;
  const lvlH = Math.round((opts.height - gap * (n - 1)) / n);
  const W = opts.width;

  /* 金字塔的顶不收到 0: 一个真尖角里放不下字, 那一层就白画了。
   * 留 0.2 的顶宽, 既还是塔的轮廓, 顶层的字也塞得下。 */
  const widthAt = (k: number) => mode === 'pyramid'
    ? W * (0.20 + 0.80 * (k / n))
    : W * (1 - 0.40 * (k / n));

  const rows = opts.levels.map((lv, i) => {
    const topW = Math.round(widthAt(i));
    const botW = Math.round(widthAt(i + 1));
    /* 色阶从深到浅: 金字塔越往上越"高层"该越重, 漏斗越往下越"收窄"该越重 */
    const k = mode === 'pyramid' ? i / Math.max(1, n - 1) : 1 - i / Math.max(1, n - 1);
    const fill = mixHex(t.accentDeep, t.accent, k);
    const fg = bestTextOn(fill);

    return ZStack({ align: 'start', width: W, height: lvlH }, [
      Shape({
        geometry: 'custom', width: W, height: lvlH, fill,
        customPath: trapezoidPath(W, lvlH, topW, botW),
      }),
      Text(lv.label, {
        fontSize: 17, bold: true, color: fg, textAlign: 'ctr', singleLine: true, width: W,
        fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
        padding: {
          top: Math.round(lvlH / 2 - (lv.desc ? 20 : 12)),
          left: 0, right: 0, bottom: 0,
        },
      }),
      lv.desc
        ? Text(lv.desc, {
            fontSize: 14, color: mixHex(fg, fill, 0.28),
            textAlign: 'ctr', singleLine: true, width: W,
            fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
            padding: { top: Math.round(lvlH / 2 + 6), left: 0, right: 0, bottom: 0 },
          })
        : nothing(),
    ]);
  });

  /* gapFixed: 塔的各层必须贴着 (金字塔 gap=0), 漏斗的 6px 缝也是定死的节奏。
   * 不声明的话求解器会为了填满版面把层与层撑开, 塔就散成三块梯形。 */
  return VStack({ gap, align: 'center', width: W, height: opts.height, gapFixed: true }, rows);
}

/** 层级金字塔 —— 用在"有高低之分"的内容上 (战略层/执行层, 能力分级) */
export function pyramidStack(opts: TaperOptions): ComposeNode {
  return taperStack(opts, 'pyramid');
}

/** 漏斗 —— 用在"逐级流失/筛选"的内容上 (曝光→点击→成交) */
export function funnelStack(opts: TaperOptions): ComposeNode {
  return taperStack(opts, 'funnel');
}
