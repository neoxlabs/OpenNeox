
import type { AREProfile, LoopProfile, ReasoningDefaults } from '@neoxlabs/kernel/profiles/types.js';

// ==================== Types ====================

export type SpeedMode = 'turbo' | 'normal' | 'deep';

export interface SpeedModeOverlay {
  loop?: Partial<LoopProfile>;
  are?: Partial<AREProfile>;
  reasoning?: Partial<ReasoningDefaults>;
  /** Provider-specific params that get merged into API request */
  providerParams?: Record<string, any>;
}

/** Provider-specific speed mode mapping */
export interface ProviderSpeedMapping {
  turbo: Record<string, any>;
  normal: Record<string, any>;
  deep: Record<string, any>;
}

// ==================== Provider Mappings ====================

/** Multi-provider speed mode parameter mappings */
const PROVIDER_SPEED_MAPPINGS: Record<string, ProviderSpeedMapping> = {
  anthropic: {
    turbo: { thinking: { type: 'disabled' }, budget_tokens: 0 },
    normal: { thinking: { type: 'enabled' }, budget_tokens: 16384 },
    deep: { thinking: { type: 'enabled' }, budget_tokens: -1 }, // -1 = max
  },
  openai: {
    turbo: { reasoning_effort: 'low' },
    normal: { reasoning_effort: 'medium' },
    deep: { reasoning_effort: 'high' },
  },
  'openai-o-series': {
    turbo: { reasoning_effort: 'minimal' },
    normal: { reasoning_effort: 'medium' },
    deep: { reasoning_effort: 'xhigh' },
  },
  kimi: {
    turbo: { thinking: { type: 'disabled' } },
    normal: { thinking: { type: 'enabled' } },
    deep: { thinking: { type: 'enabled', budget_tokens: 65536 } },
  },
  deepseek: {
    turbo: { thinking: { type: 'disabled' } },
    normal: { thinking: { type: 'enabled' } },
    deep: { thinking: { type: 'enabled' } },
  },
  // Generic fallback for models without native reasoning control
  generic: {
    turbo: {},
    normal: {},
    deep: {},
  },
};

// ==================== Speed Mode Overlays ====================

const SPEED_MODE_OVERLAYS: Record<SpeedMode, SpeedModeOverlay> = {
  turbo: {
    loop: {
      strategy: 'fast_converge',
      disableProgressGate: true,
      disablePostActionReflection: true,
      disablePlannerAutoFollowup: true,
    },
    are: {
      maxLevel: 0,  // NONE - skip all reasoning gates
    },
    reasoning: {
      effort: 'minimal',
    },
  },
  normal: {
    loop: {
      strategy: 'balanced',
      disableProgressGate: false,
      disablePostActionReflection: false,
    },
    are: {
      maxLevel: 1,  // LIGHT
    },
    reasoning: {
      effort: 'medium',
    },
  },
  deep: {
    loop: {
      strategy: 'balanced',
      disableProgressGate: false,
      disablePostActionReflection: false,
      disablePlannerAutoFollowup: false,
    },
    are: {
      maxLevel: 2,  // DEEP
    },
    reasoning: {
      effort: 'high',
    },
  },
};

// ==================== State ====================

let currentSpeedMode: SpeedMode = 'normal';
let onSpeedModeChange: ((mode: SpeedMode) => void) | null = null;

// ==================== Public API ====================

export function setSpeedMode(mode: SpeedMode): void {
  currentSpeedMode = mode;
  onSpeedModeChange?.(mode);
}

export function getSpeedMode(): SpeedMode {
  return currentSpeedMode;
}

export function setSpeedModeChangeCallback(callback: ((mode: SpeedMode) => void) | null): void {
  onSpeedModeChange = callback;
}

/**
 * Get the profile overlay for the current speed mode.
 * Merges into the active ModelProfile at runtime.
 */
export function getProfileOverlay(mode?: SpeedMode): SpeedModeOverlay {
  return SPEED_MODE_OVERLAYS[mode || currentSpeedMode];
}

/**
 * Get provider-specific parameters for the current speed mode.
 * Returns params that should be merged into the API request.
 */
export function getProviderSpeedParams(providerType: string, mode?: SpeedMode): Record<string, any> {
  const m = mode || currentSpeedMode;

  // Try exact match first, then prefix match
  const mapping = PROVIDER_SPEED_MAPPINGS[providerType]
    || PROVIDER_SPEED_MAPPINGS[providerType.split('-')[0]]
    || PROVIDER_SPEED_MAPPINGS.generic;

  return mapping[m] || {};
}

/**
 * Detect provider type from provider string.
 * Used to auto-select the right speed mapping.
 */
export function detectProviderType(provider: string, model: string): string {
  const p = provider.toLowerCase();
  const m = model.toLowerCase();

  if (p.includes('anthropic') || m.includes('claude')) return 'anthropic';
  if (m.includes('o1') || m.includes('o3') || m.includes('o4')) return 'openai-o-series';
  if (p.includes('openai') || m.includes('gpt')) return 'openai';
  if (p.includes('kimi') || m.includes('kimi') || m.includes('moonshot')) return 'kimi';
  if (p.includes('deepseek') || m.includes('deepseek')) return 'deepseek';
  if (p.includes('glm') || m.includes('glm')) return 'generic';
  if (p.includes('gemini') || m.includes('gemini')) return 'generic';

  return 'generic';
}

/** Speed mode display info */
export function getSpeedModeInfo(mode?: SpeedMode): { icon: string; label: string; color: string } {
  const m = mode || currentSpeedMode;
  switch (m) {
    case 'turbo': return { icon: '⚡', label: 'Turbo', color: 'yellow' };
    case 'normal': return { icon: '●', label: 'Normal', color: 'cyan' };
    case 'deep': return { icon: '🧠', label: 'Deep', color: 'magenta' };
  }
}

/** Check if a provider/model combo supports native reasoning control */
export function supportsNativeReasoning(provider: string, model: string): boolean {
  const pType = detectProviderType(provider, model);
  return pType !== 'generic';
}
