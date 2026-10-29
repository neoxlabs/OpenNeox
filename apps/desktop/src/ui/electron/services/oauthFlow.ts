/**
 * Browser-based OAuth 2.0 PKCE login flow (RFC 7636) for Neox Desktop.
 *
 *   流程
 *   ----
 *   1. renderer 调 IPC `auth:launch-oauth` → 主进程
 *   2. 主进程 OAuthFlow.start():
 *      a. 生成 code_verifier (32 字节随机), 算 code_challenge = base64url(sha256(verifier))
 *      b. 生成 state nonce 防 CSRF
 *      c. 构造 https://app.neox.dev/oauth/authorize?response_type=code&client_id=neox-desktop&redirect_uri=neox://oauth/callback&code_challenge=...&state=...&scope=...
 *      d. openSafeWebExternalUrl() 跳浏览器 (协议白名单版 shell.openExternal)
 *      e. await pending deep link Promise (超时 5 分钟)
 *   3. 用户在浏览器登录 + 授权 → web /oauth/authorize redirect → neox://oauth/callback?code=...&state=...
 *   4. mac OS: app.on('open-url') / win+linux: app.on('second-instance') 解析 argv
 *      → OAuthFlow.handleDeepLink(url) → 校验 state → resolve pending Promise
 *   5. 主进程 POST /oauth/token { grant_type=authorization_code, code, code_verifier, ... }
 *      → 拿 access + refresh token → 同步落 safeStorage (authHandlers.writeTokens) → return user
 *
 *   安全
 *   ----
 *   · code_verifier 永远不离开主进程, renderer 完全见不到
 *   · state 走 timing-safe compare 防伪造 deep link
 *   · 同时只允许 1 个进行中的 flow, 后来居上 (老的 reject 'superseded')
 *   · 5 分钟超时强制清理, 防泄漏内存 + 防长期 stale state 被恶意调起
 */

import { createHash, randomBytes } from 'crypto';
import { openSafeWebExternalUrl } from '../ipc/safeExternalOpen.js';
import { AUTH_CANCELED_MESSAGE } from '../../shared/authCancel.js';
import { DISTRIBUTION } from '@neoxlabs/kernel/platform/distribution.js';

/* 协议跟着发行版走 (main.ts 注册的是 DISTRIBUTION.protocol), 两个发行版同机时回调不会落到另一个 app */
const NEOX_REDIRECT_URI = `${DISTRIBUTION.protocol}://oauth/callback`;

function liteRedirectUri(): string | null {
  const port = process.env.NEOX_SERVER_PORT || process.env.NEOX_LITE_PORT;
  if (String(process.env.NEOX_EDITION || '').trim().toLowerCase() !== 'lite' || !port) return null;
  return `http://127.0.0.1:${port}/oauth/callback`;
}
const NEOX_CLIENT_ID = 'neox-desktop';
/* 极简版有**自己的 OAuth client** (控制面 migration 0198)。
 * 独立 client 之后 JWT 的 cid claim 天然带上发行版身份 —— 服务端能分清这个会话
 * 来自极简版还是正式版 (用量归因 / 灰度 / 定位都用得上), 也不去放大 neox-desktop
 * 的 redirect 面。 */
const NEOX_LITE_CLIENT_ID = 'neox-lite';
const FLOW_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_SCOPE = 'profile plugins:read plugins:write membership:read membership:write workspace:read workspace:write api_keys:read api_keys:write usage:read usage:write';

export type OAuthLoginResult = {
  user: {
    id: string;
    email: string;
    displayName?: string;
    phone?: string | null;
    avatarUrl?: string | null;
    emailVerifiedAt?: string | null;
    isAdmin?: boolean;
  };
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
  scope: string;
};

