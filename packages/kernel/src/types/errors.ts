/**
 * Structured Error Classification System
 * Based on OpenAI Codex error handling patterns
 */

import { formatErrorForUI, isHTMLContent } from '../utils/errorFormatter.js';

type ErrorWithCode = {
  message?: string;
  code?: string;
  toolName?: string;
};

/**
 * Error categories for classification
 */
export enum ErrorCategory {
  // Retryable HTTP errors
  RETRYABLE_HTTP = 'retryable_http',           // 429, 5xx
  RETRYABLE_STREAM = 'retryable_stream',       // Stream disconnected, timeout
  RETRYABLE_NETWORK = 'retryable_network',     // Network errors, connection refused
  RETRYABLE_RATE_LIMIT = 'retryable_rate_limit', // 429 或代理 502 (速率限制)

  // Non-retryable errors
  FATAL_AUTH = 'fatal_auth',                   // 401, 403
  FATAL_LIMIT = 'fatal_limit',                 // Quota/usage limit
  FATAL_CONTEXT = 'fatal_context',             // Context window exceeded
  FATAL_INVALID = 'fatal_invalid',             // 400, invalid parameters

  // Tool execution errors
  TOOL_JSON_INVALID = 'tool_json_invalid',     // JSON parse failed
  TOOL_TRUNCATED = 'tool_truncated',           // Stream truncated
  TOOL_TIMEOUT = 'tool_timeout',               // Execution timeout
  TOOL_DENIED = 'tool_denied',                 // User denied

  // Cancellation (user interrupted)
  CANCELED = 'canceled',                       // User canceled request

  // Internal errors
  INTERNAL = 'internal',                       // Unexpected internal errors
}

/**
 * Error context for debugging
 */
export interface ErrorContext {
  httpStatus?: number;
  requestId?: string;
  toolName?: string;
  receivedLength?: number;
  expectedLength?: number;
  rawMessage?: string;
  attempt?: number;
  maxAttempts?: number;
}

/**
 * Structured error interface
 */
export interface StructuredError {
  category: ErrorCategory;
  code: string;
  message: string;
  retryable: boolean;
  retryAfter?: number;  // milliseconds
  context?: ErrorContext;
  originalError?: Error;
}

/**
 * Custom error class with structured data
 */
export class NeoxError extends Error implements StructuredError {
  public readonly category: ErrorCategory;
  public readonly code: string;
  public readonly retryable: boolean;
  public readonly retryAfter?: number;
  public readonly context?: ErrorContext;
  public readonly originalError?: Error;

  constructor(props: StructuredError) {
    super(props.message);
    this.name = 'NeoxError';
    this.category = props.category;
    this.code = props.code;
    this.retryable = props.retryable;
    this.retryAfter = props.retryAfter;
    this.context = props.context;
    this.originalError = props.originalError;

    // Maintains proper stack trace for where error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, NeoxError);
    }
  }

  /**
   * Create a new error with additional context
   */
  withContext(additionalContext: Partial<ErrorContext>): NeoxError {
    return new NeoxError({
      ...this,
      context: { ...this.context, ...additionalContext },
    });
  }

  /**
   * Convert to JSON for logging/serialization
   */
  toJSON(): Record<string, any> {
    return {
      name: this.name,
      category: this.category,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      retryAfter: this.retryAfter,
      context: this.context,
      stack: this.stack,
    };
  }
}

/* ============================================================
 * ErrorCodeRegistry — 前后端公开 contract (C3)
 *
 *   命名空间: <domain>.<reason>, a stable dot-separated error namespace.
 *   每个 code 是稳定 string, 一旦发布不再改 (改 = breaking change).
 *
 *   分类 (前缀):
 *     auth.*      认证 / API key
 *     quota.*     额度 / 计费 / rate limit
 *     network.*   DNS / TLS / 代理 / 连接
 *     upstream.*  上游 (provider gateway) 错
 *     model.*     模型不存在 / 不可用 / 不支持
 *     context.*   上下文长度溢出
 *     tool.*      工具执行错 (denied / timeout / arg invalid)
 *     stream.*    流式响应中断 / 解析失败
 *     internal.*  代码 bug, 不应该到用户
 *     user.*      用户主动 (cancel / abort)
 *
 *   每个条目带 zh + en 默认消息 (后端兜底, 前端 i18n miss 时 fallback 用),
 *   带 category (老 ErrorCategory 兼容), retryable, nextAction (可选 UI 操作)
 * ============================================================ */

/* · 加 'open_providers' — BYOK 用户 apiKey 错时应引导他改自己 provider 的 key,
 * 而不是跳登录 Neox 订阅. 桌面点该 action 直接切到 Settings → API 服务商 tab. */
export type ErrorActionKind = 'topup' | 'login' | 'retry' | 'switch_provider' | 'switch_model' | 'open_logs' | 'contact_support' | 'open_providers';

export interface ErrorCodeSpec {
  /** stable string id, e.g. 'quota.exhausted' */
  code: string;
  category: ErrorCategory;
  retryable: boolean;
  /** 默认消息 — 前端 i18n 缺这条 code 时兜底, 后端独立运行 (CLI / 无 UI) 时也用这个 */
  defaultMessage: { zh: string; en: string };
  /** 给 UI 推荐的下一步 — 例如 quota.* → topup, auth.* → login */
  nextAction?: ErrorActionKind;
}

/**
 * 已注册的 error code (按 namespace 分组).
 *
 * 添加新 code 流程:
 *   1. 在这里加一条 (zh + en + category + retryable)
 *   2. 前端 i18n/errors.ts 加对应的 UI 友好文案 (可比 defaultMessage 更详细 / 带 hint)
 *   3. 后端 throw 处用 NeoxError({ code: 'xxx.yyy', ... }) 即可, 不要再写裸 message
 */
