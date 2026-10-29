import { extractParagraphs } from './wordOoxml.js';

export interface ParagraphChange {
  /** 改后文档里的段号 (0 起); 整段被删时是改前段号 */
  index: number;
  /** 改前的原文; 新增段落为空串 */
  before: string;
  /** 改后的文字; 删掉的段落为空串 */
  after: string;
}

/** 单个工具结果里最多带几条对照 (够回执引用, 也不把上下文撑爆) */
export const MAX_CHANGES_PER_RESULT = 8;
/** 每侧文字最多带多少字 (再长就截断, 回执引用也够了) */
export const MAX_CHANGE_TEXT = 300;

const clip = (s: string): string => (s.length > MAX_CHANGE_TEXT ? s.slice(0, MAX_CHANGE_TEXT) + '…' : s);

/**
 * 两份段落文本 → 改动列表。
 *
 *   用最长公共子序列对齐: 没动过的段落跳过, 中间的差异块里
 *     · 前后都有 → 一段换一段 = 改写 (before/after 都填)
 *     · 只有前   → 删掉
 *     · 只有后   → 新增
 *   段落特别多 (各 > 600 段) 时退回按下标对比 —— 长文档改一处也要 O(n·m) 内存不值得。
 */
export function diffParagraphTexts(before: readonly string[], after: readonly string[]): ParagraphChange[] {
  if (before.length > 600 || after.length > 600) return diffByIndex(before, after);

  /* LCS 表: lcs[i][j] = before[i..] 与 after[j..] 的最长公共子序列长度 */
  const n = before.length;
  const m = after.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = before[i] === after[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const out: ParagraphChange[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) { i++; j++; continue; }
    /* 收集一段差异块: 哪边前进后能重新对上就往哪边挪 */
    const startI = i;
    const startJ = j;
    while (i < n && j < m && before[i] !== after[j]) {
      const skipBefore = lcs[i + 1]![j]!;
      const skipAfter = lcs[i]![j + 1]!;
      if (skipBefore > skipAfter) i++;
      else if (skipAfter > skipBefore) j++;
      /* 两边都救不回来 = 这一段被改写, 一起前进 (否则会被拆成「删一段 + 加一段」) */
      else { i++; j++; }
    }
    /* 一边已走完, 差异块开不了头 (否则下面的循环原地打转) —— 把剩下的全算进来 */
    if (i === startI && j === startJ) { i = n; j = m; }
    const removed = before.slice(startI, i);
    const added = after.slice(startJ, j);
    const paired = Math.min(removed.length, added.length);
    for (let k = 0; k < paired; k++) {
      const b = removed[k]!;
      const a = added[k]!;
      if (b !== a) out.push({ index: startJ + k, before: clip(b), after: clip(a) });
    }
    for (let k = paired; k < removed.length; k++) {
      const b = removed[k]!;
      if (b) out.push({ index: startI + k, before: clip(b), after: '' });
    }
    for (let k = paired; k < added.length; k++) {
      const a = added[k]!;
      if (a) out.push({ index: startJ + k, before: '', after: clip(a) });
    }
  }
  return out;
}

/** 段落数过多时的兜底: 按段号比, 多出来的算新增/删除 */
function diffByIndex(before: readonly string[], after: readonly string[]): ParagraphChange[] {
  const out: ParagraphChange[] = [];
  const n = Math.max(before.length, after.length);
  for (let i = 0; i < n; i++) {
    const b = before[i];
    const a = after[i];
    if (b === a) continue;
    if (b === undefined) { if (a) out.push({ index: i, before: '', after: clip(a) }); continue; }
    if (a === undefined) { if (b) out.push({ index: i, before: clip(b), after: '' }); continue; }
    out.push({ index: i, before: clip(b), after: clip(a) });
  }
  return out;
}

/** 写盘前后两份 document.xml → 改动列表 (最多 MAX_CHANGES_PER_RESULT 条) */
export function summarizeDocxChanges(beforeXml: string, afterXml: string): ParagraphChange[] {
  const before = extractParagraphs(beforeXml).map((p) => p.text);
  const after = extractParagraphs(afterXml).map((p) => p.text);
  return diffParagraphTexts(before, after).slice(0, MAX_CHANGES_PER_RESULT);
}

export function changesField(beforeXml: string, afterXml: string): { changes: ParagraphChange[] } | null {
  const changes = summarizeDocxChanges(beforeXml, afterXml);
  return changes.length ? { changes } : null;
}
