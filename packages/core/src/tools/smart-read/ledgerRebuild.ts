import * as fs from 'fs/promises';
import { recordRead, HISTORY_SEEN_RANGE_KEY } from './readLedger.js';
import { stripLineNumbersForLedger } from './utils.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { writeStallFile } from '@neoxlabs/kernel/utils/stallGuard.js';

/** 单个文件上限 —— 超大文件不值得为重建账本再读一遍 */
const MAX_REBUILD_FILE_BYTES = 512 * 1024;
/** 最多回溯多少条 readfile 结果 (从新到旧) —— 长会话别把恢复拖慢 */
const MAX_REBUILD_ENTRIES = 40;

const READ_TOOL_NAMES = new Set(['readfile', 'read_file', 'read', 'smart_read']);
/** 写类工具 —— 模型亲手写过的文件, 它上下文里有 (至少某个版本的) 内容 */
const WRITE_TOOL_NAMES = new Set(['write_file', 'edit', 'edit_file', 'edit_batch', 'str_replace_editor', 'multi_edit']);


type AnyMessage = {
  role?: string;
  content?: unknown;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
  tool_call_id?: string;
};

function pathArg(a: Record<string, unknown>): string | undefined {
  const p = a.file_path ?? a.path ?? a.filePath ?? a.file;
  return typeof p === 'string' && p ? p : undefined;
}

/** paths=[...] 一次读多个时, 结果按 `══════ <path> ══════` 分段拼接 (smart-read/tools.ts)。 */
function splitMultiReadSections(text: string, paths: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < paths.length; i++) {
    const header = `══════ ${paths[i]} ══════\n`;
    const start = text.indexOf(header);
    if (start < 0) continue;
    const bodyStart = start + header.length;
    const next = text.indexOf('\n\n══════ ', bodyStart);
    out.set(paths[i], text.slice(bodyStart, next < 0 ? undefined : next));
  }
  return out;
}

interface HistoryScan {
  /** 文件路径 → 当时展示给模型的整读输出 (同一文件保留最后一次) */
  wholeReads: Map<string, string>;
  /** 文件路径 → 模型最后一次 write_file 写进去的完整内容 */
  writes: Map<string, string>;
  /** 历史里以任何方式读过/写过的文件 (含范围读) */
  touched: Set<string>;
}

/** 从历史里配出读/写证据。 */
function scanHistory(messages: AnyMessage[]): HistoryScan {
  const callById = new Map<string, { name: string; args: Record<string, unknown> }>();
  const touched = new Set<string>();
  const writes = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    for (const tc of m.tool_calls) {
      const name = tc?.function?.name;
      if (!name || !tc.id) continue;
      const isRead = READ_TOOL_NAMES.has(name);
      if (!isRead && !WRITE_TOOL_NAMES.has(name)) continue;
      let a: Record<string, unknown>;
      try { a = JSON.parse(tc.function?.arguments || '{}') as Record<string, unknown>; } catch { continue; }
      callById.set(tc.id, { name, args: a });
      const p = pathArg(a);
      if (p) touched.add(p);
      if (isRead && Array.isArray(a.paths)) {
        for (const x of a.paths) if (typeof x === 'string' && x) touched.add(x);
      }
      /* write_file 的 content 就是写进去的全文; 结果是否成功下面配 tool 消息时再定 */
      if (name === 'write_file' && p && typeof a.content === 'string' && a.mode !== 'append') {
        writes.set(p, a.content);
      }
    }
  }

  const wholeReads = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== 'tool' || !m.tool_call_id) continue;
    const call = callById.get(m.tool_call_id);
    if (!call || !READ_TOOL_NAMES.has(call.name)) continue;
    const a = call.args;
    /* 只考虑整读 —— 范围读没法跟整文件内容比对, 无法安全判定 */
    const isRangeRead = a.start_line != null || a.end_line != null || a.ranges != null
      || a.pattern != null || a.symbol != null || a.function != null || a.class != null;
    if (isRangeRead) continue;
    const text = typeof m.content === 'string' ? m.content : '';
    if (!text) continue;
    const multi = Array.isArray(a.paths) ? (a.paths as unknown[]).filter((x): x is string => typeof x === 'string' && !!x) : [];
    if (multi.length > 0) {
      for (const [p, section] of splitMultiReadSections(text, multi)) wholeReads.set(p, section);
      continue;
    }
    const p = pathArg(a);
    if (p) wholeReads.set(p, text);   // 后出现的覆盖先出现的 = 保留最后一次读
  }
  return { wholeReads, writes, touched };
}

export interface RebuildResult {
  restored: number;
  skipped: number;
}

/**
 * 从恢复出来的消息历史重建读账本。
 * @param messages  loadHistory 之后的完整 memory 消息 (需含 raw tool_calls / tool result)
 * @param resolvePath 把工具参数里的路径解析成绝对路径 (跟 readfile 当时用的同一套)
 */
