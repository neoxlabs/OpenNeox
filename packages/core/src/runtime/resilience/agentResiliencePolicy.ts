/**
 * AgentResiliencePolicy - Agent 自愈与容错策略
 *
 * 三层韧性：
 * 1. LLM 调用级：429/500/网络错误 → 指数退避重试
 * 2. 进程级：agentLoop 崩溃 → 自动重启（保留上下文）
 * 3. 团队级：Worker 失败 → Leader 决定重派或跳过
 */

import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { extractNeoxEnvelopeFromError } from '@neoxlabs/platform/utils/neoxErrorCatalogue.js';

// ============================================================================
// Types
// ============================================================================

export interface RetryResult<T> {
  success: boolean;
  value?: T;
  error?: Error;
  attempts: number;
  totalDelayMs: number;
}

export interface ResilienceConfig {
  /** LLM 调用重试次数（默认 3） */
  maxLLMRetries: number;
  /** 进程级重启次数（默认 2） */
  maxProcessRetries: number;
  /** 初始退避时间 ms（默认 1000） */
  initialBackoffMs: number;
  /** 最大退避时间 ms（默认 30000） */
  maxBackoffMs: number;
  /** 退避倍数（默认 2） */
  backoffMultiplier: number;
}

export const DEFAULT_RESILIENCE_CONFIG: ResilienceConfig = {
  maxLLMRetries: 3,
  maxProcessRetries: 2,
  initialBackoffMs: 1000,
  maxBackoffMs: 30000,
  backoffMultiplier: 2,
};

export type ErrorCategory = 'rate_limit' | 'server_error' | 'network' | 'token_limit' | 'auth' | 'unknown';

// ============================================================================
// Error Classification
// ============================================================================

/**
 * Classify an error to determine the appropriate recovery strategy.
 *
 *   优先按 NeoxError envelope.code 判定 (网关现在返结构化 code), 找不到再回落 keyword 兜底.
 *   这样 gateway 改文案 / 翻译都不影响 retry 行为, 决策只跟 code 绑定.
 */
export function classifyError(err: Error): ErrorCategory {
  /* 优先: NeoxError envelope (gateway 标准格式) — 用顶部 import 而非动态 require,
   * vitest ESM 环境下 require 在 .ts 模块会失败 (CommonJS / ESM 混用). */
  const envelope = extractNeoxEnvelopeFromError(err);
  if (envelope) {
    const code = envelope.code as string;
    if (code.startsWith('quota.') && code.includes('rate_limit')) return 'rate_limit';
    if (code.startsWith('quota.')) return 'auth'; /* points/anonymous quota - non retryable */
    if (code.startsWith('upstream.timeout') || code.startsWith('upstream.network')) return 'network';
    if (code.startsWith('upstream.rate_limited')) return 'rate_limit';
    /* upstream.bad_response = 上游应答了但返具体错误 (model_not_found / bad_request),
     * gateway 内部 failover 已经探完, 客户端再 retry 没用. 当作 auth (不可重试) 直接出错. */
    if (code.startsWith('upstream.bad_response')) return 'auth';
    if (code.startsWith('upstream.')) return 'server_error';
    if (code === 'auth.anonymous.invalid_key') return 'network'; /* 客户端 rotate 后可重试 */
    if (code.startsWith('auth.')) return 'auth';
    if (code.startsWith('model.')) return 'auth'; /* model.* 都不可重试 */
    if (code === 'system.control_plane_unavailable') return 'server_error';
    if (code === 'system.internal_error') return 'server_error';
    return 'unknown';
  }

  /* 回落: 字符串关键字兜底 (网关老版本 / 第三方 OpenAI 直连) */
  const msg = err.message?.toLowerCase() || '';
  const name = err.name?.toLowerCase() || '';

  // Rate limiting (429)
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('quota')) {
    return 'rate_limit';
  }

  // 404 / model_unavailable / not_found — 配置缺失类错误, 不可重试 (admin 修才行)
  if (msg.includes('404') || msg.includes('not found') ||
      msg.includes('model_unavailable') || msg.includes('model_not_found') ||
      msg.includes('no gateway channel') || msg.includes('all channels exhausted')) {
    return 'auth'; /* 复用 auth category, isRetryable=false */
  }

  // Server errors (500, 502, 503)
  if (msg.includes('500') || msg.includes('502') || msg.includes('503') ||
      msg.includes('internal server error') || msg.includes('bad gateway') ||
      msg.includes('service unavailable')) {
    return 'server_error';
  }

  // Network errors — EPIPE = SSE / 长连接对端关 socket, 高频出现在 streaming 中途断开,
  // 不归 network 会落到下游"UNKNOWN + 裸 write EPIPE"裸文案.
  if (msg.includes('econnreset') || msg.includes('econnrefused') ||
      msg.includes('etimedout') || msg.includes('fetch failed') ||
      msg.includes('network') || name.includes('aborterror') ||
      msg.includes('socket hang up') || msg.includes('enotfound') ||
      msg.includes('epipe')) {
    return 'network';
  }

  // Token/context limit
  if (msg.includes('context length') || msg.includes('maximum context') ||
      msg.includes('token') || msg.includes('too long') ||
      msg.includes('max_tokens') || msg.includes('context_length')) {
    return 'token_limit';
  }

  // Auth errors (don't retry)
  if (msg.includes('401') || msg.includes('403') || msg.includes('unauthorized') ||
      msg.includes('forbidden') || msg.includes('invalid api key')) {
    return 'auth';
  }

  return 'unknown';
}

