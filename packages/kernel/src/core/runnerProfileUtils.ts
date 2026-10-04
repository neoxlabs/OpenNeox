import type { Tool } from '../types/index.js';
import type { CompletionProfile, ResolvedModelProfile } from '../profiles/index.js';
import { getKernelConfig } from './kernelConfigBridge.js';

export function getCompletionProfile(
  modelProfile?: ResolvedModelProfile,
): CompletionProfile {
  return modelProfile?.completion ?? {};
}

export function applyToolsetFilter(
  tools: Tool[],
  modelProfile?: ResolvedModelProfile,
  options?: { modelName?: string },
): Tool[] {
  const config = getKernelConfig();
  const modelKey = options?.modelName?.trim().toLowerCase();
  const modelOverrides = config.toolsetOverridesByModel;
  const profileOverrides = config.toolsetOverrides;
  const profileId = modelProfile?.id;
  const hasModelOverride = !!modelKey
    && !!modelOverrides
    && Object.prototype.hasOwnProperty.call(modelOverrides, modelKey);
  const hasProfileOverride = !!profileId
    && !!profileOverrides
    && Object.prototype.hasOwnProperty.call(profileOverrides, profileId);

  const disabled = hasModelOverride
    ? modelOverrides?.[modelKey!]
    : hasProfileOverride
      ? profileOverrides?.[profileId!]
      : modelProfile?.toolset?.disabledTools;

  if (!disabled || disabled.length === 0) return tools;
  const disabledSet = new Set(disabled);
  return tools.filter(t => !disabledSet.has(t.name));
}
