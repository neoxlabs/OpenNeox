/**
 * dataviz-bits — 数值的**形状**: 进度环 / 评分点阵 / 迷你趋势线 / 占比条 / 目标条.
 *
 * 【为什么 chartFocus 之外还要这一层】chartFocus 是"一整页讲一组数据"。但 deck 里
 * 大量的数字是**贴在别的东西旁边**的: KPI 卡上的 82%、单数字页的 5.2×、
 * 表格旁边的一条趋势。这些数现在只有字号大小的区别 —— 一页六张卡就是六个大字,
 * 观众得逐个读完才知道哪个好哪个差。
 *
 * 加一个形状, "82%" 立刻有了参照系: 环走了多少、条填了多少、趋势是往上还是往下。
 * 这不是装饰 —— 它编码的信息是数字本身没有的 (**跟谁比**)。
 *
 * 【所以它和 decor-vector 是两类东西, 判据也相反】
 *   decor-vector 必须读不出意思, 像在表达什么就是画错了
 *   dataviz-bits 必须**准确**表达, 画出来的比例和数值对不上就是在骗人
 * 因此这里所有形状都由数值直接算出, 没有任何"看起来好看点"的手动微调:
 * 一旦允许微调, 图形和数字就会悄悄脱钩, 而观众无从察觉。
 *
 * 【单位约定】value 一律传**原始值**, 不要先自己换算成百分比:
 * 换算规则 (要不要除以 max、要不要截断) 集中在这里, 散到调用方就会出现
 * "这一页按 100 算、那一页按 max 算"的不一致。
 */

import type { ComposeNode } from '../compose/types.js';
import { ZStack, HStack, Text, Shape } from '../compose/dsl.js';
import { activeTheme } from './theme.js';
import { mixHex, bestTextOn, nothing } from './motif-bits.js';
import { slabPath, circlePath, type VectorPath } from './diagram-bits.js';

/* ============================================================
 * 弧 —— 进度环的基础
 * ============================================================ */

/**
 * 从 12 点方向顺时针画一段弧, 占整圈的 frac (0~1)。
 *
 * Full circles use two arcs because coincident endpoints make one SVG arc
 * degenerate. Fractions above one half set the large-arc flag so the path
 * represents the requested portion rather than its complement.
 */
export function arcPath(size: number, thickness: number, frac: number): VectorPath {
  const r = (size - thickness) / 2;
  const c = size / 2;
  const at = (deg: number) => {
    const a = ((deg - 90) * Math.PI) / 180;   /* -90 = 从 12 点起 */
    return `${(c + r * Math.cos(a)).toFixed(2)},${(c + r * Math.sin(a)).toFixed(2)}`;
  };
  const f = Math.max(0, Math.min(1, frac));
  const vb = { width: size, height: size };
  if (f >= 1) {
    return { d: `M${at(0)} A${r},${r} 0 0 1 ${at(180)} A${r},${r} 0 0 1 ${at(0)}`, viewBox: vb };
  }
  if (f <= 0) return { d: '', viewBox: vb };
  const end = f * 360;
  return { d: `M${at(0)} A${r},${r} 0 ${end > 180 ? 1 : 0} 1 ${at(end)}`, viewBox: vb };
}

/* ============================================================
 * 1 · progressRing —— 进度环
 * ============================================================ */

export interface ProgressRingOptions {
  /** 0~1. 传 0.82 不是 82 */
  value: number;
  size?: number;
  /** 环宽 px, 默认按尺寸的 11% */
  thickness?: number;
  /** 环心文字, 缺省用百分比 */
  centerText?: string;
  onDark?: boolean;
}

