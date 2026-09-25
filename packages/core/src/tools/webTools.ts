
import type { LLMProvider, Tool } from '@neoxlabs/kernel/types/index.js';
import fs from 'node:fs';
import { createContextualResult } from '@neoxlabs/kernel/core/types/toolResult.js';
import { getActiveConfigFile, loadConfig, onUserIdChange } from '@neoxlabs/platform/utils/config.js';
import { unwrapApiKey } from '@neoxlabs/platform/utils/apiKeyCrypto.js';
import { truncateUtf16Safe } from '@neoxlabs/kernel/utils/wireText.js';
import { applyGrokCliHeaders } from '@neoxlabs/kernel/utils/grokCliTransport.js';
import https from 'https';
import zlib from 'node:zlib';
import http from 'http';
import { resolveGithubToken } from './githubToken.js';
import type { Agent } from 'http';
import { checkFetchTarget } from './web/fetchTargetGuard.js';
import { createHash } from 'node:crypto';
import { resolveProviderEntry } from '@neoxlabs/platform/platform/providerResolver.js';

// ==================== Proxy Detection (Codex-compatible) ====================

interface ProxyConfig {
  httpProxy: string | null;
  httpsProxy: string | null;
  allProxy: string | null;
  noProxy: string[];
}

let cachedProxyConfig: ProxyConfig | null = null;
/** mtime 缓存带 path, 兼容测试/未来 active config 路径变化; 只存 mtimeMs 容易误判缓存新旧. */
let cachedRuntimeConfig: { path: string; mtimeMs: number; config: Record<string, unknown> } | null = null;

const WEB_SEARCH_CACHE_TTL_MS = Number(process.env.NEOX_WEB_SEARCH_CACHE_TTL_MS) || 5 * 60_000;
const webSearchCache = new Map<string, {
  expiresAt: number;
  result: { results: WebSearchResult[]; images?: WebImageResult[]; backend: WebSearchBackend };
}>();
const webSearchInflight = new Map<string, Promise<{ results: WebSearchResult[]; images?: WebImageResult[]; backend: WebSearchBackend; error?: string }>>();

/* P0: 用户切换时必须清掉所有缓存 — A 的搜索结果不能给 B 复用,
 *   runtime config 也跟着 active config 路径走, 一并清掉. */
onUserIdChange((next, prev) => {
  void next; void prev;
  webSearchCache.clear();
  webSearchInflight.clear();
  cachedRuntimeConfig = null;
});

type WebSearchBackend = 'custom-url' | 'provider-api' | 'serper' | 'bocha' | 'none' | 'kimi-builtin' | 'neox-gateway';

/** 实时读 active config 文件的 mtime. 不缓存路径, 兼容测试/未来路径策略变化. */
function getConfigMtimeMs(): number {
  try {
    return fs.statSync(getActiveConfigFile()).mtimeMs;
  } catch {
    return 0;
  }
}

function loadRuntimeConfig(): Record<string, unknown> {
  const activePath = getActiveConfigFile();
  const mtimeMs = getConfigMtimeMs();
  if (cachedRuntimeConfig
      && cachedRuntimeConfig.path === activePath
      && cachedRuntimeConfig.mtimeMs === mtimeMs) {
    return cachedRuntimeConfig.config;
  }
  const config = loadConfig();
  const configRecord = config as unknown as Record<string, unknown>;
  cachedRuntimeConfig = { path: activePath, mtimeMs, config: configRecord };
  return configRecord;
}

function normalizeSearchQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLowerCase();
}

function buildWebSearchCacheKey(query: string, maxResults: number, provider: ProviderLike | null, endpoint: string | null, freshness: SearchFreshness = 'all'): string {
  return JSON.stringify({
    query: normalizeSearchQuery(query),
    maxResults,
    /* 时效档必须进键 —— 否则「近一周」会命中上一次「不限」的缓存, 拿到一模一样的旧结果 */
    freshness,
    protocol: provider?.protocol || '',
    baseUrl: provider?.baseUrl || '',
    endpoint: endpoint || '',
    model: resolveProviderModel(provider),
  });
}

function cleanupExpiredWebSearchCache(): void {
  const now = Date.now();
  for (const [key, entry] of webSearchCache.entries()) {
    if (entry.expiresAt <= now) {
      webSearchCache.delete(key);
    }
  }
}

/**
 * Detect proxy configuration from environment variables.
 * Follows the same priority as Codex: HTTPS_PROXY > HTTP_PROXY > ALL_PROXY
 */
function detectProxyConfig(): ProxyConfig {
  if (cachedProxyConfig) return cachedProxyConfig;

  const readEnv = (...keys: string[]): string | null => {
    for (const key of keys) {
      const val = (process.env[key] || '').trim();
      if (val) return val;
    }
    return null;
  };

  cachedProxyConfig = {
    httpProxy: readEnv('HTTP_PROXY', 'http_proxy'),
    httpsProxy: readEnv('HTTPS_PROXY', 'https_proxy'),
    allProxy: readEnv('ALL_PROXY', 'all_proxy'),
    noProxy: (readEnv('NO_PROXY', 'no_proxy') || '').split(',').map(s => s.trim()).filter(Boolean),
  };

  const active = cachedProxyConfig.httpsProxy || cachedProxyConfig.httpProxy || cachedProxyConfig.allProxy;
  if (active) {
    console.log(`[WebTools] 🔗 Proxy detected: ${active}`);
  }

  return cachedProxyConfig;
}

/**
 * Get the appropriate proxy URL for a given target URL.
 * Returns null if no proxy should be used.
 */
function getProxyForUrl(targetUrl: string): string | null {
  const config = detectProxyConfig();

  // Check NO_PROXY exclusions
  try {
    const hostname = new URL(targetUrl).hostname;
    if (config.noProxy.some(pattern => {
      if (pattern === '*') return true;
      if (pattern.startsWith('.')) return hostname.endsWith(pattern) || hostname === pattern.slice(1);
      return hostname === pattern || hostname.endsWith('.' + pattern);
    })) {
      return null;
    }
  } catch {
    // Invalid URL, skip NO_PROXY check
  }

  const isHttps = targetUrl.startsWith('https://');
  if (isHttps) {
    return config.httpsProxy || config.httpProxy || config.allProxy;
  }
  return config.httpProxy || config.allProxy;
}

/**
 * Proxy-aware fetch: automatically routes through detected proxy if available.
 * Falls back to global fetch() when no proxy is configured.
 */
async function proxyAwareFetch(
  url: string,
  init?: RequestInit & { signal?: AbortSignal },
): Promise<Response> {
  const proxyUrl = getProxyForUrl(url);

  if (!proxyUrl) {
    // No proxy — use native fetch
    return fetch(url, init);
  }

  // Use https-proxy-agent for proxy support
  try {
    const { HttpsProxyAgent } = await import('https-proxy-agent');
    const agent = new HttpsProxyAgent(proxyUrl);

    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      Object.entries(h).forEach(([k, v]) => { headers[k] = v; });
    }
    let method = init?.method || 'GET';
    let body: RequestInit['body'] = init?.body;
    const followRedirects = init?.redirect !== 'manual' && init?.redirect !== 'error';

    const requestOnce = (targetUrl: string): Promise<{ res: http.IncomingMessage; body: Buffer }> =>
      new Promise((resolve, reject) => {
        const parsedUrl = new URL(targetUrl);
        const isHttps = parsedUrl.protocol === 'https:';
        const lib = isHttps ? https : http;
        const reqOptions: https.RequestOptions = {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (isHttps ? 443 : 80),
          path: parsedUrl.pathname + parsedUrl.search,
          method,
          headers,
          agent: agent as Agent,
        };
        const req = lib.request(reqOptions, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const raw = Buffer.concat(chunks);
            const enc = String(res.headers['content-encoding'] || '').toLowerCase();
            let decoded = raw;
            try {
              if (enc.includes('br')) decoded = zlib.brotliDecompressSync(raw);
              else if (enc.includes('gzip')) decoded = zlib.gunzipSync(raw);
              else if (enc.includes('deflate')) {
                try { decoded = zlib.inflateSync(raw); } catch { decoded = zlib.inflateRawSync(raw); }
              }
            } catch { decoded = raw; }
            resolve({ res, body: decoded });
          });
          res.on('error', reject);
        });
        if (init?.signal) {
          const onAbort = () => {
            req.destroy();
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          };
          if (init.signal.aborted) onAbort();
          else init.signal.addEventListener('abort', onAbort, { once: true });
        }
        req.on('error', reject);
        if (body) {
          req.write(typeof body === 'string' ? body : JSON.stringify(body));
        }
        req.end();
      });

    let current = url;
    for (let hop = 0; hop < 6; hop++) {
      const { res, body: payload } = await requestOnce(current);
      const status = res.statusCode || 200;
      const location = res.headers.location;
      if (followRedirects && location && status >= 300 && status < 400 && hop < 5) {
        current = new URL(String(location), current).href;
        /* 303 / 301+POST 按浏览器惯例降级成 GET, 不重复发 body */
        if (status === 303 || ((status === 301 || status === 302) && method !== 'GET' && method !== 'HEAD')) {
          method = 'GET';
          body = undefined;
        }
        continue;
      }
      const responseHeaders = new Headers();
      Object.entries(res.headers).forEach(([k, v]) => {
        if (v && k.toLowerCase() !== 'content-encoding' && k.toLowerCase() !== 'content-length') {
          responseHeaders.set(k, Array.isArray(v) ? v.join(', ') : v);
        }
      });
      const response = new Response(new Uint8Array(payload), {
        status,
        statusText: res.statusMessage || '',
        headers: responseHeaders,
      });
      Object.defineProperty(response, 'url', { value: current, configurable: true });
      return response;
    }
    throw new Error('Too many redirects');
  } catch (importError) {
    // https-proxy-agent not available, log warning and fallback
    console.warn('[WebTools] ⚠️ Proxy configured but https-proxy-agent not available, using direct connection');
    return fetch(url, init);
  }
}

const ANTHROPIC_VERSION = '2023-06-01';

interface ProviderLike {
  protocol?: string;
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  lastSelectedModel?: string;
  models?: Array<{ name?: string }>;
}

interface ExtractedLink {
  title: string;
  url: string;
  description: string;
}

type JsonObject = Record<string, unknown>;

