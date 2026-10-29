/**
 * T0 声明式执行器
 *
 *   把清单里的一条 operation 变成一次真实的 HTTP 调用。
 *
 *   顺序是刻意的: **闸门 → 建请求 → 注入凭据 → 发出**。
 *   凭据在最后一步才出现, 且不经过任何清单提供的内容 —— 插件作者能影响的是
 *   path/query/body 的形状, 影响不了 Authorization。
 *
 *   运行时再验一遍 URL 源
 *   --------------------
 *   baseUrl 的 path 里可能有 {{connection.cloudId}} 这类插值 (Confluence 就是),
 *   而 connection 的值来自本地连接表 —— 一旦那里被写脏, 拼出来的 URL 可能指向
 *   完全不同的主机, 而我们会**带着用户的 token** 打过去。
 *
 *   默认: 最终 URL 的 origin 必须与清单声明的 origin 完全一致。
 *   声明了 allowedHostSuffix 时 (Zendesk / Shopify): 主机必须是单个 DNS 标签
 *   + 清单里的字面量后缀。这是防凭据外泄的最后一道闸。
 */

import { evaluateGate, type GateContext, type GateDecision } from './gate.js';
import { interpolatePath, interpolateQuery, interpolateString, interpolateValue, MISSING } from './template.js';
import type { Credential } from './credentialStore.js';
import type {
  CapabilityId,
  ConnectorAuth,
  ConnectorOperation,
  PluginConnectorDefinition,
} from '@neoxlabs/platform/shared/plugin-connector.js';

export type ExecuteOptions = {
  connector: PluginConnectorDefinition;
  pluginName: string;
  capability: CapabilityId;
  input?: Record<string, unknown>;
  /** 安装期解析出来的连接变量, 如 Confluence 的 cloudId */
  connection?: Record<string, unknown>;
  credential: Credential;
  gate: GateContext;
  /** 便于测试注入; 默认用全局 fetch */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
};

export type ExecuteResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; code: string; message: string; status?: number; gate?: GateDecision };

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** 头部值里的 CR/LF 会被某些客户端解析成额外的头 —— 直接拒 */
function assertSafeHeaderValue(name: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`illegal characters in header "${name}"`);
  }
}

/** 清单里 baseUrl 去掉占位符后的 origin —— 用作最终 URL 的比对基准 */
function declaredOrigin(baseUrl: string): string {
  /* 占位符只可能出现在 host 之后 (校验器要求 baseUrl 以 https:// 开头且
   * host 段是字面量), 用一个安全替身填掉再解析 */
  const probe = baseUrl.replace(/\{\{[^}]+\}\}/g, 'x');
  return new URL(probe).origin;
}

/** 子域必须是单个 DNS 标签, 整机必须以 `.suffix` 结尾 */
export function hostMatchesAllowedSuffix(hostname: string, suffix: string): boolean {
  const host = hostname.toLowerCase();
  const s = suffix.trim().toLowerCase();
  if (!s || host === s || !host.endsWith(`.${s}`)) return false;
  const sub = host.slice(0, host.length - s.length - 1);
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(sub);
}

