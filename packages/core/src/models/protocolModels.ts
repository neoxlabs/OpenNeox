/**
 * Protocol Model Suggestions
 *
 * 根据 Provider 协议提供推荐的模型列表
 */

import { modelRegistry, type ModelMetadata } from '@neoxlabs/platform/models/registry/index.js';
import { PROVIDER_PRESETS } from '@neoxlabs/kernel/models/providerPresets.js';
import type { ProviderProtocol } from '@neoxlabs/platform/shared/ipc.js';

type RegistryProvider = ModelMetadata['provider'];

const PROTOCOL_PROVIDER_MAP: Record<ProviderProtocol, RegistryProvider[]> = {
  'openai': ['openai'],
  'openai-responses': ['openai'],
  'openai-images': ['openai'],
  'openai-tts': ['openai'],
  'openai-stt': ['openai'],
  'openai-embedding': ['openai'],
  'anthropic': ['anthropic'],
  'anthropic-openai': ['anthropic'],
  'gemini': ['gemini'],
  'gemini-images': ['gemini'],
  'grok': ['xai'],
  'grok-images': ['xai'],
  'deepseek': ['deepseek'],
  'minimax': ['minimax'],
  'minimax-tts': ['minimax'],
  'minimax-video': ['minimax'],
  'qwen': ['qwen'],
  'qwen-images': ['qwen'],
  'dashscope-tts': ['qwen'],
  'doubao': ['doubao'],
  'doubao-images': ['doubao'],
  'doubao-tts': ['doubao'],
  'kimi': ['kimi'],
  'glm': ['glm'],
  'glm-claude': ['glm'],
  'glm-images': ['glm'],
  'kimi-claude': ['kimi'],
  'openrouter': [],
  'openrouter-images': [],
  'mistral': ['mistral'],
  'groq': ['groq'],
  'together': ['together'],
};

const TWO_YEARS_MS = 1000 * 60 * 60 * 24 * 365 * 2;

function getProvidersForProtocol(protocol: ProviderProtocol): RegistryProvider[] {
  return PROTOCOL_PROVIDER_MAP[protocol] || [];
}

