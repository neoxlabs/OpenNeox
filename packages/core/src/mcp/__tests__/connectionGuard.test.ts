import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isTerminalConnectionError,
  isMcpSessionExpiredError,
  McpSessionExpiredError,
  McpAuthError,
  McpAuthPermanentError,
  withTimeout,
  getDiagnosticMessage,
  ConnectionHealthTracker,
  truncateToolDescription,
  MAX_MCP_DESCRIPTION_LENGTH,
  markServerNeedsAuth,
  markServerAuthFresh,
  cachedNeedsAuth,
  __clearNeedsAuthCacheForTests,
} from '../connectionGuard.js';

describe('isTerminalConnectionError', () => {
  it('detects ECONNRESET', () => {
    expect(isTerminalConnectionError({ code: 'ECONNRESET' })).toBe(true);
  });

  it('detects ETIMEDOUT', () => {
    expect(isTerminalConnectionError({ code: 'ETIMEDOUT' })).toBe(true);
  });

  it('detects ECONNREFUSED', () => {
    expect(isTerminalConnectionError({ code: 'ECONNREFUSED' })).toBe(true);
  });

  it('detects message patterns', () => {
    expect(isTerminalConnectionError({ message: 'SSE stream disconnected' })).toBe(true);
    expect(isTerminalConnectionError({ message: 'Maximum reconnection attempts reached' })).toBe(true);
  });

  it('returns false for non-terminal errors', () => {
    expect(isTerminalConnectionError({ code: 'ENOENT' })).toBe(false);
    expect(isTerminalConnectionError({ message: 'some random error' })).toBe(false);
    expect(isTerminalConnectionError(null)).toBe(false);
  });
});

describe('isMcpSessionExpiredError', () => {
  it('detects HTTP 404', () => {
    expect(isMcpSessionExpiredError({ code: 404 })).toBe(true);
    expect(isMcpSessionExpiredError({ statusCode: 404 })).toBe(true);
  });

  it('detects JSON-RPC -32001', () => {
    expect(isMcpSessionExpiredError({ code: -32001 })).toBe(true);
  });

  it('detects -32001 in message body', () => {
    expect(isMcpSessionExpiredError({ message: 'error "code":-32001 response' })).toBe(true);
    expect(isMcpSessionExpiredError({ body: '"code": -32001' })).toBe(true);
  });

  it('detects Connection closed (-32000)', () => {
    expect(isMcpSessionExpiredError({ code: -32000, message: 'Connection closed' })).toBe(true);
  });

  it('returns false for normal errors', () => {
    expect(isMcpSessionExpiredError({ code: 500 })).toBe(false);
    expect(isMcpSessionExpiredError(null)).toBe(false);
  });
});

describe('McpSessionExpiredError', () => {
  it('creates error with server name', () => {
    const err = new McpSessionExpiredError('my-server');
    expect(err.name).toBe('McpSessionExpiredError');
    expect(err.serverName).toBe('my-server');
    expect(err.message).toContain('my-server');
  });
});

describe('withTimeout', () => {
  it('resolves when promise completes before timeout', async () => {
    const result = await withTimeout(
      Promise.resolve(42),
      1000,
      'test',
    );
    expect(result).toBe(42);
  });

  it('rejects when timeout expires', async () => {
    const slowPromise = new Promise(resolve => setTimeout(resolve, 5000));
    await expect(
      withTimeout(slowPromise, 50, 'test-op'),
    ).rejects.toThrow('test-op timed out');
  });

  it('passes through rejection', async () => {
    await expect(
      withTimeout(Promise.reject(new Error('boom')), 1000, 'test'),
    ).rejects.toThrow('boom');
  });
});

