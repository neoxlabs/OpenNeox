/**
 * 连接器 OAuth 2.0 + PKCE (RFC 7636)
 *
 *   跟账号登录那条 oauthFlow 分开: 那边回调 neox:// 或控制面, 这边是
 *   打给 Google / Microsoft 的回环 HTTP。Slack 公开分发要 https 回调,
 *   授权码先落到 neox-dev.com 再 bounce 到本机固定端口。同时只跑一个
 *   连接器授权, 避免两个弹窗抢同一个回环端口。
 *
 *   clientId 解析顺序: 清单 auth.clientId → 连接变量 clientId →
 *   环境变量 / ~/.neox-secrets/*.env。
 *   Google 桌面客户端换票仍要带 client_secret（只放本机 secrets，不进清单）。
 *   Microsoft 公共客户端通常没有 secret，有则照样带上。
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { openSafeWebExternalUrl } from '../../ui/electron/ipc/safeExternalOpen.js';
import type { ConnectorOAuth2Auth } from '@neoxlabs/platform/shared/plugin-connector.js';
import {
  buildConnectorAuthorizeUrl,
  buildOAuthTokenBody,
  connectorOAuthProvider,
  parseOAuthTokenPayload,
  resolveAuthorizeRedirectUri,
  resolveConnectorClientId,
  resolveConnectorClientSecret,
  resolveLoopbackListenPort,
  usesUserOauthScopes,
} from './oauthTokens.js';
import { escapeHtml, loopbackRedirectHost, loopbackRedirectUri } from './oauthLoopback.js';

export {
  resolveConnectorClientId,
  resolveConnectorClientSecret,
  loadFreshCredential,
  refreshConnectorToken,
} from './oauthTokens.js';
export { escapeHtml, loopbackRedirectHost, loopbackRedirectUri } from './oauthLoopback.js';

const FLOW_TIMEOUT_MS = 5 * 60_000;

export type ConnectorOAuthTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
};

type Pending = {
  pluginName: string;
  state: string;
  verifier: string;
  redirectUri: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  servers: ReturnType<typeof createServer>[];
  resolve: (tokens: ConnectorOAuthTokens) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

let pending: Pending | null = null;

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function verifier(): string {
  return b64url(randomBytes(32));
}

function challenge(v: string): string {
  return b64url(createHash('sha256').update(v).digest());
}

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function htmlPage(title: string, body: string): string {
  const t = escapeHtml(title);
  const b = escapeHtml(body);
  return `<!doctype html><meta charset="utf-8"><title>${t}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:48px auto;max-width:28rem;color:#1a1a1a;white-space:pre-wrap}
h1{font-size:1.15rem}</style><h1>${t}</h1><p>${b}</p>`;
}

function writeHtml(res: ServerResponse, status: number, title: string, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(htmlPage(title, body));
}

function closeServers(servers: ReturnType<typeof createServer>[]): void {
  for (const s of servers) {
    try { s.close(); } catch { /* already closed */ }
  }
}

function cancelPending(reason: string): void {
  if (!pending) return;
  const cur = pending;
  pending = null;
  clearTimeout(cur.timer);
  closeServers(cur.servers);
  cur.reject(new Error(reason));
}

async function exchangeCode(opts: {
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  code: string;
  verifier: string;
  redirectUri: string;
}): Promise<ConnectorOAuthTokens> {
  const body = buildOAuthTokenBody({
    grantType: 'authorization_code',
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    code: opts.code,
    verifier: opts.verifier,
    redirectUri: opts.redirectUri,
  });
  const res = await fetch(opts.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
    redirect: 'error',
  });
  const text = await res.text();
  let parsed: any = {};
  try { parsed = JSON.parse(text); } catch { /* token 端点偶尔回 form */ }
  if (!res.ok && parsed.ok !== true) {
    throw new Error(parsed.error_description || parsed.error || text.slice(0, 240) || `token exchange ${res.status}`);
  }
  return parseOAuthTokenPayload(parsed);
}

