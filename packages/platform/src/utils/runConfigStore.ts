/**
 * RunConfigStore - 运行模式配置存储管理
 *
 * 管理各模式下的 Agent 模型配置：
 * - Main Agent 模型
 * - Supervisor Agent 模型
 * - Worker 模型池
 */

import {
  AssistantConfig,
  AssistantCollaborationMode,
  AgentModelRef,
  WorkerModelEntry,
  RunModeScope,
  RunModeConfig,
  DEFAULT_CLAUDE_EXPLORE_USE_HAIKU,
  DEFAULT_CLAUDE_OPUS_FALLBACK_WHEN_NO_HAIKU,
  DEFAULT_SIDE_AGENT_ENABLED,
  DEFAULT_SIDE_AGENT_FEATURES,
  loadConfig,
  saveConfig,
  type SideAgentConfig,
} from './config.js';
import { ProviderStore } from './providerStore.js';
import { modelRegistry, type ModelMetadata } from '../models/registry/index.js';

//  Re-export WorkerModelEntry 供外部使用
export type { WorkerModelEntry } from './config.js';

/**
 *  内置模型默认 traits
 * 用户可以覆盖或添加自定义 traits
 */
const BUILTIN_MODEL_TRAITS: Record<string, string[]> = {
  // ============ Claude 系列 ============
  'claude-opus-4-5-20250514': ['reasoning', 'creative', 'thorough', '深度思考', '复杂推理'],
  'claude-sonnet-4-5-20250514': ['coding', 'fast', 'accurate', '代码', '快速'],
  'claude-haiku-4-5-20250514': ['fast', 'cheap', 'simple', '轻量', '低成本'],
  // 兼容旧版本名称
  'claude-opus-4-20250514': ['reasoning', 'creative', 'thorough', '深度思考'],
  'claude-sonnet-4-20250514': ['coding', 'fast', 'accurate', '代码'],

  // ============ GPT 系列 (2025) ============
  'gpt-5.6-sol': ['reasoning', 'coding', 'thorough', 'long-context', 'agent', '深度推理', '长上下文', '全能', '旗舰', '委派'],
  'gpt-5.6-terra': ['reasoning', 'coding', 'thorough', 'long-context', 'agent', '深度推理', '长上下文', '委派'],
  'gpt-5.6-luna': ['reasoning', 'coding', 'balanced', 'fast', '推理', '快速', '通用'],
  'gpt-5.5': ['reasoning', 'coding', 'thorough', 'long-context', '深度推理', '长上下文', '全能'],
  'gpt-5.4': ['reasoning', 'coding', 'thorough', 'long-context', '深度推理', '长上下文'],
  'gpt-5.4-mini': ['reasoning', 'coding', 'balanced', 'fast', '快速', '通用'],
  'gpt-5.4-nano': ['fast', 'cheap', 'coding', '快速', '低成本'],
  'gpt-5.2': ['reasoning', 'coding', 'thorough', '深度推理', '全能'],
  'gpt-5.2-mini': ['reasoning', 'fast', 'balanced', '推理', '快速'],
  'gpt-5.2-codex': ['coding', 'agent', 'autonomous', '代码专家', '自主编程'],
  'gpt-5.2-codex-high': ['coding', 'agent', 'thorough', '代码', '深度编程', '最强'],
  'gpt-5.2-codex-medium': ['coding', 'agent', 'balanced', '代码', '性价比'],
  'gpt-5.1': ['reasoning', 'coding', 'balanced', '逻辑缜密', '通用'],
  'gpt-5.1-mini': ['fast', 'cheap', 'coding', '快速', '低成本'],
  'gpt-5.1-codex': ['coding', 'agent', 'autonomous', '代码', '编程'],
  'gpt-5.1-codex-max': ['coding', 'agent', 'thorough', '代码', '深度编程'],
  'o3': ['reasoning', 'math', 'science', '深度推理', '数学'],
  'o4-mini': ['reasoning', 'fast', 'coding', '推理', '快速'],

  // ============ Gemini 系列 ============
  // Gemini 3 系列 - UI 设计专长
  'gemini-3-pro-preview': ['ui', 'design', 'vision', 'creative', 'UI设计', '界面', '视觉'],
  'gemini-3.0-pro': ['ui', 'design', 'vision', 'creative', 'UI设计', '界面'],
  'gemini-3.0-flash': ['ui', 'fast', 'vision', 'UI', '快速'],
  // Gemini 2.5 系列
  'gemini-2.5-pro': ['reasoning', 'long-context', 'vision', '推理', '长上下文'],
  'gemini-2.5-flash': ['fast', 'vision', 'multimodal', '快速', '多模态'],

  // ============ 其他模型 ============
  'deepseek-v4-pro': ['coding', 'reasoning', 'thinking', 'long-context', '代码', '深度推理'],
  'deepseek-v4-flash': ['coding', 'reasoning', 'cheap', 'fast', '代码', '性价比'],
  'qwen3.7-max': ['chinese', 'reasoning', 'coding', 'long-context', '中文', '推理'],
  'qwen3.7-plus': ['chinese', 'reasoning', 'coding', '中文', '通用'],
  'qwen3.6-flash': ['chinese', 'fast', 'cheap', '中文', '快速'],
};

