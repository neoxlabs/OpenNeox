/**
 * FuzzyMatcher —— fzf 风格的模糊匹配 + 打分器。
 *
 * 为什么自己写而不是用 fuzzysort / fuse.js
 * -----------------------------------------
 * 1. 我们要**返回匹配字符的下标数组**（给 UI 做高亮），大部分库没这个能力
 * 2. 我们要**自定义加分规则**（camelCase 边界 / 路径分隔符 / 导出符号）
 * 3. 我们的候选规模可预期（<500），纯 JS 实现足够快，没必要引依赖
 *
 * 算法概述（参考 junegunn/fzf v2 + VSCode 的 filter.ts）
 * ----------------------------------------------------
 * 对每一条候选：
 *   1. 把 query 逐字符按顺序去 target 里找，找不到 → 立刻淘汰
 *   2. 找到了 → 记下每个字符在 target 的下标
 *   3. 根据下标数组算一个 score：
 *        + 连续匹配段加分（连起来越长越好）
 *        + 单词边界匹配加分（camelCase / 路径分隔符 / 下划线前 = 加分）
 *        + 首字母匹配加分
 *        + 起始位置靠前加分
 *        - 匹配点之间的距离扣分
 *   4. 返回 { score, indices }
 *
 * 分数范围
 * --------
 * 非匹配 → -Infinity（调用方应该用 isFinite 过滤）
 * 匹配   → 0 ~ ~1000 之间，具体上限看 target 长度
 *
 * 性能
 * ----
 * 单次 match：O(|target|)，对 500 个候选做 match 大约 <5ms
 * 无需 worker 化
 */

// ============================================================================
// 权重常量 —— 对齐 fzf v2，但根据 IDE 场景微调
// ============================================================================

const SCORE_MATCH = 16;                // 基础匹配分
const SCORE_GAP_START = -3;            // 新 gap 开始的惩罚
const SCORE_GAP_EXTENSION = -1;        // gap 每延长一个字符的惩罚
const BONUS_BOUNDARY = 8;              // 单词边界匹配（/ _ - . 后面）
const BONUS_CAMEL = 20;                // camelCase 边界（小写后接大写）
// 比 BONUS_BOUNDARY 更高 —— 用户输入 "PDM" 找 "PsiDocumentManager"
// 是代码搜索最重要的场景，必须压倒普通子串匹配
const BONUS_CONSECUTIVE = 8;           // 连续两个字符都匹配
const BONUS_FIRST_CHAR = 4;            // 匹配到 target 第一个字符
const BONUS_EXACT = 200;               // 完整字符串等于 query（最强加分，只对完全相等触发）

// ============================================================================
// 公共 API
// ============================================================================

export interface FuzzyResult {
  /** 匹配分，越大越靠前；不匹配时为 -Infinity */
  score: number;
  /** 匹配字符在 target 中的下标数组，可用于 UI 高亮 */
  indices: number[];
}

export const NO_MATCH: FuzzyResult = { score: -Infinity, indices: [] };

export interface FuzzyMatchOptions {
  /** 大小写敏感。默认 false —— 代码搜索常规行为 */
  caseSensitive?: boolean;
  /**
   * 是否"smart case"：query 全小写 → 不敏感；query 含大写 → 敏感。
   * 默认 true（IDEA 和 VSCode 都这么做）。caseSensitive 为 true 时此项被忽略。
   */
  smartCase?: boolean;
}

/**
 * 主入口：计算 query 对 target 的模糊匹配分数。
 *
 * @returns 匹配结果；不匹配时 score === -Infinity
 */
export function fuzzyMatch(
  query: string,
  target: string,
  options: FuzzyMatchOptions = {},
): FuzzyResult {
  if (query.length === 0) return { score: 0, indices: [] };
  if (target.length === 0) return NO_MATCH;
  if (query.length > target.length) return NO_MATCH;

  const caseSensitive = resolveCaseSensitive(query, options);

  // 快路径：完全相等 —— 这是唯一触发 BONUS_EXACT 的条件。
  // 子串匹配不走快路径，让它走慢路径正常跟 camelCase 匹配竞争。
  if (
    target.length === query.length &&
    cmpStr(query, target, caseSensitive) === 0
  ) {
    return {
      score: BONUS_EXACT + query.length * SCORE_MATCH * 2,
      indices: Array.from({ length: query.length }, (_, i) => i),
    };
  }

  // 一般路径：贪心扫描 + 打分。
  // 注意：子串（比如 'foo' vs 'foobar'）也会走这条 —— computeScore 会通过
  // "连续匹配 + 首字符加分" 给它合理的分数，但不会像 BONUS_EXACT 那样爆表，
  // 这样 "PDM" vs "PsiDocumentManager" 的 camelCase 匹配能稳定赢"子串存在"。
  const indices = collectIndices(query, target, caseSensitive);
  if (!indices) return NO_MATCH;
  const score = computeScore(indices, target);
  return { score, indices };
}

