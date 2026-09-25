/**
 * text-metrics · 精准文本测量 (真实字体 metrics · 非启发式).
 *
 * 每字符 advance 来自字体 metrics，断行使用统一的 CJK/Latin 规则，导出端复用同一行高以保持测量一致。
 *
 * 单位: 输入 fontSize 是 pt, maxWidth 是 CSS px @96DPI, 输出 width/height 是 px.
 */

import {
  resolveFontMetrics,
  resolveLineHeightPt,
  charAdvanceEm,
  isEastAsianChar,
  type FontMetricsRecord,
} from './font-metrics.js';

const PT_TO_PX = 96 / 72;

/** 断行预测安全边: 预测线宽逼近 maxWidth 时按提前 2px 换行.
 * 防"我们算它塞得下 · WPS 差 0.5px 塞不下"的危险方向 (会造成真溢出).
 * 反方向 (我们提前一点换行) 只是行末稍空, 无害. */
const WRAP_SAFETY_PX = 2;

export interface TextMeasureOptions {
  singleLine?: boolean;
  maxLines?: number;
  bold?: boolean;
  fontLatin?: string;
  fontEast?: string;
  letterSpacingPt?: number;
  /** 显式行高 pt · 缺省走 resolveLineHeightPt 策略 (跟 exporter/预览共享同一事实源) */
  lineHeightPt?: number;
}

export interface TextMeasureResult {
  width: number;
  height: number;
  lines: number;
  /** 本次测量使用的行高 (pt) — paint 阶段必须把它写进 pptx lnSpc, 三位一体 */
  lineHeightPt: number;
}

/* ============================================================
 * 字符分类 + kinsoku 禁则
 * ============================================================ */

/** 行首禁排 (闭合标点不能开头 · 附着在前一 token 上) */
const NO_LINE_START = new Set([..."。，、！？；：）】》〉」』〕％‰…‥・;:,.!?%)]}›»”’"]
  .map((c) => c.codePointAt(0)!));

/** 行尾禁排 (开放标点不能结尾 · 附着在后一 token 上) */
const NO_LINE_END = new Set([..."（【《〈「『〔([{‹«“‘"]
  .map((c) => c.codePointAt(0)!));

function isSpace(cp: number): boolean {
  return cp === 0x20 || cp === 0x09 || cp === 0x3000; /* 半角空格 · tab · 全角空格 */
}

/* ============================================================
 * 测量核心
 * ============================================================ */

interface MeasureCtx {
  fontPx: number;
  letterPx: number;
  latin: FontMetricsRecord;
  east: FontMetricsRecord;
  latinKey: string;
  eastKey: string;
}

function charWidthPx(cp: number, ctx: MeasureCtx): number {
  const useEast = isEastAsianChar(cp);
  const rec = useEast ? ctx.east : ctx.latin;
  const key = useEast ? ctx.eastKey : ctx.latinKey;
  return charAdvanceEm(cp, rec, key) * ctx.fontPx + ctx.letterPx;
}

interface Token {
  width: number;
  /** 是不是 break-opportunity 空格 (行末可丢弃) */
  isSpace: boolean;
}

/** 一段无 \n 的文本 → token 序列 (kinsoku 已附着) */
function tokenize(text: string, ctx: MeasureCtx): Token[] {
  const tokens: Token[] = [];
  const cps = [...text].map((c) => c.codePointAt(0)!);
  let i = 0;
  /** pending: 行尾禁排 (开放标点) 累积宽度 · 附着到下一个 token 头上 */
  let pendingWidth = 0;

  while (i < cps.length) {
    const cp = cps[i]!;
    if (isSpace(cp)) {
      tokens.push({ width: charWidthPx(cp, ctx), isSpace: true });
      i++;
      continue;
    }
    if (NO_LINE_END.has(cp)) {
      pendingWidth += charWidthPx(cp, ctx);
      i++;
      continue;
    }
    if (isEastAsianChar(cp) || NO_LINE_START.has(cp)) {
      /* CJK 单字成 token; 后续闭合标点 (行首禁排) 全部吸附 */
      let w = pendingWidth + charWidthPx(cp, ctx);
      pendingWidth = 0;
      i++;
      while (i < cps.length && NO_LINE_START.has(cps[i]!)) {
        w += charWidthPx(cps[i]!, ctx);
        i++;
      }
      tokens.push({ width: w, isSpace: false });
      continue;
    }
    /* Latin/数字 run: 到下一个空格/CJK/开放标点为止, 整体不可断.
     * 保守方向: 我们不假设 PPT 会在 - / 之类处断词 — 宁可预测早换行, 不可预测塞得下. */
    let w = pendingWidth;
    pendingWidth = 0;
    while (i < cps.length) {
      const c = cps[i]!;
      if (isSpace(c) || isEastAsianChar(c) || NO_LINE_END.has(c)) break;
      w += charWidthPx(c, ctx);
      i++;
    }
    /* run 后面跟着的闭合标点吸附 (如 "GDP).") — 已含在循环里 (非 CJK 闭合标点不是 NO_LINE_END) */
    tokens.push({ width: w, isSpace: false });
  }
  if (pendingWidth > 0) tokens.push({ width: pendingWidth, isSpace: false });
  return tokens;
}

