/**
 * Runtime Event Handlers
 * Handles events from AgentRuntimeHost and updates UI
 */

import type { InkUIAdapter } from '../ink/InkUIAdapter.js';
import { getLanguage } from '../i18n/index.js';
import type { AgentRuntimeEvent } from '@neoxlabs/core/runtime/agentRuntimeHost.js';
import { handleToolCallStart, handleToolOutput } from '../tools/handlers.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { tokenUsageService, type TokenUsageService } from '@neoxlabs/platform/platform/tokenUsageService.js';
import { getGlobalCostTracker } from '@neoxlabs/platform/platform/costTracker.js';
import { getGlobalRateLimitTracker } from '@neoxlabs/platform/platform/rateLimitTracker.js';
import { getGlobalHealthTracker } from '@neoxlabs/platform/platform/providerHealthState.js';
import { onToolSummaryEvent } from '@neoxlabs/kernel/core/toolSummaryGenerator.js';
import { inferStatusFromTool, getRetryStatus, getCompleteStatus, getErrorStatus, getStreamingStatus, getToolResultStatus } from '../ink/utils/statusInference.js';
import { recordContextUsage, clearContextUsage } from '../ink/contextUsageStore.js';

/**
 * Context for runtime event handling
 */
export interface RuntimeEventContext {
  uiController: InkUIAdapter | null;
  /** Getter for uiController — use this if uiController may be set after context creation */
  getUiController?: () => InkUIAdapter | null;
  lastToolCallArgs: Map<string, Record<string, any>>;
  /** Map toolId -> toolName for aggregation fallback */
  toolIdToName: Map<string, string>;
  toolIdToArgs: Map<string, Record<string, any>>;
  pushTokenStats: (inputTokens: number, outputTokens: number, snapshot?: any, cacheStats?: {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    contextTokens?: number;
  }) => void;
  getRuntimeTokens: () => { input: number; output: number };
  setRuntimeTokens: (input: number, output: number) => void;
  /** Streaming token estimation - getter to always get latest value */
  getStreamingTokenCount?: () => number;
  setStreamingTokenCount?: (count: number) => void;
  /** Provider and model for token usage tracking */
  provider?: string;
  model?: string;
  sessionId?: string;
  tokenUsage?: TokenUsageService;
  /** Track tool streaming state */
  currentStreamingTool?: { name: string; totalChars: number };
  _lastStatusTime?: number;
  /** 已渲染过的 checkpoint id — 同一 checkpoint 事件可能被多路 (本地 + SSE) 重复投递, 去重防重复横幅 */
  _seenCheckpointIds?: Set<string>;
}

/**
 * Estimate token count from text (rough approximation)
 * Based on OpenAI's tiktoken estimates:
 * - English: ~4 chars per token (0.25 tokens per char)
 * - CJK: ~1.5 chars per token (0.67 tokens per char)
 * Note: This is for OUTPUT tokens estimation only
 */
/* 重试详情行的中文化 —— 见 stream_retry 分支的说明。
 * 只翻常见的几条; 认不出的原样透传, 宁可英文也不瞎译。 */
function localizeStreamError(err?: string): string | undefined {
  if (!err || getLanguage() !== 'zh') return err;
  const s = err.trim();

  const stalled = s.match(/^Stream stalled \((\d+)s no data\)$/i);
  if (stalled) return `流卡住了 (${stalled[1]} 秒没有数据)`;

  const table: Record<string, string> = {
    'Stream timeout': '流超时',
    'Network error': '网络中断',
    'Connection reset': '连接被重置',
    'Request timeout': '请求超时',
    'socket hang up': '连接被对端断开',
    'fetch failed': '请求发不出去 (网络或代理问题)',
  };
  for (const [k, v] of Object.entries(table)) {
    if (s.toLowerCase() === k.toLowerCase()) return v;
  }
  return err;
}

function estimateOutputTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    const code = char.codePointAt(0) || 0;
    // CJK characters (Chinese, Japanese, Korean)
    if ((code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3000 && code <= 0x303F) ||
      (code >= 0xFF00 && code <= 0xFFEF) ||
      (code >= 0xAC00 && code <= 0xD7AF)) { // Korean
      tokens += 0.67; // ~1.5 chars per token for CJK
    } else {
      tokens += 0.25; // ~4 chars per token for ASCII
    }
  }
  return Math.ceil(tokens);
}

type StructuredToolResult = {
  type?: string;
  tool?: string;
  status?: string;
  summary?: string;
  content?: string;
  file_path?: string;
  verify_hint?: string;
  error?: string;
};

const STRUCTURED_TOOL_RESULT_TYPES = new Set(['ephemeral', 'contextual', 'summarized']);
const CONTENT_PREVIEW_LINE_LIMITS: Record<string, number> = {
  show_tree: 6,
  list_directory: 6,
  smart_tree: 6,
  tree: 6,
  git_status: 30,
  git_diff: 30,
  git_log: 30,
  git_blame: 30,
  git_branch_list: 30,
  git_branch: 30,
};

function parseStructuredToolResult(output: string): StructuredToolResult | null {
  const trimmed = output.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const resultType = (parsed as StructuredToolResult).type;
    if (typeof resultType !== 'string' || !STRUCTURED_TOOL_RESULT_TYPES.has(resultType)) {
      return null;
    }
    return parsed as StructuredToolResult;
  } catch (err: any) {
    cliLogger.debug('RUNTIME_EVENTS', `Structured result parse failed: ${err?.message}`);
    return null;
  }
}

/* 已知"会自愈"的错误码 → 给人看的友好提示 (CLI 显示层). error 照样显示 (跟 Claude Code 一样),
 * 只是把给 LLM 用的技术原文 (verify_hint / 原始 error code / Path 堆叠) 换成一句人话。
 * LLM 仍从原始 tool 结果拿 verify_hint 自己重读重试 — 这里只动 CLI 显示, 不动喂模型的内容。 */
const FRIENDLY_RECOVERABLE_ERRORS: Record<string, string> = {
  /* 自己前面 edit 造成的行号漂移现在由 edit_file 快照锚点自动消化 (不再误报 stale)。
   * 走到这里的都是真·外部改动 (格式化器 / 另一进程 / 手动改了), 模型会重读最新内容再编辑。 */
  stale_snapshot: '文件已被外部改动（格式化器或其它进程），正在重新读取最新内容后继续',
};

function formatStructuredToolResult(result: StructuredToolResult): string | undefined {
  // 友好化已知自愈错误 — 显示一句人话, 不堆 verify_hint / 原始 code
  if (result.status === 'error' && typeof result.error === 'string') {
    const friendly = FRIENDLY_RECOVERABLE_ERRORS[result.error];
    if (friendly) {
      const base = typeof result.file_path === 'string' && result.file_path.trim()
        ? result.file_path.split(/[\\/]/).pop()
        : '';
      return base ? `${friendly} · ${base}` : friendly;
    }
  }

  const lines: string[] = [];
  if (typeof result.summary === 'string' && result.summary.trim()) {
    lines.push(result.summary.trim());
  }
  if (typeof result.file_path === 'string' && result.file_path.trim()) {
    lines.push(`Path: ${result.file_path}`);
  }
  if (typeof result.verify_hint === 'string' && result.verify_hint.trim()) {
    lines.push(`Verify: ${result.verify_hint}`);
  }
  if (result.status === 'error') {
    const errorText = typeof result.error === 'string' ? result.error.trim() : '';
    if (errorText && (lines.length === 0 || !lines[0].includes(errorText))) {
      lines.push(`Error: ${errorText}`);
    }
  }

  if (result.type === 'contextual' && typeof result.content === 'string' && result.content.trim()) {
    const toolName = typeof result.tool === 'string' ? result.tool.toLowerCase() : '';
    const maxLines = CONTENT_PREVIEW_LINE_LIMITS[toolName];
    if (!maxLines) {
      return lines.length ? lines.join('\n') : undefined;
    }
    const contentLines = result.content
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map(line => line.length > 200 ? `${line.slice(0, 199)}…` : line);
    const clipped = contentLines.slice(0, maxLines);
    if (contentLines.length > maxLines) {
      clipped.push(`... (${contentLines.length - maxLines} more lines)`);
    }
    lines.push(clipped.join('\n'));
  }

  return lines.length ? lines.join('\n') : undefined;
}

function formatGenericJsonToolResult(output: string): string | undefined {
  const trimmed = output.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, any>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }

    const lines: string[] = [];
    if (typeof parsed.summary === 'string' && parsed.summary.trim()) {
      lines.push(parsed.summary.trim());
    } else if (typeof parsed.message === 'string' && parsed.message.trim()) {
      lines.push(parsed.message.trim());
    }

    if (typeof parsed.url === 'string' && parsed.url.trim()) {
      lines.push(`URL: ${parsed.url.trim()}`);
    }

    const stats = parsed.stats;
    if (stats && typeof stats === 'object') {
      if (typeof stats.load_time_ms === 'number') {
        lines.push(`Load: ${stats.load_time_ms}ms`);
      }
      if (typeof stats.network_requests === 'number') {
        lines.push(`Requests: ${stats.network_requests}`);
      }
      if (typeof stats.errors === 'number') {
        lines.push(`Errors: ${stats.errors}`);
      }
    }

    return lines.length > 0 ? lines.join('\n') : undefined;
  } catch (err: any) {
    cliLogger.debug('RUNTIME_EVENTS', `Tool output format failed: ${err?.message}`);
    return undefined;
  }
}

function formatSelectToolsOutput(
  output: string,
  summary: string | undefined,
  outputTruncated: boolean | undefined
): string | undefined {
  const raw = output.replace(/\r\n?/g, '\n').trim();
  if (!raw) {
    return summary;
  }

  type CategoryNode = { label: string; id: string; tools: string[] };
  const categories: CategoryNode[] = [];
  const directTools: string[] = [];
  let activeCategory: CategoryNode | null = null;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === '---' || trimmed === '参数:') continue;

    const categoryMatch = trimmed.match(/^##\s+(.+?)\s+\(([^)]+)\)$/);
    if (categoryMatch) {
      activeCategory = {
        label: categoryMatch[1],
        id: categoryMatch[2],
        tools: [],
      };
      categories.push(activeCategory);
      continue;
    }

    const toolMatch = trimmed.match(/^([a-zA-Z0-9_][\w-]*):\s*(.+)$/);
    if (toolMatch && !line.startsWith(' ')) {
      const toolName = toolMatch[1];
      if (activeCategory) {
        if (!activeCategory.tools.includes(toolName)) {
          activeCategory.tools.push(toolName);
        }
      } else if (!directTools.includes(toolName)) {
        directTools.push(toolName);
      }
    }
  }

  const categoryCount = categories.length;
  const toolCount = categories.reduce((sum, c) => sum + c.tools.length, 0) + directTools.length;
  const header = summary && !summary.startsWith('## ')
    ? summary
    : `${categoryCount} categories, ${toolCount} tools`;

  const lines: string[] = [header];
  const visibleCategories = categories.slice(0, 5);
  const hasMoreCategories = categories.length > visibleCategories.length;

  visibleCategories.forEach((cat, idx) => {
    const isLastVisible = idx === visibleCategories.length - 1 && !hasMoreCategories && directTools.length === 0;
    const branch = isLastVisible ? '└─' : '├─';
    const toolPreview = cat.tools.slice(0, 4).join(', ');
    const extraTools = cat.tools.length > 4 ? ` +${cat.tools.length - 4}` : '';
    lines.push(`${branch} ${cat.label} [${cat.id}] · ${cat.tools.length}${toolPreview ? ` · ${toolPreview}${extraTools}` : ''}`);
  });

  if (hasMoreCategories) {
    const branch = directTools.length > 0 ? '├─' : '└─';
    lines.push(`${branch} … +${categories.length - visibleCategories.length} more categories`);
  }

  if (directTools.length > 0) {
    const preview = directTools.slice(0, 6).join(', ');
    const suffix = directTools.length > 6 ? ` +${directTools.length - 6}` : '';
    lines.push(`└─ tools · ${preview}${suffix}`);
  }

  if (outputTruncated) {
    lines.push('… (truncated)');
  }

  return lines.join('\n');

}

