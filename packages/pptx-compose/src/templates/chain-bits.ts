/**
 * chain-bits — 节点链: 轨道 × 节点 × 连接器 × 标注.
 *
 * 【这一层的立论】明康给的稻壳流程图截图里有九个版式看着完全不同 (圆环弧箭头链 /
 * 鱼骨 / 之字 / 上升大道 / 椭圆轨道 …), 但它们是**同一套语法的排列组合**:
 *
 *     轨道 track      节点沿什么曲线排 (直线 / 弧 / 上升斜线 / 之字 / 椭圆)
 *     节点 node       圆 + 光晕环 + 图标 + 标题
 *     连接器 connector 两节点之间画什么 (弧形箭头 / 直箭头 / 咬合楔形 / 无)
 *     标注 caption    正文摆哪 (下方 / 上下交替 / 引线)
 *
 * 所以不该照着截图画九个组件 —— 那是把参数硬编成了二十份代码, 改一次配色要改
 * 二十处。做成四个正交的维度, 九个版式是参数组合, 而且能组合出截图里没有的。
 *
 * 【为什么不用现成的图库】GoJS / DHTMLX / DgrmJS 那一类是**交互式流程图编辑器**,
 * 解决的是节点连线的图论布局 (谁连谁、怎么不打结), 不是这种装饰性信息图;
 * 而且它们输出 SVG DOM, 我们要的是 headless Node 里出 OOXML custGeom,
 * 且在 PowerPoint 里仍然是可编辑图形。d3-shape 只是路径字符串生成器,
 * 我们需要的几条参数曲线自己写十几行就有, 不值得为它引一个运行时依赖。
 *
 * SmartArt 也否掉了: 它要 data/layout/style/colors 四个部件联动, 主流库都不支持,
 * 而且 SmartArt 自己还得带一份普通形状的回退渲染 —— 绕一圈落地还是形状。
 *
 * 【箭头为什么是填充路径而不是线加箭头帽】我们的导出器根本没有 <a:headEnd>/
 * <a:tailEnd>。这反而是对的: 稻壳那些弧形箭头本来就是**带锥度的填充带**
 * (起点细终点粗), 线加箭头帽做不出来; 而且箭头帽的样式在 Office / WPS /
 * LibreOffice / Keynote 里各画各的, 填充路径四个引擎长得一模一样。
 */

import type { ComposeNode } from '../compose/types.js';
import { ZStack, Text, Shape } from '../compose/dsl.js';
import { activeTheme, activeSpec } from './theme.js';
import { withAlpha, mixHex, lighten, bestTextOn, hueRotatePalette, nothing } from './motif-bits.js';
import { circlePath, slabPath, type VectorPath } from './diagram-bits.js';
import { iconGlyph, hasIcon, type IconName } from './icon-bits.js';

type P = readonly [number, number];

/* ============================================================
 * ribbonArrowPath —— 带锥度的弧形箭头 (一条闭合填充路径)
 * ============================================================ */

export interface RibbonArrowOptions {
  /** 弯多少 px, 正数向法线一侧鼓 (换号就是另一侧) */
  bulge?: number;
  /** 起点带宽 / 终点带宽 —— 不相等就是锥度 */
  widthStart?: number;
  widthEnd?: number;
  /** 箭头长 / 箭头宽 */
  headLength?: number;
  headWidth?: number;
  /** 采样数. 24 段在这个尺寸下已经看不出折线 */
  samples?: number;
}

/**
 * 从 p0 到 p1 画一条弯曲的实心箭头。
 *
 * 做法: 二次贝塞尔作中线 → 沿法线两侧偏移出带宽 → 末端留出箭头长度 →
 * 补一个三角。全部解析算出, **不需要旋转** —— 这很重要, 因为 compose 的
 * ShapeParams 根本没有暴露 rotation (renderer 底层有, 但 paint 没往下传),
 * 靠旋转摆箭头这条路是不通的。算顶点则完全绕开这个问题。
 */
