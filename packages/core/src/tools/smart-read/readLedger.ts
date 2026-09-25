/**
 * Read Ledger：记录每个读上下文看过的文件范围和版本。
 * readfile 通过账本完成两项工作:
 *
 *   1. 读去重 (省 token): 同文件同范围且 mtime/size 未变 → 不重发全文, 返回一句 stub。
 *   2. edit 的读证据: staleness (读后有没有被改) + 区域重定位 (旧内容在手, 行号漂了也能找回)。
 *
 * 版本戳由 mtime 和 size 组成，fs.stat 即可校验；账本只保存模型实际看到的文本范围，
 * 供 edit 做区域级一致性判定。
 *
 * 作用域: 每 session 一张账本, 靠 chatSessionAls 定位 (runner 每回合已 runWithChatSession)。
 *
 * 子 agent 使用独立的 readScopeAls；没有显式读上下文时回落到 chatSessionAls。这样不同
 * 上下文不会共享模型不可见的读取证据，同时保持主会话的 session 语义。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import * as nodePath from 'path';
import { getCurrentChatSessionId } from '../../runtime/shell/chatSessionContext.js';

const readScopeAls = new AsyncLocalStorage<string>();

/** 开一个独立读账本作用域 (子 agent 用)。作用域内的 readfile 去重只跟自己比。 */
export function runWithReadScope<T>(scopeId: string, fn: () => T): T {
  return readScopeAls.run(scopeId, fn);
}

export interface ReadEntry {
  /** 归一化范围指纹; 整读为 'FULL'。同一文件不同范围各存一条。 */
  rangeKey: string;
  /** 模型实际看到的那段文本 (区域内容)。edit 用它把漂移的区域重新定位回去。 */
  content: string;
  /** content[0] 对应的绝对行号 (1-indexed); 整读为 1。用于 edit 区域切片的偏移换算。 */
  startLine: number;
  /** 展示行数，并界定该记录覆盖的行区间。 */
  lineCount: number;
  /** 读那一刻 fs.stat 的 mtimeMs —— 主版本戳 (免读校验)。 */
  mtimeMs: number;
  /** 读那一刻的字节数 —— 补 mtime 的分辨率软肋 (size 变了必然改了)。 */
  sizeBytes: number;
  /** 第几轮读的。给 stub 提示; 也为将来的"驱逐感知"预留 (被压缩驱逐则放行重读)。 */
  readAtTurn: number;
}

type FileLedger = Map<string /* rangeKey */, ReadEntry>;
type SessionLedger = Map<string /* normPath */, FileLedger>;

const _sessions = new Map<string /* sessionId */, SessionLedger>();
/** 长跑 server 防泄漏: 最多留最近 N 个 session 的账本 (Map 保插入序, LRU 淘最旧)。 */
const MAX_SESSIONS = 100;

function currentSessionId(): string {
  /* 读作用域优先 —— 子 agent 在自己的桶里, 不吃父会话读过的账 */
  return readScopeAls.getStore() ?? getCurrentChatSessionId() ?? '__default__';
}

function sessionLedger(): SessionLedger {
  const id = currentSessionId();
  let s = _sessions.get(id);
  if (s) {
    // touch → 移到末尾, 维持 LRU
    _sessions.delete(id);
    _sessions.set(id, s);
    return s;
  }
  if (_sessions.size >= MAX_SESSIONS) {
    const oldest = _sessions.keys().next().value;
    if (oldest !== undefined) _sessions.delete(oldest);
  }
  s = new Map();
  _sessions.set(id, s);
  return s;
}

/**
 * 当前会话的读账本里有多少个文件条目。
 *
 * 用途: 判断"账本是不是空的"。跨重启恢复会话时 memory 里有历史但账本是空的 ——
 * 那一刻必须重建 (见 ledgerRebuild.ts / AgentRuntimeHost.restoreReadLedger)。
 *  别用它做任何"有没有读过某个文件"的判断, 那是 hasBeenRead/checkCoherence 的事。
 */