function pickResult(payload: unknown, path?: string): unknown {
  if (!path) return payload;
  let cur: unknown = payload;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

const PATH_TOKEN_MARK = '__NEOX_CRED_TOKEN__';

function encodeToken(raw: string, encoding?: 'plain' | 'base64'): string {
  return encoding === 'base64' ? Buffer.from(raw, 'utf8').toString('base64') : raw;
}

function credentialHeaders(auth: ConnectorAuth, cred: Credential): Record<string, string> {
  if (auth.kind === 'oauth2') {
    if (cred.kind !== 'oauth2') throw new Error('credential kind does not match manifest auth (expected oauth2)');
    return { Authorization: `Bearer ${cred.accessToken}` };
  }
  if (auth.kind === 'token') {
    if (cred.kind !== 'token') throw new Error('credential kind does not match manifest auth (expected token)');
    if (!auth.header) return {};
    const token = encodeToken(cred.token, auth.tokenEncoding);
    const value = auth.valueTemplate
      ? auth.valueTemplate.replace('{{token}}', token)
      : token;
    return { [auth.header]: value };
  }
  return {};
}

/** 按大小上限读响应, 超限即中止 —— 不给恶意/异常上游撑爆内存的机会 */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`response exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function executeCapability(opts: ExecuteOptions): Promise<ExecuteResult> {
  const {
    connector, pluginName, capability, input = {}, connection = {}, credential, gate,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  } = opts;

  const operation: ConnectorOperation | undefined =
    connector.operations.find(o => o.capability === capability);
  if (!operation) {
    return { ok: false, code: 'operation_not_found', message: `no operation implements "${capability}" in ${pluginName}` };
  }

  // ── 闸门先行 ─────────────────────────────────────────────────────────
  const decision = evaluateGate(connector, pluginName, capability, gate);
  if (!decision.allow) {
    return {
      ok: false,
      code: decision.code,
      message: decision.message.zh ?? decision.message.en,
      gate: decision,
    };
  }

  // ── 建请求 (此时还没有凭据) ───────────────────────────────────────────
  const scope = { input, connection };
  const pathInject = connector.auth.kind === 'token' && connector.auth.pathInject === true;
  let url: URL;
  try {
    const base = interpolatePath(connector.baseUrl, scope);
    const pathTemplate = pathInject
      ? operation.path.replace(/\{\{\s*token\s*\}\}/g, PATH_TOKEN_MARK)
      : operation.path;
    const opPath = interpolatePath(pathTemplate, scope);
    url = new URL(base.replace(/\/+$/, '') + opPath);
  } catch (err: any) {
    return { ok: false, code: 'bad_input', message: err?.message ?? 'failed to build request URL' };
  }

  /* 见文件头: 拼完必须还在声明的那个 origin / 后缀上 */
  const suffix = typeof connector.allowedHostSuffix === 'string'
    ? connector.allowedHostSuffix.trim().toLowerCase()
    : '';
  if (suffix) {
    if (!hostMatchesAllowedSuffix(url.hostname, suffix)) {
      return {
        ok: false,
        code: 'origin_mismatch',
        message: `refusing to send credentials to ${url.origin}; host must be a single label under ${suffix}`,
      };
    }
  } else {
    const expected = declaredOrigin(connector.baseUrl);
    if (url.origin !== expected) {
      return {
        ok: false,
        code: 'origin_mismatch',
        message: `refusing to send credentials to ${url.origin}; manifest declares ${expected}`,
      };
    }
  }
  if (url.protocol !== 'https:') {
    return { ok: false, code: 'insecure_url', message: 'only https endpoints are allowed' };
  }

  if (pathInject) {
    if (credential.kind !== 'token') {
      return { ok: false, code: 'credential_mismatch', message: 'pathInject requires a token credential' };
    }
    const token = encodeToken(credential.token, connector.auth.kind === 'token' ? connector.auth.tokenEncoding : undefined);
    url.pathname = url.pathname.replaceAll(PATH_TOKEN_MARK, encodeURIComponent(token));
  }

  for (const [k, v] of Object.entries(interpolateQuery(operation.query, scope))) {
    url.searchParams.set(k, v);
  }

  if (connector.auth.kind === 'token' && connector.auth.queryParam) {
    if (credential.kind !== 'token') {
      return { ok: false, code: 'credential_mismatch', message: 'queryParam requires a token credential' };
    }
    const token = encodeToken(credential.token, connector.auth.tokenEncoding);
    url.searchParams.set(connector.auth.queryParam, token);
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  for (const [k, v] of Object.entries(connector.headers ?? {})) {
    const resolved = interpolateString(v, scope);
    if (resolved === MISSING || resolved === null || resolved === undefined || typeof resolved === 'object') {
      return { ok: false, code: 'bad_input', message: `missing header value for ${k}` };
    }
    const headerValue = String(resolved);
    assertSafeHeaderValue(k, headerValue);
    headers[k] = headerValue;
  }

  let body: string | undefined;
  if (operation.body && operation.method !== 'GET' && operation.method !== 'DELETE') {
    const resolved = interpolateValue(operation.body, scope);
    if (resolved !== MISSING) {
      body = JSON.stringify(resolved);
      headers['Content-Type'] = 'application/json';
    }
  }

  // ── 凭据最后注入 ─────────────────────────────────────────────────────
  try {
    for (const [k, v] of Object.entries(credentialHeaders(connector.auth, credential))) {
      assertSafeHeaderValue(k, v);
      headers[k] = v;
    }
  } catch (err: any) {
    return { ok: false, code: 'credential_mismatch', message: err?.message ?? 'invalid credential' };
  }

  // ── 发出 ─────────────────────────────────────────────────────────────
  try {
    const res = await fetchImpl(url.toString(), {
      method: operation.method,
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error', // 跟随跳转可能把 Authorization 带去别的主机
    });

    const text = await readCapped(res, maxResponseBytes);
    let parsed: unknown = text;
    if (text) {
      try { parsed = JSON.parse(text); } catch { /* 保留原文, 有些端点返回非 JSON */ }
    }

    if (!res.ok) {
      return {
        ok: false,
        code: 'upstream_error',
        status: res.status,
        /* 上游报错原文可能含敏感信息, 截断; 不回显请求头 */
        message: typeof text === 'string' ? text.slice(0, 500) : `upstream returned ${res.status}`,
      };
    }

    return { ok: true, status: res.status, data: pickResult(parsed, operation.resultPath) };
  } catch (err: any) {
    /* 绝不把 headers 带进错误 —— 那里有 token */
    return { ok: false, code: 'request_failed', message: err?.message ?? 'request failed' };
  }
}