export const DEFAULT_MAX_CONCURRENT_WORKERS = 6;

export class RunConfigStore {
  private providerStore: ProviderStore;
  private scope: RunModeScope;

  constructor(providerStore?: ProviderStore, scope: RunModeScope = 'agentic') {
    this.providerStore = providerStore ?? new ProviderStore();
    this.scope = scope;
  }

  private readLegacyScopedConfig(_config: ReturnType<typeof loadConfig>): AssistantConfig {
    // scope 仅为 'agentic'：无 legacy 回退，返回空配置
    // 避免不同模式共享同一份 workerPool
    return { workerPool: [], collaborationMode: 'flexible', claudeExploreUseHaiku: DEFAULT_CLAUDE_EXPLORE_USE_HAIKU, claudeFallbackToOpusWhenNoHaiku: DEFAULT_CLAUDE_OPUS_FALLBACK_WHEN_NO_HAIKU };
  }

  private readScopedRunModeConfig(config: ReturnType<typeof loadConfig>): RunModeConfig | undefined {
    return config.runConfig?.modes?.[this.scope];
  }

  /**
   * 合并 sideAgent 配置 — 向后兼容旧 claudeExploreUseHaiku / claudeFallbackToOpusWhenNoHaiku
   * 优先级：sideAgent 显式值 > legacy 字段 > 默认值
   */
  private mergeSideAgentConfig(source: RunModeConfig | AssistantConfig): SideAgentConfig {
    const explicit = source.sideAgent ?? {};
    const legacyExplore = (source as any).claudeExploreUseHaiku as boolean | undefined;
    const legacyFallback = (source as any).claudeFallbackToOpusWhenNoHaiku as boolean | undefined;

    return {
      enabled: explicit.enabled ?? DEFAULT_SIDE_AGENT_ENABLED,
      providerId: explicit.providerId,
      model: explicit.model,
      features: {
        explore: explicit.features?.explore ?? legacyExplore ?? DEFAULT_SIDE_AGENT_FEATURES.explore,
        toolUseSummary: explicit.features?.toolUseSummary ?? DEFAULT_SIDE_AGENT_FEATURES.toolUseSummary,
        sessionTitle: explicit.features?.sessionTitle ?? DEFAULT_SIDE_AGENT_FEATURES.sessionTitle,
      },
      claudeFallbackToOpusWhenNoHaiku: explicit.claudeFallbackToOpusWhenNoHaiku ?? legacyFallback ?? false,
    };
  }

  /**
   * 获取协作配置
   */
  getConfig(): AssistantConfig {
    const config = loadConfig();
    const scoped = this.readScopedRunModeConfig(config);

    if (scoped) {
      return {
        mainAgent: scoped.mainAgent,
        taskAgent: scoped.taskAgent,
        workerPool: scoped.workerPool ?? [],
        maxConcurrent: scoped.maxConcurrent,
        collaborationMode: scoped.collaborationMode ?? 'flexible',
        claudeExploreUseHaiku: scoped.claudeExploreUseHaiku ?? DEFAULT_CLAUDE_EXPLORE_USE_HAIKU,
        claudeFallbackToOpusWhenNoHaiku: scoped.claudeFallbackToOpusWhenNoHaiku ?? DEFAULT_CLAUDE_OPUS_FALLBACK_WHEN_NO_HAIKU,
        sideAgent: this.mergeSideAgentConfig(scoped),
        createdAt: scoped.createdAt,
        updatedAt: scoped.updatedAt,
      };
    }

    return this.readLegacyScopedConfig(config);
  }

