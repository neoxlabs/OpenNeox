import type { ModelCapability } from '@neoxlabs/platform/utils/config.js';

/**
 * 预设的模型能力配置
 * 包含各个模型的能力评分和特性
 */
export const MODEL_CAPABILITIES: Record<string, ModelCapability> = {
  'claude-opus': {
    modelAlias: 'claude-opus',
    strengths: ['coding', 'reasoning', 'code_review', 'debugging'],
    scores: {
      coding: 98,
      reasoning: 95,
      vision: 85,
      creativity: 90,
      speed: 60,
      cost: 30, // 成本高=分数低
    },
    features: {
      supportsVision: true,
      supportsTools: true,
      supportsFunctionCalling: true,
      supportsStreaming: true,
      maxContextTokens: 200000,
      maxOutputTokens: 32000,
    },
  },

  'claude-sonnet': {
    modelAlias: 'claude-sonnet',
    strengths: ['coding', 'general_qa', 'summarization'],
    scores: {
      coding: 92,
      reasoning: 88,
      vision: 85,
      creativity: 85,
      speed: 80,
      cost: 60,
    },
    features: {
      supportsVision: true,
      supportsTools: true,
      supportsFunctionCalling: true,
      supportsStreaming: true,
      maxContextTokens: 200000,
      maxOutputTokens: 16000,
    },
  },

  'claude-haiku': {
    modelAlias: 'claude-haiku',
    strengths: ['general_qa', 'summarization', 'translation'],
    scores: {
      coding: 75,
      reasoning: 70,
      vision: 80,
      creativity: 70,
      speed: 95, // 速度最快
      cost: 95, // 成本最低
    },
    features: {
      supportsVision: true,
      supportsTools: true,
      supportsFunctionCalling: true,
      supportsStreaming: true,
      maxContextTokens: 200000,
      maxOutputTokens: 8000,
    },
  },

  'gemini-2.5-pro': {
    modelAlias: 'gemini-2.5-pro',
    strengths: ['image_analysis', 'data_analysis', 'reasoning'],
    scores: {
      coding: 85,
      reasoning: 90,
      vision: 95, // 图像分析最强
      creativity: 80,
      speed: 85,
      cost: 70,
    },
    features: {
      supportsVision: true,
      supportsTools: true,
      supportsFunctionCalling: true,
      supportsStreaming: true,
      maxContextTokens: 1000000,
      maxOutputTokens: 65536,
    },
  },

  'gemini-2.0-flash': {
    modelAlias: 'gemini-2.0-flash',
    strengths: ['image_analysis', 'general_qa', 'summarization'],
    scores: {
      coding: 80,
      reasoning: 82,
      vision: 90,
      creativity: 75,
      speed: 90,
      cost: 85,
    },
    features: {
      supportsVision: true,
      supportsTools: true,
      supportsFunctionCalling: true,
      supportsStreaming: true,
      maxContextTokens: 1000000,
      maxOutputTokens: 8192,
    },
  },

  'o3': {
    modelAlias: 'o3',
    strengths: ['reasoning', 'debugging', 'data_analysis'],
    scores: {
      coding: 90,
      reasoning: 99, // 推理最强
      vision: 70,
      creativity: 75,
      speed: 40, // 较慢
      cost: 20, // 成本很高
    },
    features: {
      supportsVision: false,
      supportsTools: true,
      supportsFunctionCalling: true,
      supportsStreaming: true,
      maxContextTokens: 128000,
      maxOutputTokens: 32000,
    },
  },

  'o1': {
    modelAlias: 'o1',
    strengths: ['reasoning', 'debugging', 'data_analysis'],
    scores: {
      coding: 88,
      reasoning: 95,
      vision: 70,
      creativity: 75,
      speed: 45,
      cost: 25,
    },
    features: {
      supportsVision: false,
      supportsTools: true,
      supportsFunctionCalling: true,
      supportsStreaming: true,
      maxContextTokens: 128000,
      maxOutputTokens: 32000,
    },
  },

  'gpt-4o': {
    modelAlias: 'gpt-4o',
    strengths: ['coding', 'general_qa', 'creative_writing'],
    scores: {
      coding: 88,
      reasoning: 85,
      vision: 88,
      creativity: 88,
      speed: 75,
      cost: 50,
    },
    features: {
      supportsVision: true,
      supportsTools: true,
      supportsFunctionCalling: true,
      supportsStreaming: true,
      maxContextTokens: 128000,
      maxOutputTokens: 16384,
    },
  },

  'gpt-4o-mini': {
    modelAlias: 'gpt-4o-mini',
    strengths: ['general_qa', 'summarization', 'translation'],
    scores: {
      coding: 75,
      reasoning: 72,
      vision: 80,
      creativity: 75,
      speed: 92,
      cost: 90,
    },
    features: {
      supportsVision: true,
      supportsTools: true,
      supportsFunctionCalling: true,
      supportsStreaming: true,
      maxContextTokens: 128000,
      maxOutputTokens: 16384,
    },
  },

  'gpt-4-turbo': {
    modelAlias: 'gpt-4-turbo',
    strengths: ['coding', 'reasoning', 'creative_writing'],
    scores: {
      coding: 90,
      reasoning: 87,
      vision: 85,
      creativity: 90,
      speed: 70,
      cost: 40,
    },
    features: {
      supportsVision: true,
      supportsTools: true,
      supportsFunctionCalling: true,
      supportsStreaming: true,
      maxContextTokens: 128000,
      maxOutputTokens: 4096,
    },
  },

  'deepseek-chat': {
    modelAlias: 'deepseek-chat',
    strengths: ['coding', 'reasoning', 'data_analysis'],
    scores: {
      coding: 85,
      reasoning: 82,
      vision: 0, // 不支持视觉
      creativity: 75,
      speed: 85,
      cost: 95, // 成本极低
    },
    features: {
      supportsVision: false,
      supportsTools: true,
      supportsFunctionCalling: true,
      supportsStreaming: true,
      maxContextTokens: 64000,
      maxOutputTokens: 8000,
    },
  },

  'deepseek-coder': {
    modelAlias: 'deepseek-coder',
    strengths: ['coding', 'code_review', 'debugging'],
    scores: {
      coding: 95, // 代码能力突出
      reasoning: 80,
      vision: 0,
      creativity: 70,
      speed: 85,
      cost: 95,
    },
    features: {
      supportsVision: false,
      supportsTools: true,
      supportsFunctionCalling: true,
      supportsStreaming: true,
      maxContextTokens: 64000,
      maxOutputTokens: 8000,
    },
  },
};

