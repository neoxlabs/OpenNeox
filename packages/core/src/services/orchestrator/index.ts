/**
 * 多模型协作系统 - 统一导出
 */

export { TaskAnalyzer } from '../taskAnalyzer.js';
export type { Message, LLMProvider } from '../taskAnalyzer.js';

export { ModelCapabilityManager, MODEL_CAPABILITIES } from '../modelCapabilities.js';

export { SharedContextManager } from '../sharedContextManager.js';
export type { SharedContext } from '../sharedContextManager.js';

export { ModelOrchestrator } from '../modelOrchestrator.js';
export type { ModelProviderFactory } from '../modelOrchestrator.js';

export type {
  OrchestratorConfig,
  TaskType,
  TaskRoutingRule,
  AnalyzedTask,
  TaskAnalysis,
  TaskResult,
  OrchestratedResponse,
  ModelCapability,
  ModelCapabilityScores,
  ModelFeatures,
  ContextSharingStrategy,
  OrchestrationMode,
} from '@neoxlabs/platform/utils/config.js';

/**
 * 默认的多模型协作配置
 */
export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  enabled: false, // 默认关闭，用户可手动开启
  taskRouting: [
    // 预设的任务路由规则
    {
      taskType: 'image_analysis',
      preferredModels: ['gemini-2.5-pro', 'gpt-4o'],
      fallbackModel: 'claude-sonnet',
    },
    {
      taskType: 'coding',
      preferredModels: ['claude-opus', 'deepseek-coder', 'claude-sonnet'],
      fallbackModel: 'gpt-4o',
    },
    {
      taskType: 'code_review',
      preferredModels: ['claude-opus', 'deepseek-coder'],
      fallbackModel: 'claude-sonnet',
    },
    {
      taskType: 'debugging',
      preferredModels: ['claude-opus', 'o3'],
      fallbackModel: 'claude-sonnet',
    },
    {
      taskType: 'reasoning',
      preferredModels: ['o3', 'claude-opus', 'gemini-2.5-pro'],
      fallbackModel: 'claude-sonnet',
    },
    {
      taskType: 'data_analysis',
      preferredModels: ['o3', 'gemini-2.5-pro'],
      fallbackModel: 'claude-sonnet',
    },
    {
      taskType: 'creative_writing',
      preferredModels: ['claude-opus', 'gpt-4o'],
      fallbackModel: 'claude-sonnet',
    },
    {
      taskType: 'summarization',
      preferredModels: ['claude-haiku', 'gpt-4o-mini'],
      fallbackModel: 'claude-sonnet',
    },
    {
      taskType: 'translation',
      preferredModels: ['claude-haiku', 'gpt-4o-mini'],
      fallbackModel: 'claude-sonnet',
    },
    {
      taskType: 'general_qa',
      preferredModels: ['claude-sonnet', 'gpt-4o'],
      fallbackModel: 'claude-haiku',
    },
  ],
  contextSharing: {
    strategy: 'summary', // 默认使用摘要策略
    maxSharedTokens: 2000,
    summarizerModel: 'claude-haiku', // 使用轻量模型生成摘要
  },
  mode: 'hybrid', // 默认使用混合模式
  analyzerModel: 'claude-haiku', // 使用轻量模型分析任务
};

import type { OrchestratorConfig } from '@neoxlabs/platform/utils/config.js';