type KimiChatResponse = {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string;
      tool_calls?: Array<{
        id?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
  }>;
};

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function resolveDefaultProvider(config: Record<string, unknown>): ProviderLike | null {
  const providers = config?.providers;
  if (!providers || typeof providers !== 'object') {
    return null;
  }

  const providerMap = providers as Record<string, unknown>;
  const byDefaultId = config.defaultProviderId && providerMap[config.defaultProviderId as string];
  if (byDefaultId) {
    return byDefaultId as ProviderLike;
  }

  const first = Object.values(providerMap)[0];
  return (first as ProviderLike) || null;
}

function resolveProviderModel(provider: ProviderLike | null): string {
  const fallback = isOpenAIProtocol(provider) ? 'gpt-5.5' : 'claude-fable-5';
  if (!provider) return fallback;
  return provider.lastSelectedModel
    || provider.defaultModel
    || provider.models?.[0]?.name
    || fallback;
}

function isAnthropicProtocol(provider: ProviderLike | null): boolean {
  const protocol = (provider?.protocol || '').toLowerCase();
  return protocol === 'anthropic' || protocol === 'anthropic-openai';
}

function isOpenAIProtocol(provider: ProviderLike | null): boolean {
  const protocol = (provider?.protocol || '').toLowerCase();
  return protocol === 'openai' || protocol === 'openai-responses';
}

function isKimiProtocol(provider: ProviderLike | null): boolean {
  const protocol = (provider?.protocol || '').toLowerCase();
  return protocol === 'kimi';
}

/** xAI Grok 专用协议 (oauth / preset). */
function isGrokProtocol(provider: ProviderLike | null): boolean {
  return String(provider?.protocol || '').trim().toLowerCase() === 'grok';
}

/** 官方 x.ai / Grok CLI 代理端点 — 走 Responses API 原生 web_search. */
function isOfficialXaiEndpoint(provider: ProviderLike | null): boolean {
  const base = String(provider?.baseUrl || '').toLowerCase();
  return /api\.x\.ai|cli-chat-proxy\.grok\.com|(^|[/.])grok\.com([/:]|$)/.test(base);
}

/**
 * Grok / 官方 x.ai 必须走 Responses API 原生 web_search —
 * chat completions 不会服务端执行 web_search。
 * 普通 openai 代理仍走 session LLM (Kiro/网关契约), 不能一律改打 /responses。
 */
function prefersGrokResponsesWebSearch(provider: ProviderLike | null): boolean {
  return isGrokProtocol(provider) || isOfficialXaiEndpoint(provider);
}

function isDeepSeekOfficial(provider: ProviderLike | null): boolean {
  if (String(provider?.protocol || '').trim().toLowerCase() === 'deepseek') return true;
  return /(^|[/.])api\.deepseek\.com([/:]|$)/.test(String(provider?.baseUrl || '').toLowerCase());
}

/** api.deepseek.com[/v1|/anthropic[/v1]] → https://api.deepseek.com/anthropic/v1/messages */
function resolveDeepSeekAnthropicMessagesUrl(baseUrl: string): string {
  let u: URL;
  try { u = new URL(baseUrl); } catch { return 'https://api.deepseek.com/anthropic/v1/messages'; }
  return `${u.protocol}//${u.host}/anthropic/v1/messages`;
}

function providerHasNativeWebSearch(provider: ProviderLike | null): boolean {
  return isAnthropicProtocol(provider)
    || isOpenAIProtocol(provider)
    || isGrokProtocol(provider)
    || isKimiProtocol(provider)
    || isDeepSeekOfficial(provider);
}

function isAnthropicMessagesUrl(url: string): boolean {
  return /\/v1\/messages(?:\?|$)/.test(url);
}

function isOpenAIResponsesUrl(url: string): boolean {
  return /\/v1\/responses(?:\?|$)/.test(url) || /\/responses(?:\?|$)/.test(url);
}

function buildAnthropicHeaders(endpoint: string, apiKey: string): Record<string, string> {
  const isOfficial = endpoint.includes('api.anthropic.com');
  if (isOfficial) {
    return {
      'anthropic-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
  }

  return {
    'Authorization': `Bearer ${apiKey}`,
    'anthropic-version': ANTHROPIC_VERSION,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'anthropic-dangerous-direct-browser-access': 'true',
    'x-app': 'cli',
  };
}

function buildOpenAIHeaders(apiKey: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

function resolveOpenAIWebSearchToolType(): 'web_search' | 'web_search_preview' {
  const configured = String(process.env.NEOX_OPENAI_WEB_SEARCH_TOOL_TYPE || '').trim().toLowerCase();
  return configured === 'web_search_preview' ? 'web_search_preview' : 'web_search';
}

/** 时效档 —— 工具对外的统一说法, 各后端自己翻译成它认的参数。 */
export type SearchFreshness = 'all' | 'day' | 'week' | 'month' | 'year';

export function pickPublishedAt(raw: Record<string, unknown> | null | undefined): string | undefined {
  for (const key of ['datePublished', 'date', 'publishedAt', 'published_at', 'dateLastCrawled', 'lastCrawled']) {
    const v = raw?.[key];
    if (typeof v !== 'string' || !v.trim()) continue;
    const s = v.trim();
    const t = Date.parse(s);
    if (Number.isFinite(t)) {
      const d = new Date(t);
      /* 未来时间几乎都是站点的脏数据 (预发布/时区错), 当没有 */
      if (d.getTime() > Date.now() + 86_400_000) continue;
      return d.toISOString().slice(0, 10);
    }
    return s.slice(0, 40);
  }
  return undefined;
}

function normalizeSearchResult(raw: unknown): WebSearchResult | null {
  const rawObj = raw as Record<string, unknown> | null | undefined;
  const url = String(rawObj?.url || rawObj?.link || '').trim();
  if (!url) {
    return null;
  }

  const title = String(rawObj?.title || rawObj?.name || url).trim();
  const description = String(rawObj?.description || rawObj?.snippet || rawObj?.content || '').trim();

  let hostname = 'unknown';
  try {
    hostname = new URL(url).hostname;
  } catch {
    hostname = 'unknown';
  }

  const publishedAt = pickPublishedAt(rawObj);
  return publishedAt ? { title, url, description, hostname, publishedAt } : { title, url, description, hostname };
}

function extractLinksFromText(text: string): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  if (!text || typeof text !== 'string') return links;

  const markdownRegex = /\[([^\]]{1,120})\]\((https?:\/\/[^\s)]+)\)/g;
  let markdownMatch: RegExpExecArray | null;
  while ((markdownMatch = markdownRegex.exec(text)) !== null) {
    links.push({
      title: markdownMatch[1].trim() || markdownMatch[2],
      url: markdownMatch[2].trim(),
      description: '',
    });
  }

  const urlRegex = /https?:\/\/[^\s)\]}>"']+/g;
  let urlMatch: RegExpExecArray | null;
  while ((urlMatch = urlRegex.exec(text)) !== null) {
    const url = urlMatch[0].trim();
    links.push({ title: url, url, description: '' });
  }

  return links;
}

