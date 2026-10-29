import type { ProviderConfigEntry } from '@neoxlabs/kernel/types/configTypes.js';
import { modelRegistry } from '@neoxlabs/platform/models/registry/index.js';
import { getConcurrencyProfile } from '@neoxlabs/platform/utils/config.js';
import { getSchemaRegistry } from '@neoxlabs/kernel/schemas/index.js';

export type ExploreProviderInfo = Pick<ProviderConfigEntry, 'models'> & Partial<Pick<ProviderConfigEntry, 'protocol' | 'baseUrl'>>;

export interface ResolveClaudeSmallFastModelInput {
  providerId: string;
  modelName: string;
  provider?: ExploreProviderInfo | null;
  configuredProviderId?: string;
  configuredModelName?: string;
  enabled?: boolean;
  allowOpusFallback?: boolean;
}

export interface ResolveExploreModelPolicyInput {
  sessionProviderId: string;
  sessionModelName: string;
  provider?: ExploreProviderInfo | null;
  configuredProviderId?: string;
  configuredModelName?: string;
  claudeExploreUseHaiku?: boolean;
  claudeFallbackToOpusWhenNoHaiku?: boolean;
}

export interface ClaudeModelSelection {
  providerId: string;
  modelName: string;
  source: 'configured' | 'auto-haiku' | 'auto-opus' | 'session' | 'low-profile';
  reason: string;
}

export type ExploreModelSelection = ClaudeModelSelection;

const KNOWN_HAIKU_IDS = [
  'claude-haiku-4-5-20251001',
  'claude-3-5-haiku-20241022',
] as const;

const KNOWN_OPUS_IDS = [
  'claude-opus-4-6',
  'claude-opus-4-5-20251101',
  'claude-opus-4-20250514',
] as const;