export const ERROR_CODES: Record<string, ErrorCodeSpec> = {
  /* ---------- auth.* 认证 ---------- */
  'auth.invalid_key': {
    code: 'auth.invalid_key',
    category: ErrorCategory.FATAL_AUTH,
    retryable: false,
    defaultMessage: {
      zh: 'API 密钥无效或已被吊销',
      en: 'API key is invalid or has been revoked',
    },
    /* · BYOK 无差异原则: apiKey 错 = 用户自己 provider 配的 key 有问题,
     * 引导去改 provider 而不是跳登录. Neox 订阅用户如果他的 nxk key 被 revoke,
     * useStreamHandler 会自动 re-mint 一次 (见 auth.invalid_key 处理), 用不着弹按钮. */
    nextAction: 'open_providers',
  },
  'auth.expired': {
    code: 'auth.expired',
    category: ErrorCategory.FATAL_AUTH,
    retryable: false,
    defaultMessage: {
      zh: '登录已过期, 请重新登录',
      en: 'Session expired, please log in again',
    },
    nextAction: 'login',
  },
  'auth.forbidden': {
    code: 'auth.forbidden',
    category: ErrorCategory.FATAL_AUTH,
    retryable: false,
    defaultMessage: {
      zh: '没有访问该资源的权限',
      en: 'No permission to access this resource',
    },
  },

  /* ---------- quota.* 额度 / 计费 ---------- */
  'quota.exhausted': {
    code: 'quota.exhausted',
    category: ErrorCategory.FATAL_LIMIT,
    retryable: false,
    defaultMessage: {
      zh: '账户余额不足, 请充值后继续',
      en: 'Account balance exhausted, please top up to continue',
    },
    nextAction: 'topup',
  },
  'quota.rate_limited': {
    code: 'quota.rate_limited',
    category: ErrorCategory.RETRYABLE_RATE_LIMIT,
    retryable: true,
    defaultMessage: {
      zh: '请求过于频繁, 已自动重试',
      en: 'Rate limited, automatically retrying',
    },
  },
  /* 高负载 —— 跟"额度用完"是完全不同的事: 用户没做错任何事, 等一下就好.
   * 文案不能带责备语气, 也不该引导去充值(充值不解决排队). */
  'system.busy': {
    code: 'system.busy',
    category: ErrorCategory.RETRYABLE_RATE_LIMIT,
    retryable: true,
    defaultMessage: {
      zh: '当前使用人数较多, 正在重试',
      en: 'High demand right now, retrying',
    },
    /* 等待之外唯一真正管用的动作 —— 换个模型立刻能继续. */
    nextAction: 'switch_model',
  },
  'upstream.circuit_open': {
    code: 'upstream.circuit_open',
    category: ErrorCategory.RETRYABLE_RATE_LIMIT,
    retryable: true,
    defaultMessage: {
      zh: '该模型的线路暂时不可用, 正在切换',
      en: 'This model route is temporarily unavailable, switching',
    },
    nextAction: 'switch_model',
  },
  /* 这个模型没有能干这件事的路由 (最典型: 发了图, 而它一条路由都不吃图).
   *
   * 跟 upstream.circuit_open 长得像但**必须不可重试**: 熔断等一等就好, 能力不匹配
   * 等到天亮也一样。 线上: 网关把这种情况混在 circuit_open 里报 503 retryable,
   * 桌面端 4 秒后原样重发, 再 503 —— 用户看到的是"服务不稳定", 而真相是换个模型立刻就好。 */
  'model.capability_unsupported': {
    code: 'model.capability_unsupported',
    category: ErrorCategory.FATAL_INVALID,
    retryable: false,
    defaultMessage: {
      zh: '当前模型不支持这次请求用到的能力(例如图片输入), 换一个支持的模型',
      en: 'This model does not support a capability used by the request (e.g. image input) — switch models',
    },
    nextAction: 'switch_model',
  },
  'quota.daily_cap': {
    code: 'quota.daily_cap',
    category: ErrorCategory.FATAL_LIMIT,
    retryable: false,
    defaultMessage: {
      zh: '已达今日额度上限, 请明日再试或升级套餐',
      en: 'Daily quota reached, try tomorrow or upgrade plan',
    },
    nextAction: 'topup',
  },

  /* ---------- network.* 网络 ---------- */
  'network.timeout': {
    code: 'network.timeout',
    category: ErrorCategory.RETRYABLE_NETWORK,
    retryable: true,
    defaultMessage: {
      zh: '网络请求超时',
      en: 'Network request timed out',
    },
    nextAction: 'retry',
  },
  'network.unreachable': {
    code: 'network.unreachable',
    category: ErrorCategory.RETRYABLE_NETWORK,
    retryable: true,
    defaultMessage: {
      zh: '无法连接到服务器, 请检查网络',
      en: 'Cannot reach server, please check your network',
    },
    nextAction: 'retry',
  },
  'network.dns': {
    code: 'network.dns',
    category: ErrorCategory.RETRYABLE_NETWORK,
    retryable: true,
    defaultMessage: {
      zh: '域名解析失败, 请检查网络或代理',
      en: 'DNS lookup failed, check network or proxy',
    },
  },
  'network.tls': {
    code: 'network.tls',
    category: ErrorCategory.RETRYABLE_NETWORK,
    retryable: true,
    defaultMessage: {
      zh: 'TLS 握手失败',
      en: 'TLS handshake failed',
    },
  },
  'network.proxy_unreachable': {
    code: 'network.proxy_unreachable',
    category: ErrorCategory.RETRYABLE_NETWORK,
    retryable: true,
    defaultMessage: {
      zh: '代理服务器不可达, 请检查 HTTPS_PROXY 设置',
      en: 'Proxy unreachable, check HTTPS_PROXY setting',
    },
  },

  /* ---------- upstream.* 上游 ---------- */
  'upstream.server_error': {
    code: 'upstream.server_error',
    category: ErrorCategory.RETRYABLE_HTTP,
    retryable: true,
    defaultMessage: {
      zh: '上游服务异常',
      en: 'Upstream service error',
    },
    nextAction: 'retry',
  },
  'upstream.bad_gateway': {
    code: 'upstream.bad_gateway',
    category: ErrorCategory.RETRYABLE_HTTP,
    retryable: true,
    defaultMessage: {
      zh: '上游网关错误',
      en: 'Upstream bad gateway',
    },
  },
  'upstream.unavailable': {
    code: 'upstream.unavailable',
    category: ErrorCategory.RETRYABLE_HTTP,
    retryable: true,
    defaultMessage: {
      zh: '上游服务暂时不可用',
      en: 'Upstream service unavailable',
    },
  },

  /* ---------- model.* 模型 ---------- */
  'model.not_found': {
    code: 'model.not_found',
    category: ErrorCategory.FATAL_INVALID,
    retryable: false,
    defaultMessage: {
      zh: '指定的模型不存在',
      en: 'Specified model not found',
    },
    nextAction: 'switch_provider',
  },
  'model.unsupported': {
    code: 'model.unsupported',
    category: ErrorCategory.FATAL_INVALID,
    retryable: false,
    defaultMessage: {
      zh: '该模型不支持此操作',
      en: 'Model does not support this operation',
    },
  },
  'model.input_too_large': {
    code: 'model.input_too_large',
    category: ErrorCategory.FATAL_CONTEXT,
    retryable: false,
    defaultMessage: {
      zh: '输入超过模型上下文上限, 请精简后重试',
      en: 'Input exceeds model context limit, please shorten and retry',
    },
  },

  /* ---------- context.* 上下文 ---------- */
  'context.exceeded': {
    code: 'context.exceeded',
    category: ErrorCategory.FATAL_CONTEXT,
    retryable: false,
    defaultMessage: {
      zh: '会话上下文已满, 已自动压缩仍超限',
      en: 'Conversation context exceeded after auto-compression',
    },
  },

  /* ---------- tool.* 工具 ---------- */
  'tool.denied': {
    code: 'tool.denied',
    category: ErrorCategory.TOOL_DENIED,
    retryable: false,
    defaultMessage: {
      zh: '工具调用已被拒绝',
      en: 'Tool call was denied',
    },
  },
  'tool.timeout': {
    code: 'tool.timeout',
    category: ErrorCategory.TOOL_TIMEOUT,
    retryable: true,
    defaultMessage: {
      zh: '工具执行超时',
      en: 'Tool execution timed out',
    },
    nextAction: 'retry',
  },
  'tool.invalid_args': {
    code: 'tool.invalid_args',
    category: ErrorCategory.TOOL_JSON_INVALID,
    retryable: false,
    defaultMessage: {
      zh: '工具参数无效或解析失败',
      en: 'Tool arguments invalid or failed to parse',
    },
  },
  'tool.execution_failed': {
    code: 'tool.execution_failed',
    category: ErrorCategory.INTERNAL,
    retryable: false,
    defaultMessage: {
      zh: '工具执行失败',
      en: 'Tool execution failed',
    },
  },
  'tool.denied_by_skill_scope': {
    code: 'tool.denied_by_skill_scope',
    category: ErrorCategory.TOOL_DENIED,
    retryable: false,
    defaultMessage: {
      zh: '当前 skill 不允许调此工具',
      en: 'Active skill does not permit this tool',
    },
  },

  /* ---------- stream.* 流式 ---------- */
  'stream.disconnected': {
    code: 'stream.disconnected',
    category: ErrorCategory.RETRYABLE_STREAM,
    retryable: true,
    defaultMessage: {
      zh: '流式响应中断, 正在自动重连',
      en: 'Stream disconnected, automatically reconnecting',
    },
  },
  'stream.malformed': {
    code: 'stream.malformed',
    category: ErrorCategory.RETRYABLE_STREAM,
    retryable: true,
    defaultMessage: {
      zh: '流式响应格式错误',
      en: 'Malformed stream response',
    },
  },

  /* ---------- user.* 用户主动 ---------- */
  'user.canceled': {
    code: 'user.canceled',
    category: ErrorCategory.CANCELED,
    retryable: false,
    defaultMessage: {
      zh: '操作已取消',
      en: 'Operation canceled',
    },
  },

  /* ---------- config.* 用户配置 (设置 UI / providerStore 校验) ----------
   *   这些 code 的 i18n 文案故意不在 i18n/errors.ts 注册 — providerStore 抛错时
   *   message 里已含具体值 (e.g. 'Provider "foo" does not exist'), translateError
   *   会回落到 backendMessage 保留这个具体名. */
  'config.invalid_id': {
    code: 'config.invalid_id',
    category: ErrorCategory.FATAL_INVALID,
    retryable: false,
    defaultMessage: { zh: 'Provider ID 不合法', en: 'Provider ID is invalid' },
  },
  'config.provider_not_found': {
    code: 'config.provider_not_found',
    category: ErrorCategory.FATAL_INVALID,
    retryable: false,
    defaultMessage: { zh: '指定的 provider 不存在', en: 'Provider not found' },
  },
  'config.provider_exists': {
    code: 'config.provider_exists',
    category: ErrorCategory.FATAL_INVALID,
    retryable: false,
    defaultMessage: { zh: 'Provider ID 已存在', en: 'Provider ID already exists' },
  },
  'config.model_not_found': {
    code: 'config.model_not_found',
    category: ErrorCategory.FATAL_INVALID,
    retryable: false,
    defaultMessage: { zh: '指定的模型在该 provider 下不存在', en: 'Model not found for this provider' },
  },
  'config.model_exists': {
    code: 'config.model_exists',
    category: ErrorCategory.FATAL_INVALID,
    retryable: false,
    defaultMessage: { zh: '模型已存在', en: 'Model already exists' },
  },
  'config.field_required': {
    code: 'config.field_required',
    category: ErrorCategory.FATAL_INVALID,
    retryable: false,
    defaultMessage: { zh: '必填字段缺失', en: 'Required field missing' },
  },
  'config.empty_models': {
    code: 'config.empty_models',
    category: ErrorCategory.FATAL_INVALID,
    retryable: false,
    defaultMessage: { zh: '至少需要一个模型', en: 'At least one model is required' },
  },

  /* ---------- internal.* 内部 (不应该出现给用户) ---------- */
  'internal.unknown': {
    code: 'internal.unknown',
    category: ErrorCategory.INTERNAL,
    retryable: false,
    defaultMessage: {
      zh: '内部错误, 请查看日志',
      en: 'Internal error, please check logs',
    },
    nextAction: 'open_logs',
  },
  'internal.config_invalid': {
    code: 'internal.config_invalid',
    category: ErrorCategory.INTERNAL,
    retryable: false,
    defaultMessage: {
      zh: '配置文件无效或损坏',
      en: 'Configuration file is invalid or corrupted',
    },
  },
};

