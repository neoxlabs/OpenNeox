/**
 * Model Info Utilities for UI
 *
 * UI 层使用的模型信息查询工具
 */

import { modelRegistry } from '@neoxlabs/platform/models/registry/index.js';
import type { ModelInfo } from '../shared/ipc.js';

/**
 * 获取模型的详细信息（包含注册中心数据）
 */
export function getEnhancedModelInfo(modelName: string): {
  displayName: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  supportsVision: boolean;
  supportsThinking: boolean;
  supportsTools: boolean;
  scores?: {
    coding: number;
    reasoning: number;
    vision: number;
    creativity: number;
    speed: number;
    cost: number;
  };
  notes?: string;
} | null {
  const model = modelRegistry.getModel(modelName);
  if (!model) return null;

  return {
    displayName: model.displayName,
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
    supportsVision: model.supportsVision ?? false,
    supportsThinking: model.supportsThinking ?? false,
    supportsTools: model.supportsTools ?? false,
    scores: model.scores
      ? {
          coding: model.scores.coding ?? 0,
          reasoning: model.scores.reasoning ?? 0,
          vision: model.scores.vision ?? 0,
          creativity: model.scores.creativity ?? 0,
          speed: model.scores.speed ?? 0,
          cost: model.scores.cost ?? 0,
        }
      : undefined,
    notes: model.notes,
  };
}

/**
 * 格式化上下文窗口大小
 */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1000000) {
    const value = tokens / 1000000;
    const nearest = Math.round(value);
    if (nearest >= 1 && Math.abs(value - nearest) <= 0.11) return `${nearest}M`;
    const formatted = value >= 10 ? `${Math.round(value)}` : value.toFixed(1).replace(/\.0$/, '');
    return `${formatted}M`;
  } else if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}K`;
  }
  return `${tokens}`;
}

/**
 * 获取模型能力徽章
 */
export function getModelBadges(modelInfo: ModelInfo): Array<{
  emoji: string;
  label: string;
  tooltip: string;
}> {
  const badges: Array<{ emoji: string; label: string; tooltip: string }> = [];

  if (modelInfo.supportsVision) {
    badges.push({
      emoji: '👁️',
      label: 'Vision',
      tooltip: '支持图像输入',
    });
  }

  if (modelInfo.supportsThinking) {
    badges.push({
      emoji: '💭',
      label: 'Thinking',
      tooltip: '支持深度思考模式',
    });
  }

  return badges;
}

/**
 * 根据上下文大小获取推荐场景
 */
export function getRecommendedUseCases(contextTokens: number): string[] {
  const useCases: string[] = [];

  if (contextTokens >= 1000000) {
    useCases.push('超大型代码库分析', '长文档处理', '复杂项目重构');
  } else if (contextTokens >= 200000) {
    useCases.push('大型项目开发', '代码审查', '架构设计');
  } else if (contextTokens >= 128000) {
    useCases.push('日常编程', '功能开发', 'Bug修复');
  } else {
    useCases.push('快速问答', '代码片段', '简单任务');
  }

  return useCases;
}

/**
 * 对比两个模型
 */
export function compareModels(modelA: string, modelB: string): {
  winner: 'A' | 'B' | 'tie';
  reason: string;
} | null {
  const a = modelRegistry.getModel(modelA);
  const b = modelRegistry.getModel(modelB);

  if (!a || !b) return null;

  // 简单对比：综合评分
  const scoreA = (a.scores?.coding ?? 50) + (a.scores?.reasoning ?? 50);
  const scoreB = (b.scores?.coding ?? 50) + (b.scores?.reasoning ?? 50);

  if (scoreA > scoreB) {
    return {
      winner: 'A',
      reason: `${a.displayName} 在编程和推理能力上更强`,
    };
  } else if (scoreB > scoreA) {
    return {
      winner: 'B',
      reason: `${b.displayName} 在编程和推理能力上更强`,
    };
  }

  return {
    winner: 'tie',
    reason: '两个模型能力相当',
  };
}

/**
 * 获取最适合特定任务的模型
 */
export function getBestModelForTask(
  taskType: 'coding' | 'reasoning' | 'vision' | 'creativity',
  availableModels: ModelInfo[]
): ModelInfo | null {
  if (availableModels.length === 0) return null;

  // 根据任务类型获取最佳模型
  let best = availableModels[0];
  let bestScore = 0;

  for (const model of availableModels) {
    const registryModel = modelRegistry.getModel(model.name);
    if (!registryModel?.scores) continue;

    const score = registryModel.scores[taskType] ?? 0;
    if (score > bestScore) {
      bestScore = score;
      best = model;
    }
  }

  return best;
}

/**
 * 获取模型的能力评分
 */
export function getModelScores(modelName: string) {
  const model = modelRegistry.getModel(modelName);
  return model?.scores ?? null;
}

/**
 * 检查模型是否支持特定功能
 */
export function checkModelSupport(modelName: string, feature: 'vision' | 'thinking' | 'tools'): boolean {
  const model = modelRegistry.getModel(modelName);
  if (!model) return false;

  switch (feature) {
    case 'vision':
      return model.supportsVision ?? false;
    case 'thinking':
      return model.supportsThinking ?? false;
    case 'tools':
      return model.supportsTools ?? false;
    default:
      return false;
  }
}