function parseWebSearchResults(data: unknown): WebSearchResult[] {
  const d = data as Record<string, unknown> | null | undefined;
  const candidates: unknown[] = [];

  if (Array.isArray(d?.results)) {
    candidates.push(...(d.results as unknown[]));
  }

  if (Array.isArray(d?.organic)) {
    candidates.push(...(d.organic as unknown[]));
  }

  if (Array.isArray(d?.content)) {
    for (const block of d.content as Array<Record<string, unknown>>) {
      if (block?.type === 'web_search_tool_result' && Array.isArray(block.content)) {
        candidates.push(...(block.content as unknown[]));
      }
    }
  }

  if (Array.isArray(d?.sources)) {
    candidates.push(...(d.sources as unknown[]));
  }

  const outputArray = Array.isArray(d?.output)
    ? d.output as unknown[]
    : Array.isArray((d?.response as Record<string, unknown> | undefined)?.output)
      ? (d!.response as Record<string, unknown>).output as unknown[]
      : null;

  if (outputArray) {
    for (const item of outputArray) {
      const itemObj = item as Record<string, unknown> | null | undefined;
      const actionObj = itemObj?.action as Record<string, unknown> | undefined;
      if (Array.isArray(actionObj?.sources)) {
        candidates.push(...(actionObj.sources as unknown[]));
      }

      if (itemObj?.type === 'message' && Array.isArray(itemObj.content)) {
        for (const part of itemObj.content as Array<Record<string, unknown>>) {
          if (part?.type !== 'output_text') {
            continue;
          }

          if (typeof part.text === 'string') {
            candidates.push(...extractLinksFromText(part.text));
          }

          if (!Array.isArray(part.annotations)) {
            continue;
          }

          for (const annotation of part.annotations as Array<Record<string, unknown>>) {
            if (annotation?.type !== 'url_citation' || !annotation?.url) {
              continue;
            }

            const start = Number(annotation.start_index);
            const end = Number(annotation.end_index);
            const text = typeof part.text === 'string' ? part.text : '';
            const snippet = Number.isFinite(start) && Number.isFinite(end) && end > start
              ? text.slice(start, end)
              : '';

            candidates.push({
              title: annotation.title || annotation.url,
              url: annotation.url,
              description: snippet,
            });
          }
        }
      }
    }
  }

  if (typeof d?.output_text === 'string') {
    candidates.push(...extractLinksFromText(d.output_text as string));
  }

  if (Array.isArray(d?.choices)) {
    for (const choice of d.choices as Array<Record<string, unknown>>) {
      const msg = choice?.message as Record<string, unknown> | undefined;
      const content = msg?.content;
      if (typeof content === 'string') {
        candidates.push(...extractLinksFromText(content));
      }
    }
  }

  const results = candidates
    .map(normalizeSearchResult)
    .filter((item): item is WebSearchResult => !!item);

  const seen = new Set<string>();
  const deduped: WebSearchResult[] = [];
  for (const result of results) {
    const key = `${result.url}::${result.title}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(result);
    }
  }

  return deduped;
}

function resolveWebSearchEndpoint(config: Record<string, unknown>, provider: ProviderLike | null): string | null {
  const webSearch = config?.webSearch as Record<string, unknown> | undefined;
  const configuredUrl = String(webSearch?.url || '').trim();
  if (configuredUrl) {
    return configuredUrl;
  }

  if (!provider?.baseUrl) {
    return null;
  }

  const baseUrl = normalizeBaseUrl(provider.baseUrl);

  /* DeepSeek 官方 → anthropic 兼容端点 (放在 openai 分支之前: 它常被配成 openai 协议) */
  if (isDeepSeekOfficial(provider)) {
    return resolveDeepSeekAnthropicMessagesUrl(baseUrl);
  }

  /* openai / grok → Responses API (`/v1/responses` + type:web_search) */
  if (isOpenAIProtocol(provider) || isGrokProtocol(provider)) {
    return baseUrl.endsWith('/v1') ? `${baseUrl}/responses` : `${baseUrl}/v1/responses`;
  }

  if (!isAnthropicProtocol(provider)) {
    return null;
  }

  return baseUrl.endsWith('/v1') ? `${baseUrl}/messages` : `${baseUrl}/v1/messages`;
}

let activeWebSearchSession: {
  llmProvider: LLMProvider;
  model: string;
  /** 会话实际协议 — 原生 web search 门控必须看这个, 不能看 defaultProvider */
  protocol?: string;
  baseUrl?: string;
  apiKey?: string;
} | null = null;

export function setActiveWebSearchSession(
  llmProvider: LLMProvider | null,
  model?: string,
  providerHint?: ProviderLike | string | null,
): void {
  if (!llmProvider || !model) {
    activeWebSearchSession = null;
    return;
  }
  const hint = typeof providerHint === 'string'
    ? { protocol: providerHint } as ProviderLike
    : (providerHint || null);
  activeWebSearchSession = {
    llmProvider,
    model,
    protocol: hint?.protocol ? String(hint.protocol) : undefined,
    baseUrl: hint?.baseUrl ? String(hint.baseUrl) : undefined,
    apiKey: hint?.apiKey ? String(hint.apiKey) : undefined,
  };
}

/** 优先用会话 provider 凭证 — 默认 DeepSeek + 会话 Grok 时不能拿错 key/baseUrl. */
function resolveActiveWebSearchProvider(config: Record<string, unknown>): ProviderLike | null {
  const session = activeWebSearchSession;
  if (session && (session.protocol || session.baseUrl || session.apiKey)) {
    return {
      protocol: session.protocol,
      baseUrl: session.baseUrl,
      apiKey: session.apiKey,
      defaultModel: session.model,
      lastSelectedModel: session.model,
    };
  }
  if (session?.protocol) {
    const providers = config?.providers;
    if (providers && typeof providers === 'object') {
      const match = Object.values(providers as Record<string, ProviderLike>).find(
        (p) => String(p?.protocol || '').toLowerCase() === session.protocol!.toLowerCase(),
      );
      if (match) return match;
    }
  }
  return resolveDefaultProvider(config);
}

/**
 * 通过 active session 的 llmProvider 发独立的 chat/completions WebSearch 请求.
 *
 * 契约 (跟 Claude Code WebSearchTool 一致, AccountHub claude-kiro.js isWebSearchRequest
 * 也按这套契约识别):
 *   - tools 数组单个 web_search
 *   - 单 user message, content 以 "Perform a web search for the query: " 开头
 *
 * 命中契约后, 上游 (订阅 → gateway → relay-d; BYOK → 直连 relay-d /
 * Anthropic 兼容代理) 走 Kiro MCP 搜索, 把结果摘要作为 text content 返回. 这里从
 * assistant content 文本里 extractLinksFromText 提结果.
 */
async function callWebSearchViaSessionLLM(
  query: string,
  maxResults: number,
): Promise<{ results: WebSearchResult[]; error?: string; unsupported?: boolean }> {
  if (!activeWebSearchSession) {
    return { results: [], error: 'WebSearch unavailable: no active session llmProvider' };
  }
  const { llmProvider, model } = activeWebSearchSession;

  const bareWebSearchTool: Tool = {
    name: 'web_search',
    description: 'Search the web',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
    function: async () => '',
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);

  try {
    const response = await llmProvider.chat(
      [{ role: 'user', content: `Perform a web search for the query: ${query}` }],
      {
        model,
        tools: [bareWebSearchTool],
        maxTokens: 2048,
        disableSystemPrompt: true,
        signal: controller.signal,
      },
    );

    const choice = response?.choices?.[0];
    const content = choice?.message?.content || '';
    if (typeof content !== 'string' || !content.trim()) {
      return { results: [], error: 'WebSearch upstream 返回空内容', unsupported: true };
    }

    /* 从 markdown 摘要里抽 links (AccountHub Kiro generateSearchSummary 输出
     * "**title**\n  snippet\n  Source: url\n\n" 这种格式). extractLinksFromText
     * 已经会处理 markdown links 和裸 URL. */
    const links = extractLinksFromText(content);
    const seen = new Set<string>();
    const results: WebSearchResult[] = [];
    for (const link of links) {
      const norm = normalizeSearchResult({ title: link.title, url: link.url, description: link.description });
      if (!norm) continue;
      if (seen.has(norm.url)) continue;
      seen.add(norm.url);
      results.push(norm);
      if (results.length >= Math.min(Math.max(1, maxResults), 20)) break;
    }

    if (results.length === 0) {
      return {
        results: [],
        error: `当前模型 (${model}) 这次没有返回搜索结果。「自带」档支持 GPT / Claude / Kimi / Grok / DeepSeek 官方;`
          + ' 其它模型去 设置 → 工具 → 联网搜索, 把「搜索后端」改成「博查 Bocha」或「Serper」并填 Key。',
      };
    }
    return { results };
  } catch (error: unknown) {
    const err = error as Record<string, unknown> | null | undefined;
    if (err?.name === 'AbortError') {
      return { results: [], error: '搜索超时' };
    }
    const msg = err?.message;
    return { results: [], error: `WebSearch 调用异常: ${typeof msg === 'string' ? msg : '未知错误'}` };
  } finally {
    clearTimeout(timer);
  }
}

type NeoxGatewayEntry = { baseUrl: string; apiKey: string };

export function resolveNeoxGatewaySearch(config: Record<string, unknown>): NeoxGatewayEntry | null {
  const providers = config?.providers as Record<string, Record<string, unknown>> | Array<Record<string, unknown>> | undefined;
  if (!providers || typeof providers !== 'object') return null;
  const list = Array.isArray(providers) ? providers : Object.entries(providers).map(([id, p]) => ({ id, ...(p || {}) }));
  const sentinel = list.find((p) => p?.id === 'neox-cloud' || String(p?.apiKey ?? '').trim() === 'neox-managed');
  if (!sentinel) return null;
  try {
    const resolved = resolveProviderEntry({ ...sentinel, id: 'neox-cloud' } as never) as unknown as { baseUrl?: string; apiKey?: string } | null;
    const baseUrl = String(resolved?.baseUrl || '').trim();
    const apiKey = String(resolved?.apiKey || '').trim();
    /* 没解出真凭据 / 匿名试用 key —— 网关不给匿名搜索, 直接不走这条 */
    if (!baseUrl || !apiKey || apiKey === 'neox-managed' || apiKey.startsWith('anonkey')) return null;
    return { baseUrl, apiKey };
  } catch {
    return null;
  }
}

async function callNeoxGatewaySearch(
  query: string,
  maxResults: number,
  entry: NeoxGatewayEntry,
): Promise<{ results: WebSearchResult[]; error?: string; provider?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const bodyStr = JSON.stringify({ query, count: maxResults });
    const url = `${entry.baseUrl.replace(/\/+$/, '')}/search`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${entry.apiKey}`,
    };
    const { loadAutoHmacSigner, getNeoxDeviceFp } = await import('@neoxlabs/kernel/models/openai.js');
    const signer = loadAutoHmacSigner();
    if (signer) {
      const bodyHexHash = createHash('sha256').update(bodyStr).digest('hex');
      const nxkId = createHash('sha256').update(entry.apiKey).digest('hex').slice(0, 16);
      const deviceFp = getNeoxDeviceFp();
      const sig = await signer(new URL(url).pathname, bodyHexHash, { nxkId, deviceFp });
      headers['X-Sig-Ts'] = sig.ts;
      headers['X-Sig-Nonce'] = sig.nonce;
      headers['X-Sig'] = sig.sig;
      headers['X-Sig-Proto'] = '2';
      headers['X-Device-FP'] = deviceFp;
      headers['X-Client-Version'] = sig.version;
    }
    const response = await proxyAwareFetch(url, { method: 'POST', headers, body: bodyStr, signal: controller.signal });
    const text = await response.text();
    let data: Record<string, unknown> | null = null;
    try { data = JSON.parse(text) as Record<string, unknown>; } catch { data = null; }
    if (!response.ok) {
      const errObj = data?.error as Record<string, unknown> | string | undefined;
      const msg = typeof errObj === 'string' ? errObj : String(errObj?.message || text.slice(0, 200));
      return { results: [], error: `Neox 搜索服务 HTTP ${response.status}: ${msg}` };
    }
    const raw = Array.isArray(data?.results) ? data!.results as Array<Record<string, unknown>> : [];
    const results: WebSearchResult[] = [];
    for (const r of raw) {
      const norm = normalizeSearchResult({ title: r.title, url: r.url, description: r.snippet, publishedAt: r.publishedAt });
      if (norm) {
        results.push(norm);
      } else if (typeof r.snippet === 'string' && r.snippet.trim()) {
        /* 部分搜索源 (智谱基础档) 只给正文不给链接 —— 正文本身有用, 保留, 不编造 URL */
        results.push({
          title: String(r.title || '').trim() || '(无标题)',
          url: '',
          description: r.snippet.trim(),
          hostname: String(r.siteName || 'unknown'),
          ...(typeof r.publishedAt === 'string' && r.publishedAt ? { publishedAt: r.publishedAt } : {}),
        });
      }
      if (results.length >= Math.min(Math.max(1, maxResults), 20)) break;
    }
    const provider = (data?.provider as Record<string, unknown> | null | undefined)?.name;
    if (results.length === 0) return { results: [], error: 'Neox 搜索服务没有返回结果' };
    return { results, provider: typeof provider === 'string' ? provider : undefined };
  } catch (error: unknown) {
    const err = error as Record<string, unknown> | null | undefined;
    if (err?.name === 'AbortError') return { results: [], error: 'Neox 搜索服务超时' };
    const message = err?.message;
    return { results: [], error: `Neox 搜索服务请求异常: ${typeof message === 'string' ? message : '未知错误'}` };
  } finally {
    clearTimeout(timer);
  }
}