export function readLedgerFileCount(): number {
  return sessionLedger().size;
}

/** readfile 读完后登记一次读。同 (path, rangeKey) 覆盖旧条目。 */
export function recordRead(normPath: string, entry: ReadEntry): void {
  const s = sessionLedger();
  let f = s.get(normPath);
  if (!f) {
    f = new Map();
    s.set(normPath, f);
  }
  f.set(entry.rangeKey, entry);
}

/**
 * 命中判定: 同范围 + mtime + size 全等才算 —— 三个 O(1) 比较, 不碰内容。
 * 调用方只 stat 一次, 把 mtimeMs/sizeBytes 传进来。命中 = 可以短路不重发全文。
 */
export function findFreshRead(
  normPath: string,
  rangeKey: string,
  mtimeMs: number,
  sizeBytes: number,
  /** 本次请求的行区间 (拿得到才传) — 用于"被更大的一次读覆盖"的命中判定 */
  wantRange?: { start: number; end: number },
): ReadEntry | undefined {
  const f = sessionLedger().get(normPath);
  if (!f) return undefined;
  const fresh = (e?: ReadEntry) => (e && e.mtimeMs === mtimeMs && e.sizeBytes === sizeBytes ? e : undefined);

  const exact = fresh(f.get(rangeKey));
  if (exact) return exact;

  /* 版本未变且已有记录完整覆盖请求范围时返回 stub；仅相交的范围仍需真实读取，
   * 因为其中包含模型尚未看到的行。 */
  if (!wantRange || !Number.isFinite(wantRange.start) || !Number.isFinite(wantRange.end)) return undefined;
  const full = fresh(f.get('FULL'));
  if (full) return full;
  for (const e of f.values()) {
    if (!fresh(e) || e.lineCount <= 0) continue;
    const covStart = e.startLine;
    const covEnd = e.startLine + e.lineCount - 1;
    if (covStart <= wantRange.start && wantRange.end <= covEnd) return e;
  }
  return undefined;
}

/** 该文件是否读过 (任意范围)。edit 的"没读过先读"门禁用。 */
export function hasBeenRead(normPath: string): boolean {
  const f = sessionLedger().get(normPath);
  return !!f && f.size > 0;
}

/**
 * 一致性判定 —— 模型手里那份副本跟磁盘还对得上吗。
 *
 * 这是 edit 失败诊断的核心: `old_string` 找不到只有三种可能, 而它们**要采取的行动完全不同**,
 * 混在一句 "String to replace not found" 里模型只能瞎猜:
 *
 *   unread — 本会话压根没读过这个文件 → 它的 old_string 是凭印象/搜索片段拼的 → 让它先读
 *   stale — 读过, 但文件之后被改了 (linter / 另一个进程 / 上一次编辑) → 让它重读
 *   fresh — 读过且文件没变 → 是模型自己抄错了 → 把文件里真实的那段摊给它
 *
 * 判据全是 O(1) 比较, 只需调用方已经拿到的 stat —— 不为判定而重读文件。
 * 只在精确匹配失败后才调用, 快路径零开销。
 */
export type ReadCoherence = 'fresh' | 'stale' | 'unread';

/** 不透明文档 (.docx 等) 的账本 rangeKey —— 只有版本戳有意义, 不存文本内容。 */
export const OPAQUE_DOC_RANGE_KEY = 'OPAQUE_DOC';

/** 会话恢复时"历史里见过但证明不了跟磁盘一致"的占位 rangeKey —— 见 ledgerRebuild.ts。 */
export const HISTORY_SEEN_RANGE_KEY = 'HISTORY_SEEN';

