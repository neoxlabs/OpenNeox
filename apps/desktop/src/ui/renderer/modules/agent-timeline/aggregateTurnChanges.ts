/**
 * aggregateTurnChanges — 把一轮 (user message → 现在) 的文件改动聚合成 turn_summary.
 *
 * ## WriteLedger 定型架构 (2026-07)
 *
 * **会员资格 SSOT = WriteDeclaration**（工具成功声明 / shell output_files / shell_proc）.
 * Timeline entries 只 **enrich** hunks / 行数; **FS 时间窗永不决定 membership**.
 *
 * 耐持久化: 优先从本轮 timeline entries 回放声明 (`extractWriteDeclarationsFromTimelineEntries`);
 * 可选传入 `declarations`（测试 / live ledger 合并）.
 *
 * ## 一"轮" (turn) 定义
 *   - 起点 = 最近一条真实 user_message (排除 background-task / continuation 启发式)
 *   - 终点 = 末条 entry ts
 */

import type { TimelineEntry } from '../../utils/workspaceUtils';
import { isPseudoEllipsisPath, resolveWorkspacePath } from '../../utils/pathUtils';
import {
  foldWriteDeclarations,
  type WriteDeclaration,
} from '@neoxlabs/kernel/core/writeLedger.js';
import { extractWriteDeclarationsFromTimelineEntries } from './turnWriteDeclarations';
import { editHunkLines } from './editHunkLines';
import { isBusEventMessage } from './cells/systemMessageParsers';

export interface TurnChange {
  path: string;
  op: 'edit' | 'write' | 'delete' | 'rename';
  addCount: number;
  delCount: number;
  /** 行数**取不到**(shell heredoc / 外部进程写的文件, 没有 diff hunks).
   *  与 "确实改了 0 行" 是两回事 —— UI 必须显示 "—" 而不是 +0 −0. */
  statsUnknown?: boolean;
  changedLines?: Array<{ start: number; end: number; kind: 'add' | 'del' | 'modify' }>;
  from?: string;
  /** edit hunks 原始数据 — 给 viewer 跑 Monaco DiffEditor 用. 只在有匹配 edit_file/write_file
   *  entry 时填. shell 产物没有. */
  editHunks?: Array<{
    oldString?: string;
    newString?: string;
    startLine?: number;
    oldLineCount?: number;
    newLineCount?: number;
    oldCharCount?: number;
    newCharCount?: number;
    previewTruncated?: boolean;
  }>;
  /** write_file / file_stream 的完整新文件内容, viewer 兜底用. */
  fallbackContent?: string;
  /** op='write' 但这一轮第一次写它时文件**已经存在** (整文件改写, 不是新建)。
   *  依据: 覆盖前存了快照 (previousSnapshotId) 或工具回执 "File updated" */
  overwrote?: boolean;
}

function normalizeWriteContent(content: string): { text: string; lineCount: number } {
  if (!content) return { text: '', lineCount: 0 };
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return { text: lines.join('\n'), lineCount: lines.length };
}

export interface TurnSummary {
  turnId: string;          /* user_message entry id (相对稳定) */
  turnStartTs: number;
  turnEndTs: number;
  changes: TurnChange[];
  totalFiles: number;
  totalAdds: number;
  totalDels: number;
}

function isInternalUserMessage(entry: TimelineEntry): boolean {
  if (entry.type !== 'user_message') return false;
  const source = (entry as any).messageSource;
  if (source === 'system-background-task') return true;
  const text = String((entry as any).detail ?? (entry as any).content ?? '').trim();
  return isBusEventMessage(text);
}

function isContinuationPrompt(entry: TimelineEntry): boolean {
  const text = String((entry as any).detail ?? (entry as any).content ?? '').trim();
  const compact = text
    .toLowerCase()
    .replace(/[。！？!?.\s]+/g, '');
  return [
    '继续', '继续吧', '接着', '接着来', '接着做', '继续做', '继续修', '继续改',
    'continue', 'goon', 'resume',
  ].includes(compact);
}

/** 判断 entry 是否产文件 · 用于 continuation 起点回溯启发式. */
function isFileChangeEntry(entry: TimelineEntry): boolean {
  if (entry.type === 'edit_file' && entry.editFilePath && entry.success !== false && entry.level !== 'error') return true;
  if (entry.type === 'file_stream' && entry.success !== false) return true;
  if (entry.type === 'tool_result' && entry.success !== false) {
    return entry.toolName === 'write_file'
      || entry.toolName === 'delete_file'
      || entry.toolName === 'rename_file'
      || entry.toolName === 'move_file'
      || entry.toolName === 'create_slides';
  }
  return false;
}

