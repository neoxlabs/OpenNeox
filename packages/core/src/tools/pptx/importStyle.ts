
import JSZip from 'jszip';
import {
  DEFAULT_STYLE_SPEC,
  hasFontMetrics,
  type GridSpec,
  type Motif,
  type NeoxComposeTheme,
  type RadiusScale,
  type StyleSpec,
  type TypeScale,
} from '@neoxlabs/pptx-compose';

const EMU_PER_PX = 9525;
const MOTIFS: Motif[] = ['chevron', 'ribbon', 'capsule', 'line', 'none'];
const STYLE_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

export interface ImportStyleOptions {
  /** 显式指定 styleId; 不给则按配色/字体指纹生成稳定的 imported-xxx */
  styleId?: string;
  /** 给用户看的名字 */
  displayName?: string;
  /** 一句话说明适合什么场景 */
  suitedFor?: string;
  /** 来源文件名 (只用于默认名字和报告) */
  sourceName?: string;
}

export interface FontSubstitution {
  role: keyof NeoxComposeTheme['fonts'];
  from: string;
  to: string;
}

export interface ImportStyleReport {
  source: {
    slideCount: number;
    slideWidthPx: number;
    slideHeightPx: number;
    themeName?: string;
  };
  /** 主色的实际来源 —— theme 还是 slide 里出现最多的彩色填充 */
  colorSource: 'theme' | 'slides';
  colors: { paper: string; ink: string; accent: string; accentDeep: string; muted: string };
  fonts: {
    displayLatin: string;
    displayEast: string;
    textLatin: string;
    textEast: string;
    numeric: string;
    substitutions: FontSubstitution[];
  };
  motif: { value: Motif; evidence: string };
  radius: { value: RadiusScale; evidence: string };
  type: { value: TypeScale; evidence: string };
  grid: GridSpec;
  /** 给模型/用户看的推断说明与缺口, 一行一条 */
  notes: string[];
}

/* ============================================================
 * 颜色工具
 * ============================================================ */

function normHex(v: string | undefined | null): string | null {
  if (!v) return null;
  const m = /^#?([0-9a-fA-F]{6})$/.exec(v.trim());
  return m ? `#${m[1]!.toUpperCase()}` : null;
}

function rgbOf(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function hexOf(rgb: [number, number, number]): string {
  return `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/** t=0 → a, t=1 → b */
function mix(a: string, b: string, t: number): string {
  const x = rgbOf(a);
  const y = rgbOf(b);
  return hexOf([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

function relLum(hex: string): number {
  const c = rgbOf(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}

function contrast(a: string, b: string): number {
  const la = relLum(a);
  const lb = relLum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** 对比度不够就朝黑/白方向压, 直到达标。返回的是实色, 不用透明度。 */
function ensureContrast(fg: string, bg: string, min: number): string {
  if (contrast(fg, bg) >= min) return fg;
  const target = relLum(bg) > 0.35 ? '#000000' : '#FFFFFF';
  for (let i = 1; i <= 20; i++) {
    const c = mix(fg, target, i / 20);
    if (contrast(c, bg) >= min) return c;
  }
  return target;
}

/** 彩度够高才算"品牌色" —— 白/灰/近黑不算 */
function isColorful(hex: string): boolean {
  const [r, g, b] = rgbOf(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max - min >= 24 && max >= 48 && min <= 236;
}

function mostCommon(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | undefined;
  let bestN = 0;
  for (const [v, n] of counts) {
    if (n > bestN) { best = v; bestN = n; }
  }
  return best;
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * 出现最多的字号; 票数相同时取更小的那个 —— 正文区间里, 大字号往往是
 * 副标题/强调句 (出现一两次), 真正铺满页面的是小一点的那档。
 */
function mostCommonBodySize(values: number[]): number | undefined {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: number | undefined;
  let bestN = 0;
  for (const [v, n] of counts) {
    if (n > bestN || (n === bestN && best !== undefined && v < best)) { best = v; bestN = n; }
  }
  return best;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/* ============================================================
 * XML 解析 (只取需要的格子; pptx 是固定 schema, 不用通用 XML 解析器)
 * ============================================================ */

interface ParsedTheme {
  name?: string;
  colors: Record<string, string>;
  majorLatin?: string;
  majorEast?: string;
  minorLatin?: string;
  minorEast?: string;
}

const SCHEME_SLOTS = [
  'dk1', 'lt1', 'dk2', 'lt2',
  'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6',
  'hlink', 'folHlink',
];

function parseThemeXml(xml: string): ParsedTheme {
  const name = /<a:theme\b[^>]*\bname="([^"]*)"/.exec(xml)?.[1];
  const colors: Record<string, string> = {};
  for (const slot of SCHEME_SLOTS) {
    /* srgbClr val=... / sysClr ... lastClr=... 两种写法 */
    const m = new RegExp(`<a:${slot}>\\s*<a:(?:srgbClr val|sysClr[^>]*lastClr)="([0-9A-Fa-f]{6})"`).exec(xml);
    const hex = normHex(m?.[1]);
    if (hex) colors[slot] = hex;
  }
  const fontBlock = (tag: 'majorFont' | 'minorFont'): string => {
    const m = new RegExp(`<a:${tag}>([\\s\\S]*?)</a:${tag}>`).exec(xml);
    return m?.[1] ?? '';
  };
  const typeface = (block: string, tag: 'latin' | 'ea'): string | undefined => {
    const m = new RegExp(`<a:${tag}\\b[^>]*typeface="([^"]*)"`).exec(block);
    const v = m?.[1]?.trim();
    return v && !v.startsWith('+') ? v : undefined;
  };
  const major = fontBlock('majorFont');
  const minor = fontBlock('minorFont');
  return {
    name,
    colors,
    majorLatin: typeface(major, 'latin'),
    majorEast: typeface(major, 'ea'),
    minorLatin: typeface(minor, 'latin'),
    minorEast: typeface(minor, 'ea'),
  };
}