/**
 * 登记一次"不透明文档读取" —— .docx / .xlsx 这类二进制文档。
 *
 * 跟文本文件的差别: 我们不把内容存进账本 (它不是按行的文本, 存了也没法给 edit 用),
 * **只存版本戳**。因为对这类文档要防的不是"old_string 抄错", 而是:
 *   word_get_paragraphs 给出 index→text, 模型随后 word_edit_paragraph(index=5);
 *   若文件在这中间被改过 (用户在 Word 里编辑 / 另一个工具动了它), index 5 指向的
 *   已经是别的段落 —— 而**按位置的操作永远"成功"**, 错了没人发现。这正是行号接口
 *   的老毛病, 必须靠版本戳在写之前拦住。
 */
export function recordOpaqueDocRead(normPath: string, mtimeMs: number, sizeBytes: number, turn = 0): void {
  recordRead(normPath, {
    rangeKey: OPAQUE_DOC_RANGE_KEY,
    content: '',          // 故意不存内容 — 二进制文档的文本没法给 edit 复用
    startLine: 1,
    lineCount: 0,
    mtimeMs,
    sizeBytes,
    readAtTurn: turn,
  });
}

export function checkCoherence(
  normPath: string,
  mtimeMs: number,
  sizeBytes: number,
): { state: ReadCoherence; entry?: ReadEntry } {
  const reads = getFileReads(normPath);
  if (reads.length === 0) return { state: 'unread' };
  /* 任一条记录的版本戳跟当前盘上一致 → 模型手里至少有一份当前副本 */
  const fresh = reads.find((r) => r.mtimeMs === mtimeMs && r.sizeBytes === sizeBytes);
  if (fresh) return { state: 'fresh', entry: fresh };
  /* 都不一致 → 读过但已过期。挑最近读的那条回去, 供报错时说明"你当时看到的是什么版本" */
  const latest = reads.reduce((a, b) => (b.readAtTurn >= a.readAtTurn ? b : a));
  return { state: 'stale', entry: latest };
}

/** 取某文件全部读记录。edit 找覆盖目标区域的那条旧内容用。 */
export function getFileReads(normPath: string): ReadEntry[] {
  const f = sessionLedger().get(normPath);
  return f ? [...f.values()] : [];
}

/**
 * 找一条覆盖 [startLine, endLine] 的读记录 (给 edit 区域重定位取旧内容)。
 * 优先整读 (FULL), 否则任一 startLine..startLine+lineCount 覆盖目标的范围读。
 */
export function findCoveringRead(
  normPath: string,
  startLine: number,
  endLine: number,
): ReadEntry | undefined {
  const reads = getFileReads(normPath);
  const full = reads.find((r) => r.rangeKey === 'FULL');
  if (full) return full;
  return reads.find((r) => r.startLine <= startLine && endLine <= r.startLine + r.lineCount - 1);
}

/** edit 写盘成功后调: 该文件所有读记录作废 (内容变了, 旧证据不再可信; 下次读重建)。 */
export function invalidateReads(normPath: string): void {
  sessionLedger().get(normPath)?.clear();
}

/**
 * 写盘成功后刷新读账本。FULL 记录可用新内容刷新；局部记录仅在能证明范围仍然正确时
 * 保留，否则删除；未读取的文件不会凭空创建读证据。
 */
export function refreshReadsAfterWrite(
  normPath: string,
  newContent: string,
  mtimeMs: number,
  sizeBytes: number,
  turn = 0,
  /** 可选的改前内容，用于计算改动行并精确更新局部读证据。 */
  previousContent?: string,
): void {
  const f = sessionLedger().get(normPath);
  if (!f || f.size === 0) return;              // 没读过 → 不造证据
  const full = f.get('FULL');
  const ranges = [...f.values()].filter((e) => e.rangeKey !== 'FULL' && e.rangeKey !== OPAQUE_DOC_RANGE_KEY);
  f.clear();

  if (full) {
    const lines = newContent.split(/\r?\n/);
    const lineCount = lines.length > 1 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
    f.set('FULL', {
      rangeKey: 'FULL',
      content: newContent,
      startLine: 1,
      lineCount,
      mtimeMs,
      sizeBytes,
      readAtTurn: full.readAtTurn || turn,
    });
    /* 有整读就够了 —— findCoveringRead / findFreshRead 都会优先命中 FULL,
     * 再留一堆范围记录只是冗余。 */
    return;
  }

  if (ranges.length === 0 || previousContent === undefined) return;

  const span = diffLineSpan(previousContent, newContent);
  if (!span) return;                            // 算不出改动区间 → 维持保守作废
  if (span.firstChangedLine === 0) {
    /* 内容压根没变 (等价写入) → 原样保留, 只刷版本戳 */
    for (const e of ranges) f.set(e.rangeKey, { ...e, mtimeMs, sizeBytes });
    return;
  }

  const newLines = newContent.split(/\r?\n/);
  for (const e of ranges) {
    const refreshed = refreshRangeEntry(e, span, newLines, mtimeMs, sizeBytes);
    if (refreshed) f.set(refreshed.rangeKey, refreshed);
  }
}