export function startConnectorOAuth(opts: {
  pluginName: string;
  auth: ConnectorOAuth2Auth;
  connection: Record<string, unknown>;
}): Promise<ConnectorOAuthTokens> {
  const clientId = resolveConnectorClientId(opts.auth, opts.connection, opts.auth.authorizeUrl);
  if (!clientId) {
    return Promise.reject(new Error('这个插件还没有官方授权应用，暂时不能登录。'));
  }
  const clientSecret = resolveConnectorClientSecret(opts.auth.authorizeUrl);
  const provider = connectorOAuthProvider(opts.auth.authorizeUrl);
  if (provider === 'google' && !clientSecret) {
    return Promise.reject(new Error(
      'Google 换票需要 client_secret。请把 NEOX_GOOGLE_OAUTH_CLIENT_SECRET 写到 ~/.neox-secrets/google-oauth.env 后重试。',
    ));
  }
  if (provider === 'slack' && !clientSecret) {
    return Promise.reject(new Error(
      'Slack 换票需要 client_secret。请把 NEOX_SLACK_OAUTH_CLIENT_SECRET 写到 ~/.neox-secrets/slack-oauth.env 后重试。',
    ));
  }

  if (pending) cancelPending('superseded');

  return new Promise<ConnectorOAuthTokens>((resolve, reject) => {
    const state = b64url(randomBytes(24));
    const codeVerifier = verifier();
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void handleCallback(req, res);
    });

    const servers: ReturnType<typeof createServer>[] = [server];

    const fail = (err: Error) => {
      if (pending && pending.state !== state) return;
      pending = null;
      clearTimeout(timer);
      closeServers(servers);
      reject(err);
    };

    const timer = setTimeout(() => fail(new Error('OAuth 超时, 请重试')), FLOW_TIMEOUT_MS);

    let started = false;
    const beginAuthorize = (port: number) => {
      if (started) return;
      started = true;
      const loopbackUri = loopbackRedirectUri(port, opts.auth.authorizeUrl);
      const redirectUri = resolveAuthorizeRedirectUri(opts.auth, loopbackUri);
      pending = {
        pluginName: opts.pluginName,
        state,
        verifier: codeVerifier,
        redirectUri,
        tokenUrl: opts.auth.tokenUrl,
        clientId,
        clientSecret,
        servers,
        resolve: (tokens) => {
          pending = null;
          clearTimeout(timer);
          closeServers(servers);
          resolve(tokens);
        },
        reject: fail,
        timer,
      };

      const url = buildConnectorAuthorizeUrl({
        authorizeUrl: opts.auth.authorizeUrl,
        clientId,
        redirectUri,
        state,
        codeChallenge: challenge(codeVerifier),
        scopes: opts.auth.scopes,
        userScopes: usesUserOauthScopes(opts.auth),
      });

      void openSafeWebExternalUrl(url).catch(err => fail(err instanceof Error ? err : new Error(String(err))));
    };

    const listenPort = resolveLoopbackListenPort(opts.auth);

    /* 始终听 127.0.0.1, 不听 0.0.0.0 —— 授权码不能进局域网。
     * Microsoft 回调主机是 localhost, macOS 常先走 ::1, 所以同端口再听一份 IPv6。 */
    server.listen(listenPort, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        fail(new Error('无法监听本机回环端口'));
        return;
      }
      const port = addr.port;
      if (loopbackRedirectHost(opts.auth.authorizeUrl) !== 'localhost') {
        beginAuthorize(port);
        return;
      }
      const v6 = createServer((req: IncomingMessage, res: ServerResponse) => {
        void handleCallback(req, res);
      });
      servers.push(v6);
      v6.on('error', () => beginAuthorize(port));
      v6.listen(port, '::1', () => beginAuthorize(port));
    });

    server.on('error', err => fail(err instanceof Error ? err : new Error(String(err))));
  });
}

async function handleCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cur = pending;
  if (!cur) {
    writeHtml(res, 400, 'No pending login', '没有进行中的授权。');
    return;
  }
  const host = req.headers.host || '127.0.0.1';
  const url = new URL(req.url || '/', `http://${host}`);
  if (url.pathname !== '/callback') {
    writeHtml(res, 404, 'Not found', '');
    return;
  }
  const err = url.searchParams.get('error');
  if (err) {
    writeHtml(res, 400, 'Authorization failed', err);
    cur.reject(new Error(url.searchParams.get('error_description') || err));
    pending = null;
    clearTimeout(cur.timer);
    closeServers(cur.servers);
    return;
  }
  const state = url.searchParams.get('state') || '';
  const code = url.searchParams.get('code') || '';
  if (!timingSafeEq(state, cur.state) || !code) {
    writeHtml(res, 400, 'Invalid callback', 'state 不匹配或缺少 code。');
    cur.reject(new Error('OAuth callback state mismatch'));
    pending = null;
    clearTimeout(cur.timer);
    closeServers(cur.servers);
    return;
  }
  try {
    const tokens = await exchangeCode({
      tokenUrl: cur.tokenUrl,
      clientId: cur.clientId,
      clientSecret: cur.clientSecret,
      code,
      verifier: cur.verifier,
      redirectUri: cur.redirectUri,
    });
    writeHtml(res, 200, 'Connected', '可以关掉这个标签, 回到 Neox。');
    cur.resolve(tokens);
  } catch (e: any) {
    writeHtml(res, 500, 'Token exchange failed', String(e?.message || e).slice(0, 280));
    cur.reject(e instanceof Error ? e : new Error(String(e)));
    pending = null;
    clearTimeout(cur.timer);
    closeServers(cur.servers);
  }
}

export function cancelConnectorOAuth(): void {
  cancelPending('canceled');
}
