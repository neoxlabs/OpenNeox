/**
 * Unified Fuzzy Line-Sequence Matcher
 *
 * Consolidates the matching logic from:
 *   - editFileTool.ts (seekSequence / normalizeMatchLine / findNextMatch)
 *   - patch/fuzzyApplicator.ts (seekSequenceWith / normalizeMatchLine / locateHunk)
 *
 * 5-Level progressive matching:
 *   L0 — Exact (character-for-character)
 *   L1 — TrimEnd (trailing whitespace ignored)
 *   L2 — Trim (leading + trailing whitespace ignored)
 *   L3 — Normalize (Unicode fullwidth→halfwidth, smart quotes, fancy dashes)
 *   L4 — Offset search (L2 comparison within ±N lines of hint)
 *
 * Design: "find-at-lowest-level-and-stop" — once a match is found at level N,
 * higher levels are never tried, keeping results deterministic and fast.
 */

// Re-export FuzzLevel from patch types for backward compat
export { FuzzLevel } from './patch/types.js';

// ============================================================================
// Types
// ============================================================================

export interface SequenceMatch {
  /** 0-based index in fileLines where the pattern starts */
  index: number;
  /** 1-based line number (index + 1) */
  line: number;
  /** Fuzz level that produced this match */
  fuzzLevel: number;
}

export type LineComparator = (fileLine: string, patternLine: string) => boolean;

// ============================================================================
// Unicode Normalization (single source of truth)
// ============================================================================

/**
 * Normalize a line for fuzzy matching:
 * - trim leading/trailing whitespace
 * - smart quotes → ASCII quotes
 * - fancy dashes → ASCII hyphen
 * - fullwidth punctuation → ASCII
 * - various Unicode spaces → ASCII space
 */
export function normalizeMatchLine(line: string): string {
  const trimmed = line.trim();
  let out = '';
  for (const ch of trimmed) {
    switch (ch) {
      // Various dash/minus characters → ASCII hyphen
      case '\u2010': case '\u2011': case '\u2012':
      case '\u2013': case '\u2014': case '\u2015':
      case '\u2212':
        out += '-'; break;
      // Smart single quotes → ASCII apostrophe
      case '\u2018': case '\u2019': case '\u201A': case '\u201B':
        out += "'"; break;
      // Smart double quotes → ASCII double quote
      case '\u201C': case '\u201D': case '\u201E': case '\u201F':
        out += '"'; break;
      // Non-breaking and various width spaces → ASCII space
      case '\u00A0': case '\u2002': case '\u2003': case '\u2004':
      case '\u2005': case '\u2006': case '\u2007': case '\u2008':
      case '\u2009': case '\u200A': case '\u202F': case '\u205F':
      case '\u3000':
        out += ' '; break;
      // Fullwidth punctuation → ASCII
      case '\u3002': out += '.'; break;
      case '\uFF0C': out += ','; break;
      case '\uFF01': out += '!'; break;
      case '\uFF1F': out += '?'; break;
      case '\uFF1B': out += ';'; break;
      case '\uFF1A': out += ':'; break;
      case '\uFF08': out += '('; break;
      case '\uFF09': out += ')'; break;
      case '\uFF3B': out += '['; break;
      case '\uFF3D': out += ']'; break;
      case '\uFF5B': out += '{'; break;
      case '\uFF5D': out += '}'; break;
      case '\uFF0E': out += '.'; break;
      case '\uFF5E': out += '~'; break;
      default:
        out += ch; break;
    }
  }
  return out;
}

// ============================================================================
// Comparators (one per fuzz level)
// ============================================================================

export const comparators: readonly LineComparator[] = [
  /* L0 Exact    */ (a, b) => a === b,
  /* L1 TrimEnd  */ (a, b) => a.trimEnd() === b.trimEnd(),
  /* L2 Trim     */ (a, b) => a.trim() === b.trim(),
  /* L3 Normalize*/ (a, b) => normalizeMatchLine(a) === normalizeMatchLine(b),
  /* L4 Offset   */ (a, b) => a.trim() === b.trim(),  // same as L2, but with restricted search window
];