export function progressRing(opts: ProgressRingOptions): ComposeNode {
  const t = activeTheme();
  const size = opts.size ?? 120;
  const th = opts.thickness ?? Math.max(6, Math.round(size * 0.11));
  const v = Math.max(0, Math.min(1, opts.value));
  const ground = opts.onDark ? t.ink : t.paper;
  /* 轨道色必须和底色拉开, 又不能抢过进度弧 —— 混 0.18 是"看得见但不说话"的量 */
  const track = mixHex(ground, opts.onDark ? t.onInk : t.ink, 0.18);

  const layers: ComposeNode[] = [
    /* 轨道: 整圈 */
    Shape({
      geometry: 'custom', width: size, height: size, fill: track,
      customPath: { ...arcPath(size, th, 1), strokeOnly: true },
      border: { color: track, width: th },
    }),
  ];

  /* 进度弧. v=0 时路径是空串, 画出来是个零尺寸形状 —— 直接不画 */
  if (v > 0) {
    layers.push(Shape({
      geometry: 'custom', width: size, height: size, fill: t.accent,
      customPath: { ...arcPath(size, th, v), strokeOnly: true },
      border: { color: t.accent, width: th },
    }));
  }

  const label = opts.centerText ?? `${Math.round(v * 100)}%`;
  /* 字号按**字数**收: 环心的可用宽度是内径 (size - 2*th), 写死一个比例时
   * "82%" 刚好而 "100%" 顶边、自定义的 "¥680万" 直接溢出环外。
   * 这和 numbersHero/manifesto 那两处是同一个道理 —— 字号得看内容多长。 */
  const inner = size - th * 2;
  const chars = Math.max(1, [...label].length);
  const ringFont = Math.max(11, Math.min(
    Math.round(size * 0.24),
    Math.round((inner * 0.92) / (chars * 0.62) * (72 / 96)),
  ));
  layers.push(Text(label, {
    fontSize: ringFont, bold: true,
    color: opts.onDark ? t.onInk : t.ink,
    textAlign: 'ctr', singleLine: true, width: size,
    fontLatin: t.fonts.numeric, fontEast: t.fonts.textEast,
    padding: { top: Math.round(size / 2 - ringFont * (96 / 72) * 0.62), left: 0, right: 0, bottom: 0 },
  }));

  return ZStack({ align: 'start', width: size, height: size }, layers);
}

/* ============================================================
 * 2 · ratingDots —— 评分点阵
 * ============================================================ */

export interface RatingDotsOptions {
  /** 得分, 和 max 同量纲 (4.6 / 5) */
  value: number;
  max?: number;
  dot?: number;
  gap?: number;
  onDark?: boolean;
}

export function ratingDots(opts: RatingDotsOptions): ComposeNode {
  const t = activeTheme();
  const max = Math.max(1, Math.round(opts.max ?? 5));
  const d = opts.dot ?? 14;
  const gap = opts.gap ?? 8;
  const ground = opts.onDark ? t.ink : t.paper;
  const empty = mixHex(ground, opts.onDark ? t.onInk : t.ink, 0.22);

  /* 半颗不画成半圆 —— 半圆在小尺寸下读不出来, 反而像渲染坏了。
   * 四舍五入到整颗, 并把真实值留给旁边的数字去说 (5 颗点的分辨率本来就只有整颗)。 */
  const filled = Math.max(0, Math.min(max, Math.round(opts.value)));

  return HStack({ gap, align: 'center' },
    Array.from({ length: max }, (_, i) => Shape({
      geometry: 'custom', width: d, height: d,
      fill: i < filled ? t.accent : empty,
      customPath: circlePath(d),
    })),
  );
}

/* ============================================================
 * 3 · sparkline —— 迷你趋势线
 * ============================================================ */

export interface SparklineOptions {
  values: Array<number | null>;
  width: number;
  height: number;
  /** 线下填充 —— 让趋势有体量, 小尺寸下比裸线好读 */
  area?: boolean;
  /** 末点强调 (设计上的"现在在这儿") */
  endpoint?: boolean;
  onDark?: boolean;
}