async function callRemoteWebSearch(
  endpoint: string,
  query: string,
  maxResults: number,
  provider: ProviderLike | null,
  webSearchApiKey?: string
): Promise<{ results: WebSearchResult[]; error?: string }> {
  const requestTimeout = 60000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeout);

  try {
    /* 两个来源盘上都可能是 enc:v1 密文 (webSearch.apiKey / provider.apiKey) — 解出真值;
     * 旧明文配置 unwrap 原样透传. */
    const apiKey = (unwrapApiKey(webSearchApiKey) || unwrapApiKey(provider?.apiKey) || '').trim();
    const looksLikeAnthropic = isAnthropicMessagesUrl(endpoint)
      && (isAnthropicProtocol(provider) || isDeepSeekOfficial(provider));
    const looksLikeOpenAIResponses = isOpenAIResponsesUrl(endpoint)
      && (isOpenAIProtocol(provider) || isGrokProtocol(provider));

    const headers: Record<string, string> = looksLikeAnthropic
      ? buildAnthropicHeaders(endpoint, apiKey)
      : looksLikeOpenAIResponses
        ? buildOpenAIHeaders(apiKey)
        : { 'Content-Type': 'application/json', 'Accept': 'application/json' };

    /* Grok CLI 代理需要客户端版本头, 否则 4xx "outdated". */
    if (looksLikeOpenAIResponses && isOfficialXaiEndpoint(provider)) {
      Object.assign(headers, applyGrokCliHeaders(headers, {
        baseUrl: provider?.baseUrl,
        model: resolveProviderModel(provider),
        force: true,
      }));
    }

    const payload = looksLikeAnthropic
      ? {
        model: resolveProviderModel(provider),
        max_tokens: 2048,
        stream: false,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
        messages: [{ role: 'user', content: `Perform a web search for the query: ${query}` }],
      }
      : looksLikeOpenAIResponses
        ? {
          model: resolveProviderModel(provider),
          tools: [{ type: resolveOpenAIWebSearchToolType() }],
          tool_choice: 'auto',
          include: ['web_search_call.action.sources'],
          input: `Perform a web search for the query: ${query}`,
          stream: false,
        }
        : {
          query,
          q: query,
          max_results: maxResults,
          limit: maxResults,
        };

    if ((looksLikeAnthropic || looksLikeOpenAIResponses) && !apiKey) {
      return { results: [], error: '未找到 Provider API Key，无法发起 WebSearch 请求' };
    }

    const response = await proxyAwareFetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        results: [],
        error: `WebSearch 请求失败: HTTP ${response.status} ${response.statusText}`,
      };
    }

    const data = await response.json();
    const results = parseWebSearchResults(data).slice(0, Math.min(Math.max(1, maxResults), 20));

    if (results.length === 0) {
      return { results: [], error: 'WebSearch 请求成功，但未返回可解析结果' };
    }

    return { results };
  } catch (error: unknown) {
    const err = error as Record<string, unknown> | null | undefined;
    if (err?.name === 'AbortError') {
      return { results: [], error: '搜索超时' };
    }
    const message = err?.message;
    return { results: [], error: `WebSearch 请求异常: ${typeof message === 'string' ? message : '未知错误'}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Kimi 内置 $web_search 搜索
 *
 * 使用 Kimi API 的 builtin_function $web_search 实现联网搜索。
 * 完整 tool_calls 流程：
 * 1. 发送聊天请求（含 $web_search builtin_function）
 * 2. Kimi 返回 finish_reason=tool_calls，arguments 包含搜索结果
 * 3. 将 arguments 原封不动回传
 * 4. Kimi 根据搜索结果生成最终回答
 * 5. 从最终回答中提取搜索结果链接
 */
async function callKimiBuiltinWebSearch(
  query: string,
  provider: ProviderLike | null,
): Promise<{ results: WebSearchResult[]; error?: string; searchTokens?: number }> {
  const requestTimeout = 60000; // Kimi 搜索可能较慢，60s 超时
  /* provider.apiKey 在 config.json 里是 enc:v1 密文 — 解出真值 (明文透传) */
  const apiKey = unwrapApiKey(provider?.apiKey).trim();
  const baseUrl = normalizeBaseUrl(provider?.baseUrl || 'https://api.moonshot.cn/v1');

  if (!apiKey) {
    return { results: [], error: 'Kimi API Key 未配置' };
  }

  const model = resolveProviderModel(provider);
  const endpoint = `${baseUrl}/chat/completions`;
  const isK25 = model.includes('k2.5') || model.includes('k2-5');

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  // 构建 Kimi $web_search 请求体
  const buildPayload = (msgs: Array<Record<string, unknown>>) => {
    const payload: Record<string, unknown> = {
      model,
      messages: msgs,
      temperature: 0.6,
      tools: [{
        type: 'builtin_function',
        function: { name: '$web_search' },
      }],
      stream: false,
    };
    if (isK25) {
      payload.thinking = { type: 'disabled' };
    }
    return payload;
  };

  // 解析错误响应
  const parseErrorResponse = async (response: Response): Promise<string> => {
    try {
      const body = await response.json() as JsonObject;
      const errorObj = body?.error as Record<string, unknown> | undefined;
      return String(errorObj?.message || body?.message || `HTTP ${response.status}`);
    } catch {
      return `HTTP ${response.status} ${response.statusText}`;
    }
  };

  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: '你是搜索助手。请使用搜索工具帮用户查找信息，返回搜索结果的摘要和链接。' },
    { role: 'user', content: `请搜索: ${query}` },
  ];

  try {
    // Step 1: 发送带 $web_search 的请求
    const controller1 = new AbortController();
    const timer1 = setTimeout(() => controller1.abort(), requestTimeout);

    const response1 = await proxyAwareFetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildPayload(messages)),
      signal: controller1.signal,
    });

    clearTimeout(timer1);

    if (!response1.ok) {
      const errDetail = await parseErrorResponse(response1);
      return { results: [], error: `Kimi $web_search 请求失败: ${errDetail}` };
    }

    const data1 = await response1.json() as KimiChatResponse;
    const choice1 = data1?.choices?.[0];
    let searchTokens: number | undefined;

    // 检查是否返回了 tool_calls（$web_search 触发）
    if (choice1?.finish_reason !== 'tool_calls' || !choice1?.message?.tool_calls) {
      // 模型直接回答了，没有调用搜索 → 从文本提取链接
      const textContent = choice1?.message?.content || '';
      const links = extractLinksFromText(textContent);
      const results = links.map(link => normalizeSearchResult({
        title: link.title,
        url: link.url,
        description: link.description,
      })).filter((r): r is WebSearchResult => !!r);

      return { results };
    }

    // 有 tool_calls → 处理 $web_search 结果
    messages.push(choice1.message);

    for (const toolCall of choice1.message.tool_calls) {
      const toolCallName = toolCall?.function?.name;
      const toolCallArgs = toolCall?.function?.arguments || '{}';

      // 提取搜索 token 消耗
      try {
        const parsed = JSON.parse(toolCallArgs);
        searchTokens = parsed?.usage?.total_tokens;
      } catch { /* ignore */ }

      // 原封不动回传 arguments
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        name: toolCallName,
        content: toolCallArgs,
      });
    }

    // Step 2: 发送 tool result 获取最终回答
    const controller2 = new AbortController();
    const timer2 = setTimeout(() => controller2.abort(), requestTimeout);

    const response2 = await proxyAwareFetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildPayload(messages)),
      signal: controller2.signal,
    });

    clearTimeout(timer2);

    if (!response2.ok) {
      const errDetail = await parseErrorResponse(response2);
      return { results: [], error: `Kimi $web_search 第二轮请求失败: ${errDetail}` };
    }

    const data2 = await response2.json() as KimiChatResponse;
    const choice2 = data2?.choices?.[0];
    const finalContent = choice2?.message?.content || '';

    // 从最终回答中提取搜索结果链接
    const links = extractLinksFromText(finalContent);
    const results = links.map(link => normalizeSearchResult({
      title: link.title,
      url: link.url,
      description: link.description,
    })).filter((r): r is WebSearchResult => !!r);

    return { results, searchTokens };
  } catch (error: unknown) {
    const err = error as Record<string, unknown> | null | undefined;
    if (err?.name === 'AbortError') {
      return { results: [], error: 'Kimi $web_search 请求超时（60s）' };
    }
    const message = err?.message;
    return { results: [], error: `Kimi $web_search 异常: ${typeof message === 'string' ? message : '未知错误'}` };
  }
}


/** 博查认的时效值 (Bing 系口径)。 */
const BOCHA_FRESHNESS: Record<SearchFreshness, string> = {
  all: 'noLimit', day: 'oneDay', week: 'oneWeek', month: 'oneMonth', year: 'oneYear',
};

async function callBochaWebSearch(query: string, maxResults: number, apiKey: string, freshness: SearchFreshness = 'all'): Promise<{ results: WebSearchResult[]; images?: WebImageResult[]; error?: string }> {
  const response = await proxyAwareFetch('https://api.bochaai.com/v1/web-search', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: query.trim(),
      count: Math.min(Math.max(1, maxResults), 20),
      summary: true,
      freshness: BOCHA_FRESHNESS[freshness] ?? 'noLimit',
    }),
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return { results: [], error: '博查 API Key 无效，请检查配置 (open.bochaai.com)' };
    }
    if (response.status === 429) {
      return { results: [], error: '博查配额已用完，请前往 open.bochaai.com 查看额度' };
    }
    return { results: [], error: `博查请求失败: HTTP ${response.status} ${response.statusText}` };
  }

  /* 博查响应: { code, data: { webPages: { value: [{ name, url, snippet, summary, siteName }] },
   *   images: { value: [{ contentUrl, thumbnailUrl, name, hostPageUrl, width, height }] } } } */
  const raw = await response.json() as any;
  const pages: any[] = raw?.data?.webPages?.value || raw?.webPages?.value || [];
  const results: WebSearchResult[] = pages.slice(0, Math.min(Math.max(1, maxResults), 20)).map((p) => {
    let hostname = '';
    try { hostname = p?.url ? new URL(p.url).hostname : ''; } catch { /* ignore */ }
    const publishedAt = pickPublishedAt(p);
    return {
      title: String(p?.name || p?.title || '').trim(),
      url: String(p?.url || '').trim(),
      description: String(p?.summary || p?.snippet || '').trim(),
      hostname: hostname || String(p?.siteName || '').trim(),
      ...(publishedAt ? { publishedAt } : {}),
    };
  }).filter((r) => r.url);
  const imgRaw: any[] = raw?.data?.images?.value || raw?.images?.value || [];
  const images: WebImageResult[] = [];
  for (const im of imgRaw.slice(0, 12)) {
    const url = String(im?.contentUrl || im?.url || '').trim();
    if (!url || !/^https?:\/\//i.test(url)) continue;
    const rec: WebImageResult = { url };
    if (im?.thumbnailUrl) rec.thumbnailUrl = String(im.thumbnailUrl).trim();
    if (im?.name) rec.title = String(im.name).trim();
    if (im?.hostPageUrl) rec.hostPageUrl = String(im.hostPageUrl).trim();
    if (typeof im?.width === 'number') rec.width = im.width;
    if (typeof im?.height === 'number') rec.height = im.height;
    images.push(rec);
  }
  return { results, images };
}

async function callExternalWebSearch(
  query: string,
  maxResults: number,
  cfg: Record<string, unknown> | undefined,
  freshness: SearchFreshness = 'all',
): Promise<{ results: WebSearchResult[]; images?: WebImageResult[]; backend: WebSearchBackend; error?: string }> {
  const engine = String(cfg?.engine || 'auto').trim().toLowerCase();
  /* webSearch.apiKey 盘上是 enc:v1 密文 — 解出真值 (旧明文透传) */
  const apiKey = unwrapApiKey(String(cfg?.apiKey || '')).trim();

  if (engine === 'bocha') {
    if (!apiKey) return { results: [], backend: 'bocha', error: '博查搜索需要配置 API Key (设置 → 工具 → 联网搜索)' };
    const r = await callBochaWebSearch(query, maxResults, apiKey, freshness);
    return { results: r.results, images: r.images, backend: 'bocha', error: r.error };
  }
  if (engine === 'serper' || (engine === 'auto' && apiKey)) {
    if (!apiKey) return { results: [], backend: 'serper', error: 'Serper 搜索需要配置 API Key (设置 → 工具 → 联网搜索)' };
    const r = await callSerperWebSearch(query, maxResults, apiKey, freshness);
    return { results: r.results, images: r.images, backend: 'serper', error: r.error };
  }
  /* auto 且没配 key, 或 custom (已在上游 endpoint 处理) → 无外部可用 */
  return { results: [], backend: 'none' };
}

/** Serper 走 Google 的 tbs 口径; all 档不传这个字段。 */
const SERPER_TBS: Record<SearchFreshness, string | undefined> = {
  all: undefined, day: 'qdr:d', week: 'qdr:w', month: 'qdr:m', year: 'qdr:y',
};

async function callSerperWebSearch(query: string, maxResults: number, apiKey: string, freshness: SearchFreshness = 'all'): Promise<{ results: WebSearchResult[]; images?: WebImageResult[]; error?: string }> {
  const tbs = SERPER_TBS[freshness];
  const response = await proxyAwareFetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      q: query.trim(),
      num: Math.min(Math.max(1, maxResults), 20),
      ...(tbs ? { tbs } : {}),
    }),
  });

  if (!response.ok) {
    if (response.status === 401) {
      return { results: [], error: 'Serper API Key 无效，请检查配置' };
    }
    if (response.status === 429) {
      return { results: [], error: 'Serper 配额已用完，请前往 serper.dev 查看额度' };
    }
    return { results: [], error: `Serper 请求失败: HTTP ${response.status} ${response.statusText}` };
  }

  const data = await response.json() as {
    /* date: serper 的 organic 会带 "Sep 3, 2026" / "3 days ago" —— 由 normalizeSearchResult
     * 的 pickPublishedAt 统一收口, 这里只是把字段写进类型免得下次有人以为没有。 */
    organic?: Array<{ title?: string; link?: string; snippet?: string; imageUrl?: string; date?: string }>;
    images?: Array<{ title?: string; imageUrl?: string; thumbnailUrl?: string; source?: string; link?: string; imageWidth?: number; imageHeight?: number }>;
  };
  const results = parseWebSearchResults(data).slice(0, Math.min(Math.max(1, maxResults), 20));
  const imagesRaw = Array.isArray(data.images) ? data.images : [];
  const images: WebImageResult[] = [];
  for (const im of imagesRaw.slice(0, 12)) {
    const url = String(im?.imageUrl || '').trim();
    if (!url || !/^https?:\/\//i.test(url)) continue;
    const rec: WebImageResult = { url };
    if (im?.thumbnailUrl) rec.thumbnailUrl = String(im.thumbnailUrl).trim();
    if (im?.title) rec.title = String(im.title).trim();
    if (im?.link) rec.hostPageUrl = String(im.link).trim();
    if (typeof im?.imageWidth === 'number') rec.width = im.imageWidth;
    if (typeof im?.imageHeight === 'number') rec.height = im.imageHeight;
    images.push(rec);
  }
  /* organic 结果本身可能也有 og:image 字段, 挂到对应 result.image 上 */
  const organic = Array.isArray(data.organic) ? data.organic : [];
  for (let i = 0; i < results.length && i < organic.length; i++) {
    const og = organic[i]?.imageUrl;
    if (og && typeof og === 'string' && /^https?:\/\//i.test(og)) {
      results[i]!.image = og;
    }
  }
  return { results, images };
}

export interface WebSearchResult {
  title: string;
  url: string;
  description: string;
  hostname: string;
  publishedAt?: string;
  image?: string;
}

export interface WebImageResult {
  /** 图片直链 · 已由搜索引擎验证可访问 · 不需要 agent 拼 URL */
  url: string;
  /** 可选缩略图 (bocha/serper 通常提供), 快速预览用 · 生成 pptx 也可以退而求次 */
  thumbnailUrl?: string;
  /** 图片描述 · 通常是网页 title */
  title?: string;
  /** 图片所在源页 · agent 引用/归属可用 */
  hostPageUrl?: string;
  /** 宽高 (可选 · 有的话可以让 agent 挑合适尺寸) */
  width?: number;
  height?: number;
}

export interface WebSearchResponse {
  query: string;
  results: WebSearchResult[];
  images?: WebImageResult[];
  totalResults: number;
  searchTime: number;
}

function formatWebSearchContent(
  query: string,
  results: WebSearchResult[],
  backend: WebSearchBackend,
  searchTime: number,
  images?: WebImageResult[],
): string {
  let output = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[?] Web Search
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

▸ 搜索词: "${query}"
▸ 结果数: ${results.length}${images?.length ? ` · 图片 ${images.length}` : ''}
▸ 后端: ${backend}
▸ 耗时: ${searchTime}ms

`;

  if (images && images.length > 0) {
    output += `━━━━━━ 🖼 图片 (可直接用作 create_slides 的 image.uri) ━━━━━━\n`;
    images.forEach((im, i) => {
      const dim = im.width && im.height ? ` ${im.width}×${im.height}` : '';
      output += `[img ${i + 1}] ${im.url}${dim}${im.title ? `  — ${im.title}` : ''}\n`;
    });
    output += `\n`;
  }

  results.forEach((result, index) => {
    output += `──────────────────────────────────────
[] ${index + 1}. ${result.title}
🔗 ${result.url}
[.] ${result.description || '(无描述)'}
[@] ${result.hostname}${result.publishedAt ? ` · ${result.publishedAt}` : ''}${result.image ? `\n[img] ${result.image}` : ''}
`;
  });

  output += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  return output;
}

function buildWebSearchResult(
  query: string,
  results: WebSearchResult[],
  backend: WebSearchBackend,
  searchTime: number,
  images?: WebImageResult[],
): string {
  const content = formatWebSearchContent(query, results, backend, searchTime, images);
  return JSON.stringify(createContextualResult(
    'web_search',
    'success',
    `Found ${results.length} results${images?.length ? ` + ${images.length} images` : ''} for "${query}" via ${backend}`,
    content,
    {
      metadata: {
        query,
        backend,
        result_count: results.length,
        results: results.slice(0, 20).map((r) => ({
          title: r.title,
          url: r.url,
          description: typeof r.description === 'string' && r.description.length > 160
            ? `${r.description.slice(0, 159)}…`
            : r.description,
          published_at: r.publishedAt,
        })),
        image_count: images?.length ?? 0,
        images: images?.map((im) => ({ url: im.url, title: im.title, width: im.width, height: im.height })) ?? [],
        search_time_ms: searchTime,
      },
    },
  ));
}

function buildWebSearchError(error: string): string {
  return JSON.stringify(createContextualResult(
    'web_search',
    'error',
    `web_search failed: ${error}`,
    undefined,
    { error },
  ));
}

function buildWebSearchUnsupported(protocol: string | undefined, detail?: string, answeredEmpty = false): string {
  const who = protocol ? `\`${protocol}\`` : 'the current model provider';
  /* answeredEmpty: 协议看着支持, 但上游收下搜索请求后一个字都没回 —— 背后多半是个
   * 没接搜索的兼容代理。跟"协议本身没有"是同一个结论: 这条渠道搜不了。 */
  const why = answeredEmpty
    ? `${who} accepted the search request but answered with no content — the endpoint behind it most likely has no real web search`
    : `${who} has no server-side web search`;
  return JSON.stringify(createContextualResult(
    'web_search',
    'error',
    `Web search is not available on ${who}`,
    `${why}, and no external search backend is configured.\n`
    + 'Two ways to enable it — tell the user, do not retry:\n'
    + '· Switch to a model whose provider has built-in search (DeepSeek official, Claude, GPT, Grok, Kimi, or a NeoxCloud subscription model);\n'
    + '· Or configure 博查 / Serper / a custom search URL in Settings → Tools → 联网搜索.\n'
    + 'You can still use web_fetch on a URL you already know.'
    + (detail ? `\n(upstream said: ${detail})` : ''),
    { error: 'web_search_unsupported_on_this_provider', precondition: true },
  ));
}

/**
 * Web Search - server-side WebSearch flow
 * 1) Prefer server-side WebSearch via provider API endpoint
 * 2) Optional custom WebSearch URL override
 * 3) Fallback to Serper.dev when configured
 */
export const webSearch: Tool = {
  name: 'web_search',
  /* D wire: 跟外部搜索服务, 60s 兜底网慢. 远超 30min default 是浪费. */
  timeoutMs: 60_000,
  description: `Search the web via server-side WebSearch.

Priority:
1. Neox Cloud search (when signed in to a Neox subscription; works with every model)
2. Custom WebSearch URL (if configured)
3. Active provider's built-in WebSearch endpoint
4. 博查 / Serper.dev fallback (if API key configured)

Use cases:
- Search for documentation: {"query": "React hooks useEffect tutorial"}
- Search for error solutions: {"query": "TypeError: Cannot read property of undefined JavaScript"}
- Search for latest information: {"query": "Node.js 20 new features"}
- Search for code examples: {"query": "Python async await example"}

Returns top search results with title, URL, and description.`,
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query string',
      },
      max_results: {
        type: 'number',
        description: 'Maximum number of results to return (default: 10, max: 20)',
      },
      freshness: {
        type: 'string',
        enum: ['all', 'day', 'week', 'month', 'year'],
        description: 'Only return results published within this window (default: all). Applies to the 博查 / Serper backends; provider-native search ignores it.',
      },
    },
    required: ['query'],
  },
  async function({ query, max_results = 10, freshness = 'all' }) {
    const startTime = Date.now();

    try {
      if (!query || query.trim().length === 0) {
        return buildWebSearchError('请提供搜索关键词');
      }

      const config = loadRuntimeConfig();
      /* 会话 provider 优先 — 默认 DeepSeek 时不能拿错 Grok/Claude 的 key/baseUrl. */
      const provider = resolveActiveWebSearchProvider(config);
      const endpoint = resolveWebSearchEndpoint(config, provider);
      const normalizedMax = Math.min(Math.max(1, max_results), 20);
      const trimmedQuery = query.trim();
      const normalizedFreshness: SearchFreshness =
        (['all', 'day', 'week', 'month', 'year'] as const).includes(freshness as SearchFreshness)
          ? freshness as SearchFreshness
          : 'all';
      const cacheKey = buildWebSearchCacheKey(trimmedQuery, normalizedMax, provider, endpoint, normalizedFreshness);

      cleanupExpiredWebSearchCache();
      const cachedEntry = webSearchCache.get(cacheKey);
      if (cachedEntry && cachedEntry.expiresAt > Date.now()) {
        const cachedSearchTime = Date.now() - startTime;
        return buildWebSearchResult(
          trimmedQuery,
          cachedEntry.result.results,
          cachedEntry.result.backend,
          cachedSearchTime,
          cachedEntry.result.images,
        );
      }

      const inFlight = webSearchInflight.get(cacheKey);
      const fetchPromise = inFlight ?? (async () => {
        let results: WebSearchResult[] = [];
        let images: WebImageResult[] | undefined;
        let backend: WebSearchBackend = 'none';
        let remoteError: string | undefined;
        /* 原生 mini-chat 回了空文本 —— 见 callWebSearchViaSessionLLM */
        let nativeAnsweredEmpty = false;

        const webSearchCfg = config?.webSearch as Record<string, unknown> | undefined;
        const engine = String(webSearchCfg?.engine || 'auto').trim().toLowerCase();
        const providerNative = providerHasNativeWebSearch(provider);
        /* engine 显式指到外部 (bocha/serper/custom) 时也跳过原生, 尊重用户选择。 */
        const preferExternal = engine === 'bocha' || engine === 'serper' || engine === 'custom';
        /* Grok 与 DeepSeek 官方同理: chat/completions 不做服务端搜索, 必须直打各自的原生端点,
         * 有无 session 都一样 (见 isDeepSeekOfficial 注释)。 */
        const preferGrokResponses = prefersGrokResponsesWebSearch(provider) || isDeepSeekOfficial(provider);

        const neoxGateway = engine === 'auto' ? resolveNeoxGatewaySearch(config) : null;
        if (results.length === 0 && neoxGateway) {
          const viaGateway = await callNeoxGatewaySearch(trimmedQuery, normalizedMax, neoxGateway);
          if (viaGateway.results.length > 0) {
            results = viaGateway.results;
            backend = 'neox-gateway';
          } else {
            remoteError = viaGateway.error;
          }
        }

        if (results.length === 0 && preferGrokResponses && endpoint && !preferExternal) {
          const remote = await callRemoteWebSearch(
            endpoint,
            trimmedQuery,
            normalizedMax,
            provider,
            webSearchCfg?.apiKey as string | undefined,
          );
          if (remote.results.length > 0) {
            results = remote.results;
            backend = String(webSearchCfg?.url || '').trim() ? 'custom-url' : 'provider-api';
          } else if (!remoteError) {
            remoteError = remote.error;
          }
        }

        if (results.length === 0 && activeWebSearchSession && providerNative && !preferExternal && !preferGrokResponses) {
          const viaLLM = await callWebSearchViaSessionLLM(trimmedQuery, normalizedMax);
          if (viaLLM.results.length > 0) {
            results = viaLLM.results;
            backend = 'provider-api';
          } else {
            remoteError = viaLLM.error;
            nativeAnsweredEmpty = viaLLM.unsupported === true;
          }
        }

        if (results.length === 0 && isKimiProtocol(provider) && !preferExternal) {
          const kimiResult = await callKimiBuiltinWebSearch(trimmedQuery, provider);
          if (kimiResult.results.length > 0) {
            results = kimiResult.results;
            backend = 'kimi-builtin';
          } else if (!remoteError) {
            remoteError = kimiResult.error;
          }
        }

        /* 兜底: 无 session 时直打 endpoint (Anthropic messages / OpenAI responses 等). */
        if (results.length === 0 && endpoint && !activeWebSearchSession && !preferExternal && !preferGrokResponses) {
          const remote = await callRemoteWebSearch(
            endpoint,
            trimmedQuery,
            normalizedMax,
            provider,
            webSearchCfg?.apiKey as string | undefined,
          );
          if (remote.results.length > 0) {
            results = remote.results;
            backend = String(webSearchCfg?.url || '').trim() ? 'custom-url' : 'provider-api';
          } else if (!remoteError) {
            remoteError = remote.error;
          }
        }

        /* 外部搜索 API — 国内模型的正路, 也是所有模型的通用兜底。按 engine 选后端。 */
        /* 网关搜索试过 = 有后端, 失败时如实报它的错, 不要说成"这条渠道没有搜索能力" */
        let externalConfigured = !!neoxGateway;
        if (results.length === 0) {
          const ext = await callExternalWebSearch(trimmedQuery, normalizedMax, webSearchCfg, normalizedFreshness);
          externalConfigured = ext.backend !== 'none';
          if (ext.results.length > 0) {
            results = ext.results;
            images = ext.images;
            backend = ext.backend;
          } else if (ext.error && !remoteError) {
            remoteError = ext.error;
          }
        }

        if (results.length === 0) {
          const nativeMissing = !providerNative && !preferGrokResponses && !preferExternal;
          const unsupported = !externalConfigured && (nativeMissing || nativeAnsweredEmpty);
          return { results: [], backend, error: remoteError || '未获取到搜索结果', unsupported, nativeAnsweredEmpty };
        }

        webSearchCache.set(cacheKey, {
          expiresAt: Date.now() + WEB_SEARCH_CACHE_TTL_MS,
          result: { results, images, backend },
        });

        return { results, images, backend };
      })();

      if (!inFlight) {
        webSearchInflight.set(cacheKey, fetchPromise);
      }

      const resolved = await fetchPromise.finally(() => {
        if (!inFlight) {
          webSearchInflight.delete(cacheKey);
        }
      });

      if (resolved.results.length === 0) {
        const r = resolved as { unsupported?: boolean; nativeAnsweredEmpty?: boolean };
        if (r.unsupported) {
          return buildWebSearchUnsupported(
            (provider as { protocol?: string } | undefined)?.protocol,
            resolved.error,
            r.nativeAnsweredEmpty === true,
          );
        }
        return buildWebSearchError(resolved.error || '未获取到搜索结果');
      }

      const searchTime = Date.now() - startTime;
      return buildWebSearchResult(trimmedQuery, resolved.results, resolved.backend, searchTime, resolved.images);
    } catch (error: unknown) {
      const searchTime = Date.now() - startTime;
      const errMsg = error instanceof Error ? error.message : '';

      if (errMsg.includes('ENOTFOUND') || errMsg.includes('network')) {
        return buildWebSearchError('网络连接错误\n请检查网络连接后重试');
      }

      if (errMsg.includes('timeout')) {
        return buildWebSearchError(`请求超时 (${searchTime}ms)\n请稍后重试`);
      }

      return buildWebSearchError(errMsg || '未知错误');
    }
  },
};

