/**
 * providerCapabilities — Provider 多能力模型 · 兼容层 + resolver.
 *
 * 老 config (protocol: 'openai') 缺 capabilities[] → runtime 推一条 chat 能力兜底.
 * 新 config 显式列 capabilities[] → 直接用.
 * services (imageGenService/ttsService/chat runtime) 通过 resolveProviderForModality
 * 查"谁能做这件事", 不再 hardcode "provider.protocol === 'openai-images'".
 */

import type {
  Modality,
  ProviderCapability,
  ProviderConfigEntry,
  ProviderModelConfig,
  ProviderProtocol,
} from '../types/configTypes.js';

// ============================================================================
// Protocol → Modality 推断 (老 config 兜底)
// ============================================================================

/** 主 protocol 对应的默认 modality. 缺 capabilities 时用这一条兜底. */
const PROTOCOL_MODALITY: Record<ProviderProtocol, Modality[]> = {
  'openai':            ['chat'],
  'openai-responses':  ['chat'],
  'openai-images':     ['image', 'image-edit'],
  'openai-tts':        ['tts'],
  'openai-stt':        ['stt'],
  'openai-embedding':  ['embedding'],
  'anthropic':         ['chat'],
  'anthropic-openai':  ['chat'],
  'doubao':            ['chat'],
  'doubao-images':     ['image'],
  'doubao-tts':        ['tts'],
  'gemini':            ['chat'],
  'gemini-images':     ['image', 'image-edit'],
  'grok':              ['chat'],
  'grok-images':       ['image'],
  'kimi':              ['chat'],
  'deepseek':          ['chat'],
  'minimax':           ['chat'],
  'minimax-tts':       ['tts'],
  'minimax-video':     ['video'],
  'qwen':              ['chat'],
  'qwen-images':       ['image', 'image-edit'],
  'dashscope-tts':     ['tts'],
  'glm':               ['chat'],
  'glm-claude':        ['chat'],
  'glm-images':        ['image'],
  'kimi-claude':       ['chat'],
  'openrouter':        ['chat'],
  'openrouter-images': ['image', 'image-edit'],
  'mistral':           ['chat'],
  'groq':              ['chat'],
  'together':          ['chat'],
};

/** 默认 endpoint 路径 (相对 baseUrl). 无 capability.endpoint 时用. */
const PROTOCOL_ENDPOINT: Partial<Record<ProviderProtocol, string>> = {
  'openai':            '/chat/completions',
  'openai-responses':  '/responses',
  'openai-images':     '/images/generations',
  'openai-tts':        '/audio/speech',
  'openai-stt':        '/audio/transcriptions',
  'openai-embedding':  '/embeddings',
  'anthropic':         '/messages',
  'anthropic-openai':  '/chat/completions',
  'doubao':            '/chat/completions',
  'doubao-images':     '/images/generations',
  'doubao-tts':        '/audio/speech',
  'gemini':            '/models',
  'gemini-images':     '/models',
  'grok':              '/chat/completions',
  'grok-images':       '/images/generations',
  'kimi':              '/chat/completions',
  'deepseek':          '/chat/completions',
  'minimax':           '/chat/completions',
  'minimax-tts':       '/t2a_v2',
  'minimax-video':     '/video_generation',
  'qwen':              '/chat/completions',
  'qwen-images':       '/services/aigc/text2image/image-synthesis',
  'dashscope-tts':     '/services/audio/tts',
  'glm':               '/chat/completions',
  'glm-claude':        '/messages',
  'glm-images':        '/images/generations',
  'kimi-claude':       '/messages',
  'openrouter':        '/chat/completions',
  'openrouter-images': '/images', /* OpenRouter 图像专用端点是 /api/v1/images, 不是 /images/generations */
  'mistral':           '/chat/completions',
  'groq':              '/chat/completions',
  'together':          '/chat/completions',
};

// ============================================================================
// 兼容层: 从老 config 派生 capabilities
// ============================================================================