describe('getDiagnosticMessage', () => {
  it('provides diagnostic for known codes', () => {
    expect(getDiagnosticMessage({ code: 'ECONNRESET' })).toContain('crashed or restarted');
    expect(getDiagnosticMessage({ code: 'ECONNREFUSED' })).toContain('down');
    expect(getDiagnosticMessage({ code: 'ETIMEDOUT' })).toContain('timeout');
  });

  it('handles spawn errors', () => {
    expect(getDiagnosticMessage({ message: 'spawn ENOENT' })).toContain('spawn');
  });
});

describe('ConnectionHealthTracker', () => {
  let tracker: ConnectionHealthTracker;

  beforeEach(() => {
    tracker = new ConnectionHealthTracker();
  });

  it('starts healthy', () => {
    expect(tracker.getHealth('test')).toBeUndefined();
  });

  it('tracks success', () => {
    tracker.recordSuccess('test');
    const health = tracker.getHealth('test')!;
    expect(health.consecutiveErrors).toBe(0);
    expect(health.totalSuccesses).toBe(1);
  });

  it('counts consecutive terminal errors', () => {
    tracker.recordError('test', { code: 'ECONNRESET' });
    expect(tracker.getHealth('test')!.consecutiveErrors).toBe(1);

    tracker.recordError('test', { code: 'ETIMEDOUT' });
    expect(tracker.getHealth('test')!.consecutiveErrors).toBe(2);
  });

  it('triggers reconnect after 3 terminal errors', () => {
    tracker.recordError('test', { code: 'ECONNRESET' });
    tracker.recordError('test', { code: 'ECONNRESET' });
    const shouldReconnect = tracker.recordError('test', { code: 'ECONNRESET' });
    expect(shouldReconnect).toBe(true);
    expect(tracker.getHealth('test')!.needsReconnect).toBe(true);
  });

  it('resets count on success', () => {
    tracker.recordError('test', { code: 'ECONNRESET' });
    tracker.recordError('test', { code: 'ECONNRESET' });
    tracker.recordSuccess('test');
    expect(tracker.getHealth('test')!.consecutiveErrors).toBe(0);
    expect(tracker.getHealth('test')!.needsReconnect).toBe(false);
  });

  it('resets count on non-terminal error', () => {
    tracker.recordError('test', { code: 'ECONNRESET' });
    tracker.recordError('test', { code: 'ECONNRESET' });
    tracker.recordError('test', { message: 'some non-terminal error' });
    expect(tracker.getHealth('test')!.consecutiveErrors).toBe(0);
  });
});

describe('truncateToolDescription', () => {
  it('preserves short descriptions', () => {
    expect(truncateToolDescription('short')).toBe('short');
  });

  it('truncates long descriptions', () => {
    const long = 'x'.repeat(MAX_MCP_DESCRIPTION_LENGTH + 100);
    const result = truncateToolDescription(long);
    expect(result.length).toBeLessThan(long.length);
    expect(result).toContain('truncated');
  });
});

// ============================================================================
// W3a needsAuth TTL 缓存
// ============================================================================

