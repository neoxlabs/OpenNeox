
import type { Slide } from '@neoxlabs/pptx-renderer';
import { render } from '../bridge/render.js';
import { ZStack, Shape } from '../compose/dsl.js';
import type { ComposeNode, Frame } from '../compose/types.js';
import { splitPanelShape, bandShape } from '../style/motif.js';
import { activeSpec, activeTheme, PAGE } from './theme.js';
import { mixHex, withAlpha, readableAccent, softInk } from './motif-bits.js';

const W = 1280;
const H = 720;

/** 一块版面区域: 排到哪、以及在这块底上该用什么颜色写字 */
export interface Region {
  bounds: Frame;
  /** 正文/标题色 */
  ink: string;
  /** 次要文字色 */
  muted: string;
  /** 这块底上仍然可读的强调色 */
  accent: string;
  /** 深底? 模板一般不需要看它, 用上面三个色就够 */
  onDark: boolean;
}

export interface SplitFrame {
  /** 色块那一侧 —— 放标题/kicker 这类"标识性"内容 */
  panel: Region;
  /** 主区 —— 放正文/列表/数据 */
  main: Region;
}

/** 深底区域的配色: 强调色在深底上要提亮, 否则暖橙在墨底上直接糊掉 */
function darkRegion(bounds: Frame): Region {
  const t = activeTheme();
  return {
    bounds,
    ink: t.onInk,
    /* 合成实色而不是 alpha —— 文字上的 <a:alpha> 三个渲染器三种结果, 见 softInk */
    muted: softInk(0.72),
    /* 写死 +34% 白是不对的: 四套主题 accent 明度差很大, 本来就亮的会被洗成粉色。
     * 统一走 readableAccent —— 按对比度逐档拉, 够了就停。 */
    accent: readableAccent(t.ink),
    onDark: true,
  };
}

function lightRegion(bounds: Frame): Region {
  const t = activeTheme();
  return { bounds, ink: t.ink, muted: t.muted, accent: t.accent, onDark: false };
}

/** 骨架层统一的画法: 满版 bounds · 不求解 · 不跑 overlap 断言 (背景块本来就相互叠) */
function paintGround(slide: Slide, layers: ComposeNode[]) {
  render(slide, ZStack({ align: 'start', width: W, height: H }, layers), {
    bounds: { x: 0, y: 0, width: W, height: H },
    fit: false,
    assertNoOverlap: false,
  });
}

/**
 * 半版色块 / 斜切分栏 —— 同一个实现, 差别只在边界形状由 motif 决定。
 * ratio 是色块占版宽的比例; 0.38 是试出来的: 再窄撑不住标题, 再宽正文那侧
 * 就只剩一栏半的宽度, 18pt 中文一行不到 20 个字, 读起来很碎。
 */
export function halfPanelFrame(
  slide: Slide,
  opts?: { ratio?: number; side?: 'left' | 'right' },
): SplitFrame {
  const t = activeTheme();
  const spec = activeSpec();
  const ratio = opts?.ratio ?? 0.38;
  const side = opts?.side ?? 'left';
  const edge = W * ratio;

  slide.background.fill = t.paper;

  const shape = spec
    ? splitPanelShape(spec, { width: W, height: H, ratio, side })
    : { d: `M0 0 L${edge} 0 L${edge} ${H} L0 ${H} Z`, viewBox: { width: W, height: H }, skew: 0 };

  paintGround(slide, [
    Shape({
      geometry: 'custom', width: W, height: H,
      /* 平涂的深色块是"一块色", 有渐变的才是"一面墙"。幅度压到 0.10 ——
       * 上一轮 0.28 把底洗成中蓝, 深色锚点没了, 白字对比度跟着掉。 */
      gradient: {
        stops: [
          { pos: 0, color: t.ink },
          { pos: 1, color: mixHex(t.ink, t.accent, 0.1) },
        ],
        angleDeg: side === 'left' ? 60 : 120,
      },
      customPath: { d: shape.d, viewBox: shape.viewBox },
    }),
  ]);

  /* 斜边的危险区: 边界最内侧的位置 = edge ∓ skew, 再留 28px 呼吸 */
  const safe = shape.skew + 28;
  const panelBounds: Frame = side === 'left'
    ? { x: PAGE.padH, y: PAGE.padTop, width: edge - shape.skew - PAGE.padH - 28, height: H - PAGE.padTop - PAGE.padBottom }
    : { x: W - edge + safe, y: PAGE.padTop, width: edge - safe - PAGE.padH, height: H - PAGE.padTop - PAGE.padBottom };
  const mainBounds: Frame = side === 'left'
    ? { x: edge + safe, y: PAGE.padTop, width: W - edge - safe - PAGE.padH, height: H - PAGE.padTop - PAGE.padBottom }
    : { x: PAGE.padH, y: PAGE.padTop, width: W - edge - safe - PAGE.padH, height: H - PAGE.padTop - PAGE.padBottom };

  return { panel: darkRegion(panelBounds), main: lightRegion(mainBounds) };
}

/**
 * 斜切分栏 —— 语义上就是"色块很淡的半版切分"。
 * 用淡色块而不是深色块, 是因为分栏页两侧都要承载正文, 深底那侧一旦有大段
 * 说明文字, 白字长段在投影上很难读。这里只要"两栏不是平白并排"的构成感。
 */