/** schemeClr → 实际颜色 (tx1/bg1 这种别名也认) */
function resolveSchemeColor(val: string, theme: ParsedTheme): string | null {
  const alias: Record<string, string> = {
    tx1: 'dk1', bg1: 'lt1', tx2: 'dk2', bg2: 'lt2',
  };
  const slot = alias[val] ?? val;
  return theme.colors[slot] ?? null;
}

interface SlideFacts {
  fontSizesPt: number[];
  boldSizesPt: number[];
  fills: string[];
  backgrounds: string[];
  presetCounts: Record<string, number>;
  /** roundRect 的实际圆角半径 (px) */
  roundRadiiPx: number[];
  thinLineCount: number;
  /** 带文字形状的包围盒 (px) */
  textRects: Array<{ left: number; top: number; right: number; bottom: number }>;
  transition?: string;
}

function scanSlideXml(xml: string, theme: ParsedTheme): SlideFacts {
  const facts: SlideFacts = {
    fontSizesPt: [], boldSizesPt: [], fills: [], backgrounds: [],
    presetCounts: {}, roundRadiiPx: [], thinLineCount: 0, textRects: [],
  };

  /* 字号 / 粗体 */
  for (const m of xml.matchAll(/<a:(?:rPr|defRPr|endParaRPr)\b([^>]*)>/g)) {
    const attrs = m[1] ?? '';
    const sz = /\bsz="(\d+)"/.exec(attrs)?.[1];
    if (sz) {
      const pt = Number(sz) / 100;
      if (pt >= 6 && pt <= 120) {
        facts.fontSizesPt.push(pt);
        if (/\bb="1"/.test(attrs)) facts.boldSizesPt.push(pt);
      }
    }
  }

  /* 背景 */
  for (const m of xml.matchAll(/<p:bg>([\s\S]*?)<\/p:bg>/g)) {
    const block = m[1] ?? '';
    const srgb = /<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(block)?.[1];
    const scheme = /<a:schemeClr val="([^"]+)"/.exec(block)?.[1];
    const hex = normHex(srgb) ?? (scheme ? resolveSchemeColor(scheme, theme) : null);
    if (hex) facts.backgrounds.push(hex);
  }

  /* 形状: 填充 / 圆角 / 文字框 */
  for (const m of xml.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)) {
    const block = m[1] ?? '';
    const spPr = /<p:spPr>([\s\S]*?)<\/p:spPr>/.exec(block)?.[1] ?? '';
    /* 边框颜色不是"形状填充", 先摘掉 <a:ln> */
    const fillBlock = spPr.replace(/<a:ln\b[\s\S]*?<\/a:ln>/g, '');
    const fillSrgb = /<a:solidFill>\s*<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(fillBlock)?.[1];
    const fillScheme = /<a:solidFill>\s*<a:schemeClr val="([^"]+)"/.exec(fillBlock)?.[1];
    const fill = normHex(fillSrgb) ?? (fillScheme ? resolveSchemeColor(fillScheme, theme) : null);
    if (fill) facts.fills.push(fill);

    const preset = /<a:prstGeom prst="([^"]+)"/.exec(spPr)?.[1];
    if (preset) {
      facts.presetCounts[preset] = (facts.presetCounts[preset] ?? 0) + 1;
      if (preset === 'roundRect') {
        const adj = /<a:gd name="adj" fmla="val (\d+)"/.exec(spPr)?.[1];
        const ext = /<a:ext cx="(\d+)" cy="(\d+)"/.exec(spPr);
        if (adj && ext) {
          const r = (Number(adj) / 100000) * Math.min(Number(ext[1]), Number(ext[2])) / EMU_PER_PX;
          if (r > 0) facts.roundRadiiPx.push(Math.round(r));
        }
      }
    }

    if (block.includes('<a:t>')) {
      const off = /<a:off x="(-?\d+)" y="(-?\d+)"\/>\s*<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(spPr);
      if (off) {
        const left = Number(off[1]) / EMU_PER_PX;
        const top = Number(off[2]) / EMU_PER_PX;
        const w = Number(off[3]) / EMU_PER_PX;
        const h = Number(off[4]) / EMU_PER_PX;
        if (w > 0 && h > 0) facts.textRects.push({ left, top, right: left + w, bottom: top + h });
      }
    }
  }

  for (const m of xml.matchAll(/<a:ln\b[^>]*\bw="(\d+)"/g)) {
    if (Number(m[1]) <= 12700) facts.thinLineCount++;
  }

  const transition = /<p:transition\b[\s\S]*?<p:(fade|push|wipe|morph)\b/.exec(xml)?.[1];
  if (transition) facts.transition = transition;

  return facts;
}