/** 老 config 没 capabilities 时的兜底 — 从主 protocol 推一条 modality 能力. */
export function deriveCapabilitiesFromProtocol(protocol: ProviderProtocol): ProviderCapability[] {
  const mods = PROTOCOL_MODALITY[protocol] ?? ['chat'];
  return mods.map(m => ({
    modality: m,
    protocol,
    endpoint: PROTOCOL_ENDPOINT[protocol],
    enabled: true,
  }));
}

/** modality → 默认 endpoint (从 models 补出的能力用). image 在 OpenRouter 上是 /images. */
const MODALITY_DEFAULT_ENDPOINT: Partial<Record<Modality, string>> = {
  chat: '/chat/completions',
  image: '/images/generations',
  'image-edit': '/images/edits',
  tts: '/audio/speech',
  stt: '/audio/transcriptions',
  embedding: '/embeddings',
  rerank: '/rerank',
};

/**
 * 从 provider.models 里出现的 modality 补出能力条目.
 * 场景: OpenRouter provider 主 protocol 是 openrouter(=chat), 但用户挂了 gpt-image-2 图像模型 —
 * 光看 protocol 会漏掉 image 能力, 导致 imageGenService 找不到 provider. 这里按实际挂载的模型补齐.
 */
function deriveCapabilitiesFromModels(p: ProviderConfigEntry, covered: Set<Modality>): ProviderCapability[] {
  const isOpenRouter = (p.baseUrl || '').toLowerCase().includes('openrouter.ai') || p.protocol === 'openrouter';
  const extra: ProviderCapability[] = [];
  const seen = new Set<Modality>(covered);
  for (const m of p.models || []) {
    for (const mod of getEffectiveModelModalities(m)) {
      if (mod === 'chat' || seen.has(mod)) continue;
      seen.add(mod);
      const endpoint = isOpenRouter && (mod === 'image' || mod === 'image-edit')
        ? '/images'
        : MODALITY_DEFAULT_ENDPOINT[mod];
      extra.push({ modality: mod, protocol: p.protocol, endpoint, enabled: true });
    }
  }
  return extra;
}

/** 拿一个 provider 的 effective capabilities —— 现从 Tab 派生 (每 Tab 按其协议覆盖的 modality 各一条),
 *  再叠加老 capabilities[] (未被 Tab 覆盖的) + 挂载 image 模型补齐。imageGenService/tts 走这个查上游。 */
export function getEffectiveCapabilities(p: ProviderConfigEntry): ProviderCapability[] {
  const tabs = getProviderTabs(p);
  const fromTabs: ProviderCapability[] = tabs.flatMap(t =>
    (PROTOCOL_MODALITY[t.protocol] ?? ['chat']).map((m) => ({
      modality: m,
      protocol: t.protocol,
      endpoint: PROTOCOL_ENDPOINT[t.protocol],
      models: t.models,
      baseUrl: t.baseUrl,
      enabled: true,
    } as ProviderCapability)),
  );
  const covered = new Set<Modality>(fromTabs.map(c => c.modality));
  const legacy = (p.capabilities ?? []).filter(c => c.enabled !== false && !covered.has(c.modality));
  legacy.forEach(c => covered.add(c.modality));
  const fromModels = deriveCapabilitiesFromModels(p, covered);
  return [...fromTabs, ...legacy, ...fromModels];
}

/** provider 是否具备指定 modality (支持 image / tts / stt / embedding / chat / video). */
export function hasCapability(p: ProviderConfigEntry, modality: Modality): boolean {
  return getEffectiveCapabilities(p).some(c => c.modality === modality);
}

/** 这个 provider 是否**显式声明**了某个模型 (models[] 或任一 Tab 的 models[])。 */
export function providerDeclaresModel(p: ProviderConfigEntry, model: string): boolean {
  if (!model) return false;
  const want = model.toLowerCase();
  const hit = (id?: string) => !!id && id.toLowerCase() === want;
  if ((p.models ?? []).some(m => hit((m as { id?: string; name?: string }).id)
    || hit((m as { id?: string; name?: string }).name))) return true;
  return (p.channels ?? []).some(ch => (ch.models ?? []).some(hit));
}

