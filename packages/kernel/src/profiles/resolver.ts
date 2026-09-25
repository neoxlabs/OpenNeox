import { BUILTIN_MODEL_PROFILES, BASE_MODEL_PROFILE } from './defaults.js';
import { getKernelConfig } from '../core/kernelConfigBridge.js';
import type { ModelProfile, ResolveModelProfileInput, ResolvedModelProfile } from './types.js';

function lower(value?: string): string {
  return (value || '').toLowerCase();
}

function listIncludes(target: string, patterns?: string[]): boolean {
  if (!patterns || patterns.length === 0) {
    return true;
  }
  return patterns.some(pattern => target.includes(pattern.toLowerCase()));
}

function matches(profile: ModelProfile, input: ResolveModelProfileInput): boolean {
  if (!profile.match) {
    return profile.id === BASE_MODEL_PROFILE.id;
  }

  const protocol = lower(input.protocol);
  const model = lower(input.model);
  const baseUrl = lower(input.baseUrl);

  if (profile.match.protocols?.length) {
    const allowed = profile.match.protocols.map(value => value.toLowerCase());
    if (!allowed.includes(protocol)) {
      return false;
    }
  }

  if (!listIncludes(model, profile.match.modelIncludes)) {
    return false;
  }

  if (profile.match.modelRegex) {
    const regex = new RegExp(profile.match.modelRegex, 'i');
    if (!regex.test(model)) {
      return false;
    }
  }

  if (!listIncludes(baseUrl, profile.match.baseUrlIncludes)) {
    return false;
  }

  return true;
}

function specificity(profile: ModelProfile): number {
  const rule = profile.match;
  if (!rule) {
    return 0;
  }
  let score = 0;
  if (rule.protocols?.length) score += 1;
  if (rule.modelIncludes?.length) score += 2;
  if (rule.modelRegex) score += 3;
  if (rule.baseUrlIncludes?.length) score += 2;
  return score;
}

function deepMerge<T extends Record<string, any>>(base: T, patch: Partial<T>): T {
  const merged: Record<string, any> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      continue;
    }
    const current = merged[key];
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current &&
      typeof current === 'object' &&
      !Array.isArray(current)
    ) {
      merged[key] = deepMerge(current, value as Record<string, any>);
      continue;
    }
    merged[key] = value;
  }
  return merged as T;
}

export function resolveModelProfile(input: ResolveModelProfileInput): ResolvedModelProfile {
  const candidates = input.candidates && input.candidates.length > 0
    ? input.candidates
    : BUILTIN_MODEL_PROFILES;

  const matched = candidates
    .filter(profile => matches(profile, input))
    .sort((a, b) => {
      const priorityDelta = (a.priority || 0) - (b.priority || 0);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }
      return specificity(a) - specificity(b);
    });

  const explicit = input.explicitProfileId
    ? candidates.find(profile => profile.id === input.explicitProfileId)
    : undefined;

  const ordered = explicit ? [...matched, explicit] : matched;
  const seed = deepMerge({} as ResolvedModelProfile, BASE_MODEL_PROFILE as ResolvedModelProfile);

  const merged = ordered.reduce((acc, profile) => deepMerge(acc, profile), seed);
  const sourceProfileIds = ordered.map(profile => profile.id);

  /* 用户覆盖 —— 恒为最后一层
   * ─────────────────────────────────────
   * 内置适配包是 Neox 对各家模型的判断; 用户在设置里改的那几格必须压过它,
   * 否则"改了没反应"。放在 resolver 里而不是某个调用点: 解析入口有四个
   * (runtimeBuilder / systemPrompt / CLI / 桌面 IPC), 分散实现迟早漏一个。
   * `id` / `match` / `priority` 不接受覆盖 —— 那是"这个包是谁"而不是"它怎么配"。 */
  const overrideMap = getKernelConfig().modelProfileOverrides;
  const modelKey = lower(input.model);
  const userOverride = modelKey && overrideMap
    ? overrideMap[modelKey]
    : undefined;
  if (!userOverride || Object.keys(userOverride).length === 0) {
    return { ...merged, sourceProfileIds };
  }
  const { id: _id, match: _match, priority: _priority, ...patch } = userOverride as Record<string, unknown>;
  return {
    ...deepMerge(merged as Record<string, any>, patch) as ResolvedModelProfile,
    sourceProfileIds: [...sourceProfileIds, 'user-override'],
  };
}

export function resolveBuiltinModelProfile(input: Omit<ResolveModelProfileInput, 'candidates'>): ResolvedModelProfile {
  return resolveModelProfile(input);
}