// ============================================================================
// Core Search: seekSequenceWith
// ============================================================================

/**
 * Search for a contiguous sequence of lines within fileLines using a comparator.
 *
 * @param fileLines  - Lines of the file
 * @param pattern    - Lines to search for
 * @param comparator - How to compare a file line vs pattern line
 * @param start      - Start searching from this 0-based index (inclusive)
 * @param end        - Stop searching at this 0-based index (inclusive, default = fileLines.length - 1)
 * @returns 0-based index where pattern was found, or null
 */
export function seekSequenceWith(
  fileLines: string[],
  pattern: string[],
  comparator: LineComparator,
  start: number = 0,
  end?: number,
): number | null {
  if (pattern.length === 0) return start;
  const maxStart = Math.min(
    fileLines.length - pattern.length,
    end !== undefined ? end : fileLines.length - 1,
  );

  for (let i = Math.max(0, start); i <= maxStart; i++) {
    let ok = true;
    for (let j = 0; j < pattern.length; j++) {
      if (!comparator(fileLines[i + j], pattern[j])) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }

  return null;
}

// ============================================================================
// seekSequence: Multi-level progressive search (replaces editFileTool.seekSequence)
// ============================================================================

/**
 * Search for a line sequence using progressively fuzzier matching.
 * Stops at the first level that finds a match.
 *
 * This is the direct replacement for editFileTool's `seekSequence()`.
 *
 * @param fileLines - File lines array
 * @param pattern   - Lines to search for
 * @param start     - 0-based start index
 * @param maxLevel  - Maximum fuzz level to try (default 3, i.e. L0-L3)
 * @returns Match result or null
 */
export function seekSequence(
  fileLines: string[],
  pattern: string[],
  start: number,
  maxLevel: number = 3,
): SequenceMatch | null {
  for (let level = 0; level <= Math.min(maxLevel, 3); level++) {
    const idx = seekSequenceWith(fileLines, pattern, comparators[level], start);
    if (idx !== null) {
      return { index: idx, line: idx + 1, fuzzLevel: level };
    }
  }
  return null;
}

/**
 * Find the first match of oldLines in fileLines, with trailing-empty-line tolerance.
 * Direct replacement for editFileTool's `findNextMatch()`.
 */
export function findNextMatch(
  fileLines: string[],
  oldLines: string[],
  newLines: string[],
  start: number,
): { start: number; oldLines: string[]; newLines: string[] } | null {
  const match = seekSequence(fileLines, oldLines, start);
  if (match) {
    return { start: match.index, oldLines, newLines };
  }

  // Retry: if last line of oldLines is empty, try without it
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') {
    const trimmedOld = oldLines.slice(0, -1);
    if (trimmedOld.length > 0) {
      const retryMatch = seekSequence(fileLines, trimmedOld, start);
      if (retryMatch) {
        const trimmedNew = newLines[newLines.length - 1] === '' ? newLines.slice(0, -1) : newLines;
        return { start: retryMatch.index, oldLines: trimmedOld, newLines: trimmedNew };
      }
    }
  }

  return null;
}

// ============================================================================
// 内容层容错 — L0~L3 之下的恢复阶梯
//
// L0-L3 normalize whitespace and Unicode lookalikes but remain strict about
// source content. Every recovery tier requires a unique bounded match and
// replaces the file's actual text, so ambiguity fails closed.
// ============================================================================

