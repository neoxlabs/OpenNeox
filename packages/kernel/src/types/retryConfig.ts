/**
 * Retry Configuration Types
 */

/**
 * Retry configuration for a single provider
 */
export interface ProviderRetryConfig {
  /** Maximum retries for HTTP requests (default: 4) */
  requestMaxRetries?: number;

  /** Maximum retries for stream reconnection (default: 5) */
  streamMaxRetries?: number;

  /** Stream idle timeout in milliseconds (default: 300000 = 5 min) */
  streamIdleTimeoutMs?: number;

  /** Connect timeout — max wait for HTTP response headers (ms) */
  connectTimeoutMs?: number;

  /** First-byte timeout — max wait for first SSE event after connect (ms) */
  firstByteTimeoutMs?: number;
}

/**
 * Global retry configuration
 */
export interface RetryConfig {
  /** Maximum retries for HTTP requests */
  requestMaxRetries: number;

  /** Maximum retries for stream reconnection */
  streamMaxRetries: number;

  /** Maximum retries for tool calls */
  toolMaxRetries: number;

  /** Initial delay for backoff in milliseconds */
  initialDelayMs: number;

  /** Backoff multiplier factor */
  backoffFactor: number;

  /** Maximum delay cap in milliseconds */
  maxDelayMs: number;

  /** Jitter range (0-1, e.g., 0.1 = 10%) */
  jitterRange: number;

  /** Stream idle timeout in milliseconds */
  streamIdleTimeoutMs: number;

  /** Connect timeout — max wait for HTTP response headers (ms) */
  connectTimeoutMs: number;

  /** First-byte timeout — max wait for first SSE event after connect (ms) */
  firstByteTimeoutMs: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  requestMaxRetries: 6,       // 普通请求重试 6 次, 总尝试 7 次 (旧 3)
  streamMaxRetries: 6,        // 流式响应重试 6 次, 总尝试 7 次 (旧 3)
  toolMaxRetries: 2,
  initialDelayMs: 1000,       // 初始延迟 1 秒
  backoffFactor: 2.0,         // 每次翻倍：1s → 2s → 4s → 4s(cap)
  maxDelayMs: 4000,           // 退避封顶 4 秒 (普通错误), 429 走 RATE_LIMIT_BACKOFF 单独 cap 60s
  jitterRange: 0.2,           // 20% 的随机抖动
  streamIdleTimeoutMs: 120_000, // 2 min — thinking 模型推理间隙可达几十秒, 120s 兜底
  connectTimeoutMs: 30_000,    // 30s — max wait for HTTP headers
  firstByteTimeoutMs: 20_000,  // 20s — max wait for first SSE event
};

/**
 * Merge user config with defaults
 */
export function mergeRetryConfig(
  userConfig?: Partial<RetryConfig>,
  providerConfig?: ProviderRetryConfig
): RetryConfig {
  return {
    ...DEFAULT_RETRY_CONFIG,
    ...userConfig,
    // Provider-specific overrides take precedence
    ...(providerConfig?.requestMaxRetries !== undefined && {
      requestMaxRetries: providerConfig.requestMaxRetries,
    }),
    ...(providerConfig?.streamMaxRetries !== undefined && {
      streamMaxRetries: providerConfig.streamMaxRetries,
    }),
    ...(providerConfig?.streamIdleTimeoutMs !== undefined && {
      streamIdleTimeoutMs: providerConfig.streamIdleTimeoutMs,
    }),
    ...(providerConfig?.connectTimeoutMs !== undefined && {
      connectTimeoutMs: providerConfig.connectTimeoutMs,
    }),
    ...(providerConfig?.firstByteTimeoutMs !== undefined && {
      firstByteTimeoutMs: providerConfig.firstByteTimeoutMs,
    }),
  };
}

/**
 * Preset configurations for known providers
 */
/* fast-fail 策略统一原则 (跟 DEFAULT_RETRY_CONFIG 对齐):
 *   重试 ≤ 3 次, 总等待 ≤ 10 秒. 真不可恢复的错 (TLS 握手失败 / 模型 deny / 配额耗尽)
 *   一定走分类逻辑直接 fast-fail, 不进重试预算. 这里的预算只兜底"瞬时抖动". */
export const PROVIDER_RETRY_PRESETS: Record<string, ProviderRetryConfig> = {
  openai: {
    requestMaxRetries: 3,
    streamMaxRetries: 3,
    streamIdleTimeoutMs: 120_000,
    connectTimeoutMs: 45_000,
    firstByteTimeoutMs: 30_000,
  },

  anthropic: {
    requestMaxRetries: 3,
    streamMaxRetries: 3,
    streamIdleTimeoutMs: 120_000,
    connectTimeoutMs: 45_000,
    firstByteTimeoutMs: 30_000,
  },

  yunwu: {
    requestMaxRetries: 3,
    streamMaxRetries: 3,
    streamIdleTimeoutMs: 90_000,
    connectTimeoutMs: 20_000,
    firstByteTimeoutMs: 15_000,
  },

  azure: {
    requestMaxRetries: 3,
    streamMaxRetries: 3,
    streamIdleTimeoutMs: 120_000,
    connectTimeoutMs: 45_000,
    firstByteTimeoutMs: 30_000,
  },

  proxy: {
    requestMaxRetries: 2,
    streamMaxRetries: 2,
    streamIdleTimeoutMs: 120_000,
    connectTimeoutMs: 45_000,
    firstByteTimeoutMs: 60_000,
  },

  neox: {
    requestMaxRetries: 2,
    streamMaxRetries: 2,
    streamIdleTimeoutMs: 120_000,
    connectTimeoutMs: 135_000,
    firstByteTimeoutMs: 135_000,
  },

  gemini: {
    requestMaxRetries: 3,
    streamMaxRetries: 3,
    streamIdleTimeoutMs: 120_000,
    connectTimeoutMs: 45_000,
    firstByteTimeoutMs: 30_000,
  },
};

/**
 * Get retry config for a provider
 */
export function getProviderRetryConfig(
  providerName: string,
  baseUrl?: string
): ProviderRetryConfig {
  // Check for known providers
  const lowerName = providerName.toLowerCase();

  if (lowerName.includes('yunwu')) {
    return PROVIDER_RETRY_PRESETS.yunwu;
  }

  if (lowerName.includes('azure')) {
    return PROVIDER_RETRY_PRESETS.azure;
  }

  if (baseUrl) {
    const lowerUrl = baseUrl.toLowerCase();
    try {
      if (new URL(baseUrl).hostname === 'gateway.neox-dev.com') {
        return PROVIDER_RETRY_PRESETS.neox;
      }
    } catch { /* Invalid URLs are reported by the transport. */ }

    if (lowerUrl.includes('yunwu')) {
      return PROVIDER_RETRY_PRESETS.yunwu;
    }
    if (lowerUrl.includes('azure')) {
      return PROVIDER_RETRY_PRESETS.azure;
    }

    // Detect third-party proxies (not official API endpoints)
    const isOfficialApi =
      lowerUrl.includes('api.anthropic.com') ||
      lowerUrl.includes('api.openai.com');

    if (!isOfficialApi) {
      // Use proxy preset for third-party services
      return PROVIDER_RETRY_PRESETS.proxy;
    }
  }

  // Default based on protocol
  if (lowerName.includes('anthropic')) {
    return PROVIDER_RETRY_PRESETS.anthropic;
  }

  if (lowerName.includes('gemini')) {
    return PROVIDER_RETRY_PRESETS.gemini;
  }

  return PROVIDER_RETRY_PRESETS.openai;
}