function parseReleaseTimestamp(releaseDate?: string): number | null {
  if (!releaseDate) return null;
  const timestamp = Date.parse(releaseDate);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function isRecentRelease(releaseDate?: string): boolean {
  const timestamp = parseReleaseTimestamp(releaseDate);
  if (timestamp === null) return false;
  return (Date.now() - timestamp) <= TWO_YEARS_MS;
}

function compareByReleaseAndScore(a: ModelMetadata, b: ModelMetadata): number {
  const aTs = parseReleaseTimestamp(a.releaseDate);
  const bTs = parseReleaseTimestamp(b.releaseDate);
  const aRecent = isRecentRelease(a.releaseDate);
  const bRecent = isRecentRelease(b.releaseDate);

  if (aRecent !== bRecent) {
    return aRecent ? -1 : 1;
  }
  if (aTs !== null && bTs !== null && aTs !== bTs) {
    return bTs - aTs;
  }
  if (aTs !== null && bTs === null) return -1;
  if (aTs === null && bTs !== null) return 1;

  if ((a.supportsStreaming ?? false) !== (b.supportsStreaming ?? false)) {
    return (a.supportsStreaming ?? false) ? -1 : 1;
  }

  const scoreDiff = (b.scores?.coding ?? 0) - (a.scores?.coding ?? 0);
  if (scoreDiff !== 0) return scoreDiff;

  return a.id.localeCompare(b.id);
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) {
    const value = tokens / 1_000_000;
    const nearest = Math.round(value);
    if (nearest >= 1 && Math.abs(value - nearest) <= 0.11) return `${nearest}M`;
    const formatted = value >= 10 ? `${Math.round(value)}` : value.toFixed(1).replace(/\.0$/, '');
    return `${formatted}M`;
  }
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}K`;
  }
  return `${tokens}`;
}

function normalizeSearchText(input: string): string {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\-_.:/\\|,;，。]+/g, '');
}

export interface ProtocolModelOption {
  id: string;
  displayName: string;
  aliases: string[];
  shortContext: string;
  contextLabel: string;
  description?: string;
  releaseDate?: string;
  recent: boolean;
  source: 'registry' | 'custom';
}

function toRegistryOption(model: ModelMetadata): ProtocolModelOption {
  return {
    id: model.id,
    displayName: model.displayName,
    aliases: model.aliases || [],
    shortContext: formatContext(model.maxInputTokens),
    contextLabel: `${formatContext(model.maxInputTokens)} in / ${formatContext(model.maxOutputTokens)} out`,
    description: model.notes,
    releaseDate: model.releaseDate,
    recent: isRecentRelease(model.releaseDate),
    source: 'registry',
  };
}

function toCustomOption(modelId: string): ProtocolModelOption {
  return {
    id: modelId,
    displayName: modelId,
    aliases: [],
    shortContext: '',
    contextLabel: '',
    recent: false,
    source: 'custom',
  };
}

export function normalizeModelId(modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed) return '';
  const model = modelRegistry.getModel(trimmed);
  return model?.id || trimmed;
}

/**
 * 预设自带的模型清单 → 下拉选项。
 *
 *   只在 registry 对这个协议**一条都没有**时才用 (现在只剩 OpenRouter ——
 *   聚合器, 不属于任何一家厂商)。其余情况一律以 registry 为准, 原因见
 *   getNormalizedModelOptionsByProtocol 里那段说明: 预设的 commonModels 是手写快照,
 *   会过期, 混进下拉会让用户选到一个已经不存在的模型。
 */
function toPresetOption(model: { name: string; label?: string; contextWindow?: number }): ProtocolModelOption {
  return {
    id: model.name,
    displayName: model.label ?? model.name,
    aliases: [],
    shortContext: model.contextWindow ? formatContext(model.contextWindow) : '',
    contextLabel: model.contextWindow ? `${formatContext(model.contextWindow)} in` : '',
    recent: false,
    source: 'registry',
  };
}

export function getNormalizedModelOptionsByProtocol(
  protocol: ProviderProtocol,
  extraModels: string[] = [],
  /** 用户在「添加服务商」里选中的预设 id —— 给了就以这家的清单为准 */
  presetId?: string,
): ProtocolModelOption[] {
  const providers = getProvidersForProtocol(protocol);
  const registryModels = modelRegistry
    .getAllModels()
    .filter(model => providers.includes(model.provider) && !model.deprecated)
    .sort(compareByReleaseAndScore)
    .map(toRegistryOption);

  const merged = new Map<string, ProtocolModelOption>();
  for (const option of registryModels) {
    merged.set(option.id.toLowerCase(), option);
  }

  if (presetId && registryModels.length === 0) {
    const preset = PROVIDER_PRESETS.find(p => p.id === presetId);
    for (const model of preset?.commonModels ?? []) {
      if (!model?.name) continue;
      /* 只收 chat 类 —— 下拉是给对话模型用的, 把 embedding/tts 混进来只会干扰 */
      const mods = model.modalities ?? ['chat'];
      if (!mods.includes('chat')) continue;
      const key = model.name.toLowerCase();
      if (!merged.has(key)) merged.set(key, toPresetOption(model));
    }
  }

  const customOptions: ProtocolModelOption[] = [];
  for (const modelName of extraModels) {
    const normalized = normalizeModelId(modelName);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (merged.has(key)) continue;

    const model = modelRegistry.getModel(normalized);
    if (model) {
      if (!providers.includes(model.provider)) {
        continue;
      }
      merged.set(key, toRegistryOption(model));
    } else {
      customOptions.push(toCustomOption(normalized));
    }
  }

  customOptions.sort((a, b) => a.id.localeCompare(b.id));
  return [...merged.values(), ...customOptions];
}

export function searchNormalizedModelOptions(
  query: string,
  protocol: ProviderProtocol,
  extraModels: string[] = [],
  presetId?: string,
): ProtocolModelOption[] {
  const lowerQuery = query.trim().toLowerCase();
  const compactQuery = normalizeSearchText(query);
  const options = getNormalizedModelOptionsByProtocol(protocol, extraModels, presetId);
  if (!lowerQuery) return options;

  return options.filter(option =>
    option.id.toLowerCase().includes(lowerQuery) ||
    option.displayName.toLowerCase().includes(lowerQuery) ||
    option.aliases.some(alias => alias.toLowerCase().includes(lowerQuery)) ||
    normalizeSearchText(option.id).includes(compactQuery) ||
    normalizeSearchText(option.displayName).includes(compactQuery) ||
    option.aliases.some(alias => normalizeSearchText(alias).includes(compactQuery)),
  );
}

/**
 * 根据 Protocol 获取推荐模型列表
 */
export function getModelSuggestionsByProtocol(protocol: ProviderProtocol): string[] {
  return getNormalizedModelOptionsByProtocol(protocol).map(option => option.id);
}

/**
 * 获取按 Protocol 分组的模型建议
 */
export function getGroupedModelSuggestions(): Record<ProviderProtocol, string[]> {
  return {
    'openai': getModelSuggestionsByProtocol('openai'),
    'openai-responses': getModelSuggestionsByProtocol('openai-responses'),
    'openai-images': getModelSuggestionsByProtocol('openai-images'),
    'openai-tts': getModelSuggestionsByProtocol('openai-tts'),
    'openai-stt': getModelSuggestionsByProtocol('openai-stt'),
    'openai-embedding': getModelSuggestionsByProtocol('openai-embedding'),
    'anthropic': getModelSuggestionsByProtocol('anthropic'),
    'anthropic-openai': getModelSuggestionsByProtocol('anthropic-openai'),
    'gemini': getModelSuggestionsByProtocol('gemini'),
    'gemini-images': getModelSuggestionsByProtocol('gemini-images'),
    'grok': getModelSuggestionsByProtocol('grok'),
    'grok-images': getModelSuggestionsByProtocol('grok-images'),
    'deepseek': getModelSuggestionsByProtocol('deepseek'),
    'minimax': getModelSuggestionsByProtocol('minimax'),
    'minimax-tts': getModelSuggestionsByProtocol('minimax-tts'),
    'minimax-video': getModelSuggestionsByProtocol('minimax-video'),
    'qwen': getModelSuggestionsByProtocol('qwen'),
    'qwen-images': getModelSuggestionsByProtocol('qwen-images'),
    'dashscope-tts': getModelSuggestionsByProtocol('dashscope-tts'),
    'doubao': getModelSuggestionsByProtocol('doubao'),
    'doubao-images': getModelSuggestionsByProtocol('doubao-images'),
    'doubao-tts': getModelSuggestionsByProtocol('doubao-tts'),
    'kimi': getModelSuggestionsByProtocol('kimi'),
    'glm': getModelSuggestionsByProtocol('glm'),
    'glm-claude': getModelSuggestionsByProtocol('glm-claude'),
    'glm-images': getModelSuggestionsByProtocol('glm-images'),
    'kimi-claude': getModelSuggestionsByProtocol('kimi-claude'),
    'openrouter': getModelSuggestionsByProtocol('openrouter'),
    'openrouter-images': getModelSuggestionsByProtocol('openrouter-images'),
    'mistral': getModelSuggestionsByProtocol('mistral'),
    'groq': getModelSuggestionsByProtocol('groq'),
    'together': getModelSuggestionsByProtocol('together'),
  };
}

/**
 * 获取 Protocol 的默认推荐模型（最佳模型）
 */
export function getDefaultModelForProtocol(protocol: ProviderProtocol): string | null {
  const suggestions = getModelSuggestionsByProtocol(protocol);
  return suggestions.length > 0 ? suggestions[0] : null;
}

/**
 * 获取热门模型列表（按 Protocol 分类）
 */
export function getPopularModelsByProtocol(protocol: ProviderProtocol, limit: number = 10): Array<{
  id: string;
  displayName: string;
  contextWindow: number;
  badges: string[];
  scores?: {
    coding: number;
    reasoning: number;
  };
}> {
  const suggestions = getModelSuggestionsByProtocol(protocol);
  const models = suggestions.slice(0, limit).map(modelId => {
    const model = modelRegistry.getModel(modelId);
    if (!model) return null;

    const badges: string[] = [];
    if (model.supportsVision) badges.push('👁️ Vision');
    if (model.supportsThinking) badges.push('💭 Thinking');
    if (model.maxInputTokens >= 1000000) badges.push('🚀 1M+ Context');

    return {
      id: model.id,
      displayName: model.displayName,
      contextWindow: model.maxInputTokens,
      badges,
      scores: model.scores ? {
        coding: model.scores.coding ?? 0,
        reasoning: model.scores.reasoning ?? 0,
      } : undefined,
    };
  }).filter(Boolean) as Array<{
    id: string;
    displayName: string;
    contextWindow: number;
    badges: string[];
    scores?: { coding: number; reasoning: number };
  }>;

  return models;
}

/**
 * 搜索模型（模糊匹配）
 */
export function searchModels(query: string, protocol?: ProviderProtocol): string[] {
  const lowerQuery = query.trim().toLowerCase();
  const compactQuery = normalizeSearchText(query);
  if (!lowerQuery) {
    return protocol
      ? getModelSuggestionsByProtocol(protocol)
      : modelRegistry.getAllModels().filter(model => !model.deprecated).map(model => model.id);
  }

  if (protocol) {
    return searchNormalizedModelOptions(lowerQuery, protocol).map(option => option.id);
  }

  return modelRegistry
    .getAllModels()
    .sort(compareByReleaseAndScore)
    .filter(model => !model.deprecated)
    .filter(model =>
      model.id.toLowerCase().includes(lowerQuery) ||
      model.displayName.toLowerCase().includes(lowerQuery) ||
      model.aliases?.some(alias => alias.toLowerCase().includes(lowerQuery)) ||
      normalizeSearchText(model.id).includes(compactQuery) ||
      normalizeSearchText(model.displayName).includes(compactQuery) ||
      model.aliases?.some(alias => normalizeSearchText(alias).includes(compactQuery)),
    )
    .map(model => model.id);
}

/**
 * 获取模型的友好显示名称
 */
export function getModelDisplayInfo(modelId: string): {
  id: string;
  displayName: string;
  context: string;
  contextLabel?: string;
  badges: string[];
  description?: string;
  releaseDate?: string;
  recent?: boolean;
} | null {
  const model = modelRegistry.getModel(modelId);
  if (!model) {
    return {
      id: modelId,
      displayName: modelId,
      context: '',
      badges: [],
    };
  }

  const badges: string[] = [];
  if (model.supportsVision) badges.push('👁️');
  if (model.supportsThinking) badges.push('💭');

  return {
    id: model.id,
    displayName: model.displayName,
    context: formatContext(model.maxInputTokens),
    contextLabel: `${formatContext(model.maxInputTokens)} in / ${formatContext(model.maxOutputTokens)} out`,
    badges,
    description: model.notes,
    releaseDate: model.releaseDate,
    recent: isRecentRelease(model.releaseDate),
  };
}

/**
 * 获取 Protocol 的推荐配置
 */
export function getProtocolRecommendedConfig(protocol: ProviderProtocol): {
  defaultModel: string | null;
  recommendedModels: string[];
  baseUrl: string;
  urlSuffix: string;
  maxTokens: number;
  description: string;
} {
  const baseConfigs: Record<ProviderProtocol, {
    baseUrl: string;
    urlSuffix: string;
    maxTokens: number;
    description: string;
  }> = {
    'openai': {
      baseUrl: 'https://api.openai.com/v1',
      urlSuffix: '/chat/completions',
      maxTokens: 16384,
      description: 'OpenAI 官方 API',
    },
    'openai-responses': {
      baseUrl: 'https://api.openai.com/v1',
      urlSuffix: '/responses',
      maxTokens: 16384,
      description: 'OpenAI Responses API (支持 Codex)',
    },
    'anthropic': {
      baseUrl: 'https://api.anthropic.com',
      urlSuffix: '/v1/messages',
      maxTokens: 16000,
      description: 'Anthropic 官方 API',
    },
    'anthropic-openai': {
      baseUrl: 'https://api.anthropic.com/v1',
      urlSuffix: '/chat/completions',
      maxTokens: 16000,
      description: 'Anthropic OpenAI 兼容格式',
    },
    'gemini': {
      baseUrl: 'https://generativelanguage.googleapis.com',
      urlSuffix: '/v1/models',
      maxTokens: 8192,
      description: 'Google Gemini API',
    },
    'deepseek': {
      baseUrl: 'https://api.deepseek.com',
      urlSuffix: '/chat/completions',
      maxTokens: 32768,
      description: 'DeepSeek OpenAI 兼容协议',
    },
    'minimax': {
      baseUrl: 'https://api.minimax.chat/v1',
      urlSuffix: '/chat/completions',
      maxTokens: 32768,
      description: 'MiniMax OpenAI 兼容协议',
    },
    'qwen': {
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      urlSuffix: '/chat/completions',
      maxTokens: 32768,
      description: 'Qwen / 阿里云百炼 OpenAI 兼容协议',
    },
    'doubao': {
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      urlSuffix: '/chat/completions',
      maxTokens: 4096,
      description: '豆包 API',
    },
    'kimi': {
      baseUrl: 'https://api.moonshot.cn/v1',
      urlSuffix: '/chat/completions',
      maxTokens: 8192,
      description: 'Kimi (Moonshot) OpenAI 兼容协议',
    },
    'glm': {
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      urlSuffix: '/chat/completions',
      maxTokens: 32000,
      description: 'GLM (智谱 AI) OpenAI 兼容协议',
    },
    'glm-claude': {
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      urlSuffix: '/v1/messages',
      maxTokens: 32000,
      description: 'GLM (智谱 AI) Anthropic Claude 协议',
    },
    'kimi-claude': {
      baseUrl: 'https://api.moonshot.cn/anthropic',
      urlSuffix: '/v1/messages',
      maxTokens: 131072,
      description: 'Kimi (Moonshot) Anthropic Claude 协议',
    },
    'openai-images':     { baseUrl: 'https://api.openai.com/v1', urlSuffix: '/images/generations', maxTokens: 0, description: 'OpenAI Images 生成 + 编辑' },
    'openai-tts':        { baseUrl: 'https://api.openai.com/v1', urlSuffix: '/audio/speech', maxTokens: 0, description: 'OpenAI TTS (tts-1)' },
    'openai-stt':        { baseUrl: 'https://api.openai.com/v1', urlSuffix: '/audio/transcriptions', maxTokens: 0, description: 'OpenAI STT (Whisper)' },
    'openai-embedding':  { baseUrl: 'https://api.openai.com/v1', urlSuffix: '/embeddings', maxTokens: 0, description: 'OpenAI Embeddings' },
    'gemini-images':     { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', urlSuffix: '/models', maxTokens: 0, description: 'Gemini 图像 (Nano Banana)' },
    'grok':              { baseUrl: 'https://api.x.ai/v1', urlSuffix: '/chat/completions', maxTokens: 8192, description: 'xAI Grok Chat' },
    'grok-images':       { baseUrl: 'https://api.x.ai/v1', urlSuffix: '/images/generations', maxTokens: 0, description: 'Grok Image' },
    'doubao-images':     { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', urlSuffix: '/images/generations', maxTokens: 0, description: '豆包 Seedream 4 图像' },
    'doubao-tts':        { baseUrl: 'https://openspeech.bytedance.com', urlSuffix: '/api/v1/tts', maxTokens: 0, description: '豆包 CosyVoice TTS' },
    'minimax-tts':       { baseUrl: 'https://api.minimax.chat/v1', urlSuffix: '/t2a_v2', maxTokens: 0, description: 'MiniMax TTS' },
    'minimax-video':     { baseUrl: 'https://api.minimax.chat/v1', urlSuffix: '/video_generation', maxTokens: 0, description: 'MiniMax 视频生成' },
    'qwen-images':       { baseUrl: 'https://dashscope.aliyuncs.com/api/v1', urlSuffix: '/services/aigc/text2image/image-synthesis', maxTokens: 0, description: '通义万相图像' },
    'dashscope-tts':     { baseUrl: 'https://dashscope.aliyuncs.com/api/v1', urlSuffix: '/services/audio/tts', maxTokens: 0, description: 'CosyVoice v2 TTS' },
    'glm-images':        { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', urlSuffix: '/images/generations', maxTokens: 0, description: '智谱 CogView-4 图像' },
    'openrouter':        { baseUrl: 'https://openrouter.ai/api/v1', urlSuffix: '/chat/completions', maxTokens: 8192, description: 'OpenRouter 聚合器 (400+ 模型)' },
    'openrouter-images': { baseUrl: 'https://openrouter.ai/api/v1', urlSuffix: '/images', maxTokens: 0, description: 'OpenRouter Images (统一 /images 端点)' },
    'mistral':           { baseUrl: 'https://api.mistral.ai/v1', urlSuffix: '/chat/completions', maxTokens: 8192, description: 'Mistral AI' },
    'groq':              { baseUrl: 'https://api.groq.com/openai/v1', urlSuffix: '/chat/completions', maxTokens: 8192, description: 'Groq LPU 极速推理' },
    'together':          { baseUrl: 'https://api.together.xyz/v1', urlSuffix: '/chat/completions', maxTokens: 8192, description: 'Together AI 开源托管' },
  };

  const config = baseConfigs[protocol];
  const defaultModel = getDefaultModelForProtocol(protocol);
  const recommendedModels = getModelSuggestionsByProtocol(protocol).slice(0, 10);

  return {
    defaultModel,
    recommendedModels,
    ...config,
  };
}
