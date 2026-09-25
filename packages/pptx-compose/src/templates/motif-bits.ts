/**
 * motif-bits — 模板用的"形态零件"
 *
 * ════════════════════════════════════════════════════════════════════════
 * This module connects templates to the active motif specification. Templates
 * request semantic parts such as title marks, backdrops, and dividers; the
 * active style selects their geometry.
 *
 * 所有零件在没有 activeSpec 时都返回**空占位**而不是报错 ——
 * 单独调模板 (不走 deck 工具) 仍然要能出图。
 * ════════════════════════════════════════════════════════════════════════
 */

import { Shape, ZStack, HStack, Text } from '../compose/dsl.js';
import type { ComposeNode } from '../compose/types.js';
import { titleMark, dividerShape, backdropShape, advanceShape, stepLayerRecipe, dotPath } from '../style/motif.js';
import { activeSpec, activeTheme } from './theme.js';
import { rosettePath, guillochePath } from './ornaments.js';

/**
 * Split a value into its primary number and a smaller baseline-aligned unit.
 * 只拆**尾部**的单位; 前缀符号 (¥ $ + −) 和百分号属于数字本身, 留在数字里。
 */
export function splitValueUnit(value: string): { num: string; unit: string } {
  const s = String(value ?? '').trim();
  const m = /^([+\-−±]?\s*[¥$€£]?\s*[\d.,]+\s*%?)\s*(.*)$/.exec(s);
  if (!m || !m[2]) return { num: s, unit: '' };
  return { num: m[1]!.replace(/\s+/g, ''), unit: m[2].trim() };
}

/** 数字 + 小号单位, 单位贴数字基线。没有单位时就是一个数字文本。 */
export function valueWithUnit(value: string, opts: {
  size: number; color: string; fontLatin: string; fontEast: string;
  bold?: boolean; letterSpacingPt?: number;
}): ComposeNode {
  const { num, unit } = splitValueUnit(value);
  const numText = Text(num, {
    fontSize: opts.size, bold: opts.bold ?? true, color: opts.color,
    letterSpacingPt: opts.letterSpacingPt ?? -1, singleLine: true,
    fontLatin: opts.fontLatin, fontEast: opts.fontEast,
  });
  if (!unit) return numText;
  const unitSize = Math.max(12, Math.round(opts.size * 0.36));
  return HStack({ align: 'end', gap: Math.max(3, Math.round(opts.size * 0.08)) }, [
    numText,
    Text(unit, {
      fontSize: unitSize, color: opts.color, singleLine: true,
      fontLatin: opts.fontLatin, fontEast: opts.fontEast,
      /* 两个文本框底对齐时, 各自基线离框底约 0.33×字号(px)。补上两者之差, 单位就落在数字基线上 */
      padding: { top: 0, left: 0, right: 0, bottom: Math.round((opts.size - unitSize) * 0.33) },
    }),
  ]);
}

/** 估一个值渲染出来有几个 em 宽 (全角 1.0 / 拉丁 0.55), 单位按 0.36 倍字号折算 —— 给反解字号用 */
export function valueEmWidth(value: string): number {
  const em = (s: string) => {
    let n = 0;
    for (const ch of s) {
      const cp = ch.codePointAt(0)!;
      const wide = (cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xff01 && cp <= 0xff60) || cp === 0xffe5;
      n += wide ? 1.0 : 0.55;
    }
    return n;
  };
  const { num, unit } = splitValueUnit(value);
  return (em(num) + (unit ? 0.12 + em(unit) * 0.36 : 0)) || 1;
}

/** 条件占位: 模板里的三元分支需要一个"什么都不画"的节点 */
export function nothing(): ComposeNode {
  return Shape({ geometry: 'rect', width: 0, height: 0, fill: 'rgba(0,0,0,0)' });
}

/**
 * 标题左侧的签名记号。这是"一眼认出是同一套"的关键零件 ——
 * 每一页都带同一个形状, 全篇才有归属感。
 */
export function titleMarkShape(size = 28, color?: string): ComposeNode {
  const spec = activeSpec();
  if (!spec) return nothing();
  const m = titleMark(spec);
  return Shape({
    geometry: 'custom', width: size, height: size,
    fill: color ?? activeTheme().accent,
    customPath: { d: m.d, viewBox: m.viewBox },
  });
}

/** 标题和正文之间的分隔符 —— 换掉那根谁都会画的 48×4 直线 */
export function dividerMotif(width = 64, height = 16, color?: string): ComposeNode {
  const spec = activeSpec();
  const t = activeTheme();
  if (!spec) return Shape({ geometry: 'rect', width: 48, height: 4, fill: color ?? t.accent });
  const d = dividerShape(spec);
  return Shape({
    geometry: 'custom', width, height,
    fill: color ?? t.accent,
    customPath: { d: d.d, viewBox: d.viewBox },
  });
}

