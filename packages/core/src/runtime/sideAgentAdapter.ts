import type { ToolCallSummaryInput } from './claude/sideAgentPrompts.js';

export interface ToolBatchSummaryRequest {
  batchId: string;
  sessionId?: string;
  toolCalls: ToolCallSummaryInput[];
  abortSignal?: AbortSignal;
  emit: (summary: string) => void;
}

export interface SessionTitleRequest {
  sessionId: string;
  firstUserMessage: string;
  /**
   * Recent user messages supplied as additional title material during reaggregation.
   */
  recentUserMessages?: string[];
  /** Number of user messages represented by this title. */
  aggregatedFromUserMessages?: number;
  /**
   * 写回前的乐观锁: 库里的名字必须还等于它才允许覆盖。
   * 对不上 = 用户自己改过名, 那这个会话之后就归用户管, 不再自动改。
   */
  expectedCurrentTitle?: string;
  abortSignal?: AbortSignal;
  emit?: (title: string) => void;
}

/** Metadata used to persist the title and advance the next milestone. */
export interface SessionTitlePersistMeta {
  aggregatedFromUserMessages?: number;
  expectedCurrentTitle?: string;
}

/** 会话标题的聚合状态 (落 app_state, 跨重启有效) */
export interface SessionTitleMeta {
  /** 上一次**我们**写进去的标题 —— 跟库里现名不符就说明用户手改过 */
  title: string;
  /** Number of user messages represented by the persisted title. */
  aggregatedFromUserMessages: number;
  /** 用户手动改过名 —— 从此不再自动覆盖 */
  manual?: boolean;
}

export interface SideAgentAdapter {
  scheduleToolBatchSummary?(request: ToolBatchSummaryRequest): void;
  scheduleSessionTitle?(request: SessionTitleRequest): void;
}
