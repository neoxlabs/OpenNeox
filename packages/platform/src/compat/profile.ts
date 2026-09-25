import type { CompatProfile, CompatThresholds, ModelCompatOverrides } from '@neoxlabs/kernel/types/compat.js';
import { modelRegistry } from '../models/registry/index.js';

const DEFAULT_WARN_THRESHOLDS: CompatThresholds = {
  warn: 0.7,
  soft: 0.80,
  hard: 0.95,
};

const DEFAULT_TAIL_TOKEN_BUDGET = 20_000;

function mergeThresholds(
  base: CompatThresholds | undefined,
  overrides: Partial<CompatThresholds> | undefined
): CompatThresholds {
  return {
    warn: overrides?.warn ?? base?.warn ?? DEFAULT_WARN_THRESHOLDS.warn,
    soft: overrides?.soft ?? base?.soft ?? DEFAULT_WARN_THRESHOLDS.soft,
    hard: overrides?.hard ?? base?.hard ?? DEFAULT_WARN_THRESHOLDS.hard,
  };
}

function defaultAutoCompactLimit(contextWindow?: number, explicit?: number): number | undefined {
  if (explicit !== undefined) {
    return explicit;
  }
  if (!contextWindow) {
    return undefined;
  }
  return Math.floor((contextWindow * 9) / 10);
}

function defaultTailBudget(contextWindow?: number, explicit?: number): number | undefined {
  if (explicit !== undefined) {
    return explicit;
  }
  if (!contextWindow) {
    return DEFAULT_TAIL_TOKEN_BUDGET;
  }
  const fifteenPercent = Math.floor(contextWindow * 0.15);
  return Math.min(DEFAULT_TAIL_TOKEN_BUDGET, fifteenPercent || DEFAULT_TAIL_TOKEN_BUDGET);
}

export function resolveCompatProfile(model: string, overrides?: ModelCompatOverrides): CompatProfile {
  const bare = model.includes(':')
    ? model.slice(model.lastIndexOf(':') + 1)
    : model.includes('/')
      ? model.slice(model.lastIndexOf('/') + 1)
      : model;
  const registryModel = modelRegistry.getModel(model) ?? modelRegistry.getModel(bare);

  if (process.env.CLI_DEBUG === '1') {
    console.error(`[PROFILE] resolveCompatProfile for model="${model}"`);
    console.error(`[PROFILE]   registryModel found: ${!!registryModel}`);
    console.error(`[PROFILE]   registryModel.maxInputTokens: ${registryModel?.maxInputTokens}`);
    console.error(`[PROFILE]   overrides.contextWindow: ${overrides?.contextWindow}`);
  }

  const DEFAULT_CONTEXT_WINDOW = 128_000;
  const DEFAULT_MAX_OUTPUT = 16_000;

  // Codex 源码: model_context_window / model_auto_compact_token_limit
  // 注意: overrides.contextWindow 视为显式意图(可主动收窄)。上游少报应在写入 overrides
  // 前与 registry 取 max (见 CLI compatProfileAdapter / resolveModelCapabilities)。
  const envContextWindow = parseInt(process.env.NEOX_CONTEXT_WINDOW || '0', 10);
  const envAutoCompactLimit = parseInt(process.env.NEOX_AUTO_COMPACT_LIMIT || '0', 10);

  const contextWindow =
    (envContextWindow > 0 ? envContextWindow : undefined) ??
    overrides?.contextWindow ??
    registryModel?.maxInputTokens ??
    DEFAULT_CONTEXT_WINDOW;

  const maxOutputTokens =
    overrides?.maxOutputTokens ??
    registryModel?.maxOutputTokens ??
    DEFAULT_MAX_OUTPUT;

  if (process.env.CLI_DEBUG === '1') {
    console.error(`[PROFILE]   final contextWindow: ${contextWindow}`);
  }

  const autoCompactLimit = defaultAutoCompactLimit(
    contextWindow,
    envAutoCompactLimit > 0 ? envAutoCompactLimit : overrides?.autoCompactTokenLimit
  );

  const tailTokenBudget = defaultTailBudget(
    contextWindow,
    overrides?.tailTokenBudget
  );

  const warnThresholds = mergeThresholds(
    DEFAULT_WARN_THRESHOLDS,
    overrides?.warnThresholds
  );

  return {
    model,
    contextWindow,
    autoCompactLimit,
    maxOutputTokens,
    tailTokenBudget,
    warnThresholds,
    source: overrides ? 'override' : registryModel ? 'registry' : 'default',
  };
}

export { DEFAULT_WARN_THRESHOLDS };
