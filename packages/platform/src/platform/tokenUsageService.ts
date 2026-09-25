/**
 * Token Usage Service - SQLite-backed Token 使用统计
 *
 *  MIGRATED: 从 JSON 文件全量读写 → SQLite 单行 INSERT（0.05ms vs 30ms）
 *
 * 记录每次 LLM API 请求的 token 消耗，按 provider 分组统计。
 * 底层使用 NeoxDatabase (better-sqlite3 + WAL 模式)。
 */

import { getDatabase } from './database.js';

// ==================== 类型定义 ====================

/** 请求类型 */
export type RequestType = 'chat' | 'health-check';

/** 单次请求的 Token 使用记录 */
export interface TokenUsageRecord {
  id: string;
  timestamp: number;
  provider: string;
  model: string;
  inputTokens: number;
  billableInputTokens?: number;
  outputTokens: number;
  totalTokens: number;
  // 缓存相关字段
  /** 通用缓存命中 tokens (OpenAI cached_tokens 或 Anthropic cache_read) */
  cachedTokens?: number;
  /** 归一化缓存读取 tokens */
  cacheReadTokens?: number;
  /** 归一化缓存写入/创建 tokens */
  cacheWriteTokens?: number;
  /** OpenAI: cached_tokens from prompt_tokens_details */
  openaiCachedTokens?: number;
  /** Anthropic: cache_read_input_tokens (10% cost) */
  anthropicCacheReadTokens?: number;
  /** Anthropic: cache_creation_input_tokens (125% cost) */
  anthropicCacheCreationTokens?: number;
  /** Anthropic: 5-minute cache creation */
  anthropicCacheCreation5mTokens?: number;
  /** Anthropic: 1-hour cache creation */
  anthropicCacheCreation1hTokens?: number;
  // 其他字段
  duration: number;           // 请求耗时 ms (整轮, 含工具循环)
  /** 回合起点→首个可见输出延迟 ms (TTFT, 感知延迟) */
  firstTokenMs?: number;
  /** 首 token→末 token 生成窗口 ms (tokens/s 分母) */
  generationMs?: number;
  success: boolean;
  error?: string;
  sessionId?: string;
  /** 请求类型: chat=正常对话, health-check=健康检测 */
  requestType?: RequestType;
}

/** Provider 统计汇总 */
export interface ProviderUsageStats {
  provider: string;
  totalRequests: number;
  successRequests: number;
  failedRequests: number;
  totalInputTokens: number;
  totalBillableInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  // 缓存统计
  totalCachedTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  /** OpenAI 缓存命中 tokens */
  totalOpenaiCachedTokens: number;
  /** Anthropic 缓存读取 tokens (10% cost) */
  totalAnthropicCacheReadTokens: number;
  /** Anthropic 缓存创建 tokens (125% cost) */
  totalAnthropicCacheCreationTokens: number;
  /** Anthropic 5分钟缓存创建 tokens */
  totalAnthropicCacheCreation5mTokens: number;
  /** Anthropic 1小时缓存创建 tokens */
  totalAnthropicCacheCreation1hTokens: number;
  // 其他统计
  avgDuration: number;
  /** 平均首响延迟 ms (无打点记录时 null) */
  avgFirstTokenMs: number | null;
  /** 平均生成速度 tokens/s (无打点记录时 null) */
  avgTokensPerSec: number | null;
  lastRequestTime: number;
  models: Record<string, {
    requests: number;
    inputTokens: number;
    billableInputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cachedTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  }>;
}

/** 完整使用统计 */
export interface UsageStatistics {
  version: string;
  lastUpdated: number;
  providers: Record<string, ProviderUsageStats>;
  records: TokenUsageRecord[];
}

// ==================== TokenUsageService ====================

export class TokenUsageService {
  // 生成唯一 ID
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  // 记录一次 Token 使用 —  直接 INSERT 一行，< 0.1ms
  async recordUsage(record: Omit<TokenUsageRecord, 'id'>): Promise<void> {
    const db = getDatabase();
    db.recordTokenUsage({
      id: this.generateId(),
      timestamp: record.timestamp,
      provider: record.provider,
      model: record.model,
      inputTokens: record.inputTokens,
      billableInputTokens: record.billableInputTokens,
      outputTokens: record.outputTokens,
      totalTokens: record.totalTokens,
      cachedTokens: record.cachedTokens,
      cacheReadTokens: record.cacheReadTokens,
      cacheWriteTokens: record.cacheWriteTokens,
      openaiCachedTokens: record.openaiCachedTokens,
      anthropicCacheReadTokens: record.anthropicCacheReadTokens,
      anthropicCacheCreationTokens: record.anthropicCacheCreationTokens,
      anthropicCacheCreation5mTokens: record.anthropicCacheCreation5mTokens,
      anthropicCacheCreation1hTokens: record.anthropicCacheCreation1hTokens,
      duration: record.duration,
      firstTokenMs: record.firstTokenMs,
      generationMs: record.generationMs,
      success: record.success,
      error: record.error,
      sessionId: record.sessionId,
      requestType: record.requestType,
    });
  }

