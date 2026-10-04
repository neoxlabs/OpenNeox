/**
 * providerPresets — 主流 provider 一键预置模板.
 *
 * 用户在设置 UI "添加 provider" → 选 preset → 自动填 baseUrl + capabilities + 常见模型列表,
 * 只需要粘贴 apiKey 即可用. 覆盖海外 (OpenAI/OpenRouter/opencode/Anthropic/Gemini/Grok/Mistral/Groq/Together)
 * + 国内 (Doubao/智谱/DeepSeek/Kimi/Dashscope/MiniMax).
 *
 * 每个 preset 声明:
 *   · id: 稳定短标识, 存进 provider.presetId
 *   · label + 简介: 显示给用户看
 *   · baseUrl: 上游 API 根
 *   · capabilities: 这个 provider 能做哪些 modality (chat / image / tts / stt / embedding / video)
 *   · commonModels: 精选常用模型列表, 用户可以直接勾选加入, 也可以点"同步" 拉真实全表
 *   · authHint: apiKey 从哪里申请 + 命名格式
 *   · docsUrl: 用户点跳去官方文档
 *
 * 增补新 preset 只需要 append 一项, 消费方 (设置 UI + provider add wizard) 零改动.
 */

import type {
  Modality,
  ProviderCapability,
  ProviderModelConfig,
  ProviderProtocol,
} from '../types/configTypes.js';

export interface ProviderPreset {
  id: string;
  label: string;
  /** 一句话介绍, 显示在 preset 卡片副标题. */
  tagline: string;
  /** 官方 base URL (可覆盖, 用户自己代理时改). */
  baseUrl: string;
  /** 全套能力声明. 用户可在 UI 里禁用其中某项. */
  capabilities: ProviderCapability[];
  /** 精选常用模型列表. 一键选中加进 provider.models. */
  commonModels: ProviderModelConfig[];
  /** apiKey 从哪里申请, 一句话说明. */
  authHint: string;
  /** 官方文档 / 控制台 URL. */
  docsUrl: string;
  /** 需要用户额外提供的 headers (如 OpenRouter 的 HTTP-Referer / X-Title). */
  extraHeadersHint?: Record<string, string>;
  /** provider 地域偏好 - 国内/海外. UI 分组用. */
  region: 'global' | 'china';
  /** brand 主色 (hex), UI 卡片强调. */
  brandColor?: string;
}

// ============================================================================
// 常用 model modality 助手 (减少 duplicate 写)
// ============================================================================

const chatModel = (name: string, label?: string, ctx?: number): ProviderModelConfig => ({
  name,
  label: label ?? name,
  modalities: ['chat'],
  input: ['text', 'image'],
  output: ['text'],
  ...(ctx ? { contextWindow: ctx } : {}),
});
const chatModelTextOnly = (name: string, label?: string, ctx?: number): ProviderModelConfig => ({
  name,
  label: label ?? name,
  modalities: ['chat'],
  input: ['text'],
  output: ['text'],
  ...(ctx ? { contextWindow: ctx } : {}),
});
const imageModel = (name: string, label?: string, edit = true): ProviderModelConfig => ({
  name,
  label: label ?? name,
  modalities: edit ? ['image', 'image-edit'] : ['image'],
  input: edit ? ['text', 'image', 'mask'] : ['text'],
  output: ['image'],
});
const ttsModel = (name: string, label?: string): ProviderModelConfig => ({
  name,
  label: label ?? name,
  modalities: ['tts'],
  input: ['text'],
  output: ['audio'],
});
const sttModel = (name: string, label?: string): ProviderModelConfig => ({
  name,
  label: label ?? name,
  modalities: ['stt'],
  input: ['audio'],
  output: ['text'],
});
const embedModel = (name: string, label?: string, dim?: number): ProviderModelConfig => ({
  name,
  label: label ?? name,
  modalities: ['embedding'],
  input: ['text'],
  output: ['text'],
  ...(dim ? { contextWindow: dim } : {}),
});

const cap = (modality: Modality, protocol: ProviderProtocol, endpoint?: string): ProviderCapability => ({
  modality,
  protocol,
  ...(endpoint ? { endpoint } : {}),
  enabled: true,
});

// ============================================================================
// Preset 定义 (按热度排序)
// ============================================================================

