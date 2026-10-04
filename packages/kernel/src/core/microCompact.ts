/**
 * Remove superseded and aged read-only tool results before full compaction.
 *
 * Repeated calls sharing a deduplication key keep their latest result, while
 * old results can be replaced with compact placeholders.
 */

import type { Message } from '../types/index.js';
import { cliLogger } from '../platform/cliLogger.js';
import { estimateTokens } from '../utils/tokenEstimate.js';

/** 可去重的工具集（只读 + 搜索类工具的结果最适合去重） */
const COMPACTABLE_TOOLS = new Set([
  'readfile', 'read_file',
  'search', 'search_files',
  'grep', 'glob',
  'list_directory', 'show_tree',
  'web_search', 'web_fetch',
  'git_status', 'git_diff', 'git_blame',
]);

/** 去重后的占位消息 */
const CLEARED_MESSAGE = '[Previous tool result cleared — superseded by a more recent call to the same tool with similar arguments]';

export interface MicroCompactResult {
  messages: Message[];
  /** 去重清理的消息数 */
  clearedCount: number;
  /** 释放的估算 token 数 */
  freedTokens: number;
}

/**
 * 提取工具调用的去重 key
 * 对于文件操作：tool_name + file_path
 * 对于搜索操作：tool_name + query/pattern
 * 对于其他：tool_name + 参数 hash
 */
function getDedupeKey(toolName: string, toolCallId: string, messages: Message[]): string | null {
  // 找到对应的 assistant message 中的 tool_call
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !msg.tool_calls) continue;
    const tc = msg.tool_calls.find((t: any) => t.id === toolCallId);
    if (!tc) continue;

    try {
      const args = JSON.parse(tc.function?.arguments || '{}');
      /* 范围/定位参数也进 key : 只按路径, "读 1-300 行"和"读 300-600 行"
       * 被当成同一次调用, 后一段把前一段清掉 —— 模型手里只剩后半截, 只能回头重读。
       * 同理 search 同一个词搜不同目录不是重复。 */
      const scope = [
        args.start_line, args.end_line, args.num_lines, args.read_all, args.pages,
        args.ranges ? JSON.stringify(args.ranges) : undefined,
        args.symbol,
      ].filter((v) => v !== undefined && v !== null).join(',');
      const scopeSuffix = scope ? `#${scope}` : '';
      // 多文件读：按整组路径去重
      if (Array.isArray(args.paths) && args.paths.length > 0) {
        return `${toolName}:[${args.paths.join('|')}]${scopeSuffix}`;
      }
      // 搜索操作：按查询 + 范围去重
      if (args.query || args.pattern || args.search) {
        const where = args.path || args.directory || args.file_pattern || args.glob || '';
        return `${toolName}:${args.query || args.pattern || args.search}@${where}${scopeSuffix}`;
      }
      // 文件操作：按路径 + 范围去重
      if (args.file_path || args.path || args.filename) {
        return `${toolName}:${args.file_path || args.path || args.filename}${scopeSuffix}`;
      }
      // 目录操作：按目录去重
      if (args.directory || args.dir) {
        return `${toolName}:${args.directory || args.dir}`;
      }
    } catch (err: any) {
      cliLogger.debug('COMPACT', `Dedup key parse failed: ${err?.message}`);
    }
    break;
  }
  return null;
}

/**
 * Scan compactable tool results, retain recent entries, and clear older
 * duplicates or results beyond the configured turn age.
 *
 * @param messages complete message history
 * @param keepRecent number of recent tool results to preserve
 * @param maxTurnAge clear results older than this many user turns when positive
 */
export function microCompact(
  messages: Message[],
  keepRecent: number = 4,
  maxTurnAge: number = 0,
): MicroCompactResult {
  // 第一遍：收集所有 tool 消息及其 key
  interface ToolEntry {
    index: number;
    key: string;
    toolName: string;
    contentLength: number;
  }

  const toolEntries: ToolEntry[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'tool') continue;

    const toolCallId = (msg as any).tool_call_id || '';
    const toolName = (msg as any).name || '';

    if (!COMPACTABLE_TOOLS.has(toolName)) continue;

    const key = getDedupeKey(toolName, toolCallId, messages);
    if (!key) continue;

    const content = typeof msg.content === 'string' ? msg.content : '';
    toolEntries.push({
      index: i,
      key,
      toolName,
      contentLength: content.length,
    });
  }

  if (toolEntries.length <= keepRecent && maxTurnAge <= 0) {
    return { messages, clearedCount: 0, freedTokens: 0 };
  }

  // 合并清理集合
  const indicesToClear = new Set<number>();

  // Age-based cleanup is independent of duplicate-key matching.
  if (maxTurnAge > 0) {
    let turnCount = 0;
    const turnBoundaries: number[] = []; // 每轮的起始 message index（从后往前）
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        turnCount++;
        turnBoundaries.push(i);
      }
    }
    const ageCutoffIndex = turnCount > maxTurnAge
      ? turnBoundaries[maxTurnAge - 1]
      : -1;

    if (ageCutoffIndex > 0) {
      for (const entry of toolEntries) {
        if (entry.index < ageCutoffIndex) {
          indicesToClear.add(entry.index);
        }
      }
    }
  }

  // === 去重清理（原有逻辑） ===
  // 第二遍：按 key 分组，只保留每个 key 的最后一次出现
  const lastSeenByKey = new Map<string, number>();  // key → toolEntries index
  for (let i = 0; i < toolEntries.length; i++) {
    lastSeenByKey.set(toolEntries[i].key, i);
  }

  // 标记需要清理的条目（不是最后一次 && 不在最近 keepRecent 个之内）
  const recentCutoff = toolEntries.length - keepRecent;

  for (let i = 0; i < toolEntries.length; i++) {
    const entry = toolEntries[i];
    const isLatest = lastSeenByKey.get(entry.key) === i;
    const isRecent = i >= recentCutoff;

    if (!isLatest && !isRecent) {
      indicesToClear.add(entry.index);
    }
  }

  if (indicesToClear.size === 0) {
    return { messages, clearedCount: 0, freedTokens: 0 };
  }

  // 第三遍：替换被清理的消息
  let freedTokens = 0;
  const result = messages.map((msg, i) => {
    if (!indicesToClear.has(i)) return msg;

    const originalContent = typeof msg.content === 'string' ? msg.content : '';
    freedTokens += estimateTokens(originalContent) - estimateTokens(CLEARED_MESSAGE);

    return { ...msg, content: CLEARED_MESSAGE };
  });

  cliLogger.info('MicroCompact', `Cleared ${indicesToClear.size} duplicate tool results (freed ~${(freedTokens / 1000).toFixed(1)}K tokens)`);

  return {
    messages: result,
    clearedCount: indicesToClear.size,
    freedTokens,
  };
}
