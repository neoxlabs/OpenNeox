import type { ContextTokenBreakdown } from '@neoxlabs/kernel/utils/contextBreakdown.js';

export type CompressionMode = 'sync' | 'async';

export type MemoryPressureState =
  | 'unknown'
  | 'normal'
  | 'warn'
  | 'soft_limit'
  | 'limit';

export interface TokenBreakdown {
  systemTokens: number;
  userTokens: number;
  assistantTokens: number;
  toolCallTokens: number;
  toolResultTokens: number;
  totalTokens: number;
}

export interface SessionCacheUsage {
  requests: number;
  inputTokens: number;
  baseInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  hitRate: number;
  outputTokens?: number;
  totalTokens?: number;
  /** 会话累积 breakdown(每轮 request breakdown 逐字段求和, 含子 agent); 无 DB 种子, 从 app 启动起算 */
  breakdown?: ContextTokenBreakdown;
}

export interface ContextUsage {
  currentTokens: number;
  maxTokens: number;
  usagePercent: number;
  messageCount: number;
  toolMessageCount?: number;
  toolResultRatio?: number;
  warnings?: string[];
  byType?: Record<string, { count: number; tokens: number }>;
  breakdown?: TokenBreakdown;
  tokensUsed?: number;
  contextWindow?: number;
  pressure?: number;
  state?: MemoryPressureState;
  sessionCache?: SessionCacheUsage;
}

export interface ContextConfig {
  compressionMode: CompressionMode;
  thresholdPercent: number;
}
