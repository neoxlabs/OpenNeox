import { ipcMain } from './ipcMainBridged.js';
import { configService } from '@neoxlabs/platform/platform/configService.js';
import { tokenUsageService } from '@neoxlabs/platform/platform/tokenUsageService.js';
import { notifyProvidersChanged } from '../services/providerConfigWatcher.js';
import type {
  CreateProviderInput,
  FetchProviderModelsRequest,
  FetchProviderModelsResult,
  ProviderProtocol,
  UpdateProviderInput,
} from '../../shared/ipc.js';

/** 拉模型列表时的默认根地址. 覆盖 ProviderProtocol 全集 —— 渠道可挂图像/语音协议,
 *  这里也得给得出根地址. 值对齐 packages/kernel/src/models/providerPresets.ts. */
const DEFAULT_MODEL_LIST_BASE_URL: Record<ProviderProtocol, string> = {
  openai: 'https://api.openai.com/v1',
  'openai-responses': 'https://api.openai.com/v1',
  'openai-images': 'https://api.openai.com/v1',
  'openai-tts': 'https://api.openai.com/v1',
  'openai-stt': 'https://api.openai.com/v1',
  'openai-embedding': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  'anthropic-openai': 'https://api.anthropic.com/v1',
  doubao: 'https://ark.cn-beijing.volces.com/api/v3',
  'doubao-images': 'https://ark.cn-beijing.volces.com/api/v3',
  'doubao-tts': 'https://ark.cn-beijing.volces.com/api/v3',
  gemini: 'https://generativelanguage.googleapis.com',
  'gemini-images': 'https://generativelanguage.googleapis.com',
  grok: 'https://api.x.ai/v1',
  'grok-images': 'https://api.x.ai/v1',
  kimi: 'https://api.moonshot.cn/v1',
  deepseek: 'https://api.deepseek.com',
  minimax: 'https://api.minimax.chat/v1',
  'minimax-tts': 'https://api.minimax.chat/v1',
  'minimax-video': 'https://api.minimax.chat/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  'qwen-images': 'https://dashscope.aliyuncs.com/api/v1',
  'dashscope-tts': 'https://dashscope.aliyuncs.com/api/v1',
  glm: 'https://open.bigmodel.cn/api/paas/v4',
  'glm-claude': 'https://open.bigmodel.cn/api/paas/v4',
  'glm-images': 'https://open.bigmodel.cn/api/paas/v4',
  'kimi-claude': 'https://api.moonshot.cn/anthropic',
  openrouter: 'https://openrouter.ai/api/v1',
  'openrouter-images': 'https://openrouter.ai/api/v1',
  mistral: 'https://api.mistral.ai/v1',
  groq: 'https://api.groq.com/openai/v1',
  together: 'https://api.together.xyz/v1',
};

const MODEL_LIST_EXPANDED_LIMIT = 1000;
const MODEL_LIST_MAX_PAGES = 50;