/**
 * 老 UPPERCASE_CODE → 新 dot-namespace code 别名表.
 *
 *   classifyError() 内部产 'HTTP_429' / 'QUOTA_EXCEEDED' 这种旧 code, 现在统一映射到新命名空间.
 *   旧 code 字符串仍接受, 调用方代码不用一次性改完.
 */
export const ERROR_CODE_ALIASES: Record<string, string> = {
  HTTP_429: 'quota.rate_limited',
  /* Go 网关自成一套词表, 与 kernel 规范码差一个词尾/前缀. 不对齐的话这几个高负载
   * 相关的错误在客户端全部落到通用兜底文案 —— 用户看到的是一句看不出该怎么办的报错,
   * 而这恰恰是最需要好好解释的场景(高峰期人人都会遇到). */
  'quota.rate_limit': 'quota.rate_limited',
  'upstream.rate_limited': 'quota.rate_limited',
  'system.busy': 'system.busy',
  'upstream.circuit_open': 'upstream.circuit_open',
  'model.capability_unsupported': 'model.capability_unsupported',
  HTTP_5xx: 'upstream.server_error',
  HTTP_500: 'upstream.server_error',
  HTTP_502: 'upstream.bad_gateway',
  HTTP_503: 'upstream.unavailable',
  HTTP_504: 'network.timeout',
  PROXY_502: 'upstream.bad_gateway',
  PROXY_503: 'upstream.unavailable',
  PROXY_UPSTREAM_FAILED: 'upstream.server_error',
  UNAUTHORIZED: 'auth.invalid_key',
  FORBIDDEN: 'auth.forbidden',
  CONTEXT_WINDOW_EXCEEDED: 'context.exceeded',
  QUOTA_EXCEEDED: 'quota.exhausted',
  /* Map balance exhaustion to the quota guidance used by related provider limits. */
  INSUFFICIENT_BALANCE: 'quota.exhausted',
  USAGE_LIMIT_REACHED: 'quota.daily_cap',
  TIMEOUT: 'network.timeout',
  CONNECT_TIMEOUT: 'network.unreachable',
  ECONNREFUSED: 'network.unreachable',
  ENOTFOUND: 'network.dns',
  EPIPE: 'stream.disconnected',
  /* ECONNRESET shares the disconnected-stream recovery guidance with EPIPE. */
  ECONNRESET: 'stream.disconnected',
  TOOL_ARGS_TRUNCATED: 'tool.invalid_args',
  TOOL_MISSING_CONTENT: 'tool.execution_failed',
  TOOL_ERROR: 'tool.execution_failed',
  CANCELED: 'user.canceled',
  UNKNOWN: 'internal.unknown',
};

