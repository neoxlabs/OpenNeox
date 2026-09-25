import fs from 'fs/promises';
import { runWithFileLimit } from './fileLimiter.js';
import { withFileWriteLock } from './fileWriteLock.js';
import path from 'path';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { createEphemeralResult } from '@neoxlabs/kernel/core/types/toolResult.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { writeStallFile } from '@neoxlabs/kernel/utils/stallGuard.js';
import { safeReadFile, SafeReadError, type EncodingDetectionResult } from './safeReadFile.js';
import { countNormalizedMatches, normalizeMatchLine, recoverMatch, type FuzzyMatchResult } from './fuzzyMatcher.js';
import { findCoveringRead, invalidateReads, refreshReadsAfterWrite, checkCoherence, bumpWorkspaceEpoch, HISTORY_SEEN_RANGE_KEY } from '../smart-read/readLedger.js';


type CreateEditFileToolDeps = {
  resolveWorkspacePath: (requestedPath?: string) => string;
  formatDisplayPath: (absPath: string) => string;
};

type AppliedHunk = {
  startLine: number;
  oldLines: string[];
  newLines: string[];
  recovery?: { kind: FuzzyMatchResult['kind'] | 'tail_prefix'; similarity: number; mismatchCount: number };
  /** old_string 多处完全相同、没传 replace_all 却被整体应用了 —— 带上全部行号, 回执里要点名 */
  autoAll?: number[];
};

/** 改后各处的原文 (含上下各 2 行, 带行号, 总量封顶) —— 让模型不必再 readfile 复核。 */
function afterSnapshot(lines: string[], hunks: AppliedHunk[]): string {
  const MAX_LINES = 40;
  const blocks: string[] = [];
  let budget = MAX_LINES;
  /* 反序应用过, 行号已是改后的; 按行号升序摊出来 */
  for (const h of [...hunks].sort((a, b) => a.startLine - b.startLine)) {
    if (budget <= 0) { blocks.push('…'); break; }
    const from = Math.max(1, h.startLine - 2);
    const to = Math.min(lines.length, h.startLine + Math.max(h.newLines.length, 1) - 1 + 2);
    const take = Math.min(to - from + 1, budget);
    budget -= take;
    const rows = [];
    for (let n = from; n < from + take; n++) rows.push(`${n} │ ${lines[n - 1] ?? ''}`);
    blocks.push(rows.join('\n'));
  }
  return blocks.length ? ` 改后该区域 (不必再 readfile 复核):\n${blocks.join('\n┄┄┄\n')}` : '';
}

const AUTO_ALL_MIN_CHARS = 40;
const AUTO_ALL_MAX_MATCHES = 3;
function isDistinctiveOldString(oldString: string): boolean {
  return oldString.trim().length >= AUTO_ALL_MIN_CHARS;
}