/** 按 modality 选择 provider；显式声明请求模型的 provider 优先，否则回退到首个匹配项。 */
export function resolveProviderForModality(
  providers: Iterable<ProviderConfigEntry>,
  modality: Modality,
  model?: string,
): ProviderConfigEntry | undefined {
  const capable: ProviderConfigEntry[] = [];
  for (const p of providers) {
    if (!hasCapability(p, modality)) continue;
    if (model && providerDeclaresModel(p, model)) return p;
    capable.push(p);
  }
  return capable[0];
}

/** 找具体 modality 对应的 capability 项 (含 protocol + endpoint) — service 拼 URL 时用. */
export function resolveCapability(
  p: ProviderConfigEntry,
  modality: Modality,
): ProviderCapability | undefined {
  return getEffectiveCapabilities(p).find(c => c.modality === modality);
}

/** protocol → 主 modality (Tab 服务哪类)。 */
export function modalityOfProtocol(protocol: ProviderProtocol): Modality {
  return (PROTOCOL_MODALITY[protocol] ?? ['chat'])[0];
}

/** 一个 provider 的有效 Tab 列表: channels[] 优先; 否则从扁平字段合成单 Tab (向后兼容, 老配置)。 */
export function getProviderTabs(p: ProviderConfigEntry): import('../types/configTypes.js').ProviderChannel[] {
  if (p.channels && p.channels.length > 0) return p.channels;
  return [{ apiKey: p.apiKey, protocol: p.protocol, baseUrl: p.baseUrl, urlSuffix: p.urlSuffix }];
}

/* 多同类 Tab 轮换 (多 key): key 为 `${providerId}:${modality}` 的计数, 每次解析轮换。 */
const _tabRotation = new Map<string, number>();

/**
 * Tab 解析 (v2): 给定 (model, modality) → 挑一个 Tab, 返回其 协议 + key + 地址。
 *   ① models[] 命中该 model 的 Tab (可多条同协议 → 轮换分摊) → ② 无 models 的 catch-all (可多条 → 轮换)
 *   → ③ chat 兜底主 Tab (加了限定 Tab 后其余模型仍走主协议, 不误路由)。
 *   老 provider (单 Tab) → 逐字返回今天的 协议/key/地址, 零行为变化。
 */
export function resolveChannel(
  p: ProviderConfigEntry,
  opts: { model?: string; modality?: Modality } = {},
): import('../types/configTypes.js').ResolvedChannel {
  const modality: Modality = opts.modality ?? 'chat';
  const tabs = getProviderTabs(p);
  const serves = tabs.filter(t => (PROTOCOL_MODALITY[t.protocol] ?? ['chat']).includes(modality));
  const model = opts.model;

  const pick = (cands: import('../types/configTypes.js').ProviderChannel[]) => {
    if (cands.length === 1) return cands[0];
    const key = `${p.id}:${modality}:${cands.map(c => c.protocol).join(',')}`;
    const n = _tabRotation.get(key) ?? 0;
    _tabRotation.set(key, n + 1);
    return cands[n % cands.length];
  };

  /* ① 限定该 model 的 Tab (同 protocol 多条 = 多 key 轮换)。 */
  const byModel = model ? serves.filter(t => t.models?.length && t.models.includes(model)) : [];
  /* ② 无 models 限制的 catch-all Tab。 */
  const catchAll = serves.filter(t => !t.models?.length);
  const chosen = byModel.length ? pick(byModel) : (catchAll.length ? pick(catchAll) : undefined);
  if (chosen) {
    return { protocol: chosen.protocol, apiKey: chosen.apiKey, baseUrl: chosen.baseUrl, urlSuffix: chosen.urlSuffix };
  }
  /* ③ 该 modality 没 catch-all Tab: chat 回主 Tab; 其它 modality 有 Tab 用第一条, 否则回 provider 主字段。 */
  if (modality === 'chat') {
    const t0 = tabs[0];
    return { protocol: t0.protocol, apiKey: t0.apiKey, baseUrl: t0.baseUrl, urlSuffix: t0.urlSuffix };
  }
  if (serves.length > 0) {
    const t = serves[0];
    return { protocol: t.protocol, apiKey: t.apiKey, baseUrl: t.baseUrl, urlSuffix: t.urlSuffix };
  }
  return { protocol: p.protocol, apiKey: p.apiKey };
}

