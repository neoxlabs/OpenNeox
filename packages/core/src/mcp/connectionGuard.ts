
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

// ============================================================================
// 常量
// ============================================================================

/** 连续致命错误后触发重连的阈值 */
const MAX_ERRORS_BEFORE_RECONNECT = 3;

/** 连接超时（ms） */
const DEFAULT_CONNECTION_TIMEOUT_MS = 30_000;

/** 请求超时（ms）— POST 请求 */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** Tool call 默认超时（ms）— 可通过 MCP_TOOL_TIMEOUT 覆盖 */
const DEFAULT_TOOL_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟

/** MCP 工具描述最大长度 */
export const MAX_MCP_DESCRIPTION_LENGTH = 2048;

const NEEDS_AUTH_CACHE_TTL_MS = 15 * 60 * 1000;

// ============================================================================
// Terminal Error 检测
// ============================================================================

/** 被视为致命（不可恢复）的错误码 */
const TERMINAL_ERROR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ECONNREFUSED',
]);

/** 被视为致命的错误消息关键词 */
const TERMINAL_ERROR_PATTERNS = [
  'Body Timeout Error',
  'terminated',
  'SSE stream disconnected',
  'Failed to reconnect',
  'Maximum reconnection attempts',
];

/**
 * 判断错误是否为致命连接错误
 */
export function isTerminalConnectionError(error: any): boolean {
  if (!error) return false;

  const code = error.code || error.errno || '';
  if (typeof code === 'string' && TERMINAL_ERROR_CODES.has(code)) {
    return true;
  }

  const message = String(error.message || error);
  return TERMINAL_ERROR_PATTERNS.some(pattern => message.includes(pattern));
}

/**
 * 生成友好的错误诊断消息
 */
export function getDiagnosticMessage(error: any): string {
  const code = error?.code || error?.errno || '';
  const message = String(error?.message || error || 'Unknown error');

  switch (code) {
    case 'ECONNRESET':
      return `Connection reset — server may have crashed or restarted`;
    case 'ETIMEDOUT':
      return `Connection timeout — network issue or server unresponsive`;
    case 'ECONNREFUSED':
      return `Connection refused — server may be down`;
    case 'EPIPE':
      return `Broken pipe — server closed connection unexpectedly`;
    case 'EHOSTUNREACH':
      return `Host unreachable — network connectivity issue`;
    case 'ESRCH':
      return `Process not found — stdio server may have terminated`;
    default:
      if (message.includes('spawn')) {
        return `Failed to spawn process — check command and permissions`;
      }
      return message.length > 200 ? message.slice(0, 200) + '...' : message;
  }
}

// ============================================================================
// ============================================================================

/** JSON-RPC error code for session not found */
const SESSION_EXPIRED_CODE = -32001;

/** 最大会话重试次数 */
export const MAX_SESSION_RETRIES = 1;

export const MAX_OAUTH_RETRIES = 1;

/**
 * 检测是否为 MCP 会话过期错误
 * CC 使用 HTTP 404 + JSON-RPC -32001 两种信号
 */
export function isMcpSessionExpiredError(error: any): boolean {
  if (!error) return false;

  // HTTP 404 状态码
  if (error.code === 404 || error.statusCode === 404) {
    return true;
  }

  // JSON-RPC -32001 错误码
  if (error.code === SESSION_EXPIRED_CODE) {
    return true;
  }

  // 在错误消息中查找 -32001
  const message = String(error.message || error.body || '');
  if (message.includes('"code":-32001') || message.includes('"code": -32001')) {
    return true;
  }

  // SDK McpError: Connection closed (transport layer)
  if (error.code === -32000 && message.includes('Connection closed')) {
    return true;
  }

  return false;
}

// ============================================================================
// ============================================================================

/**
 * 检测是否为 OAuth 401 未授权错误
 */
export function isMcpOAuthError(error: any): boolean {
  if (!error) return false;
  if (error.code === 401 || error.statusCode === 401) return true;
  if (error.status === 401) return true;
  const msg = String(error.message || '').toLowerCase();
  return msg.includes('unauthorized') || msg.includes('401') || msg.includes('invalid_token');
}

/**
 * 尝试 OAuth token 刷新并重放请求.
 *
 * 失败时**抛分级错误**让调用方决策:
 *   - McpAuthError         — 没有 refresh token, 用户从未 OAuth → 触发 UI OAuth 入口
 *   - McpAuthPermanentError — refresh 失败 / metadata 拿不到 → credentials 死了, 用户需重新授权
 *   - 其它原生 Error        — retryFn 自身 (token refresh 后) 抛, 不是 auth 问题, 上游处理
 *
 * 成功时 markServerAuthFresh 清缓存; 失败时 markServerNeedsAuth 让下次调用方跳过 connect 直接走 OAuth.
 *
 * @param serverUrl MCP 服务器 URL（用于查找存储的 token）
 * @param retryFn 重放原始请求的函数
 * @returns 重放结果
 * @throws McpAuthError | McpAuthPermanentError | 任何来自 retryFn 的 error
 */
