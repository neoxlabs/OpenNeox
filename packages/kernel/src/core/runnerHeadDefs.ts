// Split out of runner.ts for the 文件大小约束 — constants, types and type guards moved verbatim.

import type { StreamRetryStreamEvent, StreamRecoveredStreamEvent } from '../types/index.js';

export const DEFAULT_TAIL_TOKEN_BUDGET = 20_000;

export type WebSearchProviderEvent = {
  type: 'web_search_event';
  webSearchId?: string;
  webSearchQuery?: string;
  webSearchStatus?: 'searching' | 'completed';
  webSearchResults?: unknown[];
};

export type ToolCallDeltaLike = {
  index: number;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
  thoughtSignature?: string;
  __kimi_builtin?: boolean;
  __kimi_original_name?: string;
};

export function isStreamRetryChunk(chunk: unknown): chunk is StreamRetryStreamEvent {
  return !!chunk && typeof chunk === 'object' && (chunk as { type?: string }).type === 'stream_retry';
}

export function isStreamRecoveredChunk(chunk: unknown): chunk is StreamRecoveredStreamEvent {
  return !!chunk && typeof chunk === 'object' && (chunk as { type?: string }).type === 'stream_recovered';
}

export function isWebSearchProviderEvent(chunk: unknown): chunk is WebSearchProviderEvent {
  return !!chunk && typeof chunk === 'object' && (chunk as { type?: string }).type === 'web_search_event';
}

/* (已删) getCompressionTriggerRatio —— 这张分档 ratio 表是"压缩死区"的来源。
   它算出的门槛恒低于真正放行的 shouldAutoCompact(contextWindow - 33K), 所以从来没有
   决定过任何一次压缩, 只负责在死区里每轮空发一个 context_compaction:'started'。
   门槛统一到 autoCompactGuard.resolveAutoCompactTriggerTokens (唯一真源)。
   用户的 compressionThreshold 覆盖仍然生效 — 作为 overrideRatio 传进去。 */

/** microCompact 时间衰减轮数 — 超过这么多轮的旧 tool result 在压缩时直接清掉。
 *  只在真触发压缩时生效 (不提前改写历史, 不打穿前缀缓存)。
 *  microCompact.ts 注释推荐 15-20; 取 18。 */
export const AUTO_COMPACT_MAX_TURN_AGE = 18;

/** 压缩空转后, 上下文需再增长这么多 token 才值得重试 (防每轮空转刷屏)。 */
export const COMPACT_RETRY_GROWTH_TOKENS = 5_000;

/* Record compact-gate diagnostics only when usage reaches a meaningful fraction
 * of the model context; normal below-threshold usage stays quiet. */
export const COMPACT_GATE_LOG_FRACTION = 0.7;
/* 外层门禁整段跳过时拿不到阈值 (那正是问题所在), 只能用消息条数兜底。
 * 这条是真警告 —— 它意味着长任务治理整体失效。 */
export const COMPACT_GATE_MSG_FLOOR = 30;

export type ToolOutcomeStatus = 'success' | 'error' | 'already_done';

export interface ToolOutcomeSnapshot {
  iteration: number;
  name: string;
  status: ToolOutcomeStatus;
  executionTime: number;
}
