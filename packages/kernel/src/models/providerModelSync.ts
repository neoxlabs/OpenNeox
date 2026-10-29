/**
 * providerModelSync — 从 provider 上游拉真实 model 列表并推断 modality.
 *
 * 用户在设置里点"同步模型" → 前端调此函数 → 命中 provider 的 baseUrl + apiKey → GET /models →
 * 返回 ProviderModelConfig[] 供 UI merge 进 provider.models.
 *
 * 覆盖 wire 格式:
 *   · OpenRouter (openrouter): 富元数据 (input_modalities, output_modalities, context_length, pricing)
 *   · OpenAI-compat (openai / kimi / deepseek / doubao / grok / mistral / groq / together / glm):
 *     基础 {id, ...}, modality 靠模型名启发式推断
 *   · Anthropic: /v1/models list 只有 id + display_name, chat only
 *   · Gemini: /v1beta/models 有 supportedGenerationMethods (generateContent / embedContent) 精准判 modality
 *
 * 拉不到的 provider (自定义代理 / preset 未覆盖) 返回错误信息, 用户手动补.
 */

import type { ProviderConfigEntry, ProviderModelConfig, Modality } from '../types/configTypes.js';
import { getEffectiveModelModalities } from './providerCapabilities.js';

export interface SyncModelsResult {
  ok: boolean;
  models: ProviderModelConfig[];
  /** provider 上游 GET /models 的原始 status. */
  status?: number;
  /** ok=false 时的失败原因. */
  error?: string;
  /** 用了哪种解析器, 便于 UI 显示 (e.g. "openrouter-metadata"). */
  parser?: string;
}

/**
 * 同步入口. 按 preset 或 protocol 选择合适解析器. 不改动 provider config, 只返回候选列表.
 * UI 负责去重合并 (name 相同的保留用户 label + 新拉取的 modality/context/pricing).
 */
export async function syncProviderModels(p: ProviderConfigEntry): Promise<SyncModelsResult> {
  const baseUrl = (p.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl || !p.apiKey) {
    return { ok: false, models: [], error: 'baseUrl 或 apiKey 缺失' };
  }
  const presetId = p.presetId ?? '';
  const protocol = p.protocol;

  // 1. OpenRouter: 富元数据, 单独解析
  if (presetId === 'openrouter' || protocol === 'openrouter' || baseUrl.includes('openrouter.ai')) {
    return fetchOpenRouterModels(baseUrl, p.apiKey, p.extraHeaders);
  }
  // 2. Anthropic
  if (presetId === 'anthropic' || protocol === 'anthropic' || baseUrl.includes('api.anthropic.com')) {
    return fetchAnthropicModels(baseUrl, p.apiKey);
  }
  // 3. Gemini
  if (presetId === 'gemini' || protocol === 'gemini' || baseUrl.includes('generativelanguage.googleapis.com')) {
    return fetchGeminiModels(baseUrl, p.apiKey);
  }
  // 4. OpenAI-compat 兜底 (OpenAI 官方 + 大部分国内 provider + 自建代理)
  return fetchOpenAICompatModels(baseUrl, p.apiKey, p.extraHeaders);
}

// ============================================================================
// OpenRouter — 最富元数据
// ============================================================================

interface OpenRouterModel {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string; image?: string };
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
    modality?: string;
  };
  top_provider?: { context_length?: number };
}

