/**
 * AgentResiliencePolicy - Agent 自愈与容错策略
 *
 * 三层韧性：
 * 1. LLM 调用级：429/500/网络错误 → 指数退避重试
 * 2. 进程级：agentLoop 崩溃 → 自动重启（保留上下文）
 * 3. 团队级：Worker 失败 → Leader 决定重派或跳过
 */

import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { ErrorCategory as KernelErrorCategory, classifyError as classifyKernelError } from '@neoxlabs/kernel/types/errors.js';
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

export type ErrorCategory =
  | 'rate_limit'
  | 'server_error'
  | 'network'
  | 'token_limit'
  /** 额度 / 余额 / 用量上限 —— 重试一万次也还是这个结果, 必须让用户去充值或换号. */
  | 'quota_exhausted'
  | 'auth'
  | 'invalid_request'
  | 'unknown';

// ============================================================================
// Error Classification
// ============================================================================

/**
 * kernel 的权威分类 → 本模块的恢复口径。
 *
 * work:H-18 —— 这里以前自己按关键字猜, 于是跟 kernel 打架:
 *   · `quota` 关键字排在 429 判断里 → 「Insufficient Balance」被当成限流, 自动重试到用户放弃;
 *   · 400 / invalid_request 落到 unknown, 界面说不出「请求本身有问题」;
 *   · 401/403 排在 token 判断之后 (旧顺序), 语义上不稳。
 * kernel 的 `classifyError` 已经按与模型侧同一套 rules 判完 (含网关信封 / 402 / 403 余额 / 429 的
 * usage_limit_reached), 这里只做映射, 不再重写判据。
 */
function fromKernelCategory(category: KernelErrorCategory): ErrorCategory | null {
  switch (category) {
    case KernelErrorCategory.RETRYABLE_HTTP:
    case KernelErrorCategory.RETRYABLE_STREAM:
    case KernelErrorCategory.RETRYABLE_NETWORK:
    // 流中断 / 连接问题 = 等一下再来
      return 'network';
    case KernelErrorCategory.RETRYABLE_RATE_LIMIT:
      return 'rate_limit';
    case KernelErrorCategory.FATAL_LIMIT:
      return 'quota_exhausted';
    case KernelErrorCategory.FATAL_AUTH:
      return 'auth';
    case KernelErrorCategory.FATAL_CONTEXT:
      return 'token_limit';
    case KernelErrorCategory.FATAL_INVALID:
      return 'invalid_request';
    case KernelErrorCategory.TOOL_TIMEOUT:
      return 'server_error';
    case KernelErrorCategory.CANCELED:
    case KernelErrorCategory.TOOL_JSON_INVALID:
    case KernelErrorCategory.TOOL_TRUNCATED:
    case KernelErrorCategory.TOOL_DENIED:
      return null;
    case KernelErrorCategory.INTERNAL:
      /* 没识别出来 —— 不当作结论, 交给下方的关键字兜底 (它见过更多旧版网关文案)。 */
      return null;
    default:
      return null;
  }
}

/**
 * 这个错误带了多少「结构性证据」(HTTP 状态码 / errno / 网关信封 / 流错误帧)。
 *
 *   只有带证据时 kernel 的判定才可信: 它认的是状态码与 code, 而不是文案。
 *   纯文本错误 (后台进程只把 lastError 字符串传回来) 必须由关键字兜底来判,
 *   否则一个 '500 Internal Server Error' 也会因为证据不足被判成不可重试。
 */
function hasStructuralEvidence(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, any>;
  if (typeof e.response?.status === 'number') return true;
  if (typeof e.code === 'string' && /^[A-Z][A-Z0-9_]+$|^E[A-Z]+$/.test(e.code)) return true;
  if (e.isStreamError === true) return true;
  if (typeof e.category === 'string') return true; /* 已经是 NeoxError */
  return extractNeoxEnvelopeFromError(err) !== null;
}