export function sparkline(opts: SparklineOptions): ComposeNode {
  const t = activeTheme();
  const W = opts.width, H = opts.height;
  /* null = 这期没数据, 和 0 完全是两回事 —— 跳过, 不要当 0 画成一个坑。
   * (chartFocus 那边已经定了这个约定, 这里必须一致, 否则同一份 deck 两种语义。) */
  const pts = opts.values
    .map((v, i) => ({ v, i }))
    .filter((p): p is { v: number; i: number } => typeof p.v === 'number' && Number.isFinite(p.v));
  if (pts.length < 2) return nothing();

  const vs = pts.map((p) => p.v);
  let lo = Math.min(...vs), hi = Math.max(...vs);
  /* 全平的一条线: 不能除以 0, 也不该贴着上下边 —— 撑开一点让它落在中间 */
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pad = Math.max(2, H * 0.12);
  const n = opts.values.length - 1;
  const x = (i: number) => (n === 0 ? 0 : (i / n) * W);
  const y = (v: number) => pad + (1 - (v - lo) / (hi - lo)) * (H - pad * 2);

  const f = (u: number) => Math.round(u * 100) / 100;

  /* Split the data into contiguous runs so null observations create gaps
   * instead of implying values that were never recorded. */
  const runs: Array<Array<{ v: number; i: number }>> = [];
  for (const p of pts) {
    const last = runs[runs.length - 1];
    if (last && p.i === last[last.length - 1]!.i + 1) last.push(p);
    else runs.push([p]);
  }

  const layers: ComposeNode[] = [];
  const seg = (run: Array<{ v: number; i: number }>) =>
    run.map((p, k) => `${k === 0 ? 'M' : 'L'}${f(x(p.i))},${f(y(p.v))}`).join(' ');

  if (opts.area !== false) {
    const d = runs
      .filter((r) => r.length >= 2)
      .map((r) => `${seg(r)} L${f(x(r[r.length - 1]!.i))},${H} L${f(x(r[0]!.i))},${H} Z`)
      .join(' ');
    if (d) {
      layers.push(Shape({
        geometry: 'custom', width: W, height: H,
        fill: mixHex(opts.onDark ? t.ink : t.paper, t.accent, 0.20),
        customPath: { d, viewBox: { width: W, height: H } },
      }));
    }
  }

  const lineD = runs.filter((r) => r.length >= 2).map(seg).join(' ');
  if (lineD) {
    layers.push(Shape({
      geometry: 'custom', width: W, height: H, fill: t.accent,
      customPath: { d: lineD, viewBox: { width: W, height: H }, strokeOnly: true },
      border: { color: t.accent, width: 2 },
    }));
  }
  /* 孤立点 (两侧都缺数据) —— 连不成线, 但它是真实观测值, 不能不画 */
  for (const r of runs.filter((q) => q.length === 1)) {
    const p = r[0]!, dd = 6;
    layers.push(Shape({
      geometry: 'custom', width: dd, height: dd, fill: t.accent,
      customPath: circlePath(dd),
      padding: {
        top: Math.round(y(p.v) - dd / 2), left: Math.round(x(p.i) - dd / 2),
        right: 0, bottom: 0,
      },
    }));
  }

  if (opts.endpoint !== false) {
    const last = pts[pts.length - 1]!;
    const dd = 7;
    layers.push(Shape({
      geometry: 'custom', width: dd, height: dd, fill: t.accent,
      customPath: circlePath(dd),
      padding: {
        top: Math.round(y(last.v) - dd / 2), left: Math.round(x(last.i) - dd / 2),
        right: 0, bottom: 0,
      },
    }));
  }

  return ZStack({ align: 'start', width: W, height: H }, layers);
}

/* ============================================================
 * 4 · proportionBar —— 占比条
 * ============================================================ */

export interface ProportionSegment {
  value: number;
  label?: string;
  color?: string;
}

export interface ProportionBarOptions {
  segments: ProportionSegment[];
  width: number;
  height?: number;
  onDark?: boolean;
}

