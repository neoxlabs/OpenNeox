import { resolveCompatProfile } from '@neoxlabs/platform/compat/profile.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { modelRegistry } from '@neoxlabs/platform/models/registry/index.js';
import type { CompatProfile } from '@neoxlabs/kernel/types/compat.js';
import { getCliEdition } from '../edition/index.js';

export function computeCompatProfileFromMainState(params: {
  model: string;
  providerSettings: any;
  getActiveModelConfig: () => any;
  getCompactionThreshold: () => number;
}): CompatProfile | null {
  cliLogger.info('DEBUG_CTX', `rebuildCompatProfile called, model=${params.model}`);
  if (!params.model || !params.providerSettings) {
    return null;
  }

  const modelConfig = params.getActiveModelConfig();
  cliLogger.info(
    'DEBUG_CTX',
    `rebuildCompatProfile for model="${params.model}", modelConfig=${!!modelConfig}, modelConfig.compat=${JSON.stringify(modelConfig?.compat)}`,
  );

  const userCompat = modelConfig?.compat || {};
  let compatOverrides = { ...userCompat };
  try {
    /* 订阅套餐里服务端给的上限 (商业版插槽; 公开版没有 → undefined) */
    const ent = getCliEdition().account?.serverModelLimits(params.model);
    const registryMax = modelRegistry.getModel(params.model)?.maxInputTokens;
    const serverCw = ent?.contextWindow && ent.contextWindow > 0 ? ent.contextWindow : undefined;
    const reportedTop =
      typeof modelConfig?.contextWindow === 'number' && modelConfig.contextWindow > 0
        ? modelConfig.contextWindow
        : undefined;
    const userCw =
      typeof userCompat.contextWindow === 'number' && userCompat.contextWindow > 0
        ? userCompat.contextWindow
        : undefined;
    const candidates = [userCw, serverCw, reportedTop, registryMax].filter(
      (n): n is number => typeof n === 'number' && n > 0,
    );
    const reconciledCw = candidates.length > 0 ? Math.max(...candidates) : undefined;
    compatOverrides = {
      ...userCompat,
      contextWindow: reconciledCw,
      maxOutputTokens:
        userCompat.maxOutputTokens
        ?? (ent?.maxOutputTokens && ent.maxOutputTokens > 0 ? ent.maxOutputTokens : undefined),
    };
  } catch { /* membership 不可用 → 退回 registry/默认 */ }

  const compatProfile = resolveCompatProfile(params.model, compatOverrides);
  cliLogger.info(
    'DEBUG_CTX',
    `rebuildCompatProfile result: contextWindow=${compatProfile?.contextWindow}, source=${compatProfile?.source}`,
  );

  const thresholdPercent = params.getCompactionThreshold();
  if (compatProfile) {
    compatProfile.warnThresholds.warn = thresholdPercent / 100;
    cliLogger.debug(
      'CLI',
      `Applied user threshold to compatProfile: ${thresholdPercent}% (warn=${compatProfile.warnThresholds.warn})`,
    );
  }

  return compatProfile;
}