/* ============================================================
 * 归纳
 * ============================================================ */

const SERIF_RE = /serif|times|garamond|georgia|didot|song|宋|楷|kai|ming|book antiqua|palatino/i;

/** 字体必须在 metrics 表里 —— 否则测量和渲染会变成两个字体 */
function safeFont(raw: string | undefined, role: keyof NeoxComposeTheme['fonts']): string {
  const name = (raw ?? '').trim();
  if (name && hasFontMetrics(name)) return name;
  switch (role) {
    case 'displayEast':
    case 'textEast':
      return SERIF_RE.test(name) ? 'Songti SC' : 'PingFang SC';
    case 'displayLatin':
      return SERIF_RE.test(name) ? 'Didot' : 'Avenir Next';
    case 'textLatin':
      return 'Helvetica Neue';
    case 'numeric':
      return 'Avenir Next';
  }
}

const RADIUS_DEFAULT: Record<Motif, number> = {
  chevron: 10, ribbon: 8, capsule: 18, line: 4, none: 6,
};

function inferMotif(facts: SlideFacts[]): { value: Motif; evidence: string } {
  const preset = (name: string): number =>
    facts.reduce((n, f) => n + (f.presetCounts[name] ?? 0), 0);
  const largeRound = facts.reduce((n, f) => n + f.roundRadiiPx.filter((r) => r >= 12).length, 0);
  const thinLines = facts.reduce((n, f) => n + f.thinLineCount, 0);

  const scores: Record<Motif, number> = {
    chevron: preset('chevron') * 3 + preset('homePlate') * 3 + preset('notchedRightArrow') * 3
      + preset('rightArrow') + preset('triangle') * 1.5 + preset('pentagon'),
    ribbon: preset('ribbon2') * 4 + preset('plaque') * 2,
    capsule: largeRound * 2 + preset('ellipse') * 0.5,
    line: (preset('line') + preset('straightConnector1')) * 3 + thinLines * 0.4,
    none: 0,
  };

  let best: Motif = 'none';
  let bestScore = 1.999; /* 低于 2 分一律 none —— 宁可克制, 不要硬套一个不存在的形态 */
  for (const motif of MOTIFS) {
    if (motif === 'none') continue;
    if (scores[motif] > bestScore) { best = motif; bestScore = scores[motif]; }
  }

  const detail: string[] = [];
  const chevronN = preset('chevron') + preset('homePlate') + preset('notchedRightArrow')
    + preset('rightArrow') + preset('triangle') + preset('pentagon');
  if (chevronN) detail.push(`箭头/楔形 ${chevronN} 个`);
  if (largeRound) detail.push(`大圆角形状 ${largeRound} 个`);
  if (preset('ribbon2') + preset('plaque')) detail.push(`丝带/牌匾 ${preset('ribbon2') + preset('plaque')} 个`);
  if (thinLines >= 4) detail.push(`细线 ${thinLines} 条`);
  return {
    value: best,
    evidence: detail.length ? detail.join(' · ') : '没有明显装饰几何, 走无装饰排版',
  };
}

