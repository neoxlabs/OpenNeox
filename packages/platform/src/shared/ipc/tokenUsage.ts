export type RequestType = 'chat' | 'health-check';

export interface TokenUsageRecord {
  id: string;
  timestamp: number;
  provider: string;
  model: string;
  inputTokens: number;
  billableInputTokens?: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  openaiCachedTokens?: number;
  anthropicCacheReadTokens?: number;
  anthropicCacheCreationTokens?: number;
  anthropicCacheCreation5mTokens?: number;
  anthropicCacheCreation1hTokens?: number;
  duration: number;
  success: boolean;
  error?: string;
  sessionId?: string;
  requestType?: RequestType;
}

export interface ProviderUsageStats {
  provider: string;
  totalRequests: number;
  successRequests: number;
  failedRequests: number;
  totalInputTokens: number;
  totalBillableInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCachedTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalOpenaiCachedTokens: number;
  totalAnthropicCacheReadTokens: number;
  totalAnthropicCacheCreationTokens: number;
  totalAnthropicCacheCreation5mTokens: number;
  totalAnthropicCacheCreation1hTokens: number;
  avgDuration: number;
  lastRequestTime: number;
  firstRequestTime?: number;
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

export interface UsageSummary {
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
  cacheHitRate: number;
  providerCount: number;
  lastRequestTime: number;
}
