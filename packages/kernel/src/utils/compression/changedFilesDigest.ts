/* LOOP-17 · 压缩摘要固定含「已改文件 + 每个一句话」
 *
 * 压缩后模型最容易犯的错不是「忘了读过什么」，而是「忘了自己刚改过哪里」——
 * 于是回头重读、重改同一处，用户看到的是「改了又改回去」。
 *
 * 这里不靠 LLM 自觉（摘要 prompt 里写一句要求，模型不一定会照做），而是从
 * 被压缩的消息里**确定性地**扫出 mutation 工具调用，渲染成固定的一节：
 *
 *   ### Changed Files
 *   - `src/a.ts` — 修改 3 处（2 次编辑）
 *   - `src/b.ts` — 写入 1 次（最后 812 字符）
 *
 * 滚动压缩时，上一轮摘要里的这一节会被原样携带并和新条目合并（新记录覆盖旧记录），
 * 保证「压缩过很多次」的会话仍然有一份完整的改动清单。
 */

import type { Message } from '../../types/index.js';
import { getTextFromContent } from '../messageUtils.js';

const EDIT_TOOLS = new Set(['edit', 'edit_file', 'editfile', 'apply_patch', 'patch']);
const WRITE_TOOLS = new Set(['write_file', 'writefile', 'write']);
const DELETE_TOOLS = new Set(['delete_file', 'deletefile', 'delete', 'remove_file']);
const RENAME_TOOLS = new Set(['rename_file', 'move_file', 'rename', 'move']);
const MKDIR_TOOLS = new Set(['create_directory', 'mkdir', 'create_dir']);

/** 一节最多列多少个文件 —— 再多就挤掉别的段，模型也不会逐条读。 */
const MAX_CHANGED_FILES = 30;

export type ChangedFileKind = 'edit' | 'write' | 'delete' | 'rename' | 'mkdir';

export interface ChangedFileEntry {
  path: string;
  kind: ChangedFileKind;
  /** edit: 累计改动的 hunk 数; write: 最后一次写入的字符数 */
  size: number;
  /** 对同一文件发生了几次 mutation */
  count: number;
  /** rename / move 的目标路径 */
  target?: string;
}

function parseArgs(raw: unknown): Record<string, any> | null {
  if (raw && typeof raw === 'object') return raw as Record<string, any>;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, any> : null;
  } catch {
    return null;
  }
}

function pathOf(args: Record<string, any>): string | undefined {
  const p = args.file_path ?? args.filePath ?? args.path ?? args.file ?? args.old_path;
  return typeof p === 'string' && p.trim() ? p.trim() : undefined;
}

function targetOf(args: Record<string, any>): string | undefined {
  const p = args.new_path ?? args.destination_path ?? args.to ?? args.dest ?? args.target;
  return typeof p === 'string' && p.trim() ? p.trim() : undefined;
}

function hunkCount(args: Record<string, any>): number {
  if (Array.isArray(args.hunks) && args.hunks.length > 0) return args.hunks.length;
  return 1;
}

interface MutationCall { name: string; args: Record<string, any> }

/** call_tool 动态派发：真名和真参数都在入参里（与 runner 的提取口径一致）。 */
function resolveCall(name: string, args: Record<string, any>): MutationCall {
  if (name.toLowerCase() !== 'call_tool') return { name: name.toLowerCase(), args };
  const realName = String(args.tool ?? args.name ?? args.tool_name ?? '').trim();
  const realArgs = parseArgs(args.args ?? args.arguments ?? args.input) ?? {};
  return { name: realName.toLowerCase(), args: realArgs };
}

