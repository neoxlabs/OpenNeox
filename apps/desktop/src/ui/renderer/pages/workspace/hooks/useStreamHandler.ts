/**
 * useStreamHandler - 处理流式事件的 Hook
 *
 * 负责处理所有来自后端的流式事件，包括：
 * - token: 流式文本输出
 * - reasoning: 思维链/思考内容
 * - status: 状态更新
 * - metrics: token 统计
 * - thinking: 思考状态
 * - tool_call: 工具调用
 * - tool_result: 工具结果
 * - tool_error: 工具错误
 * - plan_update: update_plan 工具事件
 * - file_stream: 文件流
 * - error_classified: 错误分类
 * - stream_retry: 重连
 * - fallback/recovery: 降级/恢复
 * - provider_status: Provider 状态
 */

import { useEffect, useRef, useCallback, startTransition, MutableRefObject } from 'react';
/* 会话归属守卫 —— 刻意没有回落到当前会话, 见该文件注释 */
import { resolveStreamEventSessionId, normalizeEventSessionId } from './streamSessionGuard';
import { shouldSettlePendingAtTurnEnd, isBackgroundDelegation } from './pendingSweep';
import { describeToolError } from './toolErrorMessage';
import { settleStreamText } from './settleStreamText';
import { patchMessageById, makeForegroundMessageDispatch } from './messageListPatch';
import { applyExploreProgress } from '../../../modules/agent-timeline/exploreProgress';
import {
  isDeepResearchEntry,
  hasResearchLiveData,
  applyResearchProgress,
  bindResearchWorker,
  applyResearchWorkerTool,
  applyResearchWorkerTokens,
  markResearchWorkerDone,
} from './deepResearchLive';
/* 纯文本/工具名小工具 → ./streamToolHelpers (本文件继续 re-export, 外部 import 路径不变) */
import {
  estimateOutputTokens, parseCompactCount, SURFACE_TOOLS, summarizeSurfaceOutput, normalizeToolName,
  resolveToolCallId, extractStreamText, mergeReasoningDelta, isLikelyDuplicateError,
  isCompletionLogMessage, normalizeToolArgsForUi, formatBrowserToolCallDetail,
} from './streamToolHelpers';
export {
  estimateOutputTokens, formatCompactTokens, parseCompactCount, summarizeSurfaceOutput, normalizeToolName,
  resolveToolCallId, normalizeErrorMessage, extractStreamText, mergeReasoningDelta, isLikelyDuplicateError,
  isCompletionLogMessage, normalizeToolArgsForUi, compactUiText, pickToolArgText, compactUiUrl,
  formatBrowserToolCallDetail,
} from './streamToolHelpers';

/* dbg — 仅在 localStorage('neox-ui-debug')==='1' (开发者模式开启) 时输出.
 *   useStreamHandler 是 stream 高频路径, 商用 prod bundle 不应有 [Stream]/[Tool*]/
 *   [typewriter] 等 30+ 行调试输出污染 DevTools console. 用户排障时在
 *   设置 → 关于 → 7-tap 版本号开 dev mode 即可激活. */
const dbg = (...args: unknown[]): void => {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('neox-ui-debug') === '1') {
      // eslint-disable-next-line no-console
      console.log(...args);
    }
  } catch { /* SSR / blocked storage — silently skip */ }
};

/* logToFile — 把诊断日志同时打到 DevTools console + 主进程 neoxLogger,
 * 后者落盘到 ~/.neox/logs/neox-app-*.log, 用户不打开 DevTools 也能看.
 * tag 例: 'EDIT_DEBUG'; subTag 例: 'handleToolCall'. */
const logToFile = (tag: string, subTag: string, data: unknown): void => {
  try {
    // eslint-disable-next-line no-console
    console.log(`[${tag}][${subTag}]`, data);
  } catch { /* ignore */ }
  try {
    const api = (typeof window !== 'undefined' ? (window as any).neox : null);
    if (api && typeof api.logWarn === 'function') {
      api.logWarn(tag, subTag, data);
    } else if (api && typeof api.logDebug === 'function') {
      api.logDebug(tag, subTag, data);
    }
  } catch { /* ignore — bridge unavailable */ }
};
import { useService } from '../../../platform';
import { VFS_SERVICE } from '../../../../../ide';
import type { ChatMessage, StreamEvent as SharedStreamEvent } from '../../../../shared/ipc';
import { TimelineEntry } from '../../../utils/workspaceUtils';
import type { RuntimeLogEntry } from '../../../../state/runtimeStore';
import { getContextSnapshot, setContextSnapshot } from '../../../state/contextSnapshot';
import { ingestTeamRunEvent, type TeamRunEvent } from '../../../state/teamRunStore';
import { ingestTeamPlanEvent, ingestTeamExecEvent } from '../../../state/teamPlanStore';
import {
  createId,
  formatTimelineDetail,
  formatToolCallDetail,
  formatToolResultDetail,
  parseStructuredToolOutput,
  type MemoryStatus,
  type LatestRequestUsage,
} from '../utils';
import {
  extractNeoxEnvelopeFromError,
  parseNeoxErrorEnvelope,
  presentNeoxError,
  type NeoxErrorEnvelope,
  type NeoxErrorPresentation,
} from '@neoxlabs/platform/utils/neoxErrorCatalogue.js';
import { getEditionHook } from '../../../modules/shell/editionHooks';
import { maybeNotifyTaskComplete } from '../../../state/notifyStore';
import { emitTerminalChunk } from '../../../modules/agent-timeline/terminalChunkBus';
import { aggregateTurnChanges } from '../../../modules/agent-timeline/aggregateTurnChanges';
import { recoverShellProcDeclarations } from '../../../modules/agent-timeline/shellProcRecovery';
import { getSessionRunWorkspace } from '../../../modules/agent-timeline/sessionRunWindows';
import { recordWriteDeclaration } from '@neoxlabs/kernel/core/writeLedger.js';
/* 跟 kernel 用**同一份**解析器 —— 两边各写一遍正则, 迟早一边认得另一边不认, 那时
 * 记忆干净而屏幕上还是乱码 (或者反过来), 排查起来极难。 */
import { parseDsmlToolCalls } from '@neoxlabs/kernel/utils/dsmlToolCalls.js';
import { logTimelineJank } from '../../../modules/agent-timeline/timelineDebug';
import { getTranslations } from '../../../i18n';
import { getGlobalLanguage } from '../../../hooks/useI18n';
import { playTtsAudio, getTtsPlayer, ingestTtsAudioChunk } from '../../../utils/ttsPlayer';
import { createNeoxDiffEditor } from '../../../modules/editor/engine/factory';
import { wasRecentlyStoppedByUser } from '../../../state/userStopMarks';
import { noteStreamDrop } from '../../../state/streamDropLedger';
import { isUnclaimedArgStreamPlaceholder, PLACEHOLDER_ID_PREFIX, runEndToolCallPatch, supersededOnRetry, unclaimedAtRunEndPatch } from './argStreamPlaceholder'; import { dropDiscardedAssistantText } from './retryDiscardedText';
import { noteStreamActivity, subscribeStreamFreeze, markRunEnded } from '../../../state/streamActivity';
import { dsmlDiscardedText, dropIncompleteAssistantTurn } from './dsmlRetryDiscard';

function bi(zh: string, en: string): string { return isZhUi() ? zh : en; }
const isZhUi = () => getGlobalLanguage().startsWith('zh');

export function statusT(key: keyof ReturnType<typeof getTranslations>['agentStatus'], params?: Record<string, string | number>): string {
  const t = getTranslations(getGlobalLanguage());
  let text = t.agentStatus[key];
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(`{${k}}`, String(v));
    }
  }
  return text;
}

export function localizeStatusMessage(raw: string): string {
  const elapsed = raw.match(/(\d+)s/)?.[1] || '';
  if (/^Explore agents still running/i.test(raw)) return statusT('exploreStillRunning', { elapsed });
  if (/^Explore agents running/i.test(raw)) return statusT('exploreRunning', { elapsed });
  if (/^Waiting for response/i.test(raw)) return statusT('waitingForResponse', { elapsed });
  if (/^API responding slowly/i.test(raw)) return statusT('apiRespondingSlowly', { elapsed });
  if (/^Long wait/i.test(raw)) return statusT('longWait', { elapsed });
  if (/^Tool is running/i.test(raw)) return statusT('toolRunning', { elapsed });
  if (/^Tool chain in progress/i.test(raw)) return statusT('toolChainInProgress', { elapsed });
  if (/^Tool execution taking long/i.test(raw)) return statusT('toolExecutionLong', { elapsed });
  if (/^Generating response/i.test(raw)) return statusT('generatingResponse');
  if (raw === 'Complete!') return statusT('ready');
  return raw;
}

/**
 * 从 executeShellWorker.formatForegroundOutput 包装的 ToolResult 文本里
 * 把真正的 stdout / stderr 提取出来 (剥掉中文标题、━━━ 分隔线、退出码这些壳).
 *
 * 防御性 fallback: 主路径是 handleShellOutputStream 流式累积 commandRawOutput,
 * 但短命令 / IPC 时序异常 / dev HMR 错位等情况可能让流式路径失效, 这时 tool_result
 * 阶段调一次本函数从壳里挖出干净版本, 保证 xterm 一定能拿到 raw stdout.
 *
 * 格式参考 executeShellWorker.ts:102-140 (formatForegroundOutput):
 *   ━━━━━━━━━━...
 *   ▸ 工作目录: ...
 *   ▸ 执行命令: ...
 *   ━━━━━━━━━━...
 *
 *   ✓ 执行成功 (退出码: 0)        ← 或 "! 执行完成但有错误 (退出码: N)"
 *
 *   ◦ 标准输出 (stdout):
 *   <stdout>
 *
 *   ◦ 错误输出 (stderr):
 *   <stderr>
 *
 *   ━━━━━━━━━━...
 *
 * 用 lookahead 锚定下一段(◦ 错误输出 / ━━━ / 字符串结尾), 不会被 stdout 内
 * 的空行截断.
 */
export function extractRawStdoutFromShellResult(formatted?: unknown): string | undefined {
  if (typeof formatted !== 'string' || formatted.length === 0) return undefined;

  /* tool result 格式: body (raw stdout/stderr) + 末尾 [bg pid=X ...] marker + 可能起首 [services:...] preamble.
   *   只剥 marker + preamble, body 完整保留. */
  if (/\[bg (?:pid=\d+|started|exited)/.test(formatted) || /^\[services:/.test(formatted)) {
    let body = formatted;
    body = body.replace(/^\[services:[^\n]*\n+/, '');
    body = body.replace(/\n*\[bg [^\]]*\]\s*$/, '');
    return body.replace(/^\n+|\n+$/g, '');
  }

  // 不像是包装文本(没 ▸ 工作目录 头) → 当作已经是 raw 直接返回
  if (!formatted.includes('▸ 工作目录') && !formatted.includes('━━━')) return formatted;

  let stdout = '';
  let stderr = '';

  const stdoutMatch = formatted.match(/◦ 标准输出 \(stdout\):\n([\s\S]*?)(?=\n\n◦ 错误输出|\n\n━━━|$)/);
  if (stdoutMatch?.[1]) stdout = stdoutMatch[1].replace(/\n+$/, '');

  const stderrMatch = formatted.match(/◦ 错误输出 \(stderr\):\n([\s\S]*?)(?=\n\n━━━|$)/);
  if (stderrMatch?.[1]) stderr = stderrMatch[1].replace(/\n+$/, '');

  if (stdout && stderr) return `${stdout}\n${stderr}`;
  if (stdout) return stdout;
  if (stderr) return stderr;
  return undefined;
}

type ExploreGroupMember = NonNullable<TimelineEntry['exploreGroupMembers']>[number];

type ExtendedStreamEvent = SharedStreamEvent & {
  taskAgentId?: string;
  workerRole?: string;
  workerTask?: string;
  prefixText?: string;
  summary?: string;
  error?: string;
  viaCallTool?: boolean;
  groupMembers?: ExploreGroupMember[];
};


const STREAMED_ARG_PRIMARY_KEYS = [
  'query', 'q', 'search',           // search / web_search
  'command', 'cmd',                 // shell
  'pattern', 'regex',               // grep
  'file_path', 'filePath', 'path',  // read / write / edit
  'url', 'target',                  // web_fetch / navigate
  'question', 'prompt',             // ask_user
  'code', 'expression',             // exec / eval
  'title', 'name', 'description',   // 兜底
];
export function extractStreamedArgPreview(raw: string): string {
  if (!raw) return '';
  const trim = raw.trim();
  if (!trim) return '';
  /* 先试全 parse — 一旦收齐了 args 全解析就精准 */
  try {
    const parsed = JSON.parse(trim);
    if (parsed && typeof parsed === 'object') {
      for (const k of STREAMED_ARG_PRIMARY_KEYS) {
        const v = (parsed as Record<string, unknown>)[k];
        if (typeof v === 'string' && v.trim()) return truncateForPreview(v);
        if (typeof v === 'number') return String(v);
      }
    }
  } catch { /* 残缺 JSON, 走正则 */ }
  /* 局部正则: 匹配 "key" : "..." 或 "key" : "...  (尾巴未闭合)
   * value 部分处理 \" 转义 — 用 [^"\\]* 加 (\\.)* 简化, 只要提取出有意义 prefix 就行 */
  for (const k of STREAMED_ARG_PRIMARY_KEYS) {
    const re = new RegExp(`"${k}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*?)(?:"|$)`, 'i');
    const m = trim.match(re);
    if (m && m[1]) {
      const val = m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"').trim();
      if (val) return truncateForPreview(val);
    }
    /* number / bool 值场景, 用无引号版本 */
    const reNum = new RegExp(`"${k}"\\s*:\\s*([^",{}\\s][^,}\\n]*)`, 'i');
    const mn = trim.match(reNum);
    if (mn && mn[1]) {
      const val = mn[1].trim().replace(/[,}\s].*$/, '');
      if (val) return truncateForPreview(val);
    }
  }
  return '';
}
export function truncateForPreview(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  if (one.length <= 120) return one;
  return one.slice(0, 118) + '…';
}

import { settledToolDuration } from './settledToolDuration';
import { findClaimableOptimisticInject, settleInjectedMessage, QUEUE_SETTLE_EVENT_TYPES } from '../../../modules/agent-timeline/injectOptimisticBubble';
import { isBusEventMessage } from '../../../modules/agent-timeline/cells/systemMessageParsers';
export { settledToolDuration };


type EditStreamHunk = {
  oldString?: string;
  newString?: string;
  startLine?: number;
  oldLineCount?: number;
  newLineCount?: number;
  oldCharCount?: number;
  newCharCount?: number;
  previewTruncated?: boolean;
};

type ExploreTimelineEntry = TimelineEntry & {
  viaCallTool?: boolean;
  exploreToolRecords?: Array<NonNullable<TimelineEntry['exploreToolRecords']>[number] & {
    agentId?: string;
    timestamp?: number;
    toolId?: string;
  }>;
  exploreGroupMembers?: ExploreGroupMember[];
};


export interface UseStreamHandlerOptions {
  // State setters
  dispatchMessages: (fn: (prev: ChatMessage[]) => ChatMessage[]) => void;
  dispatchStatus: (status: string, sessionId?: string) => void;
  dispatchStreaming: (value: boolean, sessionId?: string) => void;
  applyAuthoritativeExecutionState?: (sessionId: string, state: 'idle' | 'running' | 'recovering') => void;
  requestExecutionStateReconcile?: (reason: string) => void;
  dispatchTotalTokens: (value: number | ((prev: number) => number)) => void;
  setStreamingTokens: (value: number | ((prev: number) => number)) => void;
  dispatchContextUsed: (contextUsed: number) => void;
  setMemorySnapshot: (snapshot: MemoryStatus | null) => void;
  setLatestRequestUsage: (usage: LatestRequestUsage | null) => void;
  setRuntimeLogs: (fn: (prev: RuntimeLogEntry[]) => RuntimeLogEntry[]) => void;
  setCanRetry: (canRetry: boolean) => void;
  setRetryError: (error: { code: string; message: string; suggestion?: string; category?: string; retryable?: boolean } | null) => void;
  onRequestMetrics?: (metrics: {
    inputTokens: number;
    billableInputTokens?: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
  }) => void;

  // Timeline functions
  appendTimelineEntry: (sessionId: string | undefined, entry: TimelineEntry, forceSync?: boolean) => TimelineEntry | undefined;
  updateTimelineEntry: (sessionId: string | null | undefined, predicate: (entry: TimelineEntry) => boolean, updater: (entry: TimelineEntry) => TimelineEntry, forceSync?: boolean) => void;
  updateTimelineEntryById: (sessionId: string | null | undefined, entryId: string, updater: ((entry: TimelineEntry) => TimelineEntry) | Partial<TimelineEntry>, forceSync?: boolean) => void;
  deleteTimelineEntry?: (sessionId: string | null | undefined, entryId: string) => void | Promise<void>;
  timelineMapRef: MutableRefObject<Map<string, TimelineEntry[]>>;

  // Refs
  activeSessionIdRef: MutableRefObject<string | null>;
  /* messageMapRef — NeoxRuntimeBridge.sendPrompt 在这写预分配的 assistant messageId,
   *   useStreamHandler 内 ActiveSlot reducer 把它作为 prealloc inbox + write-through
   *   镜像. 别拿它当 "current slot 的真相源" — 真相是 slotsRef. */
  messageMapRef: MutableRefObject<Map<string, string>>;
  reasoningStreamRef: MutableRefObject<Map<string, { entryId: string; content: string; startedAt?: number }>>;
  fileStreamEntryMapRef: MutableRefObject<Map<string, string>>;
  fileStreamLatestContentRef: MutableRefObject<Map<string, string>>;
  // Callbacks
  scrollToBottom: () => void;
  formatWorkspacePath: (absPath?: string) => string;
  openOrUpdateFileInEditorRef: MutableRefObject<(filePath: string, content: string, isComplete: boolean, options?: { updateOnly?: boolean }) => void>;

  // Translation
  tRef: MutableRefObject<{
    timeline: { reasoning: string };
    plan: { title: string; updated: string };
    session: Record<string, string>;
    errors: {
      loopDetected: string;
      loopDetectedSuggestion: string;
      placeholderDetected: string;
      placeholderDetectedSuggestion: string;
      runnerError: string;
      runnerErrorSuggestion: string;
    };
  }>;

  // Workspace
  workspacePath: string;
  /** stale watchdog 的会话运行态探针 — 缺省时保持旧行为 (任何事件都武装) */
  isSessionStreaming?: (sessionId: string | null) => boolean;
}

// Helper functions
export function isStreamingPlaceholderDetail(detail?: string): boolean {
  const t = (detail ?? '').trim();
  if (!t) return true;
  return /^(流式接收内容|正在接收|Receiving|Streaming)[.…\s]*$/i.test(t);
}

export const fileStreamKey = (sessionId: string, filePath: string) => `${sessionId}:${filePath}`;

export const normalizePathForMatch = (filePath?: string): string => {
  if (typeof filePath !== 'string') return '';
  return filePath.trim().replace(/\\/g, '/');
};

export const pathsMaybeMatch = (left?: string, right?: string): boolean => {
  const l = normalizePathForMatch(left);
  const r = normalizePathForMatch(right);
  if (!l || !r) return false;
  if (l === r) return true;
  if (l.endsWith(`/${r}`) || r.endsWith(`/${l}`)) return true;
  const lTail = l.split('/').filter(Boolean).slice(-2).join('/');
  const rTail = r.split('/').filter(Boolean).slice(-2).join('/');
  return Boolean(lTail) && lTail === rTail;
};

/* ============================================================
 * Tool Call Identity Helpers
 *
 * 不变式: 每次 LLM tool call 对应**唯一一个** timeline entry. 身份 = 该 entry 见过的全部
 * toolCallId 集合 (entry.toolCallIdSet). 单 id 时退化为 entry.toolCallId.
 *
 * 所有事件查找走 entryMatchesToolId, 命中后增量绑 id 走 bindToolIdPatch. 不再有 path /
 * pending / lastReverseFind 等平行 fallback 互相打架 → 同 toolId 永远命中同一 entry,
 * "前后事件匹中不同 entry → 卡死运行中" 不会发生.
 *
 * Anthropic / OpenAI 工具协议有时 tool_call_start 阶段 toolId 跟 tool_call_done 不一致
 * (preview 跟 final 各拿一个 id). 这种情况 entry 的 toolCallIdSet 累加两次 id,
 * 后续两个 id 任一到达都能找回. 同时是兼容这种情况, 又不污染"deliberate 第二次 edit"的
 * 身份独立性 (那种情况下两次 id 间隔大, 由 stream phase / time window 区分).
 * ============================================================ */
export const isTurnBoundaryUserMessage = (entry: TimelineEntry): boolean =>
  entry?.type === 'user_message'
  && !String(entry.id ?? '').startsWith('msg-injected-')
  && (entry as any).messageSource !== 'system-background-task';

/** 最后一条真·轮边界 user 消息的下标; 没有返回 -1。 */
export const latestTurnBoundaryIdx = (timeline: TimelineEntry[]): number => {
  for (let i = timeline.length - 1; i >= 0; i--) {
    if (isTurnBoundaryUserMessage(timeline[i])) return i;
  }
  return -1;
};

export const entryMatchesToolId = (entry: TimelineEntry, toolId: string): boolean => {
  if (!toolId) return false;
  if (entry.toolCallId === toolId) return true;
  return Array.isArray(entry.toolCallIdSet) && entry.toolCallIdSet.includes(toolId);
};

/** 计算把 toolId 绑到 entry 上的 patch (仅返回 diff 字段, 不修改原对象).
 *  - 已存在 set 里: 只更新 primary toolCallId 指向最新 id, 不变 set (Anthropic 同 id 重发)
 *  - 不在 set 里: append, 同时 primary 指向新 id */
export const bindToolIdPatch = (entry: TimelineEntry, toolId: string): Partial<TimelineEntry> => {
  if (!toolId) return {};
  const existingSet: string[] = Array.isArray(entry.toolCallIdSet)
    ? entry.toolCallIdSet
    : (entry.toolCallId ? [entry.toolCallId] : []);
  if (existingSet.includes(toolId)) {
    return entry.toolCallId === toolId ? {} : { toolCallId: toolId };
  }
  return { toolCallId: toolId, toolCallIdSet: [...existingSet, toolId] };
};

/** 在 timeline 里按 toolId 找 entry (走 entryMatchesToolId), 可选 predicate 过滤 type. */
export const findEntryByToolId = (
  timeline: TimelineEntry[],
  toolId: string | undefined,
  predicate?: (entry: TimelineEntry) => boolean,
): TimelineEntry | undefined => {
  if (!toolId) return undefined;
  for (const entry of timeline) {
    if (!entryMatchesToolId(entry, toolId)) continue;
    if (predicate && !predicate(entry)) continue;
    return entry;
  }
  return undefined;
};

/** 创建新 entry 时初始化身份字段. */
export const initialIdentity = (toolId?: string): Pick<TimelineEntry, 'toolCallId' | 'toolCallIdSet'> => {
  if (!toolId) return {};
  return { toolCallId: toolId, toolCallIdSet: [toolId] };
};

function compactionRunningLabel(): string {
  return getGlobalLanguage().startsWith('zh') ? '正在压缩上下文…' : 'Compacting context...';
}

function maybeReconcileBackgroundTaskNotification(sessionId: string, text: string): void {
  if (!sessionId || !/^\s*<background-task-notification>/i.test(text || '')) return;
  const pick = (tag: string): string =>
    new RegExp(`<${tag}>([\\s\\S]*?)<\/${tag}>`, 'i').exec(text)?.[1]?.trim() ?? '';
  const pid = Number(pick('pid')) || 0;
  const rawStatus = pick('status') || 'completed';
  const exitRaw = pick('exit-code');
  const exitCode = exitRaw === '' ? undefined : (Number(exitRaw) || 0);
  const status = rawStatus === 'completed' ? 'completed'
    : rawStatus === 'failed' ? 'failed'
    : rawStatus === 'killed' ? 'killed'
    : rawStatus;
}

export function useStreamHandler(options: UseStreamHandlerOptions) {
  const {
    dispatchMessages,
    dispatchStatus,
    dispatchStreaming,
    applyAuthoritativeExecutionState,
    requestExecutionStateReconcile,
    dispatchTotalTokens,
    setStreamingTokens,
    dispatchContextUsed,
    setMemorySnapshot,
    setLatestRequestUsage,
    setRuntimeLogs,
    setCanRetry,
    setRetryError,
    onRequestMetrics,
    appendTimelineEntry,
    updateTimelineEntry,
    updateTimelineEntryById,
    deleteTimelineEntry,
    timelineMapRef,
    activeSessionIdRef,
    messageMapRef,
    reasoningStreamRef,
    fileStreamEntryMapRef,
    fileStreamLatestContentRef,
    scrollToBottom,
    formatWorkspacePath,
    openOrUpdateFileInEditorRef,
    tRef,
    workspacePath,
    isSessionStreaming,
  } = options;
  const dispatchForegroundMessages = makeForegroundMessageDispatch(dispatchMessages, activeSessionIdRef);

  // VFS — step 6A：agent 写文件后通知所有 FILES_TOPIC 订阅者（编辑器、
  // 未来的 Project View 等）。在本 hook 里直接 useService 是因为
  // useStreamHandler 已经被 WorkspacePlatformProvider 包住，不需要新增
  // option 字段。
  const vfs = useService(VFS_SERVICE);

  const streamingTokensRef = useRef<Map<string, number>>(new Map());
  const recentRunnerErrorRef = useRef<Map<string, { entryId: string; message: string; timestamp: number }>>(new Map());
  const recentClassifiedErrorRef = useRef<Map<string, { entryId: string; message: string; timestamp: number }>>(new Map());
  const turnErrorEntriesRef = useRef<Map<string, Set<string>>>(new Map());
  const lastSequenceRef = useRef<Map<string, number>>(new Map());
  const recentEventRef = useRef<Map<string, number>>(new Map());
  const recentMainSummaryRef = useRef<Map<string, { text: string; timestamp: number }>>(new Map());
  /* retry watchdog: stream_retry attempt===maxRetries 是最后一次尝试, 后续不再有重试 event.
   * 如果上游 hang / 错误事件被吞, 这条 entry 会永远 pending 显示"运行中".
   * 兜底: 给最后一次尝试一个有限窗口, 超时强制收尾成失败, 让用户看到明确的终态. */
  const retryWatchdogRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const scrollRafIdRef = useRef<number | null>(null);
  const scrollTimeoutIdRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const missingSessionIdEventRef = useRef<Map<string, number>>(new Map());
  const recentHandledToolIds = useRef<Set<string>>(new Set()).current;
  //
  // 之前 30s 阈值 + dispatchStreaming(false) 误伤场景:
  //   · LLM 大 prompt 首字延迟 30-60s (上游常态)
  //   · edit_file 写大文件 / 长 shell 命令期间 iterator idle
  //   · agent 切 iter 之间偶发 30s 缝隙 (heartbeat 被 dedupe 等)
  // 一旦触发就让 LiveStatusLine 消失但 agent 还在跑, 用户看到"状态条不见了
  // 过一会儿模型继续说话". streaming 状态应该交给 run_result / error 这种
  // 权威终止信号管, watchdog 只配在 status bar 上提个醒.
  //
  // 阈值放到 120s 给上游充分时间, 触发时只 dispatchStatus 不动 streaming.
  const staleStatusWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamActiveRef = useRef(true);
  const STALE_STATUS_TIMEOUT_MS = 120_000;
  const ensurePendingCompactionEntry = useCallback((params: {
    sessionId?: string | null;
    timestamp?: number;
    title?: string;
    detail?: string;
    status?: 'started' | 'compressing';
    originalTokens?: number;
    budgetTokens?: number;
  } = {}) => {
    const sessionId = normalizeEventSessionId(params.sessionId);
    if (!sessionId) return undefined;

    const timeline = timelineMapRef.current.get(sessionId) || [];
    const pendingCompaction = [...timeline].reverse().find(
      (entry: any) => entry.type === 'context_compaction' && entry.pending,
    );
    const title = params.title || bi('📦 正在压缩上下文…', '📦 Compacting Context...');
    const detail = params.detail || compactionRunningLabel();
    const nextStatus = pendingCompaction?.compactionStatus === 'compressing'
      ? 'compressing'
      : (params.status || 'started');
    const patch: Partial<TimelineEntry> = {
      title,
      detail,
      pending: true,
      compactionStatus: nextStatus,
    };
    if (typeof params.originalTokens === 'number' && Number.isFinite(params.originalTokens)) {
      patch.compactionOriginalTokens = params.originalTokens;
    }
    if (typeof params.budgetTokens === 'number' && Number.isFinite(params.budgetTokens)) {
      patch.compactionBudgetTokens = params.budgetTokens;
    }

    if (pendingCompaction) {
      updateTimelineEntryById(sessionId, pendingCompaction.id, patch, true);
      return pendingCompaction;
    }

    return appendTimelineEntry(sessionId, {
      id: createId('compaction'),
      type: 'context_compaction',
      title,
      detail,
      timestamp: params.timestamp || Date.now(),
      pending: true,
      compactionStatus: nextStatus,
      compactionOriginalTokens: patch.compactionOriginalTokens,
      compactionBudgetTokens: patch.compactionBudgetTokens,
    } as TimelineEntry, true);
  }, [appendTimelineEntry, timelineMapRef, updateTimelineEntryById]);

  useEffect(() => {
    const failedLabel = () => getGlobalLanguage().startsWith('zh')
      ? '上下文压缩失败'
      : 'Context compaction failed';
    const keptLabel = () => getGlobalLanguage().startsWith('zh')
      ? '已保留原上下文'
      : 'Original context kept';

    const onStarted = (event: Event) => {
      const detail = (event as CustomEvent<any>).detail || {};
      const sessionId = normalizeEventSessionId(detail.sessionId);
      if (!sessionId) {
        console.warn('[Compaction] dropping manual compaction start without sessionId', detail);
        return;
      }
      ensurePendingCompactionEntry({
        sessionId,
        timestamp: typeof detail.timestamp === 'number' ? detail.timestamp : Date.now(),
        title: bi('📦 正在压缩上下文…', '📦 Compacting Context...'),
        detail: compactionRunningLabel(),
        status: 'started',
        originalTokens: typeof detail.originalTokens === 'number' ? detail.originalTokens : undefined,
        budgetTokens: typeof detail.budgetTokens === 'number' ? detail.budgetTokens : undefined,
      });
      dispatchStatus(compactionRunningLabel(), sessionId);
      scrollToBottom();
    };

    const onFailed = (event: Event) => {
      const detail = (event as CustomEvent<any>).detail || {};
      const sessionId = normalizeEventSessionId(detail.sessionId);
      if (!sessionId) return;
      const timeline = timelineMapRef.current.get(sessionId) || [];
      const pendingCompaction = [...timeline].reverse().find(
        (entry: any) => entry.type === 'context_compaction' && entry.pending,
      );
      const error = typeof detail.error === 'string' && detail.error.trim() ? detail.error.trim() : keptLabel();
      if (pendingCompaction) {
        updateTimelineEntryById(sessionId, pendingCompaction.id, {
          pending: false,
          compactionStatus: 'failed',
          title: '⚠️ Context compaction failed',
          detail: error,
        }, true);
      }
      dispatchStatus(failedLabel(), sessionId);
      scrollToBottom();
    };

    window.addEventListener('neox:manual-compaction-started', onStarted);
    window.addEventListener('neox:manual-compaction-failed', onFailed);
    return () => {
      window.removeEventListener('neox:manual-compaction-started', onStarted);
      window.removeEventListener('neox:manual-compaction-failed', onFailed);
    };
  }, [
    dispatchStatus,
    ensurePendingCompactionEntry,
    scrollToBottom,
    timelineMapRef,
    updateTimelineEntryById,
  ]);
  const resetStaleStatusWatchdog = useCallback((sessionId?: string | null) => {
    if (staleStatusWatchdogRef.current) clearTimeout(staleStatusWatchdogRef.current);
    const sid = sessionId ?? null;
    if (isSessionStreaming && !isSessionStreaming(sid)) {
      staleStatusWatchdogRef.current = null;
      return;
    }
    staleStatusWatchdogRef.current = setTimeout(() => {
      /* 触发时二次校验 — 定时器窗口内回合可能已正常结束 (settle 清得掉, 但防御竞态) */
      if (isSessionStreaming && !isSessionStreaming(sid)) return;
      console.warn('[STALE_WATCHDOG] No streaming events for 120s — likely IPC stall or upstream stuck');
      logToFile('STALE_WATCHDOG', 'no-stream-events-120s', { sessionId: sid, atMs: Date.now() });
      dispatchStatus('连接较慢, 等待响应中…', sid ?? undefined);
      /* 用户可见反馈 — hint toast 分级 warning (橙), 让用户知道 stall 已 detect 不是随机僵尸.
       *   动态 import 避免顶层引入 notifyEvents 造成循环. */
      void import('../../../components/notifyEvents').then(m => {
        try {
          m.dispatchHint('连接似乎较慢, 正在等待恢复…', 'warning');
        } catch { /* ignore */ }
      }).catch(() => { /* ignore */ });
      /* 广播全局事件 — 后续可挂 handler 主动 resubscribe / poll upstream health. */
      if (typeof window !== 'undefined') {
        try {
          window.dispatchEvent(new CustomEvent('neox:ipc-stall', { detail: { sessionId: sid, atMs: Date.now() } }));
        } catch { /* ignore */ }
      }
    }, STALE_STATUS_TIMEOUT_MS);
  }, [dispatchStatus, isSessionStreaming]);
  // 每个 toolId 一个 buffer, 每帧只 flush 一次到 React state. 这样既能消化
  // runtime 侧 48 chars / 50ms 的高频 emit, 又把 DOM 重绘绑定到显示器 vsync
  // (通常 60/120Hz), 流式看起来连续丝滑不抖.
  const editPreviewBufferRef = useRef<Map<string, {
    entryId: string;
    sessionId: string;
    latestNewString: string;
    rafHandle: number | null;
  }>>(new Map());

  /* ============================================================
   * write_file 打字机缓冲: backend 节流 80ms/80字符 + LLM stream 极快
   * 时, fullContent 一两帧就到齐 → UI 一闪而过. 这里在 UI 端再做一层
   * 缓冲: 收到 fullContent 时只 set 已显示的 partial, 然后用 setTimeout
   * 30ms 一帧 / 80 字符 / 帧 推进, 直到追上 target. isComplete=true 时
   * 立刻 set 全部并清理. 节奏 ≈ 2.7KB/s, 一个 3KB 文件大约 1 秒打完.
   * ============================================================ */
  type TypewriterState = {
    target: string;
    currentLen: number;
    timer: ReturnType<typeof setTimeout> | null;
    language: string | undefined;
    finalize: boolean;
  };
  const fileTypewriterRef = useRef<Map<string, TypewriterState>>(new Map());
  const FILE_TYPEWRITER_INTERVAL_MS = 30;
  const FILE_TYPEWRITER_CHUNK = 80;

  /* ============================================================
   * Assistant 文字流式 pacer (rAF 批量 + 字符级节奏)
   *
   *   provider 发 token 是 bursty 的 (有时 1 char, 有时 50 char).
   *   直接把每个 chunk 当成 setState 触发器, 视觉节奏 = provider 节奏,
   *   一卡一卡. 这里把 chunk 只追加到 buffer, 然后用 rAF 按目标速率
   *   一帧吐 N 字. 等于把渲染节奏锁到 vsync, 同时"匀速吐字"模拟打字机.
   *
   *   节奏算法: 基础 120 cps, pending 每多一档 (每 200 chars) 加 50 cps,
   *   超过 800 字直接 drain (provider 已经远快于 UI, 没必要再节流).
   *
   *   key = messageId. 每个 assistant 消息一个独立 pace state, 让多
   *   并发 session 互不干扰. 切到下一条消息 (tool_call 之后) 前必须
   *   drain 旧 state, 否则尾部字会丢.
   * ============================================================ */
  const PACE_BASE_CPS = 120;
  const PACE_CATCHUP_BIN = 200;
  const PACE_CATCHUP_STEP = 50;
  const PACE_MAX_CPS = 2000;
  const PACE_INSTANT_THRESHOLD = 800;

  /* ============================================================
   *  ActiveSlot reducer — 单一状态机替原 messageMapRef + messageCompletedRef
   *  + paceMapRef 三套并行 ref. 每个 assistant 消息 = 一个 ActiveSlot, 生命周期
   *  opening → streaming → closed. closed slot 留在 map 直到 rotate 时被新 slot
   *  atomic 替换 (避免"删 sentinel + 改 messageMapRef + drain pacer"分步竞态).
   *
   *  外部 prealloc 兼容: NeoxRuntimeBridge.sendPrompt 在 messageMapRef.set
   *    塞预分配的 messageId; openSlot 创建时优先采用. closeSlot 后, rotate 必须
   *    新分配 (不复用同一 messageId).
   *
   *  消除 bug: rotate 是单步 atomic — openSlot 用新 slot 覆盖 slotsRef.set, 同步
   *    更新 messageMapRef 镜像. 中间态不存在; handleResponseCompleted /
   *    handleAssistantTextComplete / handleStreamRetry 等 reader 通过 resolveSlot
   *    永远拿到一致的 (messageId, timelineEntryId, phase) 三元组.
   * ============================================================ */
  type SlotPhase = 'opening' | 'streaming' | 'closed';
  /* PaceState 仅描述节奏器自身的 buffer/进度, 不再背 messageId/sessionId — 由 slot 持有. */
  type PaceState = {
    buffer: string;     // provider 累积的全文
    flushed: number;    // 已 paint 到 React state 的字符数
    rafId: number | null;
    lastTickTs: number;
  };
  interface ActiveSlot {
    sessionId: string;
    messageId: string;
    timelineEntryId: string;      // 缓存 `msg-${messageId}`, 减字符串拼接
    phase: SlotPhase;
    sequence?: number;
    openedAt: number;
    firstChunkRendered: boolean;  // 首 chunk 是否已派发空 message + timeline entry
    pacer: PaceState;
  }
  const slotsRef = useRef<Map<string, ActiveSlot>>(new Map());
  /** 被"停止"定格的那条 assistant 气泡 (per session) —— 之后再有增量写向它一律丢弃。
   *  见下面 subscribeStreamFreeze 处的说明: 按气泡 id 挡才挡得住, 按时间/会话挡不住。 */
  const sealedEntryRef = useRef<Map<string, string>>(new Map());

  const scheduleScrollToBottom = useCallback(() => {
    if (scrollRafIdRef.current !== null || scrollTimeoutIdRef.current !== null) {
      return;
    }

    if (typeof requestAnimationFrame === 'function') {
      scrollRafIdRef.current = requestAnimationFrame(() => {
        scrollRafIdRef.current = null;
        scrollToBottom();
      });
      return;
    }

    scrollTimeoutIdRef.current = setTimeout(() => {
      scrollTimeoutIdRef.current = null;
      scrollToBottom();
    }, 16);
  }, [scrollToBottom]);

  useEffect(() => {
    return () => {
      if (scrollRafIdRef.current !== null) {
        cancelAnimationFrame(scrollRafIdRef.current);
        scrollRafIdRef.current = null;
      }
      if (scrollTimeoutIdRef.current !== null) {
        clearTimeout(scrollTimeoutIdRef.current);
        scrollTimeoutIdRef.current = null;
      }
      /* 卸载时把所有 slot pacer 的 rAF 都取消, 避免在已 unmount 的组件上 setState.
       * 不 flush — unmount 时 React state 已经 detach, flush 没意义. */
      for (const slot of slotsRef.current.values()) {
        if (slot.pacer.rafId !== null) {
          try {
            if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(slot.pacer.rafId);
            else clearTimeout(slot.pacer.rafId as unknown as ReturnType<typeof setTimeout>);
          } catch { /* noop */ }
        }
      }
      slotsRef.current.clear();
      for (const state of fileTypewriterRef.current.values()) {
        if (state.timer) clearTimeout(state.timer);
      }
      fileTypewriterRef.current.clear();
      for (const buf of editPreviewBufferRef.current.values()) {
        if (buf.rafHandle !== null) {
          try {
            if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(buf.rafHandle);
            else clearTimeout(buf.rafHandle as unknown as ReturnType<typeof setTimeout>);
          } catch { /* noop */ }
        }
      }
      editPreviewBufferRef.current.clear();
    };
  }, []);

  useEffect(() => subscribeStreamFreeze((sessionId) => {
    const slot = slotsRef.current.get(sessionId);
    if (slot) sealedEntryRef.current.set(sessionId, slot.timelineEntryId);
    closeSlot(sessionId, 'user-stop-freeze');
    closeReasoningEntry(sessionId);
  }), []);

  const settleStatusToReadyIfIdle = useCallback((sessionId?: string | null, event?: { taskAgentId?: string } | null): boolean => {
    /* taskAgentId 防御: 子 agent 的终止事件不能把主 timeline 的 streaming 收敛掉
     * (主 agent 还在跑, e.g. steering 注入后 explore 子 agent 先结束). */
    if (event?.taskAgentId) return false;
    dispatchStreaming(false, sessionId ?? undefined);
    dispatchStatus(statusT('ready'), sessionId ?? undefined);
    if (staleStatusWatchdogRef.current) {
      clearTimeout(staleStatusWatchdogRef.current);
      staleStatusWatchdogRef.current = null;
    }
    /* 通知钩子 — task done 唯一信号入口. notifyStore 内部决策:
     *   · 窗口前台跳过 (用户已在看)
     *   · enabled=false 跳过
     *   · 500ms 去抖
     *   · systemNotification → Notification API; sound → playSound IPC
     *   sessionId 前 8 位作为标识, title 后续可接 sessionStore (此 hook 暂没拿 session list ref). */
    try {
      const sidForLookup = sessionId ?? activeSessionIdRef.current ?? null;
      /* 传 id 本身, 让 notifyStore 去主进程取真标题 —— 这里原来传的是
         `sid.slice(0, 8)`, 而 id 形如 `session-1755…`, 截出来恒等于 "session-"。 */
      maybeNotifyTaskComplete({ sessionId: sidForLookup });
    } catch (e) {
      console.warn('[useStreamHandler] notify failed:', e);
    }
    return true;
  }, [dispatchStatus, dispatchStreaming, activeSessionIdRef]);

  function settleTerminalTimelineState(
    sessionId: string | null | undefined,
    options: { failureReason?: string; deleteOrphanWriteShell?: boolean } = {},
  ): void {
    if (!sessionId) return;
    const failureReason = options.failureReason || '';
    const failed = failureReason.length > 0;
    const stoppedByUser = failed && wasRecentlyStoppedByUser(sessionId);
    const markInterrupt = stoppedByUser ? { errorReason: 'interrupted', interrupted: true } : null;
    const timeline = timelineMapRef.current.get(sessionId) || [];

    for (const entry of timeline) {
      const hasPendingFlag = entry.pending === true || (entry as any).editStreaming === true;
      const hasRunningRecords =
        (entry as any).exploreToolRecords?.some?.((record: any) => record.status === 'running') ||
        (entry as any).delegationToolRecords?.some?.((record: any) => record.status === 'running');

      if (!hasPendingFlag && !hasRunningRecords) continue;

      /* 后台子 agent 的卡不在轮结束时收 —— 它的 pending 就是跨轮语义, 见 pendingSweep.ts */
      if (isBackgroundDelegation(entry as any)) continue;
      if (entry.type === 'explore_status' || entry.type === 'agent_delegation') {
        updateTimelineEntryById(sessionId, entry.id, (prev: any) => ({
          ...prev,
          pending: false,
          exploreStatus: prev.exploreStatus === 'running'
            ? (failed ? 'error' : 'completed')
            : prev.exploreStatus,
          delegationStatus: prev.delegationStatus === 'running'
            ? (failed ? 'error' : 'completed')
            : prev.delegationStatus,
          exploreError: prev.exploreError || failureReason || undefined,
          delegationError: prev.delegationError || failureReason || undefined,
          exploreToolRecords: prev.exploreToolRecords?.map((record: any) =>
            record.status === 'running'
              ? { ...record, status: failed ? 'error' : 'done' }
              : record
          ),
          delegationToolRecords: prev.delegationToolRecords?.map((record: any) =>
            record.status === 'running'
              ? { ...record, status: failed ? 'error' : 'done' }
              : record
          ),
        }));
        continue;
      }

      if (entry.type === 'tool_call') {
        const isOrphanWriteFileShell =
          entry.toolName === 'write_file' &&
          !entry.filePath &&
          !entry.targetPath &&
          !entry.codeContent &&
          !(entry.codeLines && entry.codeLines.length > 0);

        if (isOrphanWriteFileShell && options.deleteOrphanWriteShell) {
          console.warn('[DIAG terminal janitor] skipping orphan write_file shell (would have become Untitled)', {
            orphanId: entry.id,
            orphanToolCallId: entry.toolCallId,
          });
          if (deleteTimelineEntry) {
            void deleteTimelineEntry(sessionId, entry.id);
          } else {
            updateTimelineEntryById(sessionId, entry.id, (prev) => ({
              ...prev,
              type: 'tool_error' as any,
              pending: false,
              success: false,
              level: 'error',
              errorReason: prev.errorReason || failureReason || '工具状态未收敛',
              ...(markInterrupt ?? null),
            } as any));
          }
          continue;
        }

        updateTimelineEntryById(sessionId, entry.id, (prev) => ({
          ...prev,
          type: failed ? 'tool_error' as any : 'tool_result',
          pending: false,
          commandStatus: prev.commandStatus === 'running'
            ? (failed ? 'error' : 'completed')
            : prev.commandStatus,
          success: failed ? false : (prev.success ?? true),
          level: failed ? 'error' : prev.level,
          errorReason: failed ? (prev.errorReason || failureReason) : prev.errorReason,
          ...(markInterrupt ?? null),
          ...(markInterrupt ? { errorMessage: bi('你点了停止', 'You pressed Stop') } : null),
        } as any));
        continue;
      }

      if (entry.type === 'edit_file') {
        updateTimelineEntryById(sessionId, entry.id, (prev) => ({
          ...prev,
          pending: false,
          editStreaming: false,
          editIsComplete: true,
          awaitingApproval: false,
          success: failed ? (prev.success ?? false) : (prev.success ?? true),
          level: failed && prev.success !== true ? 'error' : prev.level,
          errorReason: failed ? (prev.errorReason || failureReason) : prev.errorReason,
        } as any));
        continue;
      }

      if (entry.type === 'file_stream') {
        updateTimelineEntryById(sessionId, entry.id, (prev) => ({
          ...prev,
          pending: false,
          success: failed ? (prev.success ?? false) : (prev.success ?? true),
          level: failed && prev.success !== true ? 'error' : prev.level,
          errorReason: failed ? (prev.errorReason || failureReason) : prev.errorReason,
        } as any));
        continue;
      }

      if (
        entry.type === 'assistant_message' ||
        entry.type === 'assistant_prefix' ||
        entry.type === 'agent_message' ||
        entry.type === 'thinking'
      ) {
        updateTimelineEntryById(sessionId, entry.id, (prev) => ({
          ...prev,
          pending: false,
        }));
        continue;
      }

      if (!shouldSettlePendingAtTurnEnd(entry as { type?: string; pending?: boolean; delegationIsBackground?: boolean })) continue;
      updateTimelineEntryById(sessionId, entry.id, (prev) => ({
        ...prev,
        pending: false,
        /* 留痕: 这条不是靠自己的结束事件收敛的, 是被兜底扫掉的。
         * 排查"到底哪个 type 的结束事件没到"时, 这个字段就是线索。 */
        settledBySweep: true,
        ...(failed
          ? { errorReason: (prev as any).errorReason || failureReason }
          : {}),
      } as any));
    }

    const residual = (timelineMapRef.current.get(sessionId) || [])
      .filter((e: TimelineEntry) => e.pending === true);
    if (residual.length > 0) {
      const byType = residual.reduce((acc: Record<string, number>, e: TimelineEntry) => {
        const t = e.type ?? 'unknown';
        acc[t] = (acc[t] ?? 0) + 1;
        return acc;
      }, {});
      const allExempt = residual.every(
        (e: TimelineEntry) => !shouldSettlePendingAtTurnEnd(e as { type?: string; pending?: boolean; delegationIsBackground?: boolean }),
      );
      logToFile('PENDING_SWEEP', allExempt ? 'residual-all-exempt' : 'residual-unexpected', {
        sessionId,
        count: residual.length,
        byType,
        /* true = 剩下的全是设计上该跨轮存活的 (如 ask_user), 不是 bug */
        allExempt,
      });
    }
  }

  const normalizeAssistantSessionId = useCallback((sessionId?: string | null): string | null => {
    return sessionId || null;
  }, []);

  const shouldSkipDuplicateEvent = useCallback((event: any): boolean => {
    const sessionId = normalizeEventSessionId(event.sessionId) || 'unknown';
    /* streamKey: sub-agent 的 sequence 流独立去重, taskAgentId 已足够区分.
     *   原本还含 `|| event.sourceLabel`, 但 sub-agent 事件在 1294 行被 taskAgentId 路径拦截,
     *   走到 assistant 路径的事件永远没有 sourceLabel — 已删. */
    const streamKey = `${sessionId}:${event.taskAgentId || 'main'}`;
    const sequence = typeof event.sequence === 'number' ? event.sequence : undefined;

    // 这些事件如果因为 sequence 乱序被丢弃，会导致 timeline 缺少关键卡片
    const isTimelineCritical = event.type === 'tool_call' || event.type === 'tool_result'
      || event.type === 'file_stream' || event.type === 'write_file_stream'
      || event.type === 'edit_file_stream' || event.type === 'thinking'
      || event.type === 'token' || event.type === 'text'
      || event.type === 'text_complete' || event.type === 'reasoning_complete'
      || event.type === 'run_result' || event.type === 'turn_complete'
      || QUEUE_SETTLE_EVENT_TYPES.has(event.type) // 排队消息结算, 吞了药丸就永远挂着 (见该常量注释)
      // Assistant mode streaming comes through worker_event, and sequence may restart each turn.
      || event.type === 'worker_event';

    if (sequence !== undefined && !isTimelineCritical) {
      const lastSequence = lastSequenceRef.current.get(streamKey) ?? 0;
      if (sequence <= lastSequence) {
        return true;
      }
      lastSequenceRef.current.set(streamKey, sequence);
    } else if (sequence !== undefined) {
      // 对于关键事件，仍然更新 counter（但不跳过）
      const lastSequence = lastSequenceRef.current.get(streamKey) ?? 0;
      if (sequence > lastSequence) {
        lastSequenceRef.current.set(streamKey, sequence);
      }
    }

    if (event.type === 'tool_call' || event.type === 'tool_result') {
      dbg(`[shouldSkipDuplicateEvent] ${event.type}:`, {
        toolName: event.toolName,
        toolId: event.toolId,
        sequence,
        lastSequence: lastSequenceRef.current.get(streamKey),
      });
    }

    let fingerprint = '';
    if (event.type === 'status') {
      fingerprint = `${event.level || 'info'}:${event.message || ''}`;
    } else if (event.type === 'log') {
      fingerprint = `${event.level || 'info'}:${event.message || ''}:${event.detail || ''}`;
    } else if (event.type === 'tool_call') {
      fingerprint = `${event.toolId || ''}:${event.toolName || ''}:${event.batchId || ''}`;
    } else if (event.type === 'tool_result') {
      fingerprint = `${event.toolId || ''}:${event.toolName || ''}:${event.success}:${event.resultLength || 0}`;
    } else if (event.type === 'error' || event.type === 'error_classified') {
      fingerprint = event.message || event.error || '';
    } else if (event.type === 'edit_file_stream') {
      // 保证 preview(isComplete=false) 与 complete(isComplete=true) 不会互相吞掉
      fingerprint = `${event.toolId || ''}:${event.filePath || ''}:${(event.oldString || '').substring(0, 50)}:${(event.newString || '').substring(0, 50)}:${event.isComplete === true ? 'done' : 'preview'}:${event.success === false ? 'error' : 'ok'}`;
    } else if (event.type === 'file_stream' || event.type === 'write_file_stream') {
      // 甚至同一路径短时间内 preview + complete + tool_result 连发；只按 filePath/isComplete
      // 会把后到的完成事件吞掉，导致 renderer 卡片停在旧错误/旧 pending 状态。
      fingerprint = `${event.toolId || event.toolCallId || event.id || ''}:${event.filePath || event.targetPath || ''}:${event.isComplete === true ? 'done' : event.isComplete === false ? 'running' : 'preview'}`;
    }

    if (!fingerprint) {
      return false;
    }

    const now = Date.now();
    const dedupeWindowMs = event.type === 'status' ? 250 : 1200;
    const dedupeKey = `${streamKey}:${event.type}:${fingerprint}`;
    const lastAt = recentEventRef.current.get(dedupeKey) || 0;

    if (now - lastAt < dedupeWindowMs) {
      if (event.type === 'tool_call' || event.type === 'tool_result') {
        console.warn(`[shouldSkipDuplicateEvent] ⚠️ SKIPPING ${event.type} by fingerprint dedup:`, {
          toolName: event.toolName,
          fingerprint,
          dedupeWindowMs,
          timeSinceLast: now - lastAt,
        });
      }
      return true;
    }

    recentEventRef.current.set(dedupeKey, now);
    if (recentEventRef.current.size > 1200) {
      const cutoff = now - 10_000;
      for (const [key, ts] of recentEventRef.current.entries()) {
        if (ts < cutoff) {
          recentEventRef.current.delete(key);
        }
      }
    }

    return false;
  }, []);

  // File stream helpers
  const recordFileStreamEntry = useCallback((sessionId: string, filePath: string, entryId: string) => {
    const key = fileStreamKey(sessionId, filePath);
    const prevEntryId = fileStreamEntryMapRef.current.get(key);
    if (prevEntryId && prevEntryId !== entryId) {
      console.warn('[DIAG recordFileStreamEntry] path remapped to different entry!', {
        filePath,
        prevEntryId,
        newEntryId: entryId,
      });
    }
    fileStreamEntryMapRef.current.set(key, entryId);
  }, [fileStreamEntryMapRef]);

  const trackFileStreamContent = useCallback((key: string, fullContent: string, isWriteComplete: boolean) => {
    if (isWriteComplete) {
      fileStreamLatestContentRef.current.delete(key);
    } else {
      fileStreamLatestContentRef.current.set(key, fullContent);
    }
  }, [fileStreamLatestContentRef]);

  const getFileStreamEntryId = useCallback((sessionId: string, filePath: string): string | undefined => {
    const exact = fileStreamEntryMapRef.current.get(fileStreamKey(sessionId, filePath));
    if (exact) return exact;

    const prefix = `${sessionId}:`;
    for (const [key, entryId] of fileStreamEntryMapRef.current.entries()) {
      if (!key.startsWith(prefix)) continue;
      const storedPath = key.slice(prefix.length);
      if (pathsMaybeMatch(storedPath, filePath)) {
        return entryId;
      }
    }

    return undefined;
  }, [fileStreamEntryMapRef]);

  const updateStreamingTokens = useCallback((sessionId: string, delta: string) => {
    if (!delta) return;
    const deltaTokens = estimateOutputTokens(delta);
    if (deltaTokens <= 0) return;
    const next = (streamingTokensRef.current.get(sessionId) || 0) + deltaTokens;
    streamingTokensRef.current.set(sessionId, next);
    if (activeSessionIdRef.current === sessionId) {
      setStreamingTokens(next);
    }
  }, [activeSessionIdRef, setStreamingTokens]);

  const resetStreamingTokens = useCallback((sessionId: string | null | undefined) => {
    if (!sessionId) return;
    streamingTokensRef.current.set(sessionId, 0);
    if (activeSessionIdRef.current === sessionId) {
      setStreamingTokens(0);
    }
  }, [activeSessionIdRef, setStreamingTokens]);

  const taskAgentBatchMapRef = useRef<Map<string, string>>(new Map());
  const researchEntryRef = useRef<Map<string, string>>(new Map());
  const turnUsageRef = useRef<Map<string, {
    tokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    model?: string;
    /* 生成速度用: 两个量**分别累加**, 最后再相除 —— 一轮里有多次 LLM 请求, 各自的
     * tok/s 直接平均会被短请求带偏 (一个只吐 3 个 token 的请求跟一个吐 2000 的等权)。
     * 总输出 ÷ 总生成时长 才是这一轮真实的吞吐。工具执行的时间不算在内: generationMs
     * 是"首 token → 末 token"的窗口, 由 forwarder 按每次请求给出。 */
    genTokens: number;
    genMs: number;
  }>>(new Map());

  useEffect(() => {
    if (!window.neox) {
      console.error('[App] window.neox is not available for stream');
      return;
    }

    let isActive = true;
    streamActiveRef.current = true;
    const STREAM_HIDDEN_FLUSH_MS = 100;
    const bufferedEvents: ExtendedStreamEvent[] = [];
    let bufferedFlushTimer: ReturnType<typeof setTimeout> | null = null;
    let bufferedFlushRaf: number | null = null;

    const shouldBufferEvent = (event: any): boolean => (
      event?.type === 'token'
      || event?.type === 'text'
      || event?.type === 'reasoning'
      || event?.type === 'reasoning_delta'
    );

    const flushBufferedEvents = () => {
      if (bufferedEvents.length === 0) return;
      const events = bufferedEvents.splice(0, bufferedEvents.length);
      for (const bufferedEvent of events) {
        try {
          processStreamEvent(bufferedEvent, true);
        } catch (err) {
          console.error('[Stream] buffered event handler threw, continuing:', err, bufferedEvent);
        }
      }
    };

    const runScheduledFlush = () => {
      if (bufferedFlushTimer !== null) { clearTimeout(bufferedFlushTimer); bufferedFlushTimer = null; }
      if (bufferedFlushRaf !== null) { cancelAnimationFrame(bufferedFlushRaf); bufferedFlushRaf = null; }
      if (!isActive) return;
      flushBufferedEvents();
    };

    const scheduleBufferedFlush = () => {
      if (bufferedFlushTimer !== null || bufferedFlushRaf !== null) return;
      if (typeof requestAnimationFrame === 'function') bufferedFlushRaf = requestAnimationFrame(runScheduledFlush);
      bufferedFlushTimer = setTimeout(runScheduledFlush, STREAM_HIDDEN_FLUSH_MS);
    };

    const processStreamEvent = (rawEvent: ExtendedStreamEvent, fromBuffer = false) => {
      const event: any = { ...(rawEvent as ExtendedStreamEvent) };
      if (!isActive) { noteStreamDrop('stale-subscription', event); return; }
      const resolvedSessionId = resolveStreamEventSessionId(event);
      if (!resolvedSessionId) {
        noteStreamDrop('no-session', event);
        const eventType = typeof event.type === 'string' ? event.type : 'unknown';
        const now = Date.now();
        const lastWarnAt = missingSessionIdEventRef.current.get(eventType) || 0;
        if (now - lastWarnAt > 5000) {
          missingSessionIdEventRef.current.set(eventType, now);
          const summary = {
            eventType,
            eventSubtype: event.event_type,
            toolName: event.toolName || event.name,
            sequence: event.sequence,
            taskAgentId: event.taskAgentId,
            activeSessionId: activeSessionIdRef.current,
          };
          console.warn('[Stream] dropping stream event without sessionId', summary);
          logToFile('STREAM_SESSION_GUARD', 'missing-session-id-drop', summary);
        }
        return;
      }
      event.sessionId = resolvedSessionId;
      resetStaleStatusWatchdog(resolvedSessionId);
      const taskAgentId = event.taskAgentId;
      const normalizedToolId = resolveToolCallId(event);
      if (
        normalizedToolId &&
        (event.type === 'tool_call'
          || event.type === 'tool_result'
          || event.type === 'tool_error'
          || event.type === 'edit_file_stream'
          || event.type === 'edit_file_stream_preview'
          || event.type === 'write_file_stream'
          || event.type === 'tool_call_streaming_update'
          || event.type === 'tool_call_start')
      ) {
        event.toolId = normalizedToolId;
      }

      // Debug: log all non-token events
      if (event.type !== 'token') {
        dbg('[Stream] Received event:', event.type, event.type === 'raw_response_event' ? `event_type=${event.event_type}` : '', taskAgentId ? `taskAgent=${taskAgentId}` : '');
      }
      if ((event.type === 'token' || event.type === 'text') && taskAgentId) {
        console.warn('[Stream] ⚠️ token/text event has taskAgentId! Will be filtered:', taskAgentId, 'content:', (event.content || event.delta || '').substring(0, 30));
      }

      if (event.type === 'session_execution_state') {
        const sid = event.sessionId as string | undefined;
        const st = (event as any).state;
        if (sid && sid !== '__unknown__' && (st === 'idle' || st === 'running' || st === 'recovering')) {
          applyAuthoritativeExecutionState?.(sid, st);
        }
        return;
      }

      if (shouldSkipDuplicateEvent(event)) {
        return;
      }

      if (event.type === 'user_message') {
        const userMsgSessionId = event.sessionId || activeSessionIdRef.current;
        if (!userMsgSessionId) return;
        const evtData = event.data ?? event;
        const text = (evtData.text ?? '') as string;
        const messageId = (evtData.messageId ?? evtData.message_id ?? '') as string;
        const source = (evtData.source ?? 'desktop') as string;
        const ts = (evtData.timestamp ?? event.timestamp ?? Date.now()) as number;
        if (!text || !messageId) return;
        maybeReconcileBackgroundTaskNotification(userMsgSessionId, text);
        const isBgTaskNotification = isBusEventMessage(text);
        if (!isBgTaskNotification) {
          closeSlot(userMsgSessionId, 'new-user-message-turn-boundary');
          /* 新一轮开始 = 上一轮的错误卡就此定案 (留在时间线上), 不再归本轮管。
           * 注意重试走的是同一条 user 消息 (server 不再重推), 所以不会误清本轮。 */
          turnErrorEntriesRef.current.delete(userMsgSessionId);
        }
        const existingUserEntry = (timelineMapRef.current.get(userMsgSessionId) || [])
          .find((e) => e.id === `msg-${messageId}`);
        appendTimelineEntry(userMsgSessionId, {
          id: `msg-${messageId}`,
          type: 'user_message' as const,
          title: 'User',
          detail: text,
          timestamp: existingUserEntry?.timestamp ?? ts,
          pending: false,
          messageId,
          /* source 字段先存 entry, 后续 UI 可显示 "from mobile" chip */
          messageSource: isBgTaskNotification ? 'system-background-task' : source,
        } as any, true);
        return;
      }

      if (event.type === 'queued_message_removed') {
        const sid = event.sessionId;
        const data = (event as any).data ?? event;
        if (sid && data.reason === 'interrupted') {
          const optimisticId = findClaimableOptimisticInject(timelineMapRef.current.get(sid), data.text);
          if (optimisticId) void deleteTimelineEntry?.(sid, optimisticId);
          window.dispatchEvent(new CustomEvent('neox:queued-message-rejected', {
            detail: { sessionId: sid, text: data.text, images: data.images, reason: data.reason },
          }));
        }
        return;
      }

      /* 排队插话消息被 server 真正处理的那一刻 → 此时才渲染进 timeline (运行中入队时不渲染)。
       * 不是 self-pushed (没 messageId dedup), 直接新建一条 user_message entry。 */
      if (event.type === 'user_message_injected') {
        if (taskAgentId) return;
        const sid = (event as any).sessionId || activeSessionIdRef.current;
        const evtData = (event as any).data ?? event;
        const text = (evtData.text ?? '') as string;
        if (!sid || !text) return;
        maybeReconcileBackgroundTaskNotification(sid, text);
        const ts = (evtData.timestamp ?? (event as any).timestamp ?? Date.now()) as number;
        /* 插话是助手文本的分界 (同 user_message): 不关槽, 后面的字会续写进插话之前那条气泡 */
        if (!isBusEventMessage(text)) closeSlot(sid, 'injected-user-message-boundary');
        /* 落气泡: 先认领插话按下时已经落下的那条乐观气泡, 认领不到才新建 —— 这条事件要等
         * 引擎**真正消费**才来, 无条件新建就是同一句话两个气泡。
         * 整段在 modules/agent-timeline/injectOptimisticBubble.ts。 */
        settleInjectedMessage({
          sessionId: sid, text, timestamp: ts, images: Array.isArray(evtData.images) ? evtData.images : undefined,
          isBackgroundTaskNotification: isBusEventMessage(text),
          entriesFor: (s) => timelineMapRef.current.get(s),
          update: updateTimelineEntryById as never,
          append: appendTimelineEntry as never,
        });
        /* 注入被引擎接受 = 引擎必然在跑新一轮 → 维持/恢复 streaming, 否则
         * 中断-注入的间隙里 run_result 已把 streaming 关掉, 运行态/停止按钮会消失. */
        dispatchStreaming(true, sid);
        /* 通知 composer 把这条从本地排队条 (queuedLocal) 移除 — 它只监听
         * streaming 变化, 不知道队列已被 steering drain. */
        try {
          window.dispatchEvent(new CustomEvent('neox:user-message-injected', { detail: { sessionId: sid, text } }));
        } catch { /* ignore */ }
        return;
      }

      if (event.type === 'tts_audio') {
        const evt = event.data ?? event;
        const audio = evt.audio as string | undefined;
        const format = (evt.audioFormat || 'mp3') as string;
        if (audio) {
          try {
            playTtsAudio(audio, format, evt.voiceSummary);
          } catch (e) {
            console.warn('[Stream] tts_audio playback error:', e);
          }
        }
        return;
      }

      if (event.type === 'tts_audio_chunk') {
        const evt = event.data ?? event;
        if (evt?.clipId) {
          try {
            ingestTtsAudioChunk({
              clipId: evt.clipId as string,
              seq: Number(evt.seq) || 0,
              audio: evt.audio as string | undefined,
              audioFormat: (evt.audioFormat || 'mp3') as string,
              sampleRate: evt.sampleRate as number | undefined,
              voiceSummary: evt.voiceSummary as string | undefined,
              final: evt.final === true,
              error: evt.error === true,
            });
          } catch (e) {
            console.warn('[Stream] tts_audio_chunk ingest error:', e);
          }
        }
        return;
      }

      if (taskAgentId) {
        if (typeof event.type === 'string' && event.type.startsWith('team_')) {
          /* 不 return, 往下走到 team_* 分支 */
        } else {
        const sessionId = event.sessionId || activeSessionIdRef.current;
        // worker_event 正常处理
        if (event.type === 'worker_event') {
          dbg('[Stream] 🔵 taskAgent worker event pass-through:', event.type, event.agentId);
          // 落到后面的正常处理逻辑
        } else if (event.type === 'worker_start' || event.type === 'worker_complete') {
          // 交给通用 worker handler，创建/更新 Explore 卡片
        } else if (event.type === 'tool_call' || event.type === 'tool_call_start') {
          if (sessionId) {
            const batchEntryId = taskAgentBatchMapRef.current.get(taskAgentId);
            const entryId = batchEntryId || `explore-${taskAgentId}`;
            const toolName = event.toolName || event.name || 'tool';
            const toolId = resolveToolCallId(event);
            const args = event.args || (event.arguments ? (() => { try { return JSON.parse(event.arguments); } catch { return undefined; } })() : undefined);
            updateTimelineEntryById(sessionId, entryId, (prev: ExploreTimelineEntry) => {
              const records = [...(prev.exploreToolRecords || [])];
              records.push({
                name: toolName,
                toolId,
                agentId: taskAgentId,
                args: args ? JSON.stringify(args) : undefined,
                status: 'running',
                timestamp: Date.now(),
              });
              // 更新 groupMember 的 toolCount
              const members = prev.exploreGroupMembers ? [...prev.exploreGroupMembers] : undefined;
              if (members) {
                const idx = members.findIndex((m) => m.agentId === taskAgentId);
                if (idx >= 0) {
                  members[idx] = { ...members[idx], toolCount: (members[idx].toolCount || 0) + 1 };
                }
              }
              return {
                ...prev,
                exploreToolCount: records.length,
                exploreToolRecords: records,
                exploreCurrentStatus: `${toolName}...`,
                ...(members ? { exploreGroupMembers: members } : {}),
                /* 父卡是 deep_research 活卡时, 顺带把这一路的工具数 +1 / 当前动作换掉。
                 * 没绑上 (普通 explore) 时它原样返回, 不影响上面那份。 */
                ...applyResearchWorkerTool(prev, taskAgentId, toolName),
              };
            });
          }
          return;
        } else if (event.type === 'tool_result' || event.type === 'tool_call_end') {
          if (sessionId) {
            const batchEntryId = taskAgentBatchMapRef.current.get(taskAgentId);
            const entryId = batchEntryId || `explore-${taskAgentId}`;
            const toolId = resolveToolCallId(event);
            updateTimelineEntryById(sessionId, entryId, (prev: ExploreTimelineEntry) => {
              const records = [...(prev.exploreToolRecords || [])];
              let lastRunning = -1;
              for (let i = records.length - 1; i >= 0; i--) {
                const record = records[i];
                if (
                  record.status === 'running' &&
                  record.agentId === taskAgentId &&
                  (!toolId || (record as any).toolId === toolId)
                ) {
                  lastRunning = i;
                  break;
                }
              }
              if (lastRunning < 0 && toolId) {
                for (let i = records.length - 1; i >= 0; i--) {
                  const record = records[i];
                  if ((record as any).toolId === toolId) {
                    lastRunning = i;
                    break;
                  }
                }
              }
              if (lastRunning >= 0) {
                const startTs = records[lastRunning].timestamp || 0;
                const duration = startTs > 0 ? Date.now() - startTs : undefined;
                const isError = (event as any).success === false
                  || event.type === 'tool_call_end' && (event as any).success === false;
                const errorReason = isError
                  ? ((event as any).errorMessage || (event as any).output || (event as any).error || 'tool dispatch failed')
                  : undefined;
                records[lastRunning] = {
                  ...records[lastRunning],
                  status: isError ? 'error' : 'done',
                  duration,
                  ...(errorReason ? { resultHint: errorReason.toString().slice(0, 120) } : {}),
                };
              }
              return { ...prev, exploreToolRecords: records };
            });
          }
          return;
        } else if (event.type === 'status' && event.message) {
          if (sessionId) {
            const batchEntryId = taskAgentBatchMapRef.current.get(taskAgentId);
            const entryId = batchEntryId || `explore-${taskAgentId}`;
            updateTimelineEntryById(sessionId, entryId, (prev: any) => ({
              ...prev,
              exploreCurrentStatus: String(event.message),
            }));
          }
          return;
        } else if (event.type === 'text' || event.type === 'token' || event.type === 'reasoning') {
          /* sub-agent 的文字 / token / reasoning delta — 不进主 timeline 文本, 但累计
           * token 计数让 composer 顶端的 livestatus 实时跑数字, 用户看到"agent 在干活".
           * 同时更新 explore 卡片自己的 exploreTokens 显示. */
          const delta = (event as any).delta || (event as any).content || (event as any).text || '';
          if (delta && typeof delta === 'string' && sessionId) {
            updateStreamingTokens(sessionId, delta);
            const batchEntryId = taskAgentBatchMapRef.current.get(taskAgentId);
            const entryId = batchEntryId || `explore-${taskAgentId}`;
            const deltaTokens = estimateOutputTokens(delta);
            updateTimelineEntryById(sessionId, entryId, (prev: any) => ({
              ...prev,
              exploreTokens: prev.exploreGroupMembers?.some((m: any) => m.iterations !== undefined)
                ? prev.exploreTokens : (prev.exploreTokens || 0) + deltaTokens,
              /* deep_research 活卡: 这一路的 token 也跟着涨 —— 用户要看的就是这个数 */
              ...applyResearchWorkerTokens(prev, taskAgentId, deltaTokens, 'add'),
            }));
          }
          return;
        } else if (event.type === 'token_usage' && (event as any).usage) {
          /* sub-agent 一轮结束的权威 usage — 用真实值覆盖估算的 exploreTokens. */
          const usage = (event as any).usage;
          const totalOut = Number(usage.completion_tokens || usage.output_tokens || 0);
          if (sessionId && totalOut > 0) {
            const batchEntryId = taskAgentBatchMapRef.current.get(taskAgentId);
            const entryId = batchEntryId || `explore-${taskAgentId}`;
            updateTimelineEntryById(sessionId, entryId, (prev: any) => ({
              ...prev,
              exploreTokens: Math.max(prev.exploreTokens || 0, totalOut),
              /* 权威 usage 是单轮的, 估算是整条命的累计 —— 取大不能直接盖, 否则数字往回跳 */
              ...applyResearchWorkerTokens(prev, taskAgentId, totalOut, 'max'),
            }));
          }
          return;
        } else {
          return;
        }
        }   /* team_* 例外的 else 收口 */
      }

      if (!fromBuffer && shouldBufferEvent(event)) {
        bufferedEvents.push(rawEvent);
        scheduleBufferedFlush();
        return;
      }

      if (!fromBuffer && bufferedEvents.length > 0) {
        flushBufferedEvents();
      }

      if (event.type === 'token' || event.type === 'text') {
        settleTurnErrorEntries(event.sessionId || activeSessionIdRef.current, true);
        const chunk = extractStreamText(event, ['content', 'delta', 'text', 'message', 'chunk']);
        if ((event as any).source === 'tool_args') {
          startTransition(() => updateStreamingTokens(event.sessionId || activeSessionIdRef.current || '', chunk));
        } else {
          const textSid = event.sessionId || activeSessionIdRef.current;
          /* 记一笔"这个会话刚吐了字" —— 「立即发送」要等流真的停了再插消息,
           * 否则中断残留的增量跟新一轮同帧重排 = 用户看到的抖动。见 state/streamActivity。
           * 先记再判: 就算这段字被丢掉, "流还没安静"也是事实, 接力方要据此继续等。 */
          noteStreamActivity(textSid);
          /* 用户已经按了停止 → 这些是中断路上的残留, 画上去就是"停了还在动"。
           * 已经画出来的半段文字由 closeSlot 定格保留, 不回滚。新一轮开始时
           * sendPrompt 会 clearUserStopMark, 那之后的字正常渲染。 */
          if (wasRecentlyStoppedByUser(textSid, 5000)) { noteStreamDrop('after-user-stop', event); return; }
          startTransition(() => appendAssistantTextChunk(textSid, chunk, event.sequence));
        }
      } else if (event.type === 'reasoning') {
        const sessionId = event.sessionId || activeSessionIdRef.current;
        const delta = extractStreamText(event, ['content', 'delta', 'text', 'message', 'reasoning', 'reasoning_content']);
        noteStreamActivity(sessionId);
        /* 同上: 停止后的残留 reasoning 也不再往上画 */
        if (wasRecentlyStoppedByUser(sessionId, 5000)) { noteStreamDrop('after-user-stop', event); return; }
        startTransition(() => appendReasoningChunk(sessionId, delta, event.timestamp));
      } else if (event.type === 'status') {
        const originalMsg = event.message || '';
        let msg = originalMsg;
        const tokenStreamStatusMatch = originalMsg.match(/^Streaming:\s*([^\s]+)\s+\(([\d.]+k?)\s+tokens?\)$/i);
        const charStreamStatusMatch = originalMsg.match(/^Streaming:\s*([^\s]+)\s+\((\d+)\s+chars\)$/i);
        if (tokenStreamStatusMatch || charStreamStatusMatch) {
          const streamToolNameRaw = (tokenStreamStatusMatch || charStreamStatusMatch)![1];
          const streamToolName = normalizeToolName(streamToolNameRaw) || streamToolNameRaw.toLowerCase();
          const streamedTokens = tokenStreamStatusMatch
            ? parseCompactCount(tokenStreamStatusMatch[2])
            : Math.ceil((Number(charStreamStatusMatch?.[2]) || 0) * 0.25);
          const streamSessionId = event.sessionId || activeSessionIdRef.current;
          if (streamSessionId) {
            const streamTimeline = timelineMapRef.current.get(streamSessionId) || [];
            const streamTarget = [...streamTimeline].reverse().find((entry: TimelineEntry) => {
              if (!entry.pending) return false;
              if (entry.type !== 'tool_call' && entry.type !== 'file_stream' && entry.type !== 'edit_file') return false;
              const entryTool = normalizeToolName(entry.toolName) || entry.toolName || '';
              return entryTool === streamToolName;
            });
            if (streamTarget) {
              updateTimelineEntryById(streamSessionId, streamTarget.id, (prev) => ({
                ...prev,
                streaming: true,
              }));
            }
          }
        }
        const compactMsgMap: Record<string, keyof typeof tRef.current.session> = {
          'Auto-compacting history...': 'compacting',
          '分析对话历史...': 'compactAnalyzing',
          '正在生成摘要...': 'compactSummarizing',
          '保存压缩结果...': 'compactSaving',
        };
        const compactKey = compactMsgMap[originalMsg];
        if (compactKey) {
          msg = tRef.current.session[compactKey];
          const sessionId = event.sessionId || activeSessionIdRef.current;
          if (compactKey === 'compacting' && sessionId) {
            ensurePendingCompactionEntry({
              sessionId,
              title: bi('📦 正在压缩上下文…', '📦 Compacting Context...'),
              detail: msg,
              timestamp: event.timestamp || Date.now(),
              status: 'started',
            });
            scrollToBottom();
          }
        }
        if (originalMsg === 'No compaction needed') {
          /* 宿主给了真实原因 (正在压缩中 / 摘要模型失败 / 未获收益 …) 就照实显示, 别一律"无需压缩" */
          const reason = typeof (event as any).compactReason === 'string'
            ? (event as any).compactReason.replace(/^[✓✗❌ℹ️ℹ\s]+/u, '').trim() : '';
          msg = reason || tRef.current.session.compactNotNeeded || originalMsg;
          const sessionId = event.sessionId || activeSessionIdRef.current;
          const timeline = sessionId ? (timelineMapRef.current.get(sessionId) || []) : [];
          const pendingCompaction = [...timeline].reverse().find(
            (e: any) => e.type === 'context_compaction' && e.pending
          );
          if (pendingCompaction) {
            updateTimelineEntryById(sessionId || undefined, pendingCompaction.id, {
              pending: false,
              compactionStatus: 'skipped',
              title: 'ℹ️ No Compaction Needed',
              detail: msg,
            });
          }
        }
        if (!compactKey) {
          msg = localizeStatusMessage(msg);
        }
        dispatchStatus(msg, event.sessionId);  /* 所有 status 事件的主路径 —— 入口守卫已保证 event.sessionId 非空 */
        const runningCommandMatch = originalMsg.match(/^Running:\s+(.+)$/i);
        if (runningCommandMatch) {
          const sessionId = event.sessionId || activeSessionIdRef.current;
          const commandText = runningCommandMatch[1].trim();
          if (sessionId && commandText) {
            const timeline = timelineMapRef.current.get(sessionId) || [];
            const existingShell = [...timeline].reverse().find((entry: TimelineEntry) => {
              if (entry.type !== 'tool_call' || !entry.pending) return false;
              if (entry.toolName !== 'execute_shell' && entry.toolName !== 'execute_bash') return false;
              const existingCommand = typeof entry.commandCode === 'string'
                ? entry.commandCode
                : (typeof entry.toolArgs?.command === 'string' ? entry.toolArgs.command : '');
              return existingCommand.trim() === commandText;
            });
            if (existingShell) {
              updateTimelineEntryById(sessionId, existingShell.id, (prev) => ({
                ...prev,
                title: '🔧 Calling: execute_shell',
                detail: `Running: ${commandText}`,
                pending: true,
                commandCode: prev.commandCode || commandText,
                commandStatus: 'running',
                toolName: prev.toolName || 'execute_shell',
                toolArgs: prev.toolArgs || { command: commandText },
                timestamp: event.timestamp || Date.now(),
              }));
            } else {
              appendTimelineEntry(sessionId, {
                id: createId('timeline-tool-call'),
                type: 'tool_call',
                title: '🔧 Calling: execute_shell',
                detail: `Running: ${commandText}`,
                timestamp: event.timestamp || Date.now(),
                level: 'info',
                pending: true,
                toolName: 'execute_shell',
                toolArgs: { command: commandText },
                commandCode: commandText,
                commandStatus: 'running',
              }, true);
            }
            scrollToBottom();
          }
          return;
        }
        //
        // 现象: agentRuntimeHost 的 heartbeat 每 5 秒发一条 status 提示
        // (`Tool is running... 5s` / `Explore agents running... 30s` /
        // `Waiting for response... 10s` / `Long wait (60s)...`), explore 跑 3 分钟
        // 就是几十条 status 事件. 旧代码用一个超大黑名单过滤已知文案, 没匹配
        // 上的就 appendTimelineEntry 创建一条 type='thinking', title=msg,
        // **没有 detail** 的 entry. TimelineEntry 渲染时
        // (`!thinkingBody && !thinkingPreview`) 会返回 `<div style={{height:1}}>`
        // 1px 占位, 视觉上看不见但 react-virtuoso 会给每一条留一个 row. 几十条
        // 1px row 叠在一起, 用户在 explore 卡片下就看到一大片"看不见东西的空白"
        // (用 DevTools 一查全是 data-known-size="1" 的隐藏 div).
        //
        // status 事件的语义本来就是"瞬时状态条更新", 上面 `dispatchStatus(msg)`
        // 已经把它推到底部 status bar 了, 完全没必要再往 timeline 里塞一条永久
        // 历史. 黑名单方案是按下葫芦浮起瓢 (新加 heartbeat 文案就又漏一条),
        // 直接停止创建 entry 才是根治. 持久化状态走 `case 'log'` / 专门 handler
        // (compaction / tool_call / reconnect 都已经有自己的入口), 不依赖这条通用
        // fallback.
      } else if (event.type === 'metrics') {
        // 子 agent(explore/侧路 haiku)的 usage 不能覆盖主模型的表盘/缓存命中率
        if ((event as any).taskAgentId) {
          return;
        }
        const eventSid = (event.sessionId as string | undefined) || undefined;
        const isActive = !eventSid || eventSid === activeSessionIdRef.current;
        /* 会话累积用量(forwarder 内存累加, 含子 agent) — 无条件收下写快照,
         * 这是弹窗"累积"tab 的数据源, 永远只增不清零。 */
        const sessionUsage = (event as any).sessionUsage;
        if (sessionUsage) {
          const prevSnap = getContextSnapshot(eventSid);
          setContextSnapshot({
            tokensUsed: 0,
            contextWindow: 0,
            ...(prevSnap ?? {}),
            sessionCache: sessionUsage,
            sessionId: eventSid || prevSnap?.sessionId,
            updatedAt: Date.now(),
          });
        }
        /* 子 agent 触发的累积刷新: 只更新 sessionCache, 本轮表盘字段全是 0, 到此为止。 */
        if ((event as any).sessionUsageOnly) {
          return;
        }
        const inputTokens = event.inputTokens || 0;
        const outputTokens = event.outputTokens || 0;
        const cacheReadTokens = event.cacheReadTokens || 0;
        const cacheWriteTokens = event.cacheWriteTokens || 0;
        if (eventSid && !(event as any).compacted) {
          const inTok = Number(event.inputTokens) || 0;
          const outTok = Number(event.outputTokens) || 0;
          const cacheTok = Number(event.cacheReadTokens) || 0;
          const turnTokens = inTok + outTok;
          const prevTurn = turnUsageRef.current.get(eventSid);
          const genMs = Number((event as any).generationMs) || 0;
          turnUsageRef.current.set(eventSid, {
            tokens: (prevTurn?.tokens ?? 0) + turnTokens,
            inputTokens: (prevTurn?.inputTokens ?? 0) + inTok,
            outputTokens: (prevTurn?.outputTokens ?? 0) + outTok,
            cacheReadTokens: (prevTurn?.cacheReadTokens ?? 0) + cacheTok,
            model: (event as any).model || prevTurn?.model,
            genTokens: (prevTurn?.genTokens ?? 0) + (genMs > 0 ? outTok : 0),
            genMs: (prevTurn?.genMs ?? 0) + genMs,
          });
        }
        const latestReqUsage = {
          model: (event as any).model,
          inputTokens,
          billableInputTokens: event.billableInputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          totalTokens: event.tokens,
          breakdown: event.breakdown,
          generationMs: Number((event as any).generationMs) || undefined,
          firstTokenMs: Number((event as any).firstTokenMs) || undefined,
        };
        /* provider 偶发丢 usage 字段(流式末尾 usage chunk 缺失)会发出全 0 的 metrics —
         * 全 0 覆盖会把弹窗"本轮"区块整个打空(空白一轮, 下一轮又恢复)。保留上一轮。 */
        const hasRequestUsage = inputTokens > 0 || outputTokens > 0
          || cacheReadTokens > 0 || cacheWriteTokens > 0;
        if (hasRequestUsage || event.contextUsed > 0) {
          const prev = getContextSnapshot(eventSid);
          setContextSnapshot({
            ...(prev ?? { tokensUsed: 0, contextWindow: 0, updatedAt: 0 }),
            tokensUsed: event.contextUsed > 0 ? event.contextUsed : (prev?.tokensUsed ?? 0),
            contextWindow: prev?.contextWindow || 0,
            breakdown: event.breakdown || prev?.breakdown,
            latestRequestUsage: hasRequestUsage ? latestReqUsage : prev?.latestRequestUsage,
            sessionId: eventSid || prev?.sessionId,
            updatedAt: Date.now(),
          });
        }
        if (!isActive) return;
        dispatchTotalTokens(event.tokens);
        /* metric 偶有 contextUsed=0 (上游 contextTokens 缺), 不能让它打回 state. */
        if (event.contextUsed > 0) {
          dispatchContextUsed(event.contextUsed);
        }
        if (hasRequestUsage) {
          setLatestRequestUsage(latestReqUsage);
        }
        onRequestMetrics?.({
          inputTokens,
          billableInputTokens: event.billableInputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          totalTokens: event.tokens || 0,
        });
      } else if (event.type === 'thinking') {
        // Clear reasoning stream for new iteration
        if (event.sessionId) {
          closeReasoningEntry(event.sessionId);
        }

        // Mark pending reconnect as complete
        const currentTimeline = timelineMapRef.current.get(event.sessionId) || [];
        const pendingReconnectEntry = currentTimeline.find(
          (e: TimelineEntry) => e.type === 'log' && e.level === 'warning' &&
            e.pending && e.reconnectAttempt !== undefined
        );
        if (pendingReconnectEntry) {
          updateTimelineEntryById(event.sessionId, pendingReconnectEntry.id, {
            pending: false,
            title: bi('连接已恢复', 'Reconnected'),
          });
        }

        const thinkingHints = [
          bi('正在理解这个请求…', 'Analyzing the request...'),
          bi('正在规划下一步…', 'Planning next steps...'),
          bi('正在回看上下文…', 'Reviewing context...'),
          bi('正在组织回答…', 'Preparing response...'),
          bi('正在权衡几种做法…', 'Evaluating options...'),
          bi('正在处理信息…', 'Processing information...'),
        ];

        let thinkingMessage = '';
        const timeline = timelineMapRef.current.get(event.sessionId) || [];
        const lastEntry = timeline.length > 0 ? timeline[timeline.length - 1] : null;

        if (event.iteration === 1) {
          thinkingMessage = bi('正在理解你的需求…', 'Analyzing your request...');
        } else if (lastEntry?.type === 'tool_result' || lastEntry?.type === 'tool_call') {
          const toolName = lastEntry.toolName || '';
          if (toolName.toLowerCase().includes('read')) {
            thinkingMessage = bi('正在读文件内容…', 'Analyzing file contents...');
          } else if (toolName.toLowerCase().includes('grep') || toolName.toLowerCase().includes('search')) {
            thinkingMessage = bi('正在看搜索结果…', 'Processing search results...');
          } else if (toolName.toLowerCase().includes('edit') || toolName.toLowerCase().includes('write')) {
            thinkingMessage = bi('正在检查改动…', 'Reviewing changes...');
          } else if (toolName.toLowerCase().includes('bash') || toolName.toLowerCase().includes('shell')) {
            thinkingMessage = bi('正在看命令输出…', 'Analyzing command output...');
          } else if (toolName.toLowerCase().includes('tree') || toolName.toLowerCase().includes('list')) {
            thinkingMessage = bi('正在摸清项目结构…', 'Understanding project structure...');
          } else {
            thinkingMessage = bi('正在处理结果…', 'Processing results...');
          }
        } else {
          thinkingMessage = thinkingHints[(event.iteration - 1) % thinkingHints.length];
        }

        const displayText = bi(
          `${thinkingMessage} (第 ${event.iteration} 轮)`,
          `${thinkingMessage} (iteration ${event.iteration})`,
        );
        dispatchStatus(displayText, event.sessionId);
      } else if (event.type === 'tool_call') {
        // 展开时显示调用详情，完成后 auto-collapse（TimelineEntry.cardAutoCollapsed: !event.pending）
        // 这同时修复了“多轮对话共用一个 bubble”的问题：
        //   handleToolCall 标记 messageCompleted → 下一段文字创建新 message
        handleToolCall(event);
      } else if (event.type === 'tool_result') {
        handleToolResult(event);
      } else if (event.type === 'queued_message_added') {
        const label = typeof event.position === 'number' ? statusT('messageQueued', { position: event.position }) : statusT('messageQueued', { position: '' });
        dispatchStatus(label, event.sessionId);
      } else if (event.type === 'queued_messages_processed') {
        if ((event.count || 0) > 0) {
          dispatchStatus(statusT('messagesDelivered', { count: event.count || 0 }), event.sessionId);
        }
      } else if (event.type === 'tool_error') {
        if (event.toolName === 'edit' || event.toolName === 'edit_file' || event.toolName === 'str_replace_editor') {
          logToFile('EDIT_DEBUG', 'tool_error', {
            eventType: event.type,
            toolName: event.toolName,
            toolId: event.toolId,
            id: event.id,
            toolCallId: event.toolCallId,
            sessionId: event.sessionId,
            errorReason: event.errorReason,
            errorPrefix: typeof event.error === 'string' ? event.error.slice(0, 200) : null,
            sequence: event.sequence,
            timestamp: event.timestamp,
          });
        }
        const toolName = normalizeToolName(event.toolName) || event.toolName || '';
        // 放宽截断：ephemeral error 是结构化 JSON，TimelineEntry 要 JSON.parse 抽字段，
        // 如果截断到 600 字符 JSON 就会 parse 失败，UI 直接显示裸 JSON 字符串。
        // 这里给 4000 字符足够装下任何合理的 ephemeral payload。
        const rawErrorText = typeof event.error === 'string'
          ? event.error
          : formatTimelineDetail(event.error, 4000);

        /* 正文只放人话 (载荷里没有错误信息时给兜底文案, 原始载荷挂 errorRawPayload);
         * "不是故障"标记从原始载荷认出来带上 —— 判据与缘由见 ./toolErrorMessage.describeToolError */
        const { humanError, errorText, toolGuidance } = describeToolError(event.error, getGlobalLanguage());
        const eventTimestamp = event.timestamp || Date.now();
        const sessionId = normalizeAssistantSessionId(event.sessionId) || activeSessionIdRef.current;
        const isShellTool = toolName === 'execute_bash' || toolName === 'execute_shell';

        if (isShellTool && sessionId) {
          const sessionTimeline = timelineMapRef.current.get(sessionId) || [];
          const byToolId = findEntryByToolId(
            sessionTimeline,
            event.toolId,
            (entry) => !!entry.commandCode,
          );
          const commandEntry = byToolId || [...sessionTimeline].reverse().find((entry: TimelineEntry) =>
            !!entry.commandCode &&
            entry.toolName === toolName &&
            (entry.pending || entry.commandStatus === 'running' || Math.abs((entry.timestamp || 0) - eventTimestamp) < 30000)
          );

          if (commandEntry) {
            updateTimelineEntryById(sessionId, commandEntry.id, (entry: TimelineEntry) => ({
              ...entry,
              type: 'tool_result',
              pending: false,
              success: false,
              level: 'error',
              commandStatus: 'error',
              detail: entry.detail || errorText,
              output: entry.output || event.error,
              errorReason: event.errorReason,
              timestamp: eventTimestamp,
            }), true);
            scrollToBottom();
            return;
          }

          appendTimelineEntry(sessionId, {
            id: createId('timeline-tool-result'),
            type: 'tool_result',
            title: `❌ ${toolName} completed with errors`,
            detail: errorText,
            timestamp: eventTimestamp,
            level: 'error',
            pending: false,
            toolName,
            success: false,
            errorReason: event.errorReason,
          }, true);
          scrollToBottom();
          return;
        }

        const messageText = statusT('toolError', { toolName });
        dispatchStatus(messageText, sessionId ?? undefined);
        // 去重：如果 handleToolResult 已经把失败的 tool_call 就地转成了 tool_error
        // （例如 edit_file 文件不存在的场景），这里就不要再追加一条新的 tool_error entry，
        // 否则会出现"同一个失败事件渲染出两个 tool-error-card"的重复。
        if (sessionId) {
          const sessionTl = timelineMapRef.current.get(sessionId) || [];
          const isToolRow = (entry: TimelineEntry) =>
            entry.type === 'tool_error' || entry.type === 'tool_call' || entry.type === 'tool_result';

          const failedTool = normalizeToolName(toolName) || toolName.toLowerCase();
          const existingToolError = findEntryByToolId(sessionTl, event.toolId, isToolRow)
            || [...sessionTl].reverse().find((entry: TimelineEntry) =>
              isToolRow(entry)
              && (normalizeToolName(entry.toolName) || (entry.toolName || '').toLowerCase()) === failedTool
              && entry.type !== 'tool_error'
              && (entry.pending || Math.abs((entry.timestamp || 0) - eventTimestamp) < 30000)
            );
          if (existingToolError) {
            // 补齐拒绝原因 / detail（如果原来的是占位）; 顺带把这一行落成失败态,
            // 否则 tool_call 行还挂着 pending 转圈, 失败信息只在别处。
            updateTimelineEntryById(sessionId, existingToolError.id, (entry: TimelineEntry) => ({
              ...entry,
              type: 'tool_error' as TimelineEntry['type'],
              success: false,
              streaming: false,
              detail: (entry.detail && !isStreamingPlaceholderDetail(entry.detail)) ? entry.detail : errorText,
              errorMessage: (entry as { errorMessage?: string }).errorMessage || errorText,
              errorReason: entry.errorReason || event.errorReason,
              level: 'error',
              pending: false,
              ...(toolGuidance ? { toolGuidance: true } : null),
            }));
            return;
          }
        }
        const stoppedByUser = !event.errorReason && wasRecentlyStoppedByUser(event.sessionId || '');
        appendTimelineEntry(event.sessionId, {
          id: createId('timeline-tool-error'),
          type: 'tool_error',
          title: messageText,
          detail: errorText,
          /* 载荷里认不出错误信息时, errorText 是一句人话, 原始载荷会在这里 ——
           * 排障要的是它, 「复制错误详情」也从这里取。有错误信息时两者相同, 不额外占地。 */
          errorRawPayload: humanError ? undefined : rawErrorText,
          timestamp: eventTimestamp,
          level: 'error',
          pending: false,
          // step 8 (deny refactor): 透传结构化原因，让 TimelineEntry 不再
          // 字符串匹配 "User denied approval"
          errorReason: stoppedByUser ? 'interrupted' : event.errorReason,
          ...(stoppedByUser ? { interrupted: true, errorMessage: bi('你点了停止', 'You pressed Stop') } : null),
          ...(toolGuidance ? { toolGuidance: true } : null),
          toolName,
          // 保留 toolCallId 让后续去重和 tool_call 生命周期匹配生效
          toolCallId: event.toolId,
        } as any);
      } else if (event.type === 'tool_call_delta') {
        // 而 tool_call_start 要等所有 args 解析完才发. 中间这段差几秒 (search) 到几十秒
        // (write_file) 用户都看不到任何卡片, 只有底栏一行 "流式: search (47 tokens)" 提示,
        // 体感像卡死. 这里看到第一个 delta 就建 pending 卡, 让 "工具名立即露面" 像 CC.
        //
        // 所有 tool 都建占位卡 (转圈圈 + 工具名). 短工具偶尔会有一瞬卡片闪现, 但比
        // "看不到任何卡片" 好得多 — CC/Cursor 都这么做. write/edit 走特殊 type 让
        // handleFileStream / handleEditFileStreamPreview 后续能 claim 升级.
        //
        // 追加原始 JSON 片段, 再从中抽出主参数 (query/path/command/pattern...) 塞到 detail,
        // 让用户看到 agent 实时"打字"的内容, 而不是冷冰冰"N tokens". 见 extractStreamedArgPreview.
        const argsDeltaText: string = (event as any).argumentsDelta || (event as any).arguments_delta || '';
        const tcdSessionId = event.sessionId || activeSessionIdRef.current;
        /* call_tool 透明化: 后端探测到内层工具名 (web_search 等) 时随 delta 带 innerToolName,
         * 优先用它建卡, 让流式占位卡直接显示真实工具名而不是 "Call tool"。 */
        const tcdOuterName = event.name || event.toolName;
        const tcdInner = (event as any).innerToolName as string | undefined;
        const tcdToolName = ((tcdOuterName || '').toLowerCase() === 'call_tool' && tcdInner)
          ? tcdInner
          : tcdOuterName;
        const tcdToolId = event.toolId || event.toolCallId;
        const tcdNormalized = (tcdToolName || '').toLowerCase();
        const isWriteFileTool = tcdNormalized === 'write_file' || tcdNormalized === 'write';
        const isEditFileTool = tcdNormalized === 'edit_file' || tcdNormalized === 'edit';
        /* explore/agent/ask_user/surface 工具走独立 UI 通道 (ExploreCard / AgentDelegation /
         * AskUserCard / SurfacePanel), timeline 不画 placeholder 占位, 否则两个卡片并存. */
        const skipPlaceholder = (
          tcdNormalized === 'explore'
          || tcdNormalized === 'agent'
          || tcdNormalized === 'ask_user'
          || tcdNormalized === 'send_message'
          || tcdNormalized === 'query_agent'
          || tcdNormalized === 'update_plan'
          || /^(open_surface|update_)/.test(tcdNormalized)
        );
        if (tcdSessionId && tcdToolName && !skipPlaceholder) {
          const tcdTimeline = timelineMapRef.current.get(tcdSessionId) || [];
          const tcdNow = Date.now();
          /* 去重三道:
           *   (1) 同 toolId 已建过卡 → 跳过 (forwarder 现在只对每个 tool 首个 delta 发, 但保险)
           *   (2) handleFileStream / handleEditFileStreamPreview 抢先建了卡 → 别重复 */
          const dupById = tcdToolId
            ? tcdTimeline.find((e: TimelineEntry) => e.toolCallId === tcdToolId)
            : undefined;
          const recentSameTool = !dupById
            ? tcdTimeline.find((e: TimelineEntry) =>
                e.toolName === tcdToolName &&
                e.pending &&
                (e.streaming === true || e.editStreaming === true || e.type === 'tool_call' || e.type === 'file_stream' || e.type === 'edit_file') &&
                (tcdNow - (e.timestamp ?? 0)) < 8000
              )
            : undefined;
          const stoppedLate = wasRecentlyStoppedByUser(tcdSessionId); /* 停止后晚到的残留 delta 不建卡: 它等不到 tool_call, 只会变孤儿 */
          if (!dupById && !recentSameTool && !stoppedLate) {
            if (isEditFileTool) {
            } else if (isWriteFileTool) {
              appendTimelineEntry(tcdSessionId, {
                id: createId(PLACEHOLDER_ID_PREFIX),
                type: 'tool_call',
                title: bi('写入文件 · 接收中', 'Writing file · receiving'),
                detail: '',
                timestamp: event.timestamp || tcdNow,
                level: 'info',
                pending: true,
                streaming: true,
                toolName: tcdToolName,
                toolCallId: tcdToolId,
              }, true);
            } else {
              /* 通用工具 (search / grep / bash / web_fetch / read / mcp__* 等):
               * 建一张 streaming=true + pending 的 tool_call 卡. handleToolCall 后续按
               * toolCallId 找到就在原位升级 (line 2084), 工具名 + 真实 args + 副标题. */
              const displayName = tcdToolName.startsWith('mcp__')
                ? tcdToolName.replace(/^mcp__/, '')
                : tcdToolName.charAt(0).toUpperCase() + tcdToolName.slice(1).replace(/_/g, ' ');
              /* 首帧 delta 已带的 argsDelta 顺手抽预览, 建卡就带内容, 少一次 update */
              const initialPreview = extractStreamedArgPreview(argsDeltaText);
              appendTimelineEntry(tcdSessionId, {
                id: createId(PLACEHOLDER_ID_PREFIX),
                type: 'tool_call',
                title: `${displayName}`,
                detail: initialPreview || '', // 空态时 UI 只出转圈圈, 不再"流式接收参数..."噪音
                timestamp: event.timestamp || tcdNow,
                level: 'info',
                pending: true,
                streaming: true,
                toolName: tcdToolName,
                toolCallId: tcdToolId,
                streamedArgsRaw: argsDeltaText,
                streamedArgPreview: initialPreview || undefined,
              }, true);
            }
            scheduleScrollToBottom();
          } else if ((dupById || recentSameTool) && argsDeltaText && !stoppedLate) {
            /* 卡已存在 + delta 有内容 → 累积到 streamedArgsRaw 并刷新预览.
             * 命中 dupById 优先 (toolId 精确), 兜底 recentSameTool. */
            const target = dupById || recentSameTool!;
            updateTimelineEntryById(tcdSessionId, target.id, (prev) => {
              const nextRaw = (prev.streamedArgsRaw || '') + argsDeltaText;
              const nextPreview = extractStreamedArgPreview(nextRaw);
              return {
                ...prev,
                streamedArgsRaw: nextRaw,
                streamedArgPreview: nextPreview || prev.streamedArgPreview,
                detail: nextPreview || prev.detail,
              };
            });
          }
        }
      } else if (event.type === 'plan_update') {
        handlePlanUpdate(event);
      } else if (event.type === 'edit_file_stream') {
        handleEditFileStream(event);
      } else if (event.type === 'edit_file_stream_preview') {
        handleEditFileStreamPreview(event);
      } else if (event.type === 'write_file_stream') {
        handleWriteFileStream(event);
      } else if (event.type === 'text_complete') {
        handleTextComplete(event);
      } else if (event.type === 'reasoning_complete') {
        handleReasoningComplete(event);
      } else if (event.type === 'file_stream') {
        handleFileStream(event);
      } else if (event.type === 'shell_output_stream') {
        handleShellOutputStream(event);
      } else if (event.type === 'memory') {
        /* 按 sessionId 合并写入 — 保留该会话已有的 latestRequestUsage / sessionCache,
         * 非活跃会话也更新 Map (切回去不丢), 仅 UI mirror 限活跃会话。 */
        const eventSid = event.sessionId as string | undefined;
        const prev = getContextSnapshot(eventSid);
        const snap = {
          tokensUsed: event.tokensUsed,
          contextWindow: event.contextWindow,
          state: event.state,
          pressure: event.pressure,
          byType: event.byType,
          breakdown: event.breakdown,
        };
        setContextSnapshot({
          ...(prev ?? {}),
          ...snap,
          latestRequestUsage: prev?.latestRequestUsage,
          sessionCache: prev?.sessionCache,
          sessionId: eventSid,
          updatedAt: Date.now(),
        });
        if (activeSessionIdRef.current !== eventSid) return;
        setMemorySnapshot(snap);
      } else if (event.type === 'log') {
        handleLogEvent(event);
      } else if (event.type === 'stream_retry') {
        handleStreamRetry(event);
      } else if (event.type === 'stream_recovered') {
        handleStreamRecovered(event);
      } else if (event.type === 'session_interrupted') {
        handleSessionInterrupted(event);
      } else if (event.type === 'session_title_changed') {
        try {
          const title = String((event as any).title ?? '').trim();
          const sid = String((event as any).sessionId ?? '');
          if (title && sid) {
            window.dispatchEvent(new CustomEvent('neox:session-title-changed', { detail: { sessionId: sid, title } }));
          }
        } catch { /* 标题刷新失败不能影响流处理 */ }
      } else if (event.type === 'session_resumed') {
        handleSessionResumed(event);
      } else if (event.type === 'session_resume_failed') {
        handleSessionResumeFailed(event);
      } else if (event.type === 'checkpoint') {
        handleCheckpoint(event);
      } else if (event.type === 'agent_wrote_path') {
        /* WriteLedger 热路径: Normalizer 已 record; 这里再记一次保证 renderer 进程账本同步
         * (Electron 主/渲染隔离时 kernel 单例不共享). */
        try {
          const paths = Array.isArray(event.paths) ? event.paths.filter((p: unknown) => typeof p === 'string') : [];
          if (event.sessionId && paths.length > 0) {
            recordWriteDeclaration({
              sessionId: String(event.sessionId),
              toolCallId: String(event.toolCallId || event.id || `wrote_${Date.now()}`),
              toolName: String(event.toolName || 'unknown'),
              op: (event.op === 'edit' || event.op === 'delete' || event.op === 'rename') ? event.op : 'write',
              paths,
              from: typeof event.from === 'string' ? event.from : undefined,
              ts: typeof event.timestamp === 'number' ? event.timestamp : Date.now(),
              evidence: event.evidence === 'shell_declared' || event.evidence === 'shell_proc' || event.evidence === 'tool_ui_meta'
                ? event.evidence
                : 'tool_result_path',
            });
          }
        } catch { /* ignore */ }
      } else if (event.type === 'run_result') {
        /* TTS muted 语义 = "本轮内静音" (停止朗读按钮/语音打断设的) — 回合结束
         * 自动解除, 下一轮播报不受影响。本轮残句已被 stop 清队/muted 丢弃。 */
        try { getTtsPlayer().setMuted(false); } catch { /* noop */ }
        handleRunResult(event);
      } else if (event.type === 'turn_complete') {
        // assistant 不走 agent loop 所以不会发 run_result，而是发 turn_complete
        handleResponseCompleted(event);
      } else if (event.type === 'error_classified') {
        handleErrorClassified(event);
      } else if (event.type === 'fallback') {
        handleFallback(event);
      } else if (event.type === 'recovery') {
        handleRecovery(event);
      } else if (event.type === 'raw_response_event' && event.event_type === 'dsml.incomplete_retry') {
        handleDsmlIncompleteRetry(event);
      } else if (event.type === 'raw_response_event' && event.event_type === 'context_compaction') {
        handleContextCompaction(event);
      } else if (event.type === 'raw_response_event' && event.event_type === 'target.continuation') {
        handleTargetContinuation(event);
      } else if (event.type === 'context_compaction') {
        handleDirectContextCompaction(event);
      } else if (event.type === 'provider_status') {
        handleProviderStatus(event);
      } else if (event.type === 'network_task_analysis') {
        handleNetworkTaskAnalysis(event);
      } else if (event.type === 'network_mode_select') {
        handleNetworkModeSelect(event);
      } else if (event.type === 'network_agent_execution') {
        handleNetworkAgentExecution(event);
      } else if (event.type === 'network_bidding') {
        handleNetworkBidding(event);
      } else if (event.type === 'network_agent_bid') {
        handleNetworkAgentBid(event);
      } else if (event.type === 'network_negotiation') {
        handleNetworkNegotiation(event);
      } else if (event.type === 'network_dag_topology') {
        handleNetworkDAGTopology(event);
      } else if (event.type === 'network_replan') {
        handleNetworkReplan(event);
      } else if (event.type === 'agent_message') {
        handleAgentMessage(event);
      } else if (event.type === 'worker_start') {
        handleWorkerStart(event);
      } else if (event.type === 'worker_complete') {
        handleWorkerComplete(event);
      } else if (event.type === 'worker_event') {
        handleWorkerEvent(event);
        //    状态机在 teamRunStore, Surface 是可视化主场, timeline 不加卡
      } else if (event.type === 'sub_agent') {
        /* 子 agent 的 run_result 被 onTaskAgentEvent 拦掉, 不会镜像进子会话.
         * 直播缓存又挡住 done 之后的 DB 收敛 → 最后一张 pending 工具会永远转圈.
         * lifecycle done/aborted 是子线程真正结束的信号, 在这儿把子会话 + 父派发卡收掉. */
        const action = (event as any).action || (event as any).data?.action;
        if (action === 'done' || action === 'aborted') {
          settleSubAgentFinished({
            ...event,
            action,
            agentId: (event as any).agentId || (event as any).data?.agentId,
            status: (event as any).status || (event as any).data?.status,
          });
        }
      } else if (event.type === 'team_plan_update') {
        /* 团队规划三阶段的实时快照 —— 看板靠它长, 落库那份是刷新后的重建来源。
         * sessionId 同样**不兜底**当前会话 (见下面 team_exec_update 的说明: 会话隔离)。 */
        const sid = (event as any).sessionId;
        if (sid) {
          const isNew = ingestTeamPlanEvent(sid, event);
          if (isNew) {
            void import('../../../state/teamRunStore').then(({ openTeamSurface }) => {
              openTeamSurface(sid, {
                teamId: String((event as any).teamId || sid),
                goal: (event as any).goal,
                reveal: true,
              });
            }).catch(() => { /* 开不出来不影响规划本身 */ });
          }
        }
      } else if (event.type === 'team_exec_update') {
        const sid = (event as any).sessionId;
        if (sid) {
          const first = ingestTeamExecEvent(sid, event);
          if (first) {
            void import('../../../state/teamRunStore').then(({ openTeamSurface }) => {
              openTeamSurface(sid, { teamId: String((event as any).teamId || sid), reveal: true });
            }).catch(() => { /* 开不出来不影响执行 */ });
          }
        }
      } else if (event.type === 'team_run_start'
        || event.type === 'team_lane_update'
        || event.type === 'team_blackboard_post'
        || event.type === 'team_run_complete') {
        const teamSessionId = (event as any).sessionId;
        if (teamSessionId) ingestTeamRunEvent(teamSessionId, event as unknown as TeamRunEvent);
      } else if (event.type === 'research_progress') {
        const sid = (event as any).sessionId;
        if (sid) {
          const entries = timelineMapRef.current.get(sid) || [];
          /* 从后往前找父卡: 已经挂过活卡数据的优先 (最可靠), 否则找还在跑的 deep_research
           * 工具条目。认工具名要走 isDeepResearchEntry —— 模型多半经 call_tool 调它。 */
          let targetId: string | undefined;
          for (let i = entries.length - 1; i >= 0; i--) {
            const e: any = entries[i];
            if (hasResearchLiveData(e) || (e.pending && isDeepResearchEntry(e))) { targetId = e.id; break; }
          }
          if (targetId) {
            researchEntryRef.current.set(sid, targetId);
            updateTimelineEntryById(sid, targetId, (prev: any) => ({
              ...prev,
              ...applyResearchProgress(prev, event as any),
            }));
          }
        }
      } else if (event.type === 'error') {
        handleRunnerError(event);
      }
    };

    const unsubscribe = window.neox.onStream((rawEvent) => {
      /* try/catch outer 同理: 单条事件抛错不能影响后续 chat:stream 投递. 不包的话
       * IPC 层异常被 Electron 吞掉, renderer 表面看就是 "事件突然就没了". */
      try {
        processStreamEvent(rawEvent as ExtendedStreamEvent, false);
      } catch (err) {
        console.error('[Stream] top-level event handler threw:', err, rawEvent);
        logToFile('STREAM_ERROR', 'top-level-handler-threw', { message: (err as any)?.message, eventType: (rawEvent as any)?.type });
      }
    });

    return () => {
      isActive = false;
      streamActiveRef.current = false;
      if (bufferedFlushTimer !== null) {
        clearTimeout(bufferedFlushTimer);
        bufferedFlushTimer = null;
      }
      if (bufferedFlushRaf !== null) {
        cancelAnimationFrame(bufferedFlushRaf);
        bufferedFlushRaf = null;
      }
      if (staleStatusWatchdogRef.current) {
        clearTimeout(staleStatusWatchdogRef.current);
        staleStatusWatchdogRef.current = null;
      }
      bufferedEvents.length = 0;
      unsubscribe();
    };
  }, [
    activeSessionIdRef,
    appendTimelineEntry,
    dispatchContextUsed,
    dispatchMessages,
    dispatchStatus,
    dispatchTotalTokens,
    applyAuthoritativeExecutionState,
    fileStreamEntryMapRef,
    fileStreamLatestContentRef,
    formatWorkspacePath,
    messageMapRef,
    openOrUpdateFileInEditorRef,
    recentClassifiedErrorRef,
    reasoningStreamRef,
    resetStreamingTokens,
    scrollToBottom,
    setCanRetry,
    setMemorySnapshot,
    setRetryError,
    setRuntimeLogs,
    setStreamingTokens,
    ensurePendingCompactionEntry,
    shouldSkipDuplicateEvent,
    tRef,
    timelineMapRef,
    updateTimelineEntry,
    updateTimelineEntryById,
    updateStreamingTokens,
  ]);

  // Handler functions
  function closeCurrentAssistantMessage(sessionId: string | null | undefined, reason: string): void {
    /* Assistant 文本段结束后可能马上进入 tool_call / worker_start.
     * 这时整轮还没结束,但这条消息本身已经不是 streaming 了;否则 UI 会在上一句话
     * 末尾继续显示闪烁光标,看起来像空白 agent 卡住。 ActiveSlot reducer 一步完成
     * drain + phase=closed + UI pending=false, 不再分散 mutate 三 ref. */
    closeSlot(sessionId, reason);
  }

  function handleToolCall(event: any) {
    dbg('[handleToolCall] 🔧 Received tool_call:', {
      toolName: event.toolName,
      sequence: event.sequence,
      timestamp: event.timestamp,
    });
    let toolName = normalizeToolName(event.toolName) || event.toolName || '';
    if (toolName.toLowerCase() === 'call_tool') {
      const wrap = normalizeToolArgsForUi(event.args);
      const inner = (typeof wrap?.name === 'string' && wrap.name)
        || (typeof wrap?.tool === 'string' && wrap.tool)
        || (typeof wrap?.tool_name === 'string' && wrap.tool_name) || '';
      if (inner) {
        toolName = normalizeToolName(inner) || inner;
        event = { ...event, toolName: inner, args: wrap.args ?? wrap.arguments ?? wrap.input ?? {} };
      }
    }
    const isUpdatePlanTool = toolName === 'update_plan';

    // 这样后续的 token 会创建新消息，实现：文本1 → 工具调用 → 文本2（新消息）
    const sessionId = normalizeAssistantSessionId(event.sessionId) || activeSessionIdRef.current;
    if (sessionId) {
      closeCurrentAssistantMessage(sessionId, 'tool_call');
    }

    const messageText = statusT('callingTool', { toolName });
    dispatchStatus(messageText, sessionId ?? undefined);
    const normalizedArgs = normalizeToolArgsForUi(event.args);
    const detailText = formatToolCallDetail(
      toolName,
      normalizedArgs as Record<string, any> | undefined,
      event.targetPath,
      event.equivalentCommand,
    );
    const browserDetailText = formatBrowserToolCallDetail(toolName, normalizedArgs as Record<string, any> | undefined);
    const effectiveDetailText = browserDetailText || detailText;
    const eventTimestamp = event.timestamp || Date.now();

    if (!sessionId) {
      console.warn('[handleToolCall] missing sessionId, skip timeline entry');
      return;
    }
    // 不需要通用的 tool_call timeline entry（否则会遮盖卡片或露出裸结果）
    // - agent: worker_start → agent_delegation 卡片;background 模式额外有 BackgroundAgentLaunchCard
    // - ask_user: ask_user_needed 流事件 → 交互式 AskUserCard
    // - surface 工具(open_surface/update_*): 产出物走右栏 SurfacePanel,timeline 不重复渲染裸 marker JSON
    if (
      isUpdatePlanTool
      || toolName === 'explore'
      || toolName === 'send_message'
      || toolName === 'agent'
      || toolName === 'ask_user'
      || SURFACE_TOOLS.has(toolName)
    ) {
      return;
    }
    // 防重 + streaming 卡片更新
    if (event.toolId) {
      const existing = findEntryByToolId(
        timelineMapRef.current.get(sessionId) || [],
        event.toolId,
        (entry) => entry.type === 'tool_call' || entry.type === 'tool_result' || entry.type === 'file_stream',
      );
      if (existing) {
        if (existing.streaming) {
          if (existing.type === 'file_stream') {
            // 已经被 content_delta 升级为 file_stream，只补充 args/targetPath
            // 保持 streaming=true 直到 write_file_stream 最终到来
            const argsTargetPath = normalizedArgs?.file_path || normalizedArgs?.filePath || normalizedArgs?.path;
            updateTimelineEntryById(sessionId, existing.id, (prev) => ({
              ...prev,
              toolArgs: normalizedArgs,
              targetPath: event.targetPath || argsTargetPath || prev.targetPath,
              filePath: prev.filePath || event.targetPath || argsTargetPath,
            }));
            // 注册 fileStreamEntry 以便 handleFileStream 能通过 getFileStreamEntryId 找到
            const resolvedPath = event.targetPath || argsTargetPath;
            if (resolvedPath) {
              recordFileStreamEntry(sessionId, resolvedPath, existing.id);
            }
          } else {
            // 还是 tool_call 类型，正常更新
            const updatedTitle = event.description ? `🔧 ${event.description}` : messageText;
            const argsTargetPath = normalizedArgs?.file_path || normalizedArgs?.filePath || normalizedArgs?.path;
            const resolvedTargetPath = event.targetPath || argsTargetPath;
            const keepWriteStreaming =
              (toolName === 'write_file' || toolName === 'write')
              && (!resolvedTargetPath || String(resolvedTargetPath).trim().length === 0);
            // 否则 CommandExecutionCard 无法渲染（缺少 commandCode/commandStatus）
            const isExecuteBashCall = toolName === 'execute_bash';
            const isExecuteShellCall = toolName === 'execute_shell';
            const isShellUpgrade = isExecuteBashCall || isExecuteShellCall;
            const shellCommandCode = isShellUpgrade
              ? (typeof normalizedArgs.code === 'string' ? normalizedArgs.code
                : typeof normalizedArgs.command === 'string' ? normalizedArgs.command
                : typeof normalizedArgs.cmd === 'string' ? normalizedArgs.cmd
                : typeof normalizedArgs.script === 'string' ? normalizedArgs.script : '')
              : undefined;
            updateTimelineEntryById(sessionId, existing.id, (prev) => ({
              ...prev,
              streaming: keepWriteStreaming ? true : undefined,
              title: updatedTitle,
              detail: effectiveDetailText ?? '',
              toolName: toolName || prev.toolName,
              toolArgs: normalizedArgs,
              targetPath: resolvedTargetPath || prev.targetPath,
              filePath: prev.filePath || resolvedTargetPath,
              pending: true,
              // shell 命令属性
              ...(isShellUpgrade && shellCommandCode ? {
                commandCode: shellCommandCode,
                commandCwd: typeof normalizedArgs.cwd === 'string' ? normalizedArgs.cwd : undefined,
                commandTimeout: typeof normalizedArgs.timeout === 'number' ? normalizedArgs.timeout : undefined,
                commandStatus: 'running' as const,
              } : {}),
            }));
          }
        } else {
          // 非 streaming 状态的已有条目 — 检查是否需要补充 shell 属性
          const isShellFix = (toolName === 'execute_bash' || toolName === 'execute_shell') && !existing.commandCode;
          if (isShellFix) {
            const shellCode = typeof normalizedArgs.code === 'string' ? normalizedArgs.code
              : typeof normalizedArgs.command === 'string' ? normalizedArgs.command
              : typeof normalizedArgs.cmd === 'string' ? normalizedArgs.cmd
              : typeof normalizedArgs.script === 'string' ? normalizedArgs.script : '';
            if (shellCode) {
              updateTimelineEntryById(sessionId, existing.id, (prev) => ({
                ...prev,
                toolName: toolName || prev.toolName,
                toolArgs: normalizedArgs,
                commandCode: shellCode,
                commandCwd: typeof normalizedArgs.cwd === 'string' ? normalizedArgs.cwd : prev.commandCwd,
                commandTimeout: typeof normalizedArgs.timeout === 'number' ? normalizedArgs.timeout : prev.commandTimeout,
                commandStatus: prev.commandStatus || ('running' as const),
              }));
            }
          }
        }
        // 无论是 streaming 更新还是真正的重复，都不需要再创建新卡片
        return;
      }
    }

    // prefixText 已经包含在 assistant_message 中，这里只记录日志
    const prefixText = event.prefixText;
    if (prefixText && typeof prefixText === 'string' && prefixText.trim()) {
      dbg('[handleToolCall] 🔧 Has prefixText:', prefixText.substring(0, 50) + '...');
    }

    // pending EDIT 卡片, 用户在 LLM 还在吐 tool_call args / 等审批时就能看到目标
    // 文件 + 流式预览 new_string. str_replace_editor 目前没人用, 保留走下方
    // 单工具通用分支.
    if (event.isBatch && event.batchId) {
      // Handle batch operations
      const sessionTimeline = timelineMapRef.current.get(sessionId) || [];
      const existingBatch = sessionTimeline.find((e: TimelineEntry) => e.batchId === event.batchId);
      const argsTargetPath =
        event.targetPath ||
        (typeof normalizedArgs.file_path === 'string' ? normalizedArgs.file_path : '') ||
        (typeof normalizedArgs.filePath === 'string' ? normalizedArgs.filePath : '') ||
        (typeof normalizedArgs.path === 'string' ? normalizedArgs.path : '') ||
        (typeof normalizedArgs.target === 'string' ? normalizedArgs.target : '');

      if (existingBatch) {
        updateTimelineEntry(
          sessionId,
          (e: TimelineEntry) => e.batchId === event.batchId,
          (e: TimelineEntry) => {
            const newTotal = (e.batchTotal || 0) + 1;
            const newTargets = argsTargetPath
              ? [...(e.batchTargets || []), argsTargetPath]
              : [...(e.batchTargets || [])];
            const fileHint = newTargets.length > 0
              ? newTargets.slice(-2).map((x) => x.split(/[\/]/).pop() || x).join('、')
              : `${newTotal} items`;
            return {
              ...e,
              batchTotal: newTotal,
              batchTargets: newTargets,
              title: `${toolName} (batch ${newTotal})`,
              detail: `Processing ${fileHint}`,
              pending: true,
            };
          },
          true
        );
      } else {
        const displayDescription = event.description ? event.description : `${toolName} (batch)`;
        const initialTargets = argsTargetPath ? [argsTargetPath] : [];
        const appended = appendTimelineEntry(sessionId, {
          id: createId('timeline-batch'),
          type: 'tool_call',
          title: `${displayDescription}`,
          detail: initialTargets.length
            ? `Preparing ${initialTargets[0].split(/[\/]/).pop() || initialTargets[0]}`
            : `Starting batch operation...`,
          timestamp: eventTimestamp,
          sequence: event.sequence,
          level: 'info',
          pending: true,
          toolName: toolName,
          isBatch: true,
          batchId: event.batchId,
          batchTotal: 1,
          batchCompleted: 0,
          batchTargets: initialTargets,
          totalChars: 0,
          prefixText: event.prefixText || undefined,
        }, true);
        if (isUpdatePlanTool) {
          dbg('[update_plan][tool_call][batch_append_result]', {
            sessionId,
            toolId: event.toolId,
            appendedId: appended?.id,
            appendedType: appended?.type,
            sequence: appended?.sequence,
          });
        }
      }
    } else {
      // Single tool call
      const displayTitle = event.description ? `🔧 ${event.description}` : messageText;
      const rawCommandCode = typeof normalizedArgs.code === 'string'
        ? normalizedArgs.code
        : (typeof normalizedArgs.command === 'string' ? normalizedArgs.command
          : (typeof normalizedArgs.cmd === 'string' ? normalizedArgs.cmd
            : (typeof normalizedArgs.script === 'string' ? normalizedArgs.script : '')));
      const hasExecutableCommand = rawCommandCode.trim().length > 0;
      const commandCwd = typeof normalizedArgs.cwd === 'string' ? normalizedArgs.cwd : undefined;
      const commandTimeout = typeof normalizedArgs.timeout === 'number' ? normalizedArgs.timeout : undefined;
      const isExecuteBashCall = toolName === 'execute_bash' && hasExecutableCommand;
      const isExecuteShellCall = toolName === 'execute_shell' && hasExecutableCommand;
      const isShellCommand = isExecuteBashCall || isExecuteShellCall;
      if (isShellCommand) {
        const pendingShellFromStatus = [...(timelineMapRef.current.get(sessionId) || [])].reverse().find((entry: TimelineEntry) => {
          if (entry.type !== 'tool_call' || !entry.pending) return false;
          if (entry.toolCallId) return false;
          if (entry.toolName !== 'execute_shell' && entry.toolName !== 'execute_bash') return false;
          const existingCommand = typeof entry.commandCode === 'string'
            ? entry.commandCode
            : (typeof entry.toolArgs?.command === 'string' ? entry.toolArgs.command : '');
          return existingCommand.trim() === rawCommandCode.trim();
        });
        if (pendingShellFromStatus) {
          updateTimelineEntryById(sessionId, pendingShellFromStatus.id, (prev) => ({
            ...prev,
            title: displayTitle,
            detail: effectiveDetailText || prev.detail,
            toolName,
            toolArgs: normalizedArgs,
            commandCode: rawCommandCode,
            commandCwd: commandCwd || prev.commandCwd,
            commandTimeout: commandTimeout ?? prev.commandTimeout,
            commandStatus: 'running',
            toolCallId: event.toolId || prev.toolCallId,
            timestamp: eventTimestamp,
          }));
          scrollToBottom();
          return;
        }
      }

      const isWriteFileTool = toolName === 'write_file';
      if (isWriteFileTool) {
        const rawFilePath = normalizedArgs?.file_path || normalizedArgs?.filePath || normalizedArgs?.path || '';
        const targetPath = event.targetPath || rawFilePath;

        // shell card 可能已经由 tool_call_streaming (name_received) 创建, 需要按
        // toolCallId 找到并合并, 哪怕 targetPath 暂时为空. 最终早退只在 orphan 和
        // targetPath **都** 缺失时才发生 (这时确实无法建卡).
        //
        // 这条路径覆盖两类遗孤卡:
        //  (a) `tool_call_streaming` phase=name_received 在参数完全到达前建的
        //      type='tool_call' 空壳卡 (toolName='write_file', 无 filePath);
        //  (b) `tool_call_streaming_update` phase=content_delta 升级后的
        //      type='file_stream' 卡 —— 旧链路里如果 LLM 把 "content" 放在
        //      "file_path" 前面, filepath_detected 可能不触发 (已在 agentLoop
        //      侧根治: 流末尾必发 filepath + content, 这里保留兜底).
        const sessionTimelineSnapshot = timelineMapRef.current.get(sessionId) || [];
        /* 身份判定:
         *   1. orphanByToolId — 按 event.toolId 找已绑 entry (走 toolCallIdSet, write_file 类型)
         *   2. orphanByPath — 按 path 找已注册 file_stream 卡, 但**仅在 toolCallIdSet 空时 claim**
         *      (常态: handleFileStream 抢先建的没绑 id 的卡; 已绑别的 id 的不偷)
         * 找不到 → 建新卡, 绑当前 event.toolId */
        const orphanByToolId = findEntryByToolId(
          sessionTimelineSnapshot,
          event.toolId,
          (entry) =>
            entry.toolName === 'write_file' &&
            (entry.type === 'tool_call' || entry.type === 'file_stream'),
        );

        const candidateExistingId = !orphanByToolId
          ? (targetPath ? getFileStreamEntryId(sessionId, targetPath) : undefined)
            || ((rawFilePath && rawFilePath !== targetPath) ? getFileStreamEntryId(sessionId, rawFilePath) : undefined)
          : undefined;
        const candidateEntry = candidateExistingId
          ? sessionTimelineSnapshot.find((e: TimelineEntry) => e.id === candidateExistingId)
          : undefined;
        const candidateClaimable = !!(
          candidateEntry &&
          candidateEntry.pending !== false &&
          (!Array.isArray(candidateEntry.toolCallIdSet) || candidateEntry.toolCallIdSet.length === 0)
        );
        const reuseId = orphanByToolId?.id || (candidateClaimable ? candidateExistingId : undefined);

        if (reuseId) {
          const relative = targetPath ? formatWorkspacePath(targetPath) : 'file';
          const additionsHint = typeof normalizedArgs?.content === 'string'
            ? normalizedArgs.content.split('\n').length
            : undefined;
          updateTimelineEntryById(sessionId, reuseId, (entry: TimelineEntry) => ({
            ...entry,
            type: 'file_stream' as any,
            title: entry.filePath
              ? entry.title
              : (targetPath ? `write_file → ${relative}` : entry.title),
            detail: entry.detail || (additionsHint
              ? `Writing ${relative} (+${additionsHint} lines)...`
              : `Writing ${relative}...`),
            filePath: entry.filePath || targetPath || undefined,
            targetPath: entry.targetPath || targetPath || undefined,
            toolName: 'write_file',
            ...(event.toolId ? bindToolIdPatch(entry, event.toolId) : {}),
            pending: entry.pending !== false ? true : entry.pending,
            additions: entry.additions || additionsHint,
          }));
          if (targetPath) recordFileStreamEntry(sessionId, targetPath, reuseId);
          if (rawFilePath && rawFilePath !== targetPath) {
            recordFileStreamEntry(sessionId, rawFilePath, reuseId);
          }
          scrollToBottom();
          return;
        }

        // orphan 没找到且没有 targetPath: 这时才真的无事可做 (既不能合并也不能建新卡)
        if (!targetPath) {
          return;
        }

        const relative = targetPath ? formatWorkspacePath(targetPath) : 'file';
        const additionsHint = typeof normalizedArgs?.content === 'string'
          ? normalizedArgs.content.split('\n').length
          : undefined;
        const entryId = createId('timeline-write-file');
        const entry = appendTimelineEntry(sessionId, {
          id: entryId,
          type: 'file_stream',
          title: `write_file → ${relative}`,
          detail: additionsHint ? `Writing ${relative} (+${additionsHint} lines)...` : `Writing ${relative}...`,
          timestamp: eventTimestamp,
          sequence: event.sequence,
          pending: true,
          filePath: targetPath,
          targetPath: targetPath,
          toolName: 'write_file',
          ...initialIdentity(event.toolId),
          additions: additionsHint,
        }, true);

        // 注册到 fileStreamEntryMap — handleFileStream / handleToolResult 都用它查找
        if (entry?.id) {
          if (targetPath) recordFileStreamEntry(sessionId, targetPath, entry.id);
          if (rawFilePath && rawFilePath !== targetPath) recordFileStreamEntry(sessionId, rawFilePath, entry.id);
        }
        scrollToBottom();
        return;
      }

      // 就能看到 target 文件、行号范围、new_string 预览。之前在这里 early-return，
      // 导致 edit_file_stream 事件要等到工具真的执行（= 用户批准后）才到达，
      // 审批期间 UI 只剩一行丑的 "等待审批" 文字。
      //
      // 注意：此时 editOldString 是空的（后端还没 readfile），前端 EditFileDiffCard
      // 里有 isPreview 分支，oldString 为空时就显示单栏 new content 预览，视觉上
      // 跟 WriteFileCard 的 "正在写入" 很像，用户一眼就能看懂要改什么文件。
      const isEditFileTool = toolName === 'edit_file' || toolName === 'edit';
      if (isEditFileTool) {
        const rawFilePath = normalizedArgs?.file_path || normalizedArgs?.filePath || normalizedArgs?.path || '';
        const targetPathArg = event.targetPath || rawFilePath;
        logToFile('EDIT_DEBUG', 'handleToolCall', {
          eventType: event.type,
          toolName: event.toolName,
          normalizedToolName: toolName,
          toolId: event.toolId,
          id: event.id,
          toolCallId: event.toolCallId,
          sessionId: event.sessionId,
          targetPath: event.targetPath,
          rawFilePath,
          targetPathArg,
          sequence: event.sequence,
          timestamp: event.timestamp,
          argsKeys: normalizedArgs ? Object.keys(normalizedArgs) : null,
        });
        if (!targetPathArg) {
          // 没有 file_path 就没法渲染卡片，静默跳过（等 edit_file_stream）
          return;
        }

        /* 身份判定 (Tool Call Identity 不变式):
         *   1. byToolId — 已绑 entry (走 toolCallIdSet) → 命中, 当作幂等返回
         *   2. orphanPreviewByPath — editStreaming=true 且 toolCallIdSet 空 + 1.5s 窗口
         *      → claim 它, 这是 preview 先于 tool_call 到达的合法场景 (Anthropic / forwarder 时序)
         *   3. 都不匹中 → 下面建新卡, 跟其它已绑的卡分离 (rapid-fire 多次 edit 各走各 toolId)
         * 这条规则替代了之前的 streamingPreview 全偷模式, 同文件多次 edit 不再互相 hijack. */
        const sessionTimelineForMatch = timelineMapRef.current.get(sessionId) || [];
        const existingByToolId = findEntryByToolId(
          sessionTimelineForMatch,
          event.toolId,
          (e) => e.type === 'edit_file',
        );
        const orphanPreviewByPath = !existingByToolId
          ? sessionTimelineForMatch
              .slice()
              .reverse()
              .find(
                (e: TimelineEntry) =>
                  e.type === 'edit_file' &&
                  /* 流式中或还没完成 — 真在跑的卡才接受 claim, 已完成 (editIsComplete=true) 的
                   *  卡是历史记录, 不能跟新 tool call 绑 (那样会 stomp 旧卡). */
                  (e.editStreaming === true || e.pending === true || e.editIsComplete === false) &&
                  typeof e.editFilePath === 'string' &&
                  (e.editFilePath === targetPathArg
                    || e.editFilePath.endsWith(targetPathArg)
                    || targetPathArg.endsWith(e.editFilePath)),
              )
          : undefined;
        const claimTarget = existingByToolId || orphanPreviewByPath;
        if (claimTarget) {
          if (!existingByToolId && orphanPreviewByPath) {
            logTimelineJank('edit-claim-by-path', {
              phase: 'tool-call',
              sessionId,
              incomingToolId: event.toolId,
              targetId: claimTarget.id,
              filePath: targetPathArg,
              targetToolCallIdSet: claimTarget.toolCallIdSet,
            });
          }
          if (event.toolId) {
            updateTimelineEntryById(sessionId, claimTarget.id, (entry: TimelineEntry) =>
              ({ ...entry, ...bindToolIdPatch(entry, event.toolId) }),
            );
          }
          return;
        }

        // 尝试从 args.hunks 重构多 hunk 结构，给 EditFileDiffCard 用
        const argsHunks: Array<{ oldString: string; newString: string; startLine: number }> = [];
        if (Array.isArray(normalizedArgs?.hunks)) {
          for (const h of normalizedArgs.hunks) {
            if (!h || typeof h !== 'object') continue;
            const newStr = typeof h.new_string === 'string' ? h.new_string
              : typeof h.newString === 'string' ? h.newString : '';
            const startLn = typeof h.start_line === 'number' ? h.start_line
              : typeof h.startLine === 'number' ? h.startLine : 1;
            argsHunks.push({ oldString: '', newString: newStr, startLine: startLn });
          }
        }
        const singleNewString = typeof normalizedArgs?.new_string === 'string' ? normalizedArgs.new_string
          : typeof normalizedArgs?.newString === 'string' ? normalizedArgs.newString : '';
        const singleStartLine = typeof normalizedArgs?.start_line === 'number' ? normalizedArgs.start_line
          : typeof normalizedArgs?.startLine === 'number' ? normalizedArgs.startLine : 1;

        const normalizedHunks = argsHunks.length > 0
          ? argsHunks
          : [{ oldString: '', newString: singleNewString, startLine: singleStartLine }];
        const primary = normalizedHunks[0];

        const fileName = targetPathArg.split(/[/\\]/).pop() || targetPathArg;
        const debugSnapshot = (timelineMapRef.current.get(sessionId) || [])
          .filter((e: TimelineEntry) => e.type === 'edit_file')
          .map((e: TimelineEntry) => ({
            id: e.id,
            toolName: e.toolName,
            editFilePath: e.editFilePath,
            editStreaming: e.editStreaming,
            editIsComplete: e.editIsComplete,
            pending: e.pending,
            toolCallIdSet: e.toolCallIdSet,
          }));
        logToFile('EDIT_DEBUG', 'handleToolCall:CREATE_NEW_ENTRY', {
          incomingToolId: event.toolId,
          targetPathArg,
          existingByToolId: Boolean(existingByToolId),
          orphanPreviewByPath: Boolean(orphanPreviewByPath),
          currentEditFileEntries: debugSnapshot,
        });
        appendTimelineEntry(sessionId, {
          id: createId('timeline-edit-file'),
          type: 'edit_file',
          title: `✏️ Editing: ${fileName}`,
          detail: `File: ${targetPathArg}`,
          timestamp: eventTimestamp,
          level: 'info',
          pending: true,
          editFilePath: targetPathArg,
          editOldString: primary.oldString,
          editNewString: primary.newString,
          editStartLine: primary.startLine,
          editHunks: normalizedHunks,
          editReplaceAll: normalizedHunks.length > 1,
          editIsComplete: false,
          ...initialIdentity(event.toolId),
          toolName,
          toolArgs: normalizedArgs,
        }, true);
        scrollToBottom();
        return;
      }

      const specialCardTools = [
        'readfile',
        'delete_file',
        'rename_file',
        'move_file',
        'copy_file',
        'execute_python',
        'execute_js',
        'execute_javascript',
        'execute_bash',
        'execute_shell',
        'execute_code',
        'search',
        'search_files',
        'show_tree',
        'list_directory',
        'smart_tree',
        'create_directory',
        'analyze_code',
        'run_tests',
        'run_lint',
        'run_format',
        'git_status',
        'git_diff',
        'git_blame',
        'git_branch_list',
        'git_branch',
        'git_commit',
        'build_index',
        'index_stats',
        'search_symbol',
        'get_definitions',
        'get_references',
        'web_search',
        'web_fetch',
        'memory',
        'select_tools',
        'call_tool',
        'use_skill',
        'neox_switch_model',
        'neox_list_models',
        'neox_mcp_manage',
        'neox_health_check',
        'neox_export_config',
        'neox_diagnose',
        'spawn_team',
        'spawn_process',
        'wait_process',
        'send_to_process',
        'list_processes',
        'read_process_output',
        'pause_process',
        'resume_process',
        'kill_process',
        'set_reminder',
        'list_reminders',
        'cancel_reminder',
        'ask_user',
      ];
      const isMcpTool = toolName.startsWith('mcp__');
      const isSpecialCardTool = specialCardTools.includes(toolName) || isMcpTool;
      const isViaCallTool = !!event.viaCallTool;

      // DEBUG: 如果是 readfile，打印完整的事件数据
      const isReadFileTool = toolName === 'readfile';
      if (isReadFileTool) {
        dbg('[handleToolCall DEBUG] readfile event:', JSON.stringify({
          toolName,
          targetPath: event.targetPath,
          args: event.args,
          description: event.description,
          toolId: event.toolId,
        }, null, 2));
      }

      const appended = appendTimelineEntry(sessionId, {
        id: createId('timeline-tool-call'),
        type: 'tool_call',
        title: displayTitle,
        detail: event.streaming ? '正在生成内容...' : (effectiveDetailText || undefined),
        timestamp: eventTimestamp,
        sequence: event.sequence,
        level: 'info',
        pending: isShellCommand || isSpecialCardTool || isViaCallTool || !!event.streaming,
        streaming: event.streaming || undefined,
        toolName: toolName,
        targetPath: event.targetPath,
        equivalentCommand: event.equivalentCommand,
        toolCallId: event.toolId,
        toolArgs: normalizedArgs,
        commandCode: isShellCommand ? rawCommandCode : undefined,
        commandCwd: isShellCommand ? commandCwd : undefined,
        commandTimeout: isShellCommand ? commandTimeout : undefined,
        commandStatus: isShellCommand ? 'running' : undefined,
        prefixText: event.prefixText || undefined,
        ...(isViaCallTool ? { viaCallTool: true } : {}),
      }, true);
      if (isUpdatePlanTool) {
        dbg('[update_plan][tool_call][single_append_result]', {
          sessionId,
          toolId: event.toolId,
          appendedId: appended?.id,
          appendedType: appended?.type,
          sequence: appended?.sequence,
          pending: appended?.pending,
          detailLen: appended?.detail?.length || 0,
        });
      }
    }
  }

  function parseSendMessageToolOutput(output?: string): {
    summary: string;
    content: string;
    status: string;
    agentId: string;
    agentStatus: string;
    delivery: string;
  } | null {
    const structured = parseStructuredToolOutput(output);
    if (!structured || structured.tool !== 'send_message') return null;
    const metadata = structured.metadata && typeof structured.metadata === 'object'
      ? structured.metadata as Record<string, any>
      : {};
    return {
      summary: typeof structured.summary === 'string' ? structured.summary : '',
      content: typeof structured.content === 'string' ? structured.content : '',
      status: typeof structured.status === 'string' ? structured.status : '',
      agentId: typeof metadata.agentId === 'string' ? metadata.agentId : '',
      agentStatus: typeof metadata.agentStatus === 'string' ? metadata.agentStatus : '',
      delivery: typeof metadata.delivery === 'string' ? metadata.delivery : '',
    };
  }

  function updateQueuedAgentMessageStatus(sessionId: string, agentId: string, text: string): boolean {
    if (!sessionId || !agentId || !text) return false;

    const timeline = timelineMapRef.current.get(sessionId) || [];
    const batchEntryId = taskAgentBatchMapRef.current.get(agentId);
    const targetEntry =
      timeline.find((entry: TimelineEntry) => entry.id === `delegation-${agentId}`) ||
      timeline.find((entry: TimelineEntry) => entry.id === `explore-${agentId}`) ||
      (batchEntryId ? timeline.find((entry: TimelineEntry) => entry.id === batchEntryId) : undefined) ||
      timeline.find((entry: TimelineEntry) =>
        entry.type === 'explore_status' &&
        Array.isArray(entry.exploreGroupMembers) &&
        entry.exploreGroupMembers.some((member) => member.agentId === agentId)
      );

    if (!targetEntry) return false;

    if (targetEntry.type === 'agent_delegation') {
      updateTimelineEntryById(sessionId, targetEntry.id, (prev: TimelineEntry) => ({
        ...prev,
        pending: true,
        delegationStatus: 'running',
        delegationCurrentStatus: text,
      }));
    } else {
      updateTimelineEntryById(sessionId, targetEntry.id, (prev: TimelineEntry) => ({
        ...prev,
        pending: prev.exploreStatus === 'error' || prev.exploreStatus === 'completed' ? false : true,
        exploreStatus: prev.exploreStatus === 'error' || prev.exploreStatus === 'completed' ? prev.exploreStatus : 'running',
        exploreCurrentStatus: text,
      }));
    }

    scrollToBottom();
    return true;
  }

  function handleToolResult(event: any) {
    let toolName = normalizeToolName(event.toolName) || event.toolName || '';
    /* call_tool 透明化 — 与 handleToolCall 同一处理, 结果行也按真实工具渲染. */
    if (toolName.toLowerCase() === 'call_tool') {
      const wrap = normalizeToolArgsForUi(event.args);
      const inner = (typeof wrap?.name === 'string' && wrap.name)
        || (typeof wrap?.tool === 'string' && wrap.tool)
        || (typeof wrap?.tool_name === 'string' && wrap.tool_name) || '';
      if (inner) {
        toolName = normalizeToolName(inner) || inner;
        event = { ...event, toolName: inner, args: wrap.args ?? wrap.arguments ?? wrap.input ?? {} };
      }
    }
    const isUpdatePlanTool = toolName === 'update_plan';
    const sessionId = normalizeAssistantSessionId(event.sessionId) || activeSessionIdRef.current;
    const baseText = statusT('toolCompleted', { toolName });
    const messageText = event.resultLength ? `${baseText} (${event.resultLength} chars)` : baseText;
    dispatchStatus(messageText, sessionId ?? undefined);
    const eventTimestamp = event.timestamp || Date.now();
    const normalizedResultArgs = normalizeToolArgsForUi(event.args);
    const resultToolArgs = Object.keys(normalizedResultArgs).length > 0 ? normalizedResultArgs : undefined;
    const targetPath = event.targetPath;
    /* surface 工具: 用一行友好摘要替换裸 marker JSON */
    const surfaceFriendly = SURFACE_TOOLS.has(toolName)
      ? summarizeSurfaceOutput(toolName, event.output)
      : null;
    const outputDetail = surfaceFriendly ?? formatToolResultDetail(
      toolName,
      event.output,
      event.resultLength,
      event.outputTruncated,
    );
    let resultSummary: string;
    const structuredSummary = parseStructuredToolOutput(event.output)?.summary;

    if (event.summary) {
      resultSummary = event.summary;
    } else if (structuredSummary) {
      resultSummary = structuredSummary;
    } else if (toolName === 'show_tree') {
      resultSummary = `show_tree: ${targetPath || '.'} (${event.resultLength} chars)`;
    } else if (toolName === 'smart_tree') {
      resultSummary = `smart_tree: ${targetPath || '.'} (${event.resultLength} chars)`;
    } else if (targetPath) {
      resultSummary = `✅ ${toolName}: ${targetPath} (${event.resultLength} chars)`;
    } else {
      resultSummary = event.resultLength
        ? `✅ ${toolName} completed (${event.resultLength} chars)`
        : `✅ ${toolName} completed`;
    }
    if (event.duration) {
      resultSummary += ` [${event.duration}ms]`;
    }

    if (!event.success) {
      if (event.summary) {
        resultSummary = resultSummary.startsWith('❌') ? resultSummary : `❌ ${resultSummary}`;
      } else if (resultSummary.startsWith('✅')) {
        resultSummary = resultSummary.replace(/^✅/, '❌');
      } else {
        resultSummary = `❌ ${resultSummary}`;
      }
    }

    if (!sessionId) {
      console.warn('[handleToolResult] missing sessionId, skip timeline update');
      return;
    }

    const blockedBy = (event as { blockedBy?: string }).blockedBy;
    if (blockedBy) {
      const notice = (event as { userNotice?: string }).userNotice
        || (blockedBy === 'permission' ? '这一步需要你确认' : '这一步被拦下了');
      const timeline = timelineMapRef.current.get(sessionId) || [];
      const anchor = findEntryByToolId(timeline, event.toolId,
        (e) => e.type === 'tool_call' || e.type === 'tool_result' || e.type === 'tool_error');
      /* 同一轮里同一句提示已经有了 → 只把次数加上去, 不再多一行 */
      const twin = timeline.find((e) => (e as { blockedNotice?: string }).blockedNotice === notice
        && e.id !== anchor?.id);
      if (twin) {
        updateTimelineEntryById(sessionId, twin.id, (prev) => ({
          ...prev,
          blockedRepeat: ((prev as { blockedRepeat?: number }).blockedRepeat ?? 1) + 1,
        } as TimelineEntry));
        if (anchor) void deleteTimelineEntry?.(sessionId, anchor.id);
        return;
      }
      if (anchor) {
        updateTimelineEntryById(sessionId, anchor.id, (prev) => ({
          ...prev,
          type: 'tool_result',
          pending: false,
          success: false,
          level: 'info',
          blockedBy,
          blockedNotice: notice,
          detail: notice,
          errorMessage: undefined,
          errorReason: undefined,
          timestamp: eventTimestamp,
        } as TimelineEntry));
      }
      return;
    }

    if (toolName === 'send_message') {
      const sendMessageOutput = parseSendMessageToolOutput(event.output);
      if (
        sendMessageOutput &&
        event.success !== false &&
        sendMessageOutput.status === 'success' &&
        sendMessageOutput.agentStatus === 'running' &&
        (sendMessageOutput.delivery === 'queued' || sendMessageOutput.delivery === 'injected')
      ) {
        const statusText = sendMessageOutput.content || sendMessageOutput.summary;
        if (updateQueuedAgentMessageStatus(sessionId, sendMessageOutput.agentId, statusText)) {
          dispatchStatus(sendMessageOutput.summary || statusText, sessionId ?? undefined);
          return;
        }
      }
    }
    // ask_user 的回答由 AskUserCard 自身的 askUserStatus 切换 'answered' 显示，无需通用 tool_result
    // surface 工具的产出物走右栏 SurfacePanel — 这里允许 tool_result 卡片显示, 但 detail 已被
    // summarizeSurfaceOutput 替换成一行友好摘要 (上面 surfaceFriendly), 不会再露 marker JSON.
    if (isUpdatePlanTool || toolName === 'explore' || toolName === 'ask_user') {
      return;
    }
    // agent: background 模式的 tool_result 必须保留 — TimelineEntry 用它的 detail 识别
    // background_launched 并渲染 BackgroundAgentLaunchCard。前台模式的 output 已经由
    // worker_complete → agent_delegation 卡片承载，原始输出不需要再露成裸 JSON。
    if (toolName === 'agent') {
      const output = typeof event.output === 'string' ? event.output : '';
      if (!output.includes('"background_launched"') && !output.includes('"auto_backgrounded"')) {
        return;
      }
    }

    // 如果已有完成的 tool_result entry（pending=false），跳过重复
    if (event.toolId) {
      const existing = findEntryByToolId(
        timelineMapRef.current.get(sessionId) || [],
        event.toolId,
        (entry) => entry.type === 'tool_result' && !entry.pending,
      );
      if (existing) {
        return;
      }
    }

    // 特殊处理 write_file/Write 工具 - 卡片由 handleToolCall 或 file_stream 创建
    const isWriteFileTool = toolName === 'write_file';
    if (isWriteFileTool) {
      const rawPath = event.args?.file_path || event.args?.filePath || event.args?.path;
      const pathCandidates = [targetPath, rawPath].filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
      const sessionTimeline = timelineMapRef.current.get(sessionId) || [];

      /* 身份判定 — 严格 toolCallId 匹配优先:
       *   1. 按 event.toolId 查 entry (走 toolCallIdSet) — 最严格, 跨阶段 id 漂移也命中
       *   2. 兜底: 按 path 查注册过的 file_stream entry — 仅当**该 entry 也匹中 toolCallId 链路或者
       *      toolCallIdSet 为空 (孤儿态)** 时才允许. 已绑别的 toolId 的卡不偷.
       *   3. 都找不到 → 静默忽略 (不再走 "lone pending" 这种兜底 — 那会乱清不属于本 result 的卡) */
      const byToolId = findEntryByToolId(
        sessionTimeline,
        event.toolId,
        (e) => e.toolName === 'write_file',
      );
      let existingEntryId: string | undefined = byToolId?.id;

      if (!existingEntryId) {
        const tryClaim = (id?: string): boolean => {
          if (!id) return false;
          const e = sessionTimeline.find((x) => x.id === id);
          if (!e) return false;
          if (Array.isArray(e.toolCallIdSet) && e.toolCallIdSet.length > 0) return false; // 已绑别的 id 不偷
          existingEntryId = id;
          return true;
        };
        if (targetPath && tryClaim(getFileStreamEntryId(sessionId, targetPath))) {/* claimed */}
        else if (rawPath && rawPath !== targetPath && tryClaim(getFileStreamEntryId(sessionId, rawPath))) {/* claimed */}
        else if (pathCandidates.length > 0) {
          const matchedByPath = sessionTimeline
            .slice()
            .reverse()
            .find((e: TimelineEntry) => {
              if (e.toolName !== 'write_file') return false;
              if (Array.isArray(e.toolCallIdSet) && e.toolCallIdSet.length > 0) return false;
              const entryPath = e.targetPath || e.filePath || e.toolArgs?.file_path || e.toolArgs?.filePath || e.toolArgs?.path;
              return pathCandidates.some((candidate) => pathsMaybeMatch(entryPath, candidate));
            });
          if (matchedByPath) existingEntryId = matchedByPath.id;
        }
      }

      if (existingEntryId) {
        // 最终 path). 先用 event.args / event.targetPath 回补到 entry, 再判断:
        //   (A) 有 path 或 content 可回补 → 渲染 WRITE 卡片 (正常路径)
        //   (B) 完全无数据 + success=false → 转为 tool_error 卡片, 和 edit 工具失败
        //       路径对齐 (参见同文件 line 2499-2518). 不再伪装成"✓ Done"的空壳.
        //   (C) 完全无数据 + success=true → 几乎不可能 (write_file 无 path/content 不可能成功),
        //       记录 warn 后按 tool_error 处理.
        const authoritativePath = targetPath || rawPath;
        const authoritativeContent = typeof event.args?.content === 'string'
          ? event.args.content
          : undefined;

        /* write_file 覆盖已有文件时, 工具会在覆盖前把原内容存成快照, 结果里只带一个短 id
         * (原内容不能进返回值 —— 那是要发给 LLM 的). 把 id 挂到 entry 上, Undo 才点得到.
         * 见 neox-core/tools/files/fileSnapshotStore.ts。 */
        const previousSnapshotId: string | undefined = (() => {
          try {
            const raw = typeof event.output === 'string' ? JSON.parse(event.output) : event.output;
            const id = raw?.metadata?.previous?.snapshot_id;
            return typeof id === 'string' && id ? id : undefined;
          } catch {
            const m = typeof event.output === 'string' ? /"snapshot_id"\s*:\s*"([^"]+)"/.exec(event.output) : null;
            return m ? m[1] : undefined;
          }
        })();
        /* 改写的是已有文件 (不是新建) —— 「本轮改动」据此不标「新建」。摘要在回执最前面, 截断也在 */
        const overwroteExisting = typeof event.output === 'string' && /File updated:/.test(event.output);

        dbg('[handleToolResult] write_file CaseA 前置:', {
          existingEntryId,
          previousSnapshotId: previousSnapshotId ?? '(解析为空)',
          outputLen: typeof event.output === 'string' ? event.output.length : -1,
        });

        if (previousSnapshotId || overwroteExisting) {
          for (const p of pathCandidates) {
            const fsEntryId = getFileStreamEntryId(sessionId, p);
            dbg('[handleToolResult] 快照补写探测:', { path: p, fsEntryId: fsEntryId ?? '(无映射)', existingEntryId });
            if (fsEntryId && fsEntryId !== existingEntryId) {
              updateTimelineEntryById(sessionId, fsEntryId, (entry: TimelineEntry) => ({
                ...entry,
                previousSnapshotId: (entry as any).previousSnapshotId || previousSnapshotId,
                ...(overwroteExisting ? { overwroteExisting: true } : {}),
              }));
            }
          }
        }

        const existingEntry = sessionTimeline.find((e: TimelineEntry) => e.id === existingEntryId);
        const hasAnyPath = !!(existingEntry?.filePath || existingEntry?.targetPath || authoritativePath);
        const hasAnyContent = !!(
          existingEntry?.codeContent ||
          (existingEntry?.codeLines && existingEntry.codeLines.length > 0) ||
          authoritativeContent
        );

        if (!hasAnyPath && !hasAnyContent) {
          // Case B/C: 没有任何可展示数据. 转成 tool_error 而不是留空壳 WRITE 卡.
          if (event.success !== false) {
            console.warn('[handleToolResult] write_file completed with empty path+content but success=true — rendering as tool_error');
          }
          updateTimelineEntryById(sessionId, existingEntryId, (entry: TimelineEntry) => ({
            ...entry,
            type: 'tool_error',
            pending: false,
            success: false,
            level: 'error',
            // output 原始 JSON 留给 tool-error-card 解析出 error / summary
            detail: (typeof event.output === 'string' && event.output.trim().startsWith('{'))
              ? event.output
              : (outputDetail || resultSummary || entry.detail),
            errorReason: event.errorReason,
            timestamp: eventTimestamp,
          }));
          scrollToBottom();
          return;
        }

        // Case A: 正常路径, 回补 + 标完成
        updateTimelineEntryById(sessionId, existingEntryId, (entry: TimelineEntry) => {
          const nextFilePath = entry.filePath || authoritativePath;
          const nextCodeContent = entry.codeContent || authoritativeContent;
          const nextCodeLines = (entry.codeLines && entry.codeLines.length > 0)
            ? entry.codeLines
            : (authoritativeContent
                ? authoritativeContent.split(/\r?\n/).map((line: string, idx: number) => ({
                    content: line,
                    type: 'added' as const,
                    lineNumber: idx + 1,
                  }))
                : entry.codeLines);
          return {
            ...entry,
            pending: false,
            success: event.success !== false,
            level: event.success === false ? 'error' : 'info',
            errorMessage: event.success === false ? entry.errorMessage : undefined,
            errorCode: event.success === false ? (entry as any).errorCode : undefined,
            errorReason: event.success === false ? event.errorReason : undefined,
            duration: event.duration,
            filePath: nextFilePath,
            targetPath: entry.targetPath || authoritativePath,
            title: entry.filePath
              ? entry.title
              : (nextFilePath
                  ? `write_file → ${formatWorkspacePath(nextFilePath)}`
                  : entry.title),
            codeContent: nextCodeContent,
            codeLines: nextCodeLines,
            /* 覆盖前快照 id — Undo 的依据, 不覆盖已有值 (重试时第二次结果可能没带) */
            previousSnapshotId: (entry as any).previousSnapshotId || previousSnapshotId,
            ...(overwroteExisting ? { overwroteExisting: true } : {}),
            /* 绑 toolId — 即使前面 byToolId 找到了, 也再 bind 一次确保 set 里有 (幂等) */
            ...(event.toolId ? bindToolIdPatch(entry, event.toolId) : {}),
          };
        });
        // 若卡片原本没 path, 现在补上了, 注册到 fileStreamEntryMap
        if (authoritativePath) {
          recordFileStreamEntry(sessionId, authoritativePath, existingEntryId);
        }
        scrollToBottom();
        return;
      }
      dbg('[handleToolResult] write_file tool_result: no matching entry found, ignoring');
      return;
    }

    const sessionTimeline = timelineMapRef.current.get(sessionId) || [];

    const isEditFileTool = toolName === 'edit_file' || toolName === 'edit' || toolName === 'str_replace_editor';
    if (isEditFileTool) {
      logToFile('EDIT_DEBUG', 'handleToolResult:edit', {
        eventType: event.type,
        toolName: event.toolName,
        normalizedToolName: toolName,
        toolId: event.toolId,
        id: event.id,
        toolCallId: event.toolCallId,
        sessionId: event.sessionId,
        success: event.success,
        targetPath: event.targetPath,
        errorReason: event.errorReason,
        outputPrefix: typeof event.output === 'string' ? event.output.slice(0, 200) : null,
        sequence: event.sequence,
        timestamp: event.timestamp,
      });
      const editPath = targetPath || event.args?.file_path || event.args?.filePath || event.args?.path;
      const pathMatches = (entryPath?: string, expectedPath?: string): boolean => {
        if (!entryPath || !expectedPath) return false;
        return entryPath === expectedPath || entryPath.endsWith(expectedPath) || expectedPath.endsWith(entryPath);
      };
      if (event.success !== false) {
        const editEntry = findEntryByToolId(
          sessionTimeline,
          event.toolId,
          (e) => e.type === 'edit_file',
        );
        const fallbackEditEntries = editEntry ? [] : sessionTimeline.filter((entry: TimelineEntry) =>
          entry.type === 'edit_file' &&
          (entry.pending === true || entry.editStreaming === true) &&
          pathMatches(entry.editFilePath || entry.targetPath, editPath),
        );
        const targetEditEntry = editEntry || (fallbackEditEntries.length === 1 ? fallbackEditEntries[0] : undefined);
        if (targetEditEntry && (targetEditEntry.pending === true || targetEditEntry.editStreaming === true)) {
          updateTimelineEntryById(sessionId, targetEditEntry.id, (entry: TimelineEntry) => ({
            ...entry,
            pending: false,
            editStreaming: false,
            editIsComplete: true,
            success: true,
            duration: event.duration ?? entry.duration,
            timestamp: eventTimestamp,
            ...(event.toolId ? bindToolIdPatch(entry, event.toolId) : {}),
          }));
        }
        dbg('[handleToolResult] edit tool_result: handled by edit_file_stream, pending cleared if any');
        return;
      }
      // 失败：优先更新已有 edit_file 卡片，不再额外新增 tool_result 卡片
      const editEntry = [...sessionTimeline].reverse().find((entry: TimelineEntry) =>
        entry.type === 'edit_file' &&
        (pathMatches(entry.editFilePath, editPath) || (!editPath && entry.pending))
      );
      if (editEntry) {
        updateTimelineEntryById(sessionId, editEntry.id, (entry: TimelineEntry) => ({
          ...entry,
          pending: false,
          editIsComplete: true,
          editStreaming: false,
          level: 'error',
          success: false,
          detail: outputDetail || resultSummary || entry.detail,
          errorReason: event.errorReason,
          timestamp: eventTimestamp,
        }), true);
        scrollToBottom();
        return;
      }
      // 没有 edit_file 卡片可更新（比如目标文件根本不存在，edit_file_stream 还没开始就失败了）
      // 否则会和即将到来的 tool_error 事件渲染的 tool-error-card 重复。
      // 直接把原来的 tool_call entry 就地转成 tool_error，保留原始 JSON output 供 TimelineEntry 解析。
      const fallbackToolCall = findEntryByToolId(sessionTimeline, event.toolId);
      if (fallbackToolCall) {
        updateTimelineEntryById(sessionId, fallbackToolCall.id, (entry: TimelineEntry) => ({
          ...entry,
          type: 'tool_error',
          pending: false,
          success: false,
          level: 'error',
          // 用 event.output (原始 ephemeral JSON string) 而不是 outputDetail (已被 formatToolResultDetail 抽取),
          // 这样 TimelineEntry 的 tool-error-card 能继续 JSON.parse 出 summary / error / file_path / verify_hint
          detail: (typeof event.output === 'string' && event.output.trim().startsWith('{'))
            ? event.output
            : (outputDetail || resultSummary || entry.detail),
          errorReason: event.errorReason,
          timestamp: eventTimestamp,
        }), true);
        scrollToBottom();
        return;
      }
      // 连 tool_call 也没有配对上 —— 静默 return，完全交给后续 tool_error 事件渲染
      return;
    }

    const isShellTool = toolName === 'execute_bash' || toolName === 'execute_shell';
    let commandEntry = isShellTool
      ? findEntryByToolId(sessionTimeline, event.toolId, (entry) => !!entry.commandCode)
      : undefined;

    // toolId 缺失/不匹配时，按“最近同名 shell tool_call”兜底配对，避免卡片丢失
    if (!commandEntry && isShellTool) {
      commandEntry = [...sessionTimeline].reverse().find((entry: TimelineEntry) =>
        entry.type === 'tool_call' &&
        entry.toolName === toolName &&
        (
          entry.pending === true ||
          entry.commandStatus === 'running' ||
          (!entry.commandResult && !entry.success)
        )
      );
    }

    if (commandEntry) {
      // commandRawOutput 给 xterm 用 (干净 stdout); 优先保留 stream 阶段累积的 raw,
      // 流式路径没生效时 (短命令 / HMR 等) 从 event.output 壳里提取一份兜底.
      const rawFromShellResult = extractRawStdoutFromShellResult(event.output);
      const bgMatch = typeof event.output === 'string'
        ? event.output.match(/Started in background\.\s*pid=(\d+)/i)
        : null;
      const isBackgroundRunning = bgMatch !== null && event.success;
      const bgPid = bgMatch ? Number(bgMatch[1]) : undefined;

      /* WriteLedger 第三路: 非 background 成功 shell → output_files 或 shell_proc 回收.
       * 结果挂 entry.declaredPaths, 供 aggregateTurnChanges 耐持久化回放. */
      let declaredPaths: string[] | undefined;
      let declaredEvidence: 'shell_declared' | 'shell_proc' | undefined;
      if (event.success && !isBackgroundRunning) {
        const args = (event.args || commandEntry.toolArgs || {}) as Record<string, unknown>;
        const commandText = String(
          commandEntry.commandCode
          || args.command
          || '',
        );
        const fromArgs = [
          ...(Array.isArray(args.output_files) ? args.output_files : []),
          ...(Array.isArray(args.outputFiles) ? args.outputFiles : []),
        ].filter((p): p is string => typeof p === 'string' && !!p.trim());
        if (fromArgs.length > 0) {
          declaredPaths = Array.from(new Set(fromArgs));
          declaredEvidence = 'shell_declared';
        } else if (commandText) {
          const startTs = commandEntry.timestamp
            ?? (Date.now() - (typeof event.duration === 'number' ? event.duration : 0));
          const endTs = Date.now();
          const procDecls = recoverShellProcDeclarations({
            sessionId,
            toolCallId: String(event.toolId || commandEntry.toolCallId || commandEntry.id),
            toolName,
            command: commandText,
            startTs,
            endTs,
            workspacePath: getSessionRunWorkspace(sessionId) ?? workspacePath,
          });
          const paths: string[] = [];
          for (const d of procDecls) {
            recordWriteDeclaration(d);
            paths.push(...d.paths);
          }
          if (paths.length > 0) {
            declaredPaths = Array.from(new Set(paths));
            declaredEvidence = 'shell_proc';
          }
        }
      }

      updateTimelineEntry(
        sessionId,
        (entry: TimelineEntry) => entry.id === commandEntry.id,
        (entry: TimelineEntry) => ({
          ...entry,
          pending: isBackgroundRunning,  /* 后台跑着的保持 pending, exitCode chip 不显示 */
          commandStatus: isBackgroundRunning
            ? 'running' as const
            : event.success ? 'completed' as const : 'error' as const,
          commandResult: resultSummary,
          output: event.output, // 保存实际的命令输出内容 (壳, 给 LLM 看)
          commandRawOutput: entry.commandRawOutput || rawFromShellResult,
          commandPid: entry.commandPid ?? bgPid,
          duration: event.duration ?? entry.duration,
          ...(declaredPaths && declaredPaths.length > 0
            ? { declaredPaths, declaredEvidence } as any
            : {}),
          ...(event.args && !entry.toolArgs
            ? { toolArgs: event.args }
            : {}),
        }),
        true
      );
      scrollToBottom();
      return;
    }

    if (isShellTool) {
      // 理论上 execute_shell/execute_bash 必须能匹配到之前的 tool_call。
      // 若未匹配，说明上游事件链路有缺失，这里只告警，不制造兜底卡片掩盖问题。
      console.warn(`[handleToolResult] Shell tool ${toolName} has no matching tool_call entry (toolId: ${event.toolId}), skip rendering`);
      scrollToBottom();
      return;
    }

    // Handle web_fetch results
    const isWebFetch = toolName === 'web_fetch';
    const webFetchEntry = isWebFetch
      ? findEntryByToolId(
          timelineMapRef.current.get(sessionId) || [],
          event.toolId,
          (entry) => entry.toolName === 'web_fetch',
        )
      : undefined;

    if (webFetchEntry) {
      updateTimelineEntry(
        sessionId,
        (entry: TimelineEntry) => entry.id === webFetchEntry.id,
        (entry: TimelineEntry) => ({
          ...entry,
          pending: false,
          success: event.success,
          type: 'tool_result',
          webFetchStatus: event.success ? 'done' : 'error',
          webFetchResult: event.output,
          duration: event.duration ?? entry.duration,
          level: event.success ? 'info' : 'error',
        }),
        true
      );
      scrollToBottom();
      return;
    }


    // Handle batch results
    if (event.batchId) {
      updateTimelineEntry(
        sessionId,
        (e) => e.batchId === event.batchId,
        (e) => {
          const completed = (e.batchCompleted || 0) + 1;
          const total = e.batchTotal || 0;
          const isComplete = completed >= total;
          const newTotalChars = (e.totalChars || 0) + (event.resultLength || 0);

          let title: string;
          let detail: string;

          const normalizedBatchToolName = String(e.toolName || '').toLowerCase().replace(/[\s-]+/g, '_');
          const isReadFileBatch =
            normalizedBatchToolName === 'read' ||
            normalizedBatchToolName === 'readfile' ||
            normalizedBatchToolName === 'read_file' ||
            normalizedBatchToolName === 'smart_read' ||
            normalizedBatchToolName === 'read_multiple_files' ||
            /(^|_)read(file|_file)?$/.test(normalizedBatchToolName);
          const batchNames = Array.isArray(e.batchTargets)
            ? e.batchTargets
              .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
              .map((x) => x.split(/[\/]/).pop() || x)
            : [];
          const readFileSummary = batchNames.length > 0
            ? `已读取 ${batchNames.slice(0, 3).join('、')}${batchNames.length > 3 ? ` 等 ${batchNames.length} 个文件` : ''}`
            : `已读取 ${completed}/${total || completed} 个文件`;

          if (isComplete) {
            title = isReadFileBatch ? `✅ ${e.toolName} (${total})` : `✅ ${e.toolName} (batch ${total})`;
            detail = isReadFileBatch ? readFileSummary : `Completed ${total} items, ${newTotalChars} chars total`;
          } else {
            title = `🔧 ${e.toolName} (batch ${completed}/${total})`;
            detail = isReadFileBatch ? readFileSummary : `Processing ${completed}/${total}...`;
          }

          return {
            ...e,
            batchCompleted: completed,
            pending: !isComplete,
            totalChars: newTotalChars,
            title,
            detail,
            duration: isComplete ? (eventTimestamp - e.timestamp) : undefined,
          };
        },
        true
      );
      return;
    }

    // Handle special card tools (excluding write_file which is handled by file_stream)
    const specialCardTools = [
      'readfile',
      'delete_file',
      'rename_file',
      'move_file',
      'copy_file',
      'create_directory',
      'execute_python',
      'execute_js',
      'execute_javascript',
      'execute_bash',
      'execute_code',
      'search',
      'search_files',
      'show_tree',
      'list_directory',
      'smart_tree',
      'analyze_code',
      'run_tests',
      'run_lint',
      'run_format',
      'git_status',
      'git_diff',
      'git_blame',
      'git_branch_list',
      'git_branch',
      'git_commit',
      'build_index',
      'index_stats',
      'search_symbol',
      'get_definitions',
      'get_references',
      'web_search',
      'web_fetch',
      'memory',
      'select_tools',
      'call_tool',
      'use_skill',
      'neox_switch_model',
      'neox_list_models',
      'neox_mcp_manage',
      'neox_health_check',
      'neox_export_config',
      'neox_diagnose',
      'set_reminder',
      'list_reminders',
      'cancel_reminder',
      'ask_user',
    ];
    // DEBUG: 如果是 readfile，打印完整的 tool_result 事件数据
    const isReadFileTool = toolName === 'readfile';
    if (isReadFileTool) {
      dbg('[handleToolResult DEBUG] readfile event:', JSON.stringify({
        toolName: event.toolName,
        targetPath: event.targetPath,
        args: event.args,
        toolId: event.toolId,
        resultLength: event.resultLength,
        success: event.success,
        summary: event.summary,
        outputSnippet: event.output?.slice(0, 100),
      }, null, 2));
      // DEBUG: 打印当前 timeline 中的所有 entries 的 toolCallId
      const currentEntries = timelineMapRef.current.get(sessionId) || [];
      dbg('[handleToolResult DEBUG] current timeline toolCallIds:', currentEntries.map(e => ({
        id: e.id,
        type: e.type,
        toolCallId: e.toolCallId,
        toolName: e.toolName,
        pending: e.pending,
      })));
    }

    const existingToolCallEntry = findEntryByToolId(
      timelineMapRef.current.get(sessionId) || [],
      event.toolId,
    );
    if (isUpdatePlanTool) {
      dbg('[update_plan][tool_result][match]', {
        sessionId,
        toolId: event.toolId,
        matchedEntryId: existingToolCallEntry?.id,
        matchedEntryType: existingToolCallEntry?.type,
      });
    }

    if (existingToolCallEntry) {
      // toolName='write_file', 无 filePath) 如果走到这条通用路径, 会被改成
      // type='tool_result' 但保留 toolName='write_file' —— 渲染层按 title/toolName
      // 识别为 WRITE 卡, 因无 filePath 显示 "Untitled file".
      //
      // 触发条件: 本次 event.toolName 和 shell 不匹配 (比如 event 是别的工具的结果,
      // toolId 却意外匹配到 write_file shell), 或者 normalizeToolName 丢了 write_file.
      //
      // 对策: 如果 existing 是个空 write_file shell, 它从没被任何事件填上数据,
      // 就是无效孤儿. 不再伪装成 tool_result 成功态 — 直接删掉 (有 deleteTimelineEntry 时)
      // 或降级为 tool_error (无法删时).
      const isOrphanWriteFileShell =
        existingToolCallEntry.toolName === 'write_file' &&
        (existingToolCallEntry.type === 'tool_call' || existingToolCallEntry.type === 'file_stream') &&
        !existingToolCallEntry.filePath &&
        !existingToolCallEntry.targetPath &&
        !existingToolCallEntry.codeContent &&
        !(existingToolCallEntry.codeLines && existingToolCallEntry.codeLines.length > 0);

      if (isOrphanWriteFileShell) {
        console.warn('[DIAG handleToolResult] removing orphan write_file shell (would have rendered as Untitled)', {
          orphanId: existingToolCallEntry.id,
          orphanType: existingToolCallEntry.type,
          orphanToolCallId: existingToolCallEntry.toolCallId,
          eventToolName: event.toolName,
          normalizedToolName: toolName,
          eventToolId: event.toolId,
        });
        if (deleteTimelineEntry) {
          void deleteTimelineEntry(sessionId, existingToolCallEntry.id);
        } else {
          // 无法删时降级为 tool_error (不伪装成功)
          updateTimelineEntryById(sessionId, existingToolCallEntry.id, (entry) => ({
            ...entry,
            type: 'tool_error' as any,
            pending: false,
            success: false,
            level: 'error',
            detail: resultSummary,
            timestamp: eventTimestamp,
          } as any), true);
        }
        scrollToBottom();
        return;
      }

      updateTimelineEntry(
        sessionId,
        (entry: TimelineEntry) => entry.id === existingToolCallEntry.id,
        (entry: TimelineEntry) => ({
          ...entry,
          type: 'tool_result',
          title: resultSummary,
          detail: outputDetail || entry.detail,
          pending: false,
          /* streaming 占位卡可能因 tool_call 事件缺席 (曾被幻觉过滤误拦) 直接跳到 result —
           * 这里必须补写真实工具名 + 清 streaming, 否则行永远显示裸 "Call tool". */
          streaming: undefined,
          toolName: toolName || entry.toolName,
          success: event.success,
          duration: settledToolDuration(event.duration, entry, eventTimestamp),
          toolArgs: resultToolArgs || entry.toolArgs,
          output: event.output,
          resultLength: event.resultLength,
        }),
        true
      );
      scrollToBottom();
      return;
    }

    // Fallback: toolId 缺失时，按“最近同名 pending tool_call”兜底配对
    const fallbackPending = [...(timelineMapRef.current.get(sessionId) || [])].reverse().find(
      (entry: TimelineEntry) =>
        entry.type === 'tool_call' &&
        entry.toolName === toolName &&
        entry.pending === true
    );

    if (fallbackPending) {
      updateTimelineEntryById(sessionId, fallbackPending.id, (entry: TimelineEntry) => ({
        ...entry,
        type: 'tool_result',
        title: resultSummary,
        detail: outputDetail || entry.detail,
        pending: false,
        streaming: undefined,
        toolName: toolName || entry.toolName,
        success: event.success,
        duration: settledToolDuration(event.duration, entry, eventTimestamp),
        toolArgs: resultToolArgs || entry.toolArgs,
        output: event.output,
        resultLength: event.resultLength,
      }));
      scrollToBottom();
      return;
    }

    // 对于 special card tools，如果找不到对应的 tool_call entry，不创建新的 entry
    // 避免重复的空卡片（比如 readfile）
    if (event.toolId && specialCardTools.includes(toolName)) {
      const currentTimeline = timelineMapRef.current.get(sessionId) || [];
      const toolCallEntry = findEntryByToolId(
        currentTimeline,
        event.toolId,
        (entry) => entry.type === 'tool_call' && entry.pending === true,
      );

      if (toolCallEntry) {
        updateTimelineEntryById(sessionId, toolCallEntry.id, (entry: TimelineEntry) => ({
          ...entry,
          pending: false,
          success: event.success,
          duration: event.duration ?? entry.duration,
          toolArgs: resultToolArgs || entry.toolArgs,
        }));
        scrollToBottom();
        return;
      }
      console.warn(`[handleToolResult] Special card tool ${toolName} has no matching tool_call entry, skipping new entry creation`);
      return;
    }

    // Default: create new tool result entry (仅对非 special card tools)
    appendTimelineEntry(sessionId, {
      id: createId('timeline-tool-result'),
      type: 'tool_result',
      title: resultSummary,
      detail: outputDetail || undefined,
      timestamp: eventTimestamp,
      level: 'info',
      pending: false,
      toolName: toolName,
      targetPath: event.targetPath,
      toolArgs: resultToolArgs || event.args,
    }, true);
  }

  function handlePlanUpdate(event: any) {
    const steps = Array.isArray(event.plan) ? event.plan : [];
    const planSteps: Array<{
      id: string;
      content: string;
      status: 'pending' | 'in_progress' | 'completed' | 'skipped';
      phase?: string;
      estimateSec?: number;
    }> = steps.map((step: any, index: number) => ({
      id: step.id || `step-${index + 1}`,
      content: step.step || step.content || '',
      status: step.status as 'pending' | 'in_progress' | 'completed' | 'skipped',
      phase: step.phase, estimateSec: step.estimateSec,
    }));

    const completedCount = planSteps.filter(s => s.status === 'completed').length;
    const hasInProgress = planSteps.some(s => s.status === 'in_progress');
    const planStatus: TimelineEntry['planStatus'] =
      planSteps.length > 0 && completedCount === planSteps.length
        ? 'completed'
        : hasInProgress
          ? 'executing'
          : 'approved';

    const eventTimestamp = event.timestamp || Date.now();
    const entryTitle = tRef.current.plan.updated || 'Updated Plan';

    if (event.sessionId) {
      const sessionTimeline = timelineMapRef.current.get(event.sessionId) || [];
      for (const e of sessionTimeline) {
        if (e.type === 'plan' && !(e as any).planFrozen) {
          updateTimelineEntryById(event.sessionId, e.id, (prev) => ({
            ...prev,
            planFrozen: true,
          } as any));
        }
      }
    }

    appendTimelineEntry(event.sessionId, {
      id: createId('plan-update'),
      type: 'plan',
      title: entryTitle,
      detail: event.explanation,
      timestamp: eventTimestamp,
      pending: false,
      planTitle: entryTitle,
      planSteps,
      planStatus,
      sequence: event.sequence,
    }, true);

    scrollToBottom();
  }

  function handleEditFileStreamPreview(event: any) {
    logToFile('EDIT_DEBUG', 'handleEditFileStreamPreview', {
      eventType: event.type,
      phase: event.phase,
      toolId: event.toolId,
      id: event.id,
      toolCallId: event.toolCallId,
      sessionId: event.sessionId,
      filePath: event.filePath,
      taskAgentId: event.taskAgentId,
      sequence: event.sequence,
      timestamp: event.timestamp,
    });
    const sessionId = event.sessionId || activeSessionIdRef.current;
    if (!sessionId) return;
    const toolId: string | undefined = typeof event.toolId === 'string' ? event.toolId : undefined;
    if (!toolId) return;
    dbg('[handleEditFileStreamPreview] recv', {
      phase: event.phase,
      toolId,
      filePath: event.filePath,
      newStringLen: typeof event.newStringPartial === 'string' ? event.newStringPartial.length : undefined,
      oldContentLen: typeof event.oldContent === 'string' ? event.oldContent.length : undefined,
    });

    const sessionTimeline = timelineMapRef.current.get(sessionId) || [];
    const filePath: string = typeof event.filePath === 'string' ? event.filePath : '';
    const byToolId = findEntryByToolId(
      sessionTimeline,
      toolId,
      (entry) => entry.type === 'edit_file',
    );
    const orphanPreviewByPath = !byToolId && filePath
      ? sessionTimeline
          .slice()
          .reverse()
          .find((entry: TimelineEntry) =>
            entry.type === 'edit_file' &&
            (entry.editStreaming === true || entry.pending === true || entry.editIsComplete === false) &&
            typeof entry.editFilePath === 'string' &&
            (entry.editFilePath === filePath
              || entry.editFilePath.endsWith(filePath)
              || filePath.endsWith(entry.editFilePath)),
          )
      : undefined;
    let target = byToolId || orphanPreviewByPath;

    if (target && !byToolId) {
      // orphan preview claim — 给它绑 toolId, 后续都走 toolId 路径
      logTimelineJank('edit-claim-by-path', {
        phase: 'preview',
        sessionId,
        incomingToolId: toolId,
        targetId: target.id,
        filePath,
        targetToolCallIdSet: target.toolCallIdSet,
      });
      updateTimelineEntryById(sessionId, target.id, (entry: TimelineEntry) =>
        ({ ...entry, ...bindToolIdPatch(entry, toolId) }),
      );
    }

    if (!target && filePath) {
      const debugSnapshot = (timelineMapRef.current.get(sessionId) || [])
        .filter((e: TimelineEntry) => e.type === 'edit_file')
        .map((e: TimelineEntry) => ({
          id: e.id,
          toolName: e.toolName,
          editFilePath: e.editFilePath,
          editStreaming: e.editStreaming,
          editIsComplete: e.editIsComplete,
          pending: e.pending,
          toolCallIdSet: e.toolCallIdSet,
        }));
      logToFile('EDIT_DEBUG', 'handleEditFileStreamPreview:CREATE_NEW_ENTRY', {
        incomingToolId: toolId,
        filePath,
        byToolId: Boolean(byToolId),
        orphanPreviewByPath: Boolean(orphanPreviewByPath),
        currentEditFileEntries: debugSnapshot,
      });
      logTimelineJank('edit-create-entry', {
        source: 'preview',
        sessionId,
        incomingToolId: toolId,
        filePath,
        candidates: debugSnapshot,
      });
      const fileName = filePath.split(/[/\\]/).pop() || filePath;
      const newEntryId = createId('timeline-edit-file');
      appendTimelineEntry(sessionId, {
        id: newEntryId,
        type: 'edit_file',
        title: `✏️ Editing: ${fileName}`,
        detail: `File: ${filePath}`,
        timestamp: event.timestamp || Date.now(),
        level: 'info',
        pending: true,
        editFilePath: filePath,
        editOldString: '',
        editNewString: '',
        editStartLine: typeof event.startLine === 'number' ? event.startLine : 1,
        editStreaming: true,
        editIsComplete: false,
        ...initialIdentity(toolId),
        toolName: 'edit_file',
      }, true);
      target = (timelineMapRef.current.get(sessionId) || []).find(
        (e: TimelineEntry) => e.id === newEntryId,
      ) || undefined;
      scrollToBottom();
    }

    if (!target) {
      // 没有 filePath 也没有现成 entry, 实在没法渲染, 丢弃. (init 阶段不会到这里,
      // delta 阶段如果 runtime 还没发过 init 就先来 delta, 就会命中; 静默 OK.)
      return;
    }

    const phase: 'init' | 'delta' = event.phase === 'init' ? 'init' : 'delta';

    if (phase === 'init') {
      const oldContent = typeof event.oldContent === 'string' ? event.oldContent : '';
      const startLine = typeof event.startLine === 'number' ? event.startLine : target.editStartLine || 1;
      updateTimelineEntryById(sessionId, target.id, (entry: TimelineEntry) => ({
        ...entry,
        editFilePath: filePath || entry.editFilePath,
        editOldString: oldContent,
        editStartLine: startLine,
        editStreaming: true,
        editIsComplete: false,
        pending: true,
        // 单 hunk 结构重置, 多 hunk 的由 runtime 侧 abort 了不走这里
        editHunks: [{
          oldString: oldContent,
          newString: entry.editNewString || '',
          startLine,
          previewTruncated: false,
        }],
      }));
      return;
    }

    // delta 阶段: NEW 侧覆盖式更新 — 走 rAF 缓冲避免 React 重绘雪崩
    const newStringPartial: string = typeof event.newStringPartial === 'string'
      ? event.newStringPartial : '';
    const bufferMap = editPreviewBufferRef.current;
    const existingBuf = bufferMap.get(toolId);
    if (existingBuf) {
      // 已经有在等 rAF 的 buffer, 只更新 latest; 同一帧内所有 delta 都被合并成一次 flush
      existingBuf.latestNewString = newStringPartial;
      existingBuf.entryId = target.id;
      existingBuf.sessionId = sessionId;
      return;
    }
    // 初始入队并排 rAF
    const buf = {
      entryId: target.id,
      sessionId,
      latestNewString: newStringPartial,
      rafHandle: null as number | null,
    };
    bufferMap.set(toolId, buf);
    const flush = () => {
      const current = bufferMap.get(toolId);
      if (!current) return;
      bufferMap.delete(toolId);
      updateTimelineEntryById(current.sessionId, current.entryId, (entry: TimelineEntry) => ({
        ...entry,
        editNewString: current.latestNewString,
        editStreaming: true,
        editIsComplete: false,
        pending: true,
        editHunks: (entry.editHunks && entry.editHunks.length > 0)
          ? entry.editHunks.map((h, idx) => idx === 0
              ? { ...h, newString: current.latestNewString }
              : h)
          : [{
              oldString: entry.editOldString || '',
              newString: current.latestNewString,
              startLine: entry.editStartLine || 1,
              previewTruncated: false,
            }],
      }));
    };
    if (typeof requestAnimationFrame === 'function') {
      buf.rafHandle = requestAnimationFrame(flush);
    } else {
      // 非浏览器环境 (测试) 退化成 setTimeout
      buf.rafHandle = setTimeout(flush, 16) as unknown as number;
    }
  }

  function handleEditFileStream(event: any) {
    logToFile('EDIT_DEBUG', 'handleEditFileStream', {
      eventType: event.type,
      toolId: event.toolId,
      id: event.id,
      toolCallId: event.toolCallId,
      sessionId: event.sessionId,
      filePath: event.filePath,
      isComplete: event.isComplete,
      success: event.success,
      taskAgentId: event.taskAgentId,
      hunksCount: Array.isArray(event.hunks) ? event.hunks.length : 0,
      oldStringLen: typeof event.oldString === 'string' ? event.oldString.length : null,
      newStringLen: typeof event.newString === 'string' ? event.newString.length : null,
      sequence: event.sequence,
      timestamp: event.timestamp,
    });
    // flush 覆盖掉最终 diff 内容
    const incomingToolId = typeof event.toolId === 'string' ? event.toolId : '';
    if (incomingToolId) {
      const buf = editPreviewBufferRef.current.get(incomingToolId);
      if (buf?.rafHandle != null) {
        if (typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(buf.rafHandle);
        } else {
          clearTimeout(buf.rafHandle as unknown as ReturnType<typeof setTimeout>);
        }
      }
      editPreviewBufferRef.current.delete(incomingToolId);
    }
    dbg('[handleEditFileStream] 📝 Received:', {
      filePath: event.filePath,
      oldStringLen: event.oldString?.length,
      newStringLen: event.newString?.length,
      hunksCount: Array.isArray(event.hunks) ? event.hunks.length : 0,
      isComplete: event.isComplete,
      sequence: event.sequence,
      timestamp: event.timestamp,
    });

    // 工具执行前就渲染一个 pending 的 Edit Card，让用户能提前看到 diff
    const isPreview = !event.isComplete;

    const sessionId = event.sessionId || activeSessionIdRef.current;
    if (!sessionId) {
      return;
    }

    const filePath = event.filePath || '';
    if (!filePath) {
      return;
    }
    const streamToolId = typeof event.toolId === 'string' ? event.toolId : undefined;

    const eventTimestamp = event.timestamp || Date.now();
    const fileName = filePath.split(/[/\\]/).pop() || filePath;
    const title = `✏️ Editing: ${fileName}`;
    const detailHints: string[] = [];
    const hunks = Array.isArray(event.hunks) ? event.hunks : [];
    const dedupedHunks = (() => {
      if (hunks.length === 0) return [] as EditStreamHunk[];
      const seen = new Set<string>();
      const unique: EditStreamHunk[] = [];
      for (const hunk of hunks) {
        const oldStr = typeof hunk?.oldString === 'string' ? hunk.oldString : '';
        const newStr = typeof hunk?.newString === 'string' ? hunk.newString : '';
        const line = typeof hunk?.startLine === 'number' ? hunk.startLine : 0;
        const sign = `${line}:${oldStr}\u0000${newStr}`;
        if (seen.has(sign)) continue;
        seen.add(sign);
        unique.push(hunk);
      }
      return unique;
    })();

    const optionalNumber = (value: unknown): number | undefined => {
      const n = Number(value);
      return Number.isFinite(n) ? Math.max(0, n) : undefined;
    };

    const resolveOldNew = (hunk?: { oldString?: string; newString?: string }) => {
      const oldFromEvent = typeof event.oldString === 'string' ? event.oldString : '';
      const newFromEvent = typeof event.newString === 'string' ? event.newString : '';
      return {
        oldString: typeof hunk?.oldString === 'string' ? hunk.oldString : oldFromEvent,
        newString: typeof hunk?.newString === 'string' ? hunk.newString : newFromEvent,
      };
    };

    const normalizedHunks = dedupedHunks.length > 0
      ? dedupedHunks.map((hunk) => {
        const resolved = resolveOldNew(hunk);
        return {
          oldString: resolved.oldString,
          newString: resolved.newString,
          startLine: typeof hunk?.startLine === 'number'
            ? hunk.startLine
            : (typeof event.startLine === 'number' ? event.startLine : 1),
          oldLineCount: optionalNumber((hunk as any)?.oldLineCount ?? (hunk as any)?.old_line_count),
          newLineCount: optionalNumber((hunk as any)?.newLineCount ?? (hunk as any)?.new_line_count),
          oldCharCount: optionalNumber((hunk as any)?.oldCharCount ?? (hunk as any)?.old_char_count),
          newCharCount: optionalNumber((hunk as any)?.newCharCount ?? (hunk as any)?.new_char_count),
          previewTruncated: Boolean((hunk as any)?.previewTruncated ?? (hunk as any)?.preview_truncated),
        };
      })
      : [{
        oldString: typeof event.oldString === 'string' ? event.oldString : '',
        newString: typeof event.newString === 'string' ? event.newString : '',
        startLine: typeof event.startLine === 'number' ? event.startLine : 1,
        oldLineCount: optionalNumber((event as any).oldLineCount ?? (event as any).old_line_count),
        newLineCount: optionalNumber((event as any).newLineCount ?? (event as any).new_line_count),
        oldCharCount: optionalNumber((event as any).oldCharCount ?? (event as any).old_char_count),
        newCharCount: optionalNumber((event as any).newCharCount ?? (event as any).new_char_count),
        previewTruncated: Boolean(event.previewTruncated),
      }];
    const primaryHunk = normalizedHunks[0];
    const oldString = primaryHunk?.oldString || '';
    const newString = primaryHunk?.newString || '';
    const startLine = typeof primaryHunk?.startLine === 'number' ? primaryHunk.startLine : 1;
    const hasPreviewTruncated = Boolean(
      event.previewTruncated
      || normalizedHunks.some((hunk: any) => Boolean(hunk?.previewTruncated))
    );
    const omittedHunks = Number.isFinite(Number(event.hunksOmitted))
      ? Math.max(0, Number(event.hunksOmitted))
      : 0;
    if (hasPreviewTruncated) {
      detailHints.push('preview truncated');
    }
    if (omittedHunks > 0) {
      detailHints.push(`${omittedHunks} hunks omitted`);
    }
    const detail = detailHints.length > 0
      ? `File: ${filePath} (${detailHints.join(', ')})`
      : `File: ${filePath}`;

    // 而 edit_file_stream 带的是工具执行后的绝对路径，精确 === 会失败导致重复创建 entry
    const pathMatches = (entryPath: string | undefined, streamPath: string): boolean => {
      if (!entryPath) return false;
      if (entryPath === streamPath) return true;
      // 尾部匹配: "/full/path/Foo.java" ends with "Foo.java" 或反之
      return streamPath.endsWith(entryPath) || entryPath.endsWith(streamPath);
    };

    const sessionTimeline = timelineMapRef.current.get(sessionId) || [];
    const editFileCandidatesForDebug = () => sessionTimeline
      .filter((e) => e.type === 'edit_file')
      .map((e) => ({
        id: e.id,
        path: e.editFilePath,
        toolCallId: e.toolCallId,
        toolCallIdSet: e.toolCallIdSet,
        streaming: e.editStreaming,
        pending: e.pending,
        complete: e.editIsComplete,
      }));

    /* 身份判定 — 三层, 严格:
     *   1. byToolId: 已绑的 entry (含 toolCallIdSet) → 直接命中
     *   2. orphanPreviewByPath: 还没完成的 edit 卡 + 路径匹配 → claim 并补 id。
     *      这里不再要求 toolCallIdSet 为空, 因为 preview/tool_call/final stream 的 id 字段
     *      在不同 provider/forwarder 下可能不一致; path + 未完成态是同卡收敛规则。
     *   3. 都没找到 → 创建新 entry
     *
     * 之前的 streamingPreview / pendingEntry / matchingContentEntry 三连兜底已经下掉:
     * 它们会跨身份匹错卡 → "同文件 rapid-fire 多次 edit 时, 第一张卡的 isComplete 被匹中
     * 第二张卡, 第一张永卡运行中". 严格身份后这条路彻底封死. */
    const toolIdMatchedEntry = findEntryByToolId(
      sessionTimeline,
      streamToolId,
      (entry) => entry.type === 'edit_file',
    );
    const orphanPreviewEntry = !toolIdMatchedEntry
      ? sessionTimeline
          .slice()
          .reverse()
          .find((entry: TimelineEntry) =>
            entry.type === 'edit_file' &&
            (entry.editStreaming === true || entry.pending === true || entry.editIsComplete === false) &&
            pathMatches(entry.editFilePath, filePath),
          )
      : undefined;
    const targetEntry = toolIdMatchedEntry || orphanPreviewEntry;
    if (orphanPreviewEntry && streamToolId && targetEntry === orphanPreviewEntry) {
      // orphan claim — 当前 stream 是这张 preview 卡的权威收敛事件
      logTimelineJank('edit-claim-by-path', {
        phase: 'final-stream',
        sessionId,
        incomingToolId: streamToolId,
        targetId: orphanPreviewEntry.id,
        filePath,
        targetToolCallIdSet: orphanPreviewEntry.toolCallIdSet,
      });
      updateTimelineEntryById(sessionId, orphanPreviewEntry.id, (entry: TimelineEntry) =>
        ({ ...entry, ...bindToolIdPatch(entry, streamToolId) }),
      );
    }
    dbg('[handleEditFileStream] match', {
      streamToolId,
      hasToolIdMatch: Boolean(toolIdMatchedEntry),
      hasOrphanPreviewMatch: Boolean(orphanPreviewEntry),
      targetId: targetEntry?.id,
      editFilePathCandidates: editFileCandidatesForDebug(),
    });
    const isFailedEditEvent = event.success === false;

    if (isFailedEditEvent) {
      if (targetEntry) {
        updateTimelineEntryById(sessionId, targetEntry.id, (entry: TimelineEntry) => ({
          ...entry,
          pending: false,
          editIsComplete: false,
          editStreaming: false,
          level: 'error',
          success: false,
          // (比如 hash mismatch 根本没进入实际编辑), 这时展示 LLM 想改什么比空更有用.
          editNewString: (event.newString && event.newString.length > 0)
            ? event.newString
            : (entry.editNewString || ''),
          editOldString: (event.oldString && event.oldString.length > 0)
            ? event.oldString
            : (entry.editOldString || ''),
          title: `✏️ Edit Failed: ${fileName}`,
          detail: event.errorMessage
            ? `File: ${filePath} (${event.errorMessage})`
            : `File: ${filePath} (edit failed)`,
          timestamp: eventTimestamp,
        }), true);
      } else {
        appendTimelineEntry(sessionId, {
          id: createId('timeline-edit-file'),
          type: 'edit_file',
          title: `✏️ Edit Failed: ${fileName}`,
          detail: event.errorMessage
            ? `File: ${filePath} (${event.errorMessage})`
            : `File: ${filePath} (edit failed)`,
          timestamp: eventTimestamp,
          level: 'error',
          pending: false,
          success: false,
          editFilePath: filePath,
          editOldString: oldString,
          editNewString: newString,
          editStartLine: startLine,
          editHunks: normalizedHunks,
          editReplaceAll: normalizedHunks.length > 1,
          ...initialIdentity(streamToolId),
          editIsComplete: false,
        }, true);
      }
      scrollToBottom();
      return;
    }

    const applyEntryUpdate = (entryId: string): string => {
      const eventHasContent = normalizedHunks.some(
        (h) => (h?.newString && h.newString.length > 0) || (h?.oldString && h.oldString.length > 0),
      );
      updateTimelineEntryById(sessionId, entryId, (entry: TimelineEntry) => ({
        ...entry,
        editFilePath: filePath,
        editOldString: eventHasContent ? oldString : (entry.editOldString || oldString),
        editNewString: eventHasContent ? newString : (entry.editNewString || newString),
        editStartLine: eventHasContent ? startLine : (entry.editStartLine ?? startLine),
        editHunks: eventHasContent
          ? normalizedHunks
          : (entry.editHunks && entry.editHunks.length > 0 ? entry.editHunks : normalizedHunks),
        editReplaceAll: (eventHasContent ? normalizedHunks.length : (entry.editHunks?.length ?? normalizedHunks.length)) > 1,
        ...(streamToolId ? bindToolIdPatch(entry, streamToolId) : {}),
        editIsComplete: !isPreview,
        pending: isPreview,
        editStreaming: false,
        title: isPreview ? `✏️ Editing: ${fileName}` : title,
        detail,
        timestamp: eventTimestamp,
      }), true);
      return entryId;
    };

    const appendEditEntry = (): string => {
      const entryId = createId('timeline-edit-file');
      const candidates = editFileCandidatesForDebug();
      logToFile('EDIT_DEBUG', 'handleEditFileStream:CREATE_NEW_ENTRY', {
        incomingToolId: streamToolId,
        filePath,
        isPreview,
        isComplete: event.isComplete,
        success: event.success,
        hasToolIdMatch: Boolean(toolIdMatchedEntry),
        hasOrphanPreviewMatch: Boolean(orphanPreviewEntry),
        candidates,
      });
      logTimelineJank('edit-create-entry', {
        source: 'final-stream',
        sessionId,
        incomingToolId: streamToolId,
        filePath,
        isPreview,
        candidates,
      });
      appendTimelineEntry(sessionId, {
        id: entryId,
        type: 'edit_file',
        title: isPreview ? `✏️ Editing: ${fileName}` : title,
        detail,
        timestamp: eventTimestamp,
        level: 'info',
        pending: isPreview,
        editFilePath: filePath,
        editOldString: oldString,
        editNewString: newString,
        editStartLine: startLine,
        editHunks: normalizedHunks,
        editStreaming: false,
        ...initialIdentity(streamToolId),
        editReplaceAll: normalizedHunks.length > 1,
        editIsComplete: !isPreview,
      }, true);
      return entryId;
    };

    let finalizedEntryId: string;
    if (targetEntry) {
      finalizedEntryId = applyEntryUpdate(targetEntry.id);
    } else {
      finalizedEntryId = appendEditEntry();
    }

    if (!isPreview) {
      const latestTimeline = timelineMapRef.current.get(sessionId) || [];
      for (const entry of latestTimeline) {
        if (entry.id === finalizedEntryId) continue;
        if (entry.type !== 'edit_file') continue;
        if (entry.pending !== true && entry.editStreaming !== true) continue;
        const sameTool = streamToolId && entryMatchesToolId(entry, streamToolId);
        const samePath = pathMatches(entry.editFilePath || entry.targetPath, filePath);
        if (!sameTool && !samePath) continue;
        logTimelineJank('edit-close-duplicate-pending', {
          sessionId,
          finalizedEntryId,
          closedEntryId: entry.id,
          streamToolId,
          sameTool: Boolean(sameTool),
          samePath,
          filePath,
          closedPath: entry.editFilePath || entry.targetPath,
          closedToolCallIdSet: entry.toolCallIdSet,
        });
        updateTimelineEntryById(sessionId, entry.id, (prev: TimelineEntry) => ({
          ...prev,
          pending: false,
          editStreaming: false,
          editIsComplete: true,
          awaitingApproval: false,
          success: prev.success ?? true,
        }));
      }
    }

    scrollToBottom();

    // step 6A 补丁：edit_file_stream 独立终止于此（不像 write_file_stream
    // 那样会 forward 到 handleFileStream），所以必须在这里显式发 VFS 事件。
    // step 7A 清理：移除 setFileTreeRefreshKey —— FILES_TOPIC 订阅已经覆盖。
    if (!isPreview) {
      vfs.notifyChanged(filePath, 'agent');
    }
  }

  function handleWriteFileStream(event: any) {
    if (!event.isComplete) {
      return;
    }
    handleFileStream({
      ...event,
      type: 'file_stream',
    });
  }

  function handleTextComplete(event: any) {
    const sessionId = event.sessionId || activeSessionIdRef.current;
    const target = sessionId ? resolveSlot(sessionId) : null;
    const timeline = sessionId ? (timelineMapRef.current.get(sessionId) || []) : [];
    const targetEntry = target ? timeline.find((entry) => entry.id === target.timelineEntryId) : undefined;
    if (!targetEntry?.detail?.trim()) {
      /* 这里原本还判 `target.phase !== 'closed'` —— 但 resolveSlot 返回的是
       * { messageId, timelineEntryId } 这个**只有两个字段的新对象**, 根本不带 phase,
       * 所以那个条件恒真 (undefined !== 'closed'), 从来没起过作用 (TS2339 点出来的)。
       * 去掉它不改行为: closeSlot 内部会拿 slotsRef 里的真 slot 自己判 phase,
       * 已关闭时只在文本为空的情况下补 completionText —— 真幂等 (见 closeSlot:7016)。 */
      if (sessionId && target) {
        const completionText = extractStreamText(event, ['text', 'content', 'message']);
        closeSlot(sessionId, 'text_complete-before-paint',
          completionText ? { completionText } : {});
      }
      return;
    }
    handleResponseCompleted(event);
  }

  function handleReasoningComplete(event: any) {
    const sessionId = event.sessionId || activeSessionIdRef.current;
    closeReasoningEntry(sessionId);
  }

  function closeReasoningEntry(sessionId: string | null | undefined) {
    if (!sessionId) return;
    const existing = reasoningStreamRef.current.get(sessionId);
    if (!existing) return;
    const startedAt = existing.startedAt;
    const durationMs = startedAt && startedAt > 0 ? Math.max(0, Date.now() - startedAt) : undefined;
    updateTimelineEntryById(sessionId, existing.entryId, (prev) => ({
      ...prev,
      pending: false,
      duration: prev.duration ?? durationMs,
    }));
    reasoningStreamRef.current.delete(sessionId);
  }

  function appendReasoningChunk(sessionId: string | null | undefined, delta: string, timestamp?: number, title?: string) {
    if (!sessionId) return;
    const safeDelta = typeof delta === 'string' ? delta : '';

    const existing = reasoningStreamRef.current.get(sessionId);
    if (existing) {
      const merged = mergeReasoningDelta(existing.content, safeDelta);
      existing.content = merged.content;
      updateTimelineEntryById(sessionId, existing.entryId, (prev) => ({
        ...prev,
        title: title || prev.title || tRef.current.timeline.reasoning,
        detail: existing.content,
        pending: true,
        timestamp: timestamp || prev.timestamp,
      }));
      if (merged.appended) {
        updateStreamingTokens(sessionId, merged.appended);
      }
    } else {
      if (!safeDelta) return;

      //
      // 原代码有个"向后扫 5 条找已关闭 thinking entry 复用"的逻辑(注释写着"防止重复渲染"),
      // 实际是错的:当 LLM 经过工具执行再进入下一轮 reasoning 时,
      //   1) reasoningStreamRef.get(sessionId) 因为上一轮 complete 已经 delete,返回 undefined
      //   2) 进入复用分支,找到上一轮那条已关闭的 thinking entry
      //   3) `detail: safeDelta` 直接把旧内容整个覆盖掉
      // → 用户看到"新思考覆盖了老思考",历史 reasoning 凭空消失。
      //
      // 正确做法:每次新 reasoning 开始(ref 里没有 active 条目)就新建一个 entry。
      // 同轮内的连续 delta 走 if (existing) 分支累加,结束时 handleReasoningComplete 关闭。
      const entryId = createId('reasoning');
      reasoningStreamRef.current.set(sessionId, { entryId, content: safeDelta, startedAt: timestamp || Date.now() });
      appendTimelineEntry(sessionId, {
        id: entryId,
        type: 'thinking' as const,
        title: title || tRef.current.timeline.reasoning,
        detail: safeDelta || undefined,
        timestamp: timestamp || Date.now(),
        pending: true,
      });
    }

    scrollToBottom();
  }

  function handleShellOutputStream(event: any) {
    const sessionId = event.sessionId || activeSessionIdRef.current;
    if (!sessionId) return;
    const toolId = event.toolId;
    if (!toolId) return;
    const currentOutput = typeof event.output === 'string' ? event.output : '';

    // 在 timeline 里找到对应的 shell tool_call / tool_result entry.
    // 不能只用 entry.toolCallId === toolId: LLM/tool worker 的 start/delta/stream/final
    // 偶尔会出现 id 漂移, 其它路径已经统一走 toolCallIdSet. shell stream 如果不跟上,
    // 短命令会在并行 explore 跑完前一直显示"运行中".
    const timeline = timelineMapRef.current.get(sessionId) || [];
    const target = findEntryByToolId(
      timeline,
      toolId,
      (entry) => entry.type === 'tool_call' || entry.type === 'tool_result',
    ) || [...timeline].reverse().find((entry: TimelineEntry) =>
      (entry.type === 'tool_call' || entry.type === 'tool_result') &&
      (entry.pending === true || entry.commandStatus === 'running') &&
      typeof event.command === 'string' &&
      event.command.trim().length > 0 &&
      entry.commandCode === event.command
    );
    // xterm 直通: 把字节级 delta 直接喂给订阅的 TerminalView, ANSI 序列保真.
    // 故意放在 target 检查之前 —— stream event 偶尔会比 tool_call 早到一两毫秒,
    // 这时 entry 还没创建, target 找不到. 但 xterm 也很可能还没 mount(因为
    // mapTimeline 还没生成 terminal content), bus listeners 为空, emit 是 noop.
    // 真早 mount 的 case (理论极少)就吃到了实时 chunk, 不会丢.
    const delta = typeof event.outputDelta === 'string' ? event.outputDelta : '';
    /* 同时按 toolId 和 pid 索引到 chunk bus: timeline 卡片用 toolId 订阅,
     * 服务面板 ShellConsole 镜像 selected service 输出走 pid 订阅. */
    if (delta) emitTerminalChunk(toolId, delta, typeof event.pid === 'number' ? event.pid : undefined);

    if (!target) { noteStreamDrop('shell-stream-no-card', event, String(toolId)); return; }

    updateTimelineEntryById(sessionId, target.id, (prev) => {
      // 保护: 如果之前 tool_result 已经把 entry 翻成 completed (pending=false 且
      // commandStatus !== 'running'), 后到的 stream event 不能再把它翻成 running.
      // execa stdout 的 data 事件偶尔比 process.exit 晚, 导致 isComplete=false 的
      // stream event 在 tool_result 之后到达, 不锁住会让卡片永远卡在"运行中".
      const alreadyDone = prev.pending === false && prev.commandStatus !== 'running';
      const statusPatch = event.isComplete
        ? {
            pending: false as const,
            commandStatus: (event.exitCode === 0 ? 'completed' : 'error') as 'completed' | 'error',
            commandExitCode: typeof event.exitCode === 'number' ? event.exitCode : undefined,
          }
        : alreadyDone
          ? {} // 已完成的不再回翻 running
          : { pending: true, commandStatus: 'running' as const };
      return {
        ...prev,
        output: currentOutput,
        commandResult: currentOutput,
        // commandRawOutput: 给 xterm UI 看的 raw stdout 累积. 命令完成后会有 tool_result 事件
        // 把 entry.output 覆盖成格式化壳(▸ 工作目录 / ✓ 退出码 / ◦ stdout: ...), 那是给 LLM 看的;
        // commandRawOutput 不被 tool_result 覆盖, 让 mount/refresh 时 xterm 回放干净的 stdout.
        commandRawOutput: currentOutput,
        // PTY pid: 第一次 stream 事件就稳定了, 后续 message 重复设也无害
        commandPid: typeof event.pid === 'number' ? event.pid : prev.commandPid,
        ...bindToolIdPatch(prev, toolId),
        ...statusPatch,
      };
    });
  }

  /* 把 fullContent 经打字机缓冲渐进写入 entry.codeContent / codeLines.
   * 关键: 即使 isComplete=true 也走打字机, 不直接 jump (FGTS 关时 backend
   * 只发 1 帧 isComplete=true, jump 就完全没动画了). isComplete 标记记到
   * state.finalize, 由 typewriter 跑到末尾时 set pending=false. */
  function applyFileTypewriter(
    sessionId: string,
    entryId: string,
    fullContent: string,
    isComplete: boolean,
    language: string | undefined,
  ): void {
    const key = `${sessionId}:${entryId}`;
    const prev = fileTypewriterRef.current.get(key);
    if (prev?.timer) clearTimeout(prev.timer);

    const startLen = prev?.currentLen ?? 0;
    dbg('[typewriter] 🎬 start', { entryId: entryId.slice(-12), fullLen: fullContent.length, startLen, isComplete });

    // 已经显示到末尾 → 直接 set 全部并 finalize
    if (startLen >= fullContent.length) {
      fileTypewriterRef.current.delete(key);
      writeEntryCode(sessionId, entryId, fullContent, language, isComplete);
      return;
    }

    const state: TypewriterState = {
      target: fullContent,
      currentLen: startLen,
      timer: null,
      language,
      finalize: isComplete,
    };
    fileTypewriterRef.current.set(key, state);

    let frameCount = 0;
    const tick = () => {
      const cur = fileTypewriterRef.current.get(key);
      if (!cur) {
        console.warn('[typewriter] ⚠ tick but state lost', { entryId: entryId.slice(-12) });
        return;
      }
      const next = Math.min(cur.target.length, cur.currentLen + FILE_TYPEWRITER_CHUNK);
      cur.currentLen = next;
      const reachedEnd = next >= cur.target.length;
      frameCount++;
      writeEntryCode(
        sessionId,
        entryId,
        cur.target.slice(0, next),
        cur.language,
        reachedEnd && cur.finalize,
      );
      if (!reachedEnd) {
        cur.timer = setTimeout(tick, FILE_TYPEWRITER_INTERVAL_MS);
      } else {
        dbg('[typewriter] ✅ done', { entryId: entryId.slice(-12), frames: frameCount });
        cur.timer = null;
        if (cur.finalize) fileTypewriterRef.current.delete(key);
      }
    };
    // 立即 tick 一次让首帧 partial 立刻可见
    tick();
  }

  function writeEntryCode(
    sessionId: string,
    entryId: string,
    content: string,
    language: string | undefined,
    finalize: boolean,
  ) {
    updateTimelineEntryById(sessionId, entryId, (entry) => {
      const lines = content.split(/\r?\n/);
      return {
        ...entry,
        codeContent: content,
        codeLines: lines.map((l, i) => ({
          content: l,
          type: 'added' as const,
          lineNumber: i + 1,
        })),
        language: language || entry.language,
        ...(finalize ? {
          pending: false,
          success: true,
          level: 'info' as const,
          errorMessage: undefined,
          errorCode: undefined,
          errorReason: undefined,
        } : {}),
      };
    });
    scheduleScrollToBottom();
  }

  /* 会话中断时打字机收尾: 事件流已死, 不会再有新 content — 把已缓冲的 target 一次性
   * 写完并释放 state (target 是整份文件内容, 不释放就随中断次数累积驻留内存)。
   * 直接写完而不是丢弃: 内容本地已收齐, 展示完整版比停在半截诚实。 */
  function flushFileTypewritersForSession(sessionId: string): void {
    const prefix = `${sessionId}:`;
    for (const [key, state] of fileTypewriterRef.current) {
      if (!key.startsWith(prefix)) continue;
      if (state.timer) clearTimeout(state.timer);
      fileTypewriterRef.current.delete(key);
      const entryId = key.slice(prefix.length);
      if (state.currentLen < state.target.length || state.finalize) {
        writeEntryCode(sessionId, entryId, state.target, state.language, state.finalize);
      }
    }
  }

  function handleFileStream(event: any) {
    dbg('[handleFileStream] 📁 Received file_stream:', {
      filePath: event.filePath,
      sequence: event.sequence,
      timestamp: event.timestamp,
      isComplete: event.isComplete,
    });

    const sessionId = event.sessionId || activeSessionIdRef.current;
    if (!sessionId) {
      return;
    }

    const fullContent = typeof event.content === 'string' ? event.content : '';
    const resolvedFilePath = event.filePath || event.targetPath || '';
    const pathCandidates = [resolvedFilePath, event.filePath, event.targetPath].filter(
      (path): path is string => typeof path === 'string' && path.trim().length > 0,
    );
    const relative = resolvedFilePath ? formatWorkspacePath(resolvedFilePath) : 'Untitled file';

    // - isComplete === undefined: 流式预览阶段（tool_call_delta）
    // - isComplete === false: 开始写入文件
    // - isComplete === true: 文件写入完成
    const isStreamingPreview = event.isComplete === undefined;
    const isWriteComplete = event.isComplete === true;

    /* 身份判定:
     *   1. 按 event.toolId 找已绑 entry (走 toolCallIdSet) → 命中, 优先级最高
     *   2. fileStreamEntryMap 按 path 找 — 仅在 entry **未绑任何 toolId** 时 claim
     *      已绑别的 id 的卡不偷, 避免 "多次写同文件 → 卡互串内容" 的 bug
     * 找不到 → 进入下面建新卡分支 */
    const timelineForStaleCheck = timelineMapRef.current.get(sessionId) || [];
    const streamToolId: string | undefined = typeof event.toolId === 'string' ? event.toolId : undefined;
    const byToolIdEntry = streamToolId
      ? findEntryByToolId(
          timelineForStaleCheck,
          streamToolId,
          (entry) => entry.toolName === 'write_file' && (entry.type === 'file_stream' || entry.type === 'tool_call'),
        )
      : undefined;
    const mapHitId = pathCandidates.length > 0
      ? pathCandidates.map((path) => getFileStreamEntryId(sessionId, path)).find(Boolean)
      : undefined;
    const mapHitEntry = mapHitId
      ? timelineForStaleCheck.find((e: TimelineEntry) => e.id === mapHitId)
      : undefined;
    const mapHitClaimable = !!(
      mapHitEntry &&
      (!Array.isArray(mapHitEntry.toolCallIdSet) || mapHitEntry.toolCallIdSet.length === 0) &&
      mapHitEntry.pending !== false
    );
    /* map 残留陈旧映射清理: 命中但已完成且未绑当前 toolId, 把 map 项删掉避免污染 */
    if (mapHitEntry && !byToolIdEntry && !mapHitClaimable && !isStreamingPreview) {
      for (const p of pathCandidates) {
        const key = fileStreamKey(sessionId, p);
        if (fileStreamEntryMapRef.current.get(key) === mapHitId) {
          fileStreamEntryMapRef.current.delete(key);
        }
      }
    }
    const existingId = byToolIdEntry?.id || (mapHitClaimable ? mapHitId : undefined);

    const statusLine = event.description || `${isStreamingPreview ? '生成中' : '写入'} ${relative}`;
    const changeLine = (event.additions || event.removals)
      ? `+${event.additions || 0}  -${event.removals || 0}`
      : '';
    const detailText = changeLine ? `${statusLine}\n${changeLine}` : statusLine;
    const contentLines = fullContent.split(/\r?\n/);
    const fullCodeLines = contentLines.map((line: string, idx: number) => ({
      content: line,
      type: 'added' as const,
      lineNumber: idx + 1,
    }));

    if (existingId) {
      // 更新已存在的 entry（无论是流式预览还是最终写入）
      const key = resolvedFilePath ? fileStreamKey(sessionId, resolvedFilePath) : undefined;

      // meta 直接 set; codeContent/codeLines 走 typewriter 缓冲
      updateTimelineEntryById(sessionId, existingId, (entry: TimelineEntry) => ({
        ...entry,
        title: `write_file → ${relative}`,
        detail: detailText,
        pending: true, /* typewriter 完成时再 set false */
        filePath: entry.filePath || resolvedFilePath,
        targetPath: entry.targetPath || resolvedFilePath,
        additions: isWriteComplete ? ((entry.additions || 0) + (event.additions || 0)) : entry.additions,
        removals: isWriteComplete ? ((entry.removals || 0) + (event.removals || 0)) : entry.removals,
        /* 同步身份: file_stream 事件带的 toolId 也加进 entry 身份集合 */
        ...(streamToolId ? bindToolIdPatch(entry, streamToolId) : {}),
      }));
      applyFileTypewriter(sessionId, existingId, fullContent, isWriteComplete, event.language);

      if (key) {
        trackFileStreamContent(key, fullContent, isWriteComplete);
      }
    } else {
      const timeline = timelineMapRef.current.get(sessionId) || [];
      const resolveEntryPath = (entry: TimelineEntry): string =>
        (entry.targetPath || entry.filePath || entry.toolArgs?.file_path || entry.toolArgs?.filePath || entry.toolArgs?.path || '').trim();
      const reversedTimeline = timeline.slice().reverse();
      const matchedWriteEntry = reversedTimeline.find((entry: TimelineEntry) => {
        if (entry.toolName !== 'write_file') return false;
        // 当兜底, 否则同一路径上一次已完成的 file_stream 卡会被新一次写入抢占,
        // 出现 "分段写入合到一张卡" 的 bug.
        const isInFlight = entry.pending === true || entry.streaming === true;
        if (!isInFlight) return false;
        const entryPath = resolveEntryPath(entry);
        if (resolvedFilePath) {
          return pathsMaybeMatch(entryPath, resolvedFilePath);
        }
        return !entryPath;
      });
      const streamingEntry = matchedWriteEntry || reversedTimeline.find((entry: TimelineEntry) =>
        entry.streaming && entry.toolName === 'write_file'
      );

      const eventTimestamp = event.timestamp || Date.now();

      if (streamingEntry) {
        // 已经 commit 过其他 write 的路径, resolvedFilePath 强行覆盖会把两张 write
        // 的内容合到一张卡. 逻辑: entry 一旦有 path, 就锁定 — 不同路径的 file_stream
        // 事件不能往这张 entry 上灌. 若 path 不一致, 放弃复用改为建新 entry.
        const prevFilePath = streamingEntry.filePath || streamingEntry.targetPath;
        if (prevFilePath && resolvedFilePath && prevFilePath !== resolvedFilePath) {
          console.warn('[DIAG handleFileStream streamingEntry] path conflict, creating new entry instead', {
            streamingEntryId: streamingEntry.id,
            prevFilePath,
            resolvedFilePath,
          });
          // 不复用 — 走新建逻辑 (下面 fallthrough 到 else 的 "创建新 entry" 代码)
          // 通过将 streamingEntry 设 null 让后续代码走新建分支
          const entry = appendTimelineEntry(sessionId, {
            id: createId('timeline-write-file'),
            type: 'file_stream',
            title: `write_file → ${relative}`,
            detail: detailText,
            codeContent: '',
            codeLines: [],
            timestamp: eventTimestamp,
            sequence: event.sequence,
            pending: true, /* typewriter 完成时再 set false */
            filePath: resolvedFilePath,
            targetPath: resolvedFilePath,
            language: event.language,
            toolName: 'write_file',
            additions: event.additions,
            removals: event.removals,
            ...initialIdentity(streamToolId),
          }, true);
          if (entry?.id) {
            applyFileTypewriter(sessionId, entry.id, fullContent, isWriteComplete, event.language);
            recordFileStreamEntry(sessionId, resolvedFilePath, entry.id);
            trackFileStreamContent(fileStreamKey(sessionId, resolvedFilePath), fullContent, isWriteComplete);
          }
        } else {
          updateTimelineEntryById(sessionId, streamingEntry.id, (prev) => ({
            ...prev,
            type: 'file_stream' as any,
            title: prev.filePath ? prev.title : (resolvedFilePath ? `write_file → ${relative}` : prev.title),
            detail: detailText,
            pending: true, /* typewriter 完成时再 set false */
            streaming: undefined,
            filePath: prev.filePath || resolvedFilePath,
            targetPath: prev.targetPath || resolvedFilePath,
            language: event.language,
            toolName: 'write_file',
            additions: event.additions,
            removals: event.removals,
            ...(streamToolId ? bindToolIdPatch(prev, streamToolId) : {}),
          }));
          applyFileTypewriter(sessionId, streamingEntry.id, fullContent, isWriteComplete, event.language);
          if (resolvedFilePath) {
            recordFileStreamEntry(sessionId, resolvedFilePath, streamingEntry.id);
            trackFileStreamContent(fileStreamKey(sessionId, resolvedFilePath), fullContent, isWriteComplete);
          }
        }
      } else {
        if (!resolvedFilePath) {
          return;
        }
        // 没有 streaming 预卡片，正常创建新 entry — codeContent 走 typewriter
        const entry = appendTimelineEntry(sessionId, {
          id: createId('timeline-write-file'),
          type: 'file_stream',
          title: `write_file → ${relative}`,
          detail: detailText,
          codeContent: '',
          codeLines: [],
          timestamp: eventTimestamp,
          sequence: event.sequence,
          pending: true, /* typewriter 完成时再 set false */
          filePath: resolvedFilePath,
          targetPath: resolvedFilePath,
          language: event.language,
          toolName: 'write_file',
          additions: event.additions,
          removals: event.removals,
          ...initialIdentity(streamToolId),
        }, true);

        if (entry?.id) {
          applyFileTypewriter(sessionId, entry.id, fullContent, isWriteComplete, event.language);
          recordFileStreamEntry(sessionId, resolvedFilePath, entry.id);
          trackFileStreamContent(fileStreamKey(sessionId, resolvedFilePath), fullContent, isWriteComplete);
        }
      }
    }

    scrollToBottom();

    // Update editor with file content
    // 用户想看 agent 写了什么, 自己点 WRITE 卡片的 "Open in Editor" 按钮, 或者
    // 直接在 FileExplorer 里点文件. 避免默认 agent 模式下右侧编辑器老是被自动
    // 拉出来打扰用户注意力.
    if (resolvedFilePath && fullContent) {
      openOrUpdateFileInEditorRef.current(resolvedFilePath, fullContent, isWriteComplete, { updateOnly: true });

      if (isWriteComplete) {
        // step 6A: 接通 VFS 反向通道。FILES_TOPIC 订阅者全部收到事件：
        //   - EditorService 自己：触发 reloadTab → 读盘 → 内容相同 → no-op
        //   - FileExplorer：自动 refresh + 高亮
        //   - 未来的 file watcher / agent UI 等：直接受益
        // 流式过程中不发（disk 还没真的变），只在 isWriteComplete 时发一次。
        // step 7A: 移除 setFileTreeRefreshKey —— FILES_TOPIC 订阅已经覆盖。
        vfs.notifyChanged(resolvedFilePath, 'agent');
      }
    }
  }

  function handleLogEvent(event: any) {
    const normalizedLevel: 'info' | 'warning' | 'error' =
      event.level === 'warn' ? 'warning' : event.level === 'error' ? 'error' : 'info';
    const eventTimestamp = event.timestamp || Date.now();

    if (!isCompletionLogMessage(event.message)) {
      appendTimelineEntry(event.sessionId, {
        id: createId('timeline'),
        type: 'log',
        title: event.message,
        detail: formatTimelineDetail(event.detail),
        timestamp: eventTimestamp,
        level: normalizedLevel,
        pending: false,
      });
    }

    if (activeSessionIdRef.current !== event.sessionId) return;
    setRuntimeLogs((prev: RuntimeLogEntry[]) => {
      const next: RuntimeLogEntry[] = [
        {
          id: createId('log'),
          level: event.level,
          message: event.message,
          detail: event.detail,
          timestamp: Date.now(),
        },
        ...prev,
      ];
      return next.slice(0, 20);
    });
  }

  /* 残缺 DSML 重来 (kernel core/dsmlTurnRecovery): 记忆里那一轮已经被摘干净、模型会重来,
   * 但气泡是流式 token 画的 —— 这里把这一轮撤掉, 别让重来的回答接在思考后面。
   * 动作跟 stream_retry 的丢弃一致; 不清 token 累积 (重来仍在同一个 turn 内)。 */
  function handleDsmlIncompleteRetry(event: any) {
    const sessionId = event.sessionId || activeSessionIdRef.current;
    if (!sessionId) return;
    closeSlot(sessionId, 'dsml-incomplete-retry'); reasoningStreamRef.current.delete(sessionId);
    const deps = { slot: slotsRef.current.get(sessionId), timeline: timelineMapRef.current.get(sessionId) || [], updateTimelineEntryById, deleteTimelineEntry, dispatchForegroundMessages };
    dropIncompleteAssistantTurn(sessionId, dsmlDiscardedText(event), deps);
  }

  function handleStreamRetry(event: any) {
    // Flush streaming state before retry to avoid mixing content
    const sessionId = event.sessionId || activeSessionIdRef.current;
    if (sessionId) {
      closeSlot(sessionId, 'stream-retry'); reasoningStreamRef.current.delete(sessionId);
      for (const e of supersededOnRetry(timelineMapRef.current.get(sessionId) || [])) void deleteTimelineEntry?.(sessionId, e.id); /* 上一次没生成完的调用作废: 重试会重新生成它 (argStreamPlaceholder.ts) */
      if (event.discardedText) dropDiscardedAssistantText(sessionId, event.discardedText, { slot: slotsRef.current.get(sessionId), timeline: timelineMapRef.current.get(sessionId) || [], updateTimelineEntryById, deleteTimelineEntry, dispatchForegroundMessages }); /* 从头重试 → 上一次的正文作废 (retryDiscardedText.ts) */
    }

    // 区分网络中断和速率限制
    const isRateLimit = event.isRateLimit;
    const isStreamTimeout = event.isStreamTimeout;
    const isNetworkError = event.isNetworkError || event.errorCode === 'STREAM_INCOMPLETE';
    const isNetworkInterrupt = isNetworkError && !isRateLimit && !isStreamTimeout;

    const maxRetries = event.maxRetries ?? 3;
    const errCode = (event.errorCode || '').toString().trim();
    const errFull = (event.error || '').toString().trim();

    /* 主标题 — 永远带计数 + 主语 (限流/超时/网络/连接) */
    let retryHeading: string;
    if (isRateLimit) {
      retryHeading = bi(`请求限流，等待重试 (${event.attempt}/${maxRetries})`, `Rate limited — retrying (${event.attempt}/${maxRetries})`);
    } else if (isStreamTimeout) {
      retryHeading = bi(`响应超时，重试中 (${event.attempt}/${maxRetries})`, `Response timed out — retrying (${event.attempt}/${maxRetries})`);
    } else if (isNetworkInterrupt) {
      retryHeading = bi(`网络中断，重试中 (${event.attempt}/${maxRetries})`, `Network dropped — retrying (${event.attempt}/${maxRetries})`);
    } else {
      retryHeading = bi(`连接异常，重试中 (${event.attempt}/${maxRetries})`, `Connection problem — retrying (${event.attempt}/${maxRetries})`);
    }

    const retryDetail = [
      errCode ? bi(`错误码: ${errCode}`, `Error code: ${errCode}`) : null,
      event.delayMs ? `下次重试: ${(event.delayMs / 1000).toFixed(1)}s 后` : null,
      errFull ? bi(`错误详情:\n${errFull}`, `Details:\n${errFull}`) : null,
    ].filter(Boolean).join('\n');

    /* status bar 短文案 — 带计数但不带错误片段, 保持顶栏简洁 */
    dispatchStatus(retryHeading, event.sessionId);

    const currentTimeline = timelineMapRef.current.get(event.sessionId) || [];
    const existingRetryEntry = currentTimeline.find(
      (e: TimelineEntry) => e.type === 'log' && e.level === 'warning' &&
        (e.title?.includes('重连') || e.title?.includes('重试') || e.title?.includes('Reconnecting') || e.reconnectAttempt !== undefined)
    );

    if (existingRetryEntry) {
      updateTimelineEntryById(event.sessionId, existingRetryEntry.id, (prev) => ({
        ...prev,
        title: retryHeading,
        detail: retryDetail,
        description: errCode || prev.description,
        reconnectAttempt: event.attempt,
        reconnectMaxRetries: maxRetries,
        reconnectDelayMs: event.delayMs,
        reconnectErrorCode: errCode || prev.reconnectErrorCode,
        reconnectError: event.error,
        reconnectIsNetworkInterrupt: isNetworkInterrupt,
        reconnectIsRateLimit: isRateLimit,
        timestamp: event.timestamp || Date.now(),
        pending: true,
      }), true);
    } else {
      appendTimelineEntry(event.sessionId, {
        id: createId('timeline-retry'),
        type: 'log',
        title: retryHeading,
        detail: retryDetail,
        description: errCode || undefined,
        timestamp: event.timestamp || Date.now(),
        level: 'warning',
        pending: true,
        reconnectAttempt: event.attempt,
        reconnectMaxRetries: maxRetries,
        reconnectDelayMs: event.delayMs,
        reconnectErrorCode: errCode || undefined,
        reconnectError: event.error,
        reconnectIsNetworkInterrupt: isNetworkInterrupt,
        reconnectIsRateLimit: isRateLimit,
      });
    }

    /* watchdog — 任何一次 stream_retry 都重置定时器: 在此后 (delay + 上游窗口) 内
     * 必须收到 stream_recovered / error_classified / response_completed / run_result.
     * 否则强制把 entry 收尾成失败, 让用户看到明确终态. */
    armRetryWatchdog(event.sessionId, event.delayMs ?? 0, event.attempt >= maxRetries);

  }

  function armRetryWatchdog(sessionId: string, delayMs: number, isFinalAttempt: boolean) {
    if (!sessionId) return;
    const prev = retryWatchdogRef.current.get(sessionId);
    if (prev) clearTimeout(prev);
    /* 最后一次尝试给更短的等待窗口 (90s), 中段尝试给更长 (180s) — 中段失败会再次触发 stream_retry, 重置 watchdog. */
    const buffer = isFinalAttempt ? 90_000 : 180_000;
    const timer = setTimeout(() => {
      retryWatchdogRef.current.delete(sessionId);
      forceTerminalRetry(sessionId);
    }, delayMs + buffer);
    retryWatchdogRef.current.set(sessionId, timer);
  }

  function clearRetryWatchdog(sessionId: string | null | undefined) {
    if (!sessionId) return;
    const t = retryWatchdogRef.current.get(sessionId);
    if (t) {
      clearTimeout(t);
      retryWatchdogRef.current.delete(sessionId);
    }
  }

  function forceTerminalRetry(sessionId: string) {
    const currentTimeline = timelineMapRef.current.get(sessionId) || [];
    const pendingReconnect = currentTimeline.find(
      (e: TimelineEntry) => e.type === 'log' && e.level === 'warning' &&
        e.pending && e.reconnectAttempt !== undefined
    );
    if (pendingReconnect) {
      updateTimelineEntryById(sessionId, pendingReconnect.id, (prev) => ({
        ...prev,
        pending: false,
        level: 'error',
        title: bi('服务暂时不可用，请稍后重试', 'Service temporarily unavailable — please try again later'),
      } as any), true);
    }
    const watchdogEntryId = turnScopedErrorId(sessionId, 'STREAM_TIMEOUT');
    trackTurnErrorEntry(sessionId, watchdogEntryId);
    appendTimelineEntry(sessionId, {
      id: watchdogEntryId,
      type: 'runner_error',
      title: bi('会话未能完成', 'This turn didn’t finish'),
      timestamp: timestampAfterLatestUser(sessionId),
      pending: false,
      errorCode: 'STREAM_TIMEOUT',
      errorMessage: bi('服务长时间无响应。请检查网络后重试，或稍后再试。', 'The service stopped responding for a long time. Check your connection and retry, or try again later.'),
      errorAction: { kind: 'retry', label: '重试' },
    } as any);
    dispatchStatus('', sessionId ?? undefined);
    settleStatusToReadyIfIdle(sessionId);
  }

  /** 这条已存在的条目之后, 时间线上还有没有更晚的用户气泡 (含运行中插话)。
   *  用来判断"原地更新的错误卡还该不该留在原位" —— 见调用点注释。 */
  function hasUserBubbleAfter(sessionId: string, entry: TimelineEntry): boolean {
    const tl = timelineMapRef.current.get(sessionId) || [];
    const idx = tl.findIndex((e: TimelineEntry) => e.id === entry.id);
    if (idx < 0) return false;
    return tl.slice(idx + 1).some((e: TimelineEntry) => e.type === 'user_message');
  }

  /** 把错误卡的 id 锚到「本轮 user 消息 + 错误码」上。
   *
   *  两个作用, 缺一不可:
   *    1. **去重** —— 同一轮里同一个码再来一次就命中同一个 id, 覆盖而不是再摞一张。
   *       随机 id 的老写法在一次网络抖动里能叠出三四张同样的卡, 整屏都是。
   *    2. **可追溯** —— 挂账 (trackTurnErrorEntry) 记的就是这个 id, 本轮跑成后
   *       settleTurnErrorEntries 才认得出该删哪张。
   *
   *  没有 user 锚点时 (极早期事件) 退回随机 id: 宁可不去重, 也不要让不同轮次的
   *  错误卡撞成同一个 id 互相覆盖。 */
  function turnScopedErrorId(sessionId: string, code: string): string {
    /* 锚点必须是**真·轮边界**的 user 消息 —— 插话/后台通知不算, 见 isTurnBoundaryUserMessage。 */
    const tl = timelineMapRef.current.get(sessionId) || [];
    const anchorIdx = latestTurnBoundaryIdx(tl);
    const turnAnchor = anchorIdx >= 0 ? tl[anchorIdx].id : undefined;
    if (!turnAnchor) return createId('timeline-error');
    return `timeline-error-${turnAnchor}-${String(code).replace(/[^\w.-]/g, '_')}`;
  }

  /**
   * 一轮最多一张错误卡 —— 收走本轮其余的, 并把"失败次数"接力过来。
   *
   *   调用方在 append 自己那张卡**之前**调, 拿到的返回值就是这张卡该显示的次数。
   *
   *   为什么不按错误码判"是不是同一个错": 同一次故障在重试阶梯上会**换名字**
   *   (ECONNRESET → RUNTIME_ERROR), 按码判必然漏。判据只有"本轮 + runner_error +
   *   不是我自己"。时间上更晚的那张必然更准确地描述现在是什么情况。
   *
   *   次数必须接力: 一轮里只留一张、后来的取代前面的, 被取代那张携带的次数不接过来,
   *   用户重试五次也永远看到"失败 1 次", 这个字段等于废了。
   */
  function supersedeTurnErrorCards(sessionId: string, keepId: string): number {
    const tlNow = timelineMapRef.current.get(sessionId) || [];
    const anchorIdx = latestTurnBoundaryIdx(tlNow);
    const inTurn = anchorIdx >= 0 ? tlNow.slice(anchorIdx + 1) : tlNow;
    const prevSame = tlNow.find((e: TimelineEntry) => e.id === keepId);
    const superseded = inTurn.filter((e: TimelineEntry) =>
      e.type === 'runner_error' && e.id !== keepId);

    const repeatCount = Math.max(
      (prevSame as { errorRepeatCount?: number } | undefined)?.errorRepeatCount ?? 0,
      ...superseded.map((e) => (e as { errorRepeatCount?: number }).errorRepeatCount ?? 0),
      0,
    ) + 1;

    for (const e of superseded) {
      if (deleteTimelineEntry) void deleteTimelineEntry(sessionId, e.id);
      else updateTimelineEntryById(sessionId, e.id, (prev) => ({ ...prev, hidden: true } as any), true);
    }
    return repeatCount;
  }

  /** 记下本轮的错误卡, 供"跑成了就抹掉"用。 */
  function trackTurnErrorEntry(sessionId: string | null | undefined, entryId: string) {
    if (!sessionId) return;
    const set = turnErrorEntriesRef.current.get(sessionId) ?? new Set<string>();
    set.add(entryId);
    turnErrorEntriesRef.current.set(sessionId, set);
    /* 排障入口: DevTools 里 window.__neoxTurnErrors() 看当前挂账的错误卡 */
    (window as any).__neoxTurnErrors = () =>
      Object.fromEntries([...turnErrorEntriesRef.current].map(([k, v]) => [k, [...v]]));
  }

  function settleTurnErrorEntries(sessionId: string | null | undefined, succeeded: boolean) {
    if (!sessionId) return;
    if (!succeeded) {
      const tl = timelineMapRef.current.get(sessionId) || [];
      const anchorIdx = latestTurnBoundaryIdx(tl);
      const inTurn = anchorIdx >= 0 ? tl.slice(anchorIdx + 1) : tl;
      const ids = new Set<string>(turnErrorEntriesRef.current.get(sessionId) ?? []);
      for (const e of inTurn) {
        if (e.type === 'runner_error' && (e as { pending?: boolean }).pending) ids.add(e.id);
      }
      for (const entryId of ids) {
        updateTimelineEntryById(sessionId, entryId, (prev) => (
          (prev as { pending?: boolean }).pending ? { ...prev, pending: false } as any : prev
        ), true);
      }
      return;
    }
    const set = turnErrorEntriesRef.current.get(sessionId);
    turnErrorEntriesRef.current.delete(sessionId);

    const timeline = timelineMapRef.current.get(sessionId) || [];
    const lastUserIdx = latestTurnBoundaryIdx(timeline);
    const thisTurn = lastUserIdx >= 0 ? timeline.slice(lastUserIdx + 1) : timeline;
    const doomed = new Set<string>(set ?? []);
    for (const entry of thisTurn) {
      if (entry.type === 'runner_error') doomed.add(entry.id);
    }
    if (doomed.size === 0) return;
    for (const entryId of doomed) {
      if (deleteTimelineEntry) {
        void deleteTimelineEntry(sessionId, entryId);
      } else {
        /* 没有删除能力时至少收起来 —— 跟 handleStreamRecovered 的兜底同款 */
        updateTimelineEntryById(sessionId, entryId, (prev) => ({ ...prev, hidden: true } as any), true);
      }
    }
  }

  function handleStreamRecovered(event: any) {
    // 原逻辑是把 pending 条目改成 ✓ 成功保留,但对用户而言那是一次已经恢复的抖动,
    // 留在时间线上只会让用户误以为"系统出过问题"。
    clearRetryWatchdog(event.sessionId);
    dispatchStatus('', event.sessionId);

    const currentTimeline = timelineMapRef.current.get(event.sessionId) || [];
    const pendingReconnect = currentTimeline.find(
      (e: TimelineEntry) => e.type === 'log' && e.level === 'warning' &&
        e.pending && e.reconnectAttempt !== undefined
    );

    if (pendingReconnect && deleteTimelineEntry) {
      void deleteTimelineEntry(event.sessionId, pendingReconnect.id);
    } else if (pendingReconnect) {
      // 兜底:没有 deleteTimelineEntry 时至少把它收起(hidden) — 不再展示为"成功"留痕
      updateTimelineEntryById(event.sessionId, pendingReconnect.id, (prev) => ({
        ...prev,
        pending: false,
        hidden: true,
      } as any), true);
    }

  }

  /* server 进程重启信号 (AgentBridge 通过 authToken 变化检测后 emit).
   * server 重启 = 内存里的 in-flight session 全没了, run_result 永远不会发,
   * UI 会永远卡"运行中". 这里主动 settle:
   *   1. streaming=false, status 提示
   *   2. sweep 所有 pending 工具 / explore_status / agent_delegation / thinking → aborted
   *   3. sweep pending assistant_message → 标 pending=false
   *   4. 用户能立刻重发或继续, 不再卡死 */
  function handleSessionInterrupted(event: any) {
    const reason = event.reason || 'server_restart';
    console.warn('[Stream] 🔌 session_interrupted:', reason);
    /* sessionId='*' 是 broadcast, 否则指定 session */
    const targets: string[] = event.sessionId === '*' || !event.sessionId
      ? Array.from(timelineMapRef.current.keys())
      : [event.sessionId];

    /* sessionId='*' (broadcast) 时传 undefined → wrapper 走 active 默认; 否则按事件 sid 精确写. */
    dispatchStreaming(false, event.sessionId === '*' ? undefined : event.sessionId);
    dispatchStatus(reason === 'server_restart'
      ? bi('服务已重启, 上轮会话被中断, 可重新发送', 'Service restarted — the last turn was interrupted; you can send again')
      : bi('连接已恢复, 可继续操作', 'Reconnected — you can carry on'),
      /* 同上一行 dispatchStreaming: '*' 是广播, 传 undefined 走 active 默认 */
      event.sessionId === '*' ? undefined : event.sessionId);

    for (const sessionId of targets) {
      if (!sessionId) continue;
      resetStreamingTokens(sessionId);
      clearRetryWatchdog(sessionId);
      closeReasoningEntry(sessionId);
      flushFileTypewritersForSession(sessionId);
      const timeline = timelineMapRef.current.get(sessionId) || [];
      for (const entry of timeline) {
        /* shell xterm 卡片: commandStatus='running' 但 pending 可能已 false（early return）。
           中断时必须清掉 running 状态 + shimmer，否则永远显示"运行中"。 */
        if ((entry as any).commandStatus === 'running') {
          updateTimelineEntryById(sessionId, entry.id, (prev) => ({
            ...prev,
            pending: false,
            commandStatus: 'error',
            errorReason: 'interrupted',
            interrupted: true,
          } as any));
          continue;
        }
        if (!entry.pending && !(entry as any).editStreaming) continue;
        if (entry.type === 'tool_call') {
          updateTimelineEntryById(sessionId, entry.id, (prev) => ({
            ...prev,
            type: 'tool_error' as any,
            pending: false,
            success: false,
            level: 'error',
            errorReason: 'interrupted',
            interrupted: true,
            errorMessage: bi('会话被中断 (服务重启)', 'Turn interrupted (service restarted)'),
          } as any));
        } else if (entry.type === 'edit_file') {
          updateTimelineEntryById(sessionId, entry.id, (prev) => ({
            ...prev,
            pending: false,
            editStreaming: false,
            editIsComplete: true,
            errorReason: 'interrupted',
            interrupted: true,
            errorMessage: prev.errorMessage || '会话被中断',
          } as any));
        } else if (entry.type === 'explore_status' || entry.type === 'agent_delegation') {
          updateTimelineEntryById(sessionId, entry.id, (prev) => ({
            ...prev,
            pending: false,
            exploreStatus: 'failed',
            delegationStatus: 'error',
            errorReason: 'interrupted',
            interrupted: true,
          } as any));
        } else if (entry.type === 'ask_user') {
          updateTimelineEntryById(sessionId, entry.id, (prev) => ({
            ...prev,
            pending: false,
            askUserStatus: prev.askUserStatus === 'waiting' ? 'timeout' : prev.askUserStatus,
            errorReason: 'interrupted',
            interrupted: true,
          } as any));
        } else if (
          entry.type === 'assistant_message'
          || entry.type === 'assistant_prefix'
          || entry.type === 'agent_message'
          || entry.type === 'thinking'
        ) {
          updateTimelineEntryById(sessionId, entry.id, (prev) => ({
            ...prev,
            pending: false,
          }));
        }
      }
      settleTerminalTimelineState(sessionId, { failureReason: reason === 'server_restart' ? '会话被中断 (服务重启)' : '会话被中断' });
    }
  }

  function handleSessionResumed(event: any) {
    const sessionId = event.sessionId || activeSessionIdRef.current;
    if (!sessionId) return;
    console.warn('[Stream] session interrupted by app exit:', {
      sessionId,
      repairedToolCalls: event.repairedToolCalls,
      droppedPartialMessages: event.droppedPartialMessages,
    });
    dispatchStreaming(false, sessionId);
    dispatchStatus('Idle', sessionId);
    const messageId = createId('resume');
    const detail = bi(
      '应用上次退出时这一轮还没做完, 已停止。要继续的话直接发消息。',
      'The app quit before this turn finished, so it stopped here. Send a message to pick it up.',
    );
    appendTimelineEntry(sessionId, {
      id: `resume-${messageId}`,
      type: 'log',
      /* 标题不带 emoji —— timeline 上其它卡片都是纯文字 */
      title: bi('已中断', 'Interrupted'),
      detail,
      timestamp: event.timestamp || Date.now(),
      level: 'info',
      pending: false,
    } as any, true);
    scrollToBottom();
  }

  /* 被中断的那一轮, 历史没能修补好 (悬空的工具调用没补上中断结果) —— 下一条消息可能被模型拒. */
  function handleSessionResumeFailed(event: any) {
    const sessionId = event.sessionId || activeSessionIdRef.current;
    console.warn('[Stream] ❌ session_resume_failed:', event.reason);
    dispatchStreaming(false, sessionId ?? undefined);
    dispatchStatus('Idle', sessionId);
    if (sessionId) {
      const messageId = createId('resume-fail');
      appendTimelineEntry(sessionId, {
        id: `resume-fail-${messageId}`,
        type: 'log',
        title: bi('已中断', 'Interrupted'),
        detail: bi(
          `应用上次退出时这一轮还没做完, 整理对话记录也没成功 (${event.reason || 'unknown'})。发消息如果报错, 请新开一个会话。`,
          `The app quit before this turn finished, and the history couldn't be repaired (${event.reason || 'unknown'}). If your next message fails, start a new chat.`,
        ),
        timestamp: event.timestamp || Date.now(),
        level: 'warning',
        pending: false,
      } as any, true);
    }
  }

  function handleCheckpoint(event: any) {
    const sessionId = event.sessionId || activeSessionIdRef.current;
    const checkpointId = event.checkpointId || event.id;
    const title = event.auto
      ? `↻ Checkpoint · ${checkpointId} · Auto-saved before turn`
      : `↻ Checkpoint · ${checkpointId}`;

    if (event.auto && sessionId && checkpointId) {
      const existingTimeline = timelineMapRef.current.get(sessionId) || [];
      const lastUserEntry = [...existingTimeline].reverse().find((entry) => entry.type === 'user_message');

      if (lastUserEntry) {
        updateTimelineEntryById(sessionId, lastUserEntry.id, (prev) => ({
          ...prev,
          checkpointId,
          checkpointTitle: title,
          checkpointAuto: true,
        }), true);
        return;
      }
    }

    appendTimelineEntry(sessionId, {
      id: createId('timeline-checkpoint'),
      type: 'log',
      title,
      checkpointId,
      checkpointTitle: title,
      checkpointAuto: Boolean(event.auto),
      timestamp: event.timestamp || Date.now(),
      level: 'info',
      pending: false,
    });
  }

  function handleRunResult(event: any) {
    dbg('[Stream] 🏁 run_result:', {
      iterations: event.iterations,
      toolCalls: event.toolCalls,
      durationMs: event.durationMs,
      totalTokens: event.totalTokens,
      failed: event.failed,
      interrupted: event.interrupted,
      sessionId: event.sessionId,
    });
    /* taskAgentId 防御: 子 agent 的 run_result 绝不能硬关主 timeline 的 streaming
     * (常规路径在 taskAgentId filter 就被拦下, 这里兜底 buffered/镜像等旁路). */
    if (event?.taskAgentId) return;
    const terminalFailureReason = event.interrupted
      ? '会话已中断'
      : event.failed
        ? '运行失败'
        : '';
    dispatchStreaming(false, event.sessionId || undefined);
    requestExecutionStateReconcile?.('run_result');
    /* 收尾状态最容易晚到 —— 旁边那行 dispatchStreaming 早就带了 event.sessionId, 唯独这里漏了 */
    dispatchStatus(event.interrupted ? '已停止' : 'Ready', event.sessionId || undefined);
    clearRetryWatchdog(event.sessionId || activeSessionIdRef.current);
    resetStreamingTokens(event.sessionId || activeSessionIdRef.current);
    const sessionId = event.sessionId || activeSessionIdRef.current;
    if (!sessionId) return;
    /* 这一轮**真的**收尾了 —— 「立即发送」等的就是这个信号 (中断后引擎还会再吐
     * 约 2 秒, "流安静了"不等于"这轮结束了")。见 state/streamActivity。 */
    markRunEnded(sessionId);

    settleTurnErrorEntries(sessionId, !event.failed && !event.interrupted);

    /* 中断路径: 先 drain pacer 保住半段文字 (正常 text_complete 可能已关槽,
     * closeSlot 幂等; 若漏发 text_complete 则这里兜底). */
    if (event.interrupted) {
      const partial =
        (typeof event.currentTurnText === 'string' && event.currentTurnText)
        || (typeof event.output === 'string' && event.output)
        || undefined;
      closeSlot(sessionId, 'run_result-interrupted', partial ? { completionText: partial } : undefined);
    }

    settleStatusToReadyIfIdle(sessionId, event);

    closeReasoningEntry(sessionId);

    // 服务器重启或进程中断可能导致 worker_complete 永远不会到达
    const timeline = timelineMapRef.current.get(sessionId) || [];
    for (const entry of timeline) {
      if ((entry as any).commandStatus === 'running') {
        updateTimelineEntryById(sessionId, entry.id, (prev) => ({
          ...prev,
          pending: false,
          commandStatus: terminalFailureReason ? 'error' : 'completed',
          errorReason: prev.errorReason || terminalFailureReason || undefined,
        } as any));
      }
      /* 后台子 agent 例外 —— 见 pendingSweep.ts。注意这一处是**中断/服务重启**兜底,
       * 那种场景下后台 agent 确实也没了; 但事件流会补 worker_complete 来收敛它,
       * 由那条真实信号来判死比在这里猜更准。 */
      if (entry.pending && isBackgroundDelegation(entry as any)) continue;
      if (entry.pending && (entry.type === 'explore_status' || entry.type === 'agent_delegation')) {
        updateTimelineEntryById(sessionId, entry.id, (prev) => ({
          ...prev,
          pending: false,
          exploreStatus: prev.exploreStatus === 'running'
            ? (terminalFailureReason ? 'error' : 'completed')
            : prev.exploreStatus,
          delegationStatus: (prev as any).delegationStatus === 'running'
            ? (terminalFailureReason ? 'error' : 'completed')
            : (prev as any).delegationStatus,
          exploreError: (prev as any).exploreError || terminalFailureReason || undefined,
          delegationError: (prev as any).delegationError || terminalFailureReason || undefined,
        } as any));
      }
      if (entry.pending && (entry.type === 'assistant_message' || entry.type === 'agent_message' || entry.type === 'assistant_prefix')) {
        updateTimelineEntryById(sessionId, entry.id, (prev) => ({
          ...prev,
          pending: false,
        }));
      }
      if (entry.pending && entry.type === 'thinking') {
        updateTimelineEntryById(sessionId, entry.id, (prev) => ({
          ...prev,
          pending: false,
          ...(event.interrupted ? { interrupted: true, errorReason: 'interrupted' } : {}),
        } as any));
        continue;
      }

      // 场景：task-agent 里的 search_files / readfile 等工具，tool_result 事件走了
      // 独立路径（worker_event / projection / taskAgentId filter）没能命中同一个 entry，
      // 导致卡片永远卡在 "Searching..." / "Reading..."。
      // 到 run_result 的时候 agent loop 已经彻底结束，残留 pending tool_call 一定是孤儿。
      if (entry.pending && entry.type === 'tool_call') {
        if (isUnclaimedArgStreamPlaceholder(entry)) { updateTimelineEntryById(sessionId, entry.id, (p) => ({ ...p, ...unclaimedAtRunEndPatch(event, isZhUi()) } as any)); continue; } /* 没生成完, 没执行 */
        // 从没被填上 filePath/codeContent) 不能被这个 janitor 无脑转成 tool_result + success:true
        // —— 会被渲染层识别为 WRITE 卡然后因 filePath 为空显示 "Untitled file"
        // 空壳就是空壳, 没有真实数据就不能伪装成"✓ Done", 删除或降级 tool_error
        const isOrphanWriteFileShell =
          entry.toolName === 'write_file' &&
          !entry.filePath &&
          !entry.targetPath &&
          !entry.codeContent &&
          !(entry.codeLines && entry.codeLines.length > 0);

        if (isOrphanWriteFileShell) {
          console.warn('[DIAG run_result janitor] skipping orphan write_file shell (would have become Untitled)', {
            orphanId: entry.id,
            orphanToolCallId: entry.toolCallId,
          });
          if (deleteTimelineEntry) {
            void deleteTimelineEntry(sessionId, entry.id);
          } else {
            updateTimelineEntryById(sessionId, entry.id, (prev) => ({
              ...prev,
              type: 'tool_error' as any,
              pending: false,
              success: false,
              level: 'error',
            } as any));
          }
          continue;
        }

        updateTimelineEntryById(sessionId, entry.id, (prev) => ({
          ...prev, ...runEndToolCallPatch(prev, event, isZhUi()),
        } as any));
      }
      // run 被用户中断时，ask_user 也必须收敛为静态终止态，不能继续显示等待/转圈。
      if (entry.pending && entry.type === 'ask_user' && event.interrupted) {
        updateTimelineEntryById(sessionId, entry.id, (prev) => ({
          ...prev,
          pending: false,
          askUserStatus: prev.askUserStatus === 'waiting' ? 'timeout' : prev.askUserStatus,
          errorReason: 'interrupted',
          interrupted: true,
        } as any));
      }
      if (entry.pending && entry.type === 'log' && (entry as any).reconnectAttempt !== undefined) {
        updateTimelineEntryById(sessionId, entry.id, (prev: any) => ({
          ...prev,
          pending: false,
          title: event.interrupted ? '重试已取消' : String(prev.title || '').replace('重试中', '重试结束'),
          detail: String(prev.detail || '')
            .split('\n')
            .filter((line: string) => !line.startsWith('下次重试'))
            .join('\n'),
          reconnectDelayMs: undefined,
        }));
      }
      if (entry.pending && entry.type === 'thinking') {
        updateTimelineEntryById(sessionId, entry.id, (prev) => ({
          ...prev,
          pending: false,
        }));
      }
      if (entry.pending && (entry.type === 'edit_file' || entry.type === 'file_stream' || entry.type === 'tool_call')) {
        updateTimelineEntryById(sessionId, entry.id, (prev) => ({
          ...prev,
          pending: false,
          editStreaming: false,
          editIsComplete: entry.type === 'edit_file' ? true : prev.editIsComplete,
          success: prev.success ?? false,
          level: prev.success === false ? 'error' : prev.level,
          awaitingApproval: false,
        }));
      }
    }
    settleTerminalTimelineState(sessionId, {
      failureReason: terminalFailureReason,
      deleteOrphanWriteShell: true,
    });

    if (event.interrupted) {
      const stoppedByUserNow = wasRecentlyStoppedByUser(sessionId);
      const abortReason = typeof (event as any).interruptReason === 'string'
        ? String((event as any).interruptReason).trim()
        : '';
      const stopTurnAnchor = latestTurnBoundaryIdx(timelineMapRef.current.get(sessionId) || []);
      const stopAnchorId = stopTurnAnchor >= 0
        ? (timelineMapRef.current.get(sessionId) || [])[stopTurnAnchor].id
        : sessionId;
      const stopId = `timeline-interrupted-${stopAnchorId}`;
      const already = (timelineMapRef.current.get(sessionId) || []).some((e) => e.id === stopId);
      if (!already) {
        appendTimelineEntry(sessionId, {
          id: stopId,
          type: 'log',
          title: stoppedByUserNow ? bi('已停止', 'Stopped') : abortReason === 'budget_exceeded' ? bi('预算用完', 'Budget used up') : bi('已中止', 'Aborted'),
          detail: stoppedByUserNow
            ? bi('本轮已由用户中断', 'You interrupted this turn')
            : abortReason === 'budget_exceeded' ? bi('本会话花到了预算上限, 已自动停下。点输入框里的预算调高后可继续。', 'This session reached its budget and stopped. Raise the budget from the composer to continue.') : (abortReason || bi('本轮被系统中止', 'This turn was aborted by the system')),
          timestamp: Date.now(),
          level: 'warning',
          pending: false,
        } as any, true);
      }
    }

    const targetEntry = [...timeline].reverse().find((entry: TimelineEntry) =>
      entry.type === 'assistant_message' || entry.type === 'agent_message'
    );

    if (!targetEntry) {
      const lastUserIdx = latestTurnBoundaryIdx(timeline);
      const thisTurn = lastUserIdx >= 0 ? timeline.slice(lastUserIdx + 1) : timeline;
      const hasAnyErrorEntry = thisTurn.some((entry: TimelineEntry) =>
        entry.type === 'runner_error' || entry.type === 'tool_error'
        || (entry as any).errorMessage || (entry as any).errorCode
      );
      const failedOrEmpty = (event as any).failed === true
        || (typeof (event as any).output === 'string' && !(event as any).output.trim());
      /* 用户主动中断常无完整 output — 上面已落「已停止」, 不要再叠 EMPTY_RESPONSE. */
      if (!event.interrupted && !hasAnyErrorEntry && failedOrEmpty) {
        const fallbackEntryId = turnScopedErrorId(sessionId, 'EMPTY_RESPONSE');
        trackTurnErrorEntry(sessionId, fallbackEntryId);
        appendTimelineEntry(sessionId, {
          id: fallbackEntryId,
          type: 'runner_error',
          timestamp: Date.now(),
          errorCode: 'EMPTY_RESPONSE',
          errorMessage: (event as any).failed
            ? '本次请求失败, 但未收到具体错误信息. 可能是 BYOK 服务商响应异常 / 网络中断 / 上游 provider 崩溃.'
            : '本次请求已完成, 但模型未返回任何内容. 常见原因: max_tokens 太小 / 上游 provider 异常 / apiKey 无权限. 建议去 服务商设置 检查.',
          errorAction: { kind: 'open_providers', label: '打开服务商设置' },
          runIterations: (event as any).iterations,
          runToolCalls: (event as any).toolCalls,
          runDurationMs: (event as any).durationMs,
        } as any);
      }
      return;
    }

    updateTimelineEntryById(sessionId, targetEntry.id, (prev) => ({
      ...prev,
      runIterations: event.iterations,
      runToolCalls: event.toolCalls,
      runDurationMs: event.durationMs,
      runTotalTokens: event.totalTokens,
      pending: false,
    }), true);

    /* turn_summary — 把本轮所有文件改动聚合成一张卡, 追加到 timeline 末尾.
     * 没改动 (纯问答轮) 时不创建, 避免 noise.
     *
     * +/- 统计口径:
     *   1. aggregator 累加每个 edit_file / write_file entry 的 hunks, 表示本轮工具实际改动量
     *   2. async refine 只补 refinedLines 给 diff 内容展示, 不覆盖 addCount/delCount
     *   3. 这样顶部条 / turn_summary / 单条 edit 统计保持同一累计口径 */
    const summary = aggregateTurnChanges(timeline, workspacePath);
    if (summary && summary.changes.length > 0) {
      /* dedup by summaryTurnId — run_result 可能因为后端重连 / janitor 兜底 / 双路径
       * (worker_event + run_result 主流) 等原因多次到达, 每次都 createId 新 entry append
       * 就会出现"本轮改动"卡叠 2-3 张. 按 turnId 找已存在的 entry, 复用它的 id (appendTimelineEntry
       * 内部按 id dedup → 更新原 entry 而不新建).
       *
       * 落地: id 走 stable hash (turnId 派生), summaryTurnId 也写回, 让后续 refine 也能命中. */
      const stableId = `timeline-turn-summary-${summary.turnId}`;
      const summaryEntryId = stableId;
      appendTimelineEntry(sessionId, {
        id: summaryEntryId,
        type: 'turn_summary',
        title: bi(`本轮改动 · ${summary.totalFiles} 文件`, `Changes this turn · ${summary.totalFiles} files`),
        timestamp: Date.now(),
        summaryTurnId: summary.turnId,
        summaryChanges: summary.changes,
      } as any, true);

      /* async refine — 不 await, 让 handleRunResult 立刻返回.
       *
       * 关键点: 用 Monaco headless diff editor 生成 refinedLines, 让卡片内容跟 CodeSurfaceViewer
       * 的 diff 展示用同一套 line-diff。统计数字不取 Monaco 净 diff, 仍保留 aggregator 累计值。 */
      void (async () => {
        let hiddenContainer: HTMLDivElement | null = null;
        try {
          const monaco: any = await import('monaco-editor');
          if (!streamActiveRef.current) return;
          const api = (window as any).neox;
          const reader = api?.surfaceReadFile ?? api?.readFile;
          if (!reader) return;

          /* 创建一个屏幕外的 div, 给 hidden DiffEditor 用. Monaco DiffEditor 必须挂在
           * dom 上才能跑 layout 算 diff. */
          hiddenContainer = document.createElement('div');
          hiddenContainer.style.cssText = 'position:absolute;left:-99999px;top:-99999px;width:800px;height:600px;visibility:hidden;pointer-events:none';
          document.body.appendChild(hiddenContainer);

          const refined = await Promise.all(summary.changes.map(async (c) => {
            if (c.op === 'delete' || c.op === 'rename') return c;
            if (!c.editHunks || c.editHunks.length === 0) return c;
            /* 任何一条 hunk previewTruncated=true → editFileTool 把 newString 替换成
             * "[omitted N lines]" 占位文本, indexOf 永远找不到, reverseApply 必废.
             * 这种情况退到 aggregator 的累加值兜底 (cumulative 不准但有数字). */
            if (c.editHunks.some(h => h.previewTruncated)) return c;
            try {
              const result = await reader(c.path);
              const rawCurrent = typeof result === 'string' ? result : (result?.content ?? '');
              if (typeof rawCurrent !== 'string' || !rawCurrent) return c;
              /* CRLF 归一 — editFileTool 保留原文件行尾 (\r\n 或 \n), 但 hunks 内部 newString
               * 是用单 \n join 的. 如果原文件是 CRLF, 反向 apply 时 newString 找不到 (差 \r).
               * 把 currentContent 跟 hunks 都统一成 \n, 跟 hunks 同款 line ending 后再 diff. */
              const currentContent = rawCurrent.replace(/\r\n/g, '\n');
              /* 反向应用所有 edit hunks → "本轮 edit 之前"的内容.
               *
               * 关键: 用 hunk.startLine 做"位置感知" indexOf — 文件里 newString 可能多处出现
               * (相似代码块), 取离 startLine 最近的那个匹配才正确. 否则 indexOf 总取第一个,
               * 跨 hunk 反向时会把别的 hunk 的内容当成自己的, 误差就是这种 ±1. */
              const findClosestMatch = (text: string, needle: string, hintLine?: number): number => {
                if (!needle) return -1;
                if (!hintLine || hintLine <= 0) return text.indexOf(needle);
                /* 算 hintLine 对应的 char offset */
                let charOffset = 0;
                let line = 1;
                for (let i = 0; i < text.length && line < hintLine; i++) {
                  if (text.charCodeAt(i) === 10 /* \n */) line++;
                  charOffset = i + 1;
                }
                /* 找全部出现位置, 选离 charOffset 最近的 */
                let best = -1;
                let bestDist = Infinity;
                let pos = text.indexOf(needle, 0);
                while (pos >= 0) {
                  const dist = Math.abs(pos - charOffset);
                  if (dist < bestDist) { best = pos; bestDist = dist; }
                  pos = text.indexOf(needle, pos + 1);
                }
                return best;
              };
              /* 反向 apply 顺序 — editFileTool 正向应用是按 startLine 降序 (高行号先, 避免线号漂移).
               * 要 UNDO 这套操作, 必须用反向: 按 startLine 升序 (低行号先).
               * 错的顺序会导致每次 indexOf 找的位置都在已经被部分还原的内容里, 微小漂移累积成 ±1 行偏差.
               * 把 hunks 拷贝一份按 startLine 升序排, 不破坏原数组. */
              /* 反向 apply 顺序 — editFileTool 正向应用是按 startLine 降序 (高行号先, 避免线号漂移).
               * 要 UNDO 这套操作, 必须用反向: 按 startLine 升序 (低行号先).
               * 错的顺序 → 每次 indexOf 找的位置都在已经被部分还原的内容里, 微小漂移累积成 ±1 行偏差. */
              const sortedHunks = [...c.editHunks].sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0));
              let oldContent = currentContent;
              for (const h of sortedHunks) {
                const ns = h.newString ?? '';
                const os = h.oldString ?? '';
                if (!ns) continue;
                const idx = findClosestMatch(oldContent, ns, h.startLine);
                if (idx >= 0) {
                  oldContent = oldContent.slice(0, idx) + os + oldContent.slice(idx + ns.length);
                }
              }
              if (oldContent === currentContent) {
                /* 反向应用没动 → hunks 数据有问题, 用 aggregator 的兜底 */
                return c;
              }
              /* trailing newline 归一 — 反向 apply 时 indexOf 替换可能让 oldContent 末尾 \n 状态
               * 跟 currentContent 不一致 (一个有一个没有). Monaco diff 看到末尾 +1 个 phantom empty
               * line → 数字比 LLM 报的净差多 1. 把两边 trailing \n 都剥掉再 diff, 消除这个 phantom. */
              const stripTrail = (s: string) => s.replace(/\n+$/, '');
              const origText = stripTrail(oldContent);
              const modText = stripTrail(currentContent);
              if (origText === modText) {
                /* trailing 归一后两边一致, 说明 refine 没有可靠还原出可展示的净 diff。
                 * 统计口径固定使用 aggregator 的工具调用累计值, 不能在 async refine 里覆盖成 0。 */
                return c;
              }
              /* Monaco headless diff — 只用于生成 refinedLines 给 diff 内容展示。
               * 本轮改动统计采用工具调用累计口径 (aggregateTurnChanges), 避免最终净 diff
               * 覆盖掉用户实际经历过的多次 edit/write 行数。 */
              const diffHost = document.createElement('div');
              diffHost.style.cssText = 'width:800px;height:600px';
              hiddenContainer!.appendChild(diffHost);
              const dEd = createNeoxDiffEditor(monaco, diffHost, {
                original: origText,
                modified: modText,
                language: 'plaintext',
                readOnly: true,
                applyTheme: false,
                extraOptions: {
                  automaticLayout: false,
                  renderSideBySide: true,
                  ignoreTrimWhitespace: false,
                },
              });
              /* dispose editor — factory 已挂 onDidDispose 回收两个 model, 这里再显式 dispose model
               * (isDisposed 守卫防双 dispose) + 移除子容器, 双保险防泄漏。 */
              const disposeDiffEditor = () => {
                const models = dEd.getModel?.();
                try { dEd.dispose(); } catch { /* */ }
                try { if (!models?.original?.isDisposed?.()) models?.original?.dispose?.(); } catch { /* */ }
                try { if (!models?.modified?.isDisposed?.()) models?.modified?.dispose?.(); } catch { /* */ }
                try { diffHost.remove(); } catch { /* */ }
              };
              /* 强制布局一次 — hidden 元素 Monaco 不会自动 layout, 不 layout 不算 diff */
              try { dEd.layout({ width: 800, height: 600 }); } catch { /* */ }
              /* 等 onDidUpdateDiff 触发 (Monaco 异步算 diff, 通常 < 100ms).
               * 已经算过 (model 装载就 sync 完) 时 onDidUpdateDiff 不会再触发 → 用 timeout 兜底拿当前结果. */
              const changes: Array<any> = await new Promise((resolve) => {
                /* 200ms 后无论 onDidUpdateDiff 触发与否, 直接读 getLineChanges — 大多数 < 1k 行
                 * 的文件 Monaco diff 是同步完成的. */
                const timeout = setTimeout(() => {
                  resolve(dEd.getLineChanges?.() ?? []);
                }, 200);
                const sub = dEd.onDidUpdateDiff(() => {
                  clearTimeout(timeout);
                  sub.dispose();
                  resolve(dEd.getLineChanges?.() ?? []);
                });
              });
              /* refinedLines: 把 Monaco lineChanges 展开成 DiffLine[] —
               * timeline 卡片直接当 diff 内容渲染。它是展示层净 diff, 不参与本轮累计统计。 */
              const origLineArr = origText.split('\n');
              const modLineArr = modText.split('\n');
              const refinedLines: Array<
                | { kind: 'add'; newNo: number; text: string }
                | { kind: 'del'; oldNo: number; text: string }
                | { kind: 'ctx'; oldNo?: number; newNo?: number; text: string }
                | { kind: 'hunk'; text: string }
              > = [];
              changes.sort((a, b) =>
                (a.modifiedStartLineNumber || 0) - (b.modifiedStartLineNumber || 0),
              );
              for (let ci = 0; ci < changes.length; ci++) {
                const lc = changes[ci];
                const hasDel = lc.originalEndLineNumber >= lc.originalStartLineNumber;
                const hasAdd = lc.modifiedEndLineNumber >= lc.modifiedStartLineNumber;
                if (ci > 0) {
                  refinedLines.push({
                    kind: 'hunk' as const,
                    text: `@@ −${lc.originalStartLineNumber} +${lc.modifiedStartLineNumber} @@`,
                  });
                }
                if (hasDel) {
                  const dCount = lc.originalEndLineNumber - lc.originalStartLineNumber + 1;
                  for (let i = 0; i < dCount; i++) {
                    const oldNo = lc.originalStartLineNumber + i;
                    refinedLines.push({
                      kind: 'del' as const,
                      oldNo,
                      text: origLineArr[oldNo - 1] ?? '',
                    });
                  }
                }
                if (hasAdd) {
                  const aCount = lc.modifiedEndLineNumber - lc.modifiedStartLineNumber + 1;
                  for (let i = 0; i < aCount; i++) {
                    const newNo = lc.modifiedStartLineNumber + i;
                    refinedLines.push({
                      kind: 'add' as const,
                      newNo,
                      text: modLineArr[newNo - 1] ?? '',
                    });
                  }
                }
              }
              if (refinedLines.length === 0) {
                /* Monaco 没给出 lineChanges 时也保持 aggregator 的 hunk 统计, 避免 async refine
                 * 把单卡已显示的 +N -N 清成汇总 +0 -0。 */
                disposeDiffEditor();
                return c;
              }
              /* 清理 hidden editor + models, 防内存泄漏 */
              disposeDiffEditor();
              return { ...c, refinedLines };
            } catch (err) {
              console.warn('[turn_summary] refine one file failed:', (err as any)?.message);
              return c;
            }
          }));
          if (!streamActiveRef.current) return;
          const refinedTotalAdds = refined.reduce((s, c) => s + (c.addCount || 0), 0);
          const refinedTotalDels = refined.reduce((s, c) => s + (c.delCount || 0), 0);
          updateTimelineEntryById(sessionId, summaryEntryId, (prev: TimelineEntry) => ({
            ...prev,
            summaryChanges: refined,
            /* 标志位只表示 refinedLines 已准备好；addCount/delCount 仍是 aggregator 的累计统计。 */
            summaryRefined: true,
            /* title 使用累计统计, 不使用 Monaco 最终净 diff。 */
            title: bi(`本轮改动 · ${refined.length} 文件 +${refinedTotalAdds} −${refinedTotalDels}`, `Changes this turn · ${refined.length} files +${refinedTotalAdds} −${refinedTotalDels}`),
          } as any));
        } catch (err: any) {
          /* monaco 加载失败 / fs 读失败 — 静默, 用 aggregator 的 cumulative 值兜底 */
          console.warn('[turn_summary] refine accurate counts failed:', err?.message || err);
        } finally {
          /* 务必清理 hidden dom, 否则会一直挂着 */
          if (hiddenContainer && hiddenContainer.parentNode) {
            hiddenContainer.parentNode.removeChild(hiddenContainer);
          }
        }
      })();
    }
  }

  /** 错误卡时间戳不得早于最近一条 user_message — 否则 pause/reload 按 timestamp 排序会把错误顶到用户气泡前面. */
  function timestampAfterLatestUser(sessionId: string | null | undefined, preferred?: number): number {
    const now = Date.now();
    const base = typeof preferred === 'number' && Number.isFinite(preferred) && preferred > 0 ? preferred : now;
    if (!sessionId) return Math.max(base, now);
    const timeline = timelineMapRef.current.get(sessionId) || [];
    for (let i = timeline.length - 1; i >= 0; i--) {
      const e = timeline[i];
      if (e?.type === 'user_message') {
        return Math.max(base, now, (e.timestamp || 0) + 1);
      }
    }
    return Math.max(base, now);
  }

  function handleErrorClassified(event: any) {
    const sessionId = event.sessionId || activeSessionIdRef.current;
    clearRetryWatchdog(sessionId);
    resetStreamingTokens(sessionId);
    closeEmptyAssistantSlotOnError(sessionId, 'error_classified');
    const currentTimeline = timelineMapRef.current.get(sessionId) || [];

    /* 多路径尝试找 NeoxError envelope:
     *   1. event 自身可能 (老路径透传)
     *   2. event.message 文本里可能藏 JSON ("500 ... {...}" 这种)
     *   3. event.context / event.context.originalError (NeoxError.from 留的栈)
     *   只要任意一处成功, 用 catalogue 渲染中文标准化文案. */
    const envelope: NeoxErrorEnvelope | null =
         parseNeoxErrorEnvelope(event)
      ?? extractNeoxEnvelopeFromError({ message: event.message ?? '' })
      ?? extractNeoxEnvelopeFromError(event.context)
      ?? extractNeoxEnvelopeFromError(event.context?.originalError)
      ?? extractNeoxEnvelopeFromError(event.context?.upstreamBody)
      ?? null;
    let presentation: NeoxErrorPresentation | null = envelope ? presentNeoxError(envelope) : null;
    if (presentation?.action?.kind === 'rotate_anonymous') {
      presentation = {
        ...presentation,
        title: bi('需要配置 BYOK', 'Set up your own API key'),
        message: bi(
          '请先在 API 服务商里添加自己的 API Key 和模型后再发送；Neox Cloud 登录/付费能力可按需使用。',
          'Add your own API key and a model under API providers before sending. Neox Cloud sign-in and paid plans remain optional.',
        ),
        severity: 'error',
        showInTimeline: true,
        action: { kind: 'none', label: '' },
      };
    }

    /* autoTrigger 自动行为 — 客户端静默执行, 不展示给用户.
     *   rotate_anonymous 旧动作已在上面转成可见 BYOK 提示。 */
    if (presentation?.action?.autoTrigger) {
      const kind = presentation.action.kind;
      if (kind === 'rotate_anonymous') return;
    }

    /* 账号侧的旁路动作 (网关 key 被撤销 → 静默重 mint; 订阅额度用尽 → 弹额度窗)。
     *   实现在发行版 (billing/streamErrorHooks), 公开构建里是空操作。
     *   不 return —— 错误卡照常按 catalogue 渲染, 这里只在旁边补一个动作。 */
    getEditionHook('onClassifiedStreamError')({
      envelopeCode: envelope?.code,
      envelopeMessage: envelope?.message,
      eventCode: event.code,
      eventMessage: event.message,
    });

    const pendingReconnect = currentTimeline.find(
      (e: TimelineEntry) => e.type === 'log' && e.level === 'warning' &&
        e.pending && e.reconnectAttempt !== undefined
    );

    /* error.classified 永远表示 retry 循环已经结束 (要么用尽要么不可重试).
     * 把"重连中"那条 log entry 强制收尾 (pending=false + 改 title 表"失败"), 否则它会一直
     * 显示"运行中"转圈, 用户看到既有红色错误又有"运行中"会非常困惑.
     * 然后再走下面的分支追加 runner_error 错误卡 (清楚显示最终错误). */
    if (pendingReconnect) {
      const finalReconnectMessage = presentation?.message ?? event.message;
      updateTimelineEntryById(sessionId, pendingReconnect.id, (prev) => ({
        ...prev,
        pending: false,
        level: 'info',
        title: bi('重连失败, 已停止重试', 'Reconnect failed — stopped retrying'),
        detail: [
          prev.reconnectErrorCode
            ? bi(`错误码: ${prev.reconnectErrorCode}`, `Error code: ${prev.reconnectErrorCode}`)
            : null,
          finalReconnectMessage
            ? bi(`错误详情:\n${finalReconnectMessage}`, `Details:\n${finalReconnectMessage}`)
            : prev.detail,
        ].filter(Boolean).join('\n'),
        reconnectError: finalReconnectMessage,
      }), true);
    }

    {
      /* 走 catalogue: 用稳定的 title/message; 否则回落 event.code 文案 */
      const errorLevel = (presentation?.severity ?? (event.retryable ? 'warning' : 'error')) === 'info'
        ? 'info'
        : (event.retryable ? 'warning' : 'error');
      const friendlyTitle = presentation?.title || event.code || '出错了';
      const friendlyMessage = presentation?.message || event.message || '';
      dispatchStatus(`${friendlyTitle}${friendlyMessage ? ': ' + friendlyMessage.split('\n')[0] : ''}`, sessionId ?? undefined);

      const eventTimestamp = timestampAfterLatestUser(sessionId, event.timestamp);
      const recentError = currentTimeline.find(
        (e: TimelineEntry) => e.type === 'log' &&
          (e.level === 'error' || e.level === 'warning') &&
          e.errorCode === event.code &&
          Math.abs((e.timestamp || 0) - eventTimestamp) < 5000
      );
      const runnerError = sessionId ? recentRunnerErrorRef.current.get(sessionId) : undefined;
      let usedEntryId: string | null = null;
      let shouldAppendTimeline = true;

      if (runnerError &&
        Math.abs(runnerError.timestamp - eventTimestamp) < 5000 &&
        isLikelyDuplicateError(runnerError.message, event.message)) {
        shouldAppendTimeline = false;
        usedEntryId = runnerError.entryId;
        updateTimelineEntryById(sessionId, runnerError.entryId, (prev) => ({
          ...prev,
          title: friendlyTitle,
          detail: friendlyMessage,
          level: errorLevel,
          pending: event.retryable,
          timestamp: Math.max(prev.timestamp || 0, eventTimestamp),
          errorCode: envelope?.code ?? event.code,
          errorMessage: friendlyMessage,
          /* 提示语优先用网关按 X-Neox-Lang 出好的 hint (错误文案兜底归网关, 客户端只渲染);
           * 网关没给就用本地 catalogue 的文案, 都没有才回落英文 suggestion (老链路) */
          errorSuggestion: presentation?.hint ?? (envelope ? undefined : event.suggestion),
          errorCategory: event.category,
          errorRetryable: event.retryable,
          /* 可追溯 id —— 有它用户报障就不用描述"几点几分用的什么模型" */
          errorRequestId: envelope?.requestId,
          /* CTA 按钮 — autoTrigger 的 action 上面已经 swallow 不会到这里, 这里都是要给用户点的 */
          errorAction: presentation?.action && !presentation.action.autoTrigger
            ? { kind: presentation.action.kind, label: presentation.action.label }
            : undefined,
        } as any));
      }

      if (shouldAppendTimeline && !recentError) {
        /* 锚点口径跟 turnScopedErrorId 完全一致 (插话/后台通知不是轮边界) —— 两个
         * 生产者一旦口径不同, 同一轮的两张卡就又撞不上了。 */
        const turnAnchorTl = timelineMapRef.current.get(sessionId) || [];
        const turnAnchorIdx = latestTurnBoundaryIdx(turnAnchorTl);
        const turnAnchor = turnAnchorIdx >= 0 ? turnAnchorTl[turnAnchorIdx].id : undefined;
        const rawCode = String(envelope?.code ?? event.code ?? 'unknown');
        const transportFamily = /^(network|stream)\./.test(rawCode)
          ? rawCode.split('.')[0]   /* 'network' / 'stream' */
          : null;
        const errorKey = (transportFamily ?? rawCode).replace(/[^\w.-]/g, '_');
        const timelineEntryId = turnAnchor
          ? `timeline-error-${turnAnchor}-${errorKey}`
          : createId('timeline-error');
        const prevSame = (timelineMapRef.current.get(sessionId) || [])
          .find((e: TimelineEntry) => e.id === timelineEntryId);

        const repeatCount = supersedeTurnErrorCards(sessionId, timelineEntryId);

        trackTurnErrorEntry(sessionId, timelineEntryId);
        appendTimelineEntry(sessionId, {
          id: timelineEntryId,
          errorRepeatCount: repeatCount,
          type: 'runner_error',
          title: friendlyTitle,
          timestamp: prevSame?.timestamp && !hasUserBubbleAfter(sessionId, prevSame)
            ? prevSame.timestamp
            : timestampAfterLatestUser(sessionId, eventTimestamp),
          errorLastAt: eventTimestamp,
          level: errorLevel,
          pending: event.retryable,
          errorCode: envelope?.code ?? event.code,
          errorMessage: friendlyMessage,
          /* 提示语优先用网关按 X-Neox-Lang 出好的 hint (错误文案兜底归网关, 客户端只渲染);
           * 网关没给就用本地 catalogue 的文案, 都没有才回落英文 suggestion (老链路) */
          errorSuggestion: presentation?.hint ?? (envelope ? undefined : event.suggestion),
          errorCategory: event.category,
          errorRetryable: event.retryable,
          /* 可追溯 id —— 有它用户报障就不用描述"几点几分用的什么模型" */
          errorRequestId: envelope?.requestId,
          /* CTA 按钮 — autoTrigger 的 action 上面已经 swallow 不会到这里, 这里都是要给用户点的 */
          errorAction: presentation?.action && !presentation.action.autoTrigger
            ? { kind: presentation.action.kind, label: presentation.action.label }
            : undefined,
        }, true);
        usedEntryId = timelineEntryId;
      }

      if (!usedEntryId && recentError) {
        usedEntryId = recentError.id;
      }

      if (sessionId && usedEntryId) {
        recentClassifiedErrorRef.current.set(sessionId, {
          entryId: usedEntryId,
          message: event.message,
          timestamp: eventTimestamp,
        });
      }
    }

    if (activeSessionIdRef.current === sessionId) {
      setRuntimeLogs((prev: RuntimeLogEntry[]) => {
        const isDuplicate = prev.slice(0, 3).some(
          entry => entry.level === 'error' &&
            entry.message === `[${event.category}] ${event.code}` &&
            Math.abs(entry.timestamp - Date.now()) < 1000
        );

        if (isDuplicate) {
          return prev;
        }

        const next: RuntimeLogEntry[] = [
          {
            id: createId('log'),
            level: 'error',
            message: `[${event.category}] ${event.code}`,
            detail: `${event.message}${event.suggestion ? `\n${event.suggestion}` : ''}`,
            timestamp: Date.now(),
          },
          ...prev,
        ];
        return next.slice(0, 20);
      });
    }

    if (event.retryable) {
      setCanRetry(true);
      setRetryError({
        code: event.code,
        message: event.message,
        suggestion: event.suggestion,
        category: event.category,
        retryable: event.retryable,
      });
    }
  }

  function handleFallback(event: any) {
    const fallbackEvent = event.event;
    const eventTimestamp = event.timestamp || Date.now();

    const reasonMap: Record<string, string> = {
      'provider_error': '服务异常',
      'timeout': '请求超时',
      'rate_limit': '请求限制',
      'network_error': '网络错误',
      'invalid_response': '响应异常',
      'unknown': '未知错误',
    };
    const reasonText = reasonMap[fallbackEvent.reason] || fallbackEvent.reason;

    const title = `🔄 Provider 自动切换`;
    const detail = `${fallbackEvent.fromProvider} → ${fallbackEvent.toProvider}\n原因: ${reasonText}`;

    dispatchStatus(`正在切换到备用 Provider: ${fallbackEvent.toProvider}`, event.sessionId);

    appendTimelineEntry(event.sessionId, {
      id: createId('timeline-fallback'),
      type: 'log',
      title,
      detail,
      timestamp: eventTimestamp,
      level: 'warning',
      pending: false,
      fallbackFrom: fallbackEvent.fromProvider,
      fallbackTo: fallbackEvent.toProvider,
      fallbackReason: fallbackEvent.reason,
      fallbackModelAlias: fallbackEvent.modelAlias,
    });

    if (activeSessionIdRef.current === event.sessionId) {
      setRuntimeLogs((prev: RuntimeLogEntry[]) => {
        const next: RuntimeLogEntry[] = [
          {
            id: createId('log'),
            level: 'warn',
            message: `[Fallback] ${fallbackEvent.fromProvider} → ${fallbackEvent.toProvider}`,
            detail: `Reason: ${fallbackEvent.reason}, Model: ${fallbackEvent.modelAlias}`,
            timestamp: Date.now(),
          },
          ...prev,
        ];
        return next.slice(0, 20);
      });
    }
  }

  function handleRecovery(event: any) {
    const recoveryEvent = event.event;
    const eventTimestamp = event.timestamp || Date.now();

    const title = `✅ Provider 已恢复`;
    const detail = `${recoveryEvent.providerId} 服务已恢复正常`;

    dispatchStatus(`Provider ${recoveryEvent.providerId} 已恢复`, event.sessionId);

    appendTimelineEntry(event.sessionId, {
      id: createId('timeline-recovery'),
      type: 'log',
      title,
      detail,
      timestamp: eventTimestamp,
      level: 'info',
      pending: false,
      recoveryProviderId: recoveryEvent.providerId,
      recoveryPreviousStatus: recoveryEvent.previousStatus,
    });

    if (activeSessionIdRef.current === event.sessionId) {
      setRuntimeLogs((prev: RuntimeLogEntry[]) => {
        const next: RuntimeLogEntry[] = [
          {
            id: createId('log'),
            level: 'info',
            message: `[Recovery] ${recoveryEvent.providerId} recovered`,
            detail: `Previous status: ${recoveryEvent.previousStatus}`,
            timestamp: Date.now(),
          },
          ...prev,
        ];
        return next.slice(0, 20);
      });
    }
  }
  function handleAssistantTextComplete(event: any) {
    const sessionId = event.sessionId || activeSessionIdRef.current;
    if (!sessionId) return;


    const completionText = typeof event.output === 'string' ? event.output.trim() : '';
    const completedAt = event.timestamp || Date.now();
    const slot = slotsRef.current.get(sessionId);

    if (slot) {
      /* text_complete 到达时通过 closeSlot 一步: drain pacer + phase=closed +
       * UI pending=false + (无内容时) completionText 兜底. drain 保证 msg.text 是
       * 完整的, 不会被 completionText 覆盖末尾正在显示的"打字中"状态. */
      closeSlot(sessionId, 'assistant_text_complete', { completionText, completedAt });
      dbg('[Stream] Assistant text_complete (no streaming change):', slot.messageId);
    }
    // streaming 只由 turn_complete 或 run_result 关闭
  }

  function handleResponseCompleted(event: any) {
    const sessionId = event.sessionId || activeSessionIdRef.current;
    const isIntraTurn = event?.type === 'text_complete';
    if (sessionId) {
      clearRetryWatchdog(sessionId);
      if (!isIntraTurn) resetStreamingTokens(sessionId);
      const isAbortWithoutOutput = Boolean(event?.aborted) &&
        (typeof event?.output !== 'string' || event.output.trim().length === 0);
      closeReasoningEntry(sessionId);

      // 所以 explore 里嵌套的 search_files 等工具卡片会永远卡在 "Searching..." 状态。
      // 跟 handleRunResult 里的 sweep 保持一致。
      //
      //   tool_call 也可能跟同一 iter 的后续 text 一起来. 真终止由 run_result 兜底.
      if (!isAbortWithoutOutput && !isIntraTurn) {
        const timeline = timelineMapRef.current.get(sessionId) || [];
        for (const entry of timeline) {
          if (entry.pending && entry.type === 'tool_call') {
            updateTimelineEntryById(sessionId, entry.id, (prev) => ({
              ...prev,
              type: 'tool_result',
              pending: false,
              success: prev.success ?? true,
            }));
          }
          /* 后台子 agent 例外 —— 见 pendingSweep.ts */
          if (entry.pending && (entry.type === 'explore_status' || entry.type === 'agent_delegation')
              && !isBackgroundDelegation(entry as any)) {
            updateTimelineEntryById(sessionId, entry.id, (prev) => ({
              ...prev,
              pending: false,
              exploreStatus: prev.exploreStatus === 'running' ? 'completed' : prev.exploreStatus,
              delegationStatus: (prev as any).delegationStatus === 'running' ? 'completed' : (prev as any).delegationStatus,
            }));
          }
          if (entry.pending && (entry.type === 'edit_file' || entry.type === 'file_stream')) {
            updateTimelineEntryById(sessionId, entry.id, (prev) => ({
              ...prev,
              pending: false,
              editStreaming: false,
              editIsComplete: entry.type === 'edit_file' ? true : prev.editIsComplete,
              success: prev.success ?? false,
              level: prev.success === false ? 'error' : prev.level,
              awaitingApproval: false,
            }));
          }
          // 截图里的"Generating.../生成中..."卡死就是这类 entry 的 pending=true 没被清.
          // 正常链路:LLM 输出结束 → text_complete → handleTextComplete → 清 pending.
          // 但 text_complete / turn_complete 事件有时因为 sequence dedup 或乱序被吞,
          // 导致 pending 永远不清.handleResponseCompleted 被触发 = 响应已完,所有
          // pending assistant 类 entry 都应该 settle, 无论中间信号是否丢.
          if (entry.pending && (
            entry.type === 'assistant_message'
            || entry.type === 'assistant_prefix'
            || entry.type === 'agent_message'
          )) {
            updateTimelineEntryById(sessionId, entry.id, (prev) => ({
              ...prev,
              pending: false,
            }));
          }
          if (entry.pending && entry.type === 'thinking') {
            updateTimelineEntryById(sessionId, entry.id, (prev) => ({
              ...prev,
              pending: false,
            }));
          }
        }
        settleTerminalTimelineState(sessionId);
      }
      const completionText = typeof event.output === 'string' ? event.output.trim() : '';
      const completedAt = event.timestamp || Date.now();
      const target = resolveSlot(sessionId);
      if (target) {
        /* closeSlot 一步: drain pacer (避免 completionText 覆盖打字中尾巴) +
         * phase=closed (幂等) + UI pending=false + (无内容时) completionText 兜底 +
         * (无 timeline entry 时) 补 appendTimelineEntry. */
        closeSlot(sessionId, 'response_completed', { completionText, completedAt });
        dbg('[Stream] Response completed, marked as done:', target.messageId);
      } else if (completionText) {
        /* Fallback: 整轮没有任何 token/text/prealloc — 合成一条 closed slot 承载终态. */
        const fallbackMessageId = createId('assistant');
        const synth: ActiveSlot = {
          sessionId,
          messageId: fallbackMessageId,
          timelineEntryId: `msg-${fallbackMessageId}`,
          phase: 'opening',
          openedAt: completedAt,
          firstChunkRendered: false,
          pacer: { buffer: '', flushed: 0, rafId: null, lastTickTs: 0 },
        };
        slotsRef.current.set(sessionId, synth);
        messageMapRef.current.set(sessionId, fallbackMessageId);
        closeSlot(sessionId, 'response_completed-fallback', { completionText, completedAt });
      }
    }
  }

  /* ============================================================
   *  ActiveSlot reducer transitions — 5 个纯转换函数, 替原 14 处零散
   *  messageMapRef.set/delete + messageCompletedRef.add/delete + paceMapRef
   *  set/delete + drainPaceState/dispatchMessages 散落 mutate.
   *
   *  接口: openSlot / ensureOpenSlot / closeSlot / resolveSlot / appendChunkToSlot
   *  + 内部 drainSlotPacer / flushPacedChars / tickPace / schedulePaceTick.
   * ============================================================ */

  /** 同步 drain pacer 剩余字符. 不动 slot.phase / 不从 slotsRef 删 slot.
   *  仅用于 closeSlot 内 + rotate 前的 cleanup; 外部不应直接调. */
  function drainSlotPacer(slot: ActiveSlot): void {
    const pacer = slot.pacer;
    if (pacer.rafId !== null) {
      try {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(pacer.rafId);
        else clearTimeout(pacer.rafId as unknown as ReturnType<typeof setTimeout>);
      } catch { /* noop */ }
      pacer.rafId = null;
    }
    const pending = pacer.buffer.length - pacer.flushed;
    if (pending > 0) {
      const tail = pacer.buffer.slice(pacer.flushed);
      pacer.flushed = pacer.buffer.length;
      flushPacedChars(slot, tail);
    }
  }

  /** 强制开新 slot. 已存在 (非 closed) slot 会先被 closeSlot('open-new-while-active')
   *  defensively 收尾. messageId 选取顺序: opts.messageId > prealloc (但不复用上轮的旧
   *  id) > createId('assistant'). slotsRef.set 是 atomic 覆盖, 旧 slot 引用立即丢. */
  function openSlot(
    sessionId: string,
    opts: { messageId?: string; sequence?: number } = {},
  ): ActiveSlot {
    const prev = slotsRef.current.get(sessionId);
    if (prev && prev.phase !== 'closed') {
      closeSlot(sessionId, 'open-new-while-active');
    }
    let messageId = opts.messageId;
    if (!messageId) {
      const preallocId = messageMapRef.current.get(sessionId);
      /* prealloc === prev.messageId 时说明 messageMapRef 还残留上轮镜像 — 必须新分配,
       * 否则同一 messageId 会出现两次. */
      if (preallocId && (!prev || preallocId !== prev.messageId)) {
        messageId = preallocId;
      } else {
        messageId = createId('assistant');
      }
    }
    const slot: ActiveSlot = {
      sessionId,
      messageId,
      timelineEntryId: `msg-${messageId}`,
      phase: 'opening',
      sequence: opts.sequence,
      openedAt: Date.now(),
      firstChunkRendered: false,
      pacer: { buffer: '', flushed: 0, rafId: null, lastTickTs: 0 },
    };
    slotsRef.current.set(sessionId, slot);
    messageMapRef.current.set(sessionId, messageId);
    return slot;
  }

  /** 拿当前 streaming slot; 若不存在或已 closed 自动开新 (rotate). */
  function ensureOpenSlot(sessionId: string, opts: { sequence?: number } = {}): ActiveSlot {
    const existing = slotsRef.current.get(sessionId);
    if (existing && existing.phase !== 'closed') return existing;
    return openSlot(sessionId, { sequence: opts.sequence });
  }

  /** 关 slot: drain pacer + 切 phase='closed' + UI pending=false. 幂等.
   *  closed slot 留在 slotsRef, 等下次 ensureOpenSlot rotate 时被新 slot 覆盖 —
   *  保证 closeSlot 后 resolveSlot 仍能拿到同一 messageId 给 handleResponseCompleted
   *  等 reader 用. */
  function closeSlot(
    sessionId: string | null | undefined,
    reason: string,
    options: { completionText?: string; completedAt?: number } = {},
  ): ActiveSlot | null {
    if (!sessionId) return null;
    const slot = slotsRef.current.get(sessionId);
    if (!slot) return null;
    if (slot.phase === 'closed') {
      /* 已 closed 但 caller 提供 completionText — 当 final fallback 补内容 */
      if (options.completionText) {
        const { messageId, timelineEntryId } = slot;
        const completedAt = options.completedAt ?? Date.now();
        dispatchForegroundMessages(sessionId, (prev: ChatMessage[]) => patchMessageById(prev, messageId, (msg) =>
          (!msg.text || msg.text.length === 0)
            ? { ...msg, text: options.completionText!, pending: false }
            : null
        ));
        updateTimelineEntryById(sessionId, timelineEntryId, (prev) => ({
          ...prev,
          detail: (prev.detail && prev.detail.length > 0) ? prev.detail : options.completionText!,
          timestamp: prev.timestamp || completedAt,
        }));
      }
      return slot;
    }
    drainSlotPacer(slot);
    slot.phase = 'closed';
    const { completionText, completedAt = Date.now() } = options;
    const { messageId, timelineEntryId } = slot;
    function stripDsml(t: string): string;
    function stripDsml(t: string | undefined): string | undefined;
    function stripDsml(t: string | undefined): string | undefined {
      if (!t) return t;
      const r = parseDsmlToolCalls(t);
      return (r.calls.length > 0 || r.sawIncomplete) ? r.text : t;
    }
    /* 本轮用量快照 —— 钉在这条消息上, 取完即清, 下一轮从 0 累加。
     * 不快照的话, 翻历史时每条都会显示"最新那一轮"的数字。 */
    const turnSnapshot = turnUsageRef.current.get(sessionId);
    turnUsageRef.current.delete(sessionId);
    const turnFields = turnSnapshot ? {
      turnTokens: turnSnapshot.tokens,
      turnUsage: {
        inputTokens: turnSnapshot.inputTokens,
        outputTokens: turnSnapshot.outputTokens,
        cacheReadTokens: turnSnapshot.cacheReadTokens,
      },
      model: turnSnapshot.model,
      turnTps: (turnSnapshot.genMs > 300 && turnSnapshot.genTokens > 0)
        ? Math.round((turnSnapshot.genTokens / turnSnapshot.genMs) * 1000 * 10) / 10
        : undefined,
    } : {};

    dispatchForegroundMessages(sessionId, (prev: ChatMessage[]) => {
      let found = false;
      const next = prev.map((msg) => {
        if (msg.id !== messageId) return msg;
        found = true;
        return {
          ...msg,
          text: settleStreamText(msg.text, completionText, stripDsml),
          pending: false,
          ...turnFields,
        };
      });
      if (!found && completionText) {
        return [...next, {
          id: messageId,
          role: 'assistant' as const,
          text: stripDsml(completionText)!,
          timestamp: completedAt,
          sequence: slot.sequence,
          pending: false,
          ...turnFields,
        }];
      }
      return next;
    });

    const timeline = timelineMapRef.current.get(sessionId) || [];
    const existingEntry = timeline.find((e) => e.id === timelineEntryId);
    if (existingEntry) {
      updateTimelineEntryById(sessionId, timelineEntryId, (prev) => ({
        ...prev,
        pending: false,
        detail: stripDsml((prev.detail && prev.detail.length > 0)
          ? prev.detail
          : (completionText ?? prev.detail ?? '')) ?? '',
        /* mapTimeline 读的是 timeline entry 不是 ChatMessage —— 两边都要带上,
           否则 footer 永远拿不到本轮用量 (DSML 的剥离同理, 漏一边就有一边还是乱码) */
        ...turnFields,
      }));
    } else if (completionText) {
      appendTimelineEntry(sessionId, {
        id: timelineEntryId,
        type: 'assistant_message' as const,
        title: 'Assistant',
        detail: stripDsml(completionText)!,
        timestamp: completedAt,
        sequence: slot.sequence,
        pending: false,
        ...turnFields,
        messageId,
      }, true);
    }

    dbg(`[Stream] Closed slot (${reason}):`, messageId);
    return slot;
  }

  function getTimelineEntryVisibleText(entry?: TimelineEntry): string {
    if (!entry) return '';
    const parts = [entry.detail, entry.content].filter((value): value is string =>
      typeof value === 'string' && value.length > 0
    );
    return parts.join('').trim();
  }

  function closeEmptyAssistantSlotOnError(sessionId: string | null | undefined, reason: string): void {
    if (!sessionId) return;
    const slot = slotsRef.current.get(sessionId);
    const preallocMessageId = messageMapRef.current.get(sessionId);
    const messageId = slot?.messageId || preallocMessageId;
    if (!messageId) return;

    if (slot && slot.phase !== 'closed') {
      closeSlot(sessionId, reason);
    }

    const latestSlot = slotsRef.current.get(sessionId);
    const timelineEntryId = latestSlot?.timelineEntryId || `msg-${messageId}`;
    const timeline = timelineMapRef.current.get(sessionId) || [];
    const entry = timeline.find((item) =>
      item.id === timelineEntryId ||
      (item.type === 'assistant_message' && item.messageId === messageId)
    );

    const hasTimelineText = getTimelineEntryVisibleText(entry).length > 0;
    const hasBufferedText = (latestSlot?.pacer.buffer || '').trim().length > 0;
    if (hasTimelineText || hasBufferedText) return;

    dispatchForegroundMessages(sessionId, (prev: ChatMessage[]) => {
      let changed = false;
      const next = prev.filter((msg) => {
        if (msg.id !== messageId || msg.role !== 'assistant') return true;
        if ((msg.text || '').trim().length > 0) return true;
        changed = true;
        return false;
      });
      return changed ? next : prev;
    });

    if (entry?.type === 'assistant_message') {
      if (deleteTimelineEntry) {
        void deleteTimelineEntry(sessionId, entry.id);
      } else {
        updateTimelineEntryById(sessionId, entry.id, (prev) => ({
          ...prev,
          pending: false,
          hidden: true,
        } as any), true);
      }
    }

    if (slotsRef.current.get(sessionId)?.messageId === messageId) {
      slotsRef.current.delete(sessionId);
    }
    if (messageMapRef.current.get(sessionId) === messageId) {
      messageMapRef.current.delete(sessionId);
    }
  }

  /** 找当前/最近 slot 给 reader 用. closeSlot 不删 slot, 所以 closed slot 仍可解析.
   *  无 slot 时尝试: 1) prealloc inbox (messageMapRef 残留) 2) timeline 反查最近
   *  assistant_message. 反查命中会就地合成 closed slot 给后续操作复用. */
  function resolveSlot(sessionId: string): { messageId: string; timelineEntryId: string } | null {
    const slot = slotsRef.current.get(sessionId);
    if (slot) return { messageId: slot.messageId, timelineEntryId: slot.timelineEntryId };

    const preallocId = messageMapRef.current.get(sessionId);
    if (preallocId) {
      const synth: ActiveSlot = {
        sessionId,
        messageId: preallocId,
        timelineEntryId: `msg-${preallocId}`,
        phase: 'closed',
        openedAt: Date.now(),
        firstChunkRendered: false,
        pacer: { buffer: '', flushed: 0, rafId: null, lastTickTs: 0 },
      };
      slotsRef.current.set(sessionId, synth);
      return { messageId: preallocId, timelineEntryId: synth.timelineEntryId };
    }

    const timeline = timelineMapRef.current.get(sessionId) || [];
    const recent = [...timeline].reverse().find(
      (entry) => entry.type === 'assistant_message' && entry.messageId,
    );
    if (recent?.messageId) {
      const synth: ActiveSlot = {
        sessionId,
        messageId: recent.messageId,
        timelineEntryId: recent.id,
        phase: 'closed',
        openedAt: typeof recent.timestamp === 'number' ? recent.timestamp : Date.now(),
        firstChunkRendered: true,
        pacer: { buffer: '', flushed: 0, rafId: null, lastTickTs: 0 },
      };
      slotsRef.current.set(sessionId, synth);
      messageMapRef.current.set(sessionId, recent.messageId);
      return { messageId: recent.messageId, timelineEntryId: recent.id };
    }
    return null;
  }

  /** 把 chunk 追加进 slot. 自动 rotate (旧 slot closed 时开新) + 首 chunk 渲染
   *  空 message + timeline pending 占位. */
  function appendChunkToSlot(sessionId: string, chunk: string, sequence?: number): ActiveSlot {
    const slot = ensureOpenSlot(sessionId, { sequence });
    /* 这条气泡已被"停止"定格 → 中断残留的字不再往上画 (见 subscribeStreamFreeze)。
     * 新一轮开的是另一条气泡, id 不同, 不受影响。 */
    if (sealedEntryRef.current.get(sessionId) === slot.timelineEntryId) return slot;
    if (!slot.firstChunkRendered) {
      const ts = Date.now();
      dispatchForegroundMessages(sessionId, (prev: ChatMessage[]) => {
        if (prev.find((m) => m.id === slot.messageId)) return prev;
        return [...prev, {
          id: slot.messageId,
          role: 'assistant' as const,
          text: '',
          timestamp: ts,
          sequence,
          pending: true,
        }];
      });
      const timeline = timelineMapRef.current.get(sessionId) || [];
      if (!timeline.find((e) => e.id === slot.timelineEntryId)) {
        appendTimelineEntry(sessionId, {
          id: slot.timelineEntryId,
          type: 'assistant_message' as const,
          title: 'Assistant',
          detail: '',
          timestamp: ts,
          sequence,
          pending: true,
          messageId: slot.messageId,
        }, true);
      }
      slot.firstChunkRendered = true;
    }
    slot.phase = 'streaming';
    slot.pacer.buffer += chunk;
    schedulePaceTick(slot);
    return slot;
  }

  /* —— pacer 内部: 把已 paint 的字符 paint 到 React state ——
   *   一次 setState 同时更新 messages + timeline, 跟原有逻辑一致, 只是
   *   触发节奏由 rAF tick 决定而不是 provider chunk 决定. */
  function flushPacedChars(slot: ActiveSlot, chars: string) {
    if (!chars) return;
    const { sessionId, timelineEntryId } = slot;
    updateTimelineEntryById(sessionId, timelineEntryId, (prev) => ({
      ...prev,
      detail: (prev.detail || '') + chars,
    }));
    scheduleScrollToBottom();
  }

  /* —— rAF tick: 每帧根据 pending 长度决定释放多少字符 —— */
  function tickPace(slot: ActiveSlot) {
    /* 防护: slot 已被 rotate 出 slotsRef → 旧 closure 跑过来要丢弃这帧, 不能写 stale slot.
     *   drainSlotPacer 会 cancel rafId, 正常路径下 stale rAF 不会触发; 这里是双保险. */
    if (slotsRef.current.get(slot.sessionId) !== slot) return;
    slot.pacer.rafId = null;

    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const dt = slot.pacer.lastTickTs > 0 ? Math.min(50, now - slot.pacer.lastTickTs) : 16;
    slot.pacer.lastTickTs = now;

    const pending = slot.pacer.buffer.length - slot.pacer.flushed;
    if (pending <= 0) return;

    let release: number;
    if (pending > PACE_INSTANT_THRESHOLD) {
      release = pending;
    } else {
      const cps = Math.min(
        PACE_MAX_CPS,
        PACE_BASE_CPS + Math.floor(pending / PACE_CATCHUP_BIN) * PACE_CATCHUP_STEP
      );
      release = Math.max(1, Math.min(pending, Math.ceil((cps * dt) / 1000)));
    }

    const chars = slot.pacer.buffer.slice(slot.pacer.flushed, slot.pacer.flushed + release);
    slot.pacer.flushed += release;
    flushPacedChars(slot, chars);

    if (slot.pacer.flushed < slot.pacer.buffer.length) {
      schedulePaceTick(slot);
    }
  }

  function schedulePaceTick(slot: ActiveSlot) {
    if (slot.pacer.rafId !== null) return;
    if (typeof requestAnimationFrame === 'function') {
      slot.pacer.rafId = requestAnimationFrame(() => tickPace(slot));
    } else {
      slot.pacer.rafId = setTimeout(() => tickPace(slot), 16) as unknown as number;
    }
  }

  /** appendAssistantTextChunk — 流事件外部入口 (handleTextDelta 之类的 caller).
   *  保留原 signature, 内部全走 reducer. */
  function appendAssistantTextChunk(sessionId: string | null, chunk: string, sequence?: number) {
    if (!sessionId) {
      console.warn('[Stream] Text/token event without sessionId');
      return;
    }
    if (!chunk) return;
    appendChunkToSlot(sessionId, chunk, sequence);
    /* token 计数器跟 provider 节奏走 (用户看 badge 期望"实时" tokens/sec).
     * 实际可见文字由 pacer 决定. */
    updateStreamingTokens(sessionId, chunk);
  }

  function handleDirectContextCompaction(event: any) {
    const sessionId = event.sessionId || activeSessionIdRef.current;
    const status = event.status;
    const compression = event.compression;

    if (status === 'started') {
      const fmtK = (n: unknown) =>
        typeof n === 'number' && Number.isFinite(n) && n > 0
          ? `${(n / 1000).toFixed(1)}K`
          : null;
      const origK = fmtK(event.originalTokens);
      const budgetK = fmtK(event.budgetTokens);
      ensurePendingCompactionEntry({
        sessionId,
        title: bi('📦 正在压缩上下文…', '📦 Compressing Context...'),
        detail: origK
          ? (budgetK ? `${origK} tokens → budget ${budgetK}` : `${origK} tokens`)
          : compactionRunningLabel(),
        timestamp: event.timestamp || Date.now(),
        status: 'started',
        originalTokens: event.originalTokens,
        budgetTokens: event.budgetTokens,
      });
      dispatchStatus('Compressing context...', sessionId);
      scrollToBottom();
    } else if (status === 'compressing' && compression) {
      const timeline = timelineMapRef.current.get(sessionId) || [];
      const pendingEntry = [...timeline].reverse().find(
        (e: any) => e.type === 'context_compaction' && e.pending
      );
      if (pendingEntry) {
        const bucketLines = compression.buckets
          ?.filter((b: any) => b.status !== 'empty')
          .map((b: any) => {
            const icon = b.status === 'done' ? '✓' : b.status === 'compressing' ? '●' : '○';
            const items = b.items?.slice(0, 3).join(', ') || '';
            return `${icon} ${b.label} (${b.messageCount})${items ? ': ' + items : ''}`;
          })
          .join('\n') || '';
        const pct = typeof compression.percent === 'number' ? Math.round(compression.percent) : null;
        updateTimelineEntryById(sessionId, pendingEntry.id, {
          title: pct !== null
            ? bi(`📦 压缩中 ${pct}%…`, `📦 Compressing ${pct}%...`)
            : bi(`📦 压缩中 ${compression.completedBuckets}/${compression.totalBuckets}…`, `📦 Compressing ${compression.completedBuckets}/${compression.totalBuckets}...`),
          detail: bucketLines,
          compactionStatus: 'compressing',
          compressionBuckets: compression.buckets,
          compressionTotalBuckets: pct !== null ? 100 : compression.totalBuckets,
          compressionCompletedBuckets: pct !== null ? pct : compression.completedBuckets,
          compressionSummaryModel: compression.summaryModel,
        });
        dispatchStatus(`Compressing ${compression.completedBuckets}/${compression.totalBuckets} (${compression.summaryModel})`, sessionId);
      }
    } else if (status === 'completed') {
      handleContextCompaction({ ...event, data: event });
    } else if (status === 'skipped') {
      const timeline = timelineMapRef.current.get(sessionId) || [];
      const pendingEntry = [...timeline].reverse().find(
        (e: any) => e.type === 'context_compaction' && e.pending
      );
      if (pendingEntry) {
        if (deleteTimelineEntry) {
          void deleteTimelineEntry(sessionId, pendingEntry.id);
        } else {
          /* 没有删除能力时退而求其次: 至少清 pending 并如实标注, 绝不显示"已压缩/saved" */
          const zh = getGlobalLanguage().startsWith('zh');
          updateTimelineEntryById(sessionId, pendingEntry.id, {
            pending: false,
            compactionStatus: 'skipped',
            title: zh ? '上下文压缩已跳过' : 'Context compaction skipped',
            detail: zh ? '已保留原上下文' : 'Original context kept',
          }, true);
        }
      }
    }
  }

  function handleTargetContinuation(event: any) {
    const data = event?.data ?? event ?? {};
    const sessionId = event.sessionId || activeSessionIdRef.current;
    if (!sessionId) return;
    const iteration = typeof data.iteration === 'number' ? data.iteration : undefined;
    const consecutiveBlocks = typeof data.consecutive_blocks === 'number'
      ? data.consecutive_blocks
      : (typeof data.consecutiveBlocks === 'number' ? data.consecutiveBlocks : undefined);
    const isZh = getGlobalLanguage().startsWith('zh');
    const kind = data.kind === 'verify' || data.kind === 'team_spec' || data.kind === 'unfinished' || data.kind === 'plan'
      ? data.kind
      : 'target';
    const title = kind === 'verify'
      ? (isZh ? '改完还没验证 · 先跑测试' : 'Changed but unverified · run tests first')
      : kind === 'plan'
      ? (isZh ? '计划还没做完 · 继续' : 'Plan unfinished · continuing')
      : kind === 'unfinished'
        ? (isZh ? '说了下一步但停了 · 继续' : 'Stopped after announcing a step · continuing')
        : (isZh ? 'Target 未完成 · 继续推进' : 'Target still open · continuing');
    appendTimelineEntry(sessionId, {
      id: createId('target-continue'),
      type: 'target_continuation',
      title,
      timestamp: Date.now(),
      pending: false,
      targetContinueIteration: iteration,
      targetContinueConsecutiveBlocks: consecutiveBlocks,
      targetContinueKind: kind,
    });
    scrollToBottom();
  }

  function handleContextCompaction(event: any) {
    const compactionData = event.data;
    const sessionId = event.sessionId || activeSessionIdRef.current;

    if (!compactionData || compactionData.originalTokens == null || compactionData.finalTokens == null) {
      return;
    }

    if (compactionData.status && compactionData.status !== 'completed') {
      return;
    }

    const method = compactionData.useLLM ? 'LLM Summary' : 'Smart Trim';
    const originalK = (compactionData.originalTokens / 1000).toFixed(1);
    const finalK = (compactionData.finalTokens / 1000).toFixed(1);
    const savedK = ((compactionData.originalTokens - compactionData.finalTokens) / 1000).toFixed(1);
    dispatchStatus(`Context ${method}: ${originalK}K → ${finalK}K (saved ${savedK}K)`, sessionId);

    const compression = compactionData.compression;
    const bucketSummary = compression?.buckets
      ?.filter((b: any) => b.status === 'done')
      .map((b: any) => `${b.label}: ${b.messageCount} msgs`)
      .join(', ');

    const completedData = {
      pending: false,
      title: bi(`📦 上下文已压缩 (${method})`, `📦 Context Compacted (${method})`),
      detail: bucketSummary
        ? `${originalK}K → ${finalK}K, saved ${savedK}K tokens | ${bucketSummary}`
        : `${originalK}K → ${finalK}K, saved ${savedK}K tokens`,
      compactionStatus: compactionData.status || 'completed',
      compactionOriginalMessages: compactionData.originalMessages,
      compactionKeptMessages: compactionData.keptMessages,
      compactionDroppedMessages: compactionData.droppedMessages,
      compactionCompressedMessages: compactionData.compressedMessages,
      compactionOriginalTokens: compactionData.originalTokens,
      compactionFinalTokens: compactionData.finalTokens,
      compactionBudgetTokens: compactionData.budgetTokens,
      compactionUseLLM: compactionData.useLLM,
      compressionBuckets: compression?.buckets,
      compressionTotalBuckets: compression?.totalBuckets,
      compressionCompletedBuckets: compression?.completedBuckets,
      compressionSummaryModel: compression?.summaryModel,
    };

    const timeline = timelineMapRef.current.get(sessionId) || [];
    const pendingCompaction = [...timeline].reverse().find(
      (e: any) => e.type === 'context_compaction' && e.pending
    );

    if (pendingCompaction) {
      updateTimelineEntryById(sessionId, pendingCompaction.id, completedData, true);
    } else {
      // 兜底：如果没有 pending 卡片，创建新的
      appendTimelineEntry(sessionId, {
        id: createId('compaction'),
        type: 'context_compaction',
        timestamp: event.timestamp || Date.now(),
        ...completedData,
      }, true);
    }

    const finalTokens = compactionData.finalTokens;
    if (typeof finalTokens === 'number' && finalTokens >= 0
        && (compactionData.status === 'completed' || compactionData.status == null)) {
      /* contextUsed / latestRequestUsage 是**当前活跃会话**的单值: 压完的若是已经切走的会话
       * (大会话压缩要几分钟, 期间用户新建了会话), 写进去就是新会话显示旧会话的上下文。
       * 快照 Map 按 sessionId 存, 照常写。 */
      const isActive = sessionId === activeSessionIdRef.current;
      if (isActive) dispatchContextUsed(finalTokens);
      const prevSnap = getContextSnapshot(sessionId);
      const resetUsage = {
        ...(prevSnap?.latestRequestUsage ?? {}),
        totalTokens: finalTokens,
        inputTokens: finalTokens,
      } as any;
      if (isActive) setLatestRequestUsage(resetUsage);
      setContextSnapshot({
        tokensUsed: finalTokens,
        contextWindow: prevSnap?.contextWindow || 0,
        breakdown: prevSnap?.breakdown,
        latestRequestUsage: resetUsage,
        sessionCache: prevSnap?.sessionCache,
        sessionId: sessionId || prevSnap?.sessionId,
        updatedAt: Date.now(),
      });
    }

    scrollToBottom();
  }

  // ==================== Network 模式事件处理 ====================

  function handleNetworkTaskAnalysis(event: any) {
    const sessionId = event.sessionId || activeSessionIdRef.current;
    appendTimelineEntry(sessionId, {
      id: createId('network-task-analysis'),
      type: 'network_task_analysis',
      title: bi('🔍 任务分析', '🔍 Task analysis'),
      detail: event.taskDescription || '',
      timestamp: event.timestamp || Date.now(),
      taskAnalysisDescription: event.taskDescription,
      taskAnalysisComplexity: event.complexity,
      taskAnalysisEstimatedAgents: event.estimatedAgents,
      taskAnalysisSuggestedMode: event.suggestedMode,
    });
    scrollToBottom();
  }

  function handleNetworkModeSelect(event: any) {
    const sessionId = event.sessionId || activeSessionIdRef.current;
    const modeNames: Record<string, string> = {
      'simple': 'Simple 模式',
      'pipeline': 'Pipeline 模式',
      'network': 'Network 模式',
      'direct': '直接执行',
    };
    appendTimelineEntry(sessionId, {
      id: createId('network-mode-select'),
      type: 'network_mode_select',
      title: `${modeNames[event.selectedMode] || event.selectedMode}`,
      detail: event.reason || '',
      timestamp: event.timestamp || Date.now(),
      modeSelectMode: event.selectedMode,
      modeSelectReason: event.reason,
      modeSelectAgentCount: event.agentCount,
    });
    scrollToBottom();
  }

  function handleNetworkAgentExecution(event: any) {
    const sessionId = event.sessionId || activeSessionIdRef.current;
    const statusIcons: Record<string, string> = {
      'pending': '⏳',
      'running': '▶️',
      'completed': '✅',
      'failed': '❌',
    };
    const icon = statusIcons[event.status] || '🤖';

    appendTimelineEntry(sessionId, {
      id: createId('network-agent-execution'),
      type: 'network_agent_execution',
      title: `${icon} Agent: ${event.agentName || event.agentId}`,
      detail: event.nodeName || event.output || '',
      timestamp: event.timestamp || Date.now(),
      agentExecutionAgentId: event.agentId,
      agentExecutionAgentName: event.agentName,
      agentExecutionNodeId: event.nodeId,
      agentExecutionNodeName: event.nodeName,
      agentExecutionStatus: event.status,
      agentExecutionOutput: event.output,
      agentExecutionError: event.error,
      duration: event.duration,
    });
    scrollToBottom();
  }

  function handleNetworkBidding(event: any) {
    const sessionId = event.sessionId || activeSessionIdRef.current;
    appendTimelineEntry(sessionId, {
      id: createId('network-bidding'),
      type: 'network_bidding',
      title: bi('🎯 竞标完成', '🎯 Bidding complete'),
      detail: `共 ${event.networkTotalBids || 0} 个竞标`,
      timestamp: event.timestamp || Date.now(),
      networkTaskId: event.networkTaskId,
      networkTotalBids: event.networkTotalBids,
      networkSelectedAgents: event.networkSelectedAgents,
      networkTopBid: event.networkTopBid,
    });
    scrollToBottom();
  }

  function handleNetworkAgentBid(event: any) {
    const sessionId = event.sessionId || activeSessionIdRef.current;
    const icon = event.networkParticipate ? '✋' : '🚫';
    appendTimelineEntry(sessionId, {
      id: createId('network-agent-bid'),
      type: 'network_agent_bid',
      title: `${icon} ${event.networkAgentName || event.networkAgentId}`,
      detail: event.networkReason || '',
      timestamp: event.timestamp || Date.now(),
      networkAgentId: event.networkAgentId,
      networkAgentName: event.networkAgentName,
      networkParticipate: event.networkParticipate,
      networkReason: event.networkReason,
      networkCapabilityScore: event.networkCapabilityScore,
      networkConfidence: event.networkConfidence,
    });
    scrollToBottom();
  }

  function handleNetworkNegotiation(event: any) {
    const sessionId = event.sessionId || activeSessionIdRef.current;
    const statusIcons: Record<string, string> = {
      'started': '🤝',
      'voting': '🗳️',
      'consensus': '✅',
      'failed': '❌',
    };
    const icon = statusIcons[event.networkNegotiationStatus] || '💬';
    appendTimelineEntry(sessionId, {
      id: createId('network-negotiation'),
      type: 'network_negotiation',
      title: `${icon} 协商: ${event.networkNegotiationStatus}`,
      detail: `参与者: ${(event.networkParticipants || []).join(', ')}`,
      timestamp: event.timestamp || Date.now(),
      networkNegotiationId: event.networkNegotiationId,
      networkParticipants: event.networkParticipants,
      networkNegotiationStatus: event.networkNegotiationStatus,
      networkRounds: event.networkRounds,
    });
    scrollToBottom();
  }

  function handleNetworkDAGTopology(event: any) {
    const sessionId = event.sessionId || activeSessionIdRef.current;
    const nodeCount = (event.networkDagNodes || []).length;
    appendTimelineEntry(sessionId, {
      id: createId('network-dag-topology'),
      type: 'network_dag_topology',
      title: bi(`📊 DAG 拓扑 (${nodeCount} 节点)`, `📊 DAG topology (${nodeCount} nodes)`),
      detail: '',
      timestamp: event.timestamp || Date.now(),
      networkDagId: event.networkDagId,
      networkDagNodes: event.networkDagNodes,
      networkLevelCount: event.networkLevelCount,
      networkCriticalPath: event.networkCriticalPath,
    });
    scrollToBottom();
  }

  function handleNetworkReplan(event: any) {
    const sessionId = event.sessionId || activeSessionIdRef.current;
    appendTimelineEntry(sessionId, {
      id: createId('network-replan'),
      type: 'network_replan',
      title: bi('🔄 重规划', '🔄 Replanning'),
      detail: event.networkReplanReason || '',
      timestamp: event.timestamp || Date.now(),
      networkReplanReason: event.networkReplanReason,
      networkNewNodeCount: event.networkNewNodeCount,
    });
    scrollToBottom();
  }

  function handleAgentMessage(event: any) {
    const sessionId = event.sessionId || activeSessionIdRef.current;
    const statusIcons: Record<string, string> = {
      'idle': '○',
      'running': '⚡',
      'waiting': '⏳',
      'completed': '✓',
      'error': '✗',
    };
    const icon = statusIcons[event.status] || '🤖';
    const agentLabel = (typeof event.roleName === 'string' && event.roleName.trim())
      ? event.roleName.trim()
      : `Agent-${event.agentIndex ?? 0}`;
    appendTimelineEntry(sessionId, {
      id: createId('agent-message'),
      type: 'agent_message',
      title: `${icon} ${agentLabel}`,
      detail: event.message || event.task || '',
      timestamp: event.timestamp || Date.now(),
      agentId: event.agentId,
      agentIndex: event.agentIndex,
      agentStatus: event.status,
      roleId: event.roleId,
      roleName: event.roleName,
      roleColor: event.roleColor,
      agentModel: event.model,
    });
    scrollToBottom();
  }

  function settleSubAgentFinished(event: any): void {
    const agentId = typeof event.agentId === 'string' ? event.agentId : '';
    if (!agentId) return;
    const failed = event.action === 'aborted' || event.status === 'failed' || event.status === 'aborted';
    const childSid = agentId;
    const childTimeline = timelineMapRef.current.get(childSid) || [];
    for (const entry of childTimeline) {
      const e = entry as any;
      const stillLive = entry.pending === true || e.streaming === true || e.editStreaming === true
        || e.commandStatus === 'running' || e.delegationStatus === 'running' || e.exploreStatus === 'running';
      if (!stillLive) continue;
      updateTimelineEntryById(childSid, entry.id, (prev: any) => ({
        ...prev,
        pending: false,
        streaming: undefined,
        editStreaming: false,
        commandStatus: prev.commandStatus === 'running' ? (failed ? 'error' : 'completed') : prev.commandStatus,
        exploreStatus: prev.exploreStatus === 'running' ? (failed ? 'error' : 'completed') : prev.exploreStatus,
        delegationStatus: prev.delegationStatus === 'running' ? (failed ? 'error' : 'completed') : prev.delegationStatus,
        ...(prev.type === 'tool_call' ? { type: failed ? 'tool_error' : 'tool_result', success: !failed } : {}),
      }));
    }
    dispatchStreaming(false, childSid);

    const delId = `delegation-${agentId}`;
    for (const [sid, entries] of timelineMapRef.current.entries()) {
      if (!entries.some((e) => e.id === delId)) continue;
      updateTimelineEntryById(sid, delId, (prev: any) => ({
        ...prev,
        pending: false,
        delegationStatus: prev.delegationStatus === 'running'
          ? (failed ? 'error' : 'completed')
          : prev.delegationStatus,
        delegationToolRecords: prev.delegationToolRecords?.map((record: any) =>
          record.status === 'running'
            ? { ...record, status: failed ? 'error' : 'done' }
            : record
        ),
      }));
    }
  }

  function handleWorkerStart(event: any) {
    dbg('[Stream] 🟢 handleWorkerStart CALLED:', event.type, event.agentId, event.groupMembers?.length, 'sessionId:', event.sessionId);
    const sessionId = event.sessionId || activeSessionIdRef.current;
    if (!sessionId) { console.warn('[Stream] handleWorkerStart: NO sessionId!'); return; }
    const eventTimestamp = event.timestamp || Date.now();
    const agentId = event.agentId || 'worker';
    /* 点进子会话后 sessionId === agentId: 这是"我自己开始干活", 不是又派了一个下级。
     * 画 Code Agent 派发卡会在子线程顶上多一张母卡 (用户红框圈过). */
    if (agentId === sessionId) return;
    closeCurrentAssistantMessage(sessionId, 'worker_start');
    const isExplore = agentId.toLowerCase().includes('explore') ||
      (event.task || '').toLowerCase().includes('explore');
    /* isAgent 判定: 老逻辑只认 agentId.startsWith('agent-') 或 role/workerRole==='Agent',
     * 用户自定义名 (smoke-plan / reader / xxx) 全部 miss → 误归 explore 卡.
     * 现在 agentTool 在所有 worker 事件上加 isAgentTool: true 标志, 这一条最权威. */
    const isAgent = event.isAgentTool === true
      || agentId.toLowerCase().startsWith('agent-')
      || event.role === 'Agent' || event.workerRole === 'Agent';

    // Agent 工具派遣 → 使用 agent_delegation 卡片
    if (isAgent) {
      const rawRole = (typeof event.role === 'string' && event.role) ? event.role : '';
      const capitalized = rawRole ? rawRole.charAt(0).toUpperCase() + rawRole.slice(1) : '';
      const roleName = capitalized ? `${capitalized} Agent` : (event.isBackground ? 'Background Agent' : 'Agent');

      const researchParentId = researchEntryRef.current.get(sessionId);
      const looksResearch = rawRole.toLowerCase() === 'research' || /^\s*调研\s*[:：]/.test(event.task || '');
      if (researchParentId && looksResearch) {
        taskAgentBatchMapRef.current.set(agentId, researchParentId);
        updateTimelineEntryById(sessionId, researchParentId, (prev: any) => ({
          ...prev,
          ...bindResearchWorker(prev, agentId, event.task || ''),
        }));
        scrollToBottom();
        return;
      }

      const delegationEntryId = `delegation-${agentId}`;
      const existing = (timelineMapRef.current.get(sessionId) || []).find((e: any) => e.id === delegationEntryId);
      /* worker_complete 先到 / 晚到的 start 都不能把已完成的卡打回转圈. */
      if (existing && (existing as any).delegationStatus && (existing as any).delegationStatus !== 'running') {
        return;
      }
      appendTimelineEntry(sessionId, {
        id: `delegation-${agentId}`,
        type: 'agent_delegation',
        title: `${roleName}: ${(event.task || '').substring(0, 60)}`,
        timestamp: eventTimestamp,
        pending: true,
        delegationAgentId: agentId,
        delegationTask: event.task || '',
        delegationRole: rawRole || 'agent',
        delegationRoleName: roleName,
        delegationModel: event.model || undefined,
        /* 换了模型才 false —— 折叠行标题据此写「交给 xx」(指挥模式), 跟主力同款不写 */
        delegationModelInherited: (event as { modelInherited?: boolean }).modelInherited,
        delegationStatus: 'running',
        delegationToolCount: 0,
        delegationToolRecords: [],
        duration: 0,
        /* 后台 agent 标志, mapTimeline → DelegationView 用它显示 "后台运行" badge,
         * 让用户清楚主对话结束后 agent 还在后台跑, 不会以为对话已经收尾. */
        delegationIsBackground: event.isBackground === true,
      } as any, true);
      scrollToBottom();
      return;
    }

    const role = isExplore ? 'Explore' : 'Task';

    appendTimelineEntry(sessionId, {
      id: `explore-${agentId}`,
      type: 'explore_status',
      title: `${role}: ${(event.task || '').substring(0, 60)}`,
      timestamp: eventTimestamp,
      pending: true,
      exploreRole: role,
      exploreTask: event.task || '',
      exploreStatus: 'running',
      exploreToolCount: 0,
      exploreTokens: 0,
      exploreElapsed: 0,
      exploreGroupMembers: event.groupMembers?.map((m: ExploreGroupMember) => ({
        ...m, startedAt: m.startedAt ?? event.timestamp ?? Date.now(),
      })),
    }, true);

    if (event.groupMembers) {
      const batchEntryId = `explore-${agentId}`;
      for (const member of event.groupMembers) {
        taskAgentBatchMapRef.current.set(member.agentId, batchEntryId);
      }
    }
    scrollToBottom();
  }

  function handleWorkerEvent(event: any) {
    dbg('[Stream] handleWorkerEvent:', event.eventType, event.data, 'agentId:', event.agentId);
    const sessionId = event.sessionId || activeSessionIdRef.current;
    if (!sessionId) return;
    const agentId = event.agentId || 'worker';
    if (agentId === sessionId) return;

    if (event.eventType === 'explore_progress' && event.data) {
      const entryId = taskAgentBatchMapRef.current.get(agentId) || `explore-${agentId}`;
      updateTimelineEntryById(sessionId, entryId, (prev: any) => ({
        ...prev, ...applyExploreProgress(prev, agentId, event.data),
      }));
      return;
    }

    // Agent 工具的中间事件 → 更新 delegation 卡片的 toolCount + toolRecords.
    // isAgentTool 是 agentTool 上加的明确标志位, 自定义名 agent (reader/smoke-plan)
    const isAgent = event.isAgentTool === true
      || agentId.toLowerCase().startsWith('agent-')
      || event.workerRole === 'Agent';
    if (isAgent && event.eventType === 'tool_progress') {
      const delegationEntryId = `delegation-${agentId}`;
      updateTimelineEntryById(sessionId, delegationEntryId, (prev: any) => {
        // 构建新的 tool record
        const records = [...(prev.delegationToolRecords || [])];
        // 如果有 toolName 信息，添加新记录
        if (event.data?.toolName || event.toolName) {
          const toolName = event.data?.toolName || event.toolName || 'tool';
          const toolArgs = event.data?.toolArgs || event.toolArgs || '';
          records.push({
            name: toolName,
            args: typeof toolArgs === 'string' ? toolArgs : JSON.stringify(toolArgs),
            status: 'running' as const,
            timestamp: Date.now(),
          });
          // 标记之前的 running 记录为 done
          for (let i = 0; i < records.length - 1; i++) {
            if (records[i].status === 'running') {
              records[i] = { ...records[i], status: 'done' as const };
            }
          }
        }
        return {
          ...prev,
          delegationToolCount: (prev.delegationToolCount || 0) + 1,
          delegationToolRecords: records,
        };
      });
      return;
    }

    const entryId = `explore-${agentId}`;

    if (event.eventType === 'member_complete' && event.data) {
      const { memberId, status, elapsed } = event.data;
      updateTimelineEntryById(sessionId, entryId, (prev: any) => {
        const members = [...(prev.exploreGroupMembers || [])];
        const idx = members.findIndex((m: any) => m.agentId === memberId);
        if (idx >= 0) {
          members[idx] = { ...members[idx], status, elapsed: elapsed || 0 };
        }
        const allDone = members.length > 0 && members.every(
          (m: any) => m.status === 'completed' || m.status === 'error'
        );
        if (allDone) {
          const allSuccess = members.every((m: any) => m.status === 'completed');
          return {
            ...prev,
            exploreGroupMembers: members,
            exploreStatus: allSuccess ? 'completed' : 'error',
            pending: false,
          };
        }
        return { ...prev, exploreGroupMembers: members };
      });
    }
  }

  function handleWorkerComplete(event: any) {
    dbg('[Stream] 🔴 handleWorkerComplete:', {
      agentId: event.agentId,
      success: event.success,
      duration: event.duration,
      summary: event.summary?.substring(0, 100),
    });
    const sessionId = event.sessionId || activeSessionIdRef.current;
    if (!sessionId) return;
    const agentId = event.agentId || 'worker';
    if (agentId === sessionId) return;
    const status = event.success ? 'completed' : 'error';
    const durationMs = event.duration || 0;

    // Agent 工具派遣 → 更新 agent_delegation 卡片
    const isAgent = event.isAgentTool === true
      || agentId.toLowerCase().startsWith('agent-')
      || event.role === 'Agent' || event.workerRole === 'Agent';
    if (isAgent) {
      const researchParentId = researchEntryRef.current.get(sessionId);
      if (researchParentId && taskAgentBatchMapRef.current.get(agentId) === researchParentId) {
        updateTimelineEntryById(sessionId, researchParentId, (prev: any) => ({
          ...prev,
          ...markResearchWorkerDone(prev, agentId, status === 'completed', event.summary, event.toolCount),
        }));
        scrollToBottom();
        return;
      }

      const delegationEntryId = `delegation-${agentId}`;
      const timeline = timelineMapRef.current.get(sessionId) || [];
      const existingEntry = timeline.find((e: any) => e.id === delegationEntryId);
      if (existingEntry) {
        updateTimelineEntryById(sessionId, delegationEntryId, (prev: any) => ({
          ...prev,
          pending: false,
          delegationStatus: status,
          delegationSummary: event.summary,
          delegationError: event.error,
          delegationToolCount: event.toolCount || 0,
          delegationToolRecords: prev.delegationToolRecords?.map((record: any) =>
            record.status === 'running'
              ? { ...record, status: event.success ? 'done' : 'error' }
              : record
          ),
          duration: event.duration || 0,
        }));
      } else {
        appendTimelineEntry(sessionId, {
          id: delegationEntryId,
          type: 'agent_delegation',
          title: `Agent: ${event.summary || agentId}`,
          timestamp: event.timestamp || Date.now(),
          pending: false,
          delegationAgentId: agentId,
          delegationTask: event.summary || agentId,
          delegationRole: 'Agent',
          delegationStatus: status,
          delegationSummary: event.summary,
          delegationError: event.error,
          delegationToolCount: event.toolCount || 0,
          duration: event.duration || 0,
        });
      }
      scrollToBottom();
      return;
    }

    // Explore / Task → 更新 explore_status 卡片
    const entryId = `explore-${agentId}`;
    const timeline = timelineMapRef.current.get(sessionId) || [];
    const existingEntry = timeline.find((e: any) => e.id === entryId);

    if (existingEntry) {
      updateTimelineEntryById(sessionId, entryId, (prev: any) => {
        // 防止 member_complete 事件丢失导致成员状态卡在 running
        const members = prev.exploreGroupMembers ? [...prev.exploreGroupMembers] : undefined;
        if (members) {
          for (let i = 0; i < members.length; i++) {
            if (members[i].status === 'running') {
              members[i] = { ...members[i], status };
            }
          }
        }
        return {
          ...prev,
          pending: false,
          exploreStatus: status,
          exploreElapsed: durationMs,
          exploreSummary: event.summary,
          exploreError: event.error,
          exploreToolRecords: prev.exploreToolRecords?.map((record: any) =>
            record.status === 'running'
              ? { ...record, status: event.success ? 'done' : 'error' }
              : record
          ),
          ...(members ? { exploreGroupMembers: members } : {}),
        };
      });
    } else {
      const isExplore = agentId.toLowerCase().includes('explore');
      const role = isExplore ? 'Explore' : 'Task';
      appendTimelineEntry(sessionId, {
        id: entryId,
        type: 'explore_status',
        title: `${role}: ${event.summary || agentId}`,
        timestamp: event.timestamp || Date.now(),
        pending: false,
        exploreRole: role,
        exploreTask: event.summary || agentId,
        exploreStatus: status,
        exploreSummary: event.summary,
        exploreError: event.error,
        exploreToolCount: 0,
        exploreTokens: 0,
        exploreElapsed: durationMs,
      });
    }
    scrollToBottom();
  }

  function handleProviderStatus(event: any) {
    const eventTimestamp = event.timestamp || Date.now();

    const statusMap: Record<string, { text: string; level: 'info' | 'warning' | 'error' }> = {
      'healthy': { text: '正常', level: 'info' },
      'degraded': { text: '降级中', level: 'warning' },
      'unhealthy': { text: '不可用', level: 'error' },
      'recovering': { text: '恢复中', level: 'warning' },
    };
    const statusInfo = statusMap[event.status] || { text: event.status, level: 'info' };
    const title = `Provider 状态: ${event.providerId}`;
    const detail = `状态: ${statusInfo.text}${event.reason ? `\n原因: ${event.reason}` : ''}`;

    if (event.status !== 'healthy') {
      appendTimelineEntry(event.sessionId, {
        id: createId('timeline-provider-status'),
        type: 'log',
        title,
        detail,
        timestamp: eventTimestamp,
        level: statusInfo.level,
        pending: event.status === 'recovering',
        providerStatusId: event.providerId,
        providerStatusValue: event.status,
        providerStatusReason: event.reason,
      });
    }

    if (activeSessionIdRef.current === event.sessionId) {
      setRuntimeLogs((prev: RuntimeLogEntry[]) => {
        const next: RuntimeLogEntry[] = [
          {
            id: createId('log'),
            level: statusInfo.level === 'error' ? 'error' : (statusInfo.level === 'warning' ? 'warn' : 'info'),
            message: `[Provider] ${event.providerId}: ${statusInfo.text}`,
            detail: event.reason || undefined,
            timestamp: Date.now(),
          },
          ...prev,
        ];
        return next.slice(0, 20);
      });
    }
  }

  /**
   * 处理来自 Runner 的错误事件
   * 包括：无限循环检测、占位符检测、分类错误等
   */
  function settlePendingEntriesAsFailed(sessionId: string | null | undefined, reason: string) {
    if (!sessionId) return;
    closeReasoningEntry(sessionId);
    const timeline = timelineMapRef.current.get(sessionId) || [];
    for (const entry of timeline) {
      if (!entry.pending && !(entry as any).editStreaming) continue;
      if (entry.type === 'explore_status' || entry.type === 'agent_delegation') {
        updateTimelineEntryById(sessionId, entry.id, (prev) => ({
          ...prev,
          pending: false,
          exploreStatus: prev.exploreStatus === 'running' ? 'error' : prev.exploreStatus,
          delegationStatus: (prev as any).delegationStatus === 'running' ? 'error' : (prev as any).delegationStatus,
          exploreError: (prev as any).exploreError || reason,
          delegationError: (prev as any).delegationError || reason,
        } as any));
      } else if (entry.type === 'tool_call') {
        if (isUnclaimedArgStreamPlaceholder(entry)) { updateTimelineEntryById(sessionId, entry.id, (p) => ({ ...p, ...unclaimedAtRunEndPatch({}, isZhUi(), reason) } as any)); continue; }
        updateTimelineEntryById(sessionId, entry.id, (prev) => ({
          ...prev,
          type: 'tool_error' as any,
          pending: false,
          success: false,
          level: 'error',
          errorReason: prev.errorReason || reason,
          errorMessage: (prev as { errorMessage?: string }).errorMessage || reason, /* 不带就只剩「未知错误」 */
        } as any));
      } else if (entry.type === 'edit_file') {
        updateTimelineEntryById(sessionId, entry.id, (prev) => ({
          ...prev,
          pending: false,
          editStreaming: false,
          editIsComplete: true,
          success: prev.success ?? false,
          errorReason: prev.errorReason || reason,
        } as any));
      } else if (
        entry.type === 'assistant_message'
        || entry.type === 'assistant_prefix'
        || entry.type === 'agent_message'
        || entry.type === 'thinking'
      ) {
        updateTimelineEntryById(sessionId, entry.id, (prev) => ({
          ...prev,
          pending: false,
        }));
      }
    }
  }

  function handleRunnerError(event: any) {
    if (event?.taskAgentId) return;
    const sessionId = event.sessionId || activeSessionIdRef.current;
    const eventTimestamp = timestampAfterLatestUser(sessionId, event.timestamp);
    resetStreamingTokens(sessionId);
    clearRetryWatchdog(sessionId);
    closeEmptyAssistantSlotOnError(sessionId, 'runner_error');
    const errorMessage = typeof event.error === 'string' ? event.error : 'Unknown error';
    const t = tRef.current;
    const classifiedError = sessionId ? recentClassifiedErrorRef.current.get(sessionId) : undefined;

    if (
      classifiedError &&
      Math.abs(classifiedError.timestamp - eventTimestamp) < 5000 &&
      isLikelyDuplicateError(classifiedError.message, errorMessage)
    ) {
      updateTimelineEntryById(sessionId, classifiedError.entryId, (prev) => ({
        ...prev,
        detail: prev.detail || errorMessage,
        errorMessage: prev.errorMessage || errorMessage,
        timestamp: Math.max(prev.timestamp || 0, eventTimestamp),
      }));
      return;
    }

    if (/interrupted by user|Task interrupted|用户中断/i.test(errorMessage)) {
      settlePendingEntriesAsFailed(sessionId, errorMessage);
      dispatchStreaming(false, sessionId ?? undefined);
      requestExecutionStateReconcile?.('runner_error');
      return;
    }

    const RUNNER_ERROR_HINTS: Array<{ re: RegExp; code: string; msg: string; hint: string; retry: boolean }> = [
      { re: /unsupported provider protocol|not a chat model|openai-images/i,
        code: 'MODEL_NOT_CHAT', msg: '当前选的模型不能用于对话',
        hint: '这是图像/嵌入类模型 · 请在下方模型选择器换回一个对话模型', retry: false },
      { re: /no provider|provider not found|未找到.*provider/i,
        code: 'NO_PROVIDER', msg: '没有可用的供应商',
        hint: '去设置里添加或启用一个供应商', retry: false },
      { re: /401|unauthorized|invalid api key|api key.*(invalid|expired)/i,
        code: 'UNAUTHORIZED', msg: 'API key 无效或已过期',
        hint: '去设置里检查这个供应商的 key', retry: false },
      { re: /429|rate.?limit|too many requests/i,
        code: 'RATE_LIMITED', msg: '被供应商限流了',
        hint: '等几秒再重试; 高频调用可换一个供应商', retry: true },
      { re: /insufficient.?balance|quota|余额不足|额度/i,
        code: 'QUOTA', msg: '供应商额度/余额不足',
        hint: '去供应商后台充值或提额, 也可换一个供应商', retry: false },
      { re: /context length|maximum context|context_length_exceeded|上下文.*超/i,
        code: 'CONTEXT_EXCEEDED', msg: '上下文超出模型窗口',
        hint: '开新会话继续, 或换一个窗口更大的模型', retry: false },
      { re: /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket hang up/i,
        code: 'NETWORK', msg: '连不上供应商',
        hint: '检查网络/代理是否可达该供应商域名, 然后重试', retry: true },
      { re: /timeout|timed out|ETIMEDOUT/i,
        code: 'TIMEOUT', msg: '请求超时',
        hint: '供应商这会儿慢 · 稍候重试, 或临时换一个更轻的模型', retry: true },
      { re: /5\d\d\b|internal server error|bad gateway|service unavailable/i,
        code: 'UPSTREAM_5XX', msg: '供应商服务端出错',
        hint: '不是你的问题 · 稍候重试; 持续失败换个供应商', retry: true },
    ];
    const hinted = RUNNER_ERROR_HINTS.find(h => h.re.test(errorMessage));

    // 解析错误类型和建议（使用国际化）
    let errorCode = hinted?.code ?? 'RUNNER_ERROR';
    let suggestion = hinted?.hint
      ?? (t.errors?.runnerErrorSuggestion || 'Please check the error details and try again.');
    let category = hinted ? hinted.msg : 'Runtime';
    let retryable = hinted?.retry ?? false;

    if (errorMessage.includes('infinite loop') || errorMessage.includes('Detected infinite loop')) {
      errorCode = 'LOOP_DETECTED';
      category = t.errors?.loopDetected || 'Loop Detection';
      suggestion = t.errors?.loopDetectedSuggestion || 'The model is repeatedly calling the same tool. Please try rephrasing your request or start a new conversation.';
      retryable = false;
    } else if (errorMessage.includes('placeholder') || errorMessage.includes('[omitted')) {
      errorCode = 'PLACEHOLDER_DETECTED';
      category = t.errors?.placeholderDetected || 'Placeholder Detected';
      suggestion = t.errors?.placeholderDetectedSuggestion || 'The model attempted to write placeholder text. This usually happens when conversation history contains truncated data. Please start a new conversation.';
      retryable = false;
    } else if (errorMessage.includes('Error:')) {
      // 提取错误代码
      const match = errorMessage.match(/Error:\s*(\w+)/);
      if (match) {
        errorCode = match[1];
      }
      /* 命中了具体建议就别被通用句盖回去 —— 也别把不可重试的错误标成可重试 */
      if (!hinted) {
        suggestion = t.errors?.runnerErrorSuggestion || 'Please check the error details and try again.';
        retryable = true;
      }
    }

    const timelineEntryId = turnScopedErrorId(sessionId, errorCode);
    const errorRepeatCount = supersedeTurnErrorCards(sessionId, timelineEntryId);
    trackTurnErrorEntry(sessionId, timelineEntryId);
    appendTimelineEntry(sessionId, {
      id: timelineEntryId,
      type: 'runner_error',
      title: `❌ ${errorCode}`,
      detail: errorMessage,
      timestamp: eventTimestamp,
      level: 'error',
      pending: false,
      errorRepeatCount,
      // ErrorCard 需要的额外字段
      errorCode,
      errorMessage,
      errorSuggestion: suggestion,
      errorCategory: category,
      errorRetryable: retryable,
    });

    // 更新状态栏
    dispatchStatus(`❌ Error: ${errorCode}`, sessionId);
    settlePendingEntriesAsFailed(sessionId, errorMessage);

    // 添加到运行时日志
    if (activeSessionIdRef.current === sessionId) {
      setRuntimeLogs((prev: RuntimeLogEntry[]) => {
        const next: RuntimeLogEntry[] = [
          {
            id: createId('log'),
            level: 'error',
            message: `[${category}] ${errorCode}`,
            detail: `${errorMessage}${suggestion ? `\n\n💡 ${suggestion}` : ''}`,
            timestamp: Date.now(),
          },
          ...prev,
        ];
        return next.slice(0, 20);
      });
    }

    if (sessionId) {
      recentRunnerErrorRef.current.set(sessionId, {
        entryId: timelineEntryId,
        message: errorMessage,
        timestamp: eventTimestamp,
      });
    }

    // 标记可重试状态
    if (retryable) {
      setCanRetry(true);
      setRetryError({
        code: errorCode,
        message: errorMessage,
        suggestion,
        category,
        retryable,
      });
    }

    dispatchStreaming(false, sessionId ?? undefined);
    requestExecutionStateReconcile?.('runner_error');

    scrollToBottom();
  }
}