type Pending = {
  state: string;
  codeVerifier: string;
  controlPlaneBaseUrl: string;
  webBaseUrl: string;
  /* 换 token 时必须回传**跟 authorize 那一步一模一样**的 redirect_uri, 否则服务端拒。
   * 所以存在 pending 里, 不去重新算一遍 —— 重新算会在"算的时候环境变了"时不一致。 */
  redirectUri: string;
  clientId: string;
  resolve: (result: OAuthLoginResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

function base64UrlEncode(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function generateCodeVerifier(): string {
  /* RFC 7636: 43-128 chars, [A-Z a-z 0-9 -._~]. base64url 32 字节 = 43 字符, 满足. */
  return base64UrlEncode(randomBytes(32));
}

function deriveChallenge(verifier: string): string {
  return base64UrlEncode(createHash('sha256').update(verifier).digest());
}

function timingSafeStrEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

class OAuthFlowImpl {
  private pending: Pending | null = null;

  /**
   * 启动一次 OAuth 流. 同时只允许 1 个 pending; 重复调起会替换老的 (老的 reject).
   *
   * @param params.controlPlaneBaseUrl  e.g. https://api.neox.dev (token endpoint 走这里)
   * @param params.webBaseUrl           e.g. https://app.neox.dev (authorize 页面在这里)
   * @param params.scope                空格分隔的 scope, 默认全
   * @param params.deviceName           可选, 给 server 看的设备名
   */
  start(params: {
    controlPlaneBaseUrl: string;
    webBaseUrl: string;
    scope?: string;
    deviceName?: string;
  }): Promise<OAuthLoginResult> {
    /* 替换老的 pending — 用户重复点登录按钮时老的废弃 */
    if (this.pending) {
      try { this.pending.reject(new Error('Superseded by new login attempt')); } catch { /* ignore */ }
      clearTimeout(this.pending.timer);
      this.pending = null;
    }

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = deriveChallenge(codeVerifier);
    const state = base64UrlEncode(randomBytes(16));
    const scope = (params.scope || DEFAULT_SCOPE).trim();
    const webBase = params.webBaseUrl.replace(/\/$/, '');
    const controlBase = params.controlPlaneBaseUrl.replace(/\/$/, '');

    /* 极简版走本机回环, 正式版走自定义 scheme (见 liteRedirectUri 的说明)。 */
    const lite = liteRedirectUri();
    const redirectUri = lite ?? NEOX_REDIRECT_URI;
    const clientId = lite ? NEOX_LITE_CLIENT_ID : NEOX_CLIENT_ID;

    const authorizeUrl = `${webBase}/oauth/authorize`
      + `?response_type=code`
      + `&client_id=${encodeURIComponent(clientId)}`
      + `&redirect_uri=${encodeURIComponent(redirectUri)}`
      + `&scope=${encodeURIComponent(scope)}`
      + `&state=${encodeURIComponent(state)}`
      + `&code_challenge=${encodeURIComponent(codeChallenge)}`
      + `&code_challenge_method=S256`;

    return new Promise<OAuthLoginResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending && this.pending.state === state) {
          this.pending = null;
          reject(new Error('OAuth login timed out (5 minutes)'));
        }
      }, FLOW_TIMEOUT_MS);

      this.pending = { state, codeVerifier, controlPlaneBaseUrl: controlBase, webBaseUrl: webBase, redirectUri, clientId, resolve, reject, timer };

      /* 跳浏览器 (走 safeExternalOpen 协议白名单) — 失败也要清 pending */
      openSafeWebExternalUrl(authorizeUrl).catch((err) => {
        if (this.pending && this.pending.state === state) {
          clearTimeout(this.pending.timer);
          this.pending = null;
          reject(new Error(`Failed to open browser: ${err?.message || err}`));
        }
      });
      void params.deviceName; /* 暂未用; 上线时可以塞到 token 请求 header */
    });
  }

  /**
   * 主进程收到 deep link 时调 (mac open-url / win+linux second-instance argv).
   * 解析 query → 校验 state → POST /oauth/token 换 token → resolve pending.
   *
   * 任何错误都 reject pending; 解析失败 / 不是当前 pending state → 静默忽略 (返 false).
   */
  async handleDeepLink(deepLinkUrl: string): Promise<boolean> {
    if (!this.pending) return false;
    let parsed: URL;
    try {
      parsed = new URL(deepLinkUrl);
    } catch {
      return false;
    }
    /* 两种回调都认: 正式版的自定义 scheme, 和极简版的本机回环地址。 */
    const isCustomScheme = parsed.protocol === 'neox:' && parsed.host + parsed.pathname === 'oauth/callback';
    const isLoopback = (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
      && parsed.pathname === '/oauth/callback';
    if (!isCustomScheme && !isLoopback) {
      return false;
    }

    const code = parsed.searchParams.get('code') ?? '';
    const state = parsed.searchParams.get('state') ?? '';
    const errorParam = parsed.searchParams.get('error');

    /* state 不匹配 → 不处理 (可能是过期 deep link, 不动当前 pending) */
    if (!timingSafeStrEq(state, this.pending.state)) return false;

    const pending = this.pending;
    this.pending = null;
    clearTimeout(pending.timer);

    if (errorParam) {
      pending.reject(new Error(`Authorization denied: ${errorParam}`));
      return true;
    }
    if (!code) {
      pending.reject(new Error('Missing code in callback'));
      return true;
    }

    try {
      const result = await this.exchangeCodeForToken({
        controlPlaneBaseUrl: pending.controlPlaneBaseUrl,
        code,
        codeVerifier: pending.codeVerifier,
        redirectUri: pending.redirectUri,
        clientId: pending.clientId,
      });
      pending.resolve(result);
    } catch (err: any) {
      pending.reject(err instanceof Error ? err : new Error(String(err)));
    }
    return true;
  }

  /** 取消进行中的 flow (用户点"取消"按钮 / 关闭登录窗口时) */
  cancel(): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    const pending = this.pending;
    this.pending = null;
    try { pending.reject(new Error(AUTH_CANCELED_MESSAGE)); } catch { /* ignore */ }
  }

  isPending(): boolean { return this.pending !== null; }

  private async exchangeCodeForToken(params: {
    controlPlaneBaseUrl: string;
    code: string;
    codeVerifier: string;
    /* 必须跟 authorize 那一步用的**完全一致**, 否则服务端拒 —— 所以从 pending 里带过来,
     * 不在这里重算 (重算会在"算的时候环境变了"时不一致)。 */
    redirectUri: string;
    /* 同理: 换 token 时的 client_id 必须跟 authorize 那一步一致。 */
    clientId: string;
  }): Promise<OAuthLoginResult> {
    const tokenUrl = `${params.controlPlaneBaseUrl}/api/v1/oauth/token`;
    /* 设备指纹 — 登录瞬间一并提交, 服务端写 device_fingerprints + JWT 注入 fp claim */
    const { getDeviceFingerprint } = await import('./deviceFingerprint.js');
    let fpHash: string | null = null;
    let fpBlob: Record<string, string> = {};
    try {
      const fp = getDeviceFingerprint();
      fpHash = fp.fpHash;
      fpBlob = fp.fpBlob;
    } catch (err) {
      /* eslint-disable-next-line no-console */
      console.warn('[oauthFlow] device fingerprint failed (proceeding without):', err);
    }
    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(fpHash ? { 'X-Device-FP': fpHash, 'X-Device-FP-Blob': JSON.stringify(fpBlob) } : {}),
      },
      body: JSON.stringify({
        grant_type:    'authorization_code',
        client_id:     params.clientId,
        code:          params.code,
        code_verifier: params.codeVerifier,
        redirect_uri:  params.redirectUri,
      }),
    });
    const tokenJson = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok) {
      throw new Error((tokenJson as any)?.error || `Token exchange failed: ${tokenRes.status}`);
    }
    const accessToken = String((tokenJson as any).access_token ?? '');
    const refreshToken = String((tokenJson as any).refresh_token ?? '');
    if (!accessToken || !refreshToken) {
      throw new Error('Token endpoint returned incomplete payload');
    }
    /* 拉一次 /auth/me 拿 user 信息, 同时把 access token 验通 */
    const meRes = await fetch(`${params.controlPlaneBaseUrl}/api/v1/auth/me`, {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const meJson = await meRes.json().catch(() => ({}));
    if (!meRes.ok) {
      throw new Error((meJson as any)?.error || `Failed to load user profile (${meRes.status})`);
    }
    const user = (meJson as any).user;
    if (!user || typeof user.id !== 'string') throw new Error('Invalid user payload');
    return {
      user: {
        id:               user.id,
        email:            user.email,
        displayName:      user.displayName ?? user.display_name,
        phone:            user.phone ?? null,
        avatarUrl:        user.avatarUrl ?? user.avatar_url ?? null,
        emailVerifiedAt:  user.emailVerifiedAt ?? user.email_verified_at ?? null,
        isAdmin:          !!user.isAdmin,
      },
      accessToken,
      refreshToken,
      expiresIn:         Number((tokenJson as any).expires_in ?? 900),
      refreshExpiresIn:  Number((tokenJson as any).refresh_expires_in ?? 2_592_000),
      scope:             String((tokenJson as any).scope ?? ''),
    };
  }
}

/** 单例 — 主进程整个生命周期共享 */
export const oauthFlow = new OAuthFlowImpl();

/* 交给 core 的 server —— 极简版的 /oauth/callback 落在那边, 要能调到这个实例。
 * 依赖方向是 core 在下 desktop 在上, core 不能 import 这里, 所以走 globalThis
 * (跟 EventBus / IPC 路由表同一个办法)。 */
(globalThis as any).__neoxOAuthFlow__ = oauthFlow;