/** 省略号标记 — 模型常用 `// ...` / `# ...` / `...` 表示"这中间的若干行原样不动" */
const ELISION_RE = /^\s*(?:\/\/|#|--|\/\*|\*)?\s*\.{3,}\s*(?:\*\/)?\s*$/;

export function isElisionLine(line: string): boolean {
  return ELISION_RE.test(line);
}

/** 单行相似度 0~1 — 归一化后按字符二元组集合的 Dice 系数。空行视作完全相同。 */
export function lineSimilarity(a: string, b: string): number {
  const x = normalizeMatchLine(a);
  const y = normalizeMatchLine(b);
  if (x === y) return 1;
  if (!x.length || !y.length) return 0;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const ga = grams(x), gb = grams(y);
  let inter = 0, total = 0;
  for (const [g, n] of ga) { total += n; const o = gb.get(g); if (o) inter += Math.min(n, o); }
  for (const [, n] of gb) total += n;
  return total === 0 ? 0 : (2 * inter) / total;
}

export interface FuzzyMatchResult {
  /** 命中起始 1-based 行号 */
  line: number;
  /** 文件里真实被覆盖的那几行 (替换时必须用它, 不能用模型给的 pattern) */
  actualLines: string[];
  /** 恢复档位 */
  kind: 'blank_insensitive' | 'elided' | 'similar';
  /** 0~1, 越高越像 */
  similarity: number;
  /** 对不上的行数 (给用户/模型看的诚实交代) */
  mismatchCount: number;
}

/** 去掉空行后逐行比较 —— "空行被吞" 这一类无歧义, 安全。 */
function matchIgnoringBlanks(fileLines: string[], pattern: string[]): FuzzyMatchResult[] {
  const pat = pattern.filter(l => l.trim() !== '');
  if (pat.length === 0) return [];
  const out: FuzzyMatchResult[] = [];
  const cmp = comparators[3];
  for (let i = 0; i < fileLines.length; i++) {
    let j = i, k = 0;
    while (j < fileLines.length && k < pat.length) {
      if (fileLines[j].trim() === '') { j++; continue; }   // 文件里的空行随便跳
      if (!cmp(fileLines[j], pat[k])) break;
      j++; k++;
    }
    if (k === pat.length) {
      out.push({ line: i + 1, actualLines: fileLines.slice(i, j), kind: 'blank_insensitive', similarity: 1, mismatchCount: 0 });
      i = j - 1;
      if (out.length > 1) break; // 只需知道"是否唯一"
    }
  }
  return out;
}

/** `头部锚 ... 尾部锚` —— 中间原样保留。头尾都必须精确唯一, 否则不敢用。 */
function matchWithElision(fileLines: string[], pattern: string[]): FuzzyMatchResult[] {
  const eIdx = pattern.findIndex(isElisionLine);
  if (eIdx <= 0 || eIdx >= pattern.length - 1) return [];   // 必须头尾都有实质内容
  const head = pattern.slice(0, eIdx).filter(l => l.trim() !== '');
  const tail = pattern.slice(eIdx + 1).filter(l => l.trim() !== '');
  if (head.length === 0 || tail.length === 0) return [];
  if (pattern.slice(eIdx + 1).some(isElisionLine)) return []; // 多个省略号 → 语义不清, 拒

  const heads = countNormalizedMatches(fileLines, head, 0, 3);
  if (heads.length !== 1) return [];                          // 头锚必须唯一 — 起点不能猜
  const hStart = heads[0] - 1;
  /* The first tail after the unique head defines the elided span; requiring
   * global tail uniqueness would reject valid repeated function bodies. */
  const tails = countNormalizedMatches(fileLines, tail, hStart + head.length, 1);
  if (tails.length === 0) return [];
  const tStart = tails[0] - 1;
  /* 但要防"吞掉半个文件": 省略号跨度不该离谱地大 */
  const span = tStart + tail.length - hStart;
  if (span > Math.max(200, pattern.length * 20)) return [];
  const end = tStart + tail.length;
  return [{
    line: hStart + 1,
    actualLines: fileLines.slice(hStart, end),
    kind: 'elided',
    similarity: 1,
    mismatchCount: 0,
  }];
}

/** 这一行是"无实质内容"的吗 (空行 / 纯注释) —— 这类行的漂移可以宽容, 代码行不行。 */
function isTrivialLine(line: string): boolean {
  const t = line.trim();
  if (t === '') return true;
  return /^(\/\/|#|\*|\/\*|\*\/|--|<!--)/.test(t);
}

/**
 * 代码行(非空非注释)允许的最低单行相似度 —— 低于这个就认为"改的不是同一行", 不敢动。
 *
 *  这个阈值是**校准出来的, 且窗口很窄**, 改动前务必重跑扰动基准:
 *     应恢复: const→let 0.889 · 标识符改名 0.947        (注释漂移走 isTrivialLine 豁免)
 *     不该恢复: 字面量 "xxx"→"bye" 0.846 · →"hello" 0.815
 *   两组只差 0.043 —— 单行相似度是能把它们分开的**唯一**信号(块级平均分和次优差距都分不开:
 *   两个案例在结构上几乎对称, 都是"一行精确命中 + 一行 ~0.85")。
 *
 *   这也是启发式的天花板所在: 再往下就需要 Cursor 那种 apply 小模型来理解意图。
 *   所以这里的态度是"能救的救, 分不清的宁可报错让模型重读", 而不是硬猜。
 */
const SUBSTANTIVE_LINE_FLOOR = 0.85;

/** 相似度定位 —— 整体打分 + **决定性行**的单行闸。只接受"高分 + 明显唯一 + 代码行没走样"。 */
function matchBySimilarity(
  fileLines: string[],
  pattern: string[],
  opts: { minSimilarity: number; minMargin: number; enforceLineFloor?: boolean },
): { best: FuzzyMatchResult | null; runnerUp: number; blockedByLineFloor?: boolean } {
  const n = pattern.length;
  if (n === 0 || n > fileLines.length) return { best: null, runnerUp: 0 };

  const scoreAt = (i: number): { sim: number; mismatch: number; worstSubstantive: number } => {
    let sum = 0, mismatch = 0, worst = 1;
    for (let j = 0; j < n; j++) {
      const s = lineSimilarity(fileLines[i + j], pattern[j]);
      sum += s;
      if (s < 0.999) {
        mismatch++;
        /* 只有"实质行"(非空非注释)才计入最差分 —— 注释漂移不该否决整次编辑,
           但代码行对不上就意味着我们可能在改另一处逻辑。 */
        if (!isTrivialLine(pattern[j]) || !isTrivialLine(fileLines[i + j])) {
          worst = Math.min(worst, s);
        }
      }
    }
    return { sim: sum / n, mismatch, worstSubstantive: worst };
  };

  let best: { i: number; sim: number; mismatch: number; worst: number } | null = null;
  let second = 0;
  for (let i = 0; i + n <= fileLines.length; i++) {
    const { sim, mismatch, worstSubstantive } = scoreAt(i);
    if (!best || sim > best.sim) {
      if (best) second = Math.max(second, best.sim);
      best = { i, sim, mismatch, worst: worstSubstantive };
    } else if (sim > second) second = sim;
  }
  if (!best || best.sim < opts.minSimilarity) return { best: null, runnerUp: second };
  if (best.sim - second < opts.minMargin) return { best: null, runnerUp: second };   // 有旗鼓相当的对手 → 不敢动

  /* A block average can hide an ambiguous substantive line, so the line-floor
   * check rejects a candidate whose weakest meaningful line is uncertain. */
  if (opts.enforceLineFloor !== false && best.worst < SUBSTANTIVE_LINE_FLOOR) {
    return { best: null, runnerUp: second, blockedByLineFloor: true };
  }

  return {
    best: {
      line: best.i + 1,
      actualLines: fileLines.slice(best.i, best.i + n),
      kind: 'similar',
      similarity: best.sim,
      mismatchCount: best.mismatch,
    },
    runnerUp: second,
  };
}

export interface RecoverOptions {
  /** similar 档最低整体相似度 (默认 0.90) */
  minSimilarity?: number;
  /** 与次优候选的最小差距 (默认 0.05) — 防止改到"长得也很像"的另一处 */
  minMargin?: number;
  /** similar 档允许对不上的最大行数 (默认 2) */
  maxMismatchLines?: number;
}

export interface RecoverOutcome {
  /** 成功恢复的唯一命中 */
  match?: FuzzyMatchResult;
  /** 没恢复成功时: 最接近的一处, 供报错时给模型看差在哪 */
  nearest?: { line: number; similarity: number; actualLines: string[] };
  /** 拒绝原因 (供报错文案) */
  reason?: 'ambiguous' | 'too_different' | 'none';
}

/**
 * 精确阶梯 (L0~L3) 全部落空后的恢复尝试。按"安全性从高到低"依次试:
 *   1. blank_insensitive — 只是空行对不上, 无歧义
 *   2. elided — 模型用 `// ...` 省略中段, 头尾锚唯一
 *   3. similar — 内容有 1~2 行漂移, 但整体高度相似且明显唯一
 * 任何一档只要"不唯一"就立刻放弃, 宁可让模型重读。
 */
export function recoverMatch(
  fileLines: string[],
  pattern: string[],
  opts: RecoverOptions = {},
): RecoverOutcome {
  const minSimilarity = opts.minSimilarity ?? 0.90;
  const minMargin = opts.minMargin ?? 0.05;
  const maxMismatchLines = opts.maxMismatchLines ?? 2;

  const blanks = matchIgnoringBlanks(fileLines, pattern);
  if (blanks.length === 1) return { match: blanks[0] };
  if (blanks.length > 1) return { reason: 'ambiguous' };

  const elided = matchWithElision(fileLines, pattern);
  if (elided.length === 1) return { match: elided[0] };

  /* similar 档已停用 (代码保留仅供 nearest 报错取样)。
   *
   * 它当初存在的理由是"文件可能已变 / 模型可能记错" —— 而这两件事现在由
   * readLedger.checkCoherence 精确区分开了 (unread / stale / fresh), edit 在 fresh 之外
   * 根本不会走到这里。也就是说 similar 是在**用内容去猜一个可以直接查到的事实**。
   *
   * 而它的代价是实打实的: 合法改写(const→let 0.889)与臆造字面量("xxx"→"bye" 0.846)
   * 单行相似度只差 0.043, 无法可靠区分, 只能靠一个校准出来的窄阈值去赌。
   * 现在这个赌不必下了 —— 拿掉它, 精度和优雅一起回来。 */
  void minSimilarity; void minMargin; void maxMismatchLines;

  /* 没恢复成功 —— 再宽松地找一处"最像的", 只用于报错时告诉模型差在哪, 绝不据此改文件。
     这里显式关掉单行闸: 目的是"给人看", 不是"拿来改"。 */
  const { best: loose } = matchBySimilarity(fileLines, pattern, {
    minSimilarity: 0.5, minMargin: 0, enforceLineFloor: false,
  });
  return {
    nearest: loose ? { line: loose.line, similarity: loose.similarity, actualLines: loose.actualLines } : undefined,
    reason: 'too_different',
  };
}

/**
 * Count all positions where pattern matches (using L3 normalize level).
 * Direct replacement for editFileTool's `countNormalizedMatches()`.
 */
export function countNormalizedMatches(
  fileLines: string[],
  pattern: string[],
  start: number,
  maxCount: number,
): number[] {
  const out: number[] = [];
  if (pattern.length === 0 || pattern.length > fileLines.length) return out;
  const maxStart = fileLines.length - pattern.length;
  const cmp = comparators[3]; // L3 normalize

  for (let i = Math.max(0, start); i <= maxStart; i++) {
    let ok = true;
    for (let j = 0; j < pattern.length; j++) {
      if (!cmp(fileLines[i + j], pattern[j])) {
        ok = false;
        break;
      }
    }
    if (ok) {
      out.push(i + 1); // 1-based
      if (out.length >= maxCount) break;
    }
  }
  return out;
}