describe('needsAuth cache (W3a)', () => {
  beforeEach(() => {
    __clearNeedsAuthCacheForTests();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    __clearNeedsAuthCacheForTests();
  });

  it('cachedNeedsAuth 未 mark 时返 undefined', () => {
    expect(cachedNeedsAuth('srv1', 'https://x.com/mcp')).toBeUndefined();
  });

  it('markServerNeedsAuth 后 cachedNeedsAuth=true', () => {
    markServerNeedsAuth('srv1', 'https://x.com/mcp');
    expect(cachedNeedsAuth('srv1', 'https://x.com/mcp')).toBe(true);
  });

  it('markServerAuthFresh 后 cachedNeedsAuth 返 undefined (清缓存)', () => {
    markServerNeedsAuth('srv1', 'https://x.com/mcp');
    expect(cachedNeedsAuth('srv1', 'https://x.com/mcp')).toBe(true);

    markServerAuthFresh('srv1', 'https://x.com/mcp');
    expect(cachedNeedsAuth('srv1', 'https://x.com/mcp')).toBeUndefined();
  });

  it('15min TTL 过后 cachedNeedsAuth 自动失效', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-29T10:00:00Z'));

    markServerNeedsAuth('srv1', 'https://x.com/mcp');
    expect(cachedNeedsAuth('srv1', 'https://x.com/mcp')).toBe(true);

    /* 14 分钟内仍然有效 */
    vi.setSystemTime(new Date('2026-06-29T10:14:00Z'));
    expect(cachedNeedsAuth('srv1', 'https://x.com/mcp')).toBe(true);

    /* 16 分钟后过期 */
    vi.setSystemTime(new Date('2026-06-29T10:16:00Z'));
    expect(cachedNeedsAuth('srv1', 'https://x.com/mcp')).toBeUndefined();
  });

  it('不同 (name, url) 互不干扰', () => {
    markServerNeedsAuth('srv1', 'https://x.com/mcp');
    expect(cachedNeedsAuth('srv1', 'https://x.com/mcp')).toBe(true);
    expect(cachedNeedsAuth('srv1', 'https://y.com/mcp')).toBeUndefined();
    expect(cachedNeedsAuth('srv2', 'https://x.com/mcp')).toBeUndefined();
  });

  it('空 name 或空 url 时静默 no-op', () => {
    markServerNeedsAuth('', 'https://x.com/mcp');
    markServerNeedsAuth('srv', '');
    expect(cachedNeedsAuth('', 'https://x.com/mcp')).toBeUndefined();
    expect(cachedNeedsAuth('srv', '')).toBeUndefined();
  });
});

// ============================================================================
// W3b Auth Error 分级
// ============================================================================

describe('McpAuthError / McpAuthPermanentError (W3b)', () => {
  it('McpAuthError needsUserAction=true, recoverable=true (用户走 OAuth 后可恢复)', () => {
    const err = new McpAuthError('srv', 'https://x.com', 'no refresh token');
    expect(err.name).toBe('McpAuthError');
    expect(err.serverName).toBe('srv');
    expect(err.serverUrl).toBe('https://x.com');
    expect(err.needsUserAction).toBe(true);
    expect(err.recoverable).toBe(true);
    expect(err.message).toContain('needs OAuth');
    expect(err.message).toContain('no refresh token');
  });

  it('McpAuthPermanentError needsUserAction=true, recoverable=false (自动重试无用)', () => {
    const err = new McpAuthPermanentError('srv', 'https://x.com', 'token refresh failed');
    expect(err.name).toBe('McpAuthPermanentError');
    expect(err.serverName).toBe('srv');
    expect(err.serverUrl).toBe('https://x.com');
    expect(err.needsUserAction).toBe(true);
    expect(err.recoverable).toBe(false);
    expect(err.message).toContain('permanent auth failure');
    expect(err.message).toContain('token refresh failed');
  });

  it('两种 error 都接受 cause, 存到 originalCause', () => {
    const cause = new Error('underlying');
    const e1 = new McpAuthError('s', 'u', 'r', cause);
    const e2 = new McpAuthPermanentError('s', 'u', 'r', cause);
    expect((e1 as any).originalCause).toBe(cause);
    expect((e2 as any).originalCause).toBe(cause);
  });

  it('两种 error 都是 Error 子类 (满足 instanceof Error)', () => {
    expect(new McpAuthError('s', 'u', 'r')).toBeInstanceOf(Error);
    expect(new McpAuthPermanentError('s', 'u', 'r')).toBeInstanceOf(Error);
  });

  it('两种 error 互相 isolation (互不为对方 instance)', () => {
    const e1 = new McpAuthError('s', 'u', 'r');
    const e2 = new McpAuthPermanentError('s', 'u', 'r');
    expect(e1).not.toBeInstanceOf(McpAuthPermanentError);
    expect(e2).not.toBeInstanceOf(McpAuthError);
  });
});