/** 贪心断行: token 依次填充 · 超宽换行 · 行末空格丢弃 · 超宽单 token 硬切 */
function breakLines(tokens: Token[], maxWidth: number): number[] {
  const lineWidths: number[] = [];
  let cur = 0;
  let curHasContent = false;

  const push = () => {
    lineWidths.push(cur);
    cur = 0;
    curHasContent = false;
  };

  for (const t of tokens) {
    if (t.isSpace) {
      /* 空格: 只有行内已有内容才累积 (行首空格丢弃); 行末空格在换行时自然丢弃 —
       * 简化: 空格宽度先累积, 若因它超宽则直接换行且不带走宽度. */
      if (curHasContent && cur + t.width <= maxWidth) cur += t.width;
      continue;
    }
    if (cur + t.width <= maxWidth || !curHasContent) {
      /* 塞得下, 或空行必须至少放一个 token (超宽 token 硬占一行, 下面再切) */
      if (t.width > maxWidth && !curHasContent) {
        /* 超宽单 token → 按 maxWidth 硬切成多行 (对齐 PPT 的 break-word 兜底) */
        let rest = t.width;
        while (rest > maxWidth) {
          lineWidths.push(maxWidth);
          rest -= maxWidth;
        }
        cur = rest;
        curHasContent = rest > 0;
        continue;
      }
      cur += t.width;
      curHasContent = true;
    } else {
      push();
      if (t.width > maxWidth) {
        let rest = t.width;
        while (rest > maxWidth) {
          lineWidths.push(maxWidth);
          rest -= maxWidth;
        }
        cur = rest;
        curHasContent = rest > 0;
      } else {
        cur = t.width;
        curHasContent = true;
      }
    }
  }
  if (curHasContent || lineWidths.length === 0) lineWidths.push(cur);
  return lineWidths;
}

/**
 * measureText — 精准版.
 * 高度公式: lines × lineHeightPt × PT_TO_PX. 没有缓冲, 因为行高会被钉进 pptx.
 */
export function measureText(
  text: string,
  fontSizePt: number,
  maxWidth: number,
  opts?: TextMeasureOptions,
): TextMeasureResult {
  const lineHeightPt = resolveLineHeightPt(fontSizePt, opts?.lineHeightPt);
  if (!text) return { width: 0, height: 0, lines: 0, lineHeightPt };

  const latinKey = opts?.fontLatin ?? 'Helvetica Neue';
  const eastKey = opts?.fontEast ?? 'PingFang SC';
  const ctx: MeasureCtx = {
    fontPx: fontSizePt * PT_TO_PX,
    letterPx: (opts?.letterSpacingPt ?? 0) * PT_TO_PX,
    latin: resolveFontMetrics(latinKey, opts?.bold),
    east: resolveFontMetrics(eastKey, opts?.bold),
    latinKey: `${latinKey}${opts?.bold ? ':b' : ''}`,
    eastKey: `${eastKey}${opts?.bold ? ':b' : ''}`,
  };

  const effectiveMax = opts?.singleLine || maxWidth === Infinity
    ? Infinity
    : Math.max(ctx.fontPx, maxWidth - WRAP_SAFETY_PX);

  const rawLines = text.split('\n');
  const widths: number[] = [];
  for (const raw of rawLines) {
    const tokens = tokenize(raw, ctx);
    if (effectiveMax === Infinity) {
      widths.push(tokens.reduce((s, t) => s + t.width, 0));
    } else {
      widths.push(...breakLines(tokens, effectiveMax));
    }
  }

  let lines = widths.length;
  if (opts?.maxLines && lines > opts.maxLines) lines = opts.maxLines;

  const width = maxWidth === Infinity
    ? Math.max(...widths, 0)
    : Math.min(maxWidth, Math.max(...widths, 0));
  const height = lines * lineHeightPt * PT_TO_PX;

  return { width, height, lines, lineHeightPt };
}

/**
 * truncateToLines — 把文本截到最多 maxLines 行, 末尾补省略号.
 *
 * `maxLines` 同时约束测量、绘制和导出；截断复用 measureText 的断行规则，确保各阶段行数一致。
 */
export function truncateToLines(
  text: string,
  fontSizePt: number,
  maxWidth: number,
  maxLines: number,
  opts?: TextMeasureOptions,
): string {
  if (!text || maxLines <= 0 || maxWidth === Infinity) return text;
  const base: TextMeasureOptions = { ...opts, maxLines: undefined, singleLine: false };
  if (measureText(text, fontSizePt, maxWidth, base).lines <= maxLines) return text;

  const chars = [...text];
  const fits = (n: number) =>
    measureText(chars.slice(0, n).join('').trimEnd() + '…', fontSizePt, maxWidth, base).lines <= maxLines;

  /* 二分最长的可行前缀 */
  let lo = 0, hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid; else hi = mid - 1;
  }
  if (lo <= 0) return '…';
  return chars.slice(0, lo).join('').trimEnd() + '…';
}

/* ============================================================
 * 向后兼容 shim (旧 API · 已有 template/外部调用不炸)
 * ============================================================ */

/** @deprecated 用 measureText — 真实 per-char advance 已取代平均字宽 */
export function estimateCharWidth(fontSizePt: number, text: string): number {
  if (!text) return fontSizePt * PT_TO_PX * 0.6;
  const m = measureText(text, fontSizePt, Infinity, { singleLine: true });
  return m.width / Math.max(1, [...text].length);
}

/** @deprecated 用 resolveLineHeightPt (pt) — 此函数返回 px 且系数已由策略层接管 */
export function estimateLineHeight(fontSizePt: number): number {
  return resolveLineHeightPt(fontSizePt) * PT_TO_PX;
}

export { resolveLineHeightPt } from './font-metrics.js';
