
import * as crypto from 'crypto';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { URL } from 'url';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { CONFIG_DIR, getActiveUserDir } from '@neoxlabs/platform/utils/config.js';

// ============================================================================
// 常量
// ============================================================================

/** OAuth 请求超时 */
const AUTH_REQUEST_TIMEOUT_MS = 30_000;

/** 授权等待超时（用户操作浏览器） */
const AUTH_FLOW_TIMEOUT_MS = 5 * 60 * 1000;

/** Token 存储文件名 */
const TOKEN_STORE_FILE = 'mcp-oauth-tokens.json';

/** Token 提前刷新窗口（过期前 5 分钟刷新） */
const PROACTIVE_REFRESH_BUFFER_S = 300;

/** Token 刷新最大重试次数 */
const MAX_REFRESH_ATTEMPTS = 3;

/** OAuth 回调路径 */
const CALLBACK_PATH = '/callback';

/** PKCE code_verifier 长度 */
const CODE_VERIFIER_LENGTH = 64;

// ============================================================================
// 类型定义
// ============================================================================

export interface OAuthServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  response_types_supported?: string[];
  grant_types_supported?: string[];
}

export interface OAuthClientInfo {
  client_id: string;
  client_secret?: string;
}

export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in?: number;
  scope?: string;
}

export interface StoredOAuthData {
  serverName: string;
  serverUrl: string;
  clientId: string;
  clientSecret?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope?: string;
  authorizationServerUrl?: string;
}

// ============================================================================
// 1. OAuth 元数据发现 (RFC 9728 + RFC 8414)
// ============================================================================

/**
 * 发现 OAuth 服务器元数据
 *
 * 探测顺序:
 * 1. RFC 9728: /.well-known/oauth-protected-resource → authorization_servers[0]
 * 2. RFC 8414: /.well-known/oauth-authorization-server/{path}
 * 3. 回退: /.well-known/oauth-authorization-server (无路径)
 */
export async function discoverOAuthMetadata(
  serverUrl: string,
): Promise<OAuthServerMetadata | null> {
  const url = new URL(serverUrl);

  // Step 1: RFC 9728 — probe protected resource metadata
  try {
    const resourceUrl = new URL('/.well-known/oauth-protected-resource', url.origin);
    const resourceResp = await fetchWithTimeout(resourceUrl.toString());
    if (resourceResp.ok) {
      const resourceMeta = await resourceResp.json() as any;
      const authServers = resourceMeta.authorization_servers;
      if (Array.isArray(authServers) && authServers.length > 0) {
        // 拿到 authorization server URL，再获取其元数据
        const asUrl = authServers[0];
        const asMeta = await fetchAuthServerMetadata(asUrl);
        if (asMeta) return asMeta;
      }
    }
  } catch {
    // 继续回退
  }

  // Step 2: RFC 8414 — path-aware probe
  const pathSegment = url.pathname !== '/' ? url.pathname : '';
  if (pathSegment) {
    try {
      const wellKnown = new URL(
        `/.well-known/oauth-authorization-server${pathSegment}`,
        url.origin,
      );
      const meta = await fetchAuthServerMetadata(wellKnown.toString());
      if (meta) return meta;
    } catch {
      // 继续回退
    }
  }

  // Step 3: RFC 8414 — root probe (无路径)
  try {
    const wellKnown = new URL(
      '/.well-known/oauth-authorization-server',
      url.origin,
    );
    return await fetchAuthServerMetadata(wellKnown.toString());
  } catch {
    return null;
  }
}

async function fetchAuthServerMetadata(url: string): Promise<OAuthServerMetadata | null> {
  const resp = await fetchWithTimeout(url);
  if (!resp.ok) return null;

  const data = await resp.json() as any;
  if (!data.authorization_endpoint || !data.token_endpoint) {
    return null;
  }
  return data as OAuthServerMetadata;
}

// ============================================================================
// 2. 动态客户端注册 (RFC 7591)
// ============================================================================

/**
 * 动态注册 OAuth 客户端（public client，无需 client_secret）
 */