export const PROVIDER_PRESETS: ProviderPreset[] = [
  // ---------- Global ----------
  {
    id: 'openai',
    label: 'OpenAI',
    tagline: '官方 API — GPT-5 系列 · gpt-image-1 · TTS · Whisper',
    baseUrl: 'https://api.openai.com/v1',
    region: 'global',
    brandColor: '#10a37f',
    authHint: 'https://platform.openai.com/api-keys · 格式 sk-...',
    docsUrl: 'https://platform.openai.com/docs',
    capabilities: [
      cap('chat', 'openai'),
      cap('chat', 'openai-responses', '/responses'),
      cap('image', 'openai-images'),
      cap('image-edit', 'openai-images', '/images/edits'),
      cap('tts', 'openai-tts'),
      cap('stt', 'openai-stt'),
      cap('embedding', 'openai-embedding'),
    ],
    commonModels: [
      chatModel('gpt-5.6', 'GPT-5.6 Sol', 400000),
      chatModel('gpt-5.6-mini', 'GPT-5.6 mini', 400000),
      chatModel('gpt-5', 'GPT-5', 128000),
      imageModel('gpt-image-1'),
      imageModel('dall-e-3', 'DALL·E 3', false),
      ttsModel('tts-1'),
      ttsModel('tts-1-hd'),
      sttModel('whisper-1'),
      embedModel('text-embedding-3-large', 'text-embedding-3-large', 3072),
      embedModel('text-embedding-3-small', 'text-embedding-3-small', 1536),
    ],
  },

  {
    id: 'openrouter',
    label: 'OpenRouter',
    tagline: '一个 key 通 400+ 模型 (含 Claude · Gemini · Grok · 开源系)',
    baseUrl: 'https://openrouter.ai/api/v1',
    region: 'global',
    brandColor: '#6467f2',
    authHint: 'https://openrouter.ai/keys · 格式 sk-or-v1-...',
    docsUrl: 'https://openrouter.ai/docs',
    extraHeadersHint: {
      'HTTP-Referer': 'https://neox-dev.com',
      'X-Title': 'Neox',
    },
    capabilities: [
      cap('chat', 'openai'),
      /* OpenRouter 2026 版图像 API: 统一 /api/v1/images 端点, 支持文生图 + 图生图 + 编辑 (image_references).
       * 不分 generations/edits 两个端点, 有 input_references 就是编辑. */
      cap('image', 'openrouter-images', '/images'),
      cap('image-edit', 'openrouter-images', '/images'),
    ],
    commonModels: [
      chatModel('anthropic/claude-opus-5', 'Claude Opus 5 (via OR)', 1000000),
      chatModel('openai/gpt-5.6-sol', 'GPT-5.6 Sol (via OR)', 1050000),
      chatModel('google/gemini-3.7-flash', 'Gemini 3.7 Flash (via OR)', 1048576),
      chatModel('x-ai/grok-4.6', 'Grok 4.6 (via OR)', 500000),
      chatModel('deepseek/deepseek-v4-pro-0813', 'DeepSeek V4 Pro (via OR)', 1048576),
      chatModel('moonshotai/kimi-k3', 'Kimi K3 (via OR)', 1048576),
      chatModel('z-ai/glm-5.3', 'GLM-5.3 (via OR)', 1048576),
      chatModel('qwen/qwen3.8-max', 'Qwen 3.8 Max (via OR)', 1000000),
      imageModel('openai/gpt-image-2', 'GPT Image 2 (via OR)'),
      imageModel('openai/gpt-image-1', 'GPT Image 1 (via OR)'),
      imageModel('black-forest-labs/flux-pro', 'FLUX Pro', false),
      imageModel('black-forest-labs/flux-schnell', 'FLUX Schnell', false),
      imageModel('black-forest-labs/flux-dev', 'FLUX Dev', false),
    ],
  },

  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    tagline: 'Claude 5 系列 · Opus 4.8 · Haiku 4.5',
    baseUrl: 'https://api.anthropic.com/v1',
    region: 'global',
    brandColor: '#c47f5c',
    authHint: 'https://console.anthropic.com/settings/keys · 格式 sk-ant-...',
    docsUrl: 'https://docs.anthropic.com',
    capabilities: [
      cap('chat', 'anthropic'),
    ],
    commonModels: [
      chatModel('claude-sonnet-5', 'Claude Sonnet 5', 1000000),
      chatModel('claude-opus-4-8', 'Claude Opus 4.8', 1000000),
      chatModel('claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 200000),
      chatModel('claude-opus-4-7', 'Claude Opus 4.7 (1M)', 1000000),
    ],
  },

  {
    id: 'gemini',
    label: 'Google Gemini',
    tagline: 'Gemini 2.5 Pro/Flash · 2M ctx · Nano Banana 图像',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    region: 'global',
    brandColor: '#4285f4',
    authHint: 'https://aistudio.google.com/apikey · 格式 AIza...',
    docsUrl: 'https://ai.google.dev/gemini-api/docs',
    capabilities: [
      cap('chat', 'gemini'),
      cap('image', 'gemini-images'),
      cap('image-edit', 'gemini-images'),
    ],
    commonModels: [
      chatModel('gemini-2.5-pro', 'Gemini 2.5 Pro', 2000000),
      chatModel('gemini-2.5-flash', 'Gemini 2.5 Flash', 1000000),
      chatModel('gemini-2.5-flash-lite', 'Gemini 2.5 Flash Lite', 1000000),
      imageModel('gemini-2.5-flash-image', 'Nano Banana (2.5 Flash Image)'),
    ],
  },

  {
    id: 'grok',
    label: 'xAI Grok',
    tagline: 'Grok 4.5 · 实时 X 数据 · xAI 官方端点',
    baseUrl: 'https://api.x.ai/v1',
    region: 'global',
    brandColor: '#000000',
    authHint: 'https://console.x.ai · 格式 xai-...',
    docsUrl: 'https://docs.x.ai',
    capabilities: [
      cap('chat', 'openai'),
      cap('image', 'grok-images'),
    ],
    commonModels: [
      imageModel('grok-imagine-image-quality', 'Grok Imagine (高质量)', false),
      chatModel('grok-4.5', 'Grok 4.5', 500000),
      chatModel('grok-composer-2.5-fast', 'Grok Composer 2.5 Fast', 256000),
    ],
  },

  {
    id: 'mistral',
    label: 'Mistral',
    tagline: '欧洲模型 · Mistral Large · Codestral · Pixtral',
    baseUrl: 'https://api.mistral.ai/v1',
    region: 'global',
    brandColor: '#ff7000',
    authHint: 'https://console.mistral.ai · 格式随机字符串',
    docsUrl: 'https://docs.mistral.ai',
    capabilities: [
      cap('chat', 'openai'),
      cap('embedding', 'openai-embedding', '/embeddings'),
    ],
    commonModels: [
      chatModel('mistral-large-latest', 'Mistral Large', 128000),
      chatModel('mistral-small-latest', 'Mistral Small', 128000),
      chatModel('codestral-latest', 'Codestral', 32000),
      chatModel('pixtral-large-latest', 'Pixtral Large', 128000),
      embedModel('mistral-embed', 'Mistral Embed', 1024),
    ],
  },

  {
    id: 'groq',
    label: 'Groq',
    tagline: 'LPU 极速推理 · Llama · Mixtral · Whisper',
    baseUrl: 'https://api.groq.com/openai/v1',
    region: 'global',
    brandColor: '#f55036',
    authHint: 'https://console.groq.com/keys · 格式 gsk_...',
    docsUrl: 'https://console.groq.com/docs',
    capabilities: [
      cap('chat', 'openai'),
      cap('stt', 'openai-stt', '/audio/transcriptions'),
    ],
    commonModels: [
      chatModel('llama-4-scout-17b', 'Llama 4 Scout 17B', 128000),
      chatModel('llama-4-maverick-17b', 'Llama 4 Maverick 17B', 128000),
      chatModel('llama-3.3-70b-versatile', 'Llama 3.3 70B', 128000),
      chatModel('mixtral-8x7b-32768', 'Mixtral 8x7B', 32768),
      sttModel('whisper-large-v3'),
    ],
  },

  {
    id: 'together',
    label: 'Together AI',
    tagline: '开源模型托管 · 200+ 模型 · FLUX 图像',
    baseUrl: 'https://api.together.xyz/v1',
    region: 'global',
    brandColor: '#0f6fff',
    authHint: 'https://api.together.xyz/settings/api-keys',
    docsUrl: 'https://docs.together.ai',
    capabilities: [
      cap('chat', 'openai'),
      cap('image', 'openai-images'),
      cap('embedding', 'openai-embedding', '/embeddings'),
    ],
    commonModels: [
      chatModel('meta-llama/Llama-4-Scout-17B-16E', 'Llama 4 Scout', 128000),
      chatModel('deepseek-ai/DeepSeek-R2', 'DeepSeek R2', 128000),
      chatModel('Qwen/Qwen3-Coder-480B', 'Qwen3 Coder 480B', 128000),
      imageModel('black-forest-labs/FLUX.1-schnell', 'FLUX.1 Schnell', false),
      imageModel('black-forest-labs/FLUX.1-dev', 'FLUX.1 Dev', false),
    ],
  },

  // ---------- China ----------
  {
    id: 'doubao',
    label: '字节豆包 (火山方舟)',
    tagline: '豆包 · Seed · Seedream 4 图像 · CosyVoice TTS',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    region: 'china',
    brandColor: '#0057ff',
    authHint: 'https://console.volcengine.com/ark · 格式 UUID',
    docsUrl: 'https://www.volcengine.com/docs/82379',
    capabilities: [
      cap('chat', 'doubao'),
      cap('image', 'doubao-images'),
      cap('image-edit', 'doubao-images', '/images/edits'),
      cap('tts', 'doubao-tts'),
    ],
    commonModels: [
      chatModel('doubao-seed-1.6', 'Doubao Seed 1.6', 256000),
      chatModel('doubao-pro-256k', 'Doubao Pro 256K', 256000),
      chatModel('doubao-lite-32k', 'Doubao Lite 32K', 32000),
      imageModel('doubao-seedream-4-0-250828', 'Seedream 4'),
      ttsModel('doubao-tts-v3', 'Doubao TTS'),
    ],
  },

  {
    id: 'deepseek',
    label: 'DeepSeek 深度求索',
    tagline: 'DeepSeek R2 推理 · V3 通用 · 极致性价比',
    baseUrl: 'https://api.deepseek.com/v1',
    region: 'china',
    brandColor: '#4d6bfe',
    authHint: 'https://platform.deepseek.com/api_keys · 格式 sk-...',
    docsUrl: 'https://api-docs.deepseek.com',
    capabilities: [
      cap('chat', 'deepseek'),
    ],
    commonModels: [
      chatModelTextOnly('deepseek-chat', 'DeepSeek V3', 128000),
      chatModelTextOnly('deepseek-reasoner', 'DeepSeek R2', 128000),
    ],
  },

  {
    id: 'kimi',
    label: 'Moonshot Kimi',
    tagline: 'Kimi K2.5 · 长上下文 · 中文场景强',
    baseUrl: 'https://api.moonshot.cn/v1',
    region: 'china',
    brandColor: '#2f7cf6',
    authHint: 'https://platform.moonshot.cn/console/api-keys · 格式 sk-...',
    docsUrl: 'https://platform.moonshot.cn/docs',
    capabilities: [
      cap('chat', 'kimi'),
    ],
    commonModels: [
      chatModel('kimi-k2.5', 'Kimi K2.5', 256000),
      chatModel('kimi-k2.5-preview', 'Kimi K2.5 Preview', 256000),
      chatModel('moonshot-v1-128k', 'Moonshot v1 128K', 128000),
    ],
  },

  {
    id: 'glm',
    label: '智谱 GLM',
    tagline: 'GLM-4.7 系列 · CogView-4 图像 · CogVideoX 视频',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    region: 'china',
    brandColor: '#3859ff',
    authHint: 'https://bigmodel.cn/usercenter/apikeys · 格式 xxxxx.xxxxx',
    docsUrl: 'https://bigmodel.cn/dev/api',
    capabilities: [
      cap('chat', 'glm'),
      cap('image', 'glm-images', '/images/generations'),
      cap('embedding', 'openai-embedding', '/embeddings'),
    ],
    commonModels: [
      chatModel('glm-4.7', 'GLM-4.7', 128000),
      chatModel('glm-4.7-air', 'GLM-4.7 Air', 128000),
      chatModel('glm-4.7-flash', 'GLM-4.7 Flash', 128000),
      imageModel('cogview-4', 'CogView-4', false),
      embedModel('embedding-3', 'GLM Embedding 3', 2048),
    ],
  },

  {
    id: 'dashscope',
    label: '阿里百炼 (Dashscope)',
    tagline: '通义千问 · 通义万相 · CosyVoice v2 · 全家桶',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    region: 'china',
    brandColor: '#615ced',
    authHint: 'https://bailian.console.aliyun.com/?apiKey · 格式 sk-...',
    docsUrl: 'https://help.aliyun.com/zh/dashscope',
    capabilities: [
      cap('chat', 'qwen', '/services/aigc/text-generation/generation'),
      cap('image', 'qwen-images', '/services/aigc/text2image/image-synthesis'),
      cap('tts', 'dashscope-tts', '/services/audio/tts'),
    ],
    commonModels: [
      chatModel('qwen3-max', 'Qwen3 Max', 128000),
      chatModel('qwen3-plus', 'Qwen3 Plus', 128000),
      chatModel('qwen3-coder-plus', 'Qwen3 Coder Plus', 128000),
      chatModel('qwen3-vl-plus', 'Qwen3 VL Plus', 128000),
      imageModel('wanx2.1-t2i-turbo', 'Wanxiang 2.1 Turbo', false),
      imageModel('wanx2.1-t2i-plus', 'Wanxiang 2.1 Plus', false),
      ttsModel('cosyvoice-v2', 'CosyVoice v2'),
    ],
  },

  {
    id: 'minimax',
    label: 'MiniMax',
    tagline: 'abab · 语音克隆 · 视频生成',
    baseUrl: 'https://api.minimax.chat/v1',
    region: 'china',
    brandColor: '#f8b333',
    authHint: 'https://platform.minimaxi.com · 格式 JWT',
    docsUrl: 'https://platform.minimaxi.com/document',
    capabilities: [
      cap('chat', 'minimax'),
      cap('tts', 'minimax-tts'),
      cap('video', 'minimax-video'),
    ],
    commonModels: [
      chatModel('abab7-preview', 'abab7 Preview', 245000),
      chatModel('abab6.5s-chat', 'abab 6.5s', 245000),
      ttsModel('speech-01-turbo', 'Speech-01 Turbo'),
      ttsModel('speech-01-hd', 'Speech-01 HD'),
    ],
  },

  {
    id: 'opencode',
    label: 'opencode Zen',
    tagline: '一个 key 通 deepseek · glm · kimi · qwen · minimax 等多家模型',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    region: 'global',
    /* 取自 apple-touch-icon 的底色 —— 不是从截图里那颗橙星猜的 (那颗其实是
     * anthropic 的图标, 正是这一轮修掉的"协议猜品牌"bug 的产物)。 */
    brandColor: '#141414',
    authHint: 'https://opencode.ai/auth · 格式 sk-...',
    docsUrl: 'https://opencode.ai/docs',
    capabilities: [cap('chat', 'openai')],
    commonModels: [
      chatModel('deepseek-v4-pro', 'DeepSeek V4 Pro'),
      chatModel('deepseek-v4-flash', 'DeepSeek V4 Flash'),
      chatModel('deepseek-v4-flash-vision-exp', 'DeepSeek V4 Flash Vision'),
      chatModel('glm-5.3', 'GLM-5.3'),
      chatModel('glm-5.3-flash', 'GLM-5.3 Flash'),
      chatModel('glm-5.2', 'GLM-5.2'),
      chatModel('kimi-k3', 'Kimi K3'),
      chatModel('kimi-k2.7-code', 'Kimi K2.7 Code'),
      chatModel('qwen3.8-max', 'Qwen 3.8 Max'),
      chatModel('qwen3.8-flash', 'Qwen 3.8 Flash'),
      chatModel('qwen3.7-max', 'Qwen 3.7 Max'),
      chatModel('minimax-m3', 'MiniMax M3'),
      chatModel('hy4-preview', '混元 HY4 Preview'),
      chatModel('mimo-v2.5', 'MiMo v2.5'),
      chatModel('mimo-v2.5-pro', 'MiMo v2.5 Pro'),
      chatModel('longcat-2.0', 'LongCat 2.0'),
      chatModel('omen-alpha', 'Omen Alpha'),
    ],
  },
];

