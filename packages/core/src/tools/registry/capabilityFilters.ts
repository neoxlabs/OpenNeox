import type { Tool, ToolCapabilitySet } from '@neoxlabs/kernel/types/index.js';

export function filterToolsByCapability(tools: Tool[], capabilities?: ToolCapabilitySet): Tool[] {
  if (!capabilities) {
    return tools;
  }
  return tools.filter(tool => {
    if (!tool.capabilities || tool.capabilities.length === 0) {
      return true;
    }
    return tool.capabilities.every(capability => capabilities[capability] === true);
  });
}

export function getDefaultProvider(config: any): { protocol?: string } | null {
  const providers = config?.providers;
  if (!providers || typeof providers !== 'object') {
    return null;
  }
  const byDefaultId = config.defaultProviderId && providers[config.defaultProviderId];
  if (byDefaultId) {
    return byDefaultId as { protocol?: string };
  }
  const first = Object.values(providers)[0];
  return (first as { protocol?: string }) || null;
}

export function shouldPreferNativeOpenAIWebSearch(config: any): boolean {
  const webSearchMode = String(process.env.NEOX_WEB_SEARCH || 'disabled').trim().toLowerCase();
  if (webSearchMode === 'disabled') {
    return false;
  }
  if (String(config?.webSearch?.url || '').trim()) {
    return false;
  }
  const protocol = String(getDefaultProvider(config)?.protocol || '').trim().toLowerCase();
  return protocol === 'openai' || protocol === 'openai-responses';
}

export function providerSupportsWebSearch(protocol?: string | null): boolean {
  const p = String(protocol || '').trim().toLowerCase();
  return p === 'anthropic'
    || p === 'anthropic-openai'
    || p === 'openai'
    || p === 'openai-responses'
    || p === 'grok'
    || p === 'kimi'
    || p === 'deepseek';
}

/** 配置里是否存在任一原生支持 web_search 的 provider (会话可能切到它们)。 */
export function anyConfiguredProviderSupportsWebSearch(config: any): boolean {
  const providers = config?.providers;
  if (!providers || typeof providers !== 'object') return false;
  return Object.values(providers).some((entry) => {
    const p = entry as {
      protocol?: string;
      baseUrl?: string;
      defaultModel?: string;
      lastSelectedModel?: string;
      models?: Array<{ name?: string }>;
    } | null;
    if (providerSupportsWebSearch(p?.protocol)) return true;
    /* Grok 常被挂在 anthropic/openai 代理上 — protocol 已覆盖; 再兜底认 model / x.ai 端点,
     * 避免 "我明明在用 Grok" 却因 protocol 写错被装配期摘掉. */
    const model = String(p?.lastSelectedModel || p?.defaultModel || p?.models?.[0]?.name || '').toLowerCase();
    const base = String(p?.baseUrl || '').toLowerCase();
    if (model.includes('grok')) return true;
    if (/api\.x\.ai|cli-chat-proxy\.grok\.com/.test(base)) return true;
    /* DeepSeek 官方常被配成 openai 协议 (本机就有); 域名兜底, 与 webTools.isDeepSeekOfficial 同判据 */
    if (/(^|[/.])api\.deepseek\.com([/:]|$)/.test(base)) return true;
    return false;
  });
}

export function webSearchExternallyConfigured(config: any): boolean {
  const ws = config?.webSearch;
  if (!ws) return false;
  const engine = String(ws.engine || 'auto').trim().toLowerCase();
  const apiKey = String(ws.apiKey || '').trim();
  const url = String(ws.url || '').trim();
  if (engine === 'bocha' || engine === 'serper') return !!apiKey;
  if (engine === 'custom') return !!url;
  return !!apiKey; /* auto */
}

/**
 * web_search 是否应挂进工具池。
 *   工具在 boot 时装一次, 不能只看 defaultProvider — 默认 DeepSeek、会话切 Claude 时
 *   旧逻辑会让 Life 常驻的 web_search 整段失踪, 模型退化成 curl 抓 Bing。
 */
export function webSearchAvailable(config: any, protocol?: string | null): boolean {
  return providerSupportsWebSearch(protocol)
    || anyConfiguredProviderSupportsWebSearch(config)
    || webSearchExternallyConfigured(config)
    || neoxCloudSearchConfigured(config);
}

export function neoxCloudSearchConfigured(config: any): boolean {
  const engine = String(config?.webSearch?.engine || 'auto').trim().toLowerCase();
  if (engine !== 'auto') return false;
  const providers = config?.providers;
  if (!providers || typeof providers !== 'object') return false;
  const list = Array.isArray(providers)
    ? providers
    : Object.entries(providers).map(([id, p]) => ({ id, ...(p as object) }));
  return list.some((p: any) => p?.id === 'neox-cloud' || String(p?.apiKey ?? '').trim() === 'neox-managed');
}