export function proportionBar(opts: ProportionBarOptions): ComposeNode {
  const t = activeTheme();
  const H = opts.height ?? 18;
  const W = opts.width;
  const segs = opts.segments.filter((s) => Number.isFinite(s.value) && s.value > 0);
  const total = segs.reduce((a, s) => a + s.value, 0);
  if (total <= 0 || segs.length === 0) return nothing();

  const ground = opts.onDark ? t.ink : t.paper;
  /* 段色按深浅递减而不是各挑一个色相 —— 占比条各段是**同一个量的切分**,
   * 用不同色相会读成"不同种类的东西"。深浅递减才是"同一件事分了几块"。 */
  const shade = (i: number) => segs[i]!.color
    ?? mixHex(t.accent, ground, (i / Math.max(1, segs.length - 1)) * 0.62);

  const layers: ComposeNode[] = [];
  let acc = 0;
  segs.forEach((s, i) => {
    const w = Math.max(1, Math.round((s.value / total) * W));
    const left = Math.round((acc / total) * W);
    acc += s.value;
    layers.push(Shape({
      geometry: 'custom', width: w, height: H, fill: shade(i),
      /* 只有首尾两段圆角, 中间是直边 —— 每段都圆角就成了一串胶囊, 读成并列而不是切分 */
      customPath: slabPath(w, H, i === 0 || i === segs.length - 1 ? Math.round(H / 2) : 0),
      padding: { top: 0, left, right: 0, bottom: 0 },
    }));
  });

  return ZStack({ align: 'start', width: W, height: H }, layers);
}

/* ============================================================
 * 5 · bulletBar —— 实绩 vs 目标
 * ============================================================ */

export interface BulletBarOptions {
  value: number;
  target: number;
  /** 量程上限, 缺省取 value/target 的较大者再放 15% */
  max?: number;
  /**
   * 这个指标**越小越好** (换乘距离/成本/时长/损失率/投诉量)。
   *
 * The caller declares whether a lower value is better because the direction
 * cannot be inferred from the two numeric values alone.
   */
  lowerIsBetter?: boolean;
  width: number;
  height?: number;
  onDark?: boolean;
}

/**
 * 一条实绩 + 一根目标标线。KPI 最常见的问法是"离目标还差多少",
 * 光一个数字答不了 —— 这个形状答得了。
 */
export function bulletBar(opts: BulletBarOptions): ComposeNode {
  const t = activeTheme();
  const H = opts.height ?? 16;
  const W = opts.width;
  const max = opts.max ?? Math.max(opts.value, opts.target) * 1.15;
  if (!(max > 0)) return nothing();
  const ground = opts.onDark ? t.ink : t.paper;

  const vw = Math.max(2, Math.round((Math.max(0, opts.value) / max) * W));
  const tx = Math.round((Math.max(0, opts.target) / max) * W);
  /* 达标与否用**明度**区分, 不用红绿 —— 灰度打印和色盲眼里红绿是同一个灰 */
  const met = opts.lowerIsBetter ? opts.value <= opts.target : opts.value >= opts.target;
  const barColor = met ? t.accent : mixHex(t.accent, ground, 0.42);

  return ZStack({ align: 'start', width: W, height: H }, [
    Shape({
      geometry: 'custom', width: W, height: H,
      fill: mixHex(ground, opts.onDark ? t.onInk : t.ink, 0.14),
      customPath: slabPath(W, H, Math.round(H / 2)),
    }),
    Shape({
      geometry: 'custom', width: vw, height: H, fill: barColor,
      customPath: slabPath(vw, H, Math.round(H / 2)),
    }),
    /* 目标标线比条高一截, 才读成"标尺"而不是条里的一段 */
    Shape({
      geometry: 'custom', width: 3, height: H + 8,
      fill: opts.onDark ? t.onInk : t.ink,
      customPath: slabPath(3, H + 8, 1.5),
      padding: { top: -4, left: Math.max(0, Math.min(W - 3, tx - 1)), right: 0, bottom: 0 },
    }),
  ]);
}

/** 供模板做"这张卡该配哪种形状"的兜底判断用 */
export function pctText(v: number): string {
  return `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;
}

export { bestTextOn };
