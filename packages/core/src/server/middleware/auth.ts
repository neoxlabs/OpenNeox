/**
 * Auth Middleware
 *
 * Bearer token 认证。本地请求可选跳过认证（向后兼容 CLI/Electron）。
 * 支持运行时动态开关和 token 更新。
 */

import type { MiddlewareHandler } from 'hono';

export interface AuthConfig {
  /** 认证 token */
  token: string;
  /** 本地请求免认证（默认 true） */
  allowLocalWithoutAuth?: boolean;
  /** 免认证路径（默认 ['/health']） */
  publicPaths?: string[];
}

const LOCAL_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);

function isLocalRequest(ip: string | undefined): boolean {
  if (!ip) return false;
  return LOCAL_IPS.has(ip);
}

/**
 * 动态 Auth 网关 — 支持运行时 enable/disable/updateToken
 */
export class AuthGate {
  private _enabled: boolean;
  private _token: string;
  private _allowLocalWithoutAuth: boolean;
  private _publicPaths: string[];

  constructor(config?: AuthConfig) {
    this._enabled = !!config;
    this._token = config?.token ?? '';
    this._allowLocalWithoutAuth = config?.allowLocalWithoutAuth ?? true;
    /* /oauth/callback 必须免鉴权: 浏览器带着 code 跳回来时不可能带 Bearer token。
     * 安全性不靠鉴权靠 **PKCE + state** —— code_verifier 只在本进程内存里,
     * state 用 timing-safe 比对, 别的进程就算截到这个 URL 也换不出 token。
     * (只有极简版会用到它; 正式版走 neox:// 自定义 scheme, 根本不经过 HTTP。) */
    this._publicPaths = config?.publicPaths ?? ['/health', '/oauth/callback'];
  }

  get enabled(): boolean { return this._enabled; }
  get token(): string { return this._token; }

  enable(token: string): void {
    this._token = token;
    this._enabled = true;
  }

  disable(): void {
    this._enabled = false;
  }

  updateToken(token: string): void {
    this._token = token;
  }

  /** Hono 中间件 */
  middleware(): MiddlewareHandler {
    return async (c, next) => {
      // 未启用时直接放行
      if (!this._enabled) return next();

      const path = c.req.path;

      // 公开路径免认证
      if (this._publicPaths.some(p => path === p || path.startsWith(p + '/'))) {
        return next();
      }

      // 本地请求免认证 —  安全 (企业级审计):
      //   只信【TCP socket 真实对端地址】, 绝不信 x-forwarded-for / x-real-ip 这类客户端可伪造的头。
      //   旧代码先读那俩头 → LAN/远程攻击者发 `x-forwarded-for: 127.0.0.1` 即可绕过鉴权拿到完整 runtime
      //   (执行 shell / 用已解密凭据)。本机 daemon / LAN server 前面没反代, socket 对端就是真客户端。
      if (this._allowLocalWithoutAuth) {
        const peerIp = (c.env as any)?.incoming?.socket?.remoteAddress;
        if (isLocalRequest(peerIp)) {
          return next();
        }
      }

      // 验证 Bearer token
      const authHeader = c.req.header('authorization');
      if (!authHeader) {
        return c.json({ error: 'Authorization required' }, 401);
      }

      const parts = authHeader.split(' ');
      if (parts.length !== 2 || parts[0] !== 'Bearer' || parts[1] !== this._token) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      return next();
    };
  }
}

/**
 * 便捷函数（向后兼容）
 */
export function authMiddleware(config: AuthConfig): MiddlewareHandler {
  const gate = new AuthGate(config);
  return gate.middleware();
}