function trimValue(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function getCanonicalModelId(modelName: string): string {
  return modelRegistry.getModel(modelName)?.id ?? modelName.trim();
}

function isOfficialAnthropicProvider(provider?: Partial<Pick<ProviderConfigEntry, 'protocol' | 'baseUrl'>> | null): boolean {
  if (!provider || provider.protocol !== 'anthropic') {
    return false;
  }

  const baseUrl = trimValue(provider.baseUrl)?.toLowerCase();
  return !baseUrl || baseUrl.includes('api.anthropic.com');
}

export function isClaudeModel(modelName: string): boolean {
  return getCanonicalModelId(modelName).toLowerCase().includes('claude');
}

export function isClaudeHaikuModel(modelName: string): boolean {
  const normalized = getCanonicalModelId(modelName).toLowerCase();
  return normalized.includes('claude') && normalized.includes('haiku');
}

function getPreferredOpusIds(sessionModelName: string): string[] {
  const normalized = getCanonicalModelId(sessionModelName).toLowerCase();
  const preferred: string[] = [];

  if (normalized.includes('claude-opus-4-6')) {
    preferred.push('claude-opus-4-6');
  }

  if (normalized.includes('claude-opus-4-5')) {
    preferred.push('claude-opus-4-5-20251101');
  }

  if (normalized.includes('claude-opus-4')) {
    preferred.push('claude-opus-4-20250514');
  }

  for (const candidate of KNOWN_OPUS_IDS) {
    if (!preferred.includes(candidate)) {
      preferred.push(candidate);
    }
  }

  return preferred;
}

function getPreferredHaikuIds(sessionModelName: string): string[] {
  const normalized = getCanonicalModelId(sessionModelName).toLowerCase();
  const preferred: string[] = [];

  if (normalized.includes('claude-3-5')) {
    preferred.push('claude-3-5-haiku-20241022');
  }

  if (normalized.includes('claude-opus-4') || normalized.includes('claude-sonnet-4') || normalized.includes('claude-haiku-4')) {
    preferred.push('claude-haiku-4-5-20251001');
  }

  for (const candidate of KNOWN_HAIKU_IDS) {
    if (!preferred.includes(candidate)) {
      preferred.push(candidate);
    }
  }

  return preferred;
}

function matchProviderModel(providerModelNames: string[], candidateId: string): string | undefined {
  for (const modelName of providerModelNames) {
    if (getCanonicalModelId(modelName) === candidateId) {
      return modelName;
    }
  }

  const candidate = modelRegistry.getModel(candidateId);
  const acceptedNames = new Set([
    candidateId.toLowerCase(),
    ...(candidate?.aliases ?? []).map(alias => alias.toLowerCase()),
  ]);

  return providerModelNames.find(modelName => acceptedNames.has(modelName.toLowerCase()));
}

function findAnyClaudeOpus(providerModelNames: string[]): string | undefined {
  for (const candidateId of KNOWN_OPUS_IDS) {
    const matched = matchProviderModel(providerModelNames, candidateId);
    if (matched) {
      return matched;
    }
  }

  return providerModelNames.find(modelName => {
    const lower = modelName.toLowerCase();
    return lower.includes('claude') && lower.includes('opus');
  });
}

function findAnyClaudeHaiku(providerModelNames: string[]): string | undefined {
  for (const candidateId of KNOWN_HAIKU_IDS) {
    const matched = matchProviderModel(providerModelNames, candidateId);
    if (matched) {
      return matched;
    }
  }

  return providerModelNames.find(modelName => {
    const lower = modelName.toLowerCase();
    return lower.includes('claude') && lower.includes('haiku');
  });
}

export function resolveClaudeSmallFastModelSelection(input: ResolveClaudeSmallFastModelInput): ClaudeModelSelection {
  const configuredProviderId = trimValue(input.configuredProviderId);
  const configuredModelName = trimValue(input.configuredModelName);
  if (configuredProviderId && configuredModelName) {
    return {
      providerId: configuredProviderId,
      modelName: configuredModelName,
      source: 'configured',
      reason: 'manual side-agent model configured',
    };
  }

  if (input.enabled === false) {
    return {
      providerId: input.providerId,
      modelName: input.modelName,
      source: 'session',
      reason: 'Claude→Haiku auto-switch disabled',
    };
  }

  if (!isClaudeModel(input.modelName)) {
    return {
      providerId: input.providerId,
      modelName: input.modelName,
      source: 'session',
      reason: 'session model is not Claude',
    };
  }

  if (isClaudeHaikuModel(input.modelName)) {
    return {
      providerId: input.providerId,
      modelName: input.modelName,
      source: 'session',
      reason: 'session model is already Claude Haiku',
    };
  }

  const preferredHaikuIds = getPreferredHaikuIds(input.modelName);
  const providerModelNames = (input.provider?.models ?? [])
    .map(model => model.name?.trim())
    .filter((name): name is string => Boolean(name));

  for (const candidateId of preferredHaikuIds) {
    const matched = matchProviderModel(providerModelNames, candidateId);
    if (matched) {
      return {
        providerId: input.providerId,
        modelName: matched,
        source: 'auto-haiku',
        reason: `matched Claude Haiku candidate ${candidateId}`,
      };
    }
  }

  const fallbackHaiku = findAnyClaudeHaiku(providerModelNames);
  if (fallbackHaiku) {
    return {
      providerId: input.providerId,
      modelName: fallbackHaiku,
      source: 'auto-haiku',
      reason: 'matched Claude Haiku model from provider list',
    };
  }

  if (input.allowOpusFallback) {
    for (const candidateId of getPreferredOpusIds(input.modelName)) {
      const matched = matchProviderModel(providerModelNames, candidateId);
      if (matched) {
        return {
          providerId: input.providerId,
          modelName: matched,
          source: 'auto-opus',
          reason: `Claude Haiku unavailable; matched Claude Opus candidate ${candidateId}`,
        };
      }
    }

    const fallbackOpus = findAnyClaudeOpus(providerModelNames);
    if (fallbackOpus) {
      return {
        providerId: input.providerId,
        modelName: fallbackOpus,
        source: 'auto-opus',
        reason: 'Claude Haiku unavailable; matched Claude Opus model from provider list',
      };
    }
  }

  if (isOfficialAnthropicProvider(input.provider)) {
    return {
      providerId: input.providerId,
      modelName: preferredHaikuIds[0] ?? KNOWN_HAIKU_IDS[0],
      source: 'auto-haiku',
      reason: 'official Anthropic provider defaults Claude side-queries to Haiku',
    };
  }

  if (providerModelNames.length === 0) {
    const haikuFallback = preferredHaikuIds[0] ?? KNOWN_HAIKU_IDS[0];
    if (haikuFallback) {
      return {
        providerId: input.providerId,
        modelName: haikuFallback,
        source: 'auto-haiku',
        reason: `cloud sentinel (empty provider.models) → derived Claude Haiku ${haikuFallback}`,
      };
    }
    return {
      providerId: input.providerId,
      modelName: input.modelName,
      source: 'session',
      reason: 'provider has no configured models to match Claude Haiku',
    };
  }

  return {
    providerId: input.providerId,
    modelName: input.modelName,
    source: 'session',
    reason: 'no Claude Haiku model configured for current provider',
  };
}


function detectFamilyViaRegistry(modelName: string): string | null {
  try {
    const fam = getSchemaRegistry().detectFamily({ model: modelName });
    return fam?.id ?? null;
  } catch {
    return null;
  }
}

export function detectModelFamily(modelName: string): string | null {
  const n = (modelName || '').toLowerCase();
  if (!n) return null;
  return detectFamilyViaRegistry(n);
}

/* family → 已编译的 fast 正则的缓存 (避免每次 isFastVariantForFamily 重新 parse yaml 字符串) */
const FAST_RE_CACHE = new Map<string, RegExp[]>();
function getFastPatternsFor(family: string): RegExp[] {
  if (FAST_RE_CACHE.has(family)) return FAST_RE_CACHE.get(family)!;
  try {
    const fam = getSchemaRegistry().resolveFamily(family);
    if (!fam || !fam.fast_patterns?.length) {
      FAST_RE_CACHE.set(family, []);
      return [];
    }
    /* yaml 中 fast_patterns 是字符串数组, 形如 "/haiku/i" 或纯 pattern.
       解析时支持两种: "/x/i" → new RegExp('x', 'i'); 否则 → new RegExp(s, 'i') 默认 i 大小写不敏感. */
    const compiled = fam.fast_patterns.map((s) => {
      const m = /^\/(.+)\/([a-z]*)$/.exec(s);
      return m ? new RegExp(m[1], m[2]) : new RegExp(s, 'i');
    });
    FAST_RE_CACHE.set(family, compiled);
    return compiled;
  } catch {
    return [];
  }
}

export function isFastVariantForFamily(family: string, modelName: string): boolean {
  const patterns = getFastPatternsFor(family);
  if (patterns.length === 0) return false;
  return patterns.some(p => p.test(modelName));
}

function findFastVariantInProvider(family: string, providerModelNames: string[]): string | undefined {
  for (const mn of providerModelNames) {
    if (detectModelFamily(mn) === family && isFastVariantForFamily(family, mn)) {
      return mn;
    }
  }
  return undefined;
}

/* 按命名规律把主模型派生成同族 fast 变种名 —— 用于云端路径 (NEOX 哨兵 provider 的 models[]
 * 为空, 枚举不出兄弟模型; 网关按 modelId 路由, 派生名直接可用)。
 * 仅在 provider.models 为空时调用 (见 resolveSubAgentModelSelection), BYOK 不会走到这里,
 * 故不会派生出用户 provider 不存在的模型。派生不出 → undefined → 回落主模型。 */
const FAST_DERIVE: Record<string, (n: string) => string | undefined> = {
  deepseek: (n) => (/-pro\b/i.test(n) ? n.replace(/-pro\b/i, '-flash') : undefined),
  mimo:     (n) => (/-pro\b/i.test(n) ? n.replace(/-pro\b/i, '') : undefined),
};

function deriveFastVariantName(family: string, modelName: string): string | undefined {
  const fn = FAST_DERIVE[family];
  if (!fn) return undefined;
  const derived = fn(modelName.trim());
  if (derived && derived !== modelName && isFastVariantForFamily(family, derived)) {
    return derived;
  }
  return undefined;
}

/* 通用版: Claude 走原 fine-grained 路径 (preferred haiku ids per session model + opus fallback),
 * 其他 family 走 pattern match. 保持 Claude 行为完全兼容. */
export function resolveSubAgentModelSelection(input: ResolveClaudeSmallFastModelInput): ClaudeModelSelection {
  /* concurrencyProfile='low': 子 Agent 一律用主模型, 不做任何降级 / 主副拆分.
   * 比 'configured' 优先级还高 — low 模式的语义就是"全用主模型". */
  if (getConcurrencyProfile() === 'low') {
    return {
      providerId: input.providerId,
      modelName: input.modelName,
      source: 'low-profile',
      reason: 'concurrencyProfile=low → sub-agent uses main/session model',
    };
  }
  const configuredProviderId = trimValue(input.configuredProviderId);
  const configuredModelName = trimValue(input.configuredModelName);
  if (configuredProviderId && configuredModelName) {
    return { providerId: configuredProviderId, modelName: configuredModelName, source: 'configured', reason: 'manual side-agent model configured' };
  }
  if (input.enabled === false) {
    return { providerId: input.providerId, modelName: input.modelName, source: 'session', reason: 'auto fast-variant switch disabled' };
  }
  /* Claude 走原 fine-grained policy (preferred haiku ids + opus fallback + 官方 Anthropic provider 兜底) */
  if (isClaudeModel(input.modelName)) {
    return resolveClaudeSmallFastModelSelection(input);
  }
  const family = detectModelFamily(input.modelName);
  if (!family) {
    return { providerId: input.providerId, modelName: input.modelName, source: 'session', reason: `unknown family for ${input.modelName}` };
  }
  if (isFastVariantForFamily(family, input.modelName)) {
    return { providerId: input.providerId, modelName: input.modelName, source: 'session', reason: `session model is already a ${family} fast variant` };
  }
  const providerModelNames = (input.provider?.models ?? [])
    .map(m => m.name?.trim())
    .filter((n): n is string => Boolean(n));
  const fast = findFastVariantInProvider(family, providerModelNames);
  if (fast) {
    return { providerId: input.providerId, modelName: fast, source: 'auto-haiku', reason: `matched ${family} fast variant ${fast}` };
  }
  if (providerModelNames.length === 0) {
    const derived = deriveFastVariantName(family, input.modelName);
    if (derived) {
      return { providerId: input.providerId, modelName: derived, source: 'auto-haiku', reason: `derived ${family} fast variant ${derived} (cloud sentinel, empty provider.models)` };
    }
  }
  return { providerId: input.providerId, modelName: input.modelName, source: 'session', reason: `no ${family} fast variant in provider; falling back to session model` };
}

export function resolveExploreModelSelection(input: ResolveExploreModelPolicyInput): ExploreModelSelection {
  return resolveSubAgentModelSelection({
    providerId: input.sessionProviderId,
    modelName: input.sessionModelName,
    provider: input.provider,
    configuredProviderId: input.configuredProviderId,
    configuredModelName: input.configuredModelName,
    enabled: input.claudeExploreUseHaiku,
    allowOpusFallback: input.claudeFallbackToOpusWhenNoHaiku,
  });
}
