import type { ContextTokenBreakdown } from '@neoxlabs/kernel/utils/contextBreakdown.js';
import type { SavedTimelineEntry } from './timeline.js';
import type { SessionCacheUsage } from './context.js';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  timestamp: number;
  tokens?: number;
  pending?: boolean;
  sequence?: number;
  messageSource?: string;
  /** 本轮 (这条回复) 消耗的 token —— 一轮多次 iteration 已累加。消息定稿时快照, 之后不变。 */
  turnTokens?: number;
  /** 生成这条回复实际用的模型。会话中途换模型时, 历史消息保留各自当时的模型。 */
  model?: string;
}

export interface Session {
  id: string;
  name: string;
  modelId: string;
  agentMode?: 'work' | 'code' | null;
  kind?: 'chat' | 'image';
  workspacePath: string;
  messages: ChatMessage[];
  /** 轻量列表 (listSessions slim 路径) 附带: 聊天消息条数 — messages 为空数组时列表 UI
   * (徽标/空态判断) 用它, 口径与 messages.length 一致。完整加载的 Session 可缺省。 */
  messageCount?: number;
  /** 轻量列表附带: 首条聊天消息文本截断 (无标题会话的列表标题回退用)。 */
  firstMessagePreview?: string;
  createdAt: number;
  updatedAt: number;
  totalTokens: number;
  contextUsed: number;
  contextWindow?: number;
  checkpoints?: SessionCheckpoint[];
  timeline?: SavedTimelineEntry[];
  fileRollbackCheckpointId?: string | null;
  fileReapplyCheckpointId?: string | null;
  fileRevertedMap?: Record<string, boolean>;
  fileConfirmedMap?: Record<string, boolean>;
  contextBreakdown?: ContextTokenBreakdown | null;
  latestRequestUsage?: {
    model?: string;
    inputTokens: number;
    billableInputTokens?: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalTokens: number;
    breakdown?: ContextTokenBreakdown;
  } | null;
  /** 会话累积用量快照(forwarder 逐轮累加, 含子 agent) — 跨重启恢复累积统计的真源 */
  sessionUsage?: SessionCacheUsage | null;
  runState?: SessionRunState;
  mirrorPolicy?: 'always' | 'manual' | 'never';
  parentSessionId?: string | null;
}

export type SessionRunStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'awaiting_approval'
  | 'awaiting_user';

export interface SessionRunState {
  status: SessionRunStatus;
  turnId?: string;
  lastCommittedSeq?: number;
  pendingToolCalls?: Array<{
    toolCallId: string;
    toolName: string;
    args?: any;
    startedAt: number;
  }>;
  initiatedBy?: string;
  pausedAt?: number;
  updatedAt: number;
}

export interface SessionCheckpoint {
  id: string;
  name?: string;
  timestamp: number;
  messageCount: number;
  summary?: string;
  messages?: ChatMessage[];
}

export type SessionCheckpointMeta = Omit<SessionCheckpoint, 'messages'>;