function mergeEntry(entries: Map<string, ChangedFileEntry>, path: string, call: MutationCall): void {
  const { name, args } = call;
  const existing = entries.get(path);
  const next: ChangedFileEntry = existing
    ? { ...existing }
    : { path, kind: 'edit', size: 0, count: 0 };

  if (DELETE_TOOLS.has(name)) {
    next.kind = 'delete';
    next.size = 0;
    next.target = undefined;
  } else if (RENAME_TOOLS.has(name)) {
    next.kind = 'rename';
    next.target = targetOf(args);
  } else if (MKDIR_TOOLS.has(name)) {
    next.kind = 'mkdir';
  } else if (WRITE_TOOLS.has(name)) {
    next.kind = 'write';
    const content = typeof args.content === 'string' ? args.content : '';
    next.size = content.length;
  } else if (EDIT_TOOLS.has(name)) {
    /* 写之后又编辑：仍算 write（文件是新建/覆盖出来的），只累计次数。 */
    if (next.kind !== 'write') {
      next.kind = 'edit';
      next.size += hunkCount(args);
    }
  } else {
    return;
  }

  next.count += 1;
  entries.set(path, next);
}

/** 从一段消息里按时间顺序收集 mutation 调用（同一文件合并成一条）。 */
export function collectChangedFiles(messages: readonly Message[]): ChangedFileEntry[] {
  const entries = new Map<string, ChangedFileEntry>();

  for (const msg of messages) {
    if (!msg || msg.role !== 'assistant') continue;
    const calls = (msg as any).tool_calls;
    if (!Array.isArray(calls)) continue;

    for (const rawCall of calls) {
      const name = String(rawCall?.function?.name ?? '').trim();
      if (!name) continue;
      const args = parseArgs(rawCall?.function?.arguments);
      if (!args) continue;
      const call = resolveCall(name, args);
      const filePath = pathOf(call.args);
      if (!filePath) continue;
      mergeEntry(entries, filePath, call);
    }
  }

  return [...entries.values()].slice(0, MAX_CHANGED_FILES);
}

function renderEntry(entry: ChangedFileEntry): string {
  switch (entry.kind) {
    case 'delete':
      return `- \`${entry.path}\` — 已删除`;
    case 'rename':
      return entry.target
        ? `- \`${entry.path}\` — 重命名 → \`${entry.target}\``
        : `- \`${entry.path}\` — 重命名`;
    case 'mkdir':
      return `- \`${entry.path}\` — 新建目录`;
    case 'write':
      return `- \`${entry.path}\` — 写入 ${entry.count} 次（最后一次 ${entry.size} 字符）`;
    default:
      return entry.size > 0
        ? `- \`${entry.path}\` — 修改 ${entry.size} 处（${entry.count} 次编辑）`
        : `- \`${entry.path}\` — 编辑 ${entry.count} 次`;
  }
}

/** 从摘要正文里取出 `### Changed Files` 那一节的行（滚动压缩时携带旧记录）。 */
export function extractChangedFileLines(summaries: readonly Message[]): string[] {
  const lines: string[] = [];
  for (const msg of summaries) {
    const body = getTextFromContent((msg as any)?.content);
    if (!body) continue;
    let inSection = false;
    for (const line of body.split('\n')) {
      if (/^###\s+Changed Files\s*$/.test(line)) {
        inSection = true;
        continue;
      }
      if (inSection && /^###\s+/.test(line)) break;
      if (inSection && /^-\s+`/.test(line.trim())) lines.push(line.trim());
    }
  }
  return lines;
}

function pathFromLine(line: string): string | undefined {
  const m = line.match(/^-\s+`([^`]+)`/);
  return m ? m[1] : undefined;
}

/**
 * 渲染固定的改动清单段。
 *
 * @param entries 本次从消息里扫出的改动（按时间顺序）
 * @param priorLines 上一轮摘要里的改动行（更早的改动，只可能在这里）
 */
export function renderChangedFilesSection(
  entries: readonly ChangedFileEntry[],
  priorLines: readonly string[] = [],
): string {
  const byPath = new Map<string, string>();
  for (const line of priorLines) {
    const p = pathFromLine(line);
    if (p) byPath.set(p, line);
  }
  for (const entry of entries) {
    byPath.set(entry.path, renderEntry(entry));
  }

  const lines = [...byPath.values()].slice(0, MAX_CHANGED_FILES);
  if (lines.length === 0) lines.push('- (本次会话还没有改动文件)');
  return `### Changed Files\n${lines.join('\n')}`;
}