function formatToolCallEndDetail(
  toolName: string,
  output: string | undefined,
  summary: string | undefined,
  outputTruncated: boolean | undefined
): string | undefined {
  const safeSummary = typeof summary === 'string' && summary.trim() ? summary.trim() : undefined;
  if (!output || typeof output !== 'string') {
    return safeSummary;
  }
  const parsed = parseStructuredToolResult(output);
  if (parsed) {
    const formatted = formatStructuredToolResult(parsed);
    return formatted || safeSummary;
  }

  if ((toolName || '').toLowerCase() === 'select_tools') {
    return formatSelectToolsOutput(output, safeSummary, outputTruncated);
  }

  const genericJsonFormatted = formatGenericJsonToolResult(output);
  if (genericJsonFormatted) {
    return genericJsonFormatted;
  }
  const detail = outputTruncated ? `${output}\n...(truncated)` : output;
  return safeSummary ? `${safeSummary}\n\n${detail}` : detail;
}

/**
 * Create runtime event handler function
 * Returns a function that handles AgentRuntimeHost events
 */
export function createRuntimeEventHandler(ctx: RuntimeEventContext): (event: AgentRuntimeEvent) => void {
  onToolSummaryEvent((event) => {
    if (event.type === 'summary_failed') {
      const ui = ctx.getUiController?.() ?? ctx.uiController;
      if (ui) {
        ui.addWarning?.(
          `Tool summary failed: ${event.toolName}`,
          `Model ${event.model} unavailable. ${event.reason || 'Summary skipped, task continues normally.'}`,
        );
      }
    }
  });

  // Track whether error_classified was already shown to avoid duplicate timeline entries
  let errorClassifiedShown = false;
  const recentEventMap = new Map<string, number>();

  const agentTokens = new Map<string, { input: number; output: number }>();
  const agentTasks = new Map<string, string>();
  const workerEntryIds = new Map<string, number>();
  const workerToolHistory = new Map<string, string[]>();

  // Retain last cache stats so memory_snapshot path can carry them
  let lastCacheStats: {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    contextTokens?: number;
  } | undefined;
  interface WorkerToolRecord {
    name: string;
    args?: string;
    startTime: number;
    endTime?: number;
    status: 'running' | 'done' | 'error';
    resultHint?: string;
  }
  const workerToolRecords = new Map<string, WorkerToolRecord[]>();
  const workerStartTimes = new Map<string, number>();
  const workerTaskSummaries = new Map<string, string>();
  const workerRoles = new Map<string, string>();
  const workerToolCounts = new Map<string, number>();
  // 后台 agent (run_in_background) 的 sourceLabel — 来自 worker_start.isBackground。
  // 后台 agent 卡片**整个从主时间线滤掉**(只在底部 N agents 计数 + 主 agent 汇总里体现),
  // 从根上消除"后台卡片乱序"——没有卡片就没有顺序问题 (桌面端同款)。
  const backgroundWorkers = new Set<string>();

  // groupId → entryId (一个分组对应一个 pending entry)
  const exploreGroupEntryId = new Map<string, number>();
  // sourceLabel → groupId (Explorer-1 → "explore_group_1")
  const workerToGroup = new Map<string, string>();
  // groupId → Set<sourceLabel> (分组包含哪些 Explorer)
  const groupMembers = new Map<string, Set<string>>();
  // groupId → 已完成/出错的成员数
  const groupDoneCount = new Map<string, number>();
  const memberDoneStatus = new Map<string, 'completed' | 'error'>();
  let exploreGroupCounter = 0;
  const remoteBgTaskIdToLocalId = new Map<number, number>();

  const richFileCardAt = new Map<string, number>();
  const RICH_FILE_CARD_TTL_MS = 60_000;
  const markRichFileCard = (filePath?: string) => {
    if (filePath) richFileCardAt.set(filePath, Date.now());
  };
  const hasRecentRichFileCard = (filePath?: string): boolean => {
    if (!filePath) return false;
    const at = richFileCardAt.get(filePath);
    if (at === undefined) return false;
    if (Date.now() - at > RICH_FILE_CARD_TTL_MS) {
      richFileCardAt.delete(filePath);
      return false;
    }
    return true;
  };

  // 症状: 并行 explore 的 task_agent_progress 卡片出现在主 agent iter N text 之后(底部),
  // 而正确位置应在 tool_call 发起后、下一轮 text 之前。
  // iter N text 已经 streaming 甚至 commit 完成,id 变大,commit 排序后卡片被甩到末尾。
  // id 反映 tool_call 时刻。任务 Agent ensureWorkerEntry 从 FIFO 消费预占 id。
  const reservedTaskAgentByToolId = new Map<string, number>();
  const reservedTaskAgentTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let reservedTaskAgentOrder: string[] = [];
  // 把占位 entry 移除,防止 UI 卡在 "(preparing...)" 一直转圈。
  const SUBAGENT_RESERVATION_TIMEOUT_MS = 60_000;
  const isDelegateTool = (name: string): string | null => {
    const n = (name || '').toLowerCase();
    if (n === 'explore' || n === 'parallel_explore' || n === 'parallel-explore') return 'Explore';
    if (n === 'agent' || n === 'spawn_agent' || n === 'delegate') return 'Agent';
    if (n === 'task') return 'Task';
    return null;
  };
  const clearReservedTaskAgentTimer = (toolId: string): void => {
    const t = reservedTaskAgentTimers.get(toolId);
    if (t) {
      clearTimeout(t);
      reservedTaskAgentTimers.delete(toolId);
    }
  };
  const reserveTaskAgentForTool = (toolId: string, role: string): void => {
    const ui = ctx.uiController as any;
    if (!ui || typeof ui.reserveTaskAgentEntry !== 'function') {
      cliLogger.info('SUBAGENT_ORDER', `⚠️ RESERVE skipped: ui=${!!ui} hasMethod=${!!(ui && ui.reserveTaskAgentEntry)}`);
      return;
    }
    if (reservedTaskAgentByToolId.has(toolId)) return; // 幂等
    const entryId = ui.reserveTaskAgentEntry({ role, task: 'preparing...' });
    reservedTaskAgentByToolId.set(toolId, entryId);
    reservedTaskAgentOrder.push(toolId);
    cliLogger.info('SUBAGENT_ORDER', `🟢 RESERVE role=${role} toolId=${toolId} entryId=${entryId} queue=[${reservedTaskAgentOrder.join(',')}]`);
    const timer = setTimeout(() => {
      reservedTaskAgentTimers.delete(toolId);
      if (!reservedTaskAgentByToolId.has(toolId)) return;
      reservedTaskAgentByToolId.delete(toolId);
      reservedTaskAgentOrder = reservedTaskAgentOrder.filter(id => id !== toolId);
      const ui2 = ctx.uiController as any;
      if (ui2 && typeof ui2.releaseReservedTaskAgentEntry === 'function') {
        try { ui2.releaseReservedTaskAgentEntry(entryId); } catch {}
      }
      cliLogger.warn('SUBAGENT_ORDER', `⏱️ RESERVE timeout (${SUBAGENT_RESERVATION_TIMEOUT_MS / 1000}s) released entryId=${entryId} toolId=${toolId}`);
    }, SUBAGENT_RESERVATION_TIMEOUT_MS);
    reservedTaskAgentTimers.set(toolId, timer);
  };
  const consumeReservedTaskAgentEntry = (): number | null => {
    while (reservedTaskAgentOrder.length > 0) {
      const toolId = reservedTaskAgentOrder.shift()!;
      const entryId = reservedTaskAgentByToolId.get(toolId);
      if (entryId !== undefined) {
        reservedTaskAgentByToolId.delete(toolId);
        clearReservedTaskAgentTimer(toolId);
        cliLogger.info('SUBAGENT_ORDER', `🟣 CONSUME toolId=${toolId} entryId=${entryId}`);
        return entryId;
      }
    }
    cliLogger.info('SUBAGENT_ORDER', `⚪ CONSUME miss — no reserved entry available`);
    return null;
  };
  const releaseReservedTaskAgentByTool = (toolId: string): void => {
    const entryId = reservedTaskAgentByToolId.get(toolId);
    if (entryId === undefined) return;
    reservedTaskAgentByToolId.delete(toolId);
    reservedTaskAgentOrder = reservedTaskAgentOrder.filter(id => id !== toolId);
    clearReservedTaskAgentTimer(toolId);
    const ui = ctx.uiController as any;
    if (ui && typeof ui.releaseReservedTaskAgentEntry === 'function') {
      ui.releaseReservedTaskAgentEntry(entryId);
    }
  };
  const releaseAllReservedTaskAgents = (): number => {
    let n = 0;
    for (const toolId of Array.from(reservedTaskAgentByToolId.keys())) {
      releaseReservedTaskAgentByTool(toolId);
      n++;
    }
    return n;
  };

  //
  // 为什么要这个:
  //   task-agent 的 run_result / text_complete 信号经常丢(日志里可以反复看到),
  //   导致 card 永远停留在 pending(dynamic 区)转圈,直到主 agent 最后 run_result
  //   才被一锅端清掉。体验上是:主 agent 早就进入下一节点(读文件、grep、输出 Neox 消息),
  //   但底部还有个 ⠋ Explore ×3 漂着,非常诡异。
  //
  // 正确路径:
  //   主 agent 的 tool_call_end(name=explore/agent/task) = "task-agent 已全部完成"
  //   这个信号 100% 可靠(主 agent 收到 tool_result 才会继续)。在这里 force-finalize:
  //     1. taskAgentStatus → 'completed'
  //     2. 成员状态全改 'completed'(UI 显示 ✓)
  //     3. commitTaskAgentEntry 按 id 排序插到 static 正确时间点
  //     4. clearAgentContext 清掉 StatusLine 的 worker 行
  const forceFinalizeActiveTaskAgents = (): number => {
    const ui = ctx.uiController as any;
    if (!ui) return 0;
    let n = 0;

    // ========== 分组 explore (Explorer-N 共享一个 card) ==========
    for (const [gid, entryId] of Array.from(exploreGroupEntryId.entries())) {
      const members = groupMembers.get(gid) || new Set();
      for (const m of members) {
        if (!memberDoneStatus.has(m)) memberDoneStatus.set(m, 'completed');
      }
      // 汇总 group 统计
      let totalTokens = 0;
      let totalToolCount = 0;
      let maxElapsed = 0;
      const finalMembers = Array.from(members).map(label => {
        const tokens = agentTokens.get(label) || { input: 0, output: 0 };
        const startTime = workerStartTimes.get(label) || Date.now();
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const toolCount = workerToolCounts.get(label) || 0;
        const task = workerTaskSummaries.get(label) || '';
        const memberStatus = memberDoneStatus.get(label) || 'completed';
        totalTokens += tokens.input + tokens.output;
        totalToolCount += toolCount;
        if (elapsed > maxElapsed) maxElapsed = elapsed;
        return {
          agentId: label,
          task,
          status: memberStatus as 'running' | 'completed' | 'error',
          toolCount,
          tokens: tokens.input + tokens.output,
          elapsed,
          toolRecords: (workerToolRecords.get(label) || []).map(r => ({
            name: r.name,
            args: r.args,
            status: r.status as 'running' | 'done' | 'error',
            duration: r.endTime ? (r.endTime - r.startTime) / 1000 : undefined,
            resultHint: r.resultHint,
          })),
        };
      });

      if (typeof ui.updateTaskAgentEntry === 'function') {
        ui.updateTaskAgentEntry(entryId, {
          status: 'completed',
          toolCount: totalToolCount,
          tokens: totalTokens,
          elapsed: maxElapsed,
          groupMembers: finalMembers,
        });
      }
      if (typeof ui.commitTaskAgentEntry === 'function') {
        ui.commitTaskAgentEntry(entryId);
      }
      for (const m of members) {
        if (typeof ui.clearAgentContext === 'function') ui.clearAgentContext(m);
        workerToolHistory.delete(m);
        workerToolRecords.delete(m);
        workerStartTimes.delete(m);
        workerToolCounts.delete(m);
        workerRoles.delete(m);
        workerTaskSummaries.delete(m);
        workerToGroup.delete(m);
        memberDoneStatus.delete(m);
      }
      exploreGroupEntryId.delete(gid);
      groupMembers.delete(gid);
      groupDoneCount.delete(gid);
      n++;
    }

    // ========== 独立模式 (Task / Agent 每个一个 card) ==========
    for (const [label, entryId] of Array.from(workerEntryIds.entries())) {
      //   'done'/'aborted' 事件管生命周期。否则会被误标 completed → 底部计数提前归零
      if (backgroundWorkers.has(label)) continue;
      const tokens = agentTokens.get(label) || { input: 0, output: 0 };
      const startTime = workerStartTimes.get(label) || Date.now();
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const toolCount = workerToolCounts.get(label) || 0;
      if (typeof ui.updateTaskAgentEntry === 'function') {
        ui.updateTaskAgentEntry(entryId, {
          status: 'completed',
          toolCount,
          tokens: tokens.input + tokens.output,
          elapsed,
          toolRecords: (workerToolRecords.get(label) || []).map(r => ({
            name: r.name,
            args: r.args,
            status: r.status as 'running' | 'done' | 'error',
            duration: r.endTime ? (r.endTime - r.startTime) / 1000 : undefined,
            resultHint: r.resultHint,
          })),
        });
      }
      if (typeof ui.commitTaskAgentEntry === 'function') {
        ui.commitTaskAgentEntry(entryId);
      }
      if (typeof ui.clearAgentContext === 'function') ui.clearAgentContext(label);
      workerEntryIds.delete(label);
      workerToolHistory.delete(label);
      workerToolRecords.delete(label);
      workerStartTimes.delete(label);
      workerToolCounts.delete(label);
      workerRoles.delete(label);
      workerTaskSummaries.delete(label);
      n++;
    }

    return n;
  };

  // 认为 run_result 信号在途中丢失(SSE 丢包 / sequence dedup 误吞),强制 settle.
  // 不这样干 UI 会卡在 "Generating..." / "Enter to interrupt" 永远不退出。
  // 仍有 task-agent 在跑时不 settle,自动 reschedule 等所有 task-agent 完成。
  let completionWatchdog: ReturnType<typeof setTimeout> | null = null;
  const COMPLETION_WATCHDOG_MS = 3000;
  const clearCompletionWatchdog = () => {
    if (completionWatchdog) {
      clearTimeout(completionWatchdog);
      completionWatchdog = null;
    }
  };
  const hasActiveTaskAgentWork = (): boolean => {
    for (const [gid, members] of groupMembers.entries()) {
      const done = groupDoneCount.get(gid) || 0;
      if (done < members.size) return true;
    }
    if (workerEntryIds.size > 0) return true;
    return false;
  };
  const scheduleCompletionWatchdog = (reason: string) => {
    clearCompletionWatchdog();
    completionWatchdog = setTimeout(() => {
      completionWatchdog = null;
      if (hasActiveTaskAgentWork()) {
        cliLogger.debug('EVENT', `Completion watchdog waiting for task-agents, reschedule (${reason})`);
        scheduleCompletionWatchdog(`${reason} (rescheduled)`);
        return;
      }
      const ui = ctx.uiController;
      if (!ui) return;
      cliLogger.warn('EVENT', `⚠️ run_result signal appears lost (${reason}) — forcing settle`);
      try {
        ui.completeReasoningStreaming?.();
        ui.completeTextStreaming?.();
        if ('commitAllPendingEntries' in ui) {
          (ui as any).commitAllPendingEntries();
        }
        ui.updateStatus?.(getCompleteStatus(), 'complete');
        ui.endTurn?.();
        if ('clearPlanSteps' in ui) {
          (ui as any).clearPlanSteps();
        }
      } catch (err) {
        cliLogger.warn('EVENT', 'Completion watchdog settle failed', { error: (err as any)?.message });
      }
    }, COMPLETION_WATCHDOG_MS);
  };

  const extractArgHint = (toolName: string, args: any): string | undefined => {
    if (!args) return undefined;
    const name = toolName.toLowerCase();
    // 文件读取 — 显示路径（缩短到文件名 + 1 级目录）
    if (name === 'readfile' || name === 'read' || name === 'smart_read' || name === 'read_file') {
      const p = args.file_path || args.path || '';
      if (!p) return undefined;
      // /Users/x/project/src/foo.ts → src/foo.ts
      const parts = p.split('/');
      return parts.length > 2 ? parts.slice(-2).join('/') : p;
    }
    // 搜索 — 显示模式（跳过空模式）
    if (name === 'search' || name === 'search_files' || name === 'grep') {
      const pattern = (args.pattern || args.query || '').substring(0, 35);
      return pattern ? `"${pattern}"` : undefined;
    }
    if (name === 'glob' || name === 'find_files') return args.pattern;
    // 目录树
    if (name === 'smart_tree' || name === 'show_tree' || name === 'list_directory') {
      const p = args.path || args.directory || '.';
      const parts = p.split('/');
      return parts.length > 2 ? parts.slice(-2).join('/') : p;
    }
    // 文件写入/编辑
    if (name === 'write_file' || name === 'write' || name === 'edit_file' || name === 'edit') {
      const p = args.file_path || args.path || '';
      const parts = p.split('/');
      return parts.length > 2 ? parts.slice(-2).join('/') : p;
    }
    if (name === 'bash' || name === 'execute_bash' || name === 'execute_command'
      || name === 'execute_shell' || name === 'shell' || name === 'run_command' || name === 'command_exec') {
      const cmd = args.command || args.cmd || args.script || '';
      return cmd ? cmd.replace(/\s+/g, ' ').trim().substring(0, 50) : undefined;
    }
    // 代码分析
    if (name === 'analyze_code') return args.file_path || args.path;
    // Git
    if (name === 'git_status' || name === 'git_diff' || name === 'git_log') return undefined;
    return undefined;
  };

  const formatK = (n: number): string => {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return n.toString();
  };

  const updateTaskAgentContext = (sourceLabel: string | undefined, updates: {
    status?: 'running' | 'waiting' | 'completed' | 'error';
    currentTask?: string;
    inputTokens?: number;
    outputTokens?: number;
  }) => {
    if (!sourceLabel || !ctx.uiController) return;
    const prev = agentTokens.get(sourceLabel) || { input: 0, output: 0 };
    if (updates.inputTokens !== undefined) prev.input = updates.inputTokens;
    if (updates.outputTokens !== undefined) prev.output = updates.outputTokens;
    agentTokens.set(sourceLabel, prev);
    if (updates.currentTask) agentTasks.set(sourceLabel, updates.currentTask);

    const role = workerRoles.get(sourceLabel);
    const task = workerTaskSummaries.get(sourceLabel);
    const toolCount = workerToolCounts.get(sourceLabel) || 0;
    const startTime = workerStartTimes.get(sourceLabel);
    const elapsed = startTime ? Date.now() - startTime : 0;

    ctx.uiController.updateAgentContext(sourceLabel, {
      agentId: sourceLabel,
      agentLabel: sourceLabel,
      status: updates.status,
      currentTask: task || agentTasks.get(sourceLabel),
      input: prev.input,
      output: prev.output,
      contextWindow: 200000,
      tokensUsedForContext: prev.input,
      pressure: prev.input / 200000,
      workerRole: role,
      workerTask: task,
      toolUseCount: toolCount,
      elapsedMs: elapsed,
    });
  };

  const shouldSkipDuplicateEvent = (event: AgentRuntimeEvent): boolean => {
    let key: string | undefined;
    let windowMs = 800;

    switch (event.type) {
      case 'status':
        key = `status:${event.sourceLabel || ''}:${event.status}:${event.message}`;
        windowMs = 250;
        break;
      case 'log':
        key = `log:${event.sourceLabel || ''}:${event.level}:${event.message}:${event.detail || ''}`;
        windowMs = 1000;
        break;
      case 'error':
        key = `error:${event.sourceLabel || ''}:${event.message}`;
        windowMs = 1200;
        break;
      case 'tool_call_start':
        key = `tool_call_start:${event.sourceLabel || ''}:${event.toolId || ''}:${event.name}:${event.batchId || ''}`;
        windowMs = 1200;
        break;
      case 'tool_call_end':
        key = `tool_call_end:${event.sourceLabel || ''}:${event.toolId || ''}:${event.name}:${event.success}:${event.resultLength || 0}`;
        windowMs = 1200;
        break;
      case 'tool_output': {
        const preview = (event.output || '').slice(0, 200);
        key = `tool_output:${event.sourceLabel || ''}:${event.toolId || ''}:${event.name}:${event.success}:${preview}`;
        windowMs = 1200;
        break;
      }
      case 'run_result':
        key = `run_result:${event.sourceLabel || ''}:${event.iterations || 0}:${event.durationMs || 0}`;
        windowMs = 5000;
        break;
      default:
        break;
    }

    if (!key) {
      return false;
    }

    const now = Date.now();
    const lastAt = recentEventMap.get(key) || 0;
    if (now - lastAt < windowMs) {
      return true;
    }

    recentEventMap.set(key, now);
    if (recentEventMap.size > 1000) {
      const cutoff = now - 10_000;
      for (const [mapKey, timestamp] of recentEventMap.entries()) {
        if (timestamp < cutoff) {
          recentEventMap.delete(mapKey);
        }
      }
    }

    return false;
  };

  return (event: AgentRuntimeEvent) => {
    // ctx.uiController 是快照值，可能是 null；getUiController 总是返回最新值
    if (ctx.getUiController) {
      ctx.uiController = ctx.getUiController();
    }

    //   CLI 不按 sessionId 过滤, 必须跳过, 否则和 Explorer-N 卡片翻倍。
    if ((event as any).__subAgentMirror) return;

    if (process.env.CLI_DEBUG === '1') {
      cliLogger.debug('EVENT', `Received event: type=${event.type} seq=${event.sequence || '?'}`);
    }
    if (event.type === 'tool_call_end') {
      cliLogger.info('EVENT', `🔥 CLIENT received tool_call_end: name=${event.name} toolId=${event.toolId} summary=${(event.summary || '').substring(0, 50)}`);
    }
    if (event.type === 'run_result') {
      cliLogger.info('EVENT', `🔥 CLIENT received run_result: iterations=${event.iterations} tools=${event.toolCalls} tokens=${event.totalTokens} duration=${event.durationMs} failed=${event.failed} seq=${event.sequence || '?'}`);
    }
    if (event.type === 'tool_call_start') {
      cliLogger.info('EVENT', `🔥 CLIENT received tool_call_start: name=${event.name} toolId=${event.toolId} seq=${event.sequence || '?'}`);
    }

    if (!ctx.uiController) {
      cliLogger.warn('EVENT', `⚠️ DROPPED event type=${event.type}: no uiController!`);
      return;
    }

    if (process.env.CLI_DEBUG === '1') {
      if (event.type === 'log') {
        cliLogger.debug('EVENT', `  log message: "${event.message?.substring(0, 50)}..."`);
      } else if (event.type === 'text') {
        cliLogger.debug('EVENT', `  text delta: "${event.delta?.substring(0, 30)}..."`);
      }
    }

    if (shouldSkipDuplicateEvent(event)) {
      if (event.type === 'run_result' || event.type === 'tool_call_start' || event.type === 'tool_call_end') {
        cliLogger.warn('EVENT', `⚠️ DEDUPED ${event.type}: seq=${event.sequence || '?'} name=${'name' in event ? event.name || '' : ''} iterations=${'iterations' in event ? event.iterations || '' : ''}`);
      }
      return;
    }

    // 这样 Main agent 的 timeline 保持干净，task-agent 活动收在 StatusLine 里实时刷新
    if ((event as any).type === 'research_progress') {
      const ui = ctx.uiController as any;
      if (ui && typeof ui.setResearchProgress === 'function') {
        const e = event as any;
        ui.setResearchProgress(e.phase === 'done' ? null : {
          topic: String(e.topic ?? ''),
          scale: String(e.scale ?? ''),
          seeds: Number(e.seeds ?? 0) || undefined,
          dispatched: Number(e.dispatched ?? 0),
          completed: Number(e.completed ?? 0),
          failed: Number(e.failed ?? 0),
          inFlight: Number(e.inFlight ?? 0),
          queued: Number(e.queued ?? 0),
          sources: Number(e.sources ?? 0),
          domains: Number(e.domains ?? 0),
          claims: Number(e.claims ?? 0),
          disputed: Number(e.disputed ?? 0),
        });
      }
      return;
    }

    const sourceLabel = event.sourceLabel;
    const isTaskAgent = !!sourceLabel && sourceLabel !== 'Main';

    if (isTaskAgent) {

      //   记下来 → 这个 agent 的卡片不进主时间线 (见 App dynamicEntries 过滤 + commit 跳过)。
      if ((event as any).isBackground === true) {
        backgroundWorkers.add(sourceLabel);
        const uiBg = ctx.uiController as any;
        if (uiBg && typeof uiBg.markBackgroundAgent === 'function') uiBg.markBackgroundAgent(sourceLabel);
      }

      // 捕获元数据（role/task 从 enriched event 中获取）
      {
        const eventRole = event.workerRole;
        const eventTask = event.workerTask;
        if (eventRole && !workerRoles.has(sourceLabel)) {
          const capitalized = eventRole.charAt(0).toUpperCase() + eventRole.slice(1);
          // Agent 类型加 "Agent" 后缀（如 "Plan" → "Plan Agent"）
          // Explorer 保持原名（如 "Explore"）
          const isAgent = sourceLabel.startsWith('Agent-');
          workerRoles.set(sourceLabel, isAgent ? `${capitalized} Agent` : capitalized);
        }
        if (eventTask && !workerTaskSummaries.has(sourceLabel)) {
          workerTaskSummaries.set(sourceLabel, eventTask);
        }
      }

      const isExplorer = sourceLabel.startsWith('Explorer-');
      const role = workerRoles.get(sourceLabel) || 'Task';

      // ==================== 分组逻辑 ====================
      // Explorer 使用分组模式：多个 Explorer 共享一个 pending entry
      // Task/Worker 使用独立模式：每个 Worker 一个 pending entry

      /** 获取或创建分组 ID（仅 Explorer） */
      const getOrCreateGroupId = (): string | undefined => {
        if (!isExplorer) return undefined;

        // 已有分组
        let gid = workerToGroup.get(sourceLabel);
        if (gid) return gid;

        // 查找是否有活跃的 explore 分组可以加入
        // 条件：分组内还有 running 的成员（说明是同一批并行 explore）
        for (const [existingGid, members] of groupMembers.entries()) {
          // 检查分组是否还活跃（有 running 成员）
          const doneCount = groupDoneCount.get(existingGid) || 0;
          if (doneCount < members.size) {
            // 还有活跃成员，加入这个分组
            gid = existingGid;
            break;
          }
        }

        if (!gid) {
          // 创建新分组
          gid = `explore_group_${++exploreGroupCounter}`;
          groupMembers.set(gid, new Set());
          groupDoneCount.set(gid, 0);
        }

        workerToGroup.set(sourceLabel, gid);
        groupMembers.get(gid)!.add(sourceLabel);
        return gid;
      };

      const groupId = getOrCreateGroupId();

      // 确保该 Worker 有基础数据结构
      const ensureWorkerData = () => {
        if (!workerToolHistory.has(sourceLabel)) {
          workerToolHistory.set(sourceLabel, []);
          workerToolRecords.set(sourceLabel, []);
          workerStartTimes.set(sourceLabel, Date.now());
          workerToolCounts.set(sourceLabel, 0);
        }
      };

      // 确保有 timeline 节点（分组模式用分组 entry，独立模式用独立 entry）
      const ensureWorkerEntry = (): number => {
        ensureWorkerData();

        if (groupId) {
          // 分组模式：共享一个 pending entry
          let entryId = exploreGroupEntryId.get(groupId);
          if (!entryId && ctx.uiController) {
            // 确保 iter 1 的文本在 explore 卡片之前进入 static，而不是之后
            ctx.uiController.completeTextStreaming();
            const reservedId = consumeReservedTaskAgentEntry();
            const ui = ctx.uiController as any;
            if (reservedId !== null && typeof ui.fillReservedTaskAgentEntry === 'function') {
              ui.fillReservedTaskAgentEntry(reservedId, {
                agentId: groupId,
                role: 'Explore',
                task: 'parallel explore',
              });
              entryId = reservedId;
            } else {
              entryId = ctx.uiController.addTaskAgentEntry({
                agentId: groupId,
                role: 'Explore',
                task: 'parallel explore',
                sourceLabel: 'Main',
              });
            }
            exploreGroupEntryId.set(groupId, entryId);
          }
          return entryId || 0;
        } else {
          // 独立模式
          let entryId = workerEntryIds.get(sourceLabel);
          if (!entryId && ctx.uiController) {
            ctx.uiController.completeTextStreaming();
            const task = workerTaskSummaries.get(sourceLabel) || 'starting...';
            const reservedId = consumeReservedTaskAgentEntry();
            const ui = ctx.uiController as any;
            const kind = backgroundWorkers.has(sourceLabel) ? 'background' : undefined;
            if (reservedId !== null && typeof ui.fillReservedTaskAgentEntry === 'function') {
              ui.fillReservedTaskAgentEntry(reservedId, {
                agentId: sourceLabel,
                role,
                task,
                kind,
              });
              entryId = reservedId;
            } else {
              entryId = ctx.uiController.addTaskAgentEntry({
                agentId: sourceLabel,
                role,
                task,
                sourceLabel: 'Main',
                kind,
              });
            }
            workerEntryIds.set(sourceLabel, entryId);
          }
          return entryId || 0;
        }
      };

      const buildToolRecords = (label?: string) => {
        const records = workerToolRecords.get(label || sourceLabel) || [];
        return records.map(r => ({
          name: r.name,
          args: r.args,
          status: r.status as 'running' | 'done' | 'error',
          duration: r.endTime ? (r.endTime - r.startTime) / 1000 : undefined,
          resultHint: r.resultHint,
        }));
      };

      const buildGroupMembers = () => {
        if (!groupId) return undefined;
        const members = groupMembers.get(groupId);
        if (!members || members.size <= 1) return undefined; // 单个不需要分组显示

        return Array.from(members).map(label => {
          const tokens = agentTokens.get(label) || { input: 0, output: 0 };
          const startTime = workerStartTimes.get(label) || Date.now();
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          const toolCount = workerToolCounts.get(label) || 0;
          const task = workerTaskSummaries.get(label) || '';
          // 导致已完成的成员在 buildGroupMembers 中永远显示为 'running'
          const memberStatus: 'running' | 'completed' | 'error' = memberDoneStatus.get(label) || 'running';

          return {
            agentId: label,
            task,
            status: memberStatus,
            toolCount,
            tokens: tokens.input + tokens.output,
            elapsed,
            toolRecords: buildToolRecords(label),
          };
        });
      };

      const updateWorkerEntry = (currentTool?: string, isDone?: boolean) => {
        const entryId = ensureWorkerEntry();
        if (!entryId || !ctx.uiController) return;

        if (groupId) {
          // 分组模式：聚合所有成员的统计
          const members = groupMembers.get(groupId) || new Set();
          let totalTokens = 0;
          let totalToolCount = 0;
          let maxElapsed = 0;
          for (const label of members) {
            const tokens = agentTokens.get(label) || { input: 0, output: 0 };
            totalTokens += tokens.input + tokens.output;
            totalToolCount += workerToolCounts.get(label) || 0;
            const startTime = workerStartTimes.get(label) || Date.now();
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            if (elapsed > maxElapsed) maxElapsed = elapsed;
          }

          const doneCount = groupDoneCount.get(groupId) || 0;
          const allDone = doneCount >= members.size;

          ctx.uiController.updateTaskAgentEntry(entryId, {
            status: allDone ? 'completed' : 'running',
            toolCount: totalToolCount,
            tokens: totalTokens,
            elapsed: maxElapsed,
            groupMembers: buildGroupMembers(),
          });
        } else {
          // 独立模式
          const tokens = agentTokens.get(sourceLabel) || { input: 0, output: 0 };
          const startTime = workerStartTimes.get(sourceLabel) || Date.now();
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          const totalTokens = tokens.input + tokens.output;
          const toolCount = workerToolCounts.get(sourceLabel) || 0;

          ctx.uiController.updateTaskAgentEntry(entryId, {
            status: isDone ? 'completed' : 'running',
            toolCount,
            tokens: totalTokens,
            elapsed,
            toolRecords: buildToolRecords(),
          });
        }
      };

      const cleanupWorker = (label: string) => {
        workerToolHistory.delete(label);
        workerToolRecords.delete(label);
        workerStartTimes.delete(label);
        workerToolCounts.delete(label);
        workerRoles.delete(label);
        workerTaskSummaries.delete(label);
      };

      const handleGroupMemberDone = (label: string, isError: boolean) => {
        if (!groupId) return;
        memberDoneStatus.set(label, isError ? 'error' : 'completed');
        const doneCount = (groupDoneCount.get(groupId) || 0) + 1;
        groupDoneCount.set(groupId, doneCount);
        const members = groupMembers.get(groupId) || new Set();

        if (doneCount >= members.size) {
          ctx.uiController?.updateStatus('Explore complete', 'explore_complete');

          // 所有成员完成 — 更新并提交分组 entry
          updateWorkerEntry(undefined, true);
          const entryId = exploreGroupEntryId.get(groupId);
          if (entryId && ctx.uiController) {
            ctx.uiController.commitTaskAgentEntry(entryId);
          }
          // 清理分组数据
          for (const m of members) {
            cleanupWorker(m);
            workerToGroup.delete(m);
            memberDoneStatus.delete(m);
            ctx.uiController?.clearAgentContext(m);
          }
          exploreGroupEntryId.delete(groupId);
          groupMembers.delete(groupId);
          groupDoneCount.delete(groupId);
        } else {
          // 还有成员在运行 — 只更新分组显示
          updateWorkerEntry();
        }
      };

      switch (event.type) {
        case 'tool_call_start': {
          ensureWorkerData();
          // 工具链历史
          const history = workerToolHistory.get(sourceLabel) || [];
          history.push(event.name);
          if (history.length > 12) history.shift();
          workerToolHistory.set(sourceLabel, history);

          // 详细记录
          const records = workerToolRecords.get(sourceLabel) || [];
          const argHint = extractArgHint(event.name, event.args);
          records.push({
            name: event.name,
            args: argHint,
            startTime: Date.now(),
            status: 'running',
          });
          if (records.length > 12) records.shift();
          workerToolRecords.set(sourceLabel, records);

          workerToolCounts.set(sourceLabel, (workerToolCounts.get(sourceLabel) || 0) + 1);

          updateTaskAgentContext(sourceLabel, { status: 'running', currentTask: event.name });
          updateWorkerEntry(event.name);
          break;
        }
        case 'tool_call_end': {
          const records = workerToolRecords.get(sourceLabel) || [];
          for (let i = records.length - 1; i >= 0; i--) {
            if (records[i].name === event.name && records[i].status === 'running') {
              records[i].status = event.success ? 'done' : 'error';
              records[i].endTime = Date.now();
              if (event.resultLength) {
                records[i].resultHint = `(${event.resultLength} chars)`;
              } else if (event.summary) {
                records[i].resultHint = event.summary.substring(0, 30);
              }
              break;
            }
          }
          updateTaskAgentContext(sourceLabel, { status: 'running', currentTask: `✓ ${event.name}` });
          updateWorkerEntry(`✓ ${event.name}`);
          break;
        }
        case 'token_usage': {
          updateTaskAgentContext(sourceLabel, {
            status: 'running',
            inputTokens: event.sessionPromptTokens,
            outputTokens: event.sessionCompletionTokens,
          });
          updateWorkerEntry();
          // Sub-agent token 也记录到持久化存储
          if (ctx.provider && ctx.model) {
            const usageService = ctx.tokenUsage ?? tokenUsageService;
            usageService.recordUsage({
              timestamp: Date.now(),
              provider: ctx.provider,
              model: ctx.model,
              inputTokens: event.promptTokens || 0,
              outputTokens: event.completionTokens || 0,
              totalTokens: (event.promptTokens || 0) + (event.completionTokens || 0),
              cachedTokens: event.cachedTokens || 0,
              openaiCachedTokens: event.openaiCachedTokens || 0,
              anthropicCacheReadTokens: event.anthropicCacheReadTokens || 0,
              anthropicCacheCreationTokens: event.anthropicCacheCreationTokens || 0,
              duration: event.duration || 0,
              success: true,
              sessionId: ctx.sessionId,
              requestType: 'chat',
            }).catch((error) => {
              cliLogger.warn('TOKEN_USAGE', 'Failed to persist task-agent token usage', {
                sourceLabel,
                provider: ctx.provider,
                model: ctx.model,
                message: error instanceof Error ? error.message : String(error),
              });
            });

            getGlobalCostTracker().recordRequest({
              model: ctx.model,
              provider: ctx.provider,
              inputTokens: event.promptTokens || 0,
              outputTokens: event.completionTokens || 0,
              cachedTokens: event.cachedTokens || 0,
            });

            getGlobalRateLimitTracker().recordRequest(
              ctx.provider || 'unknown',
              ctx.model || 'unknown',
              (event.promptTokens || 0) + (event.completionTokens || 0),
            );
          }
          break;
        }
        case 'run_result':
          updateTaskAgentContext(sourceLabel, { status: 'completed', currentTask: 'Done' });
          if (groupId) {
            ctx.uiController?.clearAgentContext(sourceLabel);
            handleGroupMemberDone(sourceLabel, false);
          } else {
            // 独立模式：直接提交
            updateWorkerEntry(undefined, true);
            if (ctx.uiController) {
              const entryId = workerEntryIds.get(sourceLabel);
              if (entryId) ctx.uiController.commitTaskAgentEntry(entryId);
              ctx.uiController.clearAgentContext(sourceLabel);
            }
            workerEntryIds.delete(sourceLabel);
            cleanupWorker(sourceLabel);
          }
          break;
        case 'error':
          updateTaskAgentContext(sourceLabel, { status: 'error', currentTask: event.message?.substring(0, 40) });

          if (groupId) {
            ctx.uiController?.clearAgentContext(sourceLabel);
            handleGroupMemberDone(sourceLabel, true);
          } else {
            // 独立模式
            if (ctx.uiController) {
              const entryId = workerEntryIds.get(sourceLabel);
              if (entryId) {
                ctx.uiController.updateTaskAgentEntry(entryId, {
                  status: 'error',
                  toolRecords: buildToolRecords(),
                });
                ctx.uiController.commitTaskAgentEntry(entryId);
              }
              ctx.uiController.clearAgentContext(sourceLabel);
            }
            workerEntryIds.delete(sourceLabel);
            cleanupWorker(sourceLabel);
          }
          break;
        default:
          break;
      }
      return;
    }

    //   union 里, 故在 switch 前用字符串判)。底部 "N agents" 计数的权威来源:
    //   done/aborted → 从 sidebarAgents 移除该 agent → 计数实时下降、完成后归零 (修"3 agents 不消失")。
    if ((event.type as string) === 'sub_agent') {
      const sa = event as any;
      if (sa.agentId && (sa.action === 'done' || sa.action === 'aborted')) {
        const uiSa = ctx.uiController as any;
        if (uiSa && typeof uiSa.removeSidebarAgentById === 'function') uiSa.removeSidebarAgentById(sa.agentId);
      }
      return;
    }

    switch (event.type) {
      case 'status':
        // Writing status fires very frequently; update at most every 120ms.
        if (/^Writing\s+.+\s+(·|\()\s*\d+\s+lines/i.test(event.message) || event.message.includes(' lines)...')) {
          const now = Date.now();
          const lastUpdate = ctx._lastStatusTime || 0;
          if (now - lastUpdate < 120) {
            break;
          }
          ctx._lastStatusTime = now;
        }
        /* 运行时每 5s 的心跳 ("Tool is running... 8s" / "Waiting for response... 3s") 不覆盖状态行:
         * CLI 已经知道此刻在跑哪个工具 ("Running node -e …"), 用时状态行自己计。
         * 只有"慢了"那几档 (API responding slowly / taking long / Long wait) 才值得让用户看见。 */
        if (/^(Tool is running|Tool chain in progress|Waiting for response)\.\.\. \d+s$/.test(event.message || '')) break;
        ctx.uiController.updateStatus(event.message, event.status);
        break;
      case 'log':
        // 输出到 CLI logger
        if (event.level === 'error') {
          cliLogger.error('AGENT', event.message, event.detail ? { detail: event.detail } : undefined);
        } else if (event.level === 'warn') {
          cliLogger.warn('AGENT', event.message, event.detail ? { detail: event.detail } : undefined);
        } else {
          cliLogger.info('AGENT', event.message, event.detail ? { detail: event.detail } : undefined);
        }
        // 过滤 "Task complete" — run_result 已经显示完成信息，避免重复
        if (event.message === 'Task complete') break;
        // 显示到 Timeline（传递 sourceLabel）
        ctx.uiController.addInfo(event.message, event.detail, 'info', event.sourceLabel);
        break;
      case 'compacting':
        cliLogger.info('AGENT', `[Compacting] ${event.message}`, event.detail ? { detail: event.detail } : undefined);
        // 显示专属压缩卡片
        ctx.uiController.addCompacting(event.message, event.detail);
        break;
      case 'context_compaction': {
        // 压缩完成后刷新 StatusLine ctx —— 桌面端同源修复
        const compactionStatus = (event as any).status;
        if (compactionStatus && compactionStatus !== 'completed') break;
        clearContextUsage();  // 压过了, 上一轮的分类作废
        const finalTokens = (event as any).finalTokens;
        if (typeof finalTokens === 'number' && finalTokens >= 0 && ctx.uiController?.setTokenStats) {
          const prev = ctx.uiController.getTokenStats?.() as
            | { inputTokens?: number; outputTokens?: number; contextWindow?: number }
            | undefined;
          const contextWindow = prev?.contextWindow
            || (event as any).budgetTokens
            || 0;
          ctx.uiController.setTokenStats(
            Math.min(prev?.inputTokens ?? finalTokens, finalTokens),
            prev?.outputTokens ?? 0,
            {
              tokensUsedForContext: finalTokens,
              contextWindow: contextWindow || undefined,
              cacheReadTokens: 0,
              /* TokenStats 里这个字段叫 cacheCreationTokens —— 原先写 cacheWriteTokens,
               * 字段名不存在, 压缩后缓存写入计数根本没被清零 */
              cacheCreationTokens: 0,
            },
          );
          cliLogger.info('AGENT', `[Compaction] refreshed ctx → ${finalTokens} tokens`);
        }
        break;
      }
      case 'thinking':
        // Status bar already shows thinking state, no need for timeline node
        // ctx.uiController.addThinking(event.iteration);
        // Reset error tracking for new iteration
        errorClassifiedShown = false;
        break;
      case 'reasoning':
        ctx.uiController.addReasoningDelta(event.delta, event.sourceLabel);
        // Estimate tokens during streaming
        if (ctx.setStreamingTokenCount && ctx.getStreamingTokenCount && event.delta) {
          const currentCount = ctx.getStreamingTokenCount();
          const deltaTokens = estimateOutputTokens(event.delta);
          ctx.setStreamingTokenCount(currentCount + deltaTokens);
          ctx.uiController.updateTaskTokens(currentCount + deltaTokens);
        }
        break;
      case 'reasoning_complete':
        // Immediately render Reasoning block when thinking content_block stops
        ctx.uiController.completeReasoningStreaming(event.sourceLabel);
        break;
      case 'text':
        if (process.env.CLI_DEBUG === '1') {
          cliLogger.debug('EVENT', `  text delta received: "${event.delta?.substring(0, 50)}..." (len=${event.delta?.length})`);
        }
        if (!event.sourceLabel || event.sourceLabel === 'Main') {
          clearCompletionWatchdog();
        }
        ctx.uiController.addTextDelta(event.delta, event.sourceLabel);
        // Estimate tokens during streaming
        if (ctx.setStreamingTokenCount && ctx.getStreamingTokenCount && event.delta) {
          const currentCount = ctx.getStreamingTokenCount();
          const deltaTokens = estimateOutputTokens(event.delta);
          ctx.setStreamingTokenCount(currentCount + deltaTokens);
          ctx.uiController.updateTaskTokens(currentCount + deltaTokens);
        }
        break;
      case 'text_complete':
        if (process.env.CLI_DEBUG === '1') {
          cliLogger.debug('EVENT', `  text_complete received`);
        }
        // First flush reasoning (it should appear before assistant response)
        ctx.uiController.completeReasoningStreaming(event.sourceLabel);
        // Then complete text streaming
        ctx.uiController.completeTextStreaming(event.sourceLabel);
        // Clear stale tool streaming status (can happen when provider emits deltas without a final tool end)
        if (ctx.currentStreamingTool) {
          ctx.currentStreamingTool = undefined;
          ctx.uiController.updateStatus('', 'info');
        }
        // 模型卡几秒再 emit tool_call_start"这种正常节奏会误判为 run_result 丢失,
        // 提前把 UI 切到 Ready(用户输入后 3s 直接 Ready 没任何回复 = 这个 bug)。
        // 不启动 watchdog —— 如果将来真要防 run_result 丢失,要改成"settle 请求时反向
        // 检查 hasAssistantPendingWork"(Electron 端那种),而不是 timer 主动触发。
        break;
      case 'tool_call_start': {
        if (!event.sourceLabel || event.sourceLabel === 'Main') {
          clearCompletionWatchdog();
        }
        // Flush text streaming BEFORE tool cards to ensure correct timeline order
        ctx.uiController.completeTextStreaming(event.sourceLabel);

        // Flush reasoning before tool cards so it appears earlier in timeline
        ctx.uiController.completeReasoningStreaming(event.sourceLabel);

        // task_agent_progress pending entry, 保证 id 反映 tool_call 时刻。
        // 任务 Agent 首事件到达时 ensureWorkerEntry 会 FIFO 消费它,卡片就能排到
        // "tool_call 之后、下一轮 text 之前"的正确位置。
        // NOTE: 不依赖 event.toolId(可能 undefined),用 name+timestamp fallback 作为 key。
        if (!event.sourceLabel || event.sourceLabel === 'Main') {
          const role = isDelegateTool(event.name);
          cliLogger.info('SUBAGENT_ORDER', `🔧 MAIN tool_call_start name=${event.name} role=${role} eventToolId=${event.toolId}`);
          if (role) {
            const key = event.toolId || `${event.name}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            reserveTaskAgentForTool(key, role);
          }
        }

        ctx.currentStreamingTool = { name: event.name, totalChars: 0 };

        // Generate a toolId for aggregation (prefer event.toolId, fallback to name+timestamp)
        const toolId = event.toolId || `${event.name}_${Math.floor(Date.now())}_${Math.random().toString(36).slice(2, 7)}`;
        ctx.toolIdToName.set(toolId, event.name);

        // Save args by toolId to prevent overwriting during parallel calls
        if (ctx.toolIdToArgs) {
          ctx.toolIdToArgs.set(toolId, event.args || {});
        }
        // 保留旧的方式作为 fallback（兼容性）
        ctx.lastToolCallArgs.set(event.name, event.args || {});

        // 根据工具类型显示不同的卡片
        // Use aggregated method for all tools
        handleToolCallStartWithAggregation(ctx.uiController, toolId, event.name, event.args || {}, {
          targetPath: event.targetPath,
          description: event.description,
          sourceLabel: event.sourceLabel,
          viaCallTool: event.viaCallTool,
        });

        updateTaskAgentContext(event.sourceLabel, {
          status: 'running',
          currentTask: event.name,
        });
        break;
      }
      case 'tool_call_delta':
        // Keep deltas out of the timeline to avoid noise; surface progress in status/debug.
        if (process.env.CLI_DEBUG) {
          cliLogger.debug('EVENT', `tool_call_delta: ${event.name} +${event.argumentsDelta.length} chars`);
        }

        // Ignore orphan deltas unless we have an active running tool entry.
        const runningToolId = ctx.uiController.resolveRunningToolIdByName(
          event.name,
          event.sourceLabel
        );
        if (!runningToolId || !ctx.uiController.getRunningToolLogId(runningToolId)) {
          if (process.env.CLI_DEBUG === '1') {
            cliLogger.debug('EVENT', `ignore orphan tool_call_delta for ${event.name}`);
          }
          break;
        }

        if (!ctx.currentStreamingTool || ctx.currentStreamingTool.name !== event.name) {
          // Initialize tracking for this tool
          ctx.currentStreamingTool = { name: event.name, totalChars: 0 };
        }

        // Accumulate chars
        ctx.currentStreamingTool.totalChars += event.argumentsDelta.length;

        // 写文件类工具的状态由 file_stream 事件独占 ("Writing <file> · N lines"), 这里不再
        // 另发 "Streaming: write_file (N chars)" — 否则两条 status 交替刷新 → 状态栏闪烁。
        {
          const tn = (event.name || '').toLowerCase();
          if (tn === 'write_file' || tn === 'write') break;
        }
        // Update status bar to show streaming progress (using dynamic status)
        const streamingStatus = event.name === 'query_agent'
          ? 'Querying worker status...'
          : getStreamingStatus(event.name, ctx.currentStreamingTool.totalChars);
        ctx.uiController.updateStatus(streamingStatus, 'tool_call');
        break;
      case 'tool_call_end': {
        ctx.currentStreamingTool = undefined;

        // (任务 Agent 从未发出首事件 — 比如工具失败 / 工具参数错 / 工具没真的 spawn 任务 Agent)
        if ((!event.sourceLabel || event.sourceLabel === 'Main') && event.toolId && isDelegateTool(event.name)) {
          releaseReservedTaskAgentByTool(event.toolId);
          // 这是可靠信号(比 sub 的 run_result 靠谱 —— 那个经常丢),
          // force-finalize 活跃的 task-agent card/worker,把它们从 pending 提交到 static
          // 正确时间位置,同时从 StatusLine 清掉,避免"底部转圈幽灵"。
          const finalized = forceFinalizeActiveTaskAgents();
          if (finalized > 0) {
            cliLogger.info('SUBAGENT_ORDER', `⚡ tool_call_end(${event.name}) force-finalized ${finalized} active task-agent card(s)`);
          }
        }

        // Use toolId from event for aggregation
        const toolId = event.toolId;
        let resolvedToolId: string | undefined = toolId;
        if (!resolvedToolId || !ctx.uiController.getRunningToolLogId(resolvedToolId)) {
          resolvedToolId = ctx.uiController.resolveRunningToolIdByName(
            event.name,
            event.sourceLabel
          );
        }
        const normalizedName = (event.name || '').toLowerCase();
        const suppressDetailOutput =
          normalizedName === 'readfile' ||
          normalizedName === 'search';
        /* BashOutput: 结果是 JSON, 卡片要解析字段 (状态/退出码/输出尾巴) —— 给完整原文, 不给截断的 summary */
        const isBashOutputJson = /^(bash_output|bashoutput|taskoutput)$/.test(normalizedName)
          && typeof event.output === 'string' && event.output.trim().startsWith('{');
        const combinedDetail = isBashOutputJson
          ? (event.output as string).trim()
          : suppressDetailOutput
          ? event.summary
          : formatToolCallEndDetail(
            event.name,
            typeof event.output === 'string' ? event.output : undefined,
            event.summary,
            event.outputTruncated
          );

        const hasRunningEntry = !!(resolvedToolId && ctx.uiController.getRunningToolLogId(resolvedToolId));

        if (hasRunningEntry && resolvedToolId) {
          // Aggregated mode: update existing node in-place
          ctx.uiController.completeToolCall(resolvedToolId, {
            success: event.success,
            duration: event.duration,
            resultLength: event.resultLength,
            outputTruncated: event.outputTruncated,
            summary: combinedDetail,
            error: event.success ? undefined : (combinedDetail || event.output || event.summary),
          });
        }

        if (!hasRunningEntry && isStreamManagedFileTool(normalizedName)) {
          if (!event.success) {
            const errorText = combinedDetail || event.output || event.summary || `${event.name} failed`;
            ctx.uiController.addError(`Tool ${event.name} failed`, errorText);
          } else {
            const fallbackArgs = (event.args || {}) as Record<string, any>;
            const filePath = fallbackArgs.file_path || fallbackArgs.filePath || fallbackArgs.path;
            const content = typeof fallbackArgs.content === 'string' ? fallbackArgs.content : undefined;

            // write_file_stream may be absent if upstream tool metadata mapping is lost.
            // Fallback to a static file_update entry so users still see write/edit result.
            if ((normalizedName === 'write_file' || normalizedName === 'write') && filePath && content !== undefined) {
              // Normal path should emit write_file_stream shortly after tool_call_end.
              // Avoid duplicate file cards here.
            } else if ((normalizedName === 'edit_file' || normalizedName === 'edit') && filePath) {
            } else if (typeof event.summary === 'string' && event.summary.trim()) {
              ctx.uiController.addInfo(event.summary);
            }
          }
        }
        // Specialized tools (search, glob, readfile, etc.) already create their own cards
        // via handleToolOutput, so we don't need the info summary anymore

        // NOTE: Do not clean toolId->name mapping here.
        // tool_output arrives after tool_call_end and still needs toolId mapping
        // to resolve real tool names (especially call_tool unwrapped flows).


        ctx.uiController.updateStatus(
          getToolResultStatus(event.name, event.success, event.resultLength),
          event.success ? 'tool_result' : 'error'
        );

        updateTaskAgentContext(event.sourceLabel, {
          status: 'running',
          currentTask: `✓ ${event.name}`,
        });
        break;
      }
      case 'tool_output': {
        // First try to get args by toolId (for parallel calls)
        const eventToolId = event.toolId;
        let toolArgs: Record<string, any> | undefined;

        if (eventToolId && ctx.toolIdToArgs) {
          toolArgs = ctx.toolIdToArgs.get(eventToolId);
        }

        // Fallback: 如果没有 toolId 或找不到，尝试通过工具名查找最近的 toolId
        if (!toolArgs) {
          // Find the most recent toolId for this tool name
          for (const [tid, tname] of ctx.toolIdToName.entries()) {
            if (tname === event.name && ctx.toolIdToArgs) {
              toolArgs = ctx.toolIdToArgs.get(tid);
              if (toolArgs) break;
            }
          }
        }

        // Fallback: 使用旧的方式（兼容性）
        if (!toolArgs) {
          toolArgs = ctx.lastToolCallArgs.get(event.name);
        }

        // call_tool 解包链路：优先用 toolId 找到真实工具名
        const resolvedName = (eventToolId ? ctx.toolIdToName.get(eventToolId) : undefined) || event.name;
        const runningIdForOutput = ctx.uiController.resolveRunningToolIdByName(
          resolvedName,
          event.sourceLabel
        );
        const hasRunningForOutput = !!(runningIdForOutput && ctx.uiController.getRunningToolLogId(runningIdForOutput));

        // Clear stale streaming tool status if output arrives without a running entry.
        if (!hasRunningForOutput && ctx.currentStreamingTool && ctx.currentStreamingTool.name === resolvedName) {
          ctx.currentStreamingTool = undefined;
          ctx.uiController.updateStatus('', 'info');
        }

        // Check if this tool uses specialized display (which creates its own nodes)
        const normalizedName = resolvedName.toLowerCase();
        const usesSpecializedDisplay = isSpecializedDisplayTool(normalizedName);

        // Generic aggregated tools are already finalized in tool_call_end.
        // Ignore their trailing tool_output to avoid duplicate late cards.
        if (!hasRunningForOutput && !usesSpecializedDisplay) {
          if (process.env.CLI_DEBUG === '1') {
            cliLogger.debug('EVENT', `skip trailing tool_output for aggregated tool: ${resolvedName}`);
          }
        } else if (usesSpecializedDisplay) {
          // 根据工具类型显示不同的卡片 (creates separate nodes)
          const toolArgsWithId = eventToolId ? { ...(toolArgs || {}), __toolId: eventToolId } : toolArgs;
          handleToolOutput(
            ctx.uiController,
            resolvedName,
            event.output,
            event.success,
            toolArgsWithId,
            event.sourceLabel
          );
        } else {
          // For generic tools, find the running tool by name and update in-place
          // Since tool_output doesn't have toolId, we use a workaround:
          // Find the most recent toolId for this tool name
          let foundToolId: string | undefined;
          for (const [tid, tname] of ctx.toolIdToName.entries()) {
            if (tname === resolvedName) {
              foundToolId = tid;
              break;
            }
          }

          if (foundToolId && ctx.uiController.getRunningToolLogId(foundToolId)) {
            // Update existing node
            ctx.uiController.updateToolCallOutput(foundToolId, event.output, {
              truncated: event.output.length > 2000,
            });
          }
        }

        if (eventToolId) {
          ctx.toolIdToName.delete(eventToolId);
        }

        if (eventToolId && ctx.toolIdToArgs) {
          ctx.toolIdToArgs.delete(eventToolId);
        }
        // 清理旧的参数缓存（兼容性）
        ctx.lastToolCallArgs.delete(event.name);
        if (resolvedName !== event.name) {
          ctx.lastToolCallArgs.delete(resolvedName);
        }
        break;
      }
      case 'file_stream':
        // 只在完成时显示最终内容，流式过程中只更新状态栏
        if (event.isComplete) {
          // write_file_stream/edit_file_stream 已经出过带 diff 的正经卡 → 别再补一张光杆的
          if (!hasRecentRichFileCard(event.filePath)) {
            ctx.uiController.completeCodeGenerationPreview(event.filePath, event.content);
          }
        } else {
          // 流式过程中只更新状态栏，不添加 timeline entry。
          // 写文件状态的**唯一**来源 (agentRuntimeHost 不再另 emit "Generating X.XKB", 避免两条 status
          // 交替闪烁)。显示文件名 (非整路径, 不撑行) + 单调增长的真实行数。
          const lines = event.content.split('\n').length;
          const base = event.filePath.split(/[\\/]/).pop() || event.filePath;
          ctx.uiController.updateStatus(`Writing ${base} · ${lines} lines`, 'tool_call');
        }
        break;
      case 'edit_file_stream':
        // 只在完成时显示 diff，避免重复渲染
        if (event.isComplete) {
          markRichFileCard(event.filePath);
          ctx.uiController.startEditFile(
            event.filePath,
            event.language || '',
            event.oldString,
            event.newString,
            event.startLine,
            event.description,
            event.hunks
          );
        }
        break;
      case 'write_file_stream':
        // 显示创建的新文件内容
        if (event.isComplete) {
          markRichFileCard(event.filePath);
          ctx.uiController.startWriteFile(
            event.filePath,
            event.language || '',
            event.content,
            event.description
          );
        }
        break;
      case 'token_usage': {
        const sourceLabel = event.sourceLabel;
        const isTaskAgent = sourceLabel && sourceLabel !== 'Main';

        if (!isTaskAgent) {
          const tokens = { input: event.promptTokens, output: event.completionTokens };
          ctx.setRuntimeTokens(tokens.input, tokens.output);

          const taskTokens = (event.contextTokens || event.promptTokens) + event.completionTokens;
          ctx.uiController?.updateTaskTokens(taskTokens, true);

          // 归一化后的 cache stats（直接用源头字段）
          const cacheStats = {
            cacheReadTokens: event.cacheReadTokens,
            cacheWriteTokens: event.cacheWriteTokens,
            contextTokens: event.contextTokens,
          };
          lastCacheStats = cacheStats;
          /* 上下文面板的分类 + 本轮输入/缓存/输出 (worker 自带的 breakdown, 见 ink/contextUsageStore) */
          recordContextUsage(event as any);

          const minimalSnapshot = {
            promptTokens: event.contextTokens || event.promptTokens,
            completionTokens: event.completionTokens,
            tokensUsed: event.totalTokens,
          };

          ctx.pushTokenStats(tokens.input, tokens.output, minimalSnapshot, cacheStats);
        }

        if (process.env.CLI_DEBUG) {
          cliLogger.debug('MAIN', `token_usage: source=${sourceLabel || 'none'} in=${event.promptTokens}, c-r=${event.cacheReadTokens}, c-w=${event.cacheWriteTokens}, ctx=${event.contextTokens}`);
        }

        // Record token usage to persistent storage
        if (ctx.provider && ctx.model) {
          const usageService = ctx.tokenUsage ?? tokenUsageService;
          usageService.recordUsage({
            timestamp: Date.now(),
            provider: ctx.provider,
            model: ctx.model,
            inputTokens: event.promptTokens || 0,
            outputTokens: event.completionTokens || 0,
            totalTokens: (event.contextTokens || event.promptTokens || 0) + (event.completionTokens || 0),
            cachedTokens: event.cacheReadTokens || 0,
            openaiCachedTokens: 0,
            anthropicCacheReadTokens: 0,
            anthropicCacheCreationTokens: 0,
            duration: event.duration || 0,
            success: true,
            sessionId: ctx.sessionId,
            requestType: 'chat',
          }).catch(err => {
            cliLogger.warn('RUNTIME_EVENTS', 'Failed to record token usage:', err);
          });

          getGlobalCostTracker().recordRequest({
            model: ctx.model,
            provider: ctx.provider,
            inputTokens: event.promptTokens || 0,
            outputTokens: event.completionTokens || 0,
            cachedTokens: event.cacheReadTokens || 0,
            cacheCreationTokens: event.cacheWriteTokens || 0,
          });

          getGlobalRateLimitTracker().recordRequest(
            ctx.provider || 'unknown',
            ctx.model || 'unknown',
            (event.promptTokens || 0) + (event.completionTokens || 0),
          );

          getGlobalHealthTracker().recordSuccess(ctx.provider);
        }

        updateTaskAgentContext(sourceLabel, {
          status: 'running',
          inputTokens: event.sessionPromptTokens,
          outputTokens: event.sessionCompletionTokens,
        });

        break;
      }
      case 'memory_snapshot': {
        const tokens = ctx.getRuntimeTokens();
        if (process.env.CLI_DEBUG) {
          cliLogger.debug('MAIN', `memory_snapshot received:`);
          cliLogger.debug('MAIN', `  tokensUsed=${event.snapshot.tokensUsed}, contextWindow=${event.snapshot.profile.contextWindow}`);
          cliLogger.debug('MAIN', `  pressure=${event.snapshot.pressure}, state=${event.snapshot.state}`);
          cliLogger.debug('MAIN', `  runtimeInputTokens=${tokens.input}, runtimeOutputTokens=${tokens.output}`);
        }
        ctx.pushTokenStats(tokens.input, tokens.output, event.snapshot, lastCacheStats);
        break;
      }
      case 'checkpoint': {
        if (!ctx._seenCheckpointIds) ctx._seenCheckpointIds = new Set<string>();
        if (event.id && ctx._seenCheckpointIds.has(event.id)) break;
        if (event.id) ctx._seenCheckpointIds.add(event.id);
        if (!event.auto) ctx.uiController.addInfo(`检查点已创建: ${event.id}`);
        break;
      }
      case 'run_result': {
        cliLogger.info('EVENT', `📍 run_result HANDLER ENTERED: iterations=${event.iterations} tokens=${event.totalTokens} failed=${event.failed}`);
        if (!event.sourceLabel) {
          clearCompletionWatchdog();
        }
        // This ensures all streaming text/reasoning is added to logs
        ctx.uiController.completeReasoningStreaming();
        ctx.uiController.completeTextStreaming();
        ctx.currentStreamingTool = undefined;

        // 否则 commitAllPendingEntries 会把这些 "preparing..." 占位卡片强制 commit 为
        // completed 状态(用户看到 "✓ Explore (preparing...)" 幽灵卡片)。
        // 残留的 reserved 说明对应任务 Agent 从未启动(server 侧 stall / tool 失败等)。
        if (!event.sourceLabel) {
          const released = releaseAllReservedTaskAgents();
          if (released > 0) {
            cliLogger.info('SUBAGENT_ORDER', `🧽 main run_result: released ${released} unconsumed reserved placeholders`);
          }
        }

        if ('commitAllPendingEntries' in ctx.uiController) {
          ctx.uiController.commitAllPendingEntries();
        }

        // Add run result summary to Timeline
        const iterations = event.iterations ?? 0;
        const toolCalls = event.toolCalls ?? 0;
        const durationMs = event.durationMs ?? 0;
        const totalTokens = event.totalTokens ?? 0;
        const failed = !!event.failed;

        if (failed) {
          ctx.uiController.updateStatus('Task failed', 'error');
          updateTaskAgentContext(event.sourceLabel, {
            status: 'error',
            currentTask: 'Failed',
          });
        } else {
          const sourceLabel = event.sourceLabel;

          if (sourceLabel) {
            // Sub-agent (explore/task) completed — transitional status only.
            // Must NOT endTurn: main agent is still running.
            const label = typeof sourceLabel === 'string' ? sourceLabel : 'Sub-task';
            ctx.uiController.updateStatus(`${label} done, continuing...`, 'thinking');
          } else {
            // Main agent completed — show final "Complete!"
            ctx.uiController.updateStatus(getCompleteStatus(), 'complete');
          }

          updateTaskAgentContext(sourceLabel, {
            status: 'completed',
            currentTask: 'Done',
          });
        }

        // Main run settled → explicit endTurn (updateStatus no longer touches isRunning).
        // Also force-clear residual task-agent contexts so uiBusy / interrupt UI can release.
        if (!event.sourceLabel) {
          ctx.uiController.endTurn();
          const ui = ctx.uiController as any;
          const labels = new Set<string>();
          for (const label of workerRoles.keys()) labels.add(label);
          for (const label of workerEntryIds.keys()) labels.add(label);
          for (const members of groupMembers.values()) for (const m of members) labels.add(m);
          if (ui && typeof ui.clearAgentContext === 'function') {
            for (const label of labels) ui.clearAgentContext(label);
          }
          workerRoles.clear();
          workerEntryIds.clear();
          workerToolHistory.clear();
          workerToolRecords.clear();
          workerStartTimes.clear();
          workerToolCounts.clear();
          workerTaskSummaries.clear();
          workerToGroup.clear();
          exploreGroupEntryId.clear();
          groupMembers.clear();
          groupDoneCount.clear();
          memberDoneStatus.clear();
          if (ui && typeof ui.unsealAgentContext === 'function') {
            for (const label of labels) ui.unsealAgentContext(label);
          }
          if (labels.size > 0) {
            cliLogger.info('SUBAGENT_ORDER', `🧹 main run_result: cleared ${labels.size} residual task-agent contexts [${Array.from(labels).join(',')}]`);
          }
        }

        if ('clearPlanSteps' in ctx.uiController) {
          ctx.uiController.clearPlanSteps();
        }

        break;
      }
      case 'stream_retry': {
        clearCompletionWatchdog();
        // This ensures partial content is properly saved and UI doesn't glitch

        // Step 1: Try to complete pending reasoning/text streaming gracefully
        // This commits any partial content that was received before the interruption
        try {
          ctx.uiController.finalizeStreamingState();
        } catch (err) {
          // Ignore errors during graceful completion - we'll clear state anyway
          if (process.env.CLI_DEBUG === '1') {
            cliLogger.debug('EVENT', 'Error completing streaming during retry', { error: err });
          }
        }

        // Step 2: Now clear all streaming state to prepare for retry
        // This resets counters, timers, and clears any remaining pending entries
        if (ctx.uiController.resetStreamingState) {
          ctx.uiController.resetStreamingState();
        }

        const delayFormatted = event.delayMs >= 1000
          ? `${(event.delayMs / 1000).toFixed(1)}s`
          : `${event.delayMs}ms`;
        let retryTitle = '';
        let retryType: 'rateLimit' | 'timeout' | 'network' | 'default' = 'default';
        if (event.isRateLimit) {
          retryTitle = `~ API 速率限制，${delayFormatted} 后重试 (${event.attempt}/${event.maxRetries})`;
          retryType = 'rateLimit';
        } else if (event.isStreamTimeout) {
          retryTitle = `~ Stream 超时，${delayFormatted} 后重试 (${event.attempt}/${event.maxRetries})`;
          retryType = 'timeout';
        } else if (event.isNetworkError) {
          retryTitle = `~ 网络中断，${delayFormatted} 后重连 (${event.attempt}/${event.maxRetries})`;
          retryType = 'network';
        } else {
          retryTitle = `~ ${delayFormatted} 后重试 (${event.attempt}/${event.maxRetries})`;
        }
        /* 详情那行原样透传 event.error, 是英文 —— 于是同一个事件长这样:
         *     ~ 2.0s 后重试 (1/10)
         *       Stream stalled (180s no data)     ← 中文标题配英文详情
         * 常见的几条翻掉, 认不出的原样透传 (宁可英文, 不能瞎译)。 */
        ctx.uiController.addInfo(retryTitle, localizeStreamError(event.error));
        ctx.uiController.updateStatus(getRetryStatus(retryType), 'thinking');
        break;
      }
      case 'stream_recovered': {
        // Update status to show reconnecting state and add info to timeline
        const recoveredMsg = `↻ 重试 ${event.attempt}/${event.maxRetries}，正在重连...`;
        ctx.uiController.addInfo(recoveredMsg);
        ctx.uiController.updateStatus(getRetryStatus('network'), 'thinking');
        break;
      }
      case 'error_classified':
        // Mark that we've shown a classified error to avoid duplicate timeline entry from 'error' event
        errorClassifiedShown = true;
        const msg = event.message || '';
        let smartHint = event.suggestion;
        if (/算力紧张|capacity|overloaded|server.*busy|too many requests/i.test(msg)) {
          smartHint = '服务器高峰期算力不足, 等 1-3 分钟重试. 若反复, 切换其他模型: /model';
        } else if (/rate.*limit|429/i.test(msg)) {
          smartHint = '触发 rate limit. 等待或升级 plan: /upgrade';
        } else if (/context.*long|too long|token.*limit/i.test(msg)) {
          smartHint = '上下文超长. /clear 清旧消息, 或换更大窗口模型 (/model 切 200k+ ctx).';
        } else if (/timeout|timed out|deadline/i.test(msg)) {
          smartHint = '请求超时. server 慢或网络抖, 重试一次.';
        }
        ctx.uiController.addError(
          msg || `${event.category}: ${event.code}`,
          `${event.category}: ${event.code}${smartHint ? `\nHint: ${smartHint}` : ''}\nRetryable: ${event.retryable}`
        );
        break;
      case 'plan_update':
        cliLogger.info('RUNTIME_EVENTS', '🔥 Handling plan_update event', {
          hasExplanation: !!event.explanation,
          planSteps: event.plan?.length,
        });
        if (event.plan && 'showPlanUpdate' in ctx.uiController) {
          cliLogger.info('RUNTIME_EVENTS', '✅ Calling showPlanUpdate');
          ctx.uiController.showPlanUpdate(event.explanation, event.plan);

          if ('setPlanSteps' in ctx.uiController) {
            ctx.uiController.setPlanSteps(event.plan);
          }
        } else {
          cliLogger.warn('RUNTIME_EVENTS', '❌ Cannot show plan update', {
            hasPlan: !!event.plan,
            hasMethod: 'showPlanUpdate' in ctx.uiController,
          });
        }
        break;
      case 'error':
        clearCompletionWatchdog();
        ctx.uiController.completeReasoningStreaming();
        ctx.uiController.completeTextStreaming();

        // Without this, the streaming buffers (agentBuffers, streamingTextPendingId, etc.)
        // remain in a stale state, causing subsequent text streaming to fail silently.
        // This is why CLI stops outputting after an error while Android continues to work
        // (Android receives raw SSE events, unaffected by InkUIAdapter state).
        if (ctx.uiController.resetStreamingState) {
          ctx.uiController.resetStreamingState();
        }

        // Only add to timeline if error_classified wasn't already shown
        // This avoids duplicate error entries in the timeline
        if (!errorClassifiedShown) {
          // For multi-line errors, split into message and details
          const errorLines = event.message.split('\n');
          const firstLine = errorLines[0];
          const details = errorLines.length > 1 ? errorLines.slice(1).join('\n') : undefined;
          // Use addError for red-colored timeline entry
          ctx.uiController.addError(firstLine, details);
        }
        // Always update status bar; end turn immediately (updateStatus is text-only now).
        ctx.uiController.updateStatus(event.message.split('\n')[0], 'error');
        ctx.uiController.endTurn();
        // Reset the flag for next error
        errorClassifiedShown = false;

        if (ctx.provider) {
          getGlobalHealthTracker().recordError(ctx.provider, event.message?.substring(0, 80) || 'unknown');
        }
        break;

      case 'queued_message_added':
        // 用户输入了 queued message → 追加到本地排队副本 (QueuedMessagesBar 据此显示成 pending)。
        cliLogger.info('RUNTIME_EVENTS', `📨 Queued message added at position ${event.position}`);
        ctx.uiController?.addQueuedMessage(event.text ?? '');
        break;

      case 'queued_messages_processed':
        // queued messages 已被处理（加入到对话历史），清空本地排队副本
        cliLogger.info('RUNTIME_EVENTS', `✅ Processed ${event.count} queued messages`);
        ctx.uiController?.clearQueuedMessages();
        break;

      case 'queued_message_removed':
        // 别处 (如 ↑ 撤回) 移除了一条排队消息 → 同步本地副本 (移除最后一条)。
        cliLogger.info('RUNTIME_EVENTS', `↩ Queued message removed, remaining ${event.remaining}`);
        ctx.uiController?.popQueuedMessage();
        break;

      case 'user_message_injected':
        // 排队消息此刻被 server 真正处理 → 现在才把它渲染进 timeline (入队时只在队列条 pending)。
        cliLogger.info('RUNTIME_EVENTS', `📥 Injected message now rendered: "${(event.text ?? '').substring(0, 40)}"`);
        ctx.uiController?.addUserMessage(event.text ?? '', undefined, 'local');
        break;

      case 'background_task': {
        const action = event.action;
        const taskId = event.taskId;
        const pid = event.pid;
        const command = event.command;
        const updates = (event.updates || {}) as {
          status?: 'running' | 'done' | 'error' | 'killed';
          exitCode?: number;
          outputLine?: string;
        };

        if (action === 'add' && command && pid !== undefined) {
          if ('addBackgroundTask' in ctx.uiController) {
            const localId = ctx.uiController.addBackgroundTask(command, pid);
            if (taskId !== undefined && typeof localId === 'number') {
              remoteBgTaskIdToLocalId.set(taskId, localId);
            }
          }
          (ctx.uiController as any).commitBackgroundShellLaunch?.(command);
        } else if (action === 'update' && taskId !== undefined) {
          if ('updateBackgroundTask' in ctx.uiController) {
            const localId = remoteBgTaskIdToLocalId.get(taskId) ?? taskId;
            ctx.uiController.updateBackgroundTask(localId, updates);
            if (updates.status && updates.status !== 'running') {
              remoteBgTaskIdToLocalId.delete(taskId);
            }
          }
        } else if (action === 'update_by_pid' && pid !== undefined) {
          if ('updateBackgroundTaskByPid' in ctx.uiController) {
            ctx.uiController.updateBackgroundTaskByPid(pid, updates);
          }
        }
        break;
      }

      case 'shell_output_stream': {
        // 格式化时间
        const formatElapsed = (seconds: number): string => {
          if (seconds < 60) return `${seconds}s`;
          const mins = Math.floor(seconds / 60);
          const secs = seconds % 60;
          return `${mins}m ${secs}s`;
        };

        if (event.isComplete) {
          const exitInfo = event.exitCode !== undefined && event.exitCode !== 0
            ? ` (exit=${event.exitCode})`
            : '';
          ctx.uiController.updateStatus(
            `Shell complete ${formatElapsed(event.elapsed)}${exitInfo}`,
            event.exitCode === 0 ? 'tool_result' : 'warning'
          );
        } else {
          /* 心跳只换文案 (type=info)。updateStatus 已不再碰 isRunning; 仍用 info 而不是
           * tool_call, 避免旧适配器/诊断路径把心跳当成 tool 流。前台 shell 期间 beginTurn
           * 已把 isRunning 置着, 不靠这条心跳。 */
          ctx.uiController.updateStatus(
            `Shell running... ${formatElapsed(event.elapsed)}`,
            'info'
          );
        }

        // 使用 InkUIAdapter 的方法更新 Shell 输出
        if ('updateShellOutputStream' in ctx.uiController) {
          ctx.uiController.updateShellOutputStream({
            command: event.command,
            output: event.output,
            elapsed: event.elapsed,
            isComplete: event.isComplete,
            exitCode: event.exitCode,
          });
        }
        break;
      }
    }
  };
}

/**
 * Tools that use specialized display (create their own timeline nodes).
 * These tools should NOT use the aggregation pattern.
 */
const SPECIALIZED_DISPLAY_TOOLS = new Set([
  'web_search',
  'websearch',
  'web_fetch',
  'webfetch',
  'readfile',
  'read',
  'search',
  'search_files',
  'glob',
  'show_tree',
  'list_directory',
  'smart_tree',
  'execute_bash',
  'execute_shell',
  'bash',
  'execute_python',
  'execute_js',
  'execute_javascript',
  // assistant tools (legacy)
  'spawn_agent',
  'delegate_task',
  'query_agent',
  'send_message',
  'wait_result',
  'wait_all',
  'terminate_agent',
  // assistant tools (new Agent OS)
  'spawn_process',
  'list_processes',
  'read_process_output',
  'kill_process',
  'wait_process',
  'send_to_process',
  // Team orchestration
  'create_team',
  'task',
  'explore',
  // PTC
  'ptc_execute',
  // memory tools
  'memory',
  'read_memory',
  'save_memory',
  'update_project_memory',
  // plan tools (rendered by dedicated plan UI)
  'update_plan',
  'verify_step',
  // ask_user (rendered by AskUserQuestionCard)
  'ask_user',
  'write_file',
  'write',
  'edit_file',
  'edit',
  'cron_create',
  'cron_delete',
  'cron_list',
  'task_create',
  'task_get',
  'task_update',
  'task_list',
  'task_stop',
  'enter_plan_mode',
  'exit_plan_mode',
  'enter_worktree',
  'exit_worktree',
]);

/**
 * Check if a tool uses specialized display (creates its own nodes).
 */
function isSpecializedDisplayTool(normalizedName: string): boolean {
  return SPECIALIZED_DISPLAY_TOOLS.has(normalizedName) ||
    normalizedName.includes('websearch') ||
    normalizedName.includes('webfetch');
}

function isStreamManagedFileTool(normalizedName: string): boolean {
  return normalizedName === 'write_file'
    || normalizedName === 'write'
    || normalizedName === 'edit_file'
    || normalizedName === 'edit';
}

/**
 * Handle tool_call_start with aggregation support.
 * For specialized tools, delegates to handleToolCallStart.
 * For generic tools, uses the aggregated node approach.
 */
function handleToolCallStartWithAggregation(
  uiController: InkUIAdapter | null,
  toolId: string,
  toolName: string,
  args: Record<string, any>,
  options?: { targetPath?: string; description?: string; sourceLabel?: string; viaCallTool?: boolean }
): void {
  if (!uiController) return;

  const normalizedName = toolName.toLowerCase();
  const alwaysSpecialized =
    normalizedName === 'update_plan' ||
    normalizedName === 'verify_step' ||
    normalizedName === 'ask_user' ||
    normalizedName === 'memory' ||
    normalizedName === 'read_memory' ||
    normalizedName === 'save_memory' ||
    normalizedName === 'update_project_memory';
  const streamManagedFileTool = isStreamManagedFileTool(normalizedName);

  // 因为 call_tool 的 tool_output 只会触发 completeToolCall，不会触发 handleToolOutput
  if (alwaysSpecialized || streamManagedFileTool || (!options?.viaCallTool && isSpecializedDisplayTool(normalizedName))) {
    const argsWithToolId = toolId ? { ...(args || {}), __toolId: toolId } : args;
    handleToolCallStart(uiController, toolName, argsWithToolId, options?.sourceLabel);
    return;
  }

  uiController.startToolCallWithId(toolId, toolName, args, options);
}