/** 给任意 code (新 dot-namespace 或老 UPPERCASE) 解析到 spec. 找不到返 undefined. */
export function lookupErrorCode(code: string | undefined): ErrorCodeSpec | undefined {
  if (!code) return undefined;
  if (ERROR_CODES[code]) return ERROR_CODES[code];
  const alias = ERROR_CODE_ALIASES[code];
  if (alias && ERROR_CODES[alias]) return ERROR_CODES[alias];
  return undefined;
}

/** code → 当前 language 的默认消息. 给 CLI / 没接 i18n 的后端用. */
export function getDefaultMessage(code: string | undefined, language: 'zh' | 'en' = 'zh', fallback?: string): string {
  const spec = lookupErrorCode(code);
  if (spec) return spec.defaultMessage[language];
  return fallback ?? code ?? (language === 'zh' ? '未知错误' : 'Unknown error');
}

/**
 * Parse Retry-After header value
 * Supports multiple formats:
 * - Seconds (integer): "5"
 * - HTTP-date: "Wed, 21 Oct 2015 07:28:00 GMT"
 * - Milliseconds (non-standard): "5000ms" or retry-after-ms header
 * - Decimal seconds: "2.5"
 */
export function parseRetryAfter(value: string | undefined | null): number | undefined {
  if (!value) return undefined;

  // 确保 value 是字符串类型
  if (typeof value !== 'string') {
    // 如果是数字，直接当作秒数处理
    if (typeof value === 'number' && value > 0) {
      return Math.ceil(value * 1000);
    }
    return undefined;
  }

  const trimmed = value.trim();

  // Try parsing as milliseconds (non-standard format: "5000ms")
  const msMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*ms$/i);
  if (msMatch) {
    const ms = parseFloat(msMatch[1]);
    return ms > 0 ? Math.ceil(ms) : undefined;
  }

  // Try parsing as seconds (integer or decimal)
  const seconds = parseFloat(trimmed);
  if (!isNaN(seconds) && seconds > 0) {
    return Math.ceil(seconds * 1000); // Convert to milliseconds
  }

  // Try parsing as HTTP-date
  const date = new Date(trimmed);
  if (!isNaN(date.getTime())) {
    const delayMs = date.getTime() - Date.now();
    return delayMs > 0 ? Math.ceil(delayMs) : undefined;
  }

  return undefined;
}

/**
 * 获取代理错误的默认重试延迟
 * 代理 502/503/504 通常是速率限制，需要更长的等待时间
 */
export function getDefaultProxyRetryDelay(status: number): number {
  switch (status) {
    case 502: // Bad Gateway - 代理无法连接上游，可能是速率限制
      return 3000; // 3 秒
    case 503: // Service Unavailable - 服务过载
      return 5000; // 5 秒
    case 504: // Gateway Timeout - 上游响应超时
      return 2000; // 2 秒
    default:
      return 2000; // 默认 2 秒
  }
}

/**
 * Parse retry-after from response headers
 * Checks multiple header names (standard and non-standard)
 */
export function parseRetryAfterFromHeaders(headers: Record<string, string> | undefined): number | undefined {
  if (!headers) return undefined;

  // 标准 Retry-After 头
  const retryAfter = headers['retry-after'] || headers['Retry-After'];
  if (retryAfter) {
    const parsed = parseRetryAfter(retryAfter);
    if (parsed) return parsed;
  }

  // 非标准 retry-after-ms 头 (Anthropic SDK 使用)
  const retryAfterMs = headers['retry-after-ms'] || headers['Retry-After-Ms'];
  if (retryAfterMs) {
    const ms = parseFloat(retryAfterMs);
    if (!isNaN(ms) && ms > 0) {
      return Math.ceil(ms);
    }
  }

  // x-ratelimit-reset-requests 头 (某些 API 使用)
  const resetRequests = headers['x-ratelimit-reset-requests'];
  if (resetRequests) {
    const parsed = parseRetryAfter(resetRequests);
    if (parsed) return parsed;
  }

  // Anthropic 专用头
  const anthropicReset = headers['anthropic-ratelimit-requests-reset'];
  if (anthropicReset) {
    const resetTime = new Date(anthropicReset);
    if (!isNaN(resetTime.getTime())) {
      const delayMs = resetTime.getTime() - Date.now();
      return delayMs > 0 ? Math.ceil(delayMs) : undefined;
    }
  }

  return undefined;
}

/**
 * Check if error is an Axios-like error
 */
function isAxiosLikeError(error: unknown): error is {
  response?: { status?: number; headers?: Record<string, string>; data?: any };
  message: string;
  code?: string;
} {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message?: unknown }).message === 'string'
  );
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null
    ? (error as ErrorWithCode).code
    : undefined;
}

function getErrorToolName(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null
    ? (error as ErrorWithCode).toolName
    : undefined;
}

/**
 * Check if error message indicates context window exceeded
 */
function isContextWindowError(message: string): boolean {
  const patterns = [
    /context.*window.*exceeded/i,
    /context.*length.*exceeded/i,
    /maximum.*context.*length/i,
    /token.*limit.*exceeded/i,
    /input.*too.*long/i,
  ];
  return patterns.some(pattern => pattern.test(message));
}

/**
 * Check if error message indicates quota/usage limit
 */
function isQuotaError(message: string): boolean {
  const patterns = [
    /quota.*exceeded/i,
    /usage.*limit/i,
    /rate.*limit/i,
    /insufficient.*quota/i,
    /billing/i,
  ];
  return patterns.some(pattern => pattern.test(message));
}