function findPreviousRealUserMessageIdx(entries: TimelineEntry[], beforeIdx: number): number {
  for (let i = beforeIdx; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.type === 'user_message' && !isInternalUserMessage(entry)) return i;
  }
  return -1;
}

function findTurnStartUserMessageIdx(entries: TimelineEntry[]): number {
  const latest = findPreviousRealUserMessageIdx(entries, entries.length - 1);
  if (latest < 0) return -1;
  const latestEntry = entries[latest]!;
  if (!isContinuationPrompt(latestEntry)) return latest;
  const previous = findPreviousRealUserMessageIdx(entries, latest - 1);
  if (previous < 0) return latest;
  const hadFileChangesBeforeContinuation = entries
    .slice(previous + 1, latest)
    .some(isFileChangeEntry);
  return hadFileChangesBeforeContinuation ? previous : latest;
}

/** 行数 · 兼容尾巴 \n. */
function lineCountOf(s: string | undefined): number {
  if (!s) return 0;
  const parts = s.split('\n');
  return parts.length > 1 && parts[parts.length - 1] === '' ? parts.length - 1 : parts.length;
}

function splitHunkLines(value?: string): string[] {
  if (!value) return [];
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function compactLineRanges(lines: number[]): Array<{ start: number; end: number; kind: 'add' }> {
  if (lines.length === 0) return [];
  const sorted = Array.from(new Set(lines)).sort((a, b) => a - b);
  const ranges: Array<{ start: number; end: number; kind: 'add' }> = [];
  let start = sorted[0]!;
  let end = start;
  for (let i = 1; i < sorted.length; i++) {
    const n = sorted[i]!;
    if (n === end + 1) end = n;
    else {
      ranges.push({ start, end, kind: 'add' });
      start = end = n;
    }
  }
  ranges.push({ start, end, kind: 'add' });
  return ranges;
}

function preciseChangedRangesFromHunk(h: { oldString?: string; newString?: string; startLine?: number; newLineCount?: number }): Array<{ start: number; end: number; kind: 'add' }> {
  const startLine = Math.max(1, h.startLine ?? 1);
  const declaredNewCount = Number.isFinite(Number(h.newLineCount)) ? Math.max(0, Number(h.newLineCount)) : undefined;
  const oldLines = splitHunkLines(h.oldString);
  const newLines = splitHunkLines(h.newString);

  if (newLines.length === 0) return [];
  if (oldLines.length === 0) {
    const count = declaredNewCount && declaredNewCount < newLines.length ? declaredNewCount : newLines.length;
    return count > 0 ? [{ start: startLine, end: startLine + count - 1, kind: 'add' }] : [];
  }

  let prefix = 0;
  const maxPrefix = Math.min(oldLines.length, newLines.length);
  while (prefix < maxPrefix && oldLines[prefix] === newLines[prefix]) prefix++;
  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (oldEnd >= prefix && newEnd >= prefix && oldLines[oldEnd] === newLines[newEnd]) {
    oldEnd--;
    newEnd--;
  }
  const oldMid = oldLines.slice(prefix, oldEnd + 1);
  const newMid = newLines.slice(prefix, newEnd + 1);
  if (newMid.length === 0) return [];
  if (oldMid.length === 0 || oldMid.length * newMid.length > 40_000) {
    const count = declaredNewCount && declaredNewCount < newMid.length ? declaredNewCount : newMid.length;
    return count > 0 ? [{ start: startLine + prefix, end: startLine + prefix + count - 1, kind: 'add' }] : [];
  }

  const dp: number[][] = Array.from({ length: oldMid.length + 1 }, () => Array(newMid.length + 1).fill(0));
  for (let i = oldMid.length - 1; i >= 0; i--) {
    for (let j = newMid.length - 1; j >= 0; j--) {
      dp[i]![j] = oldMid[i] === newMid[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const matchedNew = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < oldMid.length && j < newMid.length) {
    if (oldMid[i] === newMid[j]) { matchedNew.add(j); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  let changed = newMid.map((_, idx) => idx).filter(idx => !matchedNew.has(idx));
  /* 替换块不要按 declaredNewCount slice — 会把 +2−1 收成只标 1 行绿 */
  if (
    oldMid.length === 0
    && declaredNewCount !== undefined
    && declaredNewCount > 0
    && changed.length > declaredNewCount * 2
  ) {
    changed = changed.slice(0, declaredNewCount);
  }
  return compactLineRanges(changed.map(idx => startLine + prefix + idx));
}

/** 从 edit_file entry 提 changedLines + add/del. */
function extractEditChangedLines(entry: TimelineEntry): {
  changedLines: TurnChange['changedLines'];
  addCount: number;
  delCount: number;
} {
  const out: Array<{ start: number; end: number; kind: 'add' | 'del' | 'modify' }> = [];
  let addCount = 0;
  let delCount = 0;
  const hunks = (entry.editHunks && entry.editHunks.length > 0)
    ? entry.editHunks
    : (entry.editStartLine && entry.editNewString)
      ? [{ startLine: entry.editStartLine, oldString: entry.editOldString, newString: entry.editNewString }]
      : [];
  for (const h of hunks) {
    const start = h.startLine ?? 1;
    const newLn = Number.isFinite(Number((h as any).newLineCount))
      ? Math.max(0, Number((h as any).newLineCount))
      : lineCountOf(h.newString);
    const oldLn = Number.isFinite(Number((h as any).oldLineCount))
      ? Math.max(0, Number((h as any).oldLineCount))
      : lineCountOf(h.oldString);
    if (newLn > 0) {
      const precise = preciseChangedRangesFromHunk({
        oldString: h.oldString, newString: h.newString, startLine: start, newLineCount: newLn,
      });
      if (precise.length > 0) out.push(...precise);
      else out.push({ start, end: Math.max(start, start + newLn - 1), kind: 'add' });
    }
    if (oldLn > 0) out.push({ start, end: start, kind: 'del' });
    const complete = newLn === lineCountOf(h.newString) && oldLn === lineCountOf(h.oldString);
    const d = complete ? editHunkLines(h.oldString ?? '', h.newString ?? '', start) : null;
    addCount += d ? d.add : newLn;
    delCount += d ? d.del : oldLn;
  }
  return { changedLines: out.length > 0 ? out : undefined, addCount, delCount };
}

function canonicalPath(rawPath: string, workspacePath?: string): string {
  if (!rawPath) return rawPath;
  if (isPseudoEllipsisPath(rawPath)) return rawPath.replace(/^\.\.\.\//, '…/');
  return resolveWorkspacePath(rawPath, workspacePath);
}

interface EntryEnrichmentIndex {
  edits: Map<string, TimelineEntry[]>;
  writes: Map<string, TimelineEntry>;
  renames: Array<{ from: string; to: string; ts: number }>;
  /** 这一轮**第一次**写到该路径时, 文件是否已存在 (true = 改写已有文件) */
  firstWriteOverwrote: Map<string, boolean>;
}

/* write_file 覆盖已有文件: 工具先存原内容快照, 回执写 "File updated" (见 core writeFileTool) */
function writeEntryOverwrote(e: TimelineEntry): boolean {
  if (e.previousSnapshotId || e.overwroteExisting) return true;
  const out = (e as { output?: unknown }).output;
  return typeof out === 'string' && /File updated:|"action"\s*:\s*"updated"/.test(out);
}

function buildEntryEnrichmentIndex(entries: TimelineEntry[], workspacePath?: string): EntryEnrichmentIndex {
  const edits = new Map<string, TimelineEntry[]>();
  const writes = new Map<string, TimelineEntry>();
  const renames: Array<{ from: string; to: string; ts: number }> = [];
  const firstWriteOverwrote = new Map<string, boolean>();
  /* file_stream 和随后的 tool_result 是同一次写的两条 —— 同一路径只认第一条出现的结论,
   * 先建后又整体重写的仍算新建 */
  const writeCount = new Map<string, number>();
  const noteWrite = (p: string, e: TimelineEntry) => {
    const n = (writeCount.get(p) ?? 0) + 1;
    writeCount.set(p, n);
    const over = writeEntryOverwrote(e);
    if (n === 1) firstWriteOverwrote.set(p, over);
    else if (n === 2 && over && e.type === 'tool_result' && writes.get(p)?.type === 'file_stream') {
      /* 第一次写是流式那条 (没带回执), 紧跟着的回执才说是改写 —— 这一对算同一次写 */
      firstWriteOverwrote.set(p, true);
    }
  };
  for (const e of entries) {
    if (e.type === 'edit_file' && e.editFilePath && e.success !== false && e.level !== 'error') {
      const p = canonicalPath(e.editFilePath, workspacePath);
      const arr = edits.get(p) ?? [];
      arr.push(e);
      edits.set(p, arr);
      continue;
    }
    if (e.type === 'file_stream' && e.success !== false) {
      const raw = (e as any).filePath || e.targetPath || e.editFilePath;
      if (raw) {
        const p = canonicalPath(raw, workspacePath);
        noteWrite(p, e);
        writes.set(p, e);
      }
      continue;
    }
    if (e.type === 'tool_result' && e.success !== false) {
      const args = (e.toolArgs || {}) as Record<string, unknown>;
      if (e.toolName === 'write_file') {
        const raw = args.file_path || args.filePath || args.path || e.targetPath;
        if (typeof raw === 'string') {
          const p = canonicalPath(raw, workspacePath);
          noteWrite(p, e);
          writes.set(p, e);
        }
        continue;
      }
      if (e.toolName === 'rename_file' || e.toolName === 'move_file') {
        const from = args.old_path || args.from || args.source || args.source_path;
        const to = args.new_path || args.to || args.destination || args.destination_path || e.targetPath;
        if (typeof from === 'string' && typeof to === 'string') {
          renames.push({
            from: canonicalPath(from, workspacePath),
            to: canonicalPath(to, workspacePath),
            ts: e.timestamp ?? Date.now(),
          });
        }
        continue;
      }
    }
  }
  return { edits, writes, renames, firstWriteOverwrote };
}

/* .neox-tmp = Work 模式的草稿区 (见 useRecentArtifacts): 做视频时几十张预览帧不该列进「本轮改动」 */
const RUNTIME_ARTIFACT_RE =
  /(^|\/)(\.git|node_modules|\.next|\.turbo|coverage|dist|build|\.neox-tmp|__pycache__)\//i;
const RUNTIME_ARTIFACT_FILE_RE =
  /(\.db|\.db-wal|\.db-shm|\.sqlite3?|\.sqlite-wal|\.sqlite-shm|\.log|\.pid|\.swp|\.tmp)$|(^|\/)\.DS_Store$|(^|\/)(\.neox-tmp[^/]*|\.goutputstream-[^/]*|~\$[^/]*)$/i;

function isRuntimeArtifact(p: string): boolean {
  return RUNTIME_ARTIFACT_RE.test(p) || RUNTIME_ARTIFACT_FILE_RE.test(p);
}

function enrichEditChange(path: string, editEntries: TimelineEntry[]): TurnChange {
  const allHunks: TurnChange['editHunks'] = [];
  const allLines: NonNullable<TurnChange['changedLines']> = [];
  let addCount = 0;
  let delCount = 0;
  for (const e of editEntries) {
    const extracted = extractEditChangedLines(e);
    addCount += extracted.addCount;
    delCount += extracted.delCount;
    if (extracted.changedLines) allLines.push(...extracted.changedLines);
    const hunks = (e.editHunks && e.editHunks.length > 0)
      ? e.editHunks.map((h, hunkIdx) => ({
          oldString: h.oldString,
          newString: h.newString,
          startLine: h.startLine,
          oldLineCount: (h as any).oldLineCount,
          newLineCount: (h as any).newLineCount,
          oldCharCount: (h as any).oldCharCount,
          newCharCount: (h as any).newCharCount,
          previewTruncated: h.previewTruncated,
          review: (h as any).review,
          __sourceEntryId: e.id,
          __sourceHunkIdx: hunkIdx,
        } as any))
      : (e.editStartLine !== undefined && e.editNewString !== undefined)
        ? [{
            oldString: e.editOldString,
            newString: e.editNewString,
            startLine: e.editStartLine,
            review: (e as any).__topHunkReview,
            __sourceEntryId: e.id,
            __sourceHunkIdx: -1,
          } as any]
        : [];
    allHunks.push(...hunks);
  }
  return {
    path,
    op: 'edit',
    addCount,
    delCount,
    changedLines: allLines.length > 0 ? allLines : undefined,
    editHunks: allHunks.length > 0 ? allHunks : undefined,
  };
}

function enrichWriteChange(path: string, writeEntry: TimelineEntry): TurnChange {
  let contentText = '';
  if (writeEntry.type === 'file_stream') {
    contentText =
      (typeof (writeEntry as any).codeContent === 'string' && (writeEntry as any).codeContent) ||
      (typeof writeEntry.editNewString === 'string' && writeEntry.editNewString) ||
      '';
  } else {
    const args = (writeEntry.toolArgs || {}) as Record<string, unknown>;
    contentText = typeof args.content === 'string' ? args.content : '';
  }
  const normalized = normalizeWriteContent(contentText);
  return {
    path,
    op: 'write',
    addCount: normalized.lineCount,
    delCount: 0,
    changedLines: normalized.lineCount > 0
      ? [{ start: 1, end: normalized.lineCount, kind: 'add' }]
      : undefined,
    editHunks: normalized.text
      ? [{ oldString: '', newString: normalized.text, startLine: 1, newLineCount: normalized.lineCount }]
      : undefined,
    fallbackContent: normalized.text || undefined,
  };
}

/**
 * 主聚合函数. 无改动返 null.
 * workspacePath: 路径归一.
 * declarations: 可选额外声明（测试 / live ledger）; 与 entries 回放合并.
 *
 * @deprecated fsEvents 参数保留签名兼容, **忽略** — membership 不再读 FS.
 */
export function aggregateTurnChanges(
  entries: TimelineEntry[],
  workspacePath?: string,
  fsEvents?: unknown,
  declarations?: WriteDeclaration[],
): TurnSummary | null {
  void fsEvents; /* 刻意忽略 — 防旧调用方把 FS 当 membership */
  const idx = findTurnStartUserMessageIdx(entries);
  if (idx < 0) return null;
  const turnEntries = entries.slice(idx);
  const turnUserMsg = turnEntries[0]!;
  const turnId = turnUserMsg.id;
  const turnStartTs = turnUserMsg.timestamp ?? Date.now();
  const turnEndTs = turnEntries[turnEntries.length - 1]!.timestamp ?? Date.now();

  const sessionId =
    String((turnUserMsg as any).sessionId || (entries as any).sessionId || '') || 'local';

  const fromEntries = extractWriteDeclarationsFromTimelineEntries(
    turnEntries,
    sessionId,
    workspacePath,
  );
  const extra = (declarations ?? []).map((d) => ({
    ...d,
    paths: d.paths.map((p) => canonicalPath(p, workspacePath)),
    from: d.from ? canonicalPath(d.from, workspacePath) : undefined,
  }));
  const allDecls = [...fromEntries, ...extra];
  const folded = foldWriteDeclarations(allDecls);
  if (folded.size === 0) return null;

  const enrich = buildEntryEnrichmentIndex(turnEntries, workspacePath);
  const changes: TurnChange[] = [];

  for (const [path, state] of folded) {
    if (isRuntimeArtifact(path)) continue;

    if (state.op === 'rename') {
      changes.push({
        path,
        op: 'rename',
        addCount: 0,
        delCount: 0,
        from: state.from,
      });
      continue;
    }

    if (state.op === 'delete') {
      changes.push({ path, op: 'delete', addCount: 0, delCount: 0 });
      continue;
    }

    const editEntries = enrich.edits.get(path);
    const writeEntry = enrich.writes.get(path);

    if (editEntries && editEntries.length > 0 && !writeEntry) {
      changes.push(enrichEditChange(path, editEntries));
      continue;
    }

    if (writeEntry) {
      const change = enrichWriteChange(path, writeEntry);
      if (enrich.firstWriteOverwrote.get(path)) change.overwrote = true;
      changes.push(change);
      continue;
    }

    /* 有声明但无 diff 内容 (shell_proc / shell_declared / create_slides) */
    changes.push({
      path,
      op: state.op === 'edit' ? 'edit' : 'write',
      addCount: 0,
      delCount: 0,
      statsUnknown: true,
    });
  }

  if (changes.length === 0) return null;

  const totalFiles = changes.length;
  const totalAdds = changes.reduce((s, c) => s + c.addCount, 0);
  const totalDels = changes.reduce((s, c) => s + c.delCount, 0);

  return {
    turnId,
    turnStartTs,
    turnEndTs,
    changes,
    totalFiles,
    totalAdds,
    totalDels,
  };
}