export async function rebuildReadLedgerFromHistory(
  messages: AnyMessage[],
  resolvePath: (p: string) => string,
  reason = 'unknown',
): Promise<RebuildResult> {
  const { wholeReads: paired, writes, touched } = scanHistory(messages);
  if (paired.size === 0 && writes.size === 0 && touched.size === 0) {
    writeStallFile('info', 'LEDGER_REBUILD', '历史里没配出任何整读结果', {
      reason, restored: 0, skipped: 0, pairedFiles: 0, messageCount: messages.length,
      /* 配不出来的可能原因: 恢复出的消息丢了 raw tool_calls / 工具名不在白名单 /
         全是范围读。把这三项各自的条数记下来才定位得了。 */
      assistantWithToolCalls: messages.filter(m => m.role === 'assistant' && Array.isArray(m.tool_calls)).length,
      toolResults: messages.filter(m => m.role === 'tool').length,
    });
    return { restored: 0, skipped: 0 };
  }

  /* 从新到旧, 只处理最近 N 个 —— 更早的读大概率已被压缩挤掉, 重建了也不该算 fresh */
  const entries = [...paired.entries()].slice(-MAX_REBUILD_ENTRIES);
  let restored = 0;
  let skipped = 0;
  const why: Record<string, number> = {};
  const note = (k: string) => { why[k] = (why[k] || 0) + 1; };
  const freshPaths = new Set<string>();

  const recordFull = (abs: string, diskContent: string, st: { mtimeMs: number; size: number }) => {
    const lines = diskContent.split(/\r?\n/);
    const lineCount = lines.length > 1 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
    recordRead(abs, {
      rangeKey: 'FULL',
      content: diskContent,
      startLine: 1,
      lineCount,
      mtimeMs: st.mtimeMs,
      sizeBytes: st.size,
      readAtTurn: 0,
    });
    freshPaths.add(abs);
  };

  /* 模型亲手 write_file 的全文跟磁盘逐字相同 → 它上下文里就是当前版本 */
  for (const [rawPath, written] of [...writes.entries()].slice(-MAX_REBUILD_ENTRIES)) {
    try {
      const abs = resolvePath(rawPath);
      const st = await fs.stat(abs);
      if (!st.isFile() || st.size > MAX_REBUILD_FILE_BYTES) continue;
      const diskContent = await fs.readFile(abs, 'utf-8');
      if (diskContent === written) { recordFull(abs, diskContent, st); restored++; }
    } catch { /* 文件没了 → 下面的占位也不会登记 */ }
  }

  for (const [rawPath, shownText] of entries) {
    let abs: string;
    try { abs = resolvePath(rawPath); } catch { skipped++; note('resolveFail'); continue; }
    try {
      const st = await fs.stat(abs);
      if (!st.isFile()) { skipped++; note('notFile'); continue; }
      if (st.size > MAX_REBUILD_FILE_BYTES) { skipped++; note('tooBig'); continue; }
      const diskContent = await fs.readFile(abs, 'utf-8');
      /* 关键判据: 磁盘现内容原样出现在当时展示的输出里 (去掉行号前缀后)。
         includes 而不是相等 —— 输出里还有表头/摘要/提示行, 只要文件正文完整在内就算。 */
      const shown = stripLineNumbersForLedger(shownText);
      if (!diskContent || !shown.includes(diskContent.replace(/\r\n/g, '\n').trimEnd())) {
        skipped++;
        note('contentMismatch');
        /* 最可能的一条: 落盘的 tool result 是被压缩/摘要过的版本, 不含完整正文。
           把两边长度记下来, 一眼能看出是"完全对不上"还是"只差一点(换行/尾部)"。 */
        note(`mismatch_shown${shown.length}_disk${(diskContent || '').length}`);
        continue;
      }
      recordFull(abs, diskContent, st);
      restored++;
    } catch {
      skipped++;   // 文件没了 / 读不了 / 二进制 → 保持 unread, 安全
      note('statOrReadFail');
    }
  }

  /* 历史里读过/写过、但证明不了跟磁盘一致的文件 → 登记"见过"占位, 诊断为 stale 而不是 unread */
  let seen = 0;
  for (const rawPath of touched) {
    let abs: string;
    try { abs = resolvePath(rawPath); } catch { continue; }
    if (freshPaths.has(abs)) continue;
    try {
      const st = await fs.stat(abs);
      if (!st.isFile()) continue;
    } catch { continue; }
    recordRead(abs, {
      rangeKey: HISTORY_SEEN_RANGE_KEY,
      content: '',
      startLine: 1,
      lineCount: 0,
      mtimeMs: -1,
      sizeBytes: -1,
      readAtTurn: 0,
    });
    seen++;
  }
  if (seen > 0) note(`historySeen${seen}`);

  /* 必须落盘 (writeStallFile), 不能只走 cliLogger —— 桌面端 core 的 cliLogger 不持久化,
     静默失败就等于没有这个功能。paired=0 也要记: 那说明历史里压根没配出读结果, 是另一类问题。 */
  writeStallFile('info', 'LEDGER_REBUILD', `会话恢复: 重建 ${restored} 条, 跳过 ${skipped} 条`, {
    reason, restored, skipped, pairedFiles: paired.size, why,
  });
  if (restored > 0 || skipped > 0) {
    cliLogger.debug('LEDGER', `会话恢复: 重建 ${restored} 条读证据, 跳过 ${skipped} 条`);
  }
  return { restored, skipped };
}