/**
 * Web Fetch - Fetch and extract content from a URL
 */
/** web_fetch 的唯一超时真源 — 工具契约 (timeoutMs, 模型看得到) 和实际 abort 必须同一个数。 */
export const WEB_FETCH_TIMEOUT_MS = 60_000;


const WEB_FETCH_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/** 本机 GitHub token: 只在打 api.github.com / raw.githubusercontent.com 时用, 匿名限流是 403 主因。 */
/* resolveGithubToken 搬到 ./githubToken.ts —— GitHub channel 也要用同一把 token。 */

/**
 * URL 归一: 把"人看的页面"换成"机器能读的原文", 并给出为什么。
 *   github.com/o/r/blob/ref/path  → raw.githubusercontent.com/o/r/ref/path
 *   github.com/o/r/raw/ref/path   → 同上
 *   gist.github.com/u/id          → gist.githubusercontent.com/u/id/raw
 */
function normalizeFetchUrl(input: URL): { url: URL; note?: string } {
  const host = input.hostname.toLowerCase();
  if (host === 'github.com' || host === 'www.github.com') {
    const m = input.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/([^/]+)\/(.+)$/);
    if (m) {
      const raw = new URL(`https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}`);
      return { url: raw, note: `github.com/blob 页面已换成 raw 原文: ${raw.href}` };
    }
  }
  if (host === 'gist.github.com') {
    const m = input.pathname.match(/^\/([^/]+)\/([0-9a-f]+)\/?$/i);
    if (m) {
      const raw = new URL(`https://gist.githubusercontent.com/${m[1]}/${m[2]}/raw`);
      return { url: raw, note: `gist 页面已换成 raw 原文: ${raw.href}` };
    }
  }
  return { url: input };
}