/**
 * ModelCapabilityManager - 模型能力管理器
 * 提供查询和管理模型能力的方法
 */
export class ModelCapabilityManager {
  private capabilities: Map<string, ModelCapability>;

  constructor(customCapabilities?: Record<string, ModelCapability>) {
    // 合并预设能力和自定义能力
    const allCapabilities = { ...MODEL_CAPABILITIES, ...customCapabilities };
    this.capabilities = new Map(Object.entries(allCapabilities));
  }

  /**
   * 获取指定模型的能力配置
   */
  getCapability(modelAlias: string): ModelCapability | undefined {
    return this.capabilities.get(modelAlias);
  }

  /**
   * 检查模型是否支持视觉功能
   */
  supportsVision(modelAlias: string): boolean {
    const capability = this.capabilities.get(modelAlias);
    return capability?.features.supportsVision ?? false;
  }

  /**
   * 检查模型是否支持工具调用
   */
  supportsTools(modelAlias: string): boolean {
    const capability = this.capabilities.get(modelAlias);
    return capability?.features.supportsTools ?? false;
  }

  /**
   * 获取模型的最大上下文长度
   */
  getMaxContextTokens(modelAlias: string): number {
    const capability = this.capabilities.get(modelAlias);
    return capability?.features.maxContextTokens ?? 128000; // 默认值
  }

  /**
   * 获取所有支持指定任务类型的模型
   */
  getModelsForTaskType(taskType: string): ModelCapability[] {
    return Array.from(this.capabilities.values()).filter((cap) =>
      cap.strengths.includes(taskType as any)
    );
  }

  /**
   * 根据任务类型获取推荐模型（按评分排序）
   */
  getRecommendedModels(taskType: string, requiresVision: boolean = false): string[] {
    const scoreKey = this.getScoreKeyForTaskType(taskType);

    return Array.from(this.capabilities.values())
      .filter((cap) => {
        // 过滤：如果需要视觉能力，必须支持
        if (requiresVision && !cap.features.supportsVision) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        // 按相关评分排序
        const scoreA = a.scores[scoreKey] ?? 0;
        const scoreB = b.scores[scoreKey] ?? 0;
        return scoreB - scoreA;
      })
      .map((cap) => cap.modelAlias);
  }

  /**
   * 根据任务类型获取对应的评分键
   */
  private getScoreKeyForTaskType(
    taskType: string
  ): keyof ModelCapability['scores'] {
    const mapping: Record<string, keyof ModelCapability['scores']> = {
      coding: 'coding',
      code_review: 'coding',
      debugging: 'coding',
      image_analysis: 'vision',
      reasoning: 'reasoning',
      data_analysis: 'reasoning',
      creative_writing: 'creativity',
      translation: 'speed', // 翻译主要看速度
      summarization: 'speed', // 总结主要看速度
      general_qa: 'reasoning',
    };

    return mapping[taskType] ?? 'reasoning';
  }

  /**
   * 添加或更新模型能力配置
   */
  setCapability(modelAlias: string, capability: ModelCapability): void {
    this.capabilities.set(modelAlias, capability);
  }

  /**
   * 获取所有已注册的模型别名
   */
  getAllModelAliases(): string[] {
    return Array.from(this.capabilities.keys());
  }

  /**
   * 检查模型是否已注册
   */
  hasModel(modelAlias: string): boolean {
    return this.capabilities.has(modelAlias);
  }

  /**
   * 获取所有能力配置
   */
  getAllCapabilities(): ModelCapability[] {
    return Array.from(this.capabilities.values());
  }
}