export async function retryWithOAuthRefresh<T>(
  serverName: string,
  serverUrl: string,
  retryFn: () => Promise<T>,
): Promise<T> {
  /* 2.10: OAuth 流的网络调用 (metadata 发现 + token 刷新) 加 5s 硬超时.
   *   远端 SSO 域名挂 / DNS 不通时之前会一直 await, 阻塞整条 retry 链甚至冻 MCP server. */
  const OAUTH_OP_TIMEOUT_MS = 5000;
  const withOauthTimeout = <R>(label: string, p: Promise<R>): Promise<R> =>
    Promise.race([
      p,
      new Promise<never>((_, reject) => {
        const tid = setTimeout(() => {
          clearTimeout(tid);
          reject(new Error(`OAuth ${label} timeout after ${OAUTH_OP_TIMEOUT_MS / 1000}s`));
        }, OAUTH_OP_TIMEOUT_MS);
      }),
    ]);

  const { refreshAccessToken, loadStoredTokens, discoverOAuthMetadata } = await import('./oauth.js');
  const stored = loadStoredTokens(serverName, serverUrl);
  if (!stored?.refreshToken) {
    cliLogger.warn('MCP_OAUTH', `No refresh token for ${serverUrl}, user must OAuth`);
    markServerNeedsAuth(serverName, serverUrl);
    throw new McpAuthError(serverName, serverUrl, 'no refresh token stored — user must complete OAuth flow');
  }

  cliLogger.info('MCP_OAUTH', `Attempting token refresh for ${serverUrl}`);

  let metadata: Awaited<ReturnType<typeof discoverOAuthMetadata>>;
  try {
    metadata = await withOauthTimeout('metadata discovery', discoverOAuthMetadata(serverUrl));
  } catch (err: any) {
    cliLogger.warn('MCP_OAUTH', `OAuth metadata discovery failed for ${serverUrl}: ${err?.message}`);
    markServerNeedsAuth(serverName, serverUrl);
    throw new McpAuthPermanentError(
      serverName, serverUrl,
      `OAuth metadata discovery failed: ${err?.message || 'unknown'}`,
      err,
    );
  }
  if (!metadata) {
    cliLogger.warn('MCP_OAUTH', `Cannot discover OAuth metadata for ${serverUrl}`);
    markServerNeedsAuth(serverName, serverUrl);
    throw new McpAuthPermanentError(
      serverName, serverUrl,
      'OAuth metadata not available — server may not support OAuth',
    );
  }

  let newToken: Awaited<ReturnType<typeof refreshAccessToken>>;
  try {
    newToken = await withOauthTimeout('token refresh', refreshAccessToken(metadata, stored));
  } catch (err: any) {
    cliLogger.warn('MCP_OAUTH', `Token refresh threw for ${serverUrl}: ${err?.message}`);
    markServerNeedsAuth(serverName, serverUrl);
    throw new McpAuthPermanentError(
      serverName, serverUrl,
      `token refresh failed (credentials may be revoked): ${err?.message || 'unknown'}`,
      err,
    );
  }
  if (!newToken) {
    cliLogger.warn('MCP_OAUTH', `Token refresh returned no token for ${serverUrl}`);
    markServerNeedsAuth(serverName, serverUrl);
    throw new McpAuthPermanentError(
      serverName, serverUrl,
      'token refresh returned no token (credentials may be revoked)',
    );
  }

  cliLogger.info('MCP_OAUTH', `Token refreshed, replaying request to ${serverUrl}`);
  const result = await retryFn();
  /* retry 成功 → 标记 auth fresh, 下次跳过 OAuth 流程 */
  markServerAuthFresh(serverName, serverUrl);
  return result;
}

// ============================================================================
// Session Expired & Auth Error 分级
// ============================================================================

/**
 * Session expired 自定义错误 (transient — 通常 reconnect 即可恢复, 不需要 OAuth)
 */
export class McpSessionExpiredError extends Error {
  public readonly serverName: string;

  constructor(serverName: string, cause?: Error) {
    super(`MCP session expired for server "${serverName}"`);
    this.name = 'McpSessionExpiredError';
    this.serverName = serverName;
    // Store original cause for debugging
    if (cause) (this as any).originalCause = cause;
  }
}