function inferTypeScale(facts: SlideFacts[]): { value: TypeScale; evidence: string } {
  const sizes = facts.flatMap((f) => f.fontSizesPt);
  const boldSizes = new Set(facts.flatMap((f) => f.boldSizesPt));
  if (!sizes.length) {
    return { value: DEFAULT_STYLE_SPEC.type, evidence: '稿件里没有可读字号, 用默认字阶' };
  }

  const sorted = [...new Set(sizes)].sort((a, b) => b - a);
  const max = sorted[0]!;
  const display = clamp(max, 28, 56);

  const titleCandidate = sorted.find((s) => s < max * 0.96 && s >= max * 0.42);
  const title = clamp(titleCandidate ?? display * 0.6, 18, 34);

  /* 正文 = 12~22pt 区间里出现最多的字号 (标题/图注是少数, 正文是多数) */
  const bodyPool = sizes.filter((s) => s >= 10 && s <= 24);
  const body = clamp(mostCommonBodySize(bodyPool) ?? median(bodyPool) ?? 14, 10, 20);

  const captionPool = sorted.filter((s) => s < body && s >= 8);
  const caption = clamp(captionPool[0] ?? body * 0.8, 8, 14);

  const value: TypeScale = {
    display: { size: display, weight: 'bold', lineHeight: 1.18, tracking: -0.5 },
    title: { size: title, weight: 'bold', lineHeight: 1.28, tracking: -0.2 },
    body: { size: body, weight: 'regular', lineHeight: 1.62, tracking: 0 },
    caption: { size: caption, weight: 'regular', lineHeight: 1.5, tracking: 0.3 },
    numeral: {
      size: clamp(title, 20, 40),
      weight: boldSizes.has(title) || boldSizes.has(display) ? 'bold' : 'regular',
      lineHeight: 1.1,
      tracking: 0,
    },
  };
  const evidence = `字号出现 ${sorted.length} 档 (最大 ${max}pt, 正文 ${body}pt)`;
  return { value, evidence };
}

function inferGrid(facts: SlideFacts[], slideW: number, slideH: number): GridSpec {
  const rects = facts.flatMap((f) => f.textRects);
  if (rects.length < 2) return DEFAULT_STYLE_SPEC.grid;

  const left = Math.min(...rects.map((r) => r.left).filter((v) => v >= 8));
  const top = Math.min(...rects.map((r) => r.top).filter((v) => v >= 8));
  const right = Math.min(...rects.map((r) => slideW - r.right).filter((v) => v >= 8));
  const bottom = Math.min(...rects.map((r) => slideH - r.bottom).filter((v) => v >= 8));

  const pick = (v: number, fallback: number, max: number): number =>
    Number.isFinite(v) ? clamp(Math.round(v), 24, max) : fallback;

  return {
    cols: DEFAULT_STYLE_SPEC.grid.cols,
    gutter: DEFAULT_STYLE_SPEC.grid.gutter,
    baseline: DEFAULT_STYLE_SPEC.grid.baseline,
    margin: {
      left: pick(left, DEFAULT_STYLE_SPEC.grid.margin.left, 160),
      right: pick(right, DEFAULT_STYLE_SPEC.grid.margin.right, 160),
      top: pick(top, DEFAULT_STYLE_SPEC.grid.margin.top, 140),
      bottom: pick(bottom, DEFAULT_STYLE_SPEC.grid.margin.bottom, 140),
    },
  };
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28) || 'style';
}

/** FNV-1a 6 位 —— 同一份稿子重复导入得到同一个 id */
function fingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 6);
}

/* ============================================================
 * 主入口
 * ============================================================ */