function extractApiErrorMessage(data: any): string | undefined {
  if (!data) return undefined;

  if (typeof data === 'string') {
    return data;
  }

  if (typeof data === 'object') {
    if (typeof data.error === 'string') {
      return data.error;
    }

    if (data.error?.message) {
      return data.error.message;
    }

    if (data.message) {
      return data.message;
    }
  }

  return undefined;
}

/**
 * Classify an error into a StructuredError
 */
/** UI 上一条错误最多显示这么多字 —— 再长就不是"错误提示"而是"日志转储"了。 */
const MAX_UI_ERROR_MESSAGE = 400;

/**
 * 上游响应体 → 一句能看的错误文案。
 *
 *   两件事:
 *     1. HTML 错误页 → 抽出状态码 / 标题 / 主机名, 其余全扔 (formatErrorForUI 干这活)
 *     2. 任何仍然过长的 body (超大 JSON、堆栈、日志) → 截断
 *   原始内容不销毁, 调用方会把它放进 context.rawMessage。
 */
export function sanitizeUpstreamErrorMessage(raw: string, status?: number): string {
  const text = String(raw ?? '');
  if (!text) return text;

  if (isHTMLContent(text)) {
    const formatted = formatErrorForUI(text, status);
    const parts = [formatted.message, formatted.detail].filter(Boolean);
    const cleaned = parts.join('\n').trim();
    /* 抽不出任何东西时也**绝不**回退到原文 —— 那正是整页 HTML 进 UI 的那条路。 */
    return cleaned || (status ? `上游返回了一个 HTML 错误页 (HTTP ${status})` : '上游返回了一个 HTML 错误页');
  }

  if (text.length > MAX_UI_ERROR_MESSAGE) {
    return `${text.slice(0, MAX_UI_ERROR_MESSAGE)}…`;
  }
  return text;
}