  /**
   * 保存协作配置
   */
  saveConfig(collabConfig: AssistantConfig): void {
    const config = loadConfig();
    const now = new Date().toISOString();

    const previousModeConfig = config.runConfig?.modes?.[this.scope] ?? {};
    const nextModeConfig: RunModeConfig = {
      ...previousModeConfig,
      mainAgent: collabConfig.mainAgent,
      taskAgent: collabConfig.taskAgent ?? previousModeConfig.taskAgent,
      workerPool: collabConfig.workerPool ?? [],
      maxConcurrent: collabConfig.maxConcurrent,
      collaborationMode: collabConfig.collaborationMode ?? 'flexible',
      claudeExploreUseHaiku: collabConfig.claudeExploreUseHaiku ?? previousModeConfig.claudeExploreUseHaiku ?? DEFAULT_CLAUDE_EXPLORE_USE_HAIKU,
      claudeFallbackToOpusWhenNoHaiku: collabConfig.claudeFallbackToOpusWhenNoHaiku ?? previousModeConfig.claudeFallbackToOpusWhenNoHaiku ?? DEFAULT_CLAUDE_OPUS_FALLBACK_WHEN_NO_HAIKU,
      sideAgent: collabConfig.sideAgent ?? previousModeConfig.sideAgent,
      updatedAt: now,
      createdAt: previousModeConfig.createdAt || now,
    };

    config.runConfig = {
      ...(config.runConfig ?? {}),
      modes: {
        ...(config.runConfig?.modes ?? {}),
        [this.scope]: nextModeConfig,
      },
    };

    saveConfig(config);
  }

  /**
   * 获取 Main Agent 配置
   * 如果未配置，返回当前默认 provider 的模型
   */
  getMainAgent(): AgentModelRef | undefined {
    const config = this.getConfig();
    if (config.mainAgent) {
      return config.mainAgent;
    }
    // 默认使用当前 provider
    const defaultProvider = this.providerStore.getDefaultProvider();
    if (defaultProvider) {
      return {
        providerId: defaultProvider.id,
        model: defaultProvider.lastSelectedModel || defaultProvider.defaultModel || defaultProvider.models[0]?.name,
      };
    }
    return undefined;
  }

  /**
   * 设置 Main Agent 模型
   */
  setMainAgent(ref: AgentModelRef): void {
    const config = this.getConfig();
    config.mainAgent = ref;
    this.saveConfig(config);
  }

  /**
   * 获取 Supervisor Agent 配置
   */
  getSupervisorAgent(): AgentModelRef | undefined {
    const config = this.getConfig();
    return config.supervisorAgent;
  }

  /**
   * 设置 Supervisor Agent 模型
   */
  setSupervisorAgent(ref: AgentModelRef): void {
    const config = this.getConfig();
    config.supervisorAgent = ref;
    this.saveConfig(config);
  }

  /**
   * 获取 Worker 模型池
   */
  getWorkerPool(): WorkerModelEntry[] {
    const config = this.getConfig();
    return config.workerPool || [];
  }

  /**
   * 获取最大并发 Worker 数
   */
  getMaxConcurrent(): number | undefined {
    const config = this.getConfig();
    return typeof config.maxConcurrent === 'number' && Number.isFinite(config.maxConcurrent)
      ? config.maxConcurrent
      : undefined;
  }

  /**
   * 设置最大并发 Worker 数
   */
  setMaxConcurrent(maxConcurrent?: number): void {
    const config = this.getConfig();
    if (typeof maxConcurrent === 'number' && Number.isFinite(maxConcurrent) && maxConcurrent > 0) {
      config.maxConcurrent = Math.floor(maxConcurrent);
    } else {
      delete config.maxConcurrent;
    }
    this.saveConfig(config);
  }

  getCollaborationMode(): AssistantCollaborationMode {
    const config = this.getConfig();
    return config.collaborationMode === 'organization' ? 'organization' : 'flexible';
  }

  setCollaborationMode(mode: AssistantCollaborationMode): void {
    const config = this.getConfig();
    config.collaborationMode = mode;
    this.saveConfig(config);
  }

  /**
   * 设置 Worker 模型池
   */
  setWorkerPool(pool: WorkerModelEntry[]): void {
    const config = this.getConfig();
    config.workerPool = pool;
    this.saveConfig(config);
  }

  /**
   * 添加模型到 Worker 池
   */
  addWorkerModel(providerId: string, model: string, enabled = true): void {
    const pool = this.getWorkerPool();
    // 检查是否已存在
    const exists = pool.some(e => e.providerId === providerId && e.model === model);
    if (exists) {
      return;
    }

    // 获取模型 traits
    const traits = this.getModelTraits(model);

    pool.push({
      providerId,
      model,
      enabled,
      traits,
    });
    this.setWorkerPool(pool);
  }

  /**
   * 从 Worker 池移除模型
   */
  removeWorkerModel(providerId: string, model: string): void {
    const pool = this.getWorkerPool();
    const filtered = pool.filter(e => !(e.providerId === providerId && e.model === model));
    this.setWorkerPool(filtered);
  }

  /**
   * 切换 Worker 模型启用状态
   */
  toggleWorkerModel(providerId: string, model: string): void {
    const pool = this.getWorkerPool();
    const entry = pool.find(e => e.providerId === providerId && e.model === model);
    if (entry) {
      entry.enabled = !entry.enabled;
      this.setWorkerPool(pool);
    }
  }