/**
 * 首次未授权 / refresh token 缺失. 需要用户走完整 OAuth 流程.
 *
 * 调用方拿到此错误应当: 提示用户 "请重新授权" + 触发 UI 中的 OAuth 入口 (不是自动重试).
 */
export class McpAuthError extends Error {
  public readonly serverName: string;
  public readonly serverUrl: string;
  /** 用户需要主动 action (走 OAuth) 而非系统自动可恢复 */
  public readonly needsUserAction = true;
  /** transient: 用户完成 OAuth 后通常能恢复 */
  public readonly recoverable = true;

  constructor(serverName: string, serverUrl: string, reason: string, cause?: Error) {
    super(`MCP server "${serverName}" needs OAuth: ${reason}`);
    this.name = 'McpAuthError';
    this.serverName = serverName;
    this.serverUrl = serverUrl;
    if (cause) (this as any).originalCause = cause;
  }
}

/**
 * Auth permanent: 刷新 token 都失败. 通常 credentials 真的过期 / 被撤销 / server 配置变了.
 *
 * 调用方拿到此错误应当: 提示用户 "凭证失效, 请清除后重新授权" + 自动 retry 不会有用, 应停.
 */
export class McpAuthPermanentError extends Error {
  public readonly serverName: string;
  public readonly serverUrl: string;
  public readonly needsUserAction = true;
  /** 非 transient: 自动重试不会成功 */
  public readonly recoverable = false;

  constructor(serverName: string, serverUrl: string, reason: string, cause?: Error) {
    super(`MCP server "${serverName}" permanent auth failure: ${reason}`);
    this.name = 'McpAuthPermanentError';
    this.serverName = serverName;
    this.serverUrl = serverUrl;
    if (cause) (this as any).originalCause = cause;
  }
}

// ============================================================================
// needsAuth TTL 缓存
// ============================================================================

interface NeedsAuthCacheEntry {
  needsAuth: boolean;
  cachedAt: number;
}

const needsAuthCache = new Map<string, NeedsAuthCacheEntry>();

function makeCacheKey(serverName: string, serverUrl: string): string {
  return `${serverName}::${serverUrl}`;
}

/** 标记 server 需要 OAuth (例: 第一次 connect 拿到 401 / OAuth metadata 发现成功). */
export function markServerNeedsAuth(serverName: string, serverUrl: string): void {
  if (!serverName || !serverUrl) return;
  needsAuthCache.set(makeCacheKey(serverName, serverUrl), {
    needsAuth: true,
    cachedAt: Date.now(),
  });
}

/** 标记 server auth 已就绪 (例: 成功 connect, token 有效). 立刻清缓存. */
export function markServerAuthFresh(serverName: string, serverUrl: string): void {
  if (!serverName || !serverUrl) return;
  needsAuthCache.delete(makeCacheKey(serverName, serverUrl));
}

/**
 * 拿缓存判断 server 是否需要 OAuth.
 * @returns true=最近被标记需 OAuth (15min 内); false=最近被标记 auth 就绪;
 *          undefined=未缓存 / 已过期, 调用方应走正常 connect 流程
 */
export function cachedNeedsAuth(serverName: string, serverUrl: string): boolean | undefined {
  if (!serverName || !serverUrl) return undefined;
  const entry = needsAuthCache.get(makeCacheKey(serverName, serverUrl));
  if (!entry) return undefined;
  if (Date.now() - entry.cachedAt > NEEDS_AUTH_CACHE_TTL_MS) {
    /* 过期 — 主动清掉, 避免内存累积 */
    needsAuthCache.delete(makeCacheKey(serverName, serverUrl));
    return undefined;
  }
  return entry.needsAuth;
}

/** 仅测试用: 清掉所有 needsAuth 缓存 */
export function __clearNeedsAuthCacheForTests(): void {
  needsAuthCache.clear();
}

// ============================================================================
// ============================================================================

/**
 * 获取连接超时时间（ms）
 * 支持 MCP_TIMEOUT 环境变量覆盖
 */
