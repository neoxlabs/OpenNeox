/**
 * Context Intelligence — 上下文智能建议 (Neox 独有)
 *
 * 利用 ModelCapabilityManager + ModelRouter 提供智能建议：
 * 1. 自动模型切换建议 — 检测到视觉任务推荐 vision 模型
 * 2. Context 压力预警 — 接近 limit 建议 compact 或换大 context 模型
 * 3. Cost 优化建议 — 简单任务建议用便宜模型
 *
 * 这是 Claude Code 永远做不到的功能 — 它只有一个 provider。
 * Neox 的多 Provider 多模型架构使得这种智能路由成为可能。
 */

import { ModelCapabilityManager, MODEL_CAPABILITIES } from './modelCapabilities.js';
import type { ModelCapability } from '@neoxlabs/platform/utils/config.js';

// ==================== Types ====================

export type SuggestionType =
  | 'switch_model'        // 建议切换模型
  | 'context_warning'     // Context 压力预警
  | 'context_critical'    // Context 即将满
  | 'cost_optimization'   // 建议用更便宜的模型
  | 'vision_needed'       // 检测到图片，建议 vision 模型
  | 'reasoning_needed';   // 复杂任务，建议更强的推理模型

export type SuggestionUrgency = 'info' | 'warning' | 'critical';

export interface ContextSuggestion {
  type: SuggestionType;
  urgency: SuggestionUrgency;
  message: string;
  /** Suggested model alias, if applicable */
  suggestedModel?: string;
  /** Action hint */
  action?: string;
  /** Auto-dismissal time in ms (0 = manual dismiss) */
  ttlMs: number;
}

export interface ContextState {
  /** Current model alias */
  currentModel: string;
  /** Current provider name */
  currentProvider: string;
  /** Context pressure 0-1 */
  contextPressure: number;
  /** Max context tokens for current model */
  maxContextTokens: number;
  /** Tokens used so far */
  tokensUsed: number;
  /** Session cost so far in USD */
  sessionCostUsd: number;
  /** Number of tool calls this session */
  toolCallCount: number;
  /** Whether the current input contains images */
  hasImageInput: boolean;
  /** Whether the current task seems complex (multi-step, refactoring, etc.) */
  isComplexTask: boolean;
  /** Number of conversation turns */
  turnCount: number;
}

// ==================== Suggestion Generators ====================

/**
 * Analyze the current context and generate suggestions.
 * Called periodically or on significant state changes.
 */
/** Lazy singleton — created on first use with default capabilities */
let _mgr: ModelCapabilityManager | null = null;
function getMgr(): ModelCapabilityManager {
  if (!_mgr) {
    _mgr = new ModelCapabilityManager(MODEL_CAPABILITIES);
  }
  return _mgr;
}

/** Allow injecting a custom manager (e.g., from runtime with user-configured models) */
export function setCapabilityManager(mgr: ModelCapabilityManager): void {
  _mgr = mgr;
}

export function generateSuggestions(state: ContextState): ContextSuggestion[] {
  const suggestions: ContextSuggestion[] = [];
  const mgr = getMgr();

  // 1. Vision model suggestion
  if (state.hasImageInput) {
    const currentCap = mgr.getCapability(state.currentModel);
    if (currentCap && !currentCap.features.supportsVision) {
      const visionAliases = mgr.getRecommendedModels('image_analysis', true);
      const suggested = visionAliases[0];
      if (suggested) {
        suggestions.push({
          type: 'vision_needed',
          urgency: 'warning',
          message: `当前模型 ${state.currentModel} 不支持视觉。建议切换到 ${suggested}`,
          suggestedModel: suggested,
          action: `/model ${suggested}`,
          ttlMs: 30_000,
        });
      }
    }
  }

  // 2. Context pressure warning
  if (state.contextPressure >= 0.9) {
    // Critical — suggest immediate action
    const largerModels = findLargerContextModels(mgr, state.maxContextTokens);
    const suggestion: ContextSuggestion = {
      type: 'context_critical',
      urgency: 'critical',
      message: `Context 已用 ${Math.round(state.contextPressure * 100)}%，即将满。`,
      action: '/compact',
      ttlMs: 0, // Manual dismiss
    };
    if (largerModels.length > 0) {
      suggestion.message += ` 建议 compact 或切换到 ${largerModels[0]}`;
      suggestion.suggestedModel = largerModels[0];
    } else {
      suggestion.message += ' 建议立即 compact。';
    }
    suggestions.push(suggestion);
  } else if (state.contextPressure >= 0.7) {
    // Warning
    suggestions.push({
      type: 'context_warning',
      urgency: 'warning',
      message: `Context 已用 ${Math.round(state.contextPressure * 100)}%。如需继续长对话，可考虑 /compact。`,
      action: '/compact',
      ttlMs: 60_000,
    });
  }

  // 3. Cost optimization — suggest cheaper model for simple tasks
  if (!state.isComplexTask && state.turnCount > 3 && state.toolCallCount < 5) {
    const currentCap = mgr.getCapability(state.currentModel);
    if (currentCap && currentCap.scores.cost < 50) {
      // Current model is expensive
      const cheaperAliases = findCheaperModels(mgr, currentCap.scores.cost);
      if (cheaperAliases.length > 0) {
        const bestAlias = cheaperAliases[0];
        const bestCap = mgr.getCapability(bestAlias);
        suggestions.push({
          type: 'cost_optimization',
          urgency: 'info',
          message: `当前任务较简单，可用 ${bestAlias} 节省成本${bestCap ? `（cost score: ${bestCap.scores.cost} vs ${currentCap.scores.cost}）` : ''}`,
          suggestedModel: bestAlias,
          action: `/model ${bestAlias}`,
          ttlMs: 60_000,
        });
      }
    }
  }

  // 4. Reasoning model suggestion for complex tasks
  if (state.isComplexTask) {
    const currentCap = mgr.getCapability(state.currentModel);
    if (currentCap && currentCap.scores.reasoning < 85) {
      const reasoningAliases = mgr.getRecommendedModels('reasoning');
      const betterAlias = reasoningAliases.find(alias => {
        if (alias === state.currentModel) return false;
        const cap = mgr.getCapability(alias);
        return cap && cap.scores.reasoning > currentCap.scores.reasoning;
      });
      if (betterAlias) {
        const betterCap = mgr.getCapability(betterAlias);
        suggestions.push({
          type: 'reasoning_needed',
          urgency: 'info',
          message: `复杂任务建议用 ${betterAlias}${betterCap ? `（reasoning: ${betterCap.scores.reasoning} vs ${currentCap.scores.reasoning}）` : ''}`,
          suggestedModel: betterAlias,
          action: `/model ${betterAlias}`,
          ttlMs: 30_000,
        });
      }
    }
  }

  return suggestions;
}