/** 行级 diff: 公共前缀/后缀夹出被改动的区间 (旧文件坐标) 与行数增量。 */
function diffLineSpan(
  oldContent: string,
  newContent: string,
): { firstChangedLine: number; lastChangedOldLine: number; lineDelta: number } | null {
  const oldLines = oldContent.split(/\r?\n/);
  const newLines = newContent.split(/\r?\n/);
  let p = 0;
  while (p < oldLines.length && p < newLines.length && oldLines[p] === newLines[p]) p++;
  if (p === oldLines.length && p === newLines.length) {
    return { firstChangedLine: 0, lastChangedOldLine: 0, lineDelta: 0 };
  }
  let s = 0;
  while (
    s < oldLines.length - p &&
    s < newLines.length - p &&
    oldLines[oldLines.length - 1 - s] === newLines[newLines.length - 1 - s]
  ) s++;
  return {
    firstChangedLine: p + 1,                    // 1-indexed
    lastChangedOldLine: oldLines.length - s,    // 1-indexed, 旧坐标
    lineDelta: newLines.length - oldLines.length,
  };
}

/**
 * 单条范围记录的写后处置，只保留能证明模型仍知道当前内容的三种情形：改动之前、
 * 包含改动、改动之后。对应记录分别原样保留、按行数调整或平移行号。
 *
 * 与改动部分不安全重叠的记录一律丢弃，避免把未读文本误记为已读。
 */
function refreshRangeEntry(
  e: ReadEntry,
  span: { firstChangedLine: number; lastChangedOldLine: number; lineDelta: number },
  newLines: string[],
  mtimeMs: number,
  sizeBytes: number,
): ReadEntry | null {
  const { firstChangedLine: fc, lastChangedOldLine: lc, lineDelta: d } = span;
  const start = e.startLine;
  const end = e.startLine + e.lineCount - 1;
  if (start < 1 || e.lineCount < 1) return null;

  /* 情形 1: 整段在改动之前 */
  if (end < fc) return { ...e, mtimeMs, sizeBytes };

  /* 情形 3: 整段在改动之后 (旧坐标) → 平移 */
  if (start > lc) {
    const newStart = start + d;
    const newEnd = end + d;
    if (newStart < 1 || newEnd > newLines.length) return null;
    return {
      ...e,
      rangeKey: `R:${newStart}-${newEnd}`,
      startLine: newStart,
      mtimeMs,
      sizeBytes,
    };
  }

  /* 情形 2: 整段包住改动 → 重切片 (行数按增量伸缩) */
  if (start <= fc && lc <= end) {
    const newEnd = end + d;
    if (newEnd < start || newEnd > newLines.length) return null;
    const sliced = newLines.slice(start - 1, newEnd);
    if (sliced.length === 0) return null;
    return {
      ...e,
      rangeKey: `R:${start}-${newEnd}`,
      content: sliced.join('\n'),
      startLine: start,
      lineCount: sliced.length,
      mtimeMs,
      sizeBytes,
    };
  }

  /* 部分重叠 → 丢 */
  return null;
}

