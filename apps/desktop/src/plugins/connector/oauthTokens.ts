/**
 * 连接器 OAuth 换票 / 刷新 —— 不碰 Electron
 *
 *   注册表和执行器会在每次调用前走这里。授权弹窗在 oauth.ts。
 *
 *   Google 桌面客户端仍会发 client_secret，token 端点要带上；
 *   secret 只从环境变量或 ~/.neox-secrets/*.env 读，不进插件清单。
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ConnectorOAuth2Auth } from '@neoxlabs/platform/shared/plugin-connector.js';
import { saveCredential, loadCredential, type Credential } from './credentialStore.js';

const REFRESH_SKEW_MS = 60_000;

export type ConnectorOAuthProvider = 'google' | 'microsoft' | 'slack' | 'other';

export const SLACK_OAUTH_LOOPBACK_PORT = 58721;

export function connectorOAuthProvider(authorizeUrl: string): ConnectorOAuthProvider {
  try {
    const host = new URL(authorizeUrl).hostname.toLowerCase();
    if (host.endsWith('google.com') || host.endsWith('googleapis.com')) return 'google';
    if (host.includes('microsoftonline.com') || host.includes('microsoft.com')) return 'microsoft';
    if (host === 'slack.com' || host.endsWith('.slack.com')) return 'slack';
  } catch { /* 坏 URL 当 other */ }
  return 'other';
}

/** 解析 KEY=VALUE，忽略空行和 # 注释。不处理转义，secrets 文件本来就该一行一个值。 */
export function parseDotEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
      || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

function secretsDir(): string {
  return process.env.NEOX_SECRETS_DIR?.trim() || join(homedir(), '.neox-secrets');
}

function readSecretEnvFile(filename: string): Record<string, string> {
  try {
    return parseDotEnv(readFileSync(join(secretsDir(), filename), 'utf8'));
  } catch {
    return {};
  }
}

function secretEnv(provider: ConnectorOAuthProvider): Record<string, string> {
  if (provider === 'google') return readSecretEnvFile('google-oauth.env');
  if (provider === 'microsoft') return readSecretEnvFile('microsoft-oauth.env');
  if (provider === 'slack') return readSecretEnvFile('slack-oauth.env');
  return {};
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

export function resolveConnectorClientId(
  auth: ConnectorOAuth2Auth,
  connection: Record<string, unknown>,
  authorizeUrl: string,
): string | undefined {
  const fromConn = typeof connection.clientId === 'string' ? connection.clientId.trim() : '';
  if (auth.clientId?.trim()) return auth.clientId.trim();
  if (fromConn) return fromConn;
  const provider = connectorOAuthProvider(authorizeUrl);
  const file = secretEnv(provider);
  if (provider === 'google') {
    return firstNonEmpty(process.env.NEOX_GOOGLE_OAUTH_CLIENT_ID, file.NEOX_GOOGLE_OAUTH_CLIENT_ID);
  }
  if (provider === 'microsoft') {
    return firstNonEmpty(process.env.NEOX_MICROSOFT_OAUTH_CLIENT_ID, file.NEOX_MICROSOFT_OAUTH_CLIENT_ID);
  }
  if (provider === 'slack') {
    return firstNonEmpty(process.env.NEOX_SLACK_OAUTH_CLIENT_ID, file.NEOX_SLACK_OAUTH_CLIENT_ID);
  }
  return firstNonEmpty(process.env.NEOX_CONNECTOR_OAUTH_CLIENT_ID, file.NEOX_CONNECTOR_OAUTH_CLIENT_ID);
}

export function resolveConnectorClientSecret(authorizeUrl: string): string | undefined {
  const provider = connectorOAuthProvider(authorizeUrl);
  const file = secretEnv(provider);
  if (provider === 'google') {
    return firstNonEmpty(process.env.NEOX_GOOGLE_OAUTH_CLIENT_SECRET, file.NEOX_GOOGLE_OAUTH_CLIENT_SECRET);
  }
  if (provider === 'microsoft') {
    return firstNonEmpty(process.env.NEOX_MICROSOFT_OAUTH_CLIENT_SECRET, file.NEOX_MICROSOFT_OAUTH_CLIENT_SECRET);
  }
  if (provider === 'slack') {
    return firstNonEmpty(process.env.NEOX_SLACK_OAUTH_CLIENT_SECRET, file.NEOX_SLACK_OAUTH_CLIENT_SECRET);
  }
  return firstNonEmpty(process.env.NEOX_CONNECTOR_OAUTH_CLIENT_SECRET, file.NEOX_CONNECTOR_OAUTH_CLIENT_SECRET);
}

export type ParsedOAuthTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
};

