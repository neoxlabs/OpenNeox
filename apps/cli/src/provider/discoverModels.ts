/**
 * discoverModels — 拉 BYOK provider 的 `/v1/models` (或 `/models`) endpoint
 *   把真实可用模型列表返回. 大部分 OpenAI-compat / Anthropic / Codex / 国内代理网关都暴露
 *   这个端点 (selfhosted / openrouter / 月之暗面 / DeepSeek 官方等都有).
 *
 * 设计:
 *   · 24h cache 在 ProviderConfigEntry.discoveredModels + .discoveredAt (持久化到 config.json).
 *     /model selector 优先用 cache, 过期才重拉, 减少启动延迟.
 *   · 拉失败 (404 / network / 5xx) → 不 fatal, 返 cache (即使过期) / 空数组 - caller 再 fallback
 *     到 provider.models 静态配置 + 本地 modelRegistry.
 *   · 5s timeout, 防 wedge.
 *
 * 调用点 (后续):
 *   · /model 命令打开 picker 前
 *   · provider add 完成后做一次 refresh
 */

import type { ProviderConfigEntry } from '@neoxlabs/platform/utils/config.js';
import { loadConfig, saveConfig } from '@neoxlabs/platform/utils/config.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const FETCH_TIMEOUT_MS = 5000;

export interface DiscoveredModel {
  /** model id, e.g. "gpt-5.5" */
  id: string;
  /** owned_by / publisher, e.g. "openai" / "anthropic" - 可选. */
  ownedBy?: string;
  /** created timestamp from API (Unix seconds) - 可选, 用于排序. */
  created?: number;
}

export interface DiscoverResult {
  /** 真实拉到的 models. 失败时 = cache 或 空数组. */
  models: DiscoveredModel[];
  /** 数据来源: 'fresh' = 刚拉到; 'cache' = 用了 cache (含过期); 'none' = 啥都没拿到. */
  source: 'fresh' | 'cache' | 'none';
  /** 失败原因 (fresh 失败时填). */
  error?: string;
}

/**
 * 拉 provider 的 /v1/models endpoint. 24h cache. force=true 强制 refresh.
 * 自动持久化结果到 config.json provider entry.
 */
const inFlightRefresh = new Set<string>();

function refreshInBackground(provider: ProviderConfigEntry): void {
  const key = provider.id || provider.baseUrl || '';
  if (!key || inFlightRefresh.has(key)) return;
  inFlightRefresh.add(key);
  void discoverModels(provider, { force: true })
    .catch(() => { /* 后台刷新失败无需打扰用户 */ })
    .finally(() => { inFlightRefresh.delete(key); });
}

export async function discoverModels(
  provider: ProviderConfigEntry,
  options: { force?: boolean } = {},
): Promise<DiscoverResult> {
  const now = Date.now();
  const cached = (provider as any).discoveredModels as DiscoveredModel[] | undefined;
  const cachedAt = (provider as any).discoveredAt as number | undefined;
  const cacheFresh = cached && cachedAt && (now - cachedAt) < CACHE_TTL_MS;

  if (cacheFresh && !options.force) {
    return { models: cached!, source: 'cache' };
  }

  if (cached && cached.length > 0 && !options.force) {
    void refreshInBackground(provider);
    return { models: cached, source: 'cache' };
  }

  const baseUrl = (provider.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl || !provider.apiKey) {
    if (cached && cached.length > 0) return { models: cached, source: 'cache' };
    return { models: [], source: 'none', error: 'no baseUrl/apiKey' };
  }

  /* 端点选择: 多数 OpenAI-compat 走 /models (注意 baseUrl 已含 /v1 后缀, 不要重复加).
   * Anthropic 原生协议没标准 /models endpoint, 跳过 */
  if (provider.protocol === 'anthropic') {
    return { models: cached ?? [], source: cached ? 'cache' : 'none', error: 'anthropic native: no /models endpoint' };
  }

  const url = `${baseUrl}/models`;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'authorization': `Bearer ${provider.apiKey}`,
  };

  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    const resp = await fetch(url, { method: 'GET', headers, signal: ctl.signal });
    clearTimeout(timer);
    if (!resp.ok) {
      cliLogger.warn('DISCOVER_MODELS', `${provider.id} → HTTP ${resp.status}, using ${cached ? 'cache' : 'empty'}`);
      if (cached && cached.length > 0) return { models: cached, source: 'cache', error: `HTTP ${resp.status}` };
      return { models: [], source: 'none', error: `HTTP ${resp.status}` };
    }
    const json: any = await resp.json();
    const rawList = json?.data ?? json?.models ?? [];
    if (!Array.isArray(rawList)) {
      if (cached && cached.length > 0) return { models: cached, source: 'cache', error: 'unexpected response shape' };
      return { models: [], source: 'none', error: 'unexpected response shape' };
    }
    const discovered: DiscoveredModel[] = rawList
      .map((m: any) => ({
        id: typeof m === 'string' ? m : (m?.id ?? m?.name ?? ''),
        ownedBy: typeof m === 'object' ? (m.owned_by || m.ownedBy || m.publisher) : undefined,
        created: typeof m === 'object' ? (typeof m.created === 'number' ? m.created : undefined) : undefined,
      }))
      .filter((m: DiscoveredModel) => m.id && m.id.trim().length > 0);

    /* 持久化到 config.json provider entry. */
    try {
      const config = loadConfig();
      const p = config.providers?.[provider.id];
      if (p) {
        (p as any).discoveredModels = discovered;
        (p as any).discoveredAt = now;
        saveConfig(config);
      }
    } catch (err) {
      cliLogger.warn('DISCOVER_MODELS', `persist failed: ${(err as any)?.message ?? err}`);
    }
    cliLogger.info('DISCOVER_MODELS', `${provider.id} → ${discovered.length} models from ${url}`);
    return { models: discovered, source: 'fresh' };
  } catch (err: any) {
    const reason = err?.name === 'AbortError' ? `timeout ${FETCH_TIMEOUT_MS}ms` : (err?.message ?? String(err));
    cliLogger.warn('DISCOVER_MODELS', `${provider.id} fetch failed: ${reason}`);
    if (cached && cached.length > 0) return { models: cached, source: 'cache', error: reason };
    return { models: [], source: 'none', error: reason };
  }
}

/**
 * 把 discoverModels 的结果跟 provider.models (静态配置) 合并成一个去重 union.
 *   优先级: provider.models (用户手动配置) + discoveredModels (真实可用)
 *   按 model name 去重, 保持 provider.models 顺序在前.
 */
export function mergeWithConfiguredModels(
  configured: { name: string }[],
  discovered: DiscoveredModel[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of configured) {
    if (m.name && !seen.has(m.name)) { out.push(m.name); seen.add(m.name); }
  }
  for (const m of discovered) {
    if (m.id && !seen.has(m.id)) { out.push(m.id); seen.add(m.id); }
  }
  return out;
}