function normalizeBaseUrl(protocol: ProviderProtocol, baseUrl?: string): string {
  let clean = (baseUrl || DEFAULT_MODEL_LIST_BASE_URL[protocol] || DEFAULT_MODEL_LIST_BASE_URL.openai).trim();
  if (!clean) clean = DEFAULT_MODEL_LIST_BASE_URL[protocol] || DEFAULT_MODEL_LIST_BASE_URL.openai;
  if (!/^https?:\/\//i.test(clean)) clean = `https://${clean}`;
  return clean.replace(/\/+$/, '');
}

function joinProviderUrl(baseUrl: string, suffix: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const path = `/${suffix.replace(/^\/+/, '')}`;
  return `${base}${path}`
    .replace(/\/v1\/v1\b/g, '/v1')
    .replace(/\/v1beta\/v1beta\b/g, '/v1beta')
    .replace(/\/models\/models\b/g, '/models');
}

function looksLikeModelsPath(path?: string): boolean {
  return Boolean(path && /\/models(?:[/?#]|$)/i.test(path));
}

function uniqueUrls(urls: string[]): string[] {
  return Array.from(new Set(urls.map(url => url.trim()).filter(Boolean)));
}

function buildModelListUrls(request: FetchProviderModelsRequest): string[] {
  const baseUrl = normalizeBaseUrl(request.protocol, request.baseUrl);
  const suffixes: string[] = [];

  if (looksLikeModelsPath(request.urlSuffix)) {
    suffixes.push(request.urlSuffix || '');
  }

  if (request.protocol === 'gemini') {
    suffixes.push('/v1beta/models', '/v1/models', '/models');
  } else if (request.protocol === 'anthropic') {
    suffixes.push('/v1/models', '/models');
  } else {
    suffixes.push('/models', '/v1/models');
  }

  return uniqueUrls(suffixes.map(suffix => joinProviderUrl(baseUrl, suffix)));
}

function buildModelListHeaders(protocol: ProviderProtocol, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };

  if (protocol === 'gemini') {
    headers['x-goog-api-key'] = apiKey;
    return headers;
  }

  if (protocol === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    return headers;
  }

  headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

function readRemoteModelId(item: unknown, protocol: ProviderProtocol): string {
  if (typeof item === 'string') return item.trim();
  if (!item || typeof item !== 'object') return '';

  const obj = item as Record<string, any>;
  if (protocol === 'gemini' && Array.isArray(obj.supportedGenerationMethods)) {
    const canGenerate = obj.supportedGenerationMethods.some((method: unknown) => {
      const text = String(method || '').toLowerCase();
      return text === 'generatecontent' || text === 'streamgeneratecontent';
    });
    if (!canGenerate) return '';
  }

  const id = obj.id || obj.name || obj.model || obj.model_id;
  if (typeof id !== 'string') return '';
  return id.replace(/^models\//, '').trim();
}

function extractRemoteModelIds(payload: unknown, protocol: ProviderProtocol): string[] {
  const candidates: unknown[] = [];
  const pushArray = (value: unknown) => {
    if (Array.isArray(value)) candidates.push(...value);
  };

  pushArray(payload);
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, any>;
    pushArray(obj.data);
    pushArray(obj.models);
    pushArray(obj.items);
    pushArray(obj.result);
    pushArray(obj?.data?.models);
    pushArray(obj?.result?.models);
  }

  const deduped = new Map<string, string>();
  for (const item of candidates) {
    const id = readRemoteModelId(item, protocol);
    if (!id) continue;
    deduped.set(id.toLowerCase(), id);
  }

  return Array.from(deduped.values());
}

function resolveProviderNextUrl(currentUrl: string, payload: unknown, lastModelId: string): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, any>;
  const pagination = (
    obj.pagination ||
    obj.paging ||
    obj.page_info ||
    obj.pageInfo ||
    obj.meta ||
    {}
  ) as Record<string, any>;

  const directNext = (
    obj.next ||
    obj.next_url ||
    obj.nextUrl ||
    obj.next_page_url ||
    obj.nextPageUrl ||
    pagination.next ||
    pagination.next_url ||
    pagination.nextUrl ||
    pagination.next_page_url ||
    pagination.nextPageUrl
  );
  if (typeof directNext === 'string' && directNext.trim()) {
    try {
      return new URL(directNext.trim(), currentUrl).toString();
    } catch {
      return null;
    }
  }

  const url = new URL(currentUrl);
  const nextPage = obj.next_page ?? obj.nextPage ?? pagination.next_page ?? pagination.nextPage;
  if (typeof nextPage === 'number' || typeof nextPage === 'string') {
    url.searchParams.set('page', String(nextPage));
    return url.toString();
  }

  const nextPageToken = (
    obj.next_page_token ||
    obj.nextPageToken ||
    pagination.next_page_token ||
    pagination.nextPageToken
  );
  if (typeof nextPageToken === 'string' && nextPageToken.trim()) {
    url.searchParams.set('pageToken', nextPageToken.trim());
    return url.toString();
  }

  const nextCursor = (
    obj.next_cursor ||
    obj.nextCursor ||
    pagination.next_cursor ||
    pagination.nextCursor
  );
  if (typeof nextCursor === 'string' && nextCursor.trim()) {
    url.searchParams.set('cursor', nextCursor.trim());
    return url.toString();
  }

  const hasMore = Boolean(
    obj.has_more ||
    obj.hasMore ||
    obj.more ||
    pagination.has_more ||
    pagination.hasMore ||
    pagination.more
  );
  if (!hasMore) return null;

  const lastId = (
    obj.last_id ||
    obj.lastId ||
    pagination.last_id ||
    pagination.lastId ||
    lastModelId
  );
  if (typeof lastId === 'string' && lastId.trim()) {
    url.searchParams.set('after', lastId.trim());
    return url.toString();
  }

  return null;
}

function withModelListParam(sourceUrl: string, param: string, limit: number): string {
  const url = new URL(sourceUrl);
  url.searchParams.set(param, String(limit));
  return url.toString();
}

function buildExpandedModelListUrls(sourceUrl: string, limit: number): string[] {
  return uniqueUrls([
    withModelListParam(sourceUrl, 'limit', limit),
    withModelListParam(sourceUrl, 'page_size', limit),
    withModelListParam(sourceUrl, 'pageSize', limit),
    withModelListParam(sourceUrl, 'per_page', limit),
    withModelListParam(sourceUrl, 'perPage', limit),
  ]);
}

function isOpenRouterRequest(request: FetchProviderModelsRequest): boolean {
  const base = (request.baseUrl || DEFAULT_MODEL_LIST_BASE_URL[request.protocol] || '').toLowerCase();
  return base.includes('openrouter.ai');
}

/**
 * OpenRouter 2026 把图像生成模型拆到独立目录: GET /models 只吐能走 chat/completions 的模型,
 * 纯出图模型 (gpt-image-2 / flux.2 / recraft / seedream / riverflow ...) 只在 /images/models 里.
 * 这里显式拉一遍图像目录, id 合并进主列表, 否则用户永远同步不到这些模型.
 */
async function fetchOpenRouterImageModelIds(
  axios: any,
  baseUrl: string,
  headers: Record<string, string>,
): Promise<string[]> {
  const url = joinProviderUrl(baseUrl, '/images/models');
  try {
    const response = await axios.get(url, { headers, timeout: 15000, validateStatus: () => true });
    if (response.status < 200 || response.status >= 300) return [];
    return extractRemoteModelIds(response.data, 'openai');
  } catch {
    return [];
  }
}

/** 大小写不敏感去重合并, 保序 (primary 在前, 新增图像 id 追加). */
function mergeModelIds(primary: string[], extra: string[]): string[] {
  const seen = new Map<string, string>();
  for (const id of [...primary, ...extra]) {
    const key = id.toLowerCase();
    if (!seen.has(key)) seen.set(key, id);
  }
  return Array.from(seen.values());
}

function extractProviderError(payload: unknown): string {
  if (!payload) return '';
  if (typeof payload === 'string') return payload.slice(0, 240);
  if (typeof payload !== 'object') return String(payload);

  const obj = payload as Record<string, any>;
  const message = obj?.error?.message || obj?.message || obj?.error || obj?.detail;
  if (typeof message === 'string') return message.slice(0, 240);

  try {
    return JSON.stringify(payload).slice(0, 240);
  } catch {
    return '';
  }
}

/* 导出给「从本机导入 BYOK」复用 (migrateHandlers): 导入时必须至少拿到一个模型,
   否则 providerStore.addProvider 会以 config.empty_models 拒绝落盘。 */
export async function fetchProviderModels(request: FetchProviderModelsRequest): Promise<FetchProviderModelsResult> {
  const apiKey = request.apiKey?.trim();
  if (!apiKey) {
    return { models: [], error: 'API Key is required to fetch models.' };
  }

  const axios = (await import('axios')).default;
  const headers = buildModelListHeaders(request.protocol, apiKey);
  const urls = buildModelListUrls(request);
  let lastError = '';

  /* OpenRouter: 图像模型在独立 /images/models 目录, 主列表拉不到, 先并这一份. */
  const imageModelIds = isOpenRouterRequest(request)
    ? await fetchOpenRouterImageModelIds(axios, normalizeBaseUrl(request.protocol, request.baseUrl), headers)
    : [];

  for (const sourceUrl of urls) {
    const deduped = new Map<string, string>();
    const visited = new Set<string>();
    let firstPageCount = 0;

    try {
      const primary = await collectModelListPages(axios, sourceUrl, headers, request.protocol, visited);
      firstPageCount = primary.firstPageCount;
      if (primary.error) lastError = primary.error;
      for (const model of primary.models) {
        deduped.set(model.toLowerCase(), model);
      }

      if (deduped.size === firstPageCount && firstPageCount >= 30) {
        for (const expandedUrl of buildExpandedModelListUrls(sourceUrl, MODEL_LIST_EXPANDED_LIMIT)) {
          const expanded = await collectModelListPages(axios, expandedUrl, headers, request.protocol, visited);
          if (expanded.error) lastError = expanded.error;
          for (const model of expanded.models) {
            deduped.set(model.toLowerCase(), model);
          }
        }
      }

      const models = Array.from(deduped.values());
      if (models.length > 0) {
        return { models: mergeModelIds(models, imageModelIds), sourceUrl };
      }

      if (!lastError) lastError = 'The provider returned an empty model list.';
    } catch (error: any) {
      lastError = error?.message || String(error);
    }
  }

  /* 主列表全失败但图像目录有货 (罕见), 也别丢. */
  if (imageModelIds.length > 0) {
    return { models: imageModelIds, sourceUrl: urls[0] };
  }

  return {
    models: [],
    sourceUrl: urls[0],
    error: lastError || 'Unable to fetch models from this provider.',
  };
}

async function collectModelListPages(
  axios: any,
  startUrl: string,
  headers: Record<string, string>,
  protocol: ProviderProtocol,
  visited: Set<string>,
): Promise<{ models: string[]; firstPageCount: number; error: string }> {
  const deduped = new Map<string, string>();
  let pageUrl: string | null = startUrl;
  let firstPageCount = 0;
  let error = '';

  for (let page = 0; page < MODEL_LIST_MAX_PAGES && pageUrl && !visited.has(pageUrl); page += 1) {
    visited.add(pageUrl);
    const response = await axios.get(pageUrl, {
      headers,
      timeout: 15000,
      validateStatus: () => true,
    });

    if (response.status < 200 || response.status >= 300) {
      const detail = extractProviderError(response.data);
      error = detail || `HTTP ${response.status}`;
      break;
    }

    const pageModels = extractRemoteModelIds(response.data, protocol);
    if (page === 0) firstPageCount = pageModels.length;

    for (const model of pageModels) {
      deduped.set(model.toLowerCase(), model);
    }

    const lastModelId = pageModels[pageModels.length - 1] || '';
    pageUrl = resolveProviderNextUrl(pageUrl, response.data, lastModelId);
  }

  return { models: Array.from(deduped.values()), firstPageCount, error };
}

export function registerProviderModelIpcHandlers(): void {
  ipcMain.handle('provider:get-all', () => {
    return configService.getProviders();
  });

  ipcMain.handle('provider:get', (_event, id: string) => {
    return configService.getProvider(id);
  });

  ipcMain.handle('provider:get-default', () => {
    return configService.getDefaultProvider();
  });

  /* 写操作做完都主动通知 renderer 重拉模型列表 —— 不只靠 config.json 的 fs.watch (见 notifyProvidersChanged) */
  ipcMain.handle('provider:add', (_event, input: CreateProviderInput) => {
    const created = configService.addProvider(input);
    notifyProvidersChanged();
    return created;
  });

  ipcMain.handle('provider:update', (_event, id: string, updates: UpdateProviderInput) => {
    const updated = configService.updateProvider(id, updates);
    notifyProvidersChanged();
    return updated;
  });

  ipcMain.handle('provider:delete', async (_event, id: string) => {
    const provider = configService.getProvider(id);
    const providerName = provider?.name;
    configService.deleteProvider(id);
    notifyProvidersChanged();
    if (providerName) {
      await tokenUsageService.clearProvider(providerName);
      // console.log(`[Main] Cleared usage stats for deleted provider: ${providerName}`);
    }
  });

  ipcMain.handle('provider:set-default', (_event, id: string) => {
    const result = configService.setDefaultProvider(id);
    notifyProvidersChanged();
    return result;
  });

  ipcMain.handle('provider:fetch-models', (_event, request: FetchProviderModelsRequest) => {
    return fetchProviderModels(request);
  });

  ipcMain.handle('model:add', (_event, providerId: string, modelName: string, makeDefault?: boolean) => {
    const result = configService.addModel(providerId, modelName, makeDefault);
    notifyProvidersChanged();
    return result;
  });

  ipcMain.handle('model:remove', (_event, providerId: string, modelName: string) => {
    const result = configService.removeModel(providerId, modelName);
    notifyProvidersChanged();
    return result;
  });
}