export async function dynamicClientRegistration(
  metadata: OAuthServerMetadata,
  redirectUri: string,
  serverName: string,
): Promise<OAuthClientInfo> {
  if (!metadata.registration_endpoint) {
    throw new Error(
      `OAuth server does not support dynamic client registration (no registration_endpoint). ` +
      `You may need to manually configure client_id for server "${serverName}".`,
    );
  }

  const clientMetadata = {
    client_name: `Neox (${serverName})`,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none', // Public client — PKCE only
  };

  const resp = await fetchWithTimeout(metadata.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(clientMetadata),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(
      `Dynamic client registration failed (${resp.status}): ${body.slice(0, 200)}`,
    );
  }

  const result = await resp.json() as any;
  if (!result.client_id) {
    throw new Error('Dynamic client registration response missing client_id');
  }

  cliLogger.info('MCP_OAuth',
    `Registered client "${clientMetadata.client_name}" → client_id=${result.client_id}`,
  );

  return {
    client_id: result.client_id,
    client_secret: result.client_secret,
  };
}

// ============================================================================
// 3. PKCE 授权码流程 (RFC 7636)
// ============================================================================

/**
 * 生成 PKCE code_verifier（43-128 字符的随机 URL-safe 字符串）
 */
export function generateCodeVerifier(): string {
  return crypto.randomBytes(CODE_VERIFIER_LENGTH)
    .toString('base64url')
    .slice(0, 128);
}

/**
 * 生成 PKCE code_challenge（S256）
 */
export function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256')
    .update(verifier)
    .digest('base64url');
}

/**
 * 构建授权 URL
 */
export function buildAuthorizationUrl(
  metadata: OAuthServerMetadata,
  clientId: string,
  redirectUri: string,
  codeChallenge: string,
  state: string,
  scope?: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });

  if (scope) {
    params.set('scope', scope);
  }

  return `${metadata.authorization_endpoint}?${params.toString()}`;
}

/**
 * 启动本地 callback 服务器，等待 OAuth 重定向
 *
 * @returns Promise<{ code, state }> — 授权码和 state
 */
export function startCallbackServer(
  expectedState: string,
): Promise<{ code: string; port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settleOnce = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };

    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url || '/', `http://localhost`);

      if (reqUrl.pathname !== CALLBACK_PATH) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      const code = reqUrl.searchParams.get('code');
      const state = reqUrl.searchParams.get('state');
      const error = reqUrl.searchParams.get('error');

      if (error) {
        const errorDesc = reqUrl.searchParams.get('error_description') || error;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h1>Authentication Failed</h1><p>${escapeHtml(errorDesc)}</p><p>You can close this window.</p>`);
        settleOnce(() => reject(new Error(`OAuth error: ${errorDesc}`)));
        return;
      }

      if (state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>Error</h1><p>State mismatch — possible CSRF attack.</p>');
        settleOnce(() => reject(new Error('OAuth state mismatch — possible CSRF attack')));
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>Error</h1><p>Missing authorization code.</p>');
        settleOnce(() => reject(new Error('Missing authorization code in callback')));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>Authentication Successful</h1><p>You can close this window and return to Neox.</p>');

      settleOnce(() => resolve({
        code,
        port: (server.address() as any).port,
        close: () => server.close(),
      }));
    });

    // 超时
    const timeout = setTimeout(() => {
      settleOnce(() => {
        server.close();
        reject(new Error(`OAuth flow timed out after ${AUTH_FLOW_TIMEOUT_MS / 1000}s`));
      });
    }, AUTH_FLOW_TIMEOUT_MS);
    (timeout as any).unref?.(); // 不阻止进程退出

    // 端口冲突
    server.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      if (err.code === 'EADDRINUSE') {
        settleOnce(() => reject(new Error(
          `OAuth callback port is already in use. Try again or configure a different port.`,
        )));
      } else {
        settleOnce(() => reject(err));
      }
    });

    // 监听 127.0.0.1（RFC 8252 S7.3: loopback only）
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      cliLogger.debug('MCP_OAuth', `Callback server listening on port ${addr.port}`);
    });
  });
}

/**
 * 用授权码换取 token
 */
export async function exchangeCodeForTokens(
  metadata: OAuthServerMetadata,
  clientId: string,
  clientSecret: string | undefined,
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<OAuthTokens> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  });

  if (clientSecret) {
    params.set('client_secret', clientSecret);
  }

  const resp = await fetchWithTimeout(metadata.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Token exchange failed (${resp.status}): ${body.slice(0, 300)}`);
  }

  const tokens = await resp.json() as any;
  if (!tokens.access_token) {
    throw new Error('Token exchange response missing access_token');
  }

  return tokens as OAuthTokens;
}

// ============================================================================
// 4. Token 存储
// ============================================================================

function getTokenStorePath(): string {
  try {
    return path.join(getActiveUserDir(), TOKEN_STORE_FILE);
  } catch {
    return path.join(CONFIG_DIR, TOKEN_STORE_FILE);
  }
}

/**
 * 生成 server key（SHA256 签名，防止同名不同配置复用 token）
 */
