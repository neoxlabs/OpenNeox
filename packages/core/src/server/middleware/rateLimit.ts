/**
 * Rate Limit Middleware
 *
 * 基于 IP 的滑动窗口限流。
 */

import type { MiddlewareHandler } from 'hono';

export interface RateLimitConfig {
  /** 窗口内最大请求数（默认 120） */
  maxRequests?: number;
  /** 窗口时长 ms（默认 60000） */
  windowMs?: number;
  /** 免限流路径 */
  skipPaths?: string[];
}

interface WindowEntry {
  count: number;
  resetAt: number;
}

export function rateLimitMiddleware(config?: RateLimitConfig): MiddlewareHandler {
  const maxRequests = config?.maxRequests ?? 120;
  const windowMs = config?.windowMs ?? 60_000;
  const skipPaths = new Set(config?.skipPaths ?? ['/health']);

  const windows = new Map<string, WindowEntry>();

  // 定期清理过期条目
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of windows) {
      if (now > entry.resetAt) windows.delete(ip);
    }
  }, windowMs * 2);

  // 防止 timer 阻止进程退出
  if (cleanup.unref) cleanup.unref();

  return async (c, next) => {
    if (skipPaths.has(c.req.path)) return next();

    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
      || c.req.header('x-real-ip')
      || (c.env as any)?.incoming?.socket?.remoteAddress
      || 'unknown';

    /* localhost 直接放行: Neox desktop 跟 server 是同机通信, electron-main 这一边的
     * UI 各组件都从 127.0.0.1 polling 同一批端点 (process:list / shell-resize / get-output ...),
     * 全部算一个 IP 很容易顶破 120/min. 远程 client (network mode) 仍然走限流. */
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'unknown') {
      return next();
    }

    const now = Date.now();
    let entry = windows.get(ip);

    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      windows.set(ip, entry);
    }

    entry.count++;

    // 设置限流响应头
    c.header('X-RateLimit-Limit', String(maxRequests));
    c.header('X-RateLimit-Remaining', String(Math.max(0, maxRequests - entry.count)));
    c.header('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > maxRequests) {
      return c.json(
        { error: 'Too many requests', retryAfter: Math.ceil((entry.resetAt - now) / 1000) },
        429,
      );
    }

    return next();
  };
}