/**
 * 大面积背景分量 —— 封面 / 章节页要的就是这个。
 *
 * The backdrop adds non-semantic visual weight while following the active
 * motif, so it also reinforces the style identity.
 */
export function backdropMotif(opts?: {
  width?: number; height?: number; color?: string;
  left?: number; top?: number; alpha?: number;
  gradient?: { stops: Array<{ pos: number; color: string }>; angleDeg?: number };
}): ComposeNode {
  const spec = activeSpec();
  if (!spec) return nothing();
  const t = activeTheme();
  const b = backdropShape(spec);
  const w = opts?.width ?? 520;
  const h = opts?.height ?? 390;
  const base = opts?.color ?? t.accentDeep;
  return Shape({
    geometry: 'custom', width: w, height: h,
    fill: opts?.alpha != null ? withAlpha(base, opts.alpha) : base,
    gradient: opts?.gradient,
    customPath: { d: b.d, viewBox: b.viewBox },
    padding: { top: opts?.top ?? 0, left: opts?.left ?? 0, right: 0, bottom: 0 },
  });
}

/**
 * 给一个十六进制色加透明度, 输出 rgba() —— exporter 会转成 <a:alpha>。
 *
 * Keep alpha formatting in one helper so exported shape colors use a stable
 * rgba representation.
 */
export function withAlpha(hex: string, alpha: number): string {
  const x = hex.replace('#', '');
  const r = parseInt(x.slice(0, 2), 16), g = parseInt(x.slice(2, 4), 16), b = parseInt(x.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
}

/**
 * 深底上的"柔化白字" —— 直接合成成实色, **不走 alpha**.
 *
 * Text alpha is avoided because presentation renderers handle it inconsistently.
 * Blending with the known ink background gives deterministic text color and
 * keeps contrast checks aligned with the rendered result.
 */
export function softInk(alpha: number): string {
  const t = activeTheme();
  return mixHex(t.ink, t.onInk, alpha);
}

/** 两个十六进制色按比例混合 —— 深底上的背景分量要"比底色亮一点点", 不是"用主题亮色" */
export function mixHex(a: string, b: string, t: number): string {
  const p = (h: string) => {
    const x = h.replace('#', '');
    return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)];
  };
  const [r1, g1, b1] = p(a); const [r2, g2, b2] = p(b);
  /* Clamp each channel so callers cannot produce invalid hexadecimal colors. */
  const m = (u: number, v: number) => Math.max(0, Math.min(255, Math.round(u + (v - u) * t)))
    .toString(16).padStart(2, '0');
  return `#${m(r1, r2)}${m(g1, g2)}${m(b1, b2)}`;
}

/**
 * 把 accent 调到在指定底色上读得出来。
 *
 * Adjust an accent toward the appropriate light or dark endpoint until it
 * meets the small-text contrast requirement without assuming a fixed theme.
 */
/**
 * bestTextOn — 给定底色, 返回该用浅字还是深字.
 *
 * 图示组件里同一个形状在四套风格下底色可能从 accentDeep 一路变到 accentSoft,
 * 文字颜色不能写死。刻意复用本文件里的 lum/contrast, 而不是在 diagram-bits
 * 里再写一份亮度公式 —— 同一语义两份实现是这套引擎今晚踩了多次的坑。
 */
/**
 * lighten / darken —— 往这套主题的"亮"和"暗"两端拉。
 *
 * Highlights and shadows use the theme's on-ink and ink colors instead of
 * absolute white or black, keeping depth effects within the deck's palette.
 */
/**
 * hueRotatePalette —— 从主题 accent 出发, 按**色相**轮转出 n 个同族色。
 *
 * Generate decorative colors by keeping lightness and saturation stable while
 * rotating hue across a bounded span. This gives each segment equal visual
 * weight and avoids repeating the first hue at the end of a full rotation.
 */
export function hueRotatePalette(n: number, span = 200): string[] {
  const base = rgbToHsl(activeTheme().accent);
  /* Lower saturation to keep a multi-hue set cohesive. Bound lightness so one
   * shared light text color remains readable on every segment. */
  const sat = Math.min(0.62, base.s * 0.78);
  const start = Math.max(0.44, Math.min(0.52, base.l));

  const build = (l: number) => Array.from({ length: n }, (_, i) =>
    hslToRgb((base.h + (n === 1 ? 0 : (i / n) * span)) % 360, sat, l));

  /* Use lightness as the remaining degree of freedom and darken the complete
   * palette until the shared on-ink text meets the large-text threshold. */
  for (let l = start; l >= 0.30; l -= 0.03) {
    const p = build(l);
    if (Math.min(...p.map((c) => contrast(activeTheme().onInk, c))) >= 3.0) return p;
  }
  return build(0.30);
}

