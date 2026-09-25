/**
 * layout/font-metrics — 真实字体 metrics 查询层.
 *
 * "我不要靠猜": 字符 advance 来自字体文件的 hmtx 表 (build-time 烘焙进
 * assets/font-metrics.data.ts), 不是启发式系数. 查询链:
 *
 *   resolveFontMetrics('Playfair Display', bold)
 *     → aliases: Playfair Display → Didot (机器上没有的字体映射到 metric 相近的系统字体,
 *        跟 WPS 遇到缺字体时的替换行为对齐 — 至少我们的替换是可预测的)
 *     → fonts['Didot:bold'] ?? fonts['Didot']
 *     → 全部 miss 时退 PingFang SC (CJK 等宽 1.0em · 最保守)
 *
 * charAdvanceEm 对未收录字符的兜底:
 *   - CJK 表意/假名/谚文/全角区 → cjkAdvance (等宽字体) ?? 1.0
 *   - 其余 → 该字体已收录 advances 的平均值 (比拍 0.6 更贴近该字体的真实密度)
 */

import { FONT_METRICS_DATA } from '../assets/font-metrics.data.js';

export interface FontMetricsRecord {
  unitsPerEm: number;
  /** hhea 垂直 metrics · em 分数 */
  ascent: number;
  descent: number;
  lineGap: number;
  typoAscent: number | null;
  typoDescent: number | null;
  typoLineGap: number | null;
  /** CJK 全角统一 advance (em) · null = 该字体 CJK 不等宽/无 CJK */
  cjkAdvance: number | null;
  /** codepoint(十进制字符串) → advance em 分数 */
  advances: Record<string, number>;
}

const DATA = FONT_METRICS_DATA as unknown as {
  fonts: Record<string, FontMetricsRecord>;
  aliases: Record<string, string>;
};

const FALLBACK_EAST = 'PingFang SC';
const FALLBACK_LATIN = 'Helvetica Neue';

/** 每字体的平均 latin advance 缓存 (未收录字符兜底用) */
const avgAdvanceCache = new Map<string, number>();

function avgAdvance(key: string, rec: FontMetricsRecord): number {
  let avg = avgAdvanceCache.get(key);
  if (avg == null) {
    /* 用小写字母 a-z 的平均 — 正文字符密度的最好单一代表 */
    let sum = 0, n = 0;
    for (let cp = 0x61; cp <= 0x7a; cp++) {
      const a = rec.advances[String(cp)];
      if (a != null) { sum += a; n++; }
    }
    avg = n > 0 ? sum / n : 0.55;
    avgAdvanceCache.set(key, avg);
  }
  return avg;
}

function normalizeFamily(family: string): string {
  return family.trim();
}

/* 缺少 metrics 时保留可用的字体回退，同时按字体族记录一次诊断，保证测量和渲染差异可见。 */
const warnedFamilies = new Set<string>();

/** 返回字体族是否拥有可用 metrics，供主题和风格注册时校验。 */
export function hasFontMetrics(family: string): boolean {
  const fam0 = normalizeFamily(family);
  const fam = DATA.fonts[fam0] || DATA.fonts[`${fam0}:bold`] ? fam0 : (DATA.aliases[fam0] ?? fam0);
  return Boolean(DATA.fonts[fam] || DATA.fonts[`${fam}:bold`]);
}

/** 字体名 → metrics 记录. bold 优先取 :bold 变体. 永远返回可用记录 (逐级兜底). */
export function resolveFontMetrics(family: string | undefined, bold?: boolean): FontMetricsRecord {
  const fam0 = normalizeFamily(family ?? FALLBACK_EAST);
  const fam = DATA.fonts[fam0] || DATA.fonts[`${fam0}:bold`] ? fam0 : (DATA.aliases[fam0] ?? fam0);
  if (!DATA.fonts[fam] && !DATA.fonts[`${fam}:bold`] && !warnedFamilies.has(fam0)) {
    warnedFamilies.add(fam0);
    console.warn(
      `[compose] 字体 "${fam0}" 既无烘焙 metrics 也无 alias —— 测量退到 ${FALLBACK_EAST}, ` +
      `渲染端会被替换成别的面。测量和渲染用的不是同一个字体, 排版必然对不上。`,
    );
  }
  if (bold) {
    const b = DATA.fonts[`${fam}:bold`];
    if (b) return b;
  }
  return DATA.fonts[fam]
    ?? DATA.fonts[FALLBACK_EAST]
    ?? Object.values(DATA.fonts)[0]!;
}

/* ============================================================
 * 字符分类 · 决定用 east 还是 latin 字体测量 (镜像 OOXML <a:latin>/<a:ea> 分排)
 * ============================================================ */

export function isEastAsianChar(cp: number): boolean {
  return (
    (cp >= 0x2e80 && cp <= 0x303f) ||   /* CJK 部首 · 康熙 · 符号标点 (含 、。〈〉《》「」) */
    (cp >= 0x3040 && cp <= 0x30ff) ||   /* 假名 */
    (cp >= 0x3130 && cp <= 0x318f) ||   /* 谚文兼容字母 */
    (cp >= 0x3400 && cp <= 0x4dbf) ||   /* CJK 扩展 A */
    (cp >= 0x4e00 && cp <= 0x9fff) ||   /* CJK 统一表意 */
    (cp >= 0xac00 && cp <= 0xd7af) ||   /* 谚文音节 */
    (cp >= 0xf900 && cp <= 0xfaff) ||   /* CJK 兼容表意 */
    (cp >= 0xfe30 && cp <= 0xfe4f) ||   /* CJK 兼容形式 */
    (cp >= 0xff00 && cp <= 0xff65) ||   /* 全角 ASCII 变体 + 全角标点 */
    (cp >= 0x20000 && cp <= 0x2ffff)    /* CJK 扩展 B+ */
  );
}

/** 单字符 advance (em 分数) · rec 是该字符所属 script 的字体记录 */
export function charAdvanceEm(cp: number, rec: FontMetricsRecord, cacheKey: string): number {
  const hit = rec.advances[String(cp)];
  if (hit != null) return hit;
  if (isEastAsianChar(cp)) return rec.cjkAdvance ?? 1.0;
  /* 未收录的非 CJK 字符 (重音拉丁扩展 · 西里尔 · emoji 等) */
  if (cp >= 0x1f000) return 1.0; /* emoji ≈ 全角 */
  return avgAdvance(cacheKey, rec);
}

/* ============================================================
 * 行高策略 — 唯一事实源.
 *
 * 这个值会被三处共享, 保证"测量 = 导出 = 预览"三位一体:
 *   1. measureText 算高度      (compose layout)
 *   2. exporter 写 <a:lnSpc><a:spcPts>  (钉死 WPS/Office 行高)
 *   3. React 预览 line-height   (renderer)
 *
 * 排版惯例: 字号越大行高系数越紧. 值圆整到 0.25pt (spcPts 精度 0.01pt, 圆整只为好看).
 * ============================================================ */

export function resolveLineHeightPt(fontSizePt: number, explicit?: number): number {
  if (explicit != null && explicit > 0) return round25(explicit);
  let factor: number;
  if (fontSizePt <= 20) factor = 1.4;        /* 正文 · CJK 阅读舒适 */
  else if (fontSizePt <= 32) factor = 1.3;   /* 小标题 / 引言 */
  else if (fontSizePt <= 44) factor = 1.2;   /* h1 */
  else factor = 1.12;                        /* hero / 巨号数字 */
  return round25(fontSizePt * factor);
}

function round25(x: number): number {
  return Math.round(x * 4) / 4;
}