export function classifyError(error: unknown): NeoxError {
  // Already a NeoxError
  if (error instanceof NeoxError) {
    return error;
  }

  // Standard Error
  const errorMessage = error instanceof Error ? error.message : String(error);
  const originalError = error instanceof Error ? error : undefined;
  const axiosError = isAxiosLikeError(error) ? error : undefined;
  const apiMessage = axiosError ? extractApiErrorMessage(axiosError.response?.data) : undefined;
  const rawNormalizedMessage = apiMessage || errorMessage;
  /* Normalize upstream HTML and oversized bodies once before status-specific
   * classification; retain the original payload in context for diagnostics. */
  const normalizedMessage = sanitizeUpstreamErrorMessage(rawNormalizedMessage, axiosError?.response?.status);

  // HTTP/Axios-like errors
  if (axiosError?.response?.status) {
    const status = axiosError.response.status;
    const retryAfter = parseRetryAfterFromHeaders(axiosError.response.headers);
    const requestId = axiosError.response.headers?.['x-request-id'] ||
      axiosError.response.headers?.['cf-ray'];

    /* All HTTP branches share status, request identity, and the original message when
     * normalization changed the user-facing text. */
    const httpCtx = (extra?: Record<string, unknown>) => ({
      httpStatus: status,
      requestId,
      ...(rawNormalizedMessage !== normalizedMessage ? { rawMessage: rawNormalizedMessage } : {}),
      ...extra,
    });

    /* Neox gateway envelope ({ error: { code, retryable, message, ... } }) — 信网关的判断, 别再做关键字猜.
     * 这里很关键: quota.* / auth.* / model.* 都是终态错误, 不能让 stream-retry 把它们当 429 重连掉. */
    const envelope = axiosError.response.data?.error;
    const envelopeCode = typeof envelope?.code === 'string' ? envelope.code : undefined;
    const isNeoxEnvelope = envelopeCode != null && /^(auth|quota|model|upstream|request|system)\./.test(envelopeCode);
    if (isNeoxEnvelope) {
      const envelopeRetryable = envelope.retryable === true;
      const category =
        /* quota.rate_limited 必须先于 quota.* 前缀判定 — 它是"等一等就好"的限流
         * (ERROR_CODES 注册表里 retryable:true), 归 FATAL_LIMIT 会让退避策略退化成
         * 通用短退避、且不走 429 专用重试分桶。 */
        envelopeCode === 'quota.rate_limited' ? ErrorCategory.RETRYABLE_RATE_LIMIT :
        envelopeCode.startsWith('quota.') ? ErrorCategory.FATAL_LIMIT :
        envelopeCode.startsWith('auth.') ? ErrorCategory.FATAL_AUTH :
        envelopeCode.startsWith('model.') ? ErrorCategory.FATAL_INVALID :
        envelopeCode.startsWith('request.') ? ErrorCategory.FATAL_INVALID :
        envelopeCode.startsWith('upstream.rate_limited') ? ErrorCategory.RETRYABLE_RATE_LIMIT :
        envelopeCode.startsWith('upstream.') ? ErrorCategory.RETRYABLE_HTTP :
        envelopeCode.startsWith('system.') ? ErrorCategory.RETRYABLE_HTTP :
        ErrorCategory.INTERNAL;
      return new NeoxError({
        category,
        code: `HTTP_${status}`,
        message: envelope.message || normalizedMessage,
        retryable: envelopeRetryable,
        retryAfter,
        context: httpCtx({ requestId: envelope.requestId || requestId, rawMessage: envelopeCode }),
        originalError,
      });
    }

    // 429 Too Many Requests
    if (status === 429) {
      // Check if it's a quota/billing issue (not retryable)
      const responseData = axiosError.response.data;
      const errorType = responseData?.error?.type;

      if (errorType === 'usage_limit_reached' || errorType === 'usage_not_included') {
        return new NeoxError({
          category: ErrorCategory.FATAL_LIMIT,
          code: 'USAGE_LIMIT_REACHED',
          message: responseData?.error?.message || 'Usage limit reached',
          retryable: false,
          context: httpCtx(),
          originalError,
        });
      }

      // Regular rate limit (retryable)
      /* 发布审计: 裸 429 归 RETRYABLE_RATE_LIMIT (原 RETRYABLE_HTTP)。
       * 该 category 的注释本来就写着 "429 或代理 502", 但真 429 一直走通用桶:
       * - 退避退化成 1s/2s/4s cap 4s 短退避, 限流窗口内反复撞墙;
       * - 不进 runner 的 429 专用重试分桶 (tryRateLimitRetry, 上限 8), 反而烧穿
       *   20 次通用预算, 长限流后连 prompt_too_long 压缩恢复的预算都没了。
       * ERROR_CODE_ALIASES 里 HTTP_429 → quota.rate_limited 也早已按限流语义注册。 */
      return new NeoxError({
        category: ErrorCategory.RETRYABLE_RATE_LIMIT,
        code: `HTTP_${status}`,
        message: normalizedMessage,
        retryable: true,
        retryAfter,
        context: httpCtx(),
        originalError,
      });
    }

    // 502/503/504 - 代理/网关错误，通常是中转站速率限制导致
    // 使用专门的速率限制类别，以便使用更长的重试间隔
    if (status === 502 || status === 503 || status === 504) {
      /* HTML 清洗已经在 normalizedMessage 那一步统一做掉了 (见那里的说明), 这里不再重复。 */
      const cleanMessage = normalizedMessage;

      const upstreamCode = axiosError.response.data?.error?.code;
      if (upstreamCode === 'model_not_found' || /no available channels? for model/i.test(cleanMessage)) {
        return new NeoxError({
          category: ErrorCategory.FATAL_INVALID,
          code: 'MODEL_NOT_SUPPORTED',
          message: cleanMessage,
          retryable: false,
          context: httpCtx(),
          originalError,
        });
      }

      // 对于代理错误，使用更长的默认重试间隔
      // 因为中转站的速率限制恢复可能需要更长时间
      const proxyRetryAfter = retryAfter || getDefaultProxyRetryDelay(status);

      return new NeoxError({
        category: ErrorCategory.RETRYABLE_RATE_LIMIT,
        code: `PROXY_${status}`,
        message: cleanMessage || `API 代理服务暂时不可用 (${status})`,
        retryable: true,
        retryAfter: proxyRetryAfter,
        context: httpCtx(),
        originalError,
      });
    }

    // 其他 5xx Server errors (retryable)
    if (status >= 500) {
      /* 同上: 清洗在 normalizedMessage 那一步已完成。 */
      const cleanMessage = normalizedMessage;

      return new NeoxError({
        category: ErrorCategory.RETRYABLE_HTTP,
        code: `HTTP_${status}`,
        message: cleanMessage,
        retryable: true,
        retryAfter,
        context: httpCtx(),
        originalError,
      });
    }

    // 401 Unauthorized
    if (status === 401) {
      /* A 401 message that explicitly identifies an unsupported or missing model is
       * classified as a model capability error; other 401 responses remain auth errors. */
      const lower401 = (normalizedMessage || '').toLowerCase();
      const isModelError = /\bmodel\b/.test(lower401)
        && /(not\s+supported|unsupported|not\s+found|does\s+not\s+exist|no\s+such\s+model)/.test(lower401);
      if (isModelError) {
        return new NeoxError({
          category: ErrorCategory.FATAL_INVALID,
          code: 'MODEL_NOT_SUPPORTED',
          message: normalizedMessage,
          retryable: false,
          context: httpCtx(),
          originalError,
        });
      }
      return new NeoxError({
        category: ErrorCategory.FATAL_AUTH,
        code: 'UNAUTHORIZED',
        message: normalizedMessage || 'Authentication failed. Please check your API key.',
        retryable: false,
        context: httpCtx(),
        originalError,
      });
    }

    // 403 Forbidden
    if (status === 403) {
      /* Provider quota and balance keywords map 403 responses to the limit guidance;
       * other 403 responses retain the authentication classification. */
      const lower = (normalizedMessage || '').toLowerCase();
      const isQuotaLike = /\b(insufficient|balance|credit|quota|payment|no\s+more\s+credit|insufficient_quota)\b/.test(lower);
      if (isQuotaLike) {
        return new NeoxError({
          category: ErrorCategory.FATAL_LIMIT,
          code: 'QUOTA_EXCEEDED',
          message: normalizedMessage || 'Provider quota / balance exhausted.',
          retryable: false,
          context: httpCtx(),
          originalError,
        });
      }
      return new NeoxError({
        category: ErrorCategory.FATAL_AUTH,
        code: 'FORBIDDEN',
        message: normalizedMessage || 'Access denied. Please check your API permissions.',
        retryable: false,
        context: httpCtx(),
        originalError,
      });
    }

    // 402 Payment Required — 余额不足 (DeepSeek 等官方 API 常用)
    if (status === 402) {
      return new NeoxError({
        category: ErrorCategory.FATAL_LIMIT,
        code: 'INSUFFICIENT_BALANCE',
        message: normalizedMessage || 'Insufficient Balance',
        retryable: false,
        context: httpCtx(),
        originalError,
      });
    }

    // 400 Bad Request
    if (status === 400) {
      // Check for context window error
      if (isContextWindowError(errorMessage)) {
        return new NeoxError({
          category: ErrorCategory.FATAL_CONTEXT,
          code: 'CONTEXT_WINDOW_EXCEEDED',
          message: 'Context window exceeded. Please start a new conversation or clear history.',
          retryable: false,
          context: httpCtx(),
          originalError,
        });
      }

      //  代理上游请求失败 - 这是可重试的
      // Proxy upstream failure - this is retryable
      // 常见于代理服务（如 privnode.com）转发请求到 Anthropic 时出现临时问题
      if (normalizedMessage.includes('Upstream request failed') ||
        normalizedMessage.includes('upstream') ||
        normalizedMessage.includes('gateway')) {
        return new NeoxError({
          category: ErrorCategory.RETRYABLE_HTTP,
          code: 'PROXY_UPSTREAM_FAILED',
          message: normalizedMessage || 'Proxy upstream request failed',
          retryable: true,
          context: httpCtx(),
          originalError,
        });
      }

      return new NeoxError({
        category: ErrorCategory.FATAL_INVALID,
        code: 'INVALID_REQUEST',
        message: normalizedMessage,
        retryable: false,
        context: httpCtx(),
        originalError,
      });
    }

    // Other 4xx errors
    if (status >= 400 && status < 500) {
      const lower = (normalizedMessage || '').toLowerCase();
      const isQuotaLike = /\b(insufficient|balance|credit|quota|payment|no\s+more\s+credit|insufficient_quota)\b/.test(lower);
      if (isQuotaLike) {
        return new NeoxError({
          category: ErrorCategory.FATAL_LIMIT,
          code: status === 402 ? 'INSUFFICIENT_BALANCE' : 'QUOTA_EXCEEDED',
          message: normalizedMessage || 'Provider quota / balance exhausted.',
          retryable: false,
          context: httpCtx(),
          originalError,
        });
      }
      return new NeoxError({
        category: ErrorCategory.FATAL_INVALID,
        code: `HTTP_${status}`,
        message: normalizedMessage,
        retryable: false,
        context: httpCtx(),
        originalError,
      });
    }
  }

  // Canceled errors (user interrupt via AbortController)
  if (isAxiosLikeError(error)) {
    const code = error.code;
    const errorName = (error as Error).name;

    // Axios CanceledError (ERR_CANCELED) or native AbortError
    if (code === 'ERR_CANCELED' || errorName === 'CanceledError' || errorName === 'AbortError') {
      return new NeoxError({
        category: ErrorCategory.CANCELED,
        code: 'CANCELED',
        message: 'Request was canceled',
        retryable: false,
        originalError,
      });
    }

    /* EPIPE = 写已断开的 socket / pipe — 流式 SSE 中途上游或反代关连接是高频触发点.
     * 跟 ECONNRESET 同类, 必须归 RETRYABLE_NETWORK, 否则 UI 显示成 UNKNOWN + 裸 `write EPIPE`. */
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET' || code === 'EPIPE') {
      return new NeoxError({
        category: ErrorCategory.RETRYABLE_NETWORK,
        code: code,
        message: `Network error: ${errorMessage}`,
        retryable: true,
        originalError,
      });
    }

    if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || code === 'ECONNABORTED') {
      return new NeoxError({
        category: ErrorCategory.RETRYABLE_NETWORK,
        code: 'TIMEOUT',
        message: `Connection timeout: ${errorMessage}`,
        retryable: true,
        originalError,
      });
    }
  }

  // Native AbortError (not wrapped in Axios)
  if (error instanceof Error && error.name === 'AbortError') {
    return new NeoxError({
      category: ErrorCategory.CANCELED,
      code: 'CANCELED',
      message: 'Request was canceled',
      retryable: false,
      originalError: error,
    });
  }

  /* Map the tool envelope timeout code to the retryable tool-timeout category. */
  {
    const rawCode = getErrorCode(error);
    if (rawCode === 'tool_timeout' || rawCode === 'TOOL_TIMEOUT') {
      return new NeoxError({
        category: ErrorCategory.TOOL_TIMEOUT,
        code: 'tool.timeout',
        message: errorMessage || 'Tool execution timed out',
        retryable: true,
        originalError,
      });
    }
  }

  // Stream incomplete errors (network interruption)
  // 检测流不完整错误（网络中断导致）
  if (getErrorCode(error) === 'STREAM_INCOMPLETE') {
    return new NeoxError({
      category: ErrorCategory.RETRYABLE_STREAM,
      code: 'STREAM_INCOMPLETE',
      message: `网络中断: ${errorMessage}`,
      retryable: true,
      context: {
        toolName: getErrorToolName(error),
        rawMessage: errorMessage,
      },
      originalError,
    });
  }

  // Stream timeout errors (proxy not responding)
  // 检测流超时错误（代理服务器不响应）
  if (getErrorCode(error) === 'STREAM_TIMEOUT') {
    return new NeoxError({
      category: ErrorCategory.RETRYABLE_STREAM,
      code: 'STREAM_TIMEOUT',
      message: `API 代理响应超时: ${errorMessage}`,
      retryable: true,
      context: {
        rawMessage: errorMessage,
      },
      originalError,
    });
  }

  // Stream idle timeout (no data received for extended period)
  // 流空闲超时（长时间未收到数据）
  if (getErrorCode(error) === 'STREAM_IDLE_TIMEOUT') {
    return new NeoxError({
      category: ErrorCategory.RETRYABLE_STREAM,
      code: 'STREAM_IDLE_TIMEOUT',
      message: `流空闲超时: ${errorMessage}`,
      retryable: true,
      context: {
        rawMessage: errorMessage,
      },
      originalError,
    });
  }

  //  Connect timeout — axios 内部 timeout 可能因 socket 异常而失效
  // 由 Promise.race 安全超时兜底触发
  if (getErrorCode(error) === 'NEOX_CONNECT_TIMEOUT') {
    return new NeoxError({
      category: ErrorCategory.RETRYABLE_NETWORK,
      code: 'CONNECT_TIMEOUT',
      message: `连接超时 (axios timeout 可能泄漏): ${errorMessage}`,
      retryable: true,
      context: {
        rawMessage: errorMessage,
      },
      originalError,
    });
  }

  // EMPTY_STREAM means the upstream returned no valid SSE frames. Treat it as a
  // non-retryable configuration or protocol error rather than a network disconnect.
  if (getErrorCode(error) === 'EMPTY_STREAM') {
    const looksHtml = /text\/html/i.test(errorMessage);
    /* 文案克制 (需求： "错误不要废话太多"): 一句话结论 + 紧凑诊断, 不写教程。 */
    const hint = looksHtml
      ? '上游返回了网页而非 API 响应 — 检查服务商 Base URL (常见: 缺 /v1) 或协议。'
      : '上游返回空响应 — 检查服务商 Base URL / 协议 / 本机代理。';
    return new NeoxError({
      category: ErrorCategory.FATAL_INVALID,
      code: 'EMPTY_STREAM',
      message: `${hint}\n${errorMessage}`,
      retryable: false,
      originalError,
    });
  }

  /* Keep deterministic classifications before the broad stream-message matcher so
   * context and configuration errors are not retried as network disconnects. */

  // Context window errors in message
  if (isContextWindowError(errorMessage)) {
    return new NeoxError({
      category: ErrorCategory.FATAL_CONTEXT,
      code: 'CONTEXT_WINDOW_EXCEEDED',
      message: 'Context window exceeded. Please start a new conversation or clear history.',
      retryable: false,
      originalError,
    });
  }

  // Quota errors in message
  if (isQuotaError(errorMessage)) {
    return new NeoxError({
      category: ErrorCategory.FATAL_LIMIT,
      code: 'QUOTA_EXCEEDED',
      message: errorMessage,
      retryable: false,
      originalError,
    });
  }

  /* 「不支持流式 / stream 参数非法」—— 消息里带 stream, 但**不是**网络问题。
   *
   *   这类是配置或协议不匹配 (服务商不支持 SSE、base URL 指到了非流式端点、
   *   stream 参数被拒)。重试一万次也还是这个结果, 而按"网络中断"重试的观感是
   *   "它一直在转圈然后说网络不好", 用户会去查自己的网络 —— 找错方向。 */
  if (/(?:does\s?n[o']t|not|un)\s*support(?:ed)?[^.]{0,40}stream|stream(?:ing)?\s+(?:is\s+)?(?:not\s+supported|unsupported|disabled)|invalid[^.]{0,20}['"]?stream['"]?|unsupported[^.]{0,20}['"]?stream['"]?/i
    .test(errorMessage)) {
    return new NeoxError({
      category: ErrorCategory.FATAL_INVALID,
      code: 'STREAMING_UNSUPPORTED',
      message: `这个服务商/端点不支持流式返回 — 检查服务商配置或 Base URL。\n${errorMessage}`,
      retryable: false,
      originalError,
    });
  }

  // Stream errors —— 到这里才是真的传输中断
  if (errorMessage.includes('stream') ||
    errorMessage.includes('Stream') ||
    errorMessage.includes('SSE') ||
    errorMessage.includes('disconnected') ||
    errorMessage.includes('incomplete') ||
    errorMessage.includes('message_stop')) {
    return new NeoxError({
      category: ErrorCategory.RETRYABLE_STREAM,
      code: 'STREAM_ERROR',
      message: `响应流中断: ${errorMessage}`,
      retryable: true,
      originalError,
    });
  }

  // Default: internal error (not retryable)
  return new NeoxError({
    category: ErrorCategory.INTERNAL,
    code: 'UNKNOWN',
    message: errorMessage,
    retryable: false,
    originalError,
  });
}

/**
 * Classify tool-specific errors
 */
export function classifyToolError(
  toolName: string,
  args: string,
  error: Error
): NeoxError {
  const argsStr = args || '';

  // Check for truncation (incomplete JSON)
  if (!argsStr.trim().endsWith('}')) {
    return new NeoxError({
      category: ErrorCategory.TOOL_TRUNCATED,
      code: 'TOOL_ARGS_TRUNCATED',
      message: 'Tool arguments were truncated during streaming',
      retryable: false, // Truncation can't be fixed by retry
      context: {
        toolName,
        receivedLength: argsStr.length,
        rawMessage: error.message,
      },
      originalError: error,
    });
  }

  // Check for missing required fields in write/edit tools
  const normalizedTool = (toolName || '').toLowerCase();
  const isWriteTool = normalizedTool === 'write_file' || normalizedTool === 'write';
  const isEditTool = normalizedTool === 'edit_file' || normalizedTool === 'edit' || normalizedTool === 'str_replace_editor';

  if (isWriteTool && !argsStr.includes('"content"')) {
    return new NeoxError({
      category: ErrorCategory.TOOL_TRUNCATED,
      code: 'TOOL_MISSING_CONTENT',
      message: 'The content field is missing (likely truncated)',
      retryable: false,
      context: {
        toolName,
        receivedLength: argsStr.length,
        rawMessage: error.message,
      },
      originalError: error,
    });
  }

  if (isEditTool) {
    const hasSingleEditPair = argsStr.includes('"old_string"') && argsStr.includes('"new_string"');
    const hasHunkEditPair = argsStr.includes('"hunks"') && argsStr.includes('"new_string"');
    /* insert_after / insert_before + new_string 同样合法 (见 neox-core utils/jsonRepair.detectTruncation 同名判据) */
    const hasInsertPair = (argsStr.includes('"insert_after"') || argsStr.includes('"insert_before"')) && argsStr.includes('"new_string"');
    if (!hasSingleEditPair && !hasHunkEditPair && !hasInsertPair) {
      return new NeoxError({
        category: ErrorCategory.TOOL_TRUNCATED,
        code: 'TOOL_MISSING_EDIT_PAYLOAD',
        message: 'edit payload is incomplete (missing new_string/hunks)',
        retryable: false,
        context: {
          toolName,
          receivedLength: argsStr.length,
          rawMessage: error.message,
        },
        originalError: error,
      });
    }
  }

  // JSON parse error
  if (error.message.includes('JSON') ||
    error.message.includes('Unexpected') ||
    error.message.includes('parse')) {
    return new NeoxError({
      category: ErrorCategory.TOOL_JSON_INVALID,
      code: 'JSON_PARSE_ERROR',
      message: `Invalid JSON in tool arguments: ${error.message}`,
      retryable: true, // JSON errors can be retried (LLM might fix it)
      context: {
        toolName,
        receivedLength: argsStr.length,
        rawMessage: error.message,
      },
      originalError: error,
    });
  }

  // Default tool error
  return new NeoxError({
    category: ErrorCategory.TOOL_JSON_INVALID,
    code: 'TOOL_ERROR',
    message: error.message,
    retryable: true,
    context: { toolName },
    originalError: error,
  });
}

/**
 * Check if an error is retryable
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof NeoxError) {
    return error.retryable;
  }
  return classifyError(error).retryable;
}

/**
 * Get suggested recovery action for an error
 */
export function getErrorRecoverySuggestion(
  error: NeoxError,
  opts?: {
    /** True when retry attempts are exhausted and the returned guidance is terminal. */
    exhausted?: boolean;
  },
): string {
  const exhausted = opts?.exhausted === true;
  switch (error.category) {
    case ErrorCategory.RETRYABLE_RATE_LIMIT:
      if (exhausted) {
        /* Proxy failures advise switching provider/model, while a direct rate limit
         * advises waiting or switching. The preceding error line carries raw detail. */
        if (error.code.startsWith('PROXY_')) {
          return '上游网关反复失败, 重试已用尽 (原因见上一行)。这类多是中转站没给该模型配通道/分组, 或它正过载 —— 等下去多半不会好, 换个模型或服务商更快。';
        }
        return '被上游限流, 多次重试后仍未通过。稍等片刻再试, 或换一个模型。';
      }
      const waitTime = error.retryAfter ? Math.ceil(error.retryAfter / 1000) : 3;
      return `API 代理速率限制，${waitTime} 秒后自动重试...`;

    case ErrorCategory.RETRYABLE_HTTP:
      if (exhausted) return '上游多次返回可重试的错误, 重试已用尽。稍后再试, 或换一个模型 / 服务商。';
      return 'The request will be automatically retried.';

    case ErrorCategory.RETRYABLE_STREAM:
      if (exhausted) return '流式连接反复中断, 重连已用尽。检查网络是否稳定 (VPN / 代理切换会打断长连接)。';
      return '网络连接中断，正在自动重连...';

    case ErrorCategory.RETRYABLE_NETWORK:
      if (exhausted) return '网络连不上, 重试已用尽。检查网络、VPN/代理设置 (HTTP_PROXY / HTTPS_PROXY) 后重试。';
      return '网络连接异常，正在自动重试...';

    case ErrorCategory.FATAL_AUTH:
      return 'Please check your API key and ensure it has the necessary permissions.';

    case ErrorCategory.FATAL_LIMIT:
      return '余额或额度不足，请充值、等待额度重置，或换一个服务商 / 模型。';

    case ErrorCategory.FATAL_CONTEXT:
      return 'The conversation is too long. Please start a new conversation or use /compact to summarize history.';

    case ErrorCategory.FATAL_INVALID:
      return 'Please check your request parameters and try again.';

    case ErrorCategory.TOOL_TRUNCATED:
      return 'The tool call was truncated. Please use edit with smaller, targeted changes instead of rewriting entire files.';

    case ErrorCategory.TOOL_JSON_INVALID:
      return 'The tool arguments were invalid. The LLM will retry with corrected parameters.';

    case ErrorCategory.TOOL_TIMEOUT:
      return 'The tool execution timed out. Please try again with a smaller operation.';

    case ErrorCategory.TOOL_DENIED:
      return 'The tool call was denied. You can manually approve or adjust permissions.';

    default:
      return 'An unexpected error occurred. Please try again.';
  }
}