function rgbToHsl(hex: string): { h: number; s: number; l: number } {
  const x = hex.replace('#', '');
  const r = parseInt(x.slice(0, 2), 16) / 255;
  const g = parseInt(x.slice(2, 4), 16) / 255;
  const b = parseInt(x.slice(4, 6), 16) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h: number;
  if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (mx === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return { h, s, l };
}

function hslToRgb(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const xx = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] = hp < 1 ? [c, xx, 0] : hp < 2 ? [xx, c, 0] : hp < 3 ? [0, c, xx]
    : hp < 4 ? [0, xx, c] : hp < 5 ? [xx, 0, c] : [c, 0, xx];
  const m = l - c / 2;
  const to = (v: number) => Math.round(Math.max(0, Math.min(1, v + m)) * 255)
    .toString(16).padStart(2, '0');
  return `#${to(r1)}${to(g1)}${to(b1)}`;
}

export function lighten(color: string, k: number): string {
  return mixHex(color, activeTheme().onInk, k);
}

export function darken(color: string, k: number): string {
  return mixHex(color, activeTheme().ink, k);
}

export function bestTextOn(ground: string): string {
  const t = activeTheme();
  return contrast(t.onInk, ground) >= contrast(t.ink, ground) ? t.onInk : t.ink;
}

/**
 * uniformTextOn —— 给**一整组**底色定一个统一的文字色。
 *
 * A related group shares one text color so labels do not switch between light
 * and dark treatment from item to item. Prefer one light or dark color that
 * meets the threshold across every background, then fall back to per-item
 * selection when neither shared color qualifies. The default threshold of 3.0
 * matches large bold text; small labels use the 4.5 threshold in
 * readableAccent.
 */
export function uniformTextOn(grounds: string[], minContrast = 3.0): string {
  const t = activeTheme();
  if (grounds.length === 0) return t.ink;
  const worst = (fg: string) => Math.min(...grounds.map((g) => contrast(fg, g)));
  const light = worst(t.onInk), dark = worst(t.ink);
  if (light >= minContrast && light >= dark) return t.onInk;
  if (dark >= minContrast) return t.ink;
  return light >= dark ? t.onInk : t.ink;
}

export function readableAccent(ground: string, accent?: string): string {
  const t = activeTheme();
  const base = accent ?? t.accent;
  const target = lum(ground) < 0.5 ? '#ffffff' : '#000000';
  /* Small labels use the WCAG AA contrast threshold of 4.5. */
  for (let k = 0; k <= 0.6; k += 0.06) {
    const c = mixHex(base, target, k);
    if (contrast(c, ground) >= 4.5) return c;
  }
  return mixHex(base, target, 0.6);
}