/* ── 去重命中计数 (埋点用): 每命中一次账本 = 省下一次重复读/搜。按 session 累加, 由埋点
 *   收集器每 turn 结束 drain 一次, 落进 agent_turn_metrics.duplicate_read_count。 ── */
const _dupCounts = new Map<string /* sessionId */, { read: number; search: number }>();

/** readfile/search 命中账本短路时调一次。kind 区分读/搜。 */
export function noteDuplicateHit(kind: 'read' | 'search'): void {
  const id = currentSessionId();
  const c = _dupCounts.get(id) ?? { read: 0, search: 0 };
  c[kind] += 1;
  _dupCounts.set(id, c);
}

/** 取该 session 累计的去重命中数并清零 (每 turn 结束调)。传显式 sessionId 避开 ALS 上下文不确定。 */
export function drainDuplicateCounts(sessionId?: string): { read: number; search: number } {
  const id = sessionId ?? currentSessionId();
  const c = _dupCounts.get(id) ?? { read: 0, search: 0 };
  _dupCounts.delete(id);
  return c;
}

/* ── 搜索去重  ──────────────────────────────────────────────
 *  同一个查询 (pattern+path+opts) 在会话内重复搜, 且期间没有任何写入 → 短路发 stub,
 *  不重跑 ripgrep、不重发全部结果。
 *
 *  失效判据 = "工作区写纪元 (epoch)": 任意 edit/write 成功都 bumpWorkspaceEpoch() +1,
 *  搜索条目记录当时的 epoch, 只有 epoch 未变才算新鲜 (保守: 一次写作废本会话所有搜索缓存,
 *  但正是想拦的浪费 —— 模型没改任何东西却重复搜同一个词)。文件级精确失效留 v2。 ── */

export interface SearchEntry {
  /** 记录时的工作区写纪元。用于按纪元切片取"之后写过哪些文件"。 */
  epoch: number;
  /** 匹配数，用于构造 stub 摘要。 */
  matchCount: number;
  /** 命中文件列表 —— **展示用** (给 stub 自足: 即便原结果滚出上下文, 模型仍知道哪些文件命中)。 */
  filesWithMatches: string[];
  /**
   * 命中文件的**绝对路径**(已规范化), 只用于失效判定。
   *
   * 为什么不能复用 filesWithMatches: 那是 formatDisplayPath 出来的相对/美化路径,
   * 而 bumpWorkspaceEpoch 收到的是绝对路径 —— 两边字符串永远比不上, 判据①
   * "被写的文件在命中列表里" 会**恒不成立**: 把匹配行删掉之后缓存仍判新鲜,
   * stub 会拿旧的匹配数糊弄模型 (自审揪出, 全平台都错)。
   */
  matchedPaths?: string[];
  /** 本次搜索使用的正则或字面量；缺失时无法判断新增匹配。 */
  pattern?: string;
  /** 正则是否大小写不敏感 */
  caseInsensitive?: boolean;
}

/* 搜索缓存仅在命中文件被写入，或写入内容可能产生新的匹配时失效；无法取得写入内容
 * 或搜索模式时按过期处理，其他结果继续复用。 */
interface WriteRecord {
  epoch: number;
  path: string;
  /** 写入后的内容; undefined = 未知 (shell 等) → 该纪元一律作废 */
  content?: string;
}
const _writeLog = new Map<string /* sessionId */, WriteRecord[]>();
const MAX_WRITE_LOG = 400;