  // 获取所有 provider 统计
  async getProviderStats(): Promise<ProviderUsageStats[]> {
    const db = getDatabase();
    const rows = db.getTokenUsageStats();
    return rows.map((row: any) => {
      const models = db.getTokenUsageModelStats(row.provider);
      return {
        provider: row.provider,
        totalRequests: row.total_requests,
        successRequests: row.success_requests,
        failedRequests: row.failed_requests,
        totalInputTokens: row.total_input_tokens,
        totalBillableInputTokens: row.total_billable_input_tokens,
        totalOutputTokens: row.total_output_tokens,
        totalTokens: row.total_tokens,
        totalCachedTokens: row.total_cached_tokens,
        totalCacheReadTokens: row.total_cache_read_tokens,
        totalCacheWriteTokens: row.total_cache_write_tokens,
        totalOpenaiCachedTokens: row.total_openai_cached,
        totalAnthropicCacheReadTokens: row.total_anthropic_cache_read,
        totalAnthropicCacheCreationTokens: row.total_anthropic_cache_create,
        totalAnthropicCacheCreation5mTokens: row.total_anthropic_cache_5m,
        totalAnthropicCacheCreation1hTokens: row.total_anthropic_cache_1h,
        avgDuration: Math.round(row.avg_duration || 0),
        avgFirstTokenMs: row.avg_first_token_ms != null ? Math.round(row.avg_first_token_ms) : null,
        avgTokensPerSec: row.avg_tokens_per_sec != null ? Math.round(row.avg_tokens_per_sec * 10) / 10 : null,
        lastRequestTime: row.last_request_time,
        models,
      };
    });
  }

  // 获取单个 provider 的详细记录
  async getProviderRecords(provider: string, limit = 100): Promise<TokenUsageRecord[]> {
    const db = getDatabase();
    const rows = db.getTokenUsageByProvider(provider, limit);
    return rows.map((row: any) => this.rowToRecord(row));
  }

  // 获取最近的请求记录
  async getRecentRecords(limit = 50): Promise<TokenUsageRecord[]> {
    const db = getDatabase();
    const rows = db.getRecentTokenUsage(limit);
    return rows.map((row: any) => this.rowToRecord(row));
  }

  /** 按天聚合 (趋势图用) —— 聚合在 SQL 里做, 不把每条请求都搬到渲染进程。 */
  async getDaily(days = 30): Promise<Array<{
    day: string; requests: number; inputTokens: number; outputTokens: number; totalTokens: number;
  }>> {
    const rows = getDatabase().getDailyTokenUsage(days);
    return rows.map((r: any) => ({
      day: String(r.day),
      requests: Number(r.requests || 0),
      inputTokens: Number(r.input_tokens || 0),
      outputTokens: Number(r.output_tokens || 0),
      totalTokens: Number(r.total_tokens || 0),
    }));
  }

  /** 一个会话里每一轮的用量 + 模型 —— 给历史消息的 footer 回填。 */
  async getSessionTurns(sessionId: string): Promise<Array<{
    timestamp: number; model: string | null;
    inputTokens: number; outputTokens: number; cacheReadTokens: number; totalTokens: number;
  }>> {
    if (!sessionId) return [];
    try {
      return getDatabase().getSessionTurnUsage(sessionId);
    } catch {
      return [];
    }
  }

  // 获取单个 session 的累积汇总(含子 agent — 落库时统一挂主 sessionId)
  getSessionSummary(sessionId: string): ReturnType<ReturnType<typeof getDatabase>['getSessionTokenUsageSummary']> {
    return getDatabase().getSessionTokenUsageSummary(sessionId);
  }

  // 获取汇总统计
  async getSummary(): Promise<{
    totalRequests: number;
    totalTokens: number;
    totalInputTokens: number;
    totalBillableInputTokens: number;
    totalOutputTokens: number;
    totalCachedTokens: number;
    totalCacheReadTokens: number;
    totalCacheWriteTokens: number;
    totalOpenaiCachedTokens: number;
    totalAnthropicCacheReadTokens: number;
    totalAnthropicCacheCreationTokens: number;
    /** 缓存命中率 (缓存tokens / 总输入tokens) */
    cacheHitRate: number;
    providerCount: number;
    avgFirstTokenMs: number | null;
    avgTokensPerSec: number | null;
    lastRequestTime: number;
  }> {
    return getDatabase().getTokenUsageSummary();
  }

  // 清除所有统计数据
  async clearAll(): Promise<void> {
    getDatabase().clearTokenUsage();
  }

  // 清除指定 provider 的统计
  async clearProvider(provider: string): Promise<void> {
    getDatabase().clearTokenUsageByProvider(provider);
  }

  private rowToRecord(row: any): TokenUsageRecord {
    return {
      id: row.id,
      timestamp: row.timestamp,
      provider: row.provider,
      model: row.model,
      inputTokens: row.input_tokens,
      billableInputTokens: row.billable_input_tokens,
      outputTokens: row.output_tokens,
      totalTokens: row.total_tokens,
      cachedTokens: row.cached_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      openaiCachedTokens: row.openai_cached,
      anthropicCacheReadTokens: row.anthropic_cache_read,
      anthropicCacheCreationTokens: row.anthropic_cache_create,
      anthropicCacheCreation5mTokens: row.anthropic_cache_5m,
      anthropicCacheCreation1hTokens: row.anthropic_cache_1h,
      duration: row.duration,
      firstTokenMs: row.first_token_ms ?? undefined,
      generationMs: row.generation_ms ?? undefined,
      success: row.success === 1,
      error: row.error,
      sessionId: row.session_id,
      requestType: row.request_type,
    };
  }
}

// 单例
export const tokenUsageService = new TokenUsageService();
