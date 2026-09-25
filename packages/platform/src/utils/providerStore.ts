import {
  NeoxConfig,
  ProviderConfigEntry,
  ProviderChannel,
  ProviderModelConfig,
  ProviderProtocol,
  loadConfig,
  saveConfig,
} from './config.js';
import { NeoxError, ErrorCategory } from '@neoxlabs/kernel/types/errors.js';
import { wrapApiKey, unwrapApiKey, isWrappedApiKey, isNeoxManagedApiKey } from './apiKeyCrypto.js';

/* providerStore 抛错助手 — 一律走 NeoxError({code:'config.xxx'}) 而非 raw Error,
 *   让 UI toast 能按 code 路由 i18n (现版本 message 含具体名优先, future i18n 可补 placeholder). */
function configError(code: string, message: string): NeoxError {
  return new NeoxError({
    category: ErrorCategory.FATAL_INVALID,
    code,
    message,
    retryable: false,
  });
}

const DEFAULT_BASE_URL: Record<ProviderProtocol, string> = {
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
  'doubao-tts': 'https://openspeech.bytedance.com',
  gemini: 'https://generativelanguage.googleapis.com',
  'gemini-images': 'https://generativelanguage.googleapis.com/v1beta',
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



export interface CreateProviderInput {
  id?: string;
  name: string;
  protocol: ProviderProtocol;
  apiKey: string;
  /** Tab/channels: 每 Tab {apiKey, protocol, models?, baseUrl?} (明文 key, store 落盘前 wrap)。空/单 = 单 Tab。 */
  channels?: ProviderChannel[];
  baseUrl?: string;
  urlSuffix?: string;
  defaultModel?: string;
  models?: Array<string | ProviderModelConfig>;
  setAsDefault?: boolean;
  maxTokens?: number;
  maxInputTokens?: number;
  /** Anthropic 身份策略 (auto/on/off), 仅 protocol='anthropic' 生效. */
  claudeCodeMode?: 'auto' | 'on' | 'off';
  /** 关联 preset id (openai/openrouter/anthropic/...). 用于 UI 显 badge + 未来 preset 升级路径. */
  presetId?: string;
  /** 图生图 (edit) 载荷格式 (协议层, 非 OpenRouter). 'images-array' (默认) | 'image-field'. */
  imageEditFormat?: 'images-array' | 'image-field';
  injectCodexPrompt?: boolean;
  capabilities?: import('@neoxlabs/kernel/types/configTypes.js').ProviderCapability[];
  /** 额外 headers — OpenRouter 需 HTTP-Referer + X-Title. */
  extraHeaders?: Record<string, string>;
  /** 品牌 icon URL / data URL — preset 自带, 用户手动加时留空. */
  iconUrl?: string;
}

export interface UpdateProviderInput {
  name?: string;
  protocol?: ProviderProtocol;
  apiKey?: string;
  /** Tab/channels: 传数组整批替换 (明文 key); 不传保留原有。 */
  channels?: ProviderChannel[];
  baseUrl?: string;
  urlSuffix?: string;
  defaultModel?: string;
  maxTokens?: number;
  maxInputTokens?: number;
  /* 整批替换 models — Neox Cloud sync 用. 不传则保留原有列表.
   * 用 string[] 时, store 自己补 createdAt; 用对象列表时直接复用. */
  models?: Array<string | ProviderModelConfig>;
  /** Anthropic 身份策略 (auto/on/off), 仅 protocol='anthropic' 生效. */
  claudeCodeMode?: 'auto' | 'on' | 'off';
  presetId?: string;
  capabilities?: import('@neoxlabs/kernel/types/configTypes.js').ProviderCapability[];
  extraHeaders?: Record<string, string>;
  iconUrl?: string;
  imageEditFormat?: 'images-array' | 'image-field';
  injectCodexPrompt?: boolean;
}

export class ProviderStore {
  private config: NeoxConfig;

  constructor(config?: NeoxConfig) {
    const loadedFromDisk = config === undefined;
    this.config = config ?? loadConfig();
    if (!this.config.providers) {
      this.config.providers = {};
    }
    let migrated = false;
    for (const [id, provider] of Object.entries(this.config.providers)) {
      const stored = String(provider?.apiKey ?? '');
      if (stored && !isWrappedApiKey(stored) && !isNeoxManagedApiKey(stored)) {
        this.config.providers[id] = { ...provider, apiKey: wrapApiKey(stored) };
        migrated = true;
      }
    }
    if (migrated && loadedFromDisk) {
      try { saveConfig(this.config); } catch (err) {
        /* migration 是 best-effort, 不阻塞. 下次启动仍会尝试 (幂等). */
        console.warn('[providerStore] apiKey migration persist failed:', (err as Error).message);
      }
    }
  }

  /** 返回一个 apiKey (+ channels 每 Tab 的 key) 已解密的 provider 副本 (公开 API). */
  private unwrapProviderCopy(raw: ProviderConfigEntry | undefined): ProviderConfigEntry | undefined {
    if (!raw) return undefined;
    return {
      ...raw,
      apiKey: unwrapApiKey(raw.apiKey),
      ...(raw.channels ? { channels: raw.channels.map(ch => ({ ...ch, apiKey: unwrapApiKey(ch.apiKey) })) } : {}),
    };
  }

  /** Tab/channels 落盘: 每 Tab 的 key wrap 加密; 去掉无 key/无协议的 Tab。空则返 undefined (不落字段, = 单 Tab)。 */
  private wrapChannels(channels: ProviderChannel[] | undefined): ProviderChannel[] | undefined {
    if (!channels || !channels.length) return undefined;
    const cleaned = channels
      .filter(c => c && typeof c.apiKey === 'string' && c.apiKey.trim() && c.protocol)
      .map(c => ({ ...c, apiKey: wrapApiKey(c.apiKey.trim()) }));
    return cleaned.length ? cleaned : undefined;
  }

  /** 内部用: 返回 config.providers 里 raw entry (apiKey 仍是 wrapped/sentinel). */
  private getProviderRaw(id: string | undefined | null): ProviderConfigEntry | undefined {
    if (!id) return undefined;
    return this.config.providers?.[id];
  }

  private sanitizeId(value: string): string {
    return value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 48);
  }

  private ensureValidId(value: string): string {
    const sanitized = this.sanitizeId(value);
    if (!sanitized) {
      throw configError('config.invalid_id', 'Provider ID must contain letters or numbers (allowed: lowercase letters, numbers, hyphen).');
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(sanitized)) {
      throw configError('config.invalid_id', 'Provider ID can only include lowercase letters, numbers, and hyphen.');
    }
    return sanitized;
  }

  private slugifyName(name: string): string {
    const base = this.sanitizeId(name);
    return base || 'provider';
  }

  private ensureProviderId(id?: string, name?: string): string {
    const chosen = id || this.slugifyName(name || 'provider');
    if (!this.config.providers) {
      this.config.providers = {};
    }
    if (!this.config.providers[chosen]) {
      return chosen;
    }
    let suffix = 2;
    let candidate = `${chosen}-${suffix}`;
    while (this.config.providers[candidate]) {
      suffix += 1;
      candidate = `${chosen}-${suffix}`;
    }
    return candidate;
  }

  private persist(): void {
    saveConfig(this.config);
  }

  // Provider configuration is now handled by CLI's ensureProviderConfigured() in main.ts
  // No longer bootstrap from environment variables

  getProviderCount(): number {
    return Object.keys(this.config.providers || {}).length;
  }

  getProviders(): ProviderConfigEntry[] {
    return Object.values(this.config.providers || {})
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(p => this.unwrapProviderCopy(p)!);
  }

  getProvider(id: string | undefined | null): ProviderConfigEntry | undefined {
    return this.unwrapProviderCopy(this.getProviderRaw(id));
  }

  getDefaultProvider(): ProviderConfigEntry | undefined {
    if (this.config.defaultProviderId) {
      const provider = this.getProvider(this.config.defaultProviderId);
      if (provider) {
        return provider;
      }
    }

    const [first] = this.getProviders();
    if (first) {
      this.config.defaultProviderId = first.id;
      this.persist();
    }
    return first;
  }

  setDefaultProvider(id: string): ProviderConfigEntry {
    const provider = this.getProvider(id);
    if (!provider) {
      throw configError("config.provider_not_found", `Provider "${id}" does not exist.`);
    }
    this.config.defaultProviderId = id;
    this.persist();
    return provider;
  }

  addProvider(input: CreateProviderInput): ProviderConfigEntry {
    if (!input.name.trim()) {
      throw configError("config.field_required", 'Provider name is required.');
    }
    if (!input.apiKey.trim()) {
      throw configError("config.field_required", 'Provider API key/token is required.');
    }

    const id = this.ensureProviderId(input.id, input.name);
    const timestamp = new Date().toISOString();
    const baseUrl = input.baseUrl?.trim() || DEFAULT_BASE_URL[input.protocol];
    let modelEntries = (input.models || []).map((model) => {
      if (typeof model === 'string') {
        return { name: model, createdAt: timestamp } as ProviderModelConfig;
      }
      return { ...model, createdAt: model.createdAt || timestamp };
    });

    const provider: ProviderConfigEntry = {
      id,
      name: input.name.trim(),
      protocol: input.protocol,
      apiKey: wrapApiKey(input.apiKey.trim()),
      channels: this.wrapChannels(input.channels),
      baseUrl,
      urlSuffix: input.urlSuffix,
      maxTokens: input.maxTokens,
      maxInputTokens: input.maxInputTokens,
      models: modelEntries,
      defaultModel: input.defaultModel || modelEntries[0]?.name,
      lastSelectedModel: input.defaultModel || modelEntries[0]?.name,
      createdAt: timestamp,
      updatedAt: timestamp,
      /* claudeCodeMode 只对 anthropic 有语义; 其它 protocol 就算传了也存起来无害 (provider
       *   构造时非 anthropic 根本不读). undefined 视作 'auto' 保持老配置兼容. */
      claudeCodeMode: input.claudeCodeMode,
      presetId: input.presetId,
      capabilities: input.capabilities,
      extraHeaders: input.extraHeaders,
      iconUrl: input.iconUrl,
      imageEditFormat: input.imageEditFormat,
      injectCodexPrompt: input.injectCodexPrompt,
    };

    const isNeoxManaged = provider.id === 'neox-cloud'
      || (input.apiKey ?? '').trim() === 'neox-managed';
    if (!provider.defaultModel && !isNeoxManaged) {
      throw configError("config.empty_models", 'At least one model is required when creating a provider.');
    }

    if (!this.config.providers) {
      this.config.providers = {};
    }
    this.config.providers[id] = provider;

    if (!this.config.defaultProviderId || input.setAsDefault) {
      this.config.defaultProviderId = id;
    }

    this.persist();
    /* 返 unwrapped 副本 (公开 API 语义: apiKey 是明文). */
    return this.unwrapProviderCopy(provider)!;
  }

  updateProvider(id: string, updates: UpdateProviderInput): ProviderConfigEntry {
    const existingRaw = this.getProviderRaw(id);
    if (!existingRaw) {
      throw configError("config.provider_not_found", `Provider "${id}" does not exist.`);
    }
    const timestamp = new Date().toISOString();
    /* models 字段单独处理 — string[] / 对象列表 都规整成 ProviderModelConfig[];
     * 必须在展开前剥掉, 否则 spread 会把 string[] 直接灌进 next.models 把后续校验搞崩. */
    /* channels 也必须剥掉 — 否则 ...rest 会把明文 Tab key 灌进 next 覆盖已 wrap 的存量 (泄漏明文)。 */
    const { models: incomingModels, channels: incomingChannels, ...rest } = updates;
    const next: ProviderConfigEntry = {
      ...existingRaw,
      ...rest,
      baseUrl: updates.baseUrl?.trim() || existingRaw.baseUrl || DEFAULT_BASE_URL[existingRaw.protocol],
      urlSuffix: updates.urlSuffix !== undefined ? updates.urlSuffix : existingRaw.urlSuffix,
      apiKey: updates.apiKey?.trim() ? wrapApiKey(updates.apiKey.trim()) : existingRaw.apiKey,
      /* Tab/channels: 传了整批替换 (每 Tab key wrap); 没传保留存量 raw (仍 wrapped)。 */
      channels: incomingChannels !== undefined
        ? this.wrapChannels(incomingChannels)
        : existingRaw.channels,
      maxTokens: updates.maxTokens !== undefined ? updates.maxTokens : existingRaw.maxTokens,
      maxInputTokens: updates.maxInputTokens !== undefined ? updates.maxInputTokens : existingRaw.maxInputTokens,
      updatedAt: timestamp,
    };
    const existing = existingRaw; /* alias for code below that references existing.protocol / existing.models */
    if (updates.protocol && updates.protocol !== existing.protocol) {
      next.protocol = updates.protocol;
      if (!updates.baseUrl) {
        next.baseUrl = DEFAULT_BASE_URL[updates.protocol];
      }
    }
    if (incomingModels !== undefined) {
      /* 保留旧条目的 createdAt, 新增模型补当前时间 — sync 时 dropdown 排序按 createdAt 稳定. */
      const existingByName = new Map(existing.models.map(m => [m.name, m]));
      next.models = incomingModels.map(m => {
        if (typeof m === 'string') {
          return existingByName.get(m) ?? ({ name: m, createdAt: timestamp } as ProviderModelConfig);
        }
        return { ...m, createdAt: m.createdAt || existingByName.get(m.name)?.createdAt || timestamp };
      });
    }
    if (updates.defaultModel) {
      const hasModel = next.models.some((m) => m.name === updates.defaultModel);
      if (!hasModel) {
        throw configError("config.model_not_found", `Model "${updates.defaultModel}" does not exist for provider "${id}".`);
      }
      next.defaultModel = updates.defaultModel;
      next.lastSelectedModel = updates.defaultModel;
    } else if (incomingModels !== undefined && !next.models.some(m => m.name === next.defaultModel)) {
      /* 老 defaultModel 已被新 models 列表淘汰 — 默认指向第一个新模型. */
      next.defaultModel = next.models[0]?.name ?? next.defaultModel;
      next.lastSelectedModel = next.defaultModel;
    }

    this.config.providers![id] = next;
    this.persist();
    /* 返 unwrapped 副本, 让 caller 拿到明文 apiKey. */
    return this.unwrapProviderCopy(next)!;
  }

  renameProvider(currentId: string, desiredId: string): ProviderConfigEntry {
    const existingRaw = this.getProviderRaw(currentId);
    if (!existingRaw) {
      throw configError("config.provider_not_found", `Provider "${currentId}" does not exist.`);
    }
    const normalized = this.ensureValidId(desiredId);
    if (normalized === currentId) {
      return this.unwrapProviderCopy(existingRaw)!;
    }
    if (this.config.providers?.[normalized]) {
      throw configError("config.provider_exists", `Provider ID "${normalized}" already exists.`);
    }

    delete this.config.providers![currentId];
    const timestamp = new Date().toISOString();
    const renamed: ProviderConfigEntry = {
      ...existingRaw,
      id: normalized,
      updatedAt: timestamp,
    };
    this.config.providers![normalized] = renamed;

    /* renamed.apiKey 已是 wrapped (从 existingRaw 继承), 无需再 wrap. */

    if (this.config.defaultProviderId === currentId) {
      this.config.defaultProviderId = normalized;
    }

    this.persist();
    return this.unwrapProviderCopy(renamed)!;
  }

  deleteProvider(id: string): void {
    if (!this.config.providers?.[id]) {
      throw configError("config.provider_not_found", `Provider "${id}" does not exist.`);
    }
    delete this.config.providers[id];
    if (this.config.defaultProviderId === id) {
      this.config.defaultProviderId = undefined;
    }
    this.persist();
  }

  addModel(
    providerId: string,
    modelName: string,
    makeDefault = false,
    modelConfig?: Partial<ProviderModelConfig>
  ): ProviderConfigEntry {
    const provider = this.getProviderRaw(providerId);
    if (!provider) {
      throw configError("config.provider_not_found", `Provider "${providerId}" does not exist.`);
    }
    const normalized = modelName.trim();
    if (!normalized) {
      throw configError("config.field_required", 'Model name cannot be empty.');
    }
    const existing = provider.models.find((model) => model.name === normalized);
    if (existing) {
      const merged: ProviderConfigEntry = {
        ...provider,
        models: provider.models.map((model) =>
          model.name === normalized ? { ...model, ...modelConfig } : model,
        ),
        updatedAt: new Date().toISOString(),
      };
      if (makeDefault) {
        merged.defaultModel = normalized;
        merged.lastSelectedModel = normalized;
      }
      this.config.providers![providerId] = merged;
      this.persist();
      /* 跟正常路径同样返回**解密后的副本** —— 直接回 merged 会把密文 apiKey 交出去 */
      return this.unwrapProviderCopy(merged)!;
    }

    const updated: ProviderConfigEntry = {
      ...provider,
      models: [
        ...provider.models,
        {
          name: normalized,
          createdAt: new Date().toISOString(),
          ...modelConfig,
        },
      ],
      updatedAt: new Date().toISOString(),
    };

    if (!provider.defaultModel || makeDefault) {
      updated.defaultModel = normalized;
      updated.lastSelectedModel = normalized;
    }

    this.config.providers![providerId] = updated;
    this.persist();
    return this.unwrapProviderCopy(updated)!;
  }

  removeModel(providerId: string, modelName: string): ProviderConfigEntry {
    const provider = this.getProviderRaw(providerId);
    if (!provider) {
      throw configError("config.provider_not_found", `Provider "${providerId}" does not exist.`);
    }
    if (provider.models.length <= 1) {
      throw configError("config.empty_models", 'A provider must have at least one model.');
    }

    const remaining = provider.models.filter((model) => model.name !== modelName);
    if (remaining.length === provider.models.length) {
      throw configError("config.model_not_found", `Model "${modelName}" does not exist for provider "${providerId}".`);
    }

    const updated: ProviderConfigEntry = {
      ...provider,
      models: remaining,
      updatedAt: new Date().toISOString(),
    };

    if (provider.defaultModel === modelName) {
      updated.defaultModel = remaining[0].name;
    }
    if (provider.lastSelectedModel === modelName) {
      updated.lastSelectedModel = updated.defaultModel;
    }

    this.config.providers![providerId] = updated;
    this.persist();
    return this.unwrapProviderCopy(updated)!;
  }

  updateModelConfig(
    providerId: string,
    modelName: string,
    updates: Partial<Omit<ProviderModelConfig, 'name' | 'createdAt'>>
  ): ProviderConfigEntry {
    const provider = this.getProviderRaw(providerId);
    if (!provider) {
      throw configError("config.provider_not_found", `Provider "${providerId}" does not exist.`);
    }

    const modelIndex = provider.models.findIndex((m) => m.name === modelName);
    if (modelIndex === -1) {
      throw configError("config.model_not_found", `Model "${modelName}" does not exist for provider "${providerId}".`);
    }

    const updatedModels = [...provider.models];
    updatedModels[modelIndex] = {
      ...updatedModels[modelIndex],
      ...updates,
    };

    const updated: ProviderConfigEntry = {
      ...provider,
      models: updatedModels,
      updatedAt: new Date().toISOString(),
    };

    this.config.providers![providerId] = updated;
    this.persist();
    return this.unwrapProviderCopy(updated)!;
  }

  setLastSelectedModel(providerId: string, modelName: string): ProviderConfigEntry {
    const provider = this.getProviderRaw(providerId);
    if (!provider) {
      throw configError("config.provider_not_found", `Provider "${providerId}" does not exist.`);
    }
    /* sentinel 'neox-cloud' models[] 永远空 (订阅 model 从 membership/me 现拉, 不进 store),
     * 校验会误抛 model_not_found — 跳过校验只更新 lastSelectedModel 字段. */
    const isSentinel = provider.id === 'neox-cloud'
      || (provider.apiKey ?? '').trim() === 'neox-managed';
    if (!isSentinel) {
      const exists = provider.models.some((model) => model.name === modelName);
      if (!exists) {
        throw configError("config.model_not_found", `Model "${modelName}" does not exist for provider "${providerId}".`);
      }
    }
    provider.lastSelectedModel = modelName;
    provider.updatedAt = new Date().toISOString();
    this.config.providers![providerId] = provider;
    this.persist();
    return this.unwrapProviderCopy(provider)!;
  }

  resolveModel(providerId: string, requested?: string): string | undefined {
    const provider = this.getProviderRaw(providerId);
    if (!provider) {
      return undefined;
    }
    if (requested) {
      const exists = provider.models.some((model) => model.name === requested);
      if (exists) {
        return requested;
      }
    }
    return provider.lastSelectedModel || provider.defaultModel || provider.models[0]?.name;
  }
}