/**
 * 批量过滤 + 排序 —— 给一组 target 打分，返回按 score 降序的结果列表。
 *
 * 会自动过滤掉 score === -Infinity 的条目。
 */
export function fuzzyFilter<T>(
  query: string,
  items: readonly T[],
  getString: (item: T) => string,
  options: FuzzyMatchOptions = {},
  limit = 100,
): Array<{ item: T; result: FuzzyResult }> {
  const matched: Array<{ item: T; result: FuzzyResult }> = [];
  for (const item of items) {
    const r = fuzzyMatch(query, getString(item), options);
    if (Number.isFinite(r.score)) {
      matched.push({ item, result: r });
    }
  }
  matched.sort((a, b) => b.result.score - a.result.score);
  return matched.slice(0, limit);
}

// ============================================================================
// 内部实现
// ============================================================================

function resolveCaseSensitive(query: string, opts: FuzzyMatchOptions): boolean {
  if (opts.caseSensitive) return true;
  if (opts.smartCase === false) return false;
  // smartCase default: 有大写就敏感
  return /[A-Z]/.test(query);
}

function cmpStr(a: string, b: string, caseSensitive: boolean): number {
  if (caseSensitive) return a === b ? 0 : a < b ? -1 : 1;
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  return la === lb ? 0 : la < lb ? -1 : 1;
}

function indexOfIgnoring(haystack: string, needle: string, caseSensitive: boolean): number {
  if (caseSensitive) return haystack.indexOf(needle);
  return haystack.toLowerCase().indexOf(needle.toLowerCase());
}

/**
 * 贪心地从左到右把 query 的每个字符在 target 里找一个占位 ——
 * 找不到的话返回 null。
 *
 * 这是"能不能匹配"的必要条件判断；后续的打分基于这个下标集合。
 * 注意这里*没*做最优对齐 —— 真正的 fzf 会做动态规划找最高分对齐 ——
 * 但对 IDE 场景，贪心最左匹配 + 打分结果已经够好，DP 版本留给未来优化。
 */
function collectIndices(
  query: string,
  target: string,
  caseSensitive: boolean,
): number[] | null {
  const q = caseSensitive ? query : query.toLowerCase();
  const t = caseSensitive ? target : target.toLowerCase();
  const indices: number[] = [];
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t.charCodeAt(ti) === q.charCodeAt(qi)) {
      indices.push(ti);
      qi++;
    }
  }
  if (qi < q.length) return null;
  return indices;
}

/**
 * 根据匹配下标数组计算分数。
 */
function computeScore(indices: number[], target: string): number {
  let score = 0;
  let prevIdx = -2;
  let inGap = false;

  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    score += SCORE_MATCH;

    // 首字符加分
    if (idx === 0) {
      score += BONUS_FIRST_CHAR;
    }

    // 单词边界 / camelCase 加分
    if (idx > 0) {
      const prevChar = target.charCodeAt(idx - 1);
      const curChar = target.charCodeAt(idx);
      if (isBoundary(prevChar)) {
        score += BONUS_BOUNDARY;
      } else if (isLower(prevChar) && isUpper(curChar)) {
        score += BONUS_CAMEL;
      }
    }

    // 连续匹配加分 / gap 惩罚
    if (prevIdx >= 0) {
      const gap = idx - prevIdx - 1;
      if (gap === 0) {
        score += BONUS_CONSECUTIVE;
        inGap = false;
      } else {
        if (!inGap) score += SCORE_GAP_START;
        score += SCORE_GAP_EXTENSION * gap;
        inGap = true;
      }
    }

    prevIdx = idx;
  }

  // 整体靠前加分：起点越靠前越好
  if (indices.length > 0) {
    score += Math.max(0, 10 - indices[0]);
  }

  return score;
}

// 字符类判定（ASCII 码）
function isLower(c: number): boolean {
  return c >= 97 && c <= 122;
}
function isUpper(c: number): boolean {
  return c >= 65 && c <= 90;
}
function isBoundary(c: number): boolean {
  // '/' '\' '_' '-' '.' ' ' 空格 制表符
  return (
    c === 47 || c === 92 || c === 95 || c === 45 || c === 46 || c === 32 || c === 9
  );
}