  /**
   * 获取启用的 Worker 模型
   */
  getEnabledWorkerModels(): WorkerModelEntry[] {
    return this.getWorkerPool().filter(e => e.enabled);
  }

  /**
   * 从已配置的 Providers 获取所有可用模型
   */
  getAvailableModels(): Array<{ providerId: string; providerName: string; model: string; traits: string[] }> {
    const providers = this.providerStore.getProviders();
    const result: Array<{ providerId: string; providerName: string; model: string; traits: string[] }> = [];

    for (const provider of providers) {
      for (const modelConfig of provider.models) {
        const traits = this.getModelTraits(modelConfig.name);
        result.push({
          providerId: provider.id,
          providerName: provider.name,
          model: modelConfig.name,
          traits,
        });
      }
    }

    return result;
  }

  /**
   * 根据任务需求选择最佳 Worker 模型
   * LLM 会调用这个方法来选择合适的模型
   */
  selectWorkerByTraits(requiredTraits: string[]): WorkerModelEntry | undefined {
    const enabledModels = this.getEnabledWorkerModels();
    if (enabledModels.length === 0) {
      return undefined;
    }

    // 计算每个模型的匹配分数
    const scored = enabledModels.map(entry => {
      const modelTraits = entry.traits || [];
      const matchCount = requiredTraits.filter(t => modelTraits.includes(t)).length;
      return { entry, score: matchCount };
    });

    // 按分数排序，取最高的
    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.entry;
  }

  /**
   * 从内置配置或 ModelRegistry 获取模型的 traits
   * 优先级：内置配置 > ModelRegistry 自动推断
   */
  private getModelTraits(modelName: string): string[] {
    //  优先使用内置 traits
    if (BUILTIN_MODEL_TRAITS[modelName]) {
      return [...BUILTIN_MODEL_TRAITS[modelName]];
    }

    //  尝试模糊匹配（处理版本号差异）
    const normalizedName = modelName.toLowerCase();
    for (const [key, traits] of Object.entries(BUILTIN_MODEL_TRAITS)) {
      if (normalizedName.includes(key.toLowerCase()) || key.toLowerCase().includes(normalizedName)) {
        return [...traits];
      }
    }

    // 回退到 ModelRegistry 自动推断
    const metadata = modelRegistry.getModel(modelName);
    if (!metadata) {
      return [];
    }

    const traits: string[] = [];
    const scores = metadata.scores || {};

    // 根据评分生成 traits
    if ((scores.coding ?? 0) >= 85) traits.push('coding');
    if ((scores.reasoning ?? 0) >= 85) traits.push('reasoning');
    if ((scores.vision ?? 0) >= 80) traits.push('vision');
    if ((scores.creativity ?? 0) >= 85) traits.push('creative');
    if ((scores.speed ?? 0) >= 85) traits.push('fast');
    if ((scores.cost ?? 0) >= 85) traits.push('low-cost');

    // 根据特性添加 traits
    if (metadata.supportsThinking) traits.push('thinking');
    if (metadata.supportsVision) traits.push('multimodal');
    if (metadata.maxInputTokens >= 500000) traits.push('long-context');

    return traits;
  }

  /**
   *  更新 Worker 模型的 traits（用户自定义）
   */
  updateWorkerTraits(providerId: string, model: string, traits: string[]): void {
    const pool = this.getWorkerPool();
    const entry = pool.find(e => e.providerId === providerId && e.model === model);
    if (entry) {
      entry.traits = traits;
      this.setWorkerPool(pool);
    }
  }

  /**
   *  添加 traits 到现有 Worker 模型
   */
  addWorkerTraits(providerId: string, model: string, newTraits: string[]): void {
    const pool = this.getWorkerPool();
    const entry = pool.find(e => e.providerId === providerId && e.model === model);
    if (entry) {
      const existingTraits = entry.traits || [];
      const merged = [...new Set([...existingTraits, ...newTraits])];
      entry.traits = merged;
      this.setWorkerPool(pool);
    }
  }

  /**
   * 初始化默认配置
   * 将当前 provider 的所有模型添加到 worker pool
   */
  initializeDefaults(): void {
    const config = this.getConfig();
    if (config.workerPool.length > 0) {
      // 已有配置，不覆盖
      return;
    }

    const defaultProvider = this.providerStore.getDefaultProvider();
    if (!defaultProvider) {
      return;
    }

    // 添加当前 provider 的所有模型到 worker pool
    const pool: WorkerModelEntry[] = defaultProvider.models.map((m, i) => ({
      providerId: defaultProvider.id,
      model: m.name,
      enabled: i === 0, // 只启用第一个
      traits: this.getModelTraits(m.name),
    }));

    this.setWorkerPool(pool);
  }
}