/** Slack 用户票在 authed_user 里；Google / Microsoft 在顶层。ok:false 当失败。 */
export function parseOAuthTokenPayload(parsed: unknown): ParsedOAuthTokens {
  const body = parsed && typeof parsed === 'object' ? parsed as Record<string, any> : {};
  if (body.ok === false) {
    throw new Error(String(body.error_description || body.error || 'oauth failed'));
  }
  const user = body.authed_user && typeof body.authed_user === 'object'
    ? body.authed_user as Record<string, any>
    : undefined;
  const accessToken = user?.access_token || body.access_token;
  if (!accessToken) {
    throw new Error(String(body.error_description || body.error || 'token response missing access_token'));
  }
  const refreshToken = user?.refresh_token || body.refresh_token;
  const expiresIn = Number(user?.expires_in ?? body.expires_in);
  const scope = user?.scope || body.scope;
  return {
    accessToken: String(accessToken),
    refreshToken: refreshToken ? String(refreshToken) : undefined,
    expiresAt: Number.isFinite(expiresIn) ? Date.now() + expiresIn * 1000 : undefined,
    scope: scope ? String(scope) : undefined,
  };
}

export function usesUserOauthScopes(auth: ConnectorOAuth2Auth): boolean {
  return auth.userScopes === true || connectorOAuthProvider(auth.authorizeUrl) === 'slack';
}

export function resolveAuthorizeRedirectUri(auth: ConnectorOAuth2Auth, loopbackUri: string): string {
  const pub = auth.redirectUri?.trim();
  return pub || loopbackUri;
}

export function resolveLoopbackListenPort(auth: ConnectorOAuth2Auth): number {
  if (Number.isInteger(auth.loopbackPort) && (auth.loopbackPort as number) > 0) {
    return auth.loopbackPort as number;
  }
  if (auth.redirectUri?.trim()) return SLACK_OAUTH_LOOPBACK_PORT;
  return 0;
}

export function buildConnectorAuthorizeUrl(input: {
  authorizeUrl: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes: string[];
  userScopes?: boolean;
}): string {
  const url = new URL(input.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  const slackUser = input.userScopes || connectorOAuthProvider(input.authorizeUrl) === 'slack';
  if (slackUser) {
    url.searchParams.set('user_scope', input.scopes.join(','));
  } else {
    url.searchParams.set('scope', input.scopes.join(' '));
  }
  if (connectorOAuthProvider(input.authorizeUrl) === 'google') {
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
  }
  return url.toString();
}

export function buildOAuthTokenBody(params: {
  grantType: 'authorization_code' | 'refresh_token';
  clientId: string;
  clientSecret?: string;
  code?: string;
  verifier?: string;
  redirectUri?: string;
  refreshToken?: string;
}): URLSearchParams {
  const body = new URLSearchParams({
    grant_type: params.grantType,
    client_id: params.clientId,
  });
  if (params.clientSecret) body.set('client_secret', params.clientSecret);
  if (params.grantType === 'authorization_code') {
    body.set('code', params.code || '');
    body.set('redirect_uri', params.redirectUri || '');
    body.set('code_verifier', params.verifier || '');
  } else {
    body.set('refresh_token', params.refreshToken || '');
  }
  return body;
}

export async function refreshConnectorToken(
  auth: ConnectorOAuth2Auth,
  cred: Extract<Credential, { kind: 'oauth2' }>,
  clientId: string,
  clientSecret?: string,
): Promise<Extract<Credential, { kind: 'oauth2' }>> {
  if (!cred.refreshToken) return cred;
  const tokenUrl = auth.refreshUrl || auth.tokenUrl;
  const body = buildOAuthTokenBody({
    grantType: 'refresh_token',
    clientId,
    clientSecret,
    refreshToken: cred.refreshToken,
  });
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
    redirect: 'error',
  });
  const text = await res.text();
  let parsed: any = {};
  try { parsed = JSON.parse(text); } catch { /* ignore */ }
  if (!res.ok && parsed.ok !== true) {
    throw new Error(parsed.error_description || parsed.error || `refresh failed ${res.status}`);
  }
  const tokens = parseOAuthTokenPayload(parsed);
  return {
    kind: 'oauth2',
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || cred.refreshToken,
    expiresAt: tokens.expiresAt ?? cred.expiresAt,
  };
}

export function oauthCredentialNeedsRefresh(cred: Credential): boolean {
  return cred.kind === 'oauth2'
    && !!cred.refreshToken
    && typeof cred.expiresAt === 'number'
    && cred.expiresAt < Date.now() + REFRESH_SKEW_MS;
}

export async function loadFreshCredential(
  pluginName: string,
  auth: ConnectorOAuth2Auth | { kind: string },
  connection: Record<string, unknown>,
): Promise<Credential | null> {
  const cred = await loadCredential(pluginName);
  if (!cred) return null;
  if (auth.kind !== 'oauth2' || !oauthCredentialNeedsRefresh(cred)) return cred;
  const oauth = auth as ConnectorOAuth2Auth;
  const clientId = resolveConnectorClientId(oauth, connection, oauth.authorizeUrl);
  if (!clientId) return cred;
  try {
    const secret = resolveConnectorClientSecret(oauth.authorizeUrl);
    const next = await refreshConnectorToken(
      oauth,
      cred as Extract<Credential, { kind: 'oauth2' }>,
      clientId,
      secret,
    );
    await saveCredential(pluginName, next);
    return next;
  } catch {
    return cred;
  }
}