async function fetchOpenRouterModels(baseUrl: string, apiKey: string, extra?: Record<string, string>): Promise<SyncModelsResult> {
  try {
    const resp = await fetch(`${baseUrl}/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': extra?.['HTTP-Referer'] ?? 'https://neox-dev.com',
        'X-Title': extra?.['X-Title'] ?? 'Neox',
      },
    });
    if (!resp.ok) {
      return { ok: false, models: [], status: resp.status, error: await resp.text().catch(() => `HTTP ${resp.status}`), parser: 'openrouter' };
    }
    const json = await resp.json() as { data: OpenRouterModel[] };
    const models: ProviderModelConfig[] = (json.data || []).map(m => {
      const inputs = normalizeInputs(m.architecture?.input_modalities);
      const outputs = normalizeOutputs(m.architecture?.output_modalities);
      const mods = deriveModalitiesFromIO(inputs, outputs);
      const pricingIn = m.pricing?.prompt ? Number(m.pricing.prompt) * 1_000_000 : undefined;
      const pricingOut = m.pricing?.completion ? Number(m.pricing.completion) * 1_000_000 : undefined;
      return {
        name: m.id,
        label: m.name || m.id,
        description: m.description,
        modalities: mods,
        input: inputs,
        output: outputs,
        contextWindow: m.context_length ?? m.top_provider?.context_length,
        pricingPer1M: (pricingIn || pricingOut) ? { input: pricingIn, output: pricingOut } : undefined,
      };
    });
    /* OpenRouter 2026 把纯出图模型拆到 /images/models (gpt-image-2 / flux.2 / recraft ...),
     * 主 /models 里没有. 显式拉一遍并入, 按 id 去重 (主列表已有的不覆盖). */
    const imageModels = await fetchOpenRouterImageCatalog(baseUrl, apiKey, extra);
    const seen = new Set(models.map(m => m.name.toLowerCase()));
    for (const im of imageModels) {
      if (!seen.has(im.name.toLowerCase())) { models.push(im); seen.add(im.name.toLowerCase()); }
    }
    return { ok: true, models, status: resp.status, parser: 'openrouter-metadata' };
  } catch (err: any) {
    return { ok: false, models: [], error: err?.message || String(err), parser: 'openrouter' };
  }
}

/**
 * 拉 OpenRouter 图像目录 /images/models. 每条带 architecture + supported_parameters
 * (input_references>0 或 input_modalities 含 image ⇒ 支持图生图/编辑). 失败返空, 不阻断主同步.
 */
async function fetchOpenRouterImageCatalog(baseUrl: string, apiKey: string, extra?: Record<string, string>): Promise<ProviderModelConfig[]> {
  try {
    const resp = await fetch(`${baseUrl}/images/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': extra?.['HTTP-Referer'] ?? 'https://neox-dev.com',
        'X-Title': extra?.['X-Title'] ?? 'Neox',
      },
    });
    if (!resp.ok) return [];
    const json = await resp.json() as {
      data: Array<OpenRouterModel & { supported_parameters?: { input_references?: { max?: number } } }>;
    };
    return (json.data || [])
      .filter(m => m.id && m.id !== 'openrouter/auto')
      .map(m => {
        const inputs = normalizeInputs(m.architecture?.input_modalities);
        const canEdit = (m.supported_parameters?.input_references?.max ?? 0) > 0 || !!inputs?.includes('image');
        const mods: Modality[] = canEdit ? ['image', 'image-edit'] : ['image'];
        return {
          name: m.id,
          label: m.name || m.id,
          description: m.description,
          modalities: mods,
          input: canEdit ? ['text', 'image', 'mask'] : ['text'],
          output: ['image'],
        } as ProviderModelConfig;
      });
  } catch {
    return [];
  }
}

// ============================================================================
// Anthropic — /v1/models list (chat only)
// ============================================================================

async function fetchAnthropicModels(baseUrl: string, apiKey: string): Promise<SyncModelsResult> {
  try {
    const resp = await fetch(`${baseUrl}/models`, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    });
    if (!resp.ok) {
      return { ok: false, models: [], status: resp.status, error: await resp.text().catch(() => `HTTP ${resp.status}`), parser: 'anthropic' };
    }
    const json = await resp.json() as { data: Array<{ id: string; display_name?: string; type?: string }> };
    const models: ProviderModelConfig[] = (json.data || []).map(m => ({
      name: m.id,
      label: m.display_name || m.id,
      modalities: ['chat'],
      input: ['text', 'image'],
      output: ['text'],
    }));
    return { ok: true, models, status: resp.status, parser: 'anthropic' };
  } catch (err: any) {
    return { ok: false, models: [], error: err?.message || String(err), parser: 'anthropic' };
  }
}

// ============================================================================
// Gemini — /v1beta/models  (supportedGenerationMethods 判定 modality)
// ============================================================================