function buildFetchHeaders(target: URL): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': WEB_FETCH_UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.7',
    'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
  };
  const host = target.hostname.toLowerCase();
  if (host === 'api.github.com' || host === 'raw.githubusercontent.com' || host === 'gist.githubusercontent.com') {
    const token = resolveGithubToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (host === 'api.github.com') headers['Accept'] = 'application/vnd.github+json';
  }
  return headers;
}

/** 从 content-type / <meta charset> / <meta http-equiv> 判字符集, 默认 utf-8。 */
function detectCharset(contentType: string, headBytes: Uint8Array): string {
  const ct = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (ct) return ct.toLowerCase();
  const head = Buffer.from(headBytes.subarray(0, 4096)).toString('latin1');
  const meta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  return (meta || 'utf-8').toLowerCase();
}

function decodeBody(bytes: Uint8Array, charset: string): string {
  const cs = charset === 'gb2312' || charset === 'gbk' ? 'gb18030' : charset;
  try {
    return new TextDecoder(cs, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

function decodeHtmlEntities(s: string): string {
  const named: Record<string, string> = {
    nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", copy: '©', reg: '®', hellip: '…',
    mdash: '—', ndash: '–', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·',
  };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ''; } })
    .replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] ?? m);
}

/**
 * HTML → 可读文本。不是完整 DOM, 但保住结构: 标题/列表/代码块/表格行, 去掉壳 (nav/header/
 * footer/aside/form/cookie 横幅), 优先取 <main>/<article>/role=main 这种"正文容器"。
 */