const ANCHOR_STOPWORDS = new Set([
  'const', 'return', 'import', 'from', 'function', 'export', 'this', 'throw', 'Error', 'string', 'number',
  'true', 'false', 'null', 'undefined', 'async', 'await', 'class', 'interface', 'type', 'default', 'else',
  'void', 'private', 'public', 'static', 'readonly', 'boolean', 'object', 'require', 'module',
]);
/** 文件里含 old_string 标识符的行 —— 找不到时给模型的锚点, JSON 原样展示 (空白可见)。 */
function buildAnchorBlock(lines: string[], oldString: string, base: string): string {
  const idents = [...new Set((oldString.match(/[A-Za-z_$][A-Za-z0-9_$]{3,}/g) ?? []).filter(w => !ANCHOR_STOPWORDS.has(w)))];
  if (idents.length === 0) return `\n\n${base} 共 ${lines.length} 行。`;
  const scored = lines.map((l, i) => ({ n: i + 1, l, s: idents.reduce((a, w) => a + (l.includes(w) ? 1 : 0), 0) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || a.n - b.n)
    .slice(0, 12)
    .sort((a, b) => a.n - b.n);
  if (scored.length === 0) {
    return `\n\n${base} 共 ${lines.length} 行, 没有任何一行含 old_string 里的标识符 (${idents.slice(0, 5).join(', ')}) —— 你可能改错了文件。`;
  }
  return `\n\n${base} 共 ${lines.length} 行。下面是文件里含 old_string 中标识符的行 (JSON 原样, 空白可见) —— 直接照这些原文写 old_string, 不必先 readfile:\n`
    + scored.map(x => `${x.n} │ ${JSON.stringify(x.l)}`).join('\n');
}

const EDIT_FILE_MAX_HUNKS = 8;
const EDIT_FILE_MAX_SINGLE_TEXT_CHARS = 8_000;
// 前端 diff 走 Myers, 阈值可高; 超过才退化成 "[omitted ...]" 占位符 (占位符 hunk 禁 UI reject)。
const EDIT_FILE_MAX_PREVIEW_LINES = 5000;
const EDIT_FILE_MAX_PREVIEW_CHARS = 200_000;

function splitLinesPreserveEnding(text: string): {
  lines: string[];
  lineEnding: string;
  hasTrailingNewline: boolean;
} {
  const lineEnding = text.includes('\r\n') ? '\r\n' : '\n';
  const hasTrailingNewline = text.endsWith(lineEnding);
  const lines = text.split(/\r?\n/);
  if (hasTrailingNewline && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return { lines, lineEnding, hasTrailingNewline };
}

function buildPreviewText(kind: 'old' | 'new', lines: string[]): {
  text: string;
  truncated: boolean;
  lineCount: number;
  charCount: number;
} {
  const lineCount = lines.length;
  const rawText = lines.join('\n');
  const charCount = rawText.length;
  const oversized = lineCount > EDIT_FILE_MAX_PREVIEW_LINES || charCount > EDIT_FILE_MAX_PREVIEW_CHARS;
  if (!oversized) {
    return { text: rawText, truncated: false, lineCount, charCount };
  }
  return { text: `[omitted ${kind}: ${lineCount} lines, ${charCount} chars]`, truncated: true, lineCount, charCount };
}

/** UI 命脉: 3 个 normalizer + diff 卡片 + IndexedDB + LLM 压缩共同依赖这套字段名, 一个都不能改。 */
function buildOutputHunk(hunk: AppliedHunk): {
  start_line: number;
  old_line_count: number;
  new_line_count: number;
  old_preview: string;
  new_preview: string;
  old_preview_lines: number;
  new_preview_lines: number;
  old_preview_chars: number;
  new_preview_chars: number;
  preview_truncated: boolean;
} {
  const oldPreview = buildPreviewText('old', hunk.oldLines);
  const newPreview = buildPreviewText('new', hunk.newLines);
  return {
    start_line: hunk.startLine,
    old_line_count: hunk.oldLines.length,
    new_line_count: hunk.newLines.length,
    old_preview: oldPreview.text,
    new_preview: newPreview.text,
    old_preview_lines: oldPreview.lineCount,
    new_preview_lines: newPreview.lineCount,
    old_preview_chars: oldPreview.charCount,
    new_preview_chars: newPreview.charCount,
    preview_truncated: oldPreview.truncated || newPreview.truncated,
  };
}

interface RawHunk {
  old_string?: string;
  old?: string;
  new_string?: string;
  replace_all?: boolean;
  start_line?: number;
  end_line?: number;
  insert_after?: string;
  insert_before?: string;
  /** normalizeInsertHunk 打的标: 这条是插入 —— 锚点会一直存在, 幂等要看"锚点+内容"是否已在 */
  _insert?: true;
}

function normalizeInsertHunk(h: RawHunk): RawHunk {
  const after = typeof h.insert_after === 'string' ? h.insert_after : undefined;
  const before = typeof h.insert_before === 'string' ? h.insert_before : undefined;
  if (after === undefined && before === undefined) return h;
  if (typeof h.new_string !== 'string') return h; // 交给下面的 missing_new_string 闸报
  const anchor = (after ?? before)!.replace(/^\n+|\n+$/g, '');
  const body = h.new_string.replace(/^\n+|\n+$/g, '');
  if (!anchor.trim()) return h; // 空锚点没意义, 走常规路径报错
  return {
    ...h,
    _insert: true,
    old_string: anchor,
    new_string: after !== undefined ? `${anchor}\n${body}` : `${body}\n${anchor}`,
  };
}

const LEADING_WS = /^[ \t]*/;

function reindentToMatch(actualOld: string[], oldLines: string[], newLines: string[]): string[] {
  if (actualOld.length === 0 || actualOld.length !== oldLines.length) return newLines;

  for (let i = 0; i < actualOld.length; i++) {
    if (actualOld[i].trimStart() !== oldLines[i].trimStart()) return newLines;
  }

  const fileIndent = LEADING_WS.exec(actualOld[0])![0];
  const patternIndent = LEADING_WS.exec(oldLines[0])![0];
  if (fileIndent === patternIndent) return newLines;

  if (patternIndent === '') {
    /* 模式整体少了缩进 —— 给每行非空文本补回来 */
    return newLines.map((l) => (l.trim() === '' ? l : fileIndent + l));
  }
  if (fileIndent.startsWith(patternIndent)) {
    const extra = fileIndent.slice(patternIndent.length);
    return newLines.map((l) => (l.trim() === '' ? l : extra + l));
  }
  if (patternIndent.startsWith(fileIndent)) {
    const surplus = patternIndent.slice(fileIndent.length);
    return newLines.map((l) => (l.startsWith(surplus) ? l.slice(surplus.length) : l));
  }
  /* 缩进风格不同源 (tab vs space 混用之类) —— 不猜, 原样返回 */
  return newLines;
}

/** 在 lines 里定位 old_string 并把 targets 处替换成 newString。改 lines (原地), 返回应用了哪些 hunk 或错误。 */
function locateAndApply(
  lines: string[],
  oldString: string,
  newString: string,
  opts: {
    replaceAll: boolean;
    startHint?: number;
    targetPath: string;
    absPath: string;
    /** 一致性诊断结果 (见 readLedger.checkCoherence) — 只用在精确匹配失败之后 */
    coherence: { state: 'fresh' | 'stale' | 'unread'; entry?: { lineCount: number; readAtTurn: number; rangeKey?: string } };
  },
): { ok: true; applied: AppliedHunk[] } | { ok: false; error: string } {
  const newLines = splitLinesPreserveEnding(newString).lines;

  // 追加惯用法: old_string 为空 = 在文件末尾追加 new_string。
  if (oldString === '') {
    const startLine = lines.length + 1;
    /* 追加保留调用方给的换行语义: 末尾 `\n` 表示再多一个空行时用裸 split */
    const appendLines = newString.split(/\r?\n/);
    lines.push(...appendLines);
    return { ok: true, applied: [{ startLine, oldLines: [], newLines: appendLines }] };
  }

  const oldLines = splitLinesPreserveEnding(oldString).lines;
  const matches = countNormalizedMatches(lines, oldLines, 0, 50); // 1-based 行号

  if (matches.length === 0 && oldLines.length === 1 && oldString.trim() !== '') {
    const perLine = lines.map((l) => {
      let c = 0, from = 0;
      for (;;) {
        const at = l.indexOf(oldString, from);
        if (at < 0) break;
        c++; from = at + oldString.length;
      }
      return c;
    });
    const totalHits = perLine.reduce((a, b) => a + b, 0);
    if (totalHits > 0) {
      const hitLines1 = perLine.map((c, i) => (c > 0 ? i + 1 : 0)).filter(Boolean);
      let subTargets: number[];
      let subAutoAll: number[] | undefined;
      if (totalHits === 1 || opts.replaceAll) {
        subTargets = hitLines1;
      } else if (typeof opts.startHint === 'number') {
        const ranked = hitLines1
          .map((m) => ({ m, d: Math.abs(m - opts.startHint!) }))
          .sort((a, b) => a.d - b.d);
        if (ranked.length === 1 || ranked[1].d - ranked[0].d >= 5) subTargets = [ranked[0].m];
        else return { ok: false, error: ambiguityError(totalHits, opts, lines, hitLines1) };
      } else if (isDistinctiveOldString(oldString) && totalHits <= AUTO_ALL_MAX_MATCHES) {
        subTargets = hitLines1;
        subAutoAll = hitLines1;
      } else {
        return { ok: false, error: ambiguityError(totalHits, opts, lines, hitLines1) };
      }

      /* 反序应用: 行内替换可能把 1 行变成多行 (new_string 含换行), 后面的行号会移位 */
      const appliedSub: AppliedHunk[] = [];
      for (const line1 of [...subTargets].sort((a, b) => b - a)) {
        const idx = line1 - 1;
        const before = lines[idx];
        /* replaceAll 时同一行内的多次出现也要全换 (split/join 比正则安全: old_string 里可能有元字符) */
        const after = opts.replaceAll || perLine[idx] === 1
          ? before.split(oldString).join(newString)
          : before.replace(oldString, newString);
        if (after === before) continue;                       // 幂等
        const replacement = after.split(/\r?\n/);
        lines.splice(idx, 1, ...replacement);
        appliedSub.push({ startLine: line1, oldLines: [before], newLines: replacement, ...(subAutoAll ? { autoAll: subAutoAll } : {}) });
      }
      if (appliedSub.length > 0) return { ok: true, applied: appliedSub };
      return { ok: true, applied: [] };                        // 全都已经是目标内容
    }
  }

  if (matches.length === 0 && oldLines.length >= 2 && oldLines[oldLines.length - 1].trim().length >= 8) {
    const head = oldLines.slice(0, -1);
    const tail = oldLines[oldLines.length - 1];
    const tailTrim = tail.trimStart();
    const hits: number[] = [];
    for (let i = 0; i + head.length < lines.length; i++) {
      let ok = true;
      for (let j = 0; j < head.length; j++) {
        if (normalizeMatchLine(lines[i + j]) !== normalizeMatchLine(head[j])) { ok = false; break; }
      }
      if (!ok) continue;
      const fileTail = lines[i + head.length];
      if (fileTail.trimStart().startsWith(tailTrim) && fileTail.trimStart().length > tailTrim.length) hits.push(i + 1);
    }
    if (hits.length === 1) {
      const idx = hits[0] - 1;
      const actualOld = lines.slice(idx, idx + oldLines.length);
      const fileTail = actualOld[actualOld.length - 1];
      const remainder = fileTail.trimStart().slice(tailTrim.length);
      /* 把"模型抄到的那半行"当作末行去做缩进还原, 再把剩下半行接回去 */
      const seenOld = actualOld.slice(0, -1).concat([fileTail.slice(0, fileTail.length - remainder.length)]);
      const reindented = reindentToMatch(seenOld, oldLines, newLines);
      const out = [...reindented];
      if (out.length === 0) out.push(remainder);
      else out[out.length - 1] = out[out.length - 1] + remainder;
      lines.splice(idx, oldLines.length, ...out);
      return {
        ok: true,
        applied: [{ startLine: hits[0], oldLines: actualOld, newLines: out, recovery: { kind: 'tail_prefix', similarity: 1, mismatchCount: 0 } }],
      };
    }
  }

  if (matches.length === 0) {
    if (newString.trim().length >= 20 && newLines.some(l => l.trim() !== '')) {
      const already = countNormalizedMatches(lines, newLines, 0, 2);
      if (already.length >= 1) {
        writeStallFile('info', 'EDIT_STAT', 'edit ok: already_done', { file: opts.targetPath, coherence: opts.coherence.state, atLine: already[0] });
        return { ok: true, applied: [] };
      }
    }
    const coh = opts.coherence.state;

    /* fresh 之外一律不做内容层容错 —— 副本已经不可信, 任何"最像的一处"都只是猜。
     * (这也是删掉 similar 档的原因: 它当初存在的理由正是"文件可能已变 / 模型可能记错",
     *  而这两件事现在被诊断精确区分开了, 不需要用 0.85 这种校准出来的阈值去赌。) */
    const full = recoverMatch(lines, oldLines);
    const rec = coh === 'fresh' || ('match' in full && full.match?.kind === 'blank_insensitive')
      ? full
      : { nearest: 'nearest' in full ? full.nearest : undefined, reason: 'stale_copy' as const };

    if ('match' in rec && rec.match) {
      const m = rec.match;
      const idx = m.line - 1;
      const actualOld = m.actualLines;
      /* 模糊命中 ⇒ 匹配是 trim 过的, 必须把原文缩进套回去, 否则一次"改个词"的编辑
       * 会顺手把这一段的缩进抹平 (Python/YAML 直接崩)。 */
      const reindented = reindentToMatch(actualOld, oldLines, newLines);
      if (actualOld.join('\n') === reindented.join('\n')) {
        return { ok: true, applied: [] }; // 幂等
      }
      lines.splice(idx, actualOld.length, ...reindented);
      return {
        ok: true,
        applied: [{
          startLine: m.line,
          oldLines: actualOld,
          newLines: reindented,
          recovery: { kind: m.kind, similarity: m.similarity, mismatchCount: m.mismatchCount },
        }],
      };
    }

    /* 没能安全恢复 —— 按诊断结果给出**唯一一条明确的下一步**, 并把文件里真实的那段摊出来,
       让模型一次改对而不是盲目重读整文件。 */
    const near = rec.nearest;
    const nearBlock = near
      ? `\n\n文件里最接近的一段在第 ${near.line} 行 (相似度 ${(near.similarity * 100).toFixed(0)}%), 实际内容如下 (每行按 JSON 字符串原样展示, 空白可见):\n${near.actualLines.slice(0, 12).map((l, i) => `${near.line + i} │ ${JSON.stringify(l)}`).join('\n')}`
      : '';

    const base = path.basename(opts.absPath);
    /* 最接近的一段不够像 (或压根没有) 时, 再给一组锚点行 —— 模型下一发就能照抄, 省掉 readfile 那一轮 */
    const anchorBlock = (!near || near.similarity < 0.6) ? buildAnchorBlock(lines, oldString, base) : '';
    let summary: string;
    let errorCode: string;
    let hint: string;

    if (coh === 'unread') {
      summary = `Cannot edit ${base}: you haven't read this file yet`;
      errorCode = 'file_not_read';
      hint = `本会话还没读过 ${base}, 所以 old_string 不是抄来的, 文件里没有这段。照下面摊出来的真实原文写 old_string; 要改的范围更大就先 readfile("${opts.targetPath}")。`;
    } else if (coh === 'stale') {
      const was = opts.coherence.entry;
      errorCode = 'stale_read';
      if (was?.rangeKey === HISTORY_SEEN_RANGE_KEY) {
        /* 会话从历史恢复 (应用重启过): 你读过它, 但证明不了手里那份还是当前版本 */
        summary = `Cannot edit ${base}: your earlier copy may be outdated`;
        hint = `你在本会话较早时读过/写过 ${base}, 但之后应用重启过, 无法确认你记得的内容还是磁盘上的当前版本 —— old_string 跟文件对不上。`
          + ` 照下面摊出来的真实原文写 old_string; 要改的范围更大就先 readfile("${opts.targetPath}")。`;
      } else {
        summary = `Cannot edit ${base}: file changed since you read it`;
        hint = `${base} 在你读过之后被改动过${was && was.lineCount > 0 ? ` (你当时看到 ${was.lineCount} 行)` : ''} —— 可能是 linter / 格式化 / 另一个进程 / 你自己上一次编辑。`
          + ` 你手里的副本已经不是当前版本, 请 readfile("${opts.targetPath}") 重读后用新内容再编辑。`;
      }
    } else {
      summary = `String to replace not found in ${base}`;
      errorCode = 'string_not_found';
      hint = rec.reason === 'ambiguous'
        ? `old_string 有多处长得都很像, 无法确定改哪一处 —— 请在 old_string 里多带几行上下文让它唯一。`
        : `你读过 ${base} 且文件没变, 所以是 old_string 抄得跟文件不一致 (空白/缩进/引号/漏字)。`
          + ` old_string 必须跟文件逐字符一致(含前导缩进) —— 照下面的实际内容重发即可, 不必重读整个文件。`;
    }

    const editStat = {
      file: opts.targetPath,
      coherence: coh,
      errorCode,
      oldStringLines: oldLines.length,
      nearestSimilarity: near ? Number(near.similarity.toFixed(3)) : null,
    };
    writeStallFile('info', 'EDIT_STAT', `edit failed: ${errorCode}`, editStat);
    cliLogger.info('EDIT_FILE', `edit failed: ${errorCode}`, editStat);

    return {
      ok: false,
      error: JSON.stringify(createEphemeralResult('edit', 'error', summary, {
        file_path: opts.absPath,
        error: errorCode,
        verify_hint: hint + nearBlock + anchorBlock,
        metadata: {
          coherence: coh,
          ...(near ? { nearest_line: near.line, nearest_similarity: near.similarity } : {}),
        },
        guidance: true,
      })),
    };
  }

  let targets: number[];
  let autoAll: number[] | undefined;
  if (matches.length === 1 || opts.replaceAll) {
    targets = matches;
  } else if (typeof opts.startHint === 'number') {
    // 有行号 hint: 取最近的一处, 但要求明显更近 (次优至少远 5 行) 才敢用, 否则判歧义。
    const ranked = matches.map((m) => ({ m, d: Math.abs(m - opts.startHint!) })).sort((a, b) => a.d - b.d);
    if (ranked.length === 1 || ranked[1].d - ranked[0].d >= 5) {
      targets = [ranked[0].m];
    } else {
      return { ok: false, error: ambiguityError(matches.length, opts, lines, matches) };
    }
  } else if (isDistinctiveOldString(oldString) && matches.length <= AUTO_ALL_MAX_MATCHES) {
    /* 见文件头「零编辑失败」③: 长而完全相同的多处 → 全应用, 回执点名 */
    targets = matches;
    autoAll = matches;
  } else {
    return { ok: false, error: ambiguityError(matches.length, opts, lines, matches) };
  }

  // 反序应用, 保持前面的行号在 splice 后不失效。
  const applied: AppliedHunk[] = [];
  for (const line1 of [...targets].sort((a, b) => b - a)) {
    const idx = line1 - 1;
    const actualOld = lines.slice(idx, idx + oldLines.length); // 真被替换的原文 (给 diff 预览)
    /* 同上: 命中可能来自 trim 过的比较器, 缩进要按原文还原再写回 */
    const reindented = reindentToMatch(actualOld, oldLines, newLines);
    if (actualOld.join('\n') === reindented.join('\n')) continue; // 幂等: 已经是目标内容, 跳过
    lines.splice(idx, oldLines.length, ...reindented);
    applied.push({ startLine: line1, oldLines: actualOld, newLines: reindented, ...(autoAll ? { autoAll } : {}) });
  }
  return { ok: true, applied };
}

function ambiguityError(
  count: number,
  opts: { targetPath: string; absPath: string },
  lines: string[],
  matchLines: number[],
): string {
  const where = matchLines.slice(0, 6).map((n) => {
    const here = `${n} │ ${JSON.stringify(lines[n - 1] ?? '')}`;
    const next = lines[n] !== undefined ? `\n${n + 1} │ ${JSON.stringify(lines[n])}` : '';
    return here + next;
  }).join('\n…\n');
  writeStallFile('info', 'EDIT_STAT', 'edit failed: ambiguous_match', { file: opts.targetPath, errorCode: 'ambiguous_match', count });
  return JSON.stringify(createEphemeralResult('edit', 'error',
    `Found ${count} matches of old_string in ${path.basename(opts.absPath)}, but replace_all is false`, {
      file_path: opts.absPath,
      error: 'ambiguous_match',
      verify_hint: `old_string 在文件里出现 ${count} 次 (第 ${matchLines.slice(0, 6).join(', ')} 行)。要么: (1) 传 start_line=<行号> 指明改哪一处; (2) 在 old_string 里多带一行上下文让它唯一; (3) 想全替换就传 replace_all=true。各处原文:\n${where}`,
      metadata: { match_lines: matchLines.slice(0, 20) },
      /* 多处匹配同样是"给了下一步、模型自己改" —— 不弹红卡 */
      guidance: true,
    }));
}

export function createEditFileTool({ resolveWorkspacePath, formatDisplayPath: _formatDisplayPath }: CreateEditFileToolDeps): Tool {
  return {
    name: 'edit_file',
    description: `Edit an EXISTING file by replacing exact text (content-addressed, like a precise find-and-replace).

⚠️ ERRORS if the file does not exist — use write_file to create new files.
⚠️ readfile the file first so you know its exact current content.

edit_file(file_path, old_string, new_string):
- old_string = the EXACT text to replace, copied verbatim from the file (including indentation/whitespace). No line numbers.
- new_string = the replacement. REQUIRED — every call must carry it, even when it is empty.
  Leaving the field out is an error, NOT a deletion: the call is rejected and nothing is written.
  To DELETE the matched text, pass new_string: "" explicitly.
- old_string must uniquely identify ONE location. If it appears multiple times: add surrounding context to old_string to make it unique, or pass replace_all=true to replace every occurrence.
- To APPEND at end of file: old_string="" (empty), new_string=<text to append>.
- To INSERT next to an existing line (add an import, a case, a line at the end of a function): pass insert_after=<an existing line, copied verbatim> (or insert_before) + new_string=<what to insert>. No need to copy surrounding context.
- Lines you have seen in search results count as read — copy them verbatim as old_string; you do not have to readfile first.
- Multiple edits in one file: pass hunks=[{old_string, new_string, replace_all?} | {insert_after|insert_before, new_string}, ...] (applied in order).
- Long unchanged middle? You may elide it: put the first few lines, a line containing only \`...\` (or \`// ...\`), then the last few lines. The head and tail must each be unique in the file. Everything between them is kept as-is and included in what gets replaced.
- If old_string is very slightly off (a drifted comment, a blank line, one changed line), the edit still lands on the closest unique location and the result says so — but exact text is always faster and safer, so copy verbatim when you can.

Prefer edit_file over write_file for changes to existing files — it only touches the changed text and preserves the rest.`,
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the file to edit' },
        old_string: { type: 'string', description: 'Exact text to replace, copied verbatim from the file (with original indentation). Empty string "" means append new_string at end of file.', maxLength: EDIT_FILE_MAX_SINGLE_TEXT_CHARS },
        /* required 里没法表达 "(old_string+new_string) 或 hunks 二选一", 所以 new_string
         * 的必填在运行时校验 (见上面 missing_new_string), 这里靠描述把话说死。 */
        new_string: { type: 'string', description: 'Replacement text. Required — omitting this field is rejected as an error, it does NOT mean delete. To delete, pass "" explicitly.', maxLength: EDIT_FILE_MAX_SINGLE_TEXT_CHARS },
        replace_all: { type: 'boolean', description: 'Replace every occurrence of old_string (default false — errors if old_string is not unique).' },
        start_line: { type: 'number', description: 'Optional hint: if old_string appears multiple times, prefer the match nearest this line.' },
        insert_after: { type: 'string', description: 'Insert new_string right after this existing line (copied verbatim from the file). Use instead of old_string when adding code next to a known line.', maxLength: EDIT_FILE_MAX_SINGLE_TEXT_CHARS },
        insert_before: { type: 'string', description: 'Insert new_string right before this existing line (copied verbatim from the file).', maxLength: EDIT_FILE_MAX_SINGLE_TEXT_CHARS },
        hunks: {
          type: 'array',
          description: 'Multiple edits in one file, applied in order. Each: { old_string, new_string, replace_all? } or { insert_after | insert_before, new_string }.',
          maxItems: EDIT_FILE_MAX_HUNKS,
          items: {
            type: 'object',
            properties: {
              old_string: { type: 'string', maxLength: EDIT_FILE_MAX_SINGLE_TEXT_CHARS },
              new_string: { type: 'string', maxLength: EDIT_FILE_MAX_SINGLE_TEXT_CHARS },
              replace_all: { type: 'boolean' },
              insert_after: { type: 'string', maxLength: EDIT_FILE_MAX_SINGLE_TEXT_CHARS },
              insert_before: { type: 'string', maxLength: EDIT_FILE_MAX_SINGLE_TEXT_CHARS },
            },
          },
        },
        // Hidden aliases still accepted.
        path: { type: 'string' },
        filePath: { type: 'string' },
        file: { type: 'string' },
        end_line: { type: 'number' },
      },
      required: ['file_path'],
    },
    async function(args) {
      const targetPath = args.file_path || args.path || args.filePath || args.file;
      if (!targetPath) {
        return JSON.stringify(createEphemeralResult('edit', 'error', 'Missing required parameter: file_path', { error: 'file_path is required' }));
      }

      const absPath = resolveWorkspacePath(targetPath);

      // 读盘 (编码感知 + 二进制拒绝 + 不存在引导 write_file)。
      let originalContent: string;
      let originalEncoding: EncodingDetectionResult | undefined;
      try {
        const readResult = await safeReadFile(absPath);
        originalContent = readResult.content;
        originalEncoding = readResult.encoding;
      } catch (err) {
        if (err instanceof SafeReadError && err.reason === 'binary') {
          return JSON.stringify(createEphemeralResult('edit', 'error', `Binary file cannot be edited: ${targetPath}`, {
            file_path: absPath, error: 'binary_file',
          }));
        }
        return JSON.stringify(createEphemeralResult('edit', 'error', `File does not exist: ${targetPath}`, {
          file_path: absPath,
          error: `The file "${targetPath}" does not exist on disk, so edit_file cannot modify it. edit_file ONLY works on existing files.`,
          verify_hint: `To create this file, call write_file({ file_path: "${absPath}", content: "<full content>" }) instead. Do NOT retry edit_file on this path.`,
          metadata: { next_action: { tool: 'write_file', reason: 'Target file does not exist — use write_file', args: { file_path: absPath } } },
        }));
      }

      const { lines: fileLines, lineEnding, hasTrailingNewline } = splitLinesPreserveEnding(originalContent);

      // 收集 hunk: 单 edit 或 hunks[] 数组。
      const rawHunks: RawHunk[] = Array.isArray(args.hunks) && args.hunks.length > 0
        ? args.hunks
        : [{ old_string: args.old_string, old: args.old, new_string: args.new_string, replace_all: args.replace_all, start_line: args.start_line, end_line: args.end_line, insert_after: args.insert_after, insert_before: args.insert_before }];

      if (rawHunks.length > EDIT_FILE_MAX_HUNKS) {
        return JSON.stringify(createEphemeralResult('edit', 'error', `Too many hunks (${rawHunks.length} > ${EDIT_FILE_MAX_HUNKS})`, {
          file_path: absPath, error: 'too_many_hunks',
        }));
      }

      const updatedLines = fileLines.slice();
      const appliedHunks: AppliedHunk[] = [];

      /* 一致性诊断 —— 只在精确匹配失败时才被用到 (见 locateAndApply 里的大段注释)。
       * 这里 stat 一次是因为 hunk 循环里可能多次用到, 且 stat 本身微秒级;
       * 真正的"零开销"体现在: 精确命中时这个值压根不参与任何判断。 */
      let coherence: { state: 'fresh' | 'stale' | 'unread'; entry?: { lineCount: number; readAtTurn: number; rangeKey?: string } } = { state: 'unread' };
      try {
        const st = await fs.stat(absPath);
        coherence = checkCoherence(absPath, st.mtimeMs, st.size);
      } catch { /* stat 不了就当没读过, 报错文案仍然可执行 */ }

      for (const rawHunk of rawHunks) {
        const h = normalizeInsertHunk(rawHunk);
        // old_string 解析: 直接给 → 用; 否则从 readLedger 按行号桥接 (模型读过什么, 切那段当 old_string)。
        let oldString: string | undefined;
        if (typeof h.old_string === 'string') oldString = h.old_string;
        else if (typeof h.old === 'string') oldString = h.old;
        else if (typeof h.start_line === 'number') {
          const start = h.start_line;
          const end = typeof h.end_line === 'number' ? h.end_line : start;
          const entry = findCoveringRead(absPath, start, end);
          if (!entry) {
            return JSON.stringify(createEphemeralResult('edit', 'error',
              `No old_string given, and no prior readfile of ${path.basename(absPath)} covers lines ${start}-${end}`, {
                file_path: absPath, error: 'need_old_string',
                verify_hint: `传 old_string (要替换的原文), 或先 readfile("${targetPath}") 让我知道你看到的是什么再编辑。`,
              }));
          }
          const entryLines = entry.content.split(/\r?\n/);
          const from = start - entry.startLine;
          const to = end - entry.startLine + 1;
          if (from < 0 || to > entryLines.length || from >= to) {
            return JSON.stringify(createEphemeralResult('edit', 'error',
              `Line range ${start}-${end} is outside the region you last read`, {
                file_path: absPath, error: 'range_outside_read',
                verify_hint: `传 old_string, 或 readfile("${targetPath}", start_line=${start}) 重读那段再编辑。`,
              }));
          }
          oldString = entryLines.slice(from, to).join('\n');
        } else {
          return JSON.stringify(createEphemeralResult('edit', 'error', 'Missing old_string', {
            file_path: absPath, error: 'missing_old_string',
            verify_hint: `传 old_string (要替换的原文, 逐字符照抄) + new_string (替换成什么)。`,
          }));
        }

        if (typeof h.new_string !== 'string') {
          return JSON.stringify(createEphemeralResult('edit', 'error', 'Missing new_string', {
            file_path: absPath, error: 'missing_new_string',
            verify_hint: `这次调用没有 new_string 字段。传 new_string (替换成什么); 确实要删除这段就显式传 new_string: ""。`,
          }));
        }
        const newString = h.new_string;
        if (oldString === newString) continue; // 这条无改动
        /* 插入的幂等不能靠 old 不在 (锚点永远在): "锚点+内容"已经连着出现 → 已插过, 跳过 */
        if (h._insert && countNormalizedMatches(updatedLines, splitLinesPreserveEnding(newString).lines, 0, 1).length > 0) continue;

        const res = locateAndApply(updatedLines, oldString, newString, {
          replaceAll: h.replace_all === true,
          startHint: h.start_line,
          targetPath,
          absPath,
          coherence,
        });
        if (!res.ok) return res.error;
        appliedHunks.push(...res.applied);
      }

      if (appliedHunks.length === 0) {
        return JSON.stringify(createEphemeralResult('edit', 'already_done', 'No changes needed (file already matches)', {
          file_path: absPath, metadata: { total_lines: hasTrailingNewline ? Math.max(fileLines.length, 0) : fileLines.length },
        }));
      }

      // 写盘 (保留 BOM + 行尾; per-file 写锁 + 共享 FD 上限)。
      if (hasTrailingNewline) updatedLines.push('');
      const newContent = updatedLines.join(lineEnding);
      await withFileWriteLock(absPath, async () => {
        if (originalEncoding?.encoding === 'utf-8-bom') {
          const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
          await runWithFileLimit(() => fs.writeFile(absPath, Buffer.concat([bom, Buffer.from(newContent, 'utf-8')])));
        } else {
          await runWithFileLimit(() => fs.writeFile(absPath, newContent, 'utf-8'));
        }
      });

      try {
        const st = await fs.stat(absPath);
        refreshReadsAfterWrite(absPath, newContent, st.mtimeMs, st.size, 0, originalContent);
      } catch {
        invalidateReads(absPath);   // stat 失败 → 退回保守的作废
      }
      bumpWorkspaceEpoch(absPath, newContent);

      appliedHunks.sort((a, b) => a.startLine - b.startLine);
      const firstHunk = appliedHunks[0];
      const outputHunks = appliedHunks.map(buildOutputHunk);
      const finalTotalLines = hasTrailingNewline ? Math.max(updatedLines.length - 1, 0) : updatedLines.length;


      /* 走过内容层容错的, 必须在摘要里说清楚 —— old_string 跟文件不完全一致但我们按最像的
         那一处改了, 模型有权知道并复核 (不能装作精确命中)。 */
      const recovered = appliedHunks.filter(h => h.recovery);

      /* 成功也要记 —— 没有分母就算不出失败率。带上是否走了模糊恢复, 以便分开统计
         "一次就对" 和 "靠容错救回来"。走 writeStallFile: 桌面端 cliLogger 不落盘。 */
      const okStat = {
        file: targetPath,
        coherence: coherence.state,
        hunks: appliedHunks.length,
        firstLine: firstHunk.startLine,
        recovered: recovered.length,
        recoveryKinds: recovered.map(h => h.recovery!.kind),
      };
      writeStallFile('info', 'EDIT_STAT', `edit ok: ${appliedHunks.length} replacement(s)`, okStat);
      cliLogger.info('EDIT_FILE', `${appliedHunks.length} replacement(s) applied`, okStat);
      const recoveryNote = recovered.length > 0
        ? ` ⚠️ ${recovered.length} 处 old_string 与文件不完全一致, 已按最接近的位置应用 (`
          + recovered.map(h => `第${h.startLine}行: ${h.recovery!.kind}, 相似度${(h.recovery!.similarity * 100).toFixed(0)}%, ${h.recovery!.mismatchCount}行不符`).join('; ')
          + ')'
        : '';
      const blanked = appliedHunks.filter(h =>
        h.oldLines.some(l => l.trim() !== '') && h.newLines.every(l => l.trim() === ''));
      const autoAllLines = [...new Set(appliedHunks.flatMap(h => h.autoAll ?? []))].sort((a, b) => a - b);
      const autoAllNote = autoAllLines.length > 0
        ? ` ⚠️ old_string 在文件里出现 ${autoAllLines.length} 次且完全相同 (第 ${autoAllLines.join(', ')} 行), 没传 replace_all 也已全部替换 —— 若只该改其中一处, 用 edit 把另一处改回。`
        : '';
      const blankNote = blanked.length > 0
        ? ` ⚠️ ${blanked.length} 处把非空内容替换成了纯空白 (`
          + blanked.map(h => `第${h.startLine}行: 删掉了 ${JSON.stringify(h.oldLines.join('\n')).slice(0, 80)}`).join('; ')
          + ') —— 若非本意, 用现在的空白行作 old_string 补回。'
        : '';

      return JSON.stringify(createEphemeralResult('edit', 'success',
        `Edited ${path.basename(absPath)}: ${appliedHunks.length} replacement(s) at line ${firstHunk.startLine}${recoveryNote}${autoAllNote}${blankNote}`, {
          file_path: absPath,
          verify_hint: (recovered.length > 0
            ? `⚠️ 本次有 ${recovered.length} 处走了模糊恢复, 请核对下面改后的原文是否落在你想改的位置。`
            : '改动已落盘。')
            + afterSnapshot(updatedLines, appliedHunks),
          metadata: {
            mode: 'content_addressed',
            ...(recovered.length > 0 ? {
              fuzzy_recovered: recovered.map(h => ({
                start_line: h.startLine,
                kind: h.recovery!.kind,
                similarity: Number(h.recovery!.similarity.toFixed(3)),
                mismatch_lines: h.recovery!.mismatchCount,
              })),
            } : {}),
            replacements: appliedHunks.length,
            start_line: firstHunk.startLine,
            old_lines: firstHunk.oldLines.length,
            new_lines: firstHunk.newLines.length,
            total_lines: finalTotalLines,
            hunks: outputHunks,
            preview_truncated: outputHunks.some((h) => h.preview_truncated),
          },
        }));
    },
  };
}