export function getServerKey(serverName: string, serverUrl: string): string {
  const hash = crypto.createHash('sha256')
    .update(JSON.stringify({ name: serverName, url: serverUrl }))
    .digest('hex')
    .substring(0, 16);
  return `${serverName}|${hash}`;
}

function loadTokenStore(): Record<string, StoredOAuthData> {
  try {
    const raw = fs.readFileSync(getTokenStorePath(), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveTokenStore(store: Record<string, StoredOAuthData>): void {
  const dir = path.dirname(getTokenStorePath());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // 限制文件权限 — token 是敏感数据
  fs.writeFileSync(getTokenStorePath(), JSON.stringify(store, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

/**
 * 存储 token
 */
export function storeTokens(
  serverName: string,
  serverUrl: string,
  clientInfo: OAuthClientInfo,
  tokens: OAuthTokens,
  authServerUrl?: string,
): void {
  const key = getServerKey(serverName, serverUrl);
  const store = loadTokenStore();

  store[key] = {
    serverName,
    serverUrl,
    clientId: clientInfo.client_id,
    clientSecret: clientInfo.client_secret,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    scope: tokens.scope,
    authorizationServerUrl: authServerUrl,
  };

  saveTokenStore(store);
  cliLogger.info('MCP_OAuth', `Stored tokens for ${serverName}`);
}

/**
 * 读取已存储的 token
 */
export function loadStoredTokens(
  serverName: string,
  serverUrl: string,
): StoredOAuthData | null {
  const key = getServerKey(serverName, serverUrl);
  const store = loadTokenStore();
  return store[key] ?? null;
}

/**
 * 清除指定服务器的 token
 */
export function clearStoredTokens(serverName: string, serverUrl: string): void {
  const key = getServerKey(serverName, serverUrl);
  const store = loadTokenStore();
  delete store[key];
  saveTokenStore(store);
}

// ============================================================================
// 5. Token 刷新
// ============================================================================

/**
 * 刷新 access_token
 */
export async function refreshAccessToken(
  metadata: OAuthServerMetadata,
  stored: StoredOAuthData,
): Promise<OAuthTokens | null> {
  if (!stored.refreshToken) {
    return null;
  }

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: stored.refreshToken,
    client_id: stored.clientId,
  });

  if (stored.clientSecret) {
    params.set('client_secret', stored.clientSecret);
  }

  for (let attempt = 1; attempt <= MAX_REFRESH_ATTEMPTS; attempt++) {
    try {
      const resp = await fetchWithTimeout(metadata.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');

        // invalid_grant = token 已被撤销或过期
        if (resp.status === 400 && body.includes('invalid_grant')) {
          cliLogger.warn('MCP_OAuth',
            `Refresh token invalid for ${stored.serverName} — clearing stored tokens`,
          );
          clearStoredTokens(stored.serverName, stored.serverUrl);
          return null;
        }

        // 可重试的错误
        if (resp.status >= 500 && attempt < MAX_REFRESH_ATTEMPTS) {
          const delay = 1000 * Math.pow(2, attempt - 1);
          await sleep(delay);
          continue;
        }

        throw new Error(`Token refresh failed (${resp.status}): ${body.slice(0, 200)}`);
      }

      const tokens = await resp.json() as OAuthTokens;
      if (!tokens.access_token) {
        throw new Error('Refresh response missing access_token');
      }

      return tokens;
    } catch (error: any) {
      if (attempt >= MAX_REFRESH_ATTEMPTS) throw error;

      // 网络错误可重试
      if (isRetryableError(error)) {
        const delay = 1000 * Math.pow(2, attempt - 1);
        await sleep(delay);
        continue;
      }
      throw error;
    }
  }

  return null;
}

// ============================================================================
// 6. 主入口：完整 OAuth 流程
// ============================================================================

export interface OAuthFlowOptions {
  /** MCP 服务器名称 */
  serverName: string;
  /** MCP 服务器 URL */
  serverUrl: string;
  /** 手动配置的 client_id（跳过 DCR） */
  clientId?: string;
  /** 手动配置的 client_secret */
  clientSecret?: string;
  /** 打开浏览器的回调 */
  openBrowser?: (url: string) => Promise<void>;
  /** 请求的 scope */
  scope?: string;
}

export interface OAuthFlowResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

/**
 * 执行完整 OAuth 认证流程
 *
 * 1. 检查已存储的 token（有效则直接返回）
 * 2. 尝试刷新（如果有 refresh_token 且即将过期）
 * 3. 发现 OAuth 元数据 (RFC 9728)
 * 4. 动态注册客户端 (RFC 7591)（如果无 client_id）
 * 5. PKCE 授权码流程
 * 6. 存储 token
 */
export async function performOAuthFlow(
  options: OAuthFlowOptions,
): Promise<OAuthFlowResult> {
  const { serverName, serverUrl, scope } = options;

  // --- Step 1: 检查已存储的 token ---
  const stored = loadStoredTokens(serverName, serverUrl);
  if (stored) {
    const expiresIn = (stored.expiresAt - Date.now()) / 1000;

    // 还有 >5 分钟有效期，直接返回
    if (expiresIn > PROACTIVE_REFRESH_BUFFER_S) {
      return {
        accessToken: stored.accessToken,
        refreshToken: stored.refreshToken,
        expiresAt: stored.expiresAt,
      };
    }

    // --- Step 2: 尝试刷新 ---
    if (stored.refreshToken) {
      cliLogger.info('MCP_OAuth',
        `Token for ${serverName} expires in ${Math.floor(expiresIn)}s, refreshing...`,
      );

      try {
        // 需要元数据来获取 token_endpoint
        const metadata = await discoverOAuthMetadata(serverUrl);
        if (metadata) {
          const refreshed = await refreshAccessToken(metadata, stored);
          if (refreshed) {
            storeTokens(
              serverName, serverUrl,
              { client_id: stored.clientId, client_secret: stored.clientSecret },
              refreshed,
              stored.authorizationServerUrl,
            );
            return {
              accessToken: refreshed.access_token,
              refreshToken: refreshed.refresh_token,
              expiresAt: Date.now() + (refreshed.expires_in ?? 3600) * 1000,
            };
          }
        }
      } catch (error: any) {
        cliLogger.warn('MCP_OAuth', `Refresh failed for ${serverName}: ${error.message}`);
        // 刷新失败，继续走全量认证
      }
    }
  }

  // --- Step 3: 发现 OAuth 元数据 ---
  cliLogger.info('MCP_OAuth', `Discovering OAuth metadata for ${serverUrl}...`);
  const metadata = await discoverOAuthMetadata(serverUrl);
  if (!metadata) {
    throw new Error(
      `Cannot discover OAuth metadata for ${serverUrl}. ` +
      `The server may not support OAuth or the URL is incorrect.`,
    );
  }

  // --- Step 4: 获取/注册客户端 ---
  let clientInfo: OAuthClientInfo;

  if (options.clientId) {
    // 手动配置的 client_id
    clientInfo = {
      client_id: options.clientId,
      client_secret: options.clientSecret,
    };
  } else if (stored?.clientId) {
    // 复用之前注册的 client_id
    clientInfo = {
      client_id: stored.clientId,
      client_secret: stored.clientSecret,
    };
  } else {
    // 动态注册 (RFC 7591)
    // 先启动 callback server 获取端口
    const tempState = crypto.randomBytes(32).toString('base64url');
    const callbackPromise = startCallbackServer(tempState);

    // 等 server 启动以获取端口
    // 实际上我们需要先知道端口才能注册 redirect_uri
    // 所以先用 port 0 启动，然后构建 redirect_uri
    // 但 startCallbackServer 是阻塞等待的...
    // 换一种方式：先找一个可用端口

    const port = await findAvailablePort();
    const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;

    clientInfo = await dynamicClientRegistration(metadata, redirectUri, serverName);
  }

  // --- Step 5: PKCE 授权码流程 ---
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = crypto.randomBytes(32).toString('base64url');

  // 启动 callback server
  const callbackPromise = startCallbackServer(state);

  // 等待 server 启动获取实际端口（使用微小延迟让 listen 完成）
  await sleep(50);

  // 从 callbackPromise 还不能拿端口，因为它要等 code 回来
  // 我们需要另一种方法...让我重新设计

  // 更好的方式：先创建 server，拿到端口，再构建 URL
  const { server: cbServer, port: cbPort } = await createCallbackServerRaw();
  const redirectUri = `http://127.0.0.1:${cbPort}${CALLBACK_PATH}`;

  // 如果之前没注册客户端（动态注册需要 redirect_uri），现在注册
  if (!options.clientId && !stored?.clientId) {
    clientInfo = await dynamicClientRegistration(metadata, redirectUri, serverName);
  }

  const authUrl = buildAuthorizationUrl(
    metadata, clientInfo.client_id, redirectUri, codeChallenge, state,
    scope || getScopeFromMetadata(metadata),
  );

  cliLogger.info('MCP_OAuth', `Opening browser for authorization...`);

  // 打开浏览器
  if (options.openBrowser) {
    await options.openBrowser(authUrl);
  } else {
    await openUrlInBrowser(authUrl);
  }

  // 等待回调
  const code = await waitForCallback(cbServer, state, AUTH_FLOW_TIMEOUT_MS);

  // --- Step 6: 换取 token ---
  const tokens = await exchangeCodeForTokens(
    metadata, clientInfo.client_id, clientInfo.client_secret,
    code, redirectUri, codeVerifier,
  );

  // 存储
  storeTokens(
    serverName, serverUrl, clientInfo, tokens,
    metadata.issuer || serverUrl,
  );

  cliLogger.info('MCP_OAuth', `Authentication successful for ${serverName}`);

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  };
}

/**
 * 获取有效的 access_token（自动刷新/重新认证）
 * 供 clientManager 在请求前调用
 */
export async function getValidAccessToken(
  serverName: string,
  serverUrl: string,
): Promise<string | null> {
  const stored = loadStoredTokens(serverName, serverUrl);
  if (!stored) return null;

  const expiresIn = (stored.expiresAt - Date.now()) / 1000;
  if (expiresIn > PROACTIVE_REFRESH_BUFFER_S) {
    return stored.accessToken;
  }

  // 尝试刷新
  if (stored.refreshToken) {
    try {
      const metadata = await discoverOAuthMetadata(serverUrl);
      if (metadata) {
        const refreshed = await refreshAccessToken(metadata, stored);
        if (refreshed) {
          storeTokens(
            serverName, serverUrl,
            { client_id: stored.clientId, client_secret: stored.clientSecret },
            refreshed,
          );
          return refreshed.access_token;
        }
      }
    } catch {
      // 刷新失败
    }
  }

  return null; // 需要重新认证
}

// ============================================================================
// 辅助函数
// ============================================================================

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getScopeFromMetadata(metadata: OAuthServerMetadata): string | undefined {
  if (metadata.scopes_supported && metadata.scopes_supported.length > 0) {
    return metadata.scopes_supported.join(' ');
  }
  return undefined;
}

async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_REQUEST_TIMEOUT_MS);

  try {
    const resp = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(init?.headers || {}),
      },
    });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