/**
 * Classify an error to determine the appropriate recovery strategy.
 *
 *   优先按 NeoxError envelope.code 判定 (网关现在返结构化 code), 找不到再回落 keyword 兜底.
 *   这样 gateway 改文案 / 翻译都不影响 retry 行为, 决策只跟 code 绑定.
 */
export function classifyError(err: Error): ErrorCategory {
  /* work:H-18 — 带结构性证据的错误先问 kernel 的权威分类 (与模型侧 stream/request 重试
   * 同一套判据)。它给不出结论 (INTERNAL) 时继续往下走, 不在这里下判断。 */
  if (hasStructuralEvidence(err)) {
    const fromKernel = fromKernelCategory(classifyKernelError(err).category);
    if (fromKernel) return fromKernel;
  }

  /* 优先: NeoxError envelope (gateway 标准格式) — 用顶部 import 而非动态 require,
   * vitest ESM 环境下 require 在 .ts 模块会失败 (CommonJS / ESM 混用). */
  const envelope = extractNeoxEnvelopeFromError(err);
  if (envelope) {
    const code = envelope.code as string;
    if (code.startsWith('quota.') && code.includes('rate_limit')) return 'rate_limit';
    if (code.startsWith('quota.')) return 'quota_exhausted';
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

  /* 回落: 字符串关键字兜底 (网关老版本 / 第三方 OpenAI 直连 / 后台进程只回传了错误字符串) */
  const msg = err.message?.toLowerCase() || '';
  const name = err.name?.toLowerCase() || '';

  if (/insufficient[ _-]?(quota|balance|credit|funds|points)/.test(msg) ||
      /(quota|balance|credit)[^.]{0,20}(exceeded|exhausted|used up|depleted|insufficient|not enough)/.test(msg) ||
      /exceeded[^.]{0,20}(quota|limit)/.test(msg) ||
      msg.includes('billing hard limit') || msg.includes('insufficient_quota')) {
    return 'quota_exhausted';
  }

  // Rate limiting (429) —— 只认真正可恢复的限流
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('rate_limit')) {
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

  /* work:H-18 — 纯文本里的「额度用尽」: 没有状态码可看, 只能认这几个说法。
   * 放在 token 判断之后: 'usage limit' 里的 token 不在上述列表, 两者不冲突。 */
  if (msg.includes('usage limit') || msg.includes('usage_limit')) {
    return 'quota_exhausted';
  }

  // Auth errors (don't retry)
  if (msg.includes('401') || msg.includes('403') || msg.includes('unauthorized') ||
      msg.includes('forbidden') || msg.includes('invalid api key')) {
    return 'auth';
  }

  if (msg.includes('400') || msg.includes('invalid request') || msg.includes('bad request') ||
      msg.includes('invalid_request') || msg.includes('not supported')) {
    return 'invalid_request';
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
    case 'quota_exhausted':
    case 'auth':
    case 'invalid_request':
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
  /**
   * 已经分好的错误类别 (有的话)。
   *
   * work:H-18 —— 进程重试以前只拿得到一句错误文本: 429 的「额度用完」和 429 的「限流」
   * 在文本里长得一样, 分开不了。调用方手里若已经有分类结果, 就直给, 不要再靠关键字猜。
   */
  errorCategory?: ErrorCategory;
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

  const errorCategory = ctx.errorCategory
    ?? (ctx.lastError ? classifyError(new Error(ctx.lastError)) : 'unknown');

  // Don't retry auth errors
  if (errorCategory === 'auth') {
    return { shouldRetry: false, reason: 'Auth error — credentials invalid', delayMs: 0 };
  }

  /* work:H-18 — 额度 / 余额用完: 重试不会把额度重出来, 只会让用户多等几轮才看到同一句报错。 */
  if (errorCategory === 'quota_exhausted') {
    return { shouldRetry: false, reason: 'Quota exhausted — retrying cannot restore balance', delayMs: 0 };
  }

  // 请求本身不合法 (400 / 参数错 / 模型不支持): 原样重试必错
  if (errorCategory === 'invalid_request') {
    return { shouldRetry: false, reason: 'Invalid request — fix the request instead of retrying', delayMs: 0 };
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