export function ribbonArrowPath(
  p0: P, p1: P, box: { width: number; height: number }, opts?: RibbonArrowOptions,
): VectorPath {
  const bulge = opts?.bulge ?? 40;
  const w0 = opts?.widthStart ?? 5;
  const w1 = opts?.widthEnd ?? 9;
  const headL = opts?.headLength ?? 18;
  const headW = opts?.headWidth ?? 20;
  const N = Math.max(8, opts?.samples ?? 24);

  const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  const len = Math.hypot(dx, dy) || 1;
  /* 控制点 = 中点沿法线推出 bulge。法线取 (dy,-dx) 归一化 —— 换 bulge 的符号
   * 就是往另一侧鼓, 上下交替的弧就是这么来的。 */
  const nx = dy / len, ny = -dx / len;
  const cx = (p0[0] + p1[0]) / 2 + nx * bulge * 2;
  const cy = (p0[1] + p1[1]) / 2 + ny * bulge * 2;

  const at = (t: number): P => {
    const u = 1 - t;
    return [u * u * p0[0] + 2 * u * t * cx + t * t * p1[0],
            u * u * p0[1] + 2 * u * t * cy + t * t * p1[1]];
  };
  const tan = (t: number): P => {
    const u = 1 - t;
    const x = 2 * u * (cx - p0[0]) + 2 * t * (p1[0] - cx);
    const y = 2 * u * (cy - p0[1]) + 2 * t * (p1[1] - cy);
    const m = Math.hypot(x, y) || 1;
    return [x / m, y / m];
  };

  /* 累计弧长 —— 箭头要"从末端往回退 headL", 按参数 t 退是错的
   * (二次贝塞尔的 t 不是等弧长的, 弯得越厉害偏差越大)。 */
  const ts: number[] = [], cum: number[] = [0];
  for (let i = 0; i <= N; i++) ts.push(i / N);
  for (let i = 1; i <= N; i++) {
    const a = at(ts[i - 1]!), b = at(ts[i]!);
    cum.push(cum[i - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = cum[N]!;
  const cut = Math.max(0, total - headL);
  /* 在累计表里插值出 cut 对应的 t */
  let tEnd = 1;
  for (let i = 1; i <= N; i++) {
    if (cum[i]! >= cut) {
      const span = cum[i]! - cum[i - 1]! || 1;
      tEnd = ts[i - 1]! + ((cut - cum[i - 1]!) / span) * (1 / N);
      break;
    }
  }

  const f = (v: number) => Math.round(v * 100) / 100;
  const halfAt = (t: number) => (w0 + (w1 - w0) * t) / 2;

  const upper: string[] = [], lower: string[] = [];
  for (let i = 0; i <= N; i++) {
    const t = (ts[i]! / 1) * tEnd;
    const p = at(t), d = tan(t);
    const h = halfAt(t);
    upper.push(`${f(p[0] - d[1] * h)},${f(p[1] + d[0] * h)}`);
    lower.push(`${f(p[0] + d[1] * h)},${f(p[1] - d[0] * h)}`);
  }
  lower.reverse();

  const tip = at(1), dEnd = tan(tEnd);
  const base = at(tEnd);
  const hw = headW / 2;
  const bl: P = [base[0] - dEnd[1] * hw, base[1] + dEnd[0] * hw];
  const br: P = [base[0] + dEnd[1] * hw, base[1] - dEnd[0] * hw];

  const d = [
    `M${upper[0]}`,
    ...upper.slice(1).map((q) => `L${q}`),
    `L${f(bl[0])},${f(bl[1])}`,
    `L${f(tip[0])},${f(tip[1])}`,
    `L${f(br[0])},${f(br[1])}`,
    ...lower.map((q) => `L${q}`),
    'Z',
  ].join(' ');

  return { d, viewBox: { width: box.width, height: box.height } };
}

/* ============================================================
 * 轨道 —— 节点排在哪条曲线上
 * ============================================================ */

export type TrackKind = 'row' | 'rising' | 'zigzag' | 'ellipse';

/** 第 i 个节点 (共 n 个) 的圆心, 在 width×height 的框里 */
function trackPoint(kind: TrackKind, i: number, n: number, W: number, H: number, r: number): P {
  const m = r + 6;                                  /* 贴边留一点, 光晕环不被裁 */
  const x = n === 1 ? W / 2 : m + (i / (n - 1)) * (W - m * 2);
  switch (kind) {
    /* 上升: 从左下到右上。稻壳那张"上升大道"的骨架就是这条线, 只是它另外
     * 铺了一条透视的宽箭头当底 —— 节点位置本身是同一条。 */
    case 'rising': return [x, H - m - (i / Math.max(1, n - 1)) * (H - m * 2)];
    /* 之字: 上下交替。适合条目多、每条要配一段说明的场合 */
    case 'zigzag': return [x, i % 2 === 0 ? m : H - m];
    /* 椭圆: 节点排在**前半弧**上 (从左经过底部到右)。稻壳那张"环绕轨道"的
     * 骨架就是它 —— 后半弧被中间的主视觉挡住, 所以只用前半。
     * 留 5° 余量, 免得首尾两个球正好压在椭圆最左最右的端点上。 */
    case 'ellipse': {
      const rx = W / 2 - m, ry = H / 2 - m;
      const th = ((175 - (n === 1 ? 85 : (i / (n - 1)) * 170)) * Math.PI) / 180;
      return [W / 2 + rx * Math.cos(th), H / 2 + ry * Math.sin(th)];
    }
    case 'row':
    default:       return [x, H / 2];
  }
}

/* ============================================================
 * nodeChain —— 节点链
 * ============================================================ */

export interface ChainStep {
  label: string;
  desc?: string;
  icon?: IconName;
  /** 覆盖这一节点的颜色. 不传则整链同色 —— 见下面对"多彩"的说明 */
  color?: string;
}

export interface NodeChainOptions {
  steps: ChainStep[];
  width: number;
  height: number;
  track?: TrackKind;
  connector?: 'arc' | 'line' | 'none';
  /** 节点直径, 缺省按格宽自适应 */
  nodeSize?: number;
  /**
   * 节点长相。sphere 用径向渐变做出球体感 (高光偏左上), flat 是平涂圆。
   * 球体只在 accent 足够饱和时好看; 极浅或极深的主题上 flat 反而干净。
   */
  nodeStyle?: 'flat' | 'sphere';
  /** track:'ellipse' 时把轨道本身画出来 (一圈细线) */
  showTrack?: boolean;
  /**
   * 标注放哪。
   *   inside 标题写在节点里 (节点要够大)
   *   below   节点里只放**序号**, 标题和说明落在节点正下方
   * below keeps captions aligned with each node on tracks whose node heights vary.
   */
  labelPlacement?: 'inside' | 'below';
  /**
   * 每个节点一个颜色。
   *
   * 稻壳那批图默认是**彩色**的 (蓝橙灰黄蓝), 但那在信息上是有害的:
   * 流程的各步是同一类东西, 给不同颜色等于说它们分属不同种类 ——
   * 和当初 featureGrid 按 i%6 发形状是同一个错。
   * 所以默认走**同色深浅**递进 (那才对应"一步步往前"), 要彩色得显式开,
   * 且只在各步真的分属不同主体时才该开 (比如五个不同部门)。
   */
  multicolor?: boolean;
  onDark?: boolean;
}

export function nodeChain(opts: NodeChainOptions): ComposeNode {
  const t = activeTheme();
  const n = opts.steps.length;
  if (n === 0) return nothing();

  const W = opts.width, H = opts.height;
  const connector = opts.connector ?? 'arc';
  const track = opts.track ?? 'row';
  const ground = opts.onDark ? t.ink : t.paper;

  /* 节点直径: 一格宽的 62%, 但不超过框高的一半 (要给光晕和标注留地方) */
  const cell = W / Math.max(1, n);
  const D = opts.nodeSize ?? Math.round(Math.min(cell * 0.62, H * 0.52));
  const R = D / 2;
  const halo = Math.round(D * 1.22);

  const below = opts.labelPlacement === 'below';

  /* Reserve caption space before laying out the track so below-node labels stay
   * inside the composition bounds. */
  const CAPTION_H = 78;
  const trackH = below ? Math.max(halo + 8, H - CAPTION_H) : H;
  const pts = opts.steps.map((_, i) => trackPoint(track, i, n, W, trackH, halo / 2));

  const palette = opts.multicolor ? hueRotatePalette(n) : null;
  const nodeColor = (i: number) => opts.steps[i]?.color
    ?? (palette
      /* Rotate hue while keeping saturation and lightness stable so each
       * explicitly multicolored step has comparable visual weight. */
      ? palette[i]!
      /* 默认: 同色由浅到深, 对应"一步步往前推进" */
      : mixHex(mixHex(t.accent, ground, 0.34), t.accentDeep, n === 1 ? 0 : i / (n - 1)));

  const layers: ComposeNode[] = [];

  /* ── 椭圆轨道本身 (最底层) ──────────────────────────── */
  if (track === 'ellipse' && opts.showTrack !== false) {
    const m = halo / 2 + 6;
    const rx = W / 2 - m, ry = trackH / 2 - m;
    /* A full circle uses two arcs because one arc with coincident endpoints
     * renders as an empty path. */
    const line = mixHex(ground, t.accent, 0.42);
    /* 两圈: 外面一圈更淡更大的, 里面一圈实一点的 —— 单独一条细线看着像
     * "随手画了个圈", 两条才读成"一条有厚度的轨道"。 */
    const faint = mixHex(ground, t.accent, 0.20);
    layers.push(Shape({
      geometry: 'custom', width: W, height: H, fill: faint,
      customPath: {
        d: `M${W / 2 - rx - 10},${trackH / 2} A${rx + 10},${ry + 7} 0 0 1 ${W / 2 + rx + 10},${trackH / 2} `
         + `A${rx + 10},${ry + 7} 0 0 1 ${W / 2 - rx - 10},${trackH / 2} Z`,
        viewBox: { width: W, height: H },
        strokeOnly: true,
      },
      border: { color: faint, width: 1 },
    }));
    layers.push(Shape({
      geometry: 'custom', width: W, height: H, fill: line,
      customPath: {
        d: `M${W / 2 - rx},${trackH / 2} A${rx},${ry} 0 0 1 ${W / 2 + rx},${trackH / 2} `
         + `A${rx},${ry} 0 0 1 ${W / 2 - rx},${trackH / 2} Z`,
        viewBox: { width: W, height: H },
        strokeOnly: true,
      },
      border: { color: line, width: 1.4 },
    }));
  }

  /* ── 连接器先画 (要压在节点底下) ─────────────────────── */
  if (connector !== 'none') {
    for (let i = 0; i < n - 1; i++) {
      const a = pts[i]!, b = pts[i + 1]!;
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const L = Math.hypot(dx, dy) || 1;
      /* 起终点从圆心退到圆周外一点 —— 直接连圆心的话箭头会插进圆里 */
      const gap = R + 10;
      const from: P = [a[0] + (dx / L) * gap, a[1] + (dy / L) * gap];
      const to: P = [b[0] - (dx / L) * gap, b[1] - (dy / L) * gap];
      const bulge = connector === 'arc' ? (i % 2 === 0 ? -1 : 1) * Math.min(34, D * 0.30) : 0;

      layers.push(Shape({
        geometry: 'custom', width: W, height: H,
        /* 连接器不能和节点同重: 它是"关系", 节点才是"内容"。
         * 混掉一半再上, 是"看得见但不抢"的量。 */
        fill: mixHex(ground, nodeColor(i), 0.55),
        customPath: ribbonArrowPath(from, to, { width: W, height: H }, {
          bulge,
          widthStart: 4, widthEnd: 7,
          headLength: 16, headWidth: 17,
        }),
      }));
    }
  }

  /* ── 节点 ───────────────────────────────────────────── */
  opts.steps.forEach((s, i) => {
    const [cx, cy] = pts[i]!;
    const c = nodeColor(i);
    const fg = bestTextOn(c);

    /* 光晕环: 比实心圆大一圈的半透明同色。稻壳那种"圆被托着"的观感全在这一层,
     * 少了它就是五个平的色块。 */
    layers.push(Shape({
      geometry: 'custom', width: halo, height: halo,
      fill: withAlpha(c, opts.onDark ? 0.26 : 0.18),
      customPath: circlePath(halo),
      padding: { top: Math.round(cy - halo / 2), left: Math.round(cx - halo / 2), right: 0, bottom: 0 },
    }));

    layers.push(Shape({
      geometry: 'custom', width: D, height: D, fill: c,
      customPath: circlePath(D),
      /* 球体 = 径向渐变, 高光偏左上 (光源在左上是绘画默认约定, 一屏里所有球
       * 必须同一个光源方向, 否则读起来像贴了一堆不相干的贴纸)。 */
      ...(opts.nodeStyle === 'sphere'
        ? {
            gradient: {
              stops: [
                { pos: 0, color: lighten(c, 0.62) },
                { pos: 0.45, color: c },
                { pos: 1, color: mixHex(c, t.ink, 0.30) },
              ],
              radial: { cx: 0.33, cy: 0.28 },
            },
          }
        : {}),
      /* 白色细边: 球和底之间的分界。没有它, 深色球压在浅底上读起来像"一个洞",
       * 有了它才是"一个浮在上面的球"。 */
      ...(opts.nodeStyle === 'sphere' ? { border: { color: ground, width: 2 } } : {}),
      padding: { top: Math.round(cy - R), left: Math.round(cx - R), right: 0, bottom: 0 },
    }));

    /* 图标在上、标题在下, 都在圆内。没给图标就只放标题 (居中) */
    const hasIc = !below && !!(s.icon && hasIcon(s.icon));
    if (hasIc) {
      const id = Math.round(D * 0.30);
      /* 用叶子形态的 iconGlyph 而不是 iconMark ——
       * 后者是容器, 在 ZStack 里用 padding 定位会算出负内容框然后被静默丢掉
       * (今天就是这么整排消失的)。 */
      layers.push(iconGlyph(s.icon!, {
        size: id, color: fg,
        padding: { top: Math.round(cy - R + D * 0.20), left: Math.round(cx - id / 2) },
      }));
    }

    if (below) {
      /* 节点里只放序号 —— 两位数编号在 80px 的球里是舒服的, 中文标题不是 */
      layers.push(Text(String(i + 1).padStart(2, '0'), {
        fontSize: Math.max(14, Math.round(D * 0.30)), bold: true, color: fg,
        textAlign: 'ctr', singleLine: true, width: D,
        fontLatin: t.fonts.numeric, fontEast: t.fonts.textEast,
        padding: { top: Math.round(cy - R + D * 0.30), left: Math.round(cx - R), right: 0, bottom: 0 },
      }));
      /* 标题和说明落在这个节点**自己**的正下方, 而不是按格子均分 ——
       * 椭圆轨道上各节点高度不同, 均分的话文字会和球错位。 */
      const capW = Math.round(Math.min(cell * 1.02, 200));
      layers.push(Text(s.label, {
        fontSize: 14, bold: true, color: c, textAlign: 'ctr', singleLine: true, width: capW,
        fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
        padding: { top: Math.round(cy + halo / 2 + 8), left: Math.round(cx - capW / 2), right: 0, bottom: 0 },
      }));
      if (s.desc) {
        layers.push(Text(s.desc, {
          fontSize: 14, color: opts.onDark ? mixHex(t.onInk, t.ink, 0.3) : t.muted,
          textAlign: 'ctr', maxLines: 3, width: capW,
          fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
          padding: { top: Math.round(cy + halo / 2 + 30), left: Math.round(cx - capW / 2), right: 0, bottom: 0 },
        }));
      }
    } else {
      layers.push(Text(s.label, {
        fontSize: Math.max(11, Math.round(D * 0.13)), bold: true, color: fg,
        textAlign: 'ctr', singleLine: true, width: D,
        fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
        padding: {
          top: Math.round(cy - R + D * (hasIc ? 0.58 : 0.42)),
          left: Math.round(cx - R), right: 0, bottom: 0,
        },
      }));
    }
  });

  return ZStack({ align: 'start', width: W, height: H }, layers);
}

/** 链下方的一排说明 —— 和节点各画各的, 因为它要用整格宽而不是圆的宽 */
export function chainCaptions(opts: {
  steps: ChainStep[]; width: number; onDark?: boolean;
}): ComposeNode {
  const t = activeTheme();
  const n = opts.steps.length;
  if (n === 0) return nothing();
  const cell = Math.round(opts.width / n);
  const color = opts.onDark ? mixHex(t.onInk, t.ink, 0.25) : t.muted;

  return ZStack({ align: 'start', width: opts.width, height: 76 },
    opts.steps.map((s, i) => s.desc
      ? Text(s.desc, {
          fontSize: 14, color, textAlign: 'ctr', maxLines: 3,
          width: cell - 18,
          fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
          padding: { top: 0, left: i * cell + 9, right: 0, bottom: 0 },
        })
      : nothing()),
  );
}