function isRetryableError(error: any): boolean {
  const msg = String(error?.message || '').toLowerCase();
  return msg.includes('timeout') || msg.includes('etimedout') ||
    msg.includes('econnreset') || msg.includes('fetch failed');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function createCallbackServerRaw(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      resolve({ server, port });
    });
    server.on('error', reject);
  });
}

function waitForCallback(
  server: http.Server,
  expectedState: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settleOnce = (fn: () => void) => {
      if (!settled) { settled = true; fn(); }
    };

    const timeout = setTimeout(() => {
      settleOnce(() => {
        server.close();
        reject(new Error(`OAuth callback timed out after ${timeoutMs / 1000}s`));
      });
    }, timeoutMs);
    (timeout as any).unref?.();

    server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
      const reqUrl = new URL(req.url || '/', `http://localhost`);
      if (reqUrl.pathname !== CALLBACK_PATH) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      const code = reqUrl.searchParams.get('code');
      const state = reqUrl.searchParams.get('state');
      const error = reqUrl.searchParams.get('error');

      if (error) {
        const desc = reqUrl.searchParams.get('error_description') || error;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h1>Authentication Failed</h1><p>${escapeHtml(desc)}</p>`);
        settleOnce(() => { clearTimeout(timeout); server.close(); reject(new Error(`OAuth: ${desc}`)); });
        return;
      }

      if (state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>Error</h1><p>State mismatch.</p>');
        settleOnce(() => { clearTimeout(timeout); server.close(); reject(new Error('State mismatch')); });
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>Error</h1><p>Missing code.</p>');
        settleOnce(() => { clearTimeout(timeout); server.close(); reject(new Error('Missing code')); });
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>Authentication Successful</h1><p>You can close this window.</p>');
      settleOnce(() => { clearTimeout(timeout); server.close(); resolve(code); });
    });
  });
}

async function openUrlInBrowser(url: string): Promise<void> {
  const { exec } = await import('child_process');
  const platform = process.platform;

  const cmd = platform === 'darwin' ? `open "${url}"`
    : platform === 'win32' ? `start "${url}"`
    : `xdg-open "${url}"`;

  return new Promise((resolve) => {
    exec(cmd, (error) => {
      if (error) {
        cliLogger.warn('MCP_OAuth',
          `Failed to open browser automatically. Please visit:\n${url}`,
        );
      }
      resolve();
    });
  });
}