export function htmlToReadableText(html: string, baseUrl?: string): { title: string; text: string; usedMain: boolean } {
  const title = decodeHtmlEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '').replace(/\s+/g, ' ').trim());

  let body = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/i, '')
    /* textarea/select 里常塞整段转义的 HTML/CSS (百度首页就是), 解实体后会以"标签原文"露出来 */
    .replace(/<(script|style|noscript|svg|iframe|template|canvas|video|audio|object|embed|textarea|select)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(nav|header|footer|aside|form|dialog)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    /* 常见壳: cookie / 登录 / 分享横幅 —— 只按 class/id 名, 不敢按内容删 */
    .replace(/<(div|section)[^>]+(?:class|id)=["'][^"']*(?:cookie|consent|banner|sidebar|breadcrumb|share|comment|popup|modal)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi, '');

  /* 正文容器优先: 它的文本量 ≥ 全文 35% 才信, 否则回退整个 body */
  let usedMain = false;
  const mainMatch = /<(main|article)[^>]*>([\s\S]*?)<\/\1>/i.exec(body)
    || /<[^>]+role=["']main["'][^>]*>([\s\S]*?)<\/(?:div|section)>/i.exec(body);
  if (mainMatch) {
    const inner = mainMatch[mainMatch.length - 1];
    const plainAll = body.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').length;
    const plainMain = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').length;
    if (plainAll > 0 && plainMain / plainAll >= 0.35) {
      body = inner;
      usedMain = true;
    }
  }

  /* 代码块先保形 (内部换行/缩进不能被后面的空白折叠吃掉) */
  const codeBlocks: string[] = [];
  body = body.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner) => {
    const code = decodeHtmlEntities(inner.replace(/<[^>]+>/g, ''));
    codeBlocks.push(code.replace(/^\n+|\n+$/g, ''));
    return `\n CODE${codeBlocks.length - 1} \n`;
  });

  let text = body
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl, inner) => `\n\n${'#'.repeat(Number(lvl))} ${inner.replace(/<[^>]+>/g, ' ')}\n\n`)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<blockquote\b[^>]*>/gi, '\n> ')
    /* 表格按 markdown 行走: 每个 tr 起一行 `| `, 单元格之间 ` | `。
     * 表头分隔线推断不出来 (thead 不一定有), 所以不造 —— 宁可缺分隔线也不造假结构。 */
    .replace(/<tr\b[^>]*>/gi, '\n| ')
    .replace(/<\/(tr)>/gi, '\n')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<\/(p|div|section|article|blockquote|ul|ol|dl|dd|dt|figure|figcaption|summary|details)>/gi, '\n')
    .replace(/<(br|hr)[^>]*\/?>/gi, '\n')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, inner) => `\`${inner.replace(/<[^>]+>/g, '')}\``)
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, inner) => {
      const t = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return t ? `**${t}**` : '';
    })
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, inner) => {
      const t = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return t ? `*${t}*` : '';
    })
    /* 链接保成 [锚文本](绝对URL) —— 调研时"这句话出自哪"全靠锚文本和 href, 拍平就没了。
     * 站内相对链接按 baseUrl 解析; 解析不出来 / 非 http 协议的只留锚文本。 */
    .replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, inner: string) => {
      const label = decodeHtmlEntities(inner.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
      if (!label) return '';
      const rawHref = String(href).trim();
      if (!rawHref || /^(javascript:|mailto:|tel:|#)/i.test(rawHref)) return label;
      let abs = '';
      try { abs = baseUrl ? new URL(rawHref, baseUrl).href : (/^https?:\/\//i.test(rawHref) ? rawHref : ''); } catch { abs = ''; }
      return abs ? `[${label}](${abs})` : label;
    })
    .replace(/<[^>]+>/g, ' ');

  text = decodeHtmlEntities(text)
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    /* 空列表项 (图标/纯链接 li) 只剩一个 "-", 整行丢掉 */
    .replace(/(^|\n)-\s*(?=\n|$)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  text = text.replace(/ CODE(\d+) /g, (_, i) => `\n\`\`\`\n${codeBlocks[Number(i)]}\n\`\`\`\n`);
  return { title, text, usedMain };
}

function looksLikeJsChallenge(status: number, body: string): boolean {
  if (status !== 403 && status !== 503 && status !== 429) return false;
  return /cf-chl|__cf_chl|Just a moment|Checking your browser|challenge-platform|Attention Required|cf-browser-verification|captcha/i.test(body.slice(0, 20000));
}

function fetchErrorHint(status: number, target: URL, body: string, retryAfter: string | null): string {
  const host = target.hostname.toLowerCase();
  if (looksLikeJsChallenge(status, body)) {
    return '站点要求浏览器执行 JS 挑战 (Cloudflare 一类), 纯 HTTP 抓不到。改用 browser_navigate 在真实浏览器里打开这个 URL 再读页面。';
  }
  if (host === 'api.github.com' && (status === 403 || status === 429)) {
    return resolveGithubToken()
      ? 'GitHub API 限流 (已带本机 token)。等 retry-after 后再试, 或改抓 raw.githubusercontent.com 的具体文件。'
      : 'GitHub API 匿名限流 (60 次/小时/IP, 共享代理出口更容易撞)。不要重试 api.github.com: 改抓 https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>, 或让用户在环境里提供 GITHUB_TOKEN / 登录 gh CLI。';
  }
  if (status === 401 || status === 403) {
    return '站点拒绝匿名访问 (需登录 / 反爬)。不要换 UA 重试。如果用户在浏览器里能打开, 用 browser_navigate 走真实浏览器读取。';
  }
  if (status === 404) return '页面不存在。核对 URL (大小写 / 尾部斜杠 / 版本路径), 或用 web_search 找到正确链接。';
  if (status === 429) return `被限流${retryAfter ? ` (retry-after: ${retryAfter}s)` : ''}。等待后再试, 不要立即重发。`;
  if (status >= 500) return '站点服务端错误, 已自动重试一次仍失败。稍后再试, 或换镜像/其他来源。';
  return '';
}

/** 重定向落到内网时抛它 —— 跟网络错误分开, 那个会被重试, 这个必须原样报出去。 */
class RedirectBlockedError extends Error {}

/** 重定向最多跟几跳。跟 fetch 的默认值一致, 超了当失败。 */
const MAX_REDIRECTS = 20;

/**
 * 自己跟重定向, **每一跳都过一次 SSRF 校验**。
 *
 * 为什么不能用 redirect:'follow': 那样只有第一个 URL 被校验过, 而最经典的 SSRF 绕过
 * 就是「目标域名是公网的, 它 302 到 127.0.0.1」—— 等 fetch 跟完再看 response.url
 * 已经晚了, 请求早就打到内网端点上了 (光是那一发 GET 就可能有副作用)。
 */
async function fetchFollowingRedirects(
  start: URL,
  init: { signal: AbortSignal; headers: Record<string, string> },
  deadline: number,
): Promise<Response> {
  let current = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await proxyAwareFetch(current.href, { ...init, redirect: 'manual' });
    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !location) return res;
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return res;   /* Location 是坏的 —— 把这一跳当最终响应, 由上面按 3xx 处理 */
    }
    if (next.protocol !== 'http:' && next.protocol !== 'https:') {
      throw new RedirectBlockedError(`拒绝跟随重定向到 ${next.protocol}//… —— 只支持 http/https。`);
    }
    const denied = await checkFetchTarget(next, undefined, { viaProxy: !!getProxyForUrl(next.href) });
    if (denied) throw new RedirectBlockedError(`${current.hostname} 把请求重定向到了内网地址。${denied.message}`);
    if (Date.now() > deadline) return res;
    current = next;
  }
  throw new Error('重定向次数过多');
}

async function extractPdfTextFromBytes(bytes: Uint8Array, hintName: string): Promise<{ text: string; pages: number } | null> {
  const [{ default: fsp }, os, path, { extractPdfText }] = await Promise.all([
    import('node:fs/promises').then((m) => ({ default: m })),
    import('node:os'),
    import('node:path'),
    import('./image/imageProcessor.js'),
  ]);
  const safe = hintName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60) || 'fetched';
  const tmp = path.join(os.tmpdir(), `neox-webfetch-${Date.now()}-${safe}.pdf`);
  try {
    await fsp.writeFile(tmp, bytes);
    const r = await extractPdfText(tmp, {});
    if (!r.valid || !r.hasTextLayer || !r.text.trim()) return null;
    return { text: r.text, pages: r.totalPages };
  } catch {
    return null;
  } finally {
    await fsp.unlink(tmp).catch(() => { /* 临时文件删不掉不影响结果 */ });
  }
}