async function fetchGeminiModels(baseUrl: string, apiKey: string): Promise<SyncModelsResult> {
  try {
    /* Gemini apiKey 走 query string, 不用 Authorization. */
    const url = `${baseUrl}/models?key=${encodeURIComponent(apiKey)}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      return { ok: false, models: [], status: resp.status, error: await resp.text().catch(() => `HTTP ${resp.status}`), parser: 'gemini' };
    }
    const json = await resp.json() as {
      models: Array<{
        name: string;
        displayName?: string;
        description?: string;
        inputTokenLimit?: number;
        supportedGenerationMethods?: string[];
      }>;
    };
    const models: ProviderModelConfig[] = (json.models || []).map(m => {
      const supports = new Set(m.supportedGenerationMethods || []);
      const mods: Modality[] = [];
      if (supports.has('generateContent') || supports.has('streamGenerateContent')) mods.push('chat');
      if (supports.has('embedContent')) mods.push('embedding');
      if (/image/i.test(m.name)) { mods.push('image'); mods.push('image-edit'); }
      const shortId = m.name.replace(/^models\//, '');
      return {
        name: shortId,
        label: m.displayName || shortId,
        description: m.description,
        modalities: mods.length > 0 ? mods : ['chat'],
        input: mods.includes('image') ? ['text', 'image', 'mask'] : ['text', 'image'],
        output: mods.includes('image') ? ['image'] : ['text'],
        contextWindow: m.inputTokenLimit,
      };
    });
    return { ok: true, models, status: resp.status, parser: 'gemini' };
  } catch (err: any) {
    return { ok: false, models: [], error: err?.message || String(err), parser: 'gemini' };
  }
}

// ============================================================================
// OpenAI-compat 兜底 (OpenAI 官方 + Doubao + Kimi + DeepSeek + Grok + Mistral + Groq + Together + GLM ...)
// ============================================================================

async function fetchOpenAICompatModels(baseUrl: string, apiKey: string, extra?: Record<string, string>): Promise<SyncModelsResult> {
  try {
    const resp = await fetch(`${baseUrl}/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(extra || {}),
      },
    });
    if (!resp.ok) {
      return { ok: false, models: [], status: resp.status, error: await resp.text().catch(() => `HTTP ${resp.status}`), parser: 'openai-compat' };
    }
    const json = await resp.json() as { data: Array<{ id: string; owned_by?: string }> };
    const models: ProviderModelConfig[] = (json.data || []).map(m => {
      /* modality 靠模型名启发式 (providerCapabilities.getEffectiveModelModalities 内部有规则). */
      const stub: ProviderModelConfig = { name: m.id, label: m.id };
      const inferred = getEffectiveModelModalities(stub);
      const hasImage = inferred.includes('image') || inferred.includes('image-edit');
      const hasTTS = inferred.includes('tts');
      const hasSTT = inferred.includes('stt');
      const hasEmbed = inferred.includes('embedding');
      return {
        name: m.id,
        label: m.id,
        modalities: inferred,
        input: hasImage ? ['text', 'image', 'mask']
          : hasTTS ? ['text']
          : hasSTT ? ['audio']
          : hasEmbed ? ['text']
          : ['text', 'image'], /* chat 默认接受图片 (vision), 上游拒了 UI 层再降级 */
        output: hasImage ? ['image']
          : hasTTS ? ['audio']
          : ['text'],
      };
    });
    return { ok: true, models, status: resp.status, parser: 'openai-compat' };
  } catch (err: any) {
    return { ok: false, models: [], error: err?.message || String(err), parser: 'openai-compat' };
  }
}

// ============================================================================
// Helpers
// ============================================================================

function normalizeInputs(arr?: string[]): Array<'text' | 'image' | 'audio' | 'video' | 'file' | 'mask'> | undefined {
  if (!arr) return undefined;
  const out: any[] = [];
  for (const v of arr) {
    const lower = v.toLowerCase();
    if (lower === 'text') out.push('text');
    else if (lower === 'image') out.push('image');
    else if (lower === 'audio') out.push('audio');
    else if (lower === 'video') out.push('video');
    else if (lower === 'file' || lower === 'document') out.push('file');
  }
  return out.length > 0 ? out : undefined;
}
function normalizeOutputs(arr?: string[]): Array<'text' | 'image' | 'audio' | 'video'> | undefined {
  if (!arr) return undefined;
  const out: any[] = [];
  for (const v of arr) {
    const lower = v.toLowerCase();
    if (lower === 'text') out.push('text');
    else if (lower === 'image') out.push('image');
    else if (lower === 'audio') out.push('audio');
    else if (lower === 'video') out.push('video');
  }
  return out.length > 0 ? out : undefined;
}

function deriveModalitiesFromIO(inputs?: string[], outputs?: string[]): Modality[] {
  const mods: Modality[] = [];
  if (!inputs || !outputs) return ['chat'];
  const hasImageIn = inputs.includes('image');
  const hasImageOut = outputs.includes('image');
  const hasTextOut = outputs.includes('text');
  if (hasImageOut) { mods.push('image'); if (hasImageIn) mods.push('image-edit'); }
  if (hasTextOut) mods.push('chat');
  if (outputs.includes('audio')) mods.push('tts');
  if (inputs.includes('audio') && hasTextOut) mods.push('stt');
  return mods.length > 0 ? mods : ['chat'];
}