/**
 * Determine if an error category is retryable
 */
export function isRetryable(category: ErrorCategory): boolean {
  switch (category) {
    case 'rate_limit':
    case 'server_error':
    case 'network':
      return true;
    case 'token_limit':
    case 'auth':
    case 'unknown':
      return false;
  }
}

/**
 * Calculate backoff delay with jitter
 */
export function calculateBackoff(
  attempt: number,
  config: Pick<ResilienceConfig, 'initialBackoffMs' | 'maxBackoffMs' | 'backoffMultiplier'>,
  category?: ErrorCategory,
): number {
  // Rate limits get longer initial backoff
  const base = category === 'rate_limit'
    ? config.initialBackoffMs * 3
    : config.initialBackoffMs;

  const exponential = base * Math.pow(config.backoffMultiplier, attempt);
  const capped = Math.min(exponential, config.maxBackoffMs);

  // Add jitter (±25%)
  const jitter = capped * (0.75 + Math.random() * 0.5);
  return Math.round(jitter);
}

// ============================================================================
// LLM Call Retry Wrapper
// ============================================================================

/**
 * Wrap an async LLM call with retry logic
 */
export async function withLLMRetry<T>(
  fn: () => Promise<T>,
  config: ResilienceConfig = DEFAULT_RESILIENCE_CONFIG,
  opts?: {
    signal?: AbortSignal;
    processId?: string;
    onRetry?: (attempt: number, error: Error, category: ErrorCategory, delayMs: number) => void;
  },
): Promise<RetryResult<T>> {
  const logPrefix = `RESILIENCE[${opts?.processId || 'main'}]`;
  let lastError: Error | undefined;
  let totalDelay = 0;
  let actualAttempts = 0;

  for (let attempt = 0; attempt <= config.maxLLMRetries; attempt++) {
    if (opts?.signal?.aborted) {
      return {
        success: false,
        error: new Error('Aborted'),
        attempts: attempt,
        totalDelayMs: totalDelay,
      };
    }

    try {
      const value = await fn();
      if (attempt > 0) {
        cliLogger.info(logPrefix, `Recovered after ${attempt} retries (total delay: ${totalDelay}ms)`);
      }
      return {
        success: true,
        value,
        attempts: attempt + 1,
        totalDelayMs: totalDelay,
      };
    } catch (err: any) {
      lastError = err;
      actualAttempts = attempt + 1;
      const category = classifyError(err);

      if (attempt >= config.maxLLMRetries || !isRetryable(category)) {
        cliLogger.warn(logPrefix, `Non-retryable error (${category}): ${err.message}`);
        break;
      }

      const delayMs = calculateBackoff(attempt, config, category);
      totalDelay += delayMs;

      cliLogger.info(logPrefix, `Retry ${attempt + 1}/${config.maxLLMRetries} after ${delayMs}ms (${category}): ${err.message.slice(0, 100)}`);
      opts?.onRetry?.(attempt + 1, err, category, delayMs);

      await sleep(delayMs, opts?.signal);
    }
  }

  return {
    success: false,
    error: lastError,
    attempts: actualAttempts,
    totalDelayMs: totalDelay,
  };
}

// ============================================================================
// Process-level Retry
// ============================================================================

export interface ProcessRetryContext {
  pid: string;
  task: string;
  role: string;
  attempt: number;
  maxAttempts: number;
  lastError?: string;
  lastExitReason?: string;
}

/**
 * Determine if a process should be retried based on its failure
 */
export function shouldRetryProcess(ctx: ProcessRetryContext): {
  shouldRetry: boolean;
  reason: string;
  delayMs: number;
} {
  if (ctx.attempt >= ctx.maxAttempts) {
    return { shouldRetry: false, reason: `Max retries reached (${ctx.maxAttempts})`, delayMs: 0 };
  }

  const errorCategory = ctx.lastError
    ? classifyError(new Error(ctx.lastError))
    : 'unknown';

  // Don't retry auth errors
  if (errorCategory === 'auth') {
    return { shouldRetry: false, reason: 'Auth error — credentials invalid', delayMs: 0 };
  }

  // Token limit: retry only makes sense with compaction
  if (errorCategory === 'token_limit') {
    return {
      shouldRetry: true,
      reason: 'Token limit — will retry with compacted context',
      delayMs: 500,
    };
  }

  // Rate limit: retry with longer delay
  if (errorCategory === 'rate_limit') {
    return {
      shouldRetry: true,
      reason: 'Rate limited — backing off',
      delayMs: calculateBackoff(ctx.attempt, DEFAULT_RESILIENCE_CONFIG, 'rate_limit'),
    };
  }

  // Server/network errors: retryable
  if (isRetryable(errorCategory)) {
    return {
      shouldRetry: true,
      reason: `${errorCategory} error — retrying`,
      delayMs: calculateBackoff(ctx.attempt, DEFAULT_RESILIENCE_CONFIG, errorCategory),
    };
  }

  // Budget exhaustion: don't retry (by design)
  if (ctx.lastExitReason?.startsWith('budget_')) {
    return { shouldRetry: false, reason: `Budget exhausted: ${ctx.lastExitReason}`, delayMs: 0 };
  }

  return { shouldRetry: false, reason: `Unknown error type: ${errorCategory}`, delayMs: 0 };
}



// ============================================================================
// Utilities
// ============================================================================

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