export function getConnectionTimeoutMs(): number {
  const envTimeout = process.env.MCP_TIMEOUT;
  if (envTimeout) {
    const parsed = parseInt(envTimeout, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_CONNECTION_TIMEOUT_MS;
}

/**
 * 获取 tool call 超时时间（ms）
 * 支持 MCP_TOOL_TIMEOUT 环境变量覆盖
 */
export function getToolCallTimeoutMs(): number {
  const envTimeout = process.env.MCP_TOOL_TIMEOUT;
  if (envTimeout) {
    const parsed = parseInt(envTimeout, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_TOOL_TIMEOUT_MS;
}

/**
 * 获取请求超时时间（ms）
 */
export function getRequestTimeoutMs(): number {
  return DEFAULT_REQUEST_TIMEOUT_MS;
}

/**
 * 带超时的 Promise 包装
 * @param promise 原始 Promise
 * @param timeoutMs 超时毫秒数
 * @param label 标签（用于错误消息）
 * @returns 在超时前完成的 Promise
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  if (timeoutMs <= 0) return promise;

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`${label} timed out after ${(timeoutMs / 1000).toFixed(1)}s`));
      }
    }, timeoutMs);

    promise.then(
      (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      },
      (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      },
    );
  });
}

// ============================================================================
// ============================================================================

export interface ConnectionHealth {
  /** 连续致命错误计数 */
  consecutiveErrors: number;
  /** 最后一次错误时间 */
  lastErrorAt: number;
  /** 最后一次成功时间 */
  lastSuccessAt: number;
  /** 总错误次数 */
  totalErrors: number;
  /** 总成功次数 */
  totalSuccesses: number;
  /** 是否需要重连 */
  needsReconnect: boolean;
}

/**
 * 连接健康状态追踪器
 * 每个 MCP server 一个实例
 */
export class ConnectionHealthTracker {
  private healthMap = new Map<string, ConnectionHealth>();

  private getOrCreate(serverId: string): ConnectionHealth {
    let health = this.healthMap.get(serverId);
    if (!health) {
      health = {
        consecutiveErrors: 0,
        lastErrorAt: 0,
        lastSuccessAt: 0,
        totalErrors: 0,
        totalSuccesses: 0,
        needsReconnect: false,
      };
      this.healthMap.set(serverId, health);
    }
    return health;
  }

  /**
   * 记录成功（重置连续错误计数）
   */
  recordSuccess(serverId: string): void {
    const health = this.getOrCreate(serverId);
    health.consecutiveErrors = 0;
    health.lastSuccessAt = Date.now();
    health.totalSuccesses++;
    health.needsReconnect = false;
  }

  /**
   * 记录错误
   * @returns 是否应该触发重连
   */
  recordError(serverId: string, error: any): boolean {
    const health = this.getOrCreate(serverId);
    health.totalErrors++;
    health.lastErrorAt = Date.now();

    if (isTerminalConnectionError(error)) {
      health.consecutiveErrors++;
      const diagnostic = getDiagnosticMessage(error);

      if (health.consecutiveErrors >= MAX_ERRORS_BEFORE_RECONNECT) {
        health.needsReconnect = true;
        cliLogger.warn('MCP',
          `[${serverId}] ${health.consecutiveErrors} consecutive terminal errors — will reconnect. ` +
          `Last: ${diagnostic}`,
        );
        return true;
      }

      cliLogger.debug('MCP',
        `[${serverId}] Terminal error ${health.consecutiveErrors}/${MAX_ERRORS_BEFORE_RECONNECT}: ${diagnostic}`,
      );
    } else {
      // 非致命错误重置计数
      health.consecutiveErrors = 0;
    }

    return false;
  }

  /**
   * 获取健康状态
   */
  getHealth(serverId: string): ConnectionHealth | undefined {
    return this.healthMap.get(serverId);
  }

  /**
   * 清除服务器状态
   */
  clear(serverId: string): void {
    this.healthMap.delete(serverId);
  }

  /**
   * 清除所有
   */
  clearAll(): void {
    this.healthMap.clear();
  }
}

// ============================================================================
// ============================================================================

/**
 * 截断工具描述
 * OpenAPI-generated 服务器可能产生 15-60KB 的描述文本
 */
export function truncateToolDescription(description: string): string {
  if (description.length <= MAX_MCP_DESCRIPTION_LENGTH) {
    return description;
  }
  return description.slice(0, MAX_MCP_DESCRIPTION_LENGTH) + '… [truncated]';
}

// ============================================================================
// ============================================================================

/**
 * 优雅终止 stdio 子进程
 * 信号序列: SIGINT (100ms) → SIGTERM (400ms) → SIGKILL
 */
export async function gracefulKillProcess(pid: number): Promise<void> {
  const isAlive = (): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  if (!isAlive()) return;

  // Step 1: SIGINT
  try {
    process.kill(pid, 'SIGINT');
  } catch { return; }

  await sleep(100);
  if (!isAlive()) return;

  // Step 2: SIGTERM
  try {
    process.kill(pid, 'SIGTERM');
  } catch { return; }

  await sleep(400);
  if (!isAlive()) return;

  // Step 3: SIGKILL (force)
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Process already gone
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