// ============================================================================
// Helpers
// ============================================================================

export function getPresetById(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find(p => p.id === id);
}

export function getPresetsByRegion(region: 'global' | 'china'): ProviderPreset[] {
  return PROVIDER_PRESETS.filter(p => p.region === region);
}

/** 建议 preset 排序 (推荐 provider 靠前). UI 卡片列表用. */
export const RECOMMENDED_PRESET_ORDER: string[] = [
  'openrouter', /* 一个 key 通吃, 推荐首选 */
  'opencode',   /* 同为聚合网关, 紧随其后 */
  'openai',
  'anthropic',
  'gemini',
  'grok',
  'doubao',
  'deepseek',
  'glm',
  'kimi',
  'dashscope',
  'mistral',
  'groq',
  'together',
  'minimax',
];

export function getPresetsInRecommendedOrder(): ProviderPreset[] {
  const byId = new Map(PROVIDER_PRESETS.map(p => [p.id, p]));
  const seen = new Set<string>();
  const out: ProviderPreset[] = [];
  for (const id of RECOMMENDED_PRESET_ORDER) {
    const p = byId.get(id);
    if (p) { out.push(p); seen.add(id); }
  }
  for (const p of PROVIDER_PRESETS) {
    if (!seen.has(p.id)) out.push(p);
  }
  return out;
}