export async function extractStyleFromPptx(
  bytes: Uint8Array,
  opts: ImportStyleOptions = {},
): Promise<{ spec: StyleSpec; report: ImportStyleReport }> {
  const zip = await JSZip.loadAsync(bytes);

  const presFile = zip.file('ppt/presentation.xml');
  if (!presFile) throw new Error('pptx 结构损坏: 缺 ppt/presentation.xml');
  const presXml = await presFile.async('string');
  const sz = /<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/.exec(presXml);
  if (!sz) throw new Error('pptx 结构损坏: presentation.xml 缺 <p:sldSz cx cy>');
  const slideW = Math.round(Number(sz[1]) / EMU_PER_PX);
  const slideH = Math.round(Number(sz[2]) / EMU_PER_PX);

  const themeFile = Object.keys(zip.files)
    .filter((n) => /^ppt\/theme\/theme\d+\.xml$/.test(n))
    .sort()[0];
  if (!themeFile) throw new Error('pptx 结构损坏: 缺 ppt/theme/theme1.xml');
  const theme = parseThemeXml(await zip.file(themeFile)!.async('string'));

  const slideFiles = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)\.xml/)![1]) - Number(b.match(/(\d+)\.xml/)![1]));
  if (!slideFiles.length) throw new Error('这份 pptx 里没有幻灯片, 抽不出风格');

  const facts: SlideFacts[] = [];
  for (const f of slideFiles) {
    facts.push(scanSlideXml(await zip.file(f)!.async('string'), theme));
  }

  const notes: string[] = [];

  /* ---- 颜色 ---- */
  const backgrounds = facts.flatMap((f) => f.backgrounds);
  const paper = mostCommon(backgrounds) ?? theme.colors.lt1 ?? '#FFFFFF';

  /* 正文色: 候选里跟纸底对比度最高的那个; dk1 优先 (PowerPoint 的惯例) */
  const inkCandidates = [theme.colors.dk1, theme.colors.dk2, theme.colors.lt1, theme.colors.lt2]
    .filter((c): c is string => !!c);
  let ink = inkCandidates[0] ?? '#000000';
  let best = 0;
  for (const c of inkCandidates) {
    const v = contrast(c, paper);
    if (v > best) { best = v; ink = c; }
  }
  if (contrast(ink, paper) < 4.5) {
    ink = ensureContrast(ink, paper, 4.5);
    notes.push('原稿的文字色与纸底对比度不足 4.5, 已朝深色压到达标 (实色, 不用透明度)');
  }

  /* 主色: theme accent1 是公司模板的权威值; 但 Office 默认模板的 accent1 是通用蓝,
   * 真正品牌色常写在形状里 —— 这时用出现最多的彩色填充。 */
  const slideColors = facts.flatMap((f) => f.fills).filter(isColorful);
  const themeAccent = theme.colors.accent1;
  const commonSlideColor = mostCommon(slideColors);
  let accent = themeAccent ?? commonSlideColor ?? DEFAULT_STYLE_SPEC.theme.accent;
  let colorSource: 'theme' | 'slides' = themeAccent ? 'theme' : 'slides';
  if (themeAccent && commonSlideColor && commonSlideColor !== themeAccent) {
    const accentCount = slideColors.filter((c) => c === commonSlideColor).length;
    if (accentCount >= 3) {
      accent = commonSlideColor;
      colorSource = 'slides';
      notes.push(`theme accent1 是 ${themeAccent}, 但稿件里 ${commonSlideColor} 出现 ${accentCount} 次 —— 以实际用色为主色`);
    }
  }
  if (contrast(accent, paper) < 1.6) {
    const fixed = ensureContrast(accent, paper, 2.2);
    notes.push(`主色 ${accent} 在纸底上几乎看不见, 已调整为 ${fixed}`);
    accent = fixed;
  }

  const accentDeep = ensureContrast(mix(accent, relLum(paper) > 0.5 ? '#000000' : '#FFFFFF', 0.3), paper, 3);
  const accentSoft = mix(accent, paper, 0.86);
  const muted = ensureContrast(mix(ink, paper, 0.45), paper, 4.5);
  const subtle = mix(ink, paper, 0.88);
  const surface = mix(ink, paper, 0.95);
  const onInkCandidates = [paper, '#FFFFFF', '#F8FAFC'];
  const onInk = onInkCandidates.reduce((a, b) => (contrast(b, ink) > contrast(a, ink) ? b : a));

  /* ---- 字体 ---- */
  const substitutions: FontSubstitution[] = [];
  const pickFont = (raw: string | undefined, role: keyof NeoxComposeTheme['fonts']): string => {
    const to = safeFont(raw, role);
    if (raw && raw !== to) substitutions.push({ role, from: raw, to });
    return to;
  };
  const fonts = {
    displayLatin: pickFont(theme.majorLatin ?? theme.minorLatin, 'displayLatin'),
    displayEast: pickFont(theme.majorEast ?? theme.minorEast, 'displayEast'),
    textLatin: pickFont(theme.minorLatin ?? theme.majorLatin, 'textLatin'),
    textEast: pickFont(theme.minorEast ?? theme.majorEast, 'textEast'),
    numeric: pickFont(theme.minorLatin ?? theme.majorLatin, 'numeric'),
  };
  for (const s of substitutions) {
    notes.push(`字体 "${s.from}" (${s.role}) 本机没有烘焙 metrics, 已替换为 "${s.to}" —— 测量和导出用同一个面, 排版才不会错位`);
  }
  if (!theme.majorLatin && !theme.minorLatin) {
    notes.push('主题里没有声明字体, 已用默认字体族');
  }

  /* ---- 形态 / 圆角 / 字阶 / 栅格 ---- */
  const motif = inferMotif(facts);
  const radii = facts.flatMap((f) => f.roundRadiiPx);
  const baseRadius = median(radii) ?? RADIUS_DEFAULT[motif.value];
  const md = clamp(Math.round(baseRadius), 2, 28);
  const radius: RadiusScale = {
    sm: clamp(Math.round(md * 0.45), 2, 14),
    md,
    lg: motif.value === 'capsule' ? 999 : clamp(Math.round(md * 1.7), md, 40),
    path: clamp(Math.round(md * 0.9), 2, 24),
  };
  const type = inferTypeScale(facts);
  const grid = inferGrid(facts, slideW, slideH);

  /* ---- 动效 ---- */
  const transition = facts.map((f) => f.transition).find(Boolean);
  const motion: StyleSpec['motion'] = transition && ['fade', 'push', 'wipe', 'morph'].includes(transition)
    ? { transition: transition as 'fade' | 'push' | 'wipe' | 'morph', build: 'none', stagger: 0 }
    : { transition: 'fade', build: 'none', stagger: 0 };

  /* ---- id / 名字 ---- */
  const baseName = opts.displayName?.trim()
    || (opts.sourceName ? opts.sourceName.replace(/\.pptx$/i, '') : '')
    || '导入风格';
  const generatedId = `imported-${slugify(baseName)}-${fingerprint(JSON.stringify({
    paper, ink, accent, fonts, motif: motif.value,
  }))}`;
  const styleId = opts.styleId?.trim() || generatedId;
  if (!STYLE_ID_RE.test(styleId)) {
    throw new Error(`styleId 只能用小写字母/数字/连字符 (2-64 位), 收到 "${styleId}"`);
  }

  const themeTokens: NeoxComposeTheme = {
    id: `${styleId}-theme`,
    name: baseName,
    paper,
    ink,
    muted,
    subtle,
    accent,
    accentSoft,
    accentDeep,
    onInk,
    surface,
    fonts,
  };

  const spec: StyleSpec = {
    id: styleId,
    displayName: baseName,
    suitedFor: opts.suitedFor?.trim() || '沿用用户既有稿件的配色、字体与形态',
    theme: themeTokens,
    motif: motif.value,
    radius,
    type: type.value,
    grid,
    imagery: { ...DEFAULT_STYLE_SPEC.imagery },
    motion,
  };

  const aspect = slideW / slideH;
  if (Math.abs(aspect - 16 / 9) > 0.02) {
    notes.push(`原稿画布 ${slideW}×${slideH} (非 16:9); 风格可以沿用, 但生成仍按 16:9 排版 (P-04 另行处理)`);
  }

  const report: ImportStyleReport = {
    source: {
      slideCount: slideFiles.length,
      slideWidthPx: slideW,
      slideHeightPx: slideH,
      themeName: theme.name,
    },
    colorSource,
    colors: { paper, ink, accent, accentDeep, muted },
    fonts: { ...fonts, substitutions },
    motif,
    radius: {
      value: radius,
      evidence: radii.length ? `原稿圆角半径中位数 ${md}px` : `没检出圆角形状, 按 ${motif.value} 取默认 ${md}px`,
    },
    type,
    grid,
    notes,
  };

  return { spec, report };
}