export function diagonalFrame(
  slide: Slide,
  opts?: { ratio?: number; side?: 'left' | 'right' },
): SplitFrame {
  const t = activeTheme();
  const spec = activeSpec();
  const ratio = opts?.ratio ?? 0.5;
  const side = opts?.side ?? 'left';
  const edge = W * ratio;

  slide.background.fill = t.paper;

  const shape = spec
    ? splitPanelShape(spec, { width: W, height: H, ratio, side })
    : { d: `M0 0 L${edge} 0 L${edge} ${H} L0 ${H} Z`, viewBox: { width: W, height: H }, skew: 0 };

  /* 边界上要一条 accent 细边 —— 淡色块自己的边界太弱, 读不出"这一版被切开了"。
   * 不能用描边: 这是个闭合的满版轮廓, 描边会连着页面上/左/下三条边一起画出来,
   * 变成一个"框"。改成**先画一块宽 3px 的同形色块, 再用本体盖住** —— 露出来的
   * 那条边严格贴合斜/凹/鼓的边界, 其余三边被页面裁掉, 天然只剩想要的那一条。 */
  const lip = spec
    ? splitPanelShape(spec, { width: W, height: H, ratio: ratio + 4 / W, side })
    : shape;

  const tint = mixHex(t.paper, t.accent, 0.1);

  paintGround(slide, [
    Shape({
      geometry: 'custom', width: W, height: H,
      fill: withAlpha(t.accent, 0.55),
      customPath: { d: lip.d, viewBox: lip.viewBox },
    }),
    Shape({
      geometry: 'custom', width: W, height: H,
      fill: tint,
      customPath: { d: shape.d, viewBox: shape.viewBox },
    }),
  ]);

  const safe = shape.skew + 24;
  const panelBounds: Frame = side === 'left'
    ? { x: PAGE.padH, y: PAGE.padTop, width: edge - shape.skew - PAGE.padH - 24, height: H - PAGE.padTop - PAGE.padBottom }
    : { x: W - edge + safe, y: PAGE.padTop, width: edge - safe - PAGE.padH, height: H - PAGE.padTop - PAGE.padBottom };
  const mainBounds: Frame = side === 'left'
    ? { x: edge + safe, y: PAGE.padTop, width: W - edge - safe - PAGE.padH, height: H - PAGE.padTop - PAGE.padBottom }
    : { x: PAGE.padH, y: PAGE.padTop, width: W - edge - safe - PAGE.padH, height: H - PAGE.padTop - PAGE.padBottom };

  /* 淡色块 —— 两侧都是浅底, 文字色一样 */
  return { panel: lightRegion(panelBounds), main: lightRegion(mainBounds) };
}

export interface BandFrame {
  /** 色带内 —— 标题区 */
  band: Region;
  /** 带下 —— 正文区 */
  main: Region;
}

/**
 * 出血色带 —— 通栏深色带压住标题, 正文在带下。
 * 这是三种骨架里最"安全"的一种: 不动内容宽度, 只把页面的重心从"整页均质"
 * 变成"上重下轻", 适合标题短、正文多的页型。
 *
 * height 默认 236: 够放 kicker + 一行 36pt 标题 + 呼吸, 又不至于吃掉正文的地方。
 */
/* 色带下边界的安全间隙 —— 标题不贴着斜边收尾 */
const BAND_SAFE_GAP = 20;

export function bleedBandFrame(
  slide: Slide,
  opts?: { height?: number; contentHeight?: number },
): BandFrame {
  const t = activeTheme();
  const spec = activeSpec();
  /* skew 与高度成正比 (见 bandShape), 探一次拿到比例, 再反解 */
  const skewRatio = spec ? bandShape(spec, { width: W, height: 1000 }).skew / 1000 : 0;
  const bh = opts?.contentHeight != null
    ? (opts.contentHeight + PAGE.padTop + BAND_SAFE_GAP) / Math.max(0.05, 1 - skewRatio)
    : (opts?.height ?? 236);

  slide.background.fill = t.paper;

  const shape = spec
    ? bandShape(spec, { width: W, height: bh })
    : { d: `M0 0 L${W} 0 L${W} ${bh} L0 ${bh} Z`, viewBox: { width: W, height: bh }, skew: 0 };

  paintGround(slide, [
    Shape({
      geometry: 'custom', width: W, height: bh,
      gradient: {
        stops: [
          { pos: 0, color: t.ink },
          { pos: 1, color: mixHex(t.ink, t.accent, 0.12) },
        ],
        angleDeg: 0,
      },
      customPath: { d: shape.d, viewBox: shape.viewBox },
    }),
  ]);

  const bandBounds: Frame = {
    x: PAGE.padH, y: PAGE.padTop,
    width: W - PAGE.padH * 2,
    /* 斜/凹的下边界最高点是 bh-skew, 标题不能越过它 */
    height: bh - shape.skew - PAGE.padTop - BAND_SAFE_GAP,
  };
  const mainBounds: Frame = {
    x: PAGE.padH, y: bh + 36,
    width: W - PAGE.padH * 2,
    height: H - bh - 36 - PAGE.padBottom,
  };

  return { band: darkRegion(bandBounds), main: lightRegion(mainBounds) };
}