export const webFetch: Tool = {
  name: 'web_fetch',
  /* D wire: web_fetch 跟外部网络, 60s 兜底网慢. 远超 30min 全局 default 是浪费. */
  timeoutMs: WEB_FETCH_TIMEOUT_MS,
  description: `Fetch a URL and return its readable content (HTML → markdown, links kept as [text](url); PDF → text layer; JSON / plain text / markdown returned as-is; charset auto-detected).

- GitHub: github.com/.../blob/... is auto-rewritten to the raw file; api.github.com uses the local GitHub token when available.
- Sites behind a JS challenge (Cloudflare) or login cannot be fetched here — the error tells you when to switch to browser_navigate instead.
- 429/5xx are retried once automatically; do not loop on the same URL yourself.`,
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'URL to fetch content from',
      },
      max_length: {
        type: 'number',
        description: 'Maximum content length to return (default: 8000 chars, max 150000). Raise it when you actually need the whole document — research over long specs/papers usually does.',
      },
      extract_links: {
        type: 'boolean',
        description: 'Also list up to 30 links found in the page (default: false)',
      },
    },
    required: ['url'],
  },
  async function({ url, max_length = 8000, extract_links = false }) {
    const startTime = Date.now();

    const buildSuccess = (summary: string, content: string, metadata?: Record<string, unknown>) =>
      JSON.stringify(createContextualResult('web_fetch', 'success', summary, content, { metadata }));
    /* 调用方自己写错了 (URL 非法 / 协议不支持) —— 这才是**错误**, 该红。 */
    const buildError = (message: string, metadata?: Record<string, unknown>) =>
      JSON.stringify(createContextualResult('web_fetch', 'error', `web_fetch failed: ${message}`, undefined, { error: message, metadata }));

    const buildEmpty = (reason: string, hint: string, metadata?: Record<string, unknown>) =>
      JSON.stringify(createContextualResult(
        'web_fetch',
        'success',
        `没有拿到内容 (${reason}) — 0 字节`,
        `▸ 结果: 没有拿到内容\n▸ 原因: ${reason}\n${hint ? `▸ 下一步: ${hint}\n` : ''}`,
        { metadata: { ...(metadata ?? {}), fetched_bytes: 0, content_chars: 0, empty_reason: reason } },
      ));

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(String(url || '').trim());
    } catch {
      return buildError(`无效的 URL: ${url}`);
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return buildError(`只支持 http/https, 收到 ${parsedUrl.protocol}`);
    }

    const { url: target, note: rewriteNote } = normalizeFetchUrl(parsedUrl);
    const headers = buildFetchHeaders(target);
    const deadline = startTime + WEB_FETCH_TIMEOUT_MS;

    const targetDenied = await checkFetchTarget(target, undefined, { viaProxy: !!getProxyForUrl(target.href) });
    if (targetDenied) return buildError(targetDenied.message);

    /* 一次退避重试: 只对 429 / 5xx / 网络层抖动; 403/404 这种重试没有意义 */
    let response: Response | null = null;
    let lastNetErr: unknown = null;
    let redirectDenial: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const remaining = Math.max(1000, deadline - Date.now());
      const timer = setTimeout(() => controller.abort(), remaining);
      try {
        response = await fetchFollowingRedirects(target, { signal: controller.signal, headers }, deadline);
        lastNetErr = null;
      } catch (err) {
        response = null;
        /* 重定向落到内网 —— 这是最常见的 SSRF 绕过 (目标域名是公网的, 它 302 到
         * 127.0.0.1)。不能当网络错误重试, 要原样报出去。 */
        if (err instanceof RedirectBlockedError) { redirectDenial = err.message; break; }
        lastNetErr = err;
      } finally {
        clearTimeout(timer);
      }
      const retriable = response
        ? (response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504)
        : !(lastNetErr instanceof Error && lastNetErr.name === 'AbortError');
      if (!retriable || attempt === 1 || Date.now() + 2000 > deadline) break;
      await new Promise((r) => setTimeout(r, 1500));
    }

    const fetchTime = Date.now() - startTime;
    if (redirectDenial) return buildError(redirectDenial);
    if (!response) {
      const errName = lastNetErr instanceof Error ? lastNetErr.name : '';
      const errMsg = lastNetErr instanceof Error ? lastNetErr.message : String(lastNetErr || '');
      const netMeta = { url: target.href, hostname: target.hostname };
      if (errName === 'AbortError') return buildEmpty(`请求超时 (${fetchTime}ms)`, '站点太慢或不可达; 换个来源, 或稍后再试。', netMeta);
      if (errMsg.includes('ENOTFOUND')) return buildEmpty(`无法解析域名 ${target.hostname}`, '域名不存在或本机 DNS 解析不到; 核对拼写, 或改用 web_search 找到正确地址。', netMeta);
      if (errMsg.includes('ECONNREFUSED')) return buildEmpty('连接被拒绝', '端口未开放或被防火墙挡住。', netMeta);
      if (/ECONNRESET|ETIMEDOUT|socket hang up|TLS|certificate/i.test(errMsg)) {
        return buildEmpty(`网络层失败 (${errMsg})`, '已自动重试一次。若本机走代理, 确认代理对该域名可用。', netMeta);
      }
      return buildEmpty(errMsg || '未知错误', '', netMeta);
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    const bytes = new Uint8Array(await response.arrayBuffer());
    const charset = detectCharset(contentType, bytes);
    const finalUrl = response.url || target.href;

    if (!response.ok) {
      const bodyPreview = decodeBody(bytes.subarray(0, 20000), charset);
      const hint = fetchErrorHint(response.status, target, bodyPreview, response.headers.get('retry-after'));
      return buildEmpty(
        `HTTP ${response.status} ${response.statusText || ''}`.trim(),
        hint,
        { status: response.status, url: finalUrl, hostname: target.hostname, js_challenge: looksLikeJsChallenge(response.status, bodyPreview) },
      );
    }

    /* 按类型分流 */
    const mime = contentType.split(';')[0].trim();
    const maxLen = Math.min(Math.max(1000, Number(max_length) || 8000), 150000);
    let title = '';
    let text: string;
    let kind: 'html' | 'json' | 'text' | 'binary' | 'pdf';
    let usedMain = false;
    let raw = '';

    /* PDF 走文本层抽取, 不再一概拒收 */
    if (mime === 'application/pdf') {
      const sizeKb = Math.round(bytes.byteLength / 1024);
      const pdf = await extractPdfTextFromBytes(bytes, target.pathname.split('/').pop() || target.hostname);
      if (!pdf) {
        return buildEmpty(
          `PDF 抽不出文本层 (${sizeKb} KB)`,
          '要么这台机器没装 pdftotext (brew install poppler / apt install poppler-utils), '
          + '要么这是扫描件没有文本层。装了工具再试, 或换一个 HTML 版本的来源。',
          { status: response.status, url: finalUrl, content_type: mime, bytes: bytes.byteLength },
        );
      }
      kind = 'pdf';
      text = pdf.text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      title = `${target.pathname.split('/').pop() || 'PDF'} (${pdf.pages} 页)`;
    } else if (/application\/(?:zip|octet-stream|x-)|image\/|audio\/|video\/|font\//.test(mime)) {
      kind = 'binary';
      const sizeKb = Math.round(bytes.byteLength / 1024);
      return buildEmpty(
        `二进制内容 (${mime || 'unknown'}, ${sizeKb} KB), web_fetch 只处理文本`,
        `需要文件本身用 execute_shell 的 curl -L -o 下载。`,
        { status: response.status, url: finalUrl, content_type: mime, bytes: bytes.byteLength },
      );
    } else {
      raw = decodeBody(bytes, charset);
      if (/json/.test(mime) || (/^\s*[[{]/.test(raw) && !/^\s*</.test(raw) && mime === '')) {
        kind = 'json';
        try {
          text = JSON.stringify(JSON.parse(raw), null, 2);
        } catch {
          text = raw;
        }
      } else if (/text\/(?:plain|markdown|csv|x-)|application\/(?:xml|x-yaml|yaml)|text\/xml/.test(mime) || (mime === '' && !/<html|<body|<div|<p[\s>]/i.test(raw.slice(0, 4000)))) {
        kind = 'text';
        text = raw.replace(/\r\n/g, '\n').trim();
      } else {
        kind = 'html';
        const extracted = htmlToReadableText(raw, finalUrl);
        title = extracted.title;
        text = extracted.text;
        usedMain = extracted.usedMain;
      }
    }

    /* 链接 */
    let links: Array<{ text: string; href: string }> = [];
    if (extract_links && kind === 'html') {
      const linkRegex = /<a\b[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let m: RegExpExecArray | null;
      const seen = new Set<string>();
      while ((m = linkRegex.exec(raw)) !== null && links.length < 30) {
        const href = m[1].trim();
        const linkText = decodeHtmlEntities(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
        if (!linkText || /^(javascript:|mailto:|tel:)/i.test(href)) continue;
        try {
          const full = new URL(href, finalUrl).href;
          if (seen.has(full)) continue;
          seen.add(full);
          links.push({ text: linkText.slice(0, 120), href: full });
        } catch { /* skip */ }
      }
    }

    const isTruncated = text.length > maxLen;
    if (isTruncated) {
      text = truncateUtf16Safe(text, maxLen) + `\n\n... (内容已截断, 全文 ${text.length} 字符; 需要后面的部分可加大 max_length, 上限 150000)`;
    }

    const headerLines = [
      `▸ URL: ${finalUrl}${finalUrl !== target.href ? `  (重定向自 ${target.href})` : ''}`,
      rewriteNote ? `▸ ${rewriteNote}` : '',
      title ? `▸ 标题: ${title}` : '',
      `▸ 类型: ${mime || 'unknown'}${charset !== 'utf-8' ? ` (${charset})` : ''}${kind === 'html' && usedMain ? ' · 已取正文容器' : ''}`,
      `▸ 内容长度: ${text.length} 字符${isTruncated ? ' (已截断)' : ''} · 耗时 ${fetchTime}ms`,
    ].filter(Boolean);

    let output = `${headerLines.join('\n')}\n\n${text}\n`;
    if (links.length > 0) {
      output += `\n🔗 链接 (${links.length}):\n` + links.map((l, i) => `${i + 1}. ${l.text}\n   ${l.href}`).join('\n') + '\n';
    }

    return buildSuccess(
      `Fetched ${target.hostname}${title ? ` · ${title.slice(0, 60)}` : ''} (${fetchTime}ms)`,
      output,
      {
        url: finalUrl,
        requested_url: parsedUrl.href,
        hostname: target.hostname,
        page_title: title || undefined,
        content_chars: text.length,
        /* 原始响应体字节数 —— 界面上「打开网页 · x.com  12.4 KB」用它, 中文页 chars≠bytes */
        fetched_bytes: bytes.byteLength,
        content_type: mime || 'unknown',
        charset,
        kind,
        fetch_time_ms: fetchTime,
        /* 抓取**时刻** (不是耗时) —— 证据账本要记"这份原文是什么时候看到的",
         * 页面事后改了也能说清当时读到的是哪一版。fetch_time_ms 是耗时, 两回事。 */
        fetched_at: new Date(startTime).toISOString(),
        extract_links: !!extract_links,
        extracted_link_count: links.length,
        truncated: isTruncated,
      },
    );
  },
};

// Export all web tools
export const WEB_TOOLS: Tool[] = [webSearch, webFetch];
