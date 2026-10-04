import { resolveCompatProfile } from '../compat/profile.js';
import { modelRegistry, type ModelMetadata } from '../models/registry/index.js';
import type { CompatProfile, CompatProfileSource } from '@neoxlabs/kernel/types/compat.js';
import type { ProviderConfigEntry, ProviderModelConfig } from '../utils/config.js';

export * from '@neoxlabs/kernel/platform/modelCapabilities.js';

export interface ResolvedModelCapabilities {
  contextWindow: number;
  maxOutputTokens: number;
  compatProfile: CompatProfile;
  supportsVision?: boolean;
  supportsThinking?: boolean;
}

type ProviderCapabilitySource = Pick<ProviderConfigEntry, 'models' | 'maxInputTokens' | 'maxTokens'> & {
  contextWindow?: unknown;
};

function positiveNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function envPositiveInt(name: string): number | undefined {
  const parsed = Number.parseInt(process.env[name] || '0', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** registry 模糊候选表 — 全量 id/alias 的 (needle, meta) 列表, 首次使用时构建并缓存. */
let fuzzyCandidates: Array<{ needle: string; meta: ModelMetadata }> | null = null;

function getFuzzyCandidates(): Array<{ needle: string; meta: ModelMetadata }> {
  if (!fuzzyCandidates) {
    fuzzyCandidates = [];
    for (const meta of modelRegistry.getAllModels()) {
      for (const name of [meta.id, ...(meta.aliases ?? [])]) {
        const needle = name.toLowerCase();
        // 过短的 id (o1/o3 等) 子串误伤率高, 只走精确匹配
        if (needle.length >= 4) fuzzyCandidates.push({ needle, meta });
      }
    }
    // 最长 needle 优先 → 最具体的条目赢 (gpt-5.4-mini > gpt-5.4 > gpt-5); 同长非 deprecated 优先
    fuzzyCandidates.sort(
      (a, b) => b.needle.length - a.needle.length || Number(!!a.meta.deprecated) - Number(!!b.meta.deprecated),
    );
  }
  return fuzzyCandidates;
}

function isVersionSafeSubstringMatch(query: string, needle: string): boolean {
  const idx = query.indexOf(needle);
  if (idx < 0) return false;
  const afterIdx = idx + needle.length;
  if (afterIdx >= query.length) return true;
  const after = query[afterIdx];
  const next = query[afterIdx + 1];
  /* needle 后紧跟裸 digit → 更具体型号 (极少见, 仍拒) */
  if (/[0-9]/.test(after)) return false;
  if ((after === '-' || after === '.') && next && /[0-9]/.test(next)) {
    const rest = query.slice(afterIdx + 1);
    /* 日期/构建号后缀: -2026… / -20251101 — 允许 */
    if (/^\d{4}(\d{2}){0,2}([-.].*)?$/.test(rest)) return true;
    /* 版本续写: -7 / .5 — 拒绝短针 */
    return false;
  }
  return true;
}

export function lookupRegistryModel(modelName: string): ModelMetadata | undefined {
  if (!modelName || !modelName.trim()) return undefined;
  const exact = modelRegistry.getModel(modelName);
  if (exact) return exact;
  /* provider 前缀 / OpenRouter slug: neox-cloud:claude-opus-4-7 / anthropic/claude-opus-4.7 */
  const bare = modelName.includes(':')
    ? modelName.slice(modelName.lastIndexOf(':') + 1)
    : modelName.includes('/')
      ? modelName.slice(modelName.lastIndexOf('/') + 1)
      : modelName;
  if (bare !== modelName) {
    const bareExact = modelRegistry.getModel(bare);
    if (bareExact) return bareExact;
  }
  const query = bare.trim().toLowerCase();
  return getFuzzyCandidates().find(c => isVersionSafeSubstringMatch(query, c.needle))?.meta;
}

function familyNewestContextWindow(modelName: string): number | undefined {
  const lower = modelName.toLowerCase();
  /* 按 provider 分组 —— registry 的 provider 字段就是"这是哪一家的协议" */
  const providers: Array<[string, string[]]> = [
    ['openai', ['gpt', 'o1', 'o2', 'o3', 'o4', 'o5', 'codex']],
    ['anthropic', ['claude']],
    ['gemini', ['gemini']],
    ['deepseek', ['deepseek']],
    ['kimi', ['kimi', 'moonshot']],
    ['glm', ['glm', 'zhipu']],
    ['qwen', ['qwen']],
    ['doubao', ['doubao']],
    ['xai', ['grok']],
    ['minimax', ['minimax']],
    ['mistral', ['mistral']],
  ];
  const hit = providers.find(([, keys]) => keys.some((k) => lower.includes(k)));
  if (!hit) return undefined;
  const [provider] = hit;
  let best: { date: string; window: number } | undefined;
  for (const meta of modelRegistry.getAllModels()) {
    if (meta.provider !== provider || meta.deprecated) continue;
    const date = meta.releaseDate ?? '';
    if (!best || date > best.date || (date === best.date && meta.maxInputTokens > best.window)) {
      best = { date, window: meta.maxInputTokens };
    }
  }
  return best?.window;
}

export function estimateContextWindow(modelName: string): number {
  const registered = lookupRegistryModel(modelName);
  if (registered) return registered.maxInputTokens;

  /* registry 里没有这个模型 (刚发布的新版本) → 按同家族最新那个推断.
   * 放在下面那条 legacy 名字链**之前**: 那条链是按名字硬判的, `gpt-6` 不匹配
   * 任何一行, 会直接掉到最后的 128000。 */
  const familyWindow = familyNewestContextWindow(modelName);
  if (familyWindow) return familyWindow;

  // Legacy 兜底 — 仅剩 registry 连模糊匹配都够不到的奇异名字才会走到这里。
  // 新模型不要再往这里加行: 加 registry 条目 (models/registry/index.ts), 模糊匹配自动覆盖变体名。
  const lower = modelName.toLowerCase();
  if (lower.includes('gpt-5.6') || lower.includes('gpt-5-6') || lower.includes('gpt5.6')) return 372000;
  if (lower.includes('gpt-5.5') || lower.includes('gpt-5-5') || lower.includes('gpt5.5')) return 272000;
  if (lower.includes('gpt-5.4-mini') || lower.includes('gpt-5-4-mini') || lower.includes('gpt-5.4-nano') || lower.includes('gpt-5-4-nano')) return 400000;
  if (lower.includes('gpt-5.4') || lower.includes('gpt-5-4') || lower.includes('gpt5.4')) return 1000000;
  if (lower.includes('gpt-5')) return 400000;
  if (lower.includes('gpt-4.1')) return 1000000;
  if (lower.includes('gpt-4') || lower.includes('gpt-4o')) return 128000;
  /* Claude 4.6+ 旗舰线均为 1M; 旧 4 / 4.5 标准档 200K */
  if (lower.includes('claude') && /(?:opus|sonnet|fable|mythos)[-_.]?(?:4[-_.]?(?:6|7|8)|5)/.test(lower)) return 1000000;
  if (lower.includes('claude') && (lower.includes('4-6') || lower.includes('4.6') || lower.includes('4-7') || lower.includes('4.7') || lower.includes('4-8') || lower.includes('4.8'))) return 1000000;
  if (lower.includes('claude')) return 200000;
  if (lower.includes('gemini') && !lower.includes('1.0')) return 1000000;
  if (lower.includes('gemini')) return 32000;
  if (lower.includes('deepseek-v4')) return 1000000;
  if (lower.includes('deepseek-v3.2')) return 128000;
  if (lower.includes('deepseek')) return 128000;
  if (lower.includes('kimi-k2')) return 256000;
  if (lower.includes('kimi')) return 128000;
  if (lower.includes('minimax-m3')) return 1000000;
  if (lower.includes('qwen3.7')) return 1000000;
  if (lower.includes('glm-5.2')) return 1000000;
  if (lower.includes('qwen') || lower.includes('glm')) return 200000;
  if (lower.includes('doubao-seed-1-6')) return 256000;
  // xAI Grok — grok-4.5 = 500K, grok-4 = 256K
  if (lower.includes('grok-4.5') || lower.includes('grok-4-5')) return 500000;
  if (lower.includes('grok')) return 256000;
  return 128000;
}

export function resolveModelCapabilities(
  provider: ProviderCapabilitySource,
  modelName: string,
  options: { defaultMaxOutputTokens?: number } = {},
): ResolvedModelCapabilities {
  const modelEntry = provider.models?.find(entry => entry.name === modelName) as ProviderModelConfig | undefined;
  const registryModel = lookupRegistryModel(modelName);
  const baseCompat = resolveCompatProfile(modelName, modelEntry?.compat);
  const providerContextWindow = positiveNumber(provider.contextWindow) ?? positiveNumber(provider.maxInputTokens);

  const envContextWindow = envPositiveInt('NEOX_CONTEXT_WINDOW');

  /* 显式覆盖 —— compat.contextWindow 是用户/预设**主动写下**的意图(常用于把窗口
   * 收窄: 代理实际只供 64K、或为控成本)。它必须无条件赢, 包括赢过 registry。 */
  const explicitContextWindow = positiveNumber(modelEntry?.compat?.contextWindow);

  const reportedContextWindow =
    positiveNumber(modelEntry?.contextWindow) ??
    providerContextWindow ??
    (baseCompat.source !== 'default' ? positiveNumber(baseCompat.contextWindow) : undefined);

  const registryContextWindow = positiveNumber(registryModel?.maxInputTokens);
  const bareName = modelName.includes(':')
    ? modelName.slice(modelName.lastIndexOf(':') + 1)
    : modelName.includes('/')
      ? modelName.slice(modelName.lastIndexOf('/') + 1)
      : modelName;
  const registryExact = !!(modelRegistry.getModel(modelName) || modelRegistry.getModel(bareName));
  const reconciled =
    registryExact && registryContextWindow && reportedContextWindow
      ? Math.max(registryContextWindow, reportedContextWindow)
      : reportedContextWindow ?? registryContextWindow;

  const contextWindow =
    envContextWindow ??
    explicitContextWindow ??
    reconciled ??
    estimateContextWindow(modelName);

  const defaultMaxOutputTokens = options.defaultMaxOutputTokens ?? 4096;
  const maxOutputTokens =
    positiveNumber(modelEntry?.compat?.maxOutputTokens) ??
    positiveNumber(registryModel?.maxOutputTokens) ??
    positiveNumber(provider.maxTokens) ??
    (baseCompat.source !== 'default' ? positiveNumber(baseCompat.maxOutputTokens) : undefined) ??
    defaultMaxOutputTokens;

  const source: CompatProfileSource = modelEntry?.compat
    ? 'override'
    : registryModel
      ? 'registry'
      : providerContextWindow
        ? 'baseline'
        : baseCompat.source === 'default'
          ? 'unknown'
          : baseCompat.source;

  const compatProfile = {
    ...resolveCompatProfile(modelName, {
      ...(modelEntry?.compat ?? {}),
      contextWindow,
      maxOutputTokens,
    }),
    contextWindow,
    maxOutputTokens,
    source,
  };

  return {
    contextWindow,
    maxOutputTokens,
    compatProfile,
    supportsVision: registryModel?.supportsVision,
    supportsThinking: registryModel?.supportsThinking,
  };
}