// ==================== Helpers ====================

function findLargerContextModels(mgr: ModelCapabilityManager, currentMaxTokens: number): string[] {
  return mgr.getAllCapabilities()
    .filter(cap => cap.features.maxContextTokens > currentMaxTokens * 1.5)
    .sort((a, b) => b.features.maxContextTokens - a.features.maxContextTokens)
    .map(cap => cap.modelAlias);
}

function findCheaperModels(mgr: ModelCapabilityManager, currentCostScore: number): string[] {
  return mgr.getAllCapabilities()
    .filter(cap =>
      cap.scores.cost > currentCostScore + 20 && // Significantly cheaper
      cap.scores.coding >= 70 && // Still capable enough for coding
      cap.features.supportsTools
    )
    .sort((a, b) => b.scores.cost - a.scores.cost) // Cheapest first
    .map(cap => cap.modelAlias);
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

// ==================== Suggestion Manager ====================

/** Manages active suggestions with deduplication and TTL */
export class SuggestionManager {
  private active: Map<SuggestionType, ContextSuggestion> = new Map();
  private dismissed: Set<SuggestionType> = new Set();
  private timers: Map<SuggestionType, ReturnType<typeof setTimeout>> = new Map();

  /** Update suggestions based on current state */
  update(state: ContextState): ContextSuggestion[] {
    const newSuggestions = generateSuggestions(state);

    // Clear expired/resolved suggestions
    for (const [type] of this.active) {
      if (!newSuggestions.find(s => s.type === type)) {
        this.active.delete(type);
        const timer = this.timers.get(type);
        if (timer) { clearTimeout(timer); this.timers.delete(type); }
      }
    }

    // Add new suggestions (skip dismissed)
    const added: ContextSuggestion[] = [];
    for (const suggestion of newSuggestions) {
      if (this.dismissed.has(suggestion.type)) continue;
      if (this.active.has(suggestion.type)) continue;

      this.active.set(suggestion.type, suggestion);
      added.push(suggestion);

      // Auto-dismiss after TTL
      if (suggestion.ttlMs > 0) {
        const timer = setTimeout(() => {
          this.active.delete(suggestion.type);
          this.timers.delete(suggestion.type);
        }, suggestion.ttlMs);
        this.timers.set(suggestion.type, timer);
      }
    }

    return added;
  }

  /** Dismiss a suggestion */
  dismiss(type: SuggestionType): void {
    this.active.delete(type);
    this.dismissed.add(type);
    const timer = this.timers.get(type);
    if (timer) { clearTimeout(timer); this.timers.delete(type); }
  }

  /** Get all active suggestions */
  getActive(): ContextSuggestion[] {
    return [...this.active.values()];
  }

  /** Get the highest urgency active suggestion */
  getTopSuggestion(): ContextSuggestion | null {
    const active = this.getActive();
    if (active.length === 0) return null;
    // Sort: critical > warning > info
    const urgencyOrder: Record<SuggestionUrgency, number> = { critical: 3, warning: 2, info: 1 };
    active.sort((a, b) => urgencyOrder[b.urgency] - urgencyOrder[a.urgency]);
    return active[0];
  }

  /** Reset all dismissed */
  resetDismissed(): void {
    this.dismissed.clear();
  }

  /** Cleanup timers */
  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.active.clear();
  }
}

// ==================== Singleton ====================

let globalSuggestionManager: SuggestionManager | null = null;

export function getGlobalSuggestionManager(): SuggestionManager {
  if (!globalSuggestionManager) {
    globalSuggestionManager = new SuggestionManager();
  }
  return globalSuggestionManager;
}