/** 路径比较归一 —— Windows 大小写不敏感 + 分隔符混用, 直接比字符串必错。 */
function normPathForCompare(p: string): string {
  if (!p) return '';
  const resolved = nodePath.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

type SearchCache = Map<string /* queryKey */, SearchEntry>;
const _searchCache = new Map<string /* sessionId */, SearchCache>();
const _writeEpoch = new Map<string /* sessionId */, number>();
const MAX_SEARCH_QUERIES = 200; // 每 session 上限, 防长跑泄漏

function currentEpoch(): number {
  return _writeEpoch.get(currentSessionId()) ?? 0;
}

/** 记录一次工作区写入并递增 session 写纪元；缺少路径或内容时相关缓存保守失效。 */
export function bumpWorkspaceEpoch(path?: string, content?: string): void {
  const id = currentSessionId();
  const next = (_writeEpoch.get(id) ?? 0) + 1;
  _writeEpoch.set(id, next);
  const log = _writeLog.get(id) ?? [];
  log.push({ epoch: next, path: path ?? '', content });
  if (log.length > MAX_WRITE_LOG) log.splice(0, log.length - MAX_WRITE_LOG);
  _writeLog.set(id, log);
}

/** 记录后发生的写入是否可能改变这条搜索的结果集 (判据见 WriteRecord 上方注释)。 */
function searchInvalidatedBy(entry: SearchEntry): boolean {
  const log = _writeLog.get(currentSessionId());
  if (!log?.length) return false;
  const since = log.filter(w => w.epoch > entry.epoch);
  if (!since.length) return false;

  /* 用绝对路径集合比 (见 matchedPaths 注释)。老条目没有它 → 该判据失效, 由下面的模式判据兜底。 */
  const matched = new Set((entry.matchedPaths ?? []).map(normPathForCompare));
  let re: RegExp | undefined;
  if (entry.pattern) {
    try { re = new RegExp(entry.pattern, entry.caseInsensitive ? 'i' : ''); }
    catch { re = undefined; }   /* 模式不是合法正则 (纯字面量搜索) → 下面退回 includes */
  }

  for (const w of since) {
    /* 内容未知 (shell 写、二进制) → 判不了, 保守作废 */
    if (w.content === undefined) return true;
    /* ① 本来就在命中列表里 → 它的匹配行可能变了 */
    if (w.path && matched.has(normPathForCompare(w.path))) return true;
    /* 新内容包含搜索模式时，结果集可能新增匹配。 */
    if (!entry.pattern) return true;   /* 不知道搜的什么 → 保守 */
    const hit = re ? re.test(w.content)
      : entry.caseInsensitive
        ? w.content.toLowerCase().includes(entry.pattern.toLowerCase())
        : w.content.includes(entry.pattern);
    if (hit) return true;
  }
  return false;
}

/** search 跑完后登记结果指纹。pattern/caseInsensitive 给失效判定用 (见 searchInvalidatedBy)。 */
export function recordSearch(
  queryKey: string,
  matchCount: number,
  filesWithMatches: string[],
  opts?: { pattern?: string; caseInsensitive?: boolean; matchedPaths?: string[] },
): void {
  const id = currentSessionId();
  let m = _searchCache.get(id);
  if (!m) {
    m = new Map();
    _searchCache.set(id, m);
  }
  if (m.size >= MAX_SEARCH_QUERIES && !m.has(queryKey)) {
    const oldest = m.keys().next().value;
    if (oldest !== undefined) m.delete(oldest);
  }
  m.set(queryKey, {
    epoch: currentEpoch(),
    matchCount,
    filesWithMatches,
    pattern: opts?.pattern,
    caseInsensitive: opts?.caseInsensitive,
    matchedPaths: opts?.matchedPaths,
  });
}

/** 命中判定: 同 queryKey 且纪元未变 (期间无写)。命中 = 可短路不重搜。 */
export function findFreshSearch(queryKey: string): SearchEntry | undefined {
  const e = _searchCache.get(currentSessionId())?.get(queryKey);
  if (!e) return undefined;
  if (e.epoch === currentEpoch()) return e;          /* 期间没写过 → 直接新鲜 */
  return searchInvalidatedBy(e) ? undefined : e;     /* 写过, 但写的东西影响不到这条结果 */
}

/** session 结束清账本, 防内存泄漏。 */
export function dropSessionLedger(sessionId: string): void {
  _sessions.delete(sessionId);
  _dupCounts.delete(sessionId);
  _searchCache.delete(sessionId);
  _writeEpoch.delete(sessionId);
  _writeLog.delete(sessionId);
}
