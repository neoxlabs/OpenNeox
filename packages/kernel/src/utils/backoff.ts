/**
 * Exponential Backoff Algorithm
 * Based on OpenAI Codex implementation
 *
 * 针对 API 代理速率限制优化
 */

import type { RetryConfig } from '../types/retryConfig.js';
import { DEFAULT_RETRY_CONFIG } from '../types/retryConfig.js';
import { ErrorCategory } from '../types/errors.js';

// Re-export for convenience
export { DEFAULT_RETRY_CONFIG } from '../types/retryConfig.js';

/**
 * Calculate exponential backoff delay with jitter
 *
 * Formula: delay = initialDelay * (backoffFactor ^ (attempt - 1)) * jitter
 *
 * Example with defaults (200ms initial, 2.0 factor):
 * - Attempt 1: ~200ms
 * - Attempt 2: ~400ms
 * - Attempt 3: ~800ms
 * - Attempt 4: ~1600ms
 * - Attempt 5: ~3200ms
 *
 * @param attempt - The retry attempt number (1-based)
 * @param config - Optional retry configuration
 * @returns Delay in milliseconds
 */
export function calculateBackoff(
  attempt: number,
  config: Partial<RetryConfig> = {}
): number {
  const {
    initialDelayMs = DEFAULT_RETRY_CONFIG.initialDelayMs,
    backoffFactor = DEFAULT_RETRY_CONFIG.backoffFactor,
    maxDelayMs = DEFAULT_RETRY_CONFIG.maxDelayMs,
    jitterRange = DEFAULT_RETRY_CONFIG.jitterRange,
  } = config;

  // Calculate exponential component (0-based exponent)
  const exponent = Math.max(0, attempt - 1);
  const exponentialDelay = initialDelayMs * Math.pow(backoffFactor, exponent);

  // Add jitter (±jitterRange)
  // jitter = 1 + random(-jitterRange, +jitterRange)
  const jitter = 1 + (Math.random() * 2 - 1) * jitterRange;
  const delayWithJitter = exponentialDelay * jitter;

  // Cap at maximum delay
  const finalDelay = Math.min(delayWithJitter, maxDelayMs);

  return Math.floor(finalDelay);
}

/**
 * Get retry delay, preferring server-provided Retry-After if available
 *
 * @param serverRetryAfter - Server-provided retry delay (milliseconds)
 * @param attempt - The retry attempt number (1-based)
 * @param config - Optional retry configuration
 * @returns Delay in milliseconds
 */
export function getRetryDelay(
  serverRetryAfter: number | undefined,
  attempt: number,
  config?: Partial<RetryConfig>
): number {
  // Prefer server-provided delay
  if (serverRetryAfter !== undefined && serverRetryAfter > 0) {
    return serverRetryAfter;
  }

  // Fall back to calculated backoff
  return calculateBackoff(attempt, config);
}

/**
 * Sleep for a specified duration
 *
 * @param ms - Duration in milliseconds
 * @returns Promise that resolves after the delay
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create a delay that can be cancelled
 *
 * @param ms - Duration in milliseconds
 * @returns Object with promise and cancel function
 */
export function cancellableSleep(ms: number): {
  promise: Promise<boolean>;
  cancel: () => void;
} {
  let timeoutId: NodeJS.Timeout | undefined;
  let cancelled = false;

  const promise = new Promise<boolean>(resolve => {
    timeoutId = setTimeout(() => {
      if (!cancelled) {
        resolve(true); // Completed normally
      }
    }, ms);
  });

  const cancel = () => {
    cancelled = true;
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  };

  return { promise, cancel };
}

/**
 * Sleep that can be interrupted by an AbortSignal
 *
 * @param ms - Duration in milliseconds
 * @param signal - Optional AbortSignal to interrupt the sleep
 * @returns Promise that resolves after the delay or rejects if aborted
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    /* 使用单个 timer，确保完成和 abort 都能及时释放等待。 */
    const abortHandler = () => {
      clearTimeout(timeoutId);
      reject(new DOMException('Aborted', 'AbortError'));
    };

    const timeoutId = setTimeout(() => {
      signal?.removeEventListener('abort', abortHandler);
      resolve();
    }, ms);

    signal?.addEventListener('abort', abortHandler, { once: true });
  });
}

/**
 * 可被 AbortSignal 提前结束的 sleep — 与 abortableSleep 的区别: **绝不 reject**。
 *
 * 用途: runner 的 stream-retry 退避等待。该等待发生在主循环的 catch 分支里,
 * 若此处 throw 会直接窜出 generator 破坏收尾语义; 正确行为是"提前醒来 → continue →
 * 循环顶部的 signal.aborted 检查走正常 interrupted 收尾"。
 */
export function interruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timeoutId);
      resolve();
    };
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Format delay for display (human-readable)
 *
 * @param ms - Duration in milliseconds
 * @returns Human-readable string
 */