// ============================================================================
// Model modality 推断 (从 model name 猜, model.modalities 未标时兜底)
// ============================================================================

/** 一些模型 name 到 modality 的启发式映射. UI 至少可以在缺元数据时显示合理的类型徽章. */
const MODEL_NAME_MODALITY_HINTS: Array<{ pattern: RegExp; modalities: Modality[] }> = [
  /* OpenAI 图像家族: 裸 gpt-image-1/2, 带 vendor 前缀 openai/gpt-image-2, 以及 gpt-5-image /
   * gpt-5.4-image-2 这类 gpt-<版本>-image 命名. 不锚定 ^, 否则 openai/ 前缀会顶掉匹配. */
  { pattern: /gpt-image|gpt-[\d.]+-image/i,    modalities: ['image', 'image-edit'] },
  { pattern: /^dall-e/i,                       modalities: ['image'] },
  { pattern: /flux/i,                          modalities: ['image'] },
  { pattern: /stable-diffusion|sd-xl|sdxl/i,   modalities: ['image'] },
  { pattern: /recraft/i,                       modalities: ['image'] },
  { pattern: /riverflow/i,                     modalities: ['image', 'image-edit'] },
  { pattern: /mai-image/i,                     modalities: ['image'] },
  { pattern: /grok.*image/i,                   modalities: ['image'] },
  { pattern: /seedream|doubao.*image/i,        modalities: ['image', 'image-edit'] },
  { pattern: /cogview/i,                       modalities: ['image'] },
  { pattern: /nano.?banana|imagen|gemini.*image/i, modalities: ['image', 'image-edit'] },
  { pattern: /wanx|tongyi.*wanxiang/i,         modalities: ['image'] },
  { pattern: /^tts-|whisper|cosyvoice|edge-tts/i, modalities: ['tts'] },
  { pattern: /^whisper|speech.recognition|paraformer/i, modalities: ['stt'] },
  { pattern: /^text-embedding|bge-|voyage-|embedding-/i, modalities: ['embedding'] },
  { pattern: /^rerank/i,                       modalities: ['rerank'] },
  { pattern: /veo|sora|seedance|kling.*video/i, modalities: ['video'] },
];

/** 拿一个 model 的 effective modalities (声明的优先, 否则按 name 启发式, 兜底 chat). */
export function getEffectiveModelModalities(m: ProviderModelConfig): Modality[] {
  if (m.modalities && m.modalities.length > 0) return m.modalities;
  for (const rule of MODEL_NAME_MODALITY_HINTS) {
    if (rule.pattern.test(m.name)) return rule.modalities;
  }
  return ['chat'];
}

/** 是否是图像模型 (含 image 或 image-edit). UI 图片模式模型下拉用. */
export function isImageModel(m: ProviderModelConfig): boolean {
  const mods = getEffectiveModelModalities(m);
  return mods.includes('image') || mods.includes('image-edit');
}

/** 是否支持编辑 (图生图 / inpaint). UI"再改一下"按钮显隐用. */
export function supportsImageEdit(m: ProviderModelConfig): boolean {
  return getEffectiveModelModalities(m).includes('image-edit');
}

/** 是否支持视觉输入 (image → text). Chat 模式判定"能不能上传图给它看"用. */
export function acceptsImageInput(m: ProviderModelConfig): boolean {
  return m.input?.includes('image') ?? false;
}
