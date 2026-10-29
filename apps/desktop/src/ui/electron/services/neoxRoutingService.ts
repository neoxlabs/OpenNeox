/**
 * Neox Routing Service — desktop main 进程对 neox-core providerResolver 的注册器.
 *
 *   作用
 *   ----
 *   登录 Neox 后, 只把 Neox Cloud 托管 provider 的 (apiKey, baseUrl) 透明改写成
 *   Neox 网关那一对. 用户自己配置的 provider 属于 BYOK, 始终直连用户 API key/baseUrl.
 *
 *   套餐策略 (跟 内部设计文档 一致)
 *   --------------------------------------------------------
 *     · 未登录          → 不改写 (BYOK 单机模式)
 *     · 任意登录套餐    → neox-cloud / neox-managed 走网关; 其他 provider 走 BYOK 直连
 *
 *   状态来源
 *   --------
 *   主进程不直接拉 /membership/me (那是 renderer 的事), 而是 renderer 在 membershipStore
 *   每次刷新成功后通过 IPC 把 plan id 推过来, 仅供 debug/status 查看.
 *   BYOK 是否可用不从会员套餐派生, resolver 只看 provider 是否是 Neox 托管 sentinel.
 *
 *   Token 来源
 *   ----------
 *   只读 gateway-key.enc 里的 nxk_/anonkey_ 网关凭据. 不再 fallback 到 OAuth access_token:
 *   1) gateway 不认 OAuth token;
 *   2) auth token 与 gateway key 是两套权限边界, 混用会掩盖登录/mint bug;
 *   3) renderer 不能通过路由层间接把 OAuth token 当 provider apiKey 用出去.
 */
import { join } from 'path';
import * as os from 'os';
import { setProviderResolver } from '@neoxlabs/platform/platform/providerResolver.js';
import { setRoutingState } from '@neoxlabs/platform/platform/routingState.js';
import type { ProviderConfigEntry } from '@neoxlabs/platform/utils/config.js';
import { getGatewayKey } from '../ipc/gatewayKeyHandlers.js';
import { NEOX_CLOUD_PROVIDER_ID, NEOX_MANAGED_APIKEY_MARKER } from '../../shared/neoxCloud.js';

/* env 同 renderer 那边 — 优先 cloudEndpoints (持久化 profile), fallback 到 env, 再 fallback localhost.
 * cloudEndpoints 是 main 进程 source of truth; 切换 profile 后必须重启 (token 跟 server 强绑). */
import { resolveCloudEndpoints } from './cloudEndpoints.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';
const NEOX_GATEWAY_BASE =
  process.env.NEOX_GATEWAY_BASE || process.env.VITE_NEOX_GATEWAY_BASE || resolveCloudEndpoints().gateway;

/** 网关 WebSocket base (含 /n1, ws(s):// 协议) —— 流式 ASR 等 WS 端点用. */
export function getGatewayWsBase(): string {
  const cleaned = NEOX_GATEWAY_BASE.replace(/\/+$/, '');
  const http = cleaned.endsWith('/n1') ? cleaned : cleaned + '/n1';
  return http.replace(/^http:\/\//, 'ws://').replace(/^https:\/\//, 'wss://');
}

/* server 子进程读这个文件来同步 routing 状态 — 跟 server/main.ts 那边的常量对齐. */
const ROUTING_FILE = process.env.NEOX_ROUTING_FILE
  || join(os.homedir(), NEOX_HOME_DIRNAME, 'routing.json');

/* OpenAI Chat Completions 兼容协议 + Anthropic native 都走 Neox 网关.
 *   Gateway 当前已暴露 /v1/chat/completions + /v1/models + /v1/embeddings + /v1/messages
 *   (native Anthropic, anthropic_messages.go 翻译器已落地: tool_use/tool_result 配对修复 +
 *    cache_read/cache_write 字段 + message_start/message_delta usage merge 都修过).
 *   因此 native 'anthropic' 也加入 routable, 否则 claude-opus-4-6 这种走 native Anthropic
 *   协议的模型在新 chat 里会直接命中本地 BYOK 配置, 用户没配 → "No provider configured". */
const NEOX_ROUTABLE_PROTOCOLS = new Set([
  'openai',
  'openai-responses',
  'kimi',
  'deepseek',
  'minimax',
  'qwen',
  'glm',
  'doubao',
  'anthropic',         /* native /v1/messages — claude-opus-4-6 等走这条 */
  'anthropic-openai',  /* Anthropic 走 OpenAI schema 也算 — gateway 解析 OpenAI 格式 */
]);

/* NEOX_CLOUD_PROVIDER_ID / NEOX_MANAGED_APIKEY_MARKER 从 shared/neoxCloud 引入,
 *   跟 neoxCloudProviderSync 共用同一个常量, 防止两侧 sentinel 字符串漂移. */

/* ============================================================
 * 进程内状态 (renderer 推过来的 plan summary)
 * ============================================================ */
type PlanSummary = {
  /** plan id, 'free' / 'pro' / 'pro-plus' / 'ultra' / 'team' / 'enterprise' */
  planId: string;
};

let currentPlan: PlanSummary | null = null;
/** 当前登录用户 id — 写到 routing.json 让 server 子进程也能 setCurrentUserId.
 *  P0: 没这条 server 永远读匿名 config, 订阅用户 'neox-cloud' provider 找不到. */
let currentUserId: string | null = null;
/** Neox routing 总开关 — 默认开. renderer 可通过 set 接口翻转 (例如用户在设置里关闭). */
let routingEnabled = true;
/** gateway key 缓存 — 只缓存 gateway-key.enc 里的 nxk_/anonkey_ 网关凭据. */
let cachedToken: { value: string; expiresAt: number } | null = null;

async function getBearerToken(): Promise<string | null> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now) return cachedToken.value;
  const gatewayKey = await getGatewayKey();
  if (gatewayKey?.secret) {
    cachedToken = { value: gatewayKey.secret, expiresAt: now + 5 * 60_000 };
    return gatewayKey.secret;
  }
  cachedToken = null;
  return null;
}