function lum(hex: string): number {
  const x = hex.replace('#', '');
  const ch = [0, 2, 4].map((i) => {
    const v = parseInt(x.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function contrast(a: string, b: string): number {
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * 封面 / 章节页的背景层。
 *
 * Use oversized, cropped shapes whose colors stay close to the ground so the
 * background adds weight without competing with content.
 */
export function heroBackdropLayers(opts?: {
  slideW?: number; slideH?: number; tone?: 'onDark' | 'onLight';
}): ComposeNode {
  const spec = activeSpec();
  if (!spec) return nothing();
  const t = activeTheme();
  const W = opts?.slideW ?? 1280;
  const H = opts?.slideH ?? 720;
  const onDark = opts?.tone !== 'onLight';
  const ground = onDark ? t.ink : t.paper;

  /* 线条色: border 走 <a:srgbClr>, 吃不了 rgba —— 所以"半透明线"必须自己跟底色
   * 预混出实色。好处是结果可预测, 不依赖 Office 的 alpha 合成。 */
  const hair = (k: number) => mixHex(ground, onDark ? t.onInk : t.ink, k);
  const lineAccent = mixHex(ground, t.accent, 0.5);
  const b = backdropShape(spec);

  /* 版心边距 —— 尺规和角标都贴着它走, 这样线条系统和内容是**同一套网格**,
   * 而不是随手撒在版面上的装饰 (上一版那个孤零零的圆角方块就是后者)。 */
  const M = 72;
  const tickTop = 96;
  const tickGap = 116;

  /* Line styles use a field of rules instead of enlarging a single motif. */
  /* ── 纹样风格 (, finance-navy) ─────────────────────────
   * 背景分量改画 guilloche: 银行版式的分量来自**精细**, 不来自大色块 ——
   * 放大 motif 形状那套在这里会像消费品海报。纹样全部是细线描边, 不改变任何区域的明度,
   * 标题白字的对比度不受影响。 */
  if (spec.ornament === 'guilloche') {
    const gold = onDark ? mixHex(t.accent, t.onInk, 0.35) : t.accent;
    const ink = (k: number) => mixHex(ground, gold, k);
    const RS = Math.round(H * 1.3);
    const BW = W - M * 2;
    return ZStack({ align: 'start', width: W, height: H }, [
      Shape({
        geometry: 'rect', width: W, height: H,
        gradient: {
          stops: [
            { pos: 0, color: mixHex(ground, '#000000', onDark ? 0.18 : 0) },
            { pos: 0.6, color: ground },
            { pos: 1, color: mixHex(ground, gold, onDark ? 0.10 : 0.06) },
          ],
          angleDeg: 45,
        },
      }),
      /* 纹章从右侧出血, 只露出六成 —— 读成"票面的一角", 而不是摆在那里的一个圆形图案 */
      Shape({
        geometry: 'custom', width: RS, height: RS, bleed: true,
        customPath: { ...rosettePath(RS), strokeOnly: true },
        border: { color: ink(onDark ? 0.34 : 0.40), width: 0.75 },
        padding: { top: Math.round((H - RS) / 2), left: Math.round(W - RS * 0.60), right: 0, bottom: 0 },
      }),
      /* 版心上沿一条细线纹带 + 上下两条金线收边 —— 票据的边饰, 同时声明版心宽度 */
      Shape({ geometry: 'rect', width: BW, height: 1, fill: ink(0.55), padding: { top: 36, left: M, right: 0, bottom: 0 } }),
      Shape({
        geometry: 'custom', width: BW, height: 44, bleed: true,
        customPath: { ...guillochePath(BW, 44, { strands: 7, waves: 11 }), strokeOnly: true },
        border: { color: ink(onDark ? 0.30 : 0.34), width: 0.6 },
        padding: { top: 40, left: M, right: 0, bottom: 0 },
      }),
      Shape({ geometry: 'rect', width: BW, height: 1, fill: ink(0.55), padding: { top: 88, left: M, right: 0, bottom: 0 } }),
    ]);
  }

  if (spec.motif === 'line') {
    /* Lift the rule color toward onInk before blending so the line field stays
     * visible on dark themes. */
    const rule = mixHex(t.accent, t.onInk, 0.35);
    const rules = Array.from({ length: 13 }, (_, i) => {
      const x = W * 0.44 + i * 46;
      /* 越靠右越密越亮 —— 线场要有梯度才是构成, 均匀排列只是网格纸 */
      const k = 0.22 + (i / 12) * 0.40;
      return Shape({
        geometry: 'rect', width: i % 4 === 3 ? 2 : 1, height: H,
        fill: mixHex(ground, rule, k),
        padding: { top: 0, left: Math.round(x), right: 0, bottom: 0 },
      });
    });
    return ZStack({ align: 'start', width: W, height: H }, [
      Shape({
        geometry: 'rect', width: W, height: H,
        gradient: {
          stops: [
            { pos: 0, color: mixHex(ground, '#000000', onDark ? 0.14 : 0) },
            { pos: 0.52, color: ground },
            { pos: 1, color: mixHex(ground, t.accent, onDark ? 0.18 : 0.10) },
          ],
          angleDeg: 45,
        },
      }),
      ...rules,
      /* 一条横贯的重线压住线场 —— 竖线场自己会飘, 需要一条水平的东西钉住它 */
      Shape({
        geometry: 'rect', width: W - W * 0.44, height: 3,
        fill: mixHex(ground, rule, 0.78),
        padding: { top: Math.round(H * 0.30), left: Math.round(W * 0.44), right: 0, bottom: 0 },
      }),
      Shape({
        geometry: 'rect', width: 28, height: 1, fill: hair(0.34),
        padding: { top: M, left: M, right: 0, bottom: 0 },
      }),
      Shape({
        geometry: 'rect', width: 1, height: 28, fill: hair(0.34),
        padding: { top: M, left: M, right: 0, bottom: 0 },
      }),
    ]);
  }

  return ZStack({ align: 'start', width: W, height: H }, [
    /* ── 1. 底: 三档渐变 ────────────────────────────────────────
     * 两档只能做出"不平", 三档才有"纵深": 左下压暗一档当锚点, 中段回到底色,
     * 右上朝 accent 抬一档。白字全部落在左下那一档上, 对比度只增不减 ——
     * 这是能放心把幅度从 0.12 加到 0.20 的前提。 */
    Shape({
      geometry: 'rect', width: W, height: H,
      gradient: {
        stops: [
          { pos: 0, color: mixHex(ground, '#000000', onDark ? 0.14 : 0) },
          { pos: 0.52, color: ground },
          { pos: 1, color: mixHex(ground, t.accent, onDark ? 0.20 : 0.12) },
        ],
        angleDeg: 45,
      },
    }),

    /* ── 2. 两层半透明实体分量 (承重) ─────────────────────────
     * 用 alpha 而不是调暗色值, 叠在一起自然加深, 交叠处自己长出第三个层次。 */
    /* 【 明康在 PPT 编辑态里圈出来】这两层原来是 top:-25%H · 高 1.5H,
     * 也就是**向上探出画布 180px** (版面高的四分之一)。放映时看不见, 但用户
     * 一在 PowerPoint 里打开就看到一堆悬在画布外的形状 —— 我们交付的是**可编辑**
     * 的 pptx, 画布外的东西同样是交付物的一部分。
     *
     * 出血的目的只是"被页边裁掉", 探出 8% 就足够达到那个效果; 探出 25% 除了
     * 让编辑态难看, 不产生任何额外观感。所以压到 8%, 同时把高度按比例收回来,
     * 让画布内的可见部分基本不变。 */
    backdropMotif({
      width: W * 0.86, height: H * 1.18, color: t.accent, alpha: onDark ? 0.12 : 0.16,
      left: W * 0.40, top: -H * 0.08,
    }),
    backdropMotif({
      width: W * 0.60, height: H * 1.06, color: t.accent, alpha: onDark ? 0.17 : 0.22,
      left: W * 0.72, top: -H * 0.04,
    }),

    /* ── 3. 描边轮廓 (线稿) ──────────────────────────────────
     * 【这是"太简单"的正解】实体块再多也只是色块, 加一层**只描边不填充**的同款
     * 轮廓, 版面立刻从"涂了两块颜色"变成"画过"。而且线稿不吃对比度: 它不改变
     * 任何区域的明度, 白字该多清楚还多清楚 —— 上一轮怕洗掉深色锚点而把一切
     * 都压到 alpha 0.10, 压错了对象, 该省的是**面**, 不是**线**。
     * 故意和实体块错开 (更靠左、更小), 让线稿从色块里"漏出来"一条边。 */
    Shape({
      geometry: 'custom', width: W * 0.54, height: H * 1.02,
      customPath: { d: b.d, viewBox: b.viewBox, strokeOnly: true },
      border: { color: lineAccent, width: 2 },
      padding: { top: Math.round(-H * 0.04), left: Math.round(W * 0.28), right: 0, bottom: 0 },
    }),
    Shape({
      geometry: 'custom', width: W * 0.30, height: H * 0.58,
      customPath: { d: b.d, viewBox: b.viewBox, strokeOnly: true },
      border: { color: hair(0.26), width: 1 },
      padding: { top: Math.round(H * 0.10), left: Math.round(W * 0.62), right: 0, bottom: 0 },
    }),

    /* ── 4. 右侧尺规 ────────────────────────────────────────
     * 一条贴右版心的细竖线 + 五个刻度。作用不是好看, 是**声明版心**:
     * 观众看不出为什么, 但会觉得这一版是量过的。刻度间距 116 = 版心高 /5,
     * 和内容用同一套网格。 */
    Shape({
      geometry: 'rect', width: 1, height: H - M * 2,
      fill: hair(0.22),
      padding: { top: M, left: W - M, right: 0, bottom: 0 },
    }),
    ...[0, 1, 2, 3, 4].map((i) =>
      Shape({
        geometry: 'rect', width: i === 2 ? 22 : 12, height: 1,
        fill: hair(i === 2 ? 0.42 : 0.24),
        padding: { top: tickTop + i * tickGap, left: W - M - (i === 2 ? 22 : 12), right: 0, bottom: 0 },
      }),
    ),

    /* ── 5. 左上角角标 ──────────────────────────────────────
     * 两条 28px 的线拼一个 L, 卡在版心左上角。印刷上的定位标记语言 ——
     * 廉价、精确, 而且它和右侧尺规、底部标题组共用同一条 72px 边距,
     * 三者一起才算一个"系统"; 单独放一个只会是噪点。 */
    Shape({
      geometry: 'rect', width: 28, height: 1, fill: hair(0.34),
      padding: { top: M, left: M, right: 0, bottom: 0 },
    }),
    Shape({
      geometry: 'rect', width: 1, height: 28, fill: hair(0.34),
      padding: { top: M, left: M, right: 0, bottom: 0 },
    }),
  ]);
}

/**
 * 流程/步骤里的推进形状 —— 时间轴、流程页用它替掉光秃秃的圆点。
 * keepAspect: 圆点这类形状必须锁宽高比, 塞进宽扁槽位会拉成椭圆
 * (明康两次点过这个问题)。
 */
export function advanceMotif(width = 44, height = 22, color?: string): ComposeNode {
  const spec = activeSpec();
  const t = activeTheme();
  if (!spec) return Shape({ geometry: 'ellipse', width: 14, height: 14, fill: color ?? t.accent });
  const a = advanceShape(spec);
  return Shape({
    geometry: 'custom', width, height,
    fill: color ?? t.accent,
    customPath: { d: a.d, viewBox: a.viewBox },
  });
}

/**
 * 步骤节点 —— 三层配方真正落地的地方。
 *
 * The node combines the recipe's three layers, each with a distinct role:
 *   backdrop —— 大 · 淡 · 错位, 负责"体积"。没有它, 节点就是个扁平图标。
 *   body —— 实色, 负责"这是个可点的东西"。
 *   badge —— 白圆 + 序号, 负责"第几步"。序号写在图形里, 不再另起一行文字。
 */
export function stepNodeMotif(opts?: {
  index?: number; width?: number; height?: number; onDark?: boolean;
}): ComposeNode {
  const spec = activeSpec();
  const t = activeTheme();
  const W = opts?.width ?? 96;
  const H = opts?.height ?? 64;
  if (!spec) {
    return Shape({ geometry: 'ellipse', width: 18, height: 18, fill: t.accent });
  }
  const r = stepLayerRecipe(spec);

  const softColor = r.backdrop.colorRole === 'accentSoft'
    ? withAlpha(t.accent, opts?.onDark ? 0.30 : 0.22)
    : withAlpha(t.ink, 0.12);
  const bodyColor = r.body.colorRole === 'ink' ? t.ink : t.accent;

  const bw = W * r.backdrop.scale;
  const bh = H * r.backdrop.scale;
  /* offsetX/offsetY 是配方给的**错位比例**, 正是"精致"的来源 —— 两层完全对齐
   * 就是一个图形加了描边, 错开才有纵深。 */
  const offX = (W - bw) / 2 + r.backdrop.offsetX * W * 0.5;
  const offY = (H - bh) / 2 + r.backdrop.offsetY * H * 0.5;

  /* body 的宽高: keepAspect 的形状 (line 风格的圆点) 按高定宽, 否则会拉成椭圆 */
  const bodyH = H * 0.52;
  const bodyW = r.body.keepAspect ? bodyH : W * 0.72;

  const layers: ComposeNode[] = [
    Shape({
      geometry: 'custom', width: Math.round(bw), height: Math.round(bh),
      fill: softColor,
      customPath: { d: r.backdrop.path.d, viewBox: r.backdrop.path.viewBox },
      padding: { top: Math.round(offY), left: Math.round(offX), right: 0, bottom: 0 },
    }),
    Shape({
      geometry: 'custom', width: Math.round(bodyW), height: Math.round(bodyH),
      fill: bodyColor,
      customPath: { d: r.body.path.d, viewBox: r.body.path.viewBox },
      padding: {
        top: Math.round((H - bodyH) / 2),
        left: Math.round((W - bodyW) / 2),
        right: 0, bottom: 0,
      },
    }),
  ];

  if (r.badge && opts?.index != null) {
    const d = Math.round(bodyH * 0.72);
    /* 用 custom + dotPath 而不是 prst ellipse: 带 padding 偏移的 prst 形状在
     * ZStack 里被丢掉了 —— 导出的 slide XML 里 ellipse 数为 0, 序号白圆整个消失,
     * 只剩数字浮在实体色块上。custGeom 这条路径同一页里已经画了 8 个, 是通的。 */
    layers.push(Shape({
      geometry: 'custom', width: d, height: d, fill: t.paper,
      customPath: { d: dotPath().d, viewBox: dotPath().viewBox },
      padding: { top: Math.round((H - d) / 2), left: Math.round((W - d) / 2), right: 0, bottom: 0 },
    }));
    layers.push(Text(String(opts.index), {
      fontSize: Math.max(12, Math.round(d * 0.42)), bold: true, color: bodyColor,
      textAlign: 'ctr', singleLine: true,
      fontLatin: t.fonts.numeric, fontEast: t.fonts.textEast,
      width: d,
      padding: { top: Math.round((H - d) / 2 + d * 0.22), left: Math.round((W - d) / 2), right: 0, bottom: 0 },
    }));
  }

  return ZStack({ align: 'start', width: W, height: H }, layers);
}

/**
 * 大字页 (manifesto / quote) 的字号 —— 按字数定, 不是写死。
 *
 * The display size scales with text length so long statements fit the same
 * composition without forcing the rest of the slide to shrink.
 */
/**
 * 按容器宽度反解标题字号 —— 让标题最多占 maxLines 行。
 *
 * Estimate the available em width from the box width and cap the size so the
 * measured text occupies at most maxLines. The result is bounded by min and
 * max to keep titles legible in both narrow and wide containers.
 */
export function titleSizeForBox(
  text: string, boxWidth: number, opts?: { max?: number; min?: number; maxLines?: number },
): number {
  const max = opts?.max ?? 36;
  const min = opts?.min ?? 20;
  const maxLines = opts?.maxLines ?? 5;
  let em = 0;
  for (const ch of String(text ?? '')) {
    const cp = ch.codePointAt(0)!;
    const wide = (cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xff01 && cp <= 0xff60);
    em += wide ? 1.0 : 0.55;
  }
  if (em <= 0 || boxWidth <= 0) return max;
  const fit = Math.floor((maxLines * boxWidth) / (em * (96 / 72)));
  return Math.max(min, Math.min(max, fit));
}

export function displaySizeForLength(text: string, max = 80): number {
  const n = String(text ?? '').replace(/\s/g, '').length;
  if (n <= 14) return max;
  if (n <= 24) return Math.round(max * 0.72);
  if (n <= 40) return Math.round(max * 0.54);
  if (n <= 60) return Math.round(max * 0.42);
  if (n <= 90) return Math.round(max * 0.34);
  return Math.round(max * 0.28);
}

/**
 * 多系列图表的配色 —— 从主题的 accent 推出一条明度阶梯。
 *
 * 【为什么不能随便挑几个颜色】风格系统的全部意义是"一份 deck 看着是一套"。
 * 多系列如果上一组无关的调色板 (蓝橙绿红那种), 图表页会瞬间脱离风格,
 * 而且和 minimal-line 的深红、editorial-capsule 的赤陶橙直接打架。
 *
 * 做法: 以 accent 为基色, 朝 ink (更深) 和 paper (更浅) 两个方向铺开,
 * 顺序刻意交错 (基色 → 深 → 浅 → 更深 → 更浅), 让**相邻系列**的明度差最大 ——
 * 图例里相邻、柱子上也相邻, 分不开就等于没分。
 *
 * 两条硬指标 (都在 __seriesPaletteAudit 里实算, 不靠眼睛):
 *   · 每个系列色和纸底的对比度 ≥ 1.6 —— 否则浅色系列在浅底上直接消失
 *   · 相邻两个系列色之间的对比度 ≥ 2.0 —— 否则挨着的两根柱子看着是一根,
 *     两条折线叠在一起更是直接分不出 (从 1.35 提上来)
 */
/** 相邻两个系列色的对比度下限 —— 低于它, 两条折线叠在一起就分不出 */
const SERIES_MIN_ADJ = 2.0;
/** 系列色对纸底的对比度下限 —— 低于它, 浅色系列在浅底上直接消失 */
const SERIES_MIN_PAPER = 1.6;

export function seriesPalette(count: number): string[] {
  const t = activeTheme();
  const toward = (k: number) => (k < 0 ? mixHex(t.accent, t.ink, -k) : mixHex(t.accent, t.paper, k));
  /* 交错顺序: 0 基色, 负=压深, 正=提浅 */
  const ORDER = [0, -0.58, 0.3, -0.82, 0.46, -0.34, 0.16];
  const out: string[] = [t.accent];
  for (let i = 1; i < Math.max(1, count); i++) {
    const preferred = toward(ORDER[i % ORDER.length]!);
    const prev = out[i - 1]!;
    /* 默认系数够用就照用 —— 这样已经达标的三套主题一个字节都不变 */
    if (contrast(preferred, prev) >= SERIES_MIN_ADJ && contrast(preferred, t.paper) >= SERIES_MIN_PAPER) {
      out.push(preferred);
      continue;
    }
    /* Search both directions when the preferred shade misses a threshold.
     * Choose the candidate that remains most distinct from every color already
     * in the palette, so non-adjacent series do not collapse together. */
    let best = preferred;
    let bestScore = -1;
    for (let k = -0.95; k <= 0.9001; k += 0.025) {
      const c = toward(k);
      if (contrast(c, t.paper) < SERIES_MIN_PAPER) continue;
      if (contrast(c, prev) < SERIES_MIN_ADJ) continue;
      const far = Math.min(...out.map((o) => contrast(c, o)));
      if (far > bestScore) { bestScore = far; best = c; }
    }
    if (bestScore < 0) {
      /* 一个都不达标 (极窄的色域): 退而求其次, 取相邻对比最大的 */
      for (let k = -0.95; k <= 0.9001; k += 0.025) {
        const c = toward(k);
        if (contrast(c, t.paper) < SERIES_MIN_PAPER) continue;
        const v = contrast(c, prev);
        if (v > bestScore) { bestScore = v; best = c; }
      }
    }
    out.push(best);
  }
  return out.slice(0, Math.max(1, count));
}

/** Return the palette and its paper and adjacent contrast metrics for audits. */
export function __seriesPaletteAudit(count: number): {
  colors: string[]; vsPaper: number[]; adjacent: number[];
} {
  const t = activeTheme();
  const colors = seriesPalette(count);
  return {
    colors,
    vsPaper: colors.map((c) => Number(contrast(c, t.paper).toFixed(2))),
    adjacent: colors.slice(1).map((c, i) => Number(contrast(c, colors[i]!).toFixed(2))),
  };
}

/**
 * 页脚 + 页码 —— 画在版心下边距里的一条"页眉页脚带"。
 *
 * Draw footer and page number once per slide after the template has painted its
 * background; keeping this as a slide-level operation avoids duplicate chrome.
 */
/**
 * 采样 slide 上 (x, y) 处最上面那个形状的底色。
 * 按 paint 顺序倒着找第一个覆盖该点、且有实心/渐变填充的形状 —— 那就是文字会压在上面的底。
 * 找不到 (整页只有背景色) 就退到 slide.background, 再退到主题的 paper。
 */
function groundAt(slide: unknown, x: number, y: number): string {
  const t = activeTheme();
  const E = 914400 / 96;
  const model = (slide as { _model?: { shapes?: unknown[]; background?: { fill?: string } } })._model;
  const shapes = (model?.shapes ?? []) as Array<{
    kind?: string; frame?: { x: number; y: number; w: number; h: number };
    fill?: { kind?: string; color?: string; stops?: Array<{ color: string }> };
  }>;
  let ground = model?.background?.fill ?? t.paper;
  for (const sh of shapes) {
    const f = sh.frame;
    if (!f || sh.kind === 'text') continue;
    if (x * E < f.x || x * E > f.x + f.w || y * E < f.y || y * E > f.y + f.h) continue;
    if (sh.fill?.kind === 'solid' && sh.fill.color) ground = sh.fill.color;
    else if (sh.fill?.kind === 'grad' && sh.fill.stops?.length) {
      ground = sh.fill.stops[Math.floor(sh.fill.stops.length / 2)]!.color;
    } else continue;
  }
  const hex = String(ground).replace('#', '');
  return /^[0-9A-Fa-f]{6}$/.test(hex) ? `#${hex}` : t.paper;
}

export function slideChrome(
  slide: unknown,
  opts: { footerText?: string; pageNumber?: number; onDark?: boolean /* 仅指左下角(页脚)所在的底 */ },
): void {
  const t = activeTheme();
  const hasFooter = Boolean(opts.footerText && String(opts.footerText).trim());
  const hasPage = typeof opts.pageNumber === 'number' && opts.pageNumber > 0;
  if (!hasFooter && !hasPage) return;
  /* Sample the footer background when no explicit override is supplied. The
   * page number stays muted because its right-side anchor uses the paper area. */
  /* 采样出**底色本身**再定色, 而不是只判"深不深":
   * 第一版判了深浅, 30 页长 deck 里仍有一页 4.13 —— twoColumn 的**浅色调面板**
   * 既不是深底也不是纸底, muted 压上去刚好差一点。二值判断覆盖不了这种。
   * 现在两边各自采样, 交给 readableAccent 保证 ≥4.5 (它本来就是干这个的)。
   * onDark 保留为显式覆盖 —— deck 工具那条路仍然传它。 */
  const footerGround = opts.onDark != null
    ? (opts.onDark ? t.ink : t.paper)
    : groundAt(slide, 96, 720 - 32);
  const footerColor = readableAccent(footerGround, t.muted);
  /* Keep the page number on the stable paper-side muted color; angled panel
   * bounds are not reliable sampling regions. */
  const pageColor = t.muted;
  const s = slide as { shapes: { addText: (text: string, pos: unknown, style?: unknown) => unknown } };
  const Y = 720 - 44;
  if (hasFooter) {
    s.shapes.addText(String(opts.footerText), { left: 72, top: Y, width: 700, height: 24 }, {
      fontSize: 11, color: footerColor, letterSpacingPt: 0.4,
      fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
    });
  }
  if (hasPage) {
    const h = s.shapes.addText(String(opts.pageNumber), { left: 1280 - 72 - 60, top: Y, width: 60, height: 24 }, {
      fontSize: 11, color: pageColor,
      fontLatin: t.fonts.numeric, fontEast: t.fonts.textEast,
    }) as { _shape?: { paragraphs?: Array<{ align?: string }> } };
    /* 页码右对齐到版心右边界 —— 左对齐的话页数从个位变两位时会跳 */
    for (const p of h?._shape?.paragraphs ?? []) p.align = 'r';
  }
}