export function formatDelay(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }

  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }

  const minutes = seconds / 60;
  return `${minutes.toFixed(1)}m`;
}

/**
 * 速率限制专用的退避配置
 *
 * 调整说明: initialDelay 3000 → 1500
 *   Anthropic RPM 桶按分钟刷新, 实际 burst 触发 429 后 1-3s 内 RPM 桶就补充上,
 *   起始等 3s 太保守 (用户感知"重试好慢"). CC 那边起始 500ms × 2^n, 跟它接近一点更顺.
 *   factor 2.5 不变 (1.5 → 3.75 → 9.4 → 23.4 → 58.6, 跟 cap 60s 配合); jitter ±30% 不变.
 *   配合 retryConfig.requestMaxRetries=6, 总预算约 1.5+3.75+9.4+23.4+58.6+60 ≈ 156s — 长尾耐性足够.
 *   服务端 retry-after 头优先(下方 calculateRateLimitBackoff 已 honor).
 */
export const RATE_LIMIT_BACKOFF_CONFIG: Partial<RetryConfig> = {
  initialDelayMs: 1500,    // 初始延迟 1.5 秒 (旧 3s)
  backoffFactor: 2.5,      // 增长: 1.5s → 3.75s → 9.4s → 23.4s → 58.6s → 60s(cap)
  maxDelayMs: 60000,       // 最大 60 秒
  jitterRange: 0.3,        // 30% 的随机抖动，避免多个客户端同时重试
};

/**
 * 网络中断/流不完整专用的退避配置
 * 使用较短的延迟，因为网络恢复通常较快
 */
export const STREAM_INTERRUPT_BACKOFF_CONFIG: Partial<RetryConfig> = {
  initialDelayMs: 1000,    // 初始延迟 1 秒
  backoffFactor: 1.5,      // 较温和的增长: 1s → 1.5s → 2.25s → 3.4s
  maxDelayMs: 10000,       // 最大 10 秒
  jitterRange: 0.2,        // 20% 的随机抖动
};

/**
 * 计算速率限制的退避延迟
 * 相比普通退避，使用更长的延迟和更激进的增长
 *
 * Example delays:
 * - Attempt 1: ~3s (3000 * 1 * jitter)
 * - Attempt 2: ~7.5s (3000 * 2.5 * jitter)
 * - Attempt 3: ~18.75s (3000 * 6.25 * jitter)
 *
 * @param attempt - The retry attempt number (1-based)
 * @param serverRetryAfter - Server-provided retry delay (milliseconds)
 * @returns Delay in milliseconds
 */
export function calculateRateLimitBackoff(
  attempt: number,
  serverRetryAfter?: number
): number {
  // 如果服务器指定了 retry-after，优先使用（加一点 jitter）
  if (serverRetryAfter !== undefined && serverRetryAfter > 0) {
    const jitter = 1 + (Math.random() * 0.2); // 0-20% 额外延迟
    return Math.floor(serverRetryAfter * jitter);
  }

  // 使用速率限制专用的退避配置
  return calculateBackoff(attempt, RATE_LIMIT_BACKOFF_CONFIG);
}

/**
 * 根据错误类别选择合适的退避策略
 *
 * @param category - 错误类别
 * @param attempt - 重试次数
 * @param serverRetryAfter - 服务器指定的重试延迟
 * @returns Delay in milliseconds
 */
export function getSmartRetryDelay(
  category: ErrorCategory,
  attempt: number,
  serverRetryAfter?: number
): number {
  // 速率限制类错误使用更激进的退避
  if (category === ErrorCategory.RETRYABLE_RATE_LIMIT) {
    return calculateRateLimitBackoff(attempt, serverRetryAfter);
  }

  // 流中断/网络错误使用较短的退避
  if (category === ErrorCategory.RETRYABLE_STREAM ||
      category === ErrorCategory.RETRYABLE_NETWORK) {
    return calculateBackoff(attempt, STREAM_INTERRUPT_BACKOFF_CONFIG);
  }

  // 其他可重试错误使用标准退避
  return getRetryDelay(serverRetryAfter, attempt);
}

/**
 * Calculate total time for all retries
 * Useful for estimating maximum wait time
 *
 * @param maxRetries - Maximum number of retries
 * @param config - Optional retry configuration
 * @returns Total time in milliseconds (without jitter)
 */
export function calculateTotalRetryTime(
  maxRetries: number,
  config: Partial<RetryConfig> = {}
): number {
  let total = 0;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Calculate without jitter for predictable estimate
    const { initialDelayMs = DEFAULT_RETRY_CONFIG.initialDelayMs } = config;
    const { backoffFactor = DEFAULT_RETRY_CONFIG.backoffFactor } = config;
    const { maxDelayMs = DEFAULT_RETRY_CONFIG.maxDelayMs } = config;

    const delay = Math.min(
      initialDelayMs * Math.pow(backoffFactor, attempt - 1),
      maxDelayMs
    );
    total += delay;
  }

  return total;
}