/* ============================================================
 * Resolver 实现 — 同步 API. 但 token 读盘是 async, 我们给 main 启动时
 *   预热一次 + 之后定时刷新, 同步路径上读 cachedToken.
 * ============================================================ */
function resolverFn(provider: ProviderConfigEntry): ProviderConfigEntry {
  if (!routingEnabled) return provider;

  /* 路由决策:
   *   订阅 (neox-cloud) provider  → 永远走网关
   *   BYOK provider               → 永远走 BYOK 直连, 与 Neox Cloud 订阅互不干扰
   */
  const isNeoxManaged = provider.id === NEOX_CLOUD_PROVIDER_ID
    || (provider.apiKey ?? '').trim() === NEOX_MANAGED_APIKEY_MARKER;

  if (!isNeoxManaged) {
    return provider;
  }

  /* 以下都是 isNeoxManaged 路径 — 必须改写到网关. 关键: baseUrl 即使没 token 也要先重写,
   *   绝不允许 sentinel provider 用空 baseUrl 出门 (OpenAI SDK 会 fallback 到 api.openai.com,
   *   国内 TLS 握不上, 用户看到 ECONNRESET 还以为是 Neox 网关挂了).
   *
   *   P1 安全加固: 前缀 /v1 → /n1, 让全网扫描器 (固定打 /v1/chat/completions) 探不到我们.
   *   网关那边 server.go Routes() 同步切到 /n1/*, body schema 不变 (仍 OpenAI 格式), SDK 透明拼接. */
  const _cleaned = NEOX_GATEWAY_BASE.replace(/\/+$/, '');
  const gatewayBase = _cleaned.endsWith('/n1') ? _cleaned : _cleaned + '/n1';
  const token = cachedToken?.value;

  if (!NEOX_ROUTABLE_PROTOCOLS.has(provider.protocol as string)) {
    /* sentinel 协议不在白名单 — 理论不会发生. 至少把 baseUrl 锁到网关, 不让默认值生效. */
    return { ...provider, baseUrl: gatewayBase };
  }

  if (!token) {
    /* 没 token: 还是改 baseUrl, 把请求路到网关. 没 apiKey 网关会回 401, UI 看到的是
     *   清晰的 "auth.invalid_token" 错误, 比 ECONNRESET 强一万倍. */
    return { ...provider, apiKey: '', baseUrl: gatewayBase };
  }

  return {
    ...provider,
    apiKey: token,
    baseUrl: gatewayBase,
    /* protocol / models / urlSuffix 等保留 — gateway 是 OpenAI 协议兼容. */
  };
}

/* ============================================================
 * 启动入口
 * ============================================================ */
let warmTimer: NodeJS.Timeout | null = null;

export function installNeoxRouting(): void {
  setProviderResolver((provider, ctx) => {
    void ctx;
    return resolverFn(provider);
  });
  /* 每 30s 刷新一次 token 缓存; 登录 / 登出时 renderer 也会 push 让我们立刻刷一次 */
  if (warmTimer) clearInterval(warmTimer);
  warmTimer = setInterval(() => { void warmTokenCache(); }, 30_000);
  warmTimer.unref?.();
  void warmTokenCache();
}

async function warmTokenCache(): Promise<void> {
  cachedToken = null;
  await getBearerToken();
  syncRoutingToDb();
}

function syncRoutingToDb(): void {
  try {
    const _cleaned = NEOX_GATEWAY_BASE.replace(/\/+$/, '');
    const gatewayBase = _cleaned.endsWith('/n1') ? _cleaned : _cleaned + '/n1';
    setRoutingState({
      enabled: routingEnabled,
      gatewayBase,
      routableProtocols: Array.from(NEOX_ROUTABLE_PROTOCOLS),
    });
  } catch (err) {
    console.warn('[neoxRouting] sync to db failed:', err);
  }
}

/* ============================================================
 * IPC 桥 — renderer 推 plan / 触发 token 刷新 / 切总开关
 * ============================================================ */
export const neoxRoutingState = {
  setPlan(summary: PlanSummary | null): void {
    currentPlan = summary;
    syncRoutingToDb();
  },
  getPlan(): PlanSummary | null {
    return currentPlan;
  },
  setEnabled(enabled: boolean): void {
    routingEnabled = enabled;
    syncRoutingToDb();
  },
  isEnabled(): boolean {
    return routingEnabled;
  },
  /** 同步当前登录用户 id 给 server. authHandlers (login/logout) 在 setCurrentUserId 之后调一次. */
  setUserId(userId: string | null): void {
    if (currentUserId === userId) return;
    currentUserId = userId;
    /* 同时刷 token (gateway-key 跟 user 强绑) */
    cachedToken = null;
    void warmTokenCache();
  },
  refreshToken(): void {
    void warmTokenCache();
  },
  /** 测试 / debug 用 — 直接看当前会怎么改写一个 provider */
  describe(provider: ProviderConfigEntry): {
    enabled: boolean;
    hasToken: boolean;
    plan: PlanSummary | null;
    rewroteToNeox: boolean;
    resolvedBaseUrl: string;
  } {
    const out = resolverFn(provider);
    return {
      enabled: routingEnabled,
      hasToken: !!cachedToken?.value,
      plan: currentPlan,
      rewroteToNeox: out !== provider,
      resolvedBaseUrl: out.baseUrl ?? '',
    };
  },
};
