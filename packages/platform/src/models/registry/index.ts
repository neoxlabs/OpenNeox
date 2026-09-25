/**
 * 统一模型注册中心
 *
 * 集中管理所有 LLM 模型的完整信息,包括:
 * - Token 限制 (输入/输出)
 * - 能力评分
 * - 特性支持
 * - 定价信息
 *
 *  这是模型信息的单一真实来源 (Single Source of Truth)
 *
 * 参考来源:
 * - OpenAI Codex (Apache-2.0): codex-rs/core/src/openai_model_info.rs
 * - OpenAI Platform: https://platform.openai.com/docs/models
 * - Anthropic Docs: https://docs.anthropic.com/en/docs/about-claude/models/overview
 * - Google AI: https://ai.google.dev/gemini-api/docs/models
 * - DeepSeek Docs: https://api-docs.deepseek.com/
 * - Qwen/DashScope Docs: https://help.aliyun.com/zh/model-studio/
 * - Kimi Docs: https://platform.moonshot.cn/docs/
 * - MiniMax Docs: https://www.minimaxi.com/docs
 * - GLM Docs: https://docs.bigmodel.cn/
 * - Doubao/Volcengine Docs: https://www.volcengine.com/docs/
 */

import type { ModelCapability, TaskType } from '../../utils/config.js';

// ============================================================================
// 模型元数据接口
// ============================================================================

/** 模型完整元数据 */
export interface ModelMetadata {
  /** 模型 ID (唯一标识) */
  id: string;
  /** 显示名称 */
  displayName: string;
  /** Provider 协议类型 */
  provider: 'openai' | 'anthropic' | 'gemini' | 'doubao' | 'kimi' | 'deepseek' | 'minimax' | 'glm' | 'qwen' | 'xai'
    /* 这三家必须显式列在联合类型里: 一旦漏掉, protocolModels 会把它们的协议
     * 归并成 'openai'，导致选择 Mistral 时下拉框里出现的却是一整列 GPT 模型。 */
    | 'mistral' | 'groq' | 'together';
  /** 模型别名 (用于路由匹配) */
  aliases?: string[];

  // Token 限制
  /** 最大输入 tokens */
  maxInputTokens: number;
  /** 最大输出 tokens */
  maxOutputTokens: number;

  // 能力特性
  /** 支持视觉输入 */
  supportsVision?: boolean;
  /** 支持工具调用 */
  supportsTools?: boolean;
  /** 支持函数调用 */
  supportsFunctionCalling?: boolean;
  /** 支持流式输出 */
  supportsStreaming?: boolean;
  /** 支持思考模式 (推理过程可见) */
  supportsThinking?: boolean;

  // 能力评分 (0-100)
  scores?: {
    coding?: number;
    reasoning?: number;
    vision?: number;
    creativity?: number;
    speed?: number;
    cost?: number;  // 成本越低分数越高
  };

  // 元信息
  /** 发布日期 */
  releaseDate?: string;
  /** 是否已弃用 */
  deprecated?: boolean;
  /** 替代模型 ID */
  replacedBy?: string;
  /** 备注说明 */
  notes?: string;
}

// ============================================================================
// OpenAI / GPT 模型注册表
// ============================================================================

export const OPENAI_MODELS: Record<string, ModelMetadata> = {
  // ========== GPT-5 系列 ==========

  'gpt-5.6-sol': {
    id: 'gpt-5.6-sol',
    displayName: 'GPT-5.6 Sol',
    provider: 'openai',
    aliases: ['gpt5.6-sol', 'gpt-5-6-sol', 'gpt-5.6-sol-2026-07-09'],
    /* The registry uses a 372K input window for this model. The value separates successful
     * requests near 372K from the provider's context-length rejection and keeps compaction
     * thresholds aligned with the model contract. */
    maxInputTokens: 372000,
    maxOutputTokens: 128000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 100,
      reasoning: 100,
      vision: 97,
      creativity: 98,
      speed: 70,
      cost: 15,
    },
    releaseDate: '2026-07-09',
    notes: 'OpenAI GPT-5.6 Sol 旗舰模型，372K 上下文，支持 max/ultra 推理档（ultra=自动任务委派）',
  },

  'gpt-5.6-terra': {
    id: 'gpt-5.6-terra',
    displayName: 'GPT-5.6 Terra',
    provider: 'openai',
    aliases: ['gpt5.6-terra', 'gpt-5-6-terra', 'gpt-5.6-terra-2026-07-09'],
    /* GPT-5.6 variants share the 372K input-window contract. */
    maxInputTokens: 372000,
    maxOutputTokens: 128000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 99,
      reasoning: 99,
      vision: 96,
      creativity: 97,
      speed: 78,
      cost: 20,
    },
    releaseDate: '2026-07-09',
    notes: 'OpenAI GPT-5.6 Terra，372K 上下文，支持 max/ultra 推理档',
  },

  'gpt-5.6-luna': {
    id: 'gpt-5.6-luna',
    displayName: 'GPT-5.6 Luna',
    provider: 'openai',
    aliases: ['gpt5.6-luna', 'gpt-5-6-luna', 'gpt-5.6-luna-2026-07-09'],
    /* GPT-5.6 variants share the 372K input-window contract. */
    maxInputTokens: 372000,
    maxOutputTokens: 128000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 96,
      reasoning: 95,
      vision: 94,
      creativity: 94,
      speed: 88,
      cost: 40,
    },
    releaseDate: '2026-07-09',
    notes: 'OpenAI GPT-5.6 Luna 轻量档，372K 上下文，支持 max 推理档（不支持 ultra）',
  },

  'gpt-5.5': {
    id: 'gpt-5.5',
    displayName: 'GPT-5.5',
    provider: 'openai',
    aliases: ['gpt5.5', 'gpt-5-5', 'gpt-5.5-2026-04-23', 'gpt-5.5-neox'],
    maxInputTokens: 272000,
    maxOutputTokens: 128000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 99,
      reasoning: 99,
      vision: 96,
      creativity: 97,
      speed: 74,
      cost: 18,
    },
    releaseDate: '2026-04-23',
    notes: 'OpenAI GPT-5.5 模型，272K 上下文窗口，128K 输出限制',
  },

  'gpt-5.5-pro': {
    id: 'gpt-5.5-pro',
    displayName: 'GPT-5.5 Pro',
    provider: 'openai',
    aliases: ['gpt-5.5-pro-2026-04-23', 'gpt-5-5-pro'],
    maxInputTokens: 272000,
    maxOutputTokens: 128000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: false,
    scores: {
      coding: 100,
      reasoning: 100,
      vision: 96,
      creativity: 98,
      speed: 55,
      cost: 8,
    },
    releaseDate: '2026-04-23',
    notes: 'OpenAI GPT-5.5 Pro 模型，272K 上下文窗口，面向高精度复杂推理',
  },

  'gpt-5.4': {
    id: 'gpt-5.4',
    displayName: 'GPT-5.4',
    provider: 'openai',
    aliases: ['gpt5.4', 'gpt-5.4-2026-03-05', 'gpt-5.4-neox'],
    maxInputTokens: 1000000,
    maxOutputTokens: 128000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 98,
      reasoning: 99,
      vision: 95,
      creativity: 96,
      speed: 76,
      cost: 20,
    },
    releaseDate: '2026-03-05',
    notes: 'OpenAI 官方 GPT-5.4 模型，1M 上下文窗口，128K 输出限制',
  },

  'gpt-5.4-pro': {
    id: 'gpt-5.4-pro',
    displayName: 'GPT-5.4 Pro',
    provider: 'openai',
    aliases: ['gpt-5.4-pro-2026-03-05', 'gpt-5-4-pro'],
    maxInputTokens: 1000000,
    maxOutputTokens: 128000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 99,
      reasoning: 100,
      vision: 95,
      creativity: 97,
      speed: 55,
      cost: 8,
    },
    releaseDate: '2026-03-05',
    notes: 'OpenAI 官方 GPT-5.4 Pro 模型，Responses API 优先的高精度推理模型',
  },

  'gpt-5.4-mini': {
    id: 'gpt-5.4-mini',
    displayName: 'GPT-5.4 Mini',
    provider: 'openai',
    aliases: ['gpt-5.4-mini-2026-03-17', 'gpt-5-4-mini'],
    maxInputTokens: 400000,
    maxOutputTokens: 128000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 95,
      reasoning: 96,
      vision: 92,
      creativity: 92,
      speed: 84,
      cost: 55,
    },
    releaseDate: '2026-03-17',
    notes: 'OpenAI 官方 GPT-5.4 mini 模型，400K 上下文，适合 BYOK 默认轻量模型',
  },

  'gpt-5.4-nano': {
    id: 'gpt-5.4-nano',
    displayName: 'GPT-5.4 Nano',
    provider: 'openai',
    aliases: ['gpt-5.4-nano-2026-03-17', 'gpt-5-4-nano'],
    maxInputTokens: 400000,
    maxOutputTokens: 128000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 88,
      reasoning: 90,
      vision: 88,
      creativity: 86,
      speed: 96,
      cost: 90,
    },
    releaseDate: '2026-03-17',
    notes: 'OpenAI 官方 GPT-5.4 nano 模型，400K 上下文，低成本高速场景',
  },

  'gpt-5.3': {
    id: 'gpt-5.3',
    displayName: 'GPT-5.3',
    provider: 'openai',
    aliases: ['gpt5.3', 'gpt-5.3-neox'],
    maxInputTokens: 400000,
    maxOutputTokens: 128000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 97,
      reasoning: 99,
      vision: 93,
      creativity: 95,
      speed: 74,
      cost: 22,
    },
    releaseDate: '2026-02-27',
    notes: 'Neox 预置 GPT-5.3，400K 上下文窗口',
  },

  'gpt-5.3-codex': {
    id: 'gpt-5.3-codex',
    displayName: 'GPT-5.3 Codex',
    provider: 'openai',
    aliases: ['gpt-5.3-codex-max', 'gpt-5.3-codex-high'],
    maxInputTokens: 400000,
    maxOutputTokens: 128000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 99,
      reasoning: 99,
      vision: 92,
      creativity: 94,
      speed: 70,
      cost: 18,
    },
    releaseDate: '2026-02-27',
    notes: 'OpenAI 官方 GPT-5.3-Codex 模型，面向 Codex 或类似 agentic coding 环境',
  },

  'gpt-5.2': {
    id: 'gpt-5.2',
    displayName: 'GPT-5.2',
    provider: 'openai',
    maxInputTokens: 400000,  // 400K 上下文
    maxOutputTokens: 128000,  // 128K max output (官方规格)
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 96,
      reasoning: 98,
      vision: 92,
      creativity: 94,
      speed: 75,
      cost: 25,
    },
    releaseDate: '2025-12-11',
    notes: '400K 上下文窗口,128K 输出限制,代号"Garlic"',
  },

  'gpt-5.2-codex': {
    id: 'gpt-5.2-codex',
    displayName: 'GPT-5.2 Codex',
    provider: 'openai',
    aliases: ['gpt-5.2-codex'],
    maxInputTokens: 400000,
    maxOutputTokens: 128000,  // 128K max output (官方规格)
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 98,  // 代码能力最强
      reasoning: 97,
      vision: 90,
      creativity: 92,
      speed: 70,
      cost: 20,
    },
    releaseDate: '2025-12-10',
    deprecated: true,
    replacedBy: 'gpt-5.5',
    notes: '历史兼容项；未在 OpenAI 公开 API 模型页确认，不进入默认 BYOK 列表',
  },

  'gpt-5.2-codex-high': {
    id: 'gpt-5.2-codex-high',
    displayName: 'GPT-5.2 Codex High',
    provider: 'openai',
    aliases: ['gpt-5.2-codex-h'],
    maxInputTokens: 400000,
    maxOutputTokens: 128000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 99,  // 最高代码能力
      reasoning: 98,
      vision: 90,
      creativity: 93,
      speed: 60,
      cost: 15,
    },
    releaseDate: '2025-12-10',
    deprecated: true,
    replacedBy: 'gpt-5.5',
    notes: '历史兼容项；未在 OpenAI 公开 API 模型页确认，不进入默认 BYOK 列表',
  },

  'gpt-5.2-codex-medium': {
    id: 'gpt-5.2-codex-medium',
    displayName: 'GPT-5.2 Codex Medium',
    provider: 'openai',
    aliases: ['gpt-5.2-codex-m'],
    maxInputTokens: 400000,
    maxOutputTokens: 128000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 95,
      reasoning: 94,
      vision: 88,
      creativity: 90,
      speed: 80,
      cost: 40,
    },
    releaseDate: '2025-12-10',
    deprecated: true,
    replacedBy: 'gpt-5.4-mini',
    notes: '历史兼容项；未在 OpenAI 公开 API 模型页确认，不进入默认 BYOK 列表',
  },

  'gpt-5.1': {
    id: 'gpt-5.1',
    displayName: 'GPT-5.1',
    provider: 'openai',
    maxInputTokens: 272000,  // 272K 上下文 (官方规格)
    maxOutputTokens: 128000,  // 128K max output (官方规格)
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 94,
      reasoning: 96,
      vision: 90,
      creativity: 92,
      speed: 80,
      cost: 30,
    },
    notes: '272K 上下文,128K 输出,适合长上下文任务',
  },

  'gpt-5.1-codex': {
    id: 'gpt-5.1-codex',
    displayName: 'GPT-5.1 Codex',
    provider: 'openai',
    aliases: ['gpt-5-codex', 'gpt-5.1-codex-max'],
    maxInputTokens: 400000,  // 400K 上下文 (Codex 版本)
    maxOutputTokens: 128000,  // 128K max output
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 97,
      reasoning: 95,
      vision: 88,
      creativity: 90,
      speed: 75,
      cost: 25,
    },
    deprecated: true,
    replacedBy: 'gpt-5.5',
    notes: '历史兼容项；未在 OpenAI 公开 API 模型页确认，不进入默认 BYOK 列表',
  },

  'gpt-5.1-codex-mini': {
    id: 'gpt-5.1-codex-mini',
    displayName: 'GPT-5.1 Codex Mini',
    provider: 'openai',
    aliases: ['gpt-5-codex-mini'],
    maxInputTokens: 272000,
    maxOutputTokens: 128000,  // 128K max output
    supportsVision: false,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 90,
      reasoning: 88,
      vision: 0,
      creativity: 85,
      speed: 92,
      cost: 85,
    },
    deprecated: true,
    replacedBy: 'gpt-5.4-mini',
    notes: '历史兼容项；未在 OpenAI 公开 API 模型页确认，不进入默认 BYOK 列表',
  },

  'gpt-5': {
    id: 'gpt-5',
    displayName: 'GPT-5',
    provider: 'openai',
    maxInputTokens: 400000,  // 400K 上下文
    maxOutputTokens: 128000,  // 128K max output
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 92,
      reasoning: 94,
      vision: 90,
      creativity: 94,
      speed: 80,
      cost: 35,
    },
    deprecated: true,
    replacedBy: 'gpt-5.1',
    notes: '已被 GPT-5.1 替代',
  },

  // ========== GPT-4.1 系列 (超大上下文) ==========

  'gpt-4.1': {
    id: 'gpt-4.1',
    displayName: 'GPT-4.1',
    provider: 'openai',
    aliases: ['gpt-4.1-2025-04-14'],
    maxInputTokens: 1000000,  // 1M 上下文 (官方规格)
    maxOutputTokens: 128000,  // 128K max output (推测)
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 90,
      reasoning: 92,
      vision: 88,
      creativity: 90,
      speed: 65,
      cost: 15,
    },
    releaseDate: '2025-04-14',
    notes: '超大 1M+ 上下文窗口,适合处理大型代码库',
  },

  // ========== GPT-4o 系列 ==========

  'gpt-4o': {
    id: 'gpt-4o',
    displayName: 'GPT-4o',
    provider: 'openai',
    aliases: ['gpt-4o-2024-11-20', 'gpt-4o-2024-08-06'],
    maxInputTokens: 128000,
    maxOutputTokens: 16384,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 88,
      reasoning: 85,
      vision: 88,
      creativity: 88,
      speed: 75,
      cost: 50,
    },
    deprecated: true,
    replacedBy: 'gpt-5.4-mini',
  },

  'gpt-4o-mini': {
    id: 'gpt-4o-mini',
    displayName: 'GPT-4o Mini',
    provider: 'openai',
    aliases: ['gpt-4o-mini-2024-07-18'],
    maxInputTokens: 128000,
    maxOutputTokens: 16384,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 75,
      reasoning: 72,
      vision: 80,
      creativity: 75,
      speed: 92,
      cost: 90,
    },
    deprecated: true,
    replacedBy: 'gpt-5.4-nano',
  },

  // ========== o 系列 (推理模型) ==========

  'o3': {
    id: 'o3',
    displayName: 'o3',
    provider: 'openai',
    maxInputTokens: 200000,
    maxOutputTokens: 100000,
    supportsVision: false,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: {
      coding: 92,
      reasoning: 99,
      vision: 0,
      creativity: 78,
      speed: 40,
      cost: 15,
    },
    notes: '新一代推理模型,推理能力最强',
  },

  'o3-mini': {
    id: 'o3-mini',
    displayName: 'o3 Mini',
    provider: 'openai',
    aliases: ['o3-mini-2025-01-31'],
    maxInputTokens: 200000,
    maxOutputTokens: 100000,
    supportsVision: false,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: {
      coding: 88,
      reasoning: 95,
      vision: 0,
      creativity: 75,
      speed: 65,
      cost: 60,
    },
    deprecated: true,
    replacedBy: 'o4-mini',
  },

  'o4-mini': {
    id: 'o4-mini',
    displayName: 'o4 Mini',
    provider: 'openai',
    maxInputTokens: 200000,
    maxOutputTokens: 100000,
    supportsVision: false,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: {
      coding: 90,
      reasoning: 96,
      vision: 0,
      creativity: 76,
      speed: 70,
      cost: 55,
    },
  },

  'o1': {
    id: 'o1',
    displayName: 'o1',
    provider: 'openai',
    aliases: ['o1-2024-12-17'],
    maxInputTokens: 200000,
    maxOutputTokens: 100000,
    supportsVision: false,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: {
      coding: 88,
      reasoning: 95,
      vision: 0,
      creativity: 75,
      speed: 45,
      cost: 25,
    },
    deprecated: true,
    replacedBy: 'o3',
  },

  'o1-mini': {
    id: 'o1-mini',
    displayName: 'o1 Mini',
    provider: 'openai',
    aliases: ['o1-mini-2024-09-12'],
    maxInputTokens: 128000,
    maxOutputTokens: 65536,
    supportsVision: false,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: {
      coding: 82,
      reasoning: 88,
      vision: 0,
      creativity: 70,
      speed: 70,
      cost: 70,
    },
    deprecated: true,
    replacedBy: 'o4-mini',
  },

  // ========== Codex 其他模型 ==========

  'codex-mini-latest': {
    id: 'codex-mini-latest',
    displayName: 'Codex Mini (Latest)',
    provider: 'openai',
    maxInputTokens: 200000,
    maxOutputTokens: 100000,
    supportsVision: false,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 85,
      reasoning: 82,
      vision: 0,
      creativity: 75,
      speed: 88,
      cost: 80,
    },
  },

  // ========== GPT-4 Turbo ==========

  'gpt-4-turbo': {
    id: 'gpt-4-turbo',
    displayName: 'GPT-4 Turbo',
    provider: 'openai',
    aliases: ['gpt-4-turbo-2024-04-09'],
    maxInputTokens: 128000,
    maxOutputTokens: 4096,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 90,
      reasoning: 87,
      vision: 85,
      creativity: 90,
      speed: 70,
      cost: 40,
    },
    deprecated: true,
    replacedBy: 'gpt-5.4-mini',
  },

  // ========== GPT-3.5 ==========

  'gpt-3.5-turbo': {
    id: 'gpt-3.5-turbo',
    displayName: 'GPT-3.5 Turbo',
    provider: 'openai',
    maxInputTokens: 16385,
    maxOutputTokens: 4096,
    supportsVision: false,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 65,
      reasoning: 60,
      vision: 0,
      creativity: 70,
      speed: 95,
      cost: 98,
    },
    deprecated: true,
    replacedBy: 'gpt-5.4-nano',
  },
};

// ============================================================================
// Anthropic / Claude 模型注册表
// ============================================================================

export const ANTHROPIC_MODELS: Record<string, ModelMetadata> = {
  /* Claude entries follow the provider model catalog. Keep API identifiers, context limits,
   * output limits, and lifecycle dates together so selection and capability checks use one record. */
  'claude-opus-5': {
    id: 'claude-opus-5',
    displayName: 'Claude Opus 5',
    provider: 'anthropic',
    aliases: ['opus-5', 'claude-opus5'],
    maxInputTokens: 1000000,
    maxOutputTokens: 128000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: { coding: 100, reasoning: 99, vision: 97, creativity: 96, speed: 72, cost: 25 },
    releaseDate: '2026-07-24',
    notes: '复杂 agentic 编码与企业场景的主力; 1M 上下文 / 128K 输出; adaptive thinking, 默认 effort=high',
  },

  'claude-sonnet-5': {
    id: 'claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    provider: 'anthropic',
    aliases: ['sonnet-5', 'claude-sonnet5'],
    maxInputTokens: 1000000,
    maxOutputTokens: 128000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: { coding: 95, reasoning: 94, vision: 95, creativity: 94, speed: 88, cost: 55 },
    releaseDate: '2026-06-30',
    notes: '速度与智能的平衡档; 1M 上下文 / 128K 输出',
  },

  // ========== Claude 5 / 4.8 系列 ==========

  'claude-fable-5': {
    id: 'claude-fable-5',
    displayName: 'Claude Fable 5',
    provider: 'anthropic',
    aliases: ['claude-fable-5-latest'],
    maxInputTokens: 1000000,
    maxOutputTokens: 128000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: {
      coding: 99,
      reasoning: 99,
      vision: 94,
      creativity: 97,
      speed: 68,
      cost: 18,
    },
    releaseDate: '2026-06',
    notes: 'Anthropic 官方 Claude Fable 5 模型，适合复杂 agent/coding 场景',
  },

  'claude-mythos-5': {
    id: 'claude-mythos-5',
    displayName: 'Claude Mythos 5',
    provider: 'anthropic',
    aliases: ['claude-mythos-5-latest'],
    maxInputTokens: 1000000,
    maxOutputTokens: 128000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: {
      coding: 98,
      reasoning: 99,
      vision: 94,
      creativity: 98,
      speed: 62,
      cost: 12,
    },
    releaseDate: '2026-06',
    notes: 'Anthropic 官方 Claude Mythos 5 模型，偏深度推理与创作',
  },

  'claude-opus-4-8': {
    id: 'claude-opus-4-8',
    displayName: 'Claude Opus 4.8',
    provider: 'anthropic',
    aliases: ['claude-opus-4.8', 'claude-opus-4-8-latest'],
    maxInputTokens: 1000000,
    maxOutputTokens: 128000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: {
      coding: 99,
      reasoning: 98,
      vision: 93,
      creativity: 96,
      speed: 66,
      cost: 16,
    },
    releaseDate: '2026-06',
    notes: 'Anthropic 官方 Claude Opus 4.8 模型',
  },

  'claude-opus-4-7': {
    id: 'claude-opus-4-7',
    displayName: 'Claude Opus 4.7',
    provider: 'anthropic',
    aliases: ['claude-opus-4.7', 'claude-opus-4-7-latest', 'claude-opus-4-7-20260416'],
    maxInputTokens: 1000000,
    maxOutputTokens: 128000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: {
      coding: 99,
      reasoning: 98,
      vision: 92,
      creativity: 96,
      speed: 66,
      cost: 16,
    },
    releaseDate: '2026-04',
    notes: 'Anthropic 官方 Claude Opus 4.7 模型，1M 上下文窗口',
  },

  // ========== Claude 4.6 系列 ==========

  'claude-opus-4-6': {
    id: 'claude-opus-4-6',
    displayName: 'Claude Opus 4.6',
    provider: 'anthropic',
    aliases: ['claude-opus-4.6', 'claude-opus-4-6-latest'],
    maxInputTokens: 1000000,
    maxOutputTokens: 128000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: {
      coding: 99,
      reasoning: 98,
      vision: 91,
      creativity: 96,
      speed: 66,
      cost: 18,
    },
    releaseDate: '2026-02-05',
    notes: 'Claude Opus 4.6（官方别名），1M 上下文窗口',
  },

  'claude-sonnet-4-6': {
    id: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    aliases: ['claude-sonnet-4.6', 'claude-sonnet-4-6-latest'],
    maxInputTokens: 1000000,
    maxOutputTokens: 64000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: {
      coding: 96,
      reasoning: 95,
      vision: 90,
      creativity: 93,
      speed: 78,
      cost: 45,
    },
    releaseDate: '2026-02-17',
    notes: 'Claude Sonnet 4.6（官方别名），1M 上下文窗口',
  },

  // ========== Claude 4.5 系列 (2025最新) ==========

  'claude-opus-4-5-20251101': {
    id: 'claude-opus-4-5-20251101',
    displayName: 'Claude Opus 4.5',
    provider: 'anthropic',
    aliases: ['claude-opus-4.5', 'claude-opus-4-5'],
    maxInputTokens: 200000,  // 标准 200K, 企业版 1M
    maxOutputTokens: 128000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,  // Extended Thinking 支持
    scores: {
      coding: 98,
      reasoning: 97,
      vision: 90,
      creativity: 95,
      speed: 65,
      cost: 20,
    },
    releaseDate: '2025-11-24',
    notes: '最强 Claude 模型,支持 Extended Thinking,企业版可扩展至 1M 上下文',
  },

  'claude-sonnet-4-5-20250929': {
    id: 'claude-sonnet-4-5-20250929',
    displayName: 'Claude Sonnet 4.5',
    provider: 'anthropic',
    aliases: [
      'claude-sonnet-4.5',
      'claude-sonnet-4-5',
      'claude-sonnet-4-5-20250929-thinking',
    ],
    maxInputTokens: 200000,  // 标准 200K, beta 1M
    maxOutputTokens: 64000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: {
      coding: 92,
      reasoning: 90,
      vision: 88,
      creativity: 90,
      speed: 80,
      cost: 50,
    },
    releaseDate: '2025-09-29',
    notes: '平衡性能与成本,beta 版本支持 1M 上下文',
  },

  'claude-sonnet-4-20250514': {
    id: 'claude-sonnet-4-20250514',
    displayName: 'Claude Sonnet 4',
    provider: 'anthropic',
    aliases: ['claude-sonnet-4'],
    maxInputTokens: 200000,  // 升级后支持 1M beta
    maxOutputTokens: 16000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 90,
      reasoning: 88,
      vision: 85,
      creativity: 88,
      speed: 82,
      cost: 55,
    },
    notes: '2025-08-12 升级支持 1M beta 上下文',
  },

  'claude-opus-4-20250514': {
    id: 'claude-opus-4-20250514',
    displayName: 'Claude Opus 4',
    provider: 'anthropic',
    aliases: ['claude-opus-4'],
    maxInputTokens: 200000,
    maxOutputTokens: 32000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 96,
      reasoning: 95,
      vision: 88,
      creativity: 94,
      speed: 70,
      cost: 25,
    },
  },

  'claude-haiku-4-5-20251001': {
    id: 'claude-haiku-4-5-20251001',
    displayName: 'Claude Haiku 4.5',
    provider: 'anthropic',
    aliases: ['claude-haiku-4.5', 'claude-haiku-4-5'],
    maxInputTokens: 200000,
    maxOutputTokens: 64000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: {
      coding: 78,
      reasoning: 75,
      vision: 80,
      creativity: 75,
      speed: 95,
      cost: 95,
    },
    releaseDate: '2025-10-01',
    notes: '最快最便宜的 Claude 4.5 模型',
  },

  // ========== Claude 3.5 系列 (2024最新版) ==========

  'claude-3-5-sonnet-20241022': {
    id: 'claude-3-5-sonnet-20241022',
    displayName: 'Claude 3.5 Sonnet (New)',
    provider: 'anthropic',
    aliases: ['claude-3.5-sonnet-new', 'claude-3-5-sonnet-latest'],
    maxInputTokens: 200000,
    maxOutputTokens: 16000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 90,
      reasoning: 88,
      vision: 85,
      creativity: 87,
      speed: 85,
      cost: 55,
    },
    releaseDate: '2024-10-22',
    deprecated: true,
    replacedBy: 'claude-sonnet-4-6',
    notes: 'Claude 3.5 Sonnet 升级版；保留为历史兼容项',
  },

  'claude-3-5-haiku-20241022': {
    id: 'claude-3-5-haiku-20241022',
    displayName: 'Claude 3.5 Haiku',
    provider: 'anthropic',
    aliases: ['claude-3.5-haiku'],
    maxInputTokens: 200000,
    maxOutputTokens: 8000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 75,
      reasoning: 72,
      vision: 78,
      creativity: 73,
      speed: 98,
      cost: 98,
    },
    releaseDate: '2024-10-22',
    deprecated: true,
    replacedBy: 'claude-haiku-4-5-20251001',
    notes: 'Claude 3.5 Haiku；保留为历史兼容项',
  },
};

// ============================================================================
// Google Gemini 模型注册表
// ============================================================================

export const GEMINI_MODELS: Record<string, ModelMetadata> = {
  /* Gemini entries use the provider model catalog's stable identifiers and published input/output
   * limits. Keep the limits explicit because capability checks and compaction depend on them. */
  'gemini-3.7-flash': {
    id: 'gemini-3.7-flash',
    displayName: 'Gemini 3.7 Flash',
    provider: 'gemini',
    aliases: ['gemini-3-7-flash'],
    maxInputTokens: 1048576,
    maxOutputTokens: 65536,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: { coding: 95, reasoning: 94, vision: 96, creativity: 92, speed: 92, cost: 82 },
    releaseDate: '2026-08',
    notes: 'Gemini 3.7 Flash — 软件工程 / 网页开发 / agentic 工作流较 3.6 有明显提升',
  },

  'gemini-3.6-flash': {
    id: 'gemini-3.6-flash',
    displayName: 'Gemini 3.6 Flash',
    provider: 'gemini',
    aliases: ['gemini-3-6-flash'],
    maxInputTokens: 1048576,
    maxOutputTokens: 65536,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: { coding: 92, reasoning: 91, vision: 95, creativity: 90, speed: 93, cost: 84 },
    releaseDate: '2026-07',
    notes: 'Gemini 3.6 Flash',
  },

  'gemini-3.5-flash-lite': {
    id: 'gemini-3.5-flash-lite',
    displayName: 'Gemini 3.5 Flash-Lite',
    provider: 'gemini',
    aliases: ['gemini-3-5-flash-lite'],
    maxInputTokens: 1048576,
    maxOutputTokens: 65536,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: { coding: 82, reasoning: 80, vision: 88, creativity: 80, speed: 97, cost: 94 },
    releaseDate: '2026-06',
    notes: 'Gemini 3.5 Flash-Lite — 最省的一档',
  },

  // ========== Gemini 3.5 / 3.1 系列 ==========

  'gemini-3.5-flash': {
    id: 'gemini-3.5-flash',
    displayName: 'Gemini 3.5 Flash',
    provider: 'gemini',
    aliases: ['gemini-3-flash-preview'],
    maxInputTokens: 1048576,
    maxOutputTokens: 65536,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 94,
      reasoning: 94,
      vision: 95,
      creativity: 91,
      speed: 94,
      cost: 72,
    },
    releaseDate: '2026-05',
    notes: 'Google AI 官方 Gemini 3.5 Flash stable ID，1,048,576 输入上下文',
  },

  'gemini-3.1-pro-preview': {
    id: 'gemini-3.1-pro-preview',
    displayName: 'Gemini 3.1 Pro Preview',
    provider: 'gemini',
    aliases: ['gemini-3.1-pro'],
    maxInputTokens: 1048576,
    maxOutputTokens: 65536,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 96,
      reasoning: 96,
      vision: 95,
      creativity: 93,
      speed: 72,
      cost: 32,
    },
    releaseDate: '2026-02',
    notes: 'Google AI 官方 Gemini 3.1 Pro Preview ID，1,048,576 输入上下文',
  },

  'gemini-3.1-flash-lite': {
    id: 'gemini-3.1-flash-lite',
    displayName: 'Gemini 3.1 Flash-Lite',
    provider: 'gemini',
    maxInputTokens: 1048576,
    maxOutputTokens: 65536,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 90,
      reasoning: 90,
      vision: 91,
      creativity: 87,
      speed: 96,
      cost: 90,
    },
    releaseDate: '2026-05',
    notes: 'Google AI 官方 Gemini 3.1 Flash-Lite stable ID，适合高吞吐 BYOK 场景',
  },

  // ========== Gemini 3.0 系列 ==========

  'gemini-3-pro-preview': {
    id: 'gemini-3-pro-preview',
    displayName: 'Gemini 3 Pro Preview',
    provider: 'gemini',
    aliases: ['gemini-3-pro', 'gemini-3.0-pro-preview'],
    maxInputTokens: 1000000,  // 1M tokens
    maxOutputTokens: 65536,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 94,
      reasoning: 95,
      vision: 96,  // UI 设计专长
      creativity: 94,
      speed: 72,
      cost: 35,
    },
    releaseDate: '2026-01',
    deprecated: true,
    replacedBy: 'gemini-3.5-flash',
    notes: 'Gemini 3 预览版；保留为历史兼容项',
  },

  'gemini-3.0-pro': {
    id: 'gemini-3.0-pro',
    displayName: 'Gemini 3.0 Pro',
    provider: 'gemini',
    aliases: ['gemini-3.0-pro-latest'],
    maxInputTokens: 1000000,  // 1M tokens
    maxOutputTokens: 65536,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 95,
      reasoning: 96,
      vision: 94,
      creativity: 92,
      speed: 70,
      cost: 30,
    },
    releaseDate: '2025-12',
    deprecated: true,
    replacedBy: 'gemini-3.5-flash',
    notes: '未在当前 Google AI 模型页确认；保留为历史兼容项，不进入默认 BYOK 列表',
  },

  // ========== Gemini 2.5 系列 ==========

  'gemini-2.5-flash': {
    id: 'gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash',
    provider: 'gemini',
    aliases: ['gemini-2.5-flash-latest'],
    maxInputTokens: 1048576,  // ~1M tokens
    maxOutputTokens: 65535,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 90,
      reasoning: 88,
      vision: 90,
      creativity: 87,
      speed: 92,
      cost: 85,
    },
    releaseDate: '2025-03',
    notes: 'Fast and cost-efficient, ~1500 pages or 30K lines of code',
  },

  'gemini-2.5-pro': {
    id: 'gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    provider: 'gemini',
    aliases: ['gemini-2.5-pro-latest'],
    maxInputTokens: 1000000,  // 1M tokens
    maxOutputTokens: 65536,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 93,
      reasoning: 92,
      vision: 92,
      creativity: 90,
      speed: 75,
      cost: 40,
    },
    releaseDate: '2025-03',
    notes: 'Balanced performance with 1M context window',
  },

  // ========== Gemini 2.0 系列 ==========

  'gemini-2.0-flash-thinking': {
    id: 'gemini-2.0-flash-thinking',
    displayName: 'Gemini 2.0 Flash Thinking',
    provider: 'gemini',
    aliases: ['gemini-2.0-flash-thinking-exp', 'gemini-2.0-flash-thinking-experimental'],
    maxInputTokens: 1000000,  // 1M tokens
    maxOutputTokens: 65536,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: {
      coding: 92,
      reasoning: 94,
      vision: 90,
      creativity: 88,
      speed: 85,
      cost: 50,
    },
    releaseDate: '2024-12-19',
    deprecated: true,
    replacedBy: 'gemini-2.5-flash',
    notes: 'Gemini 2.0 Flash Thinking；保留为历史兼容项',
  },

  'gemini-2.0-flash': {
    id: 'gemini-2.0-flash',
    displayName: 'Gemini 2.0 Flash',
    provider: 'gemini',
    aliases: ['gemini-2.0-flash-exp', 'gemini-2.0-flash-experimental'],
    maxInputTokens: 1000000,  // 1M tokens
    maxOutputTokens: 65536,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 90,
      reasoning: 89,
      vision: 90,
      creativity: 87,
      speed: 95,
      cost: 75,
    },
    releaseDate: '2024-12-11',
    deprecated: true,
    replacedBy: 'gemini-2.5-flash',
    notes: 'Gemini 2.0 Flash；保留为历史兼容项',
  },

  // ========== Gemini 1.5 系列 ==========

  'gemini-1.5-pro': {
    id: 'gemini-1.5-pro',
    displayName: 'Gemini 1.5 Pro',
    provider: 'gemini',
    aliases: ['gemini-1.5-pro-latest', 'gemini-pro'],
    maxInputTokens: 2000000,  // 2M tokens - industry leading!
    maxOutputTokens: 65536,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 88,
      reasoning: 87,
      vision: 88,
      creativity: 85,
      speed: 70,
      cost: 50,
    },
    releaseDate: '2024-05',
    deprecated: true,
    replacedBy: 'gemini-2.5-pro',
    notes: 'Gemini 1.5 Pro；保留为历史兼容项',
  },

  'gemini-1.5-flash': {
    id: 'gemini-1.5-flash',
    displayName: 'Gemini 1.5 Flash',
    provider: 'gemini',
    aliases: ['gemini-1.5-flash-latest', 'gemini-flash'],
    maxInputTokens: 1000000,  // 1M tokens
    maxOutputTokens: 65536,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 85,
      reasoning: 83,
      vision: 85,
      creativity: 82,
      speed: 90,
      cost: 85,
    },
    releaseDate: '2024-05',
    deprecated: true,
    replacedBy: 'gemini-2.5-flash',
    notes: 'Gemini 1.5 Flash；保留为历史兼容项',
  },

  'gemini-1.5-flash-8b': {
    id: 'gemini-1.5-flash-8b',
    displayName: 'Gemini 1.5 Flash-8B',
    provider: 'gemini',
    aliases: ['gemini-flash-8b'],
    maxInputTokens: 1000000,  // 1M tokens
    maxOutputTokens: 65536,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 80,
      reasoning: 78,
      vision: 82,
      creativity: 77,
      speed: 98,
      cost: 95,
    },
    releaseDate: '2024-10',
    deprecated: true,
    replacedBy: 'gemini-2.5-flash',
    notes: 'Gemini 1.5 Flash-8B；保留为历史兼容项',
  },

  // ========== Gemini 1.0 系列 ==========

  'gemini-1.0-pro': {
    id: 'gemini-1.0-pro',
    displayName: 'Gemini 1.0 Pro',
    provider: 'gemini',
    aliases: ['gemini-pro-1.0'],
    maxInputTokens: 32768,
    maxOutputTokens: 8192,
    supportsVision: false,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 75,
      reasoning: 73,
      vision: 0,
      creativity: 75,
      speed: 85,
      cost: 90,
    },
    releaseDate: '2023-12',
    deprecated: true,
    replacedBy: 'gemini-2.5-flash',
    notes: 'Original Gemini Pro；保留为历史兼容项',
  },

  'gemini-1.0-pro-vision': {
    id: 'gemini-1.0-pro-vision',
    displayName: 'Gemini 1.0 Pro Vision',
    provider: 'gemini',
    aliases: ['gemini-pro-vision'],
    maxInputTokens: 16384,
    maxOutputTokens: 2048,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 70,
      reasoning: 68,
      vision: 80,
      creativity: 72,
      speed: 80,
      cost: 88,
    },
    releaseDate: '2023-12',
    deprecated: true,
    replacedBy: 'gemini-2.5-flash',
    notes: 'Original multimodal Gemini；保留为历史兼容项',
  },
};

// ============================================================================
// Doubao / 火山方舟 模型注册表
// ============================================================================

export const DOUBAO_MODELS: Record<string, ModelMetadata> = {
  /* Doubao entries use the provider model-page identifiers and published limits for each release
   * family. */
  'doubao-seed-2-1-pro-260628': {
    id: 'doubao-seed-2-1-pro-260628',
    displayName: 'Doubao Seed 2.1 Pro',
    provider: 'doubao',
    aliases: ['doubao-seed-2-1-pro', 'doubao-seed-2.1-pro'],
    maxInputTokens: 256000,
    maxOutputTokens: 256000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: { coding: 90, reasoning: 89, vision: 91, creativity: 87, speed: 82, cost: 78 },
    releaseDate: '2026-06-28',
    notes: '豆包 Seed 2.1 Pro — 256K 上下文 / 256K 输出, 文本+视觉',
  },

  'doubao-seed-2-0-pro': {
    id: 'doubao-seed-2-0-pro',
    displayName: 'Doubao Seed 2.0 Pro',
    provider: 'doubao',
    aliases: ['doubao-seed-2.0-pro'],
    maxInputTokens: 256000,
    maxOutputTokens: 64000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: { coding: 87, reasoning: 87, vision: 90, creativity: 85, speed: 82, cost: 80 },
    releaseDate: '2026-02',
    notes: '豆包 Seed 2.0 Pro — 256K 上下文, 多模态 (文本/图像/视频)',
  },

  'doubao-seed-2-0-mini-260215': {
    id: 'doubao-seed-2-0-mini-260215',
    displayName: 'Doubao Seed 2.0 Mini',
    provider: 'doubao',
    aliases: ['doubao-seed-2-0-mini', 'doubao-seed-2.0-mini'],
    maxInputTokens: 256000,
    maxOutputTokens: 64000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: { coding: 78, reasoning: 77, vision: 84, creativity: 76, speed: 94, cost: 92 },
    releaseDate: '2026-02-15',
    notes: '豆包 Seed 2.0 Mini — 256K 上下文',
  },

  'doubao-seed-1-6-251015': {
    id: 'doubao-seed-1-6-251015',
    displayName: 'Doubao Seed 1.6',
    provider: 'doubao',
    aliases: ['doubao-seed-1.6', 'doubao-seed-1-6'],
    maxInputTokens: 256000,
    maxOutputTokens: 16000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: {
      coding: 91,
      reasoning: 93,
      vision: 90,
      creativity: 88,
      speed: 80,
      cost: 82,
    },
    releaseDate: '2025-10-15',
    notes: '火山方舟 / 字节官方生态 Doubao Seed 1.6 模型，256K 上下文，支持多模态与思考调节',
  },

  'doubao-seed-1-6-flash-250828': {
    id: 'doubao-seed-1-6-flash-250828',
    displayName: 'Doubao Seed 1.6 Flash',
    provider: 'doubao',
    aliases: ['doubao-seed-1.6-flash'],
    maxInputTokens: 256000,
    maxOutputTokens: 16000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: {
      coding: 88,
      reasoning: 90,
      vision: 88,
      creativity: 85,
      speed: 96,
      cost: 92,
    },
    releaseDate: '2025-08-28',
    notes: '火山方舟官方 Doubao Seed 1.6 Flash 模型，偏高速与低成本',
  },
};

// ============================================================================
// Kimi (Moonshot) 模型注册表
// ============================================================================

export const KIMI_MODELS: Record<string, ModelMetadata> = {
  /* 照 platform.kimi.com/docs/api/chat 核对。
   * K3:  开放 API, 1,048,576 上下文 (K2.7 的 262,144 的四倍), 原生多模态。
   * 最大输出官方写"默认 131,072, 可调到 1,048,576" —— 这里取**默认值**,
   * 表盘按默认档算才不会给用户一个他一般拿不到的余量。 */
  'kimi-k3': {
    id: 'kimi-k3',
    displayName: 'Kimi K3',
    provider: 'kimi',
    /* 不要把 'moonshotai/Kimi-K3' 挂成别名 —— 那是 Together 路由上的 id, 已经是
     * TOGETHER_MODELS 里一条独立条目。同一个字符串既当 id 又当别人的别名,
     * 解析到谁取决于注册顺序, 而两条的上下文上限本来就可能不同。 */
    aliases: ['kimi-k3-latest'],
    maxInputTokens: 1048576,
    maxOutputTokens: 131072,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: { coding: 94, reasoning: 93, vision: 90, creativity: 90, speed: 78, cost: 80 },
    releaseDate: '2026-07-16',
    notes: 'Kimi K3 — 2.8T 参数开放权重, 1M 上下文, 原生多模态 (文本/图像/视频)',
  },

  'kimi-k2.7-code-highspeed': {
    id: 'kimi-k2.7-code-highspeed',
    displayName: 'Kimi K2.7 Code Highspeed',
    provider: 'kimi',
    aliases: ['kimi-k2-7-code-highspeed'],
    maxInputTokens: 262144,
    maxOutputTokens: 131072,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: { coding: 90, reasoning: 86, vision: 0, creativity: 82, speed: 93, cost: 84 },
    releaseDate: '2026-06',
    notes: 'K2.7 Code 的高速档',
  },

  'kimi-k2.7-code': {
    id: 'kimi-k2.7-code',
    displayName: 'Kimi K2.7 Code',
    provider: 'kimi',
    aliases: ['kimi-k2-7-code'],
    maxInputTokens: 262144,
    maxOutputTokens: 8192,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: {
      coding: 97,
      reasoning: 94,
      vision: 86,
      creativity: 86,
      speed: 78,
      cost: 58,
    },
    releaseDate: '2026-06',
    notes: 'Moonshot 官方 Kimi K2.7 Code 模型，面向代码与 Agent 场景',
  },

  'kimi-k2.6': {
    id: 'kimi-k2.6',
    displayName: 'Kimi K2.6',
    provider: 'kimi',
    aliases: ['kimi-k2-6'],
    maxInputTokens: 262144,
    maxOutputTokens: 8192,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: {
      coding: 95,
      reasoning: 94,
      vision: 86,
      creativity: 86,
      speed: 80,
      cost: 62,
    },
    releaseDate: '2026-04',
    notes: 'Moonshot 官方 Kimi K2.6 模型，256K 级上下文，多模态输入',
  },

  'kimi-k2.5': {
    id: 'kimi-k2.5',
    displayName: 'Kimi K2.5',
    provider: 'kimi',
    aliases: ['kimi-k2.5-preview'],
    maxInputTokens: 262144,
    maxOutputTokens: 8192,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: {
      coding: 94,
      reasoning: 93,
      vision: 85,
      creativity: 85,
      speed: 80,
      cost: 65,
    },
    releaseDate: '2026-02',
    deprecated: true,
    replacedBy: 'kimi-k2.6',
    notes: 'K2.5 多模态推理模型，262K 上下文；保留为历史兼容项',
  },

  'kimi-k2-0905-preview': {
    id: 'kimi-k2-0905-preview',
    displayName: 'Kimi K2 (0905 Preview)',
    provider: 'kimi',
    aliases: ['kimi-k2', 'kimi-k2-preview'],
    maxInputTokens: 256000,
    maxOutputTokens: 8192,
    supportsVision: false,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 92,
      reasoning: 90,
      vision: 0,
      creativity: 80,
      speed: 85,
      cost: 70,
    },
    releaseDate: '2025-09',
    deprecated: true,
    replacedBy: 'kimi-k2.6',
    notes: 'MoE 架构 K2 预览版；保留为历史兼容项',
  },
};

// ============================================================================
// DeepSeek 模型注册表
// ============================================================================

export const DEEPSEEK_MODELS: Record<string, ModelMetadata> = {
  'deepseek-v4-pro': {
    id: 'deepseek-v4-pro',
    displayName: 'DeepSeek V4 Pro',
    provider: 'deepseek',
    maxInputTokens: 1000000,
    maxOutputTokens: 384000,
    supportsVision: false,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: {
      coding: 97,
      reasoning: 98,
      vision: 0,
      creativity: 86,
      speed: 58,
      cost: 72,
    },
    releaseDate: '2026-06',
    notes: 'DeepSeek 官方 V4 Pro，1M 上下文，384K 输出',
  },

  'deepseek-v4-flash': {
    id: 'deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash',
    provider: 'deepseek',
    maxInputTokens: 1000000,
    maxOutputTokens: 384000,
    supportsVision: false,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: {
      coding: 94,
      reasoning: 95,
      vision: 0,
      creativity: 84,
      speed: 88,
      cost: 92,
    },
    releaseDate: '2026-06',
    notes: 'DeepSeek 官方 V4 Flash，兼容 deepseek-chat / deepseek-reasoner 别名',
  },

  /* DeepSeek 第一个多模态档 (发布, 官方标 experimental)。
   * 文本能力对齐 v4-flash, 价格同档; 图片单张 ≤384 token 计入 input, 且**只能出现在
   * user 消息**里 (system/assistant 带图上游直接 400)。
   * 这里必须单独列一条: 少了它, BYOK 的模型清单里根本选不到, 视觉徽标也无从谈起。 */
  'deepseek-v4-flash-vision-exp': {
    id: 'deepseek-v4-flash-vision-exp',
    displayName: 'DeepSeek V4 Flash Vision (Exp)',
    provider: 'deepseek',
    aliases: ['deepseek-v4-flash-vision', 'deepseek-vision'],
    maxInputTokens: 1000000,
    maxOutputTokens: 384000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: {
      coding: 94,
      reasoning: 95,
      vision: 82,
      creativity: 84,
      speed: 86,
      cost: 92,
    },
    releaseDate: '2026-08',
    notes: 'DeepSeek 首个图片输入模型 (experimental)。图片仅限 user 消息, 单图 ≤384 token',
  },

  'deepseek-v3.2': {
    id: 'deepseek-v3.2',
    displayName: 'DeepSeek V3.2',
    provider: 'deepseek',
    aliases: ['deepseek-v3.2-exp'],
    maxInputTokens: 128000,
    maxOutputTokens: 32000,
    supportsVision: false,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 92,
      reasoning: 90,
      vision: 0,
      creativity: 80,
      speed: 85,
      cost: 95,
    },
    releaseDate: '2025-09-29',
    deprecated: true,
    replacedBy: 'deepseek-v4-flash',
    notes: '实验版本；保留为历史兼容项',
  },

  'deepseek-v3.1': {
    id: 'deepseek-v3.1',
    displayName: 'DeepSeek V3.1',
    provider: 'deepseek',
    maxInputTokens: 128000,
    maxOutputTokens: 32000,
    supportsVision: false,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 90,
      reasoning: 88,
      vision: 0,
      creativity: 78,
      speed: 88,
      cost: 96,
    },
    releaseDate: '2025-08',
    deprecated: true,
    replacedBy: 'deepseek-v4-flash',
    notes: '混合架构模型；保留为历史兼容项',
  },

  'deepseek-chat': {
    id: 'deepseek-chat',
    displayName: 'DeepSeek Chat',
    provider: 'deepseek',
    maxInputTokens: 64000,
    maxOutputTokens: 32000,
    supportsVision: false,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 85,
      reasoning: 82,
      vision: 0,
      creativity: 75,
      speed: 85,
      cost: 95,
    },
    deprecated: true,
    replacedBy: 'deepseek-v4-flash',
    notes: 'DeepSeek 历史别名，官方将在 2026-07-24 后迁移到 V4 Flash 兼容路径',
  },

  'deepseek-coder': {
    id: 'deepseek-coder',
    displayName: 'DeepSeek Coder',
    provider: 'deepseek',
    maxInputTokens: 64000,
    maxOutputTokens: 32000,
    supportsVision: false,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 95,
      reasoning: 85,
      vision: 0,
      creativity: 70,
      speed: 88,
      cost: 96,
    },
    deprecated: true,
    replacedBy: 'deepseek-v4-flash',
    notes: '历史编码模型；保留为兼容项',
  },

  'deepseek-reasoner': {
    id: 'deepseek-reasoner',
    displayName: 'DeepSeek Reasoner',
    provider: 'deepseek',
    maxInputTokens: 64000,
    maxOutputTokens: 64000,
    supportsVision: false,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: {
      coding: 88,
      reasoning: 96,
      vision: 0,
      creativity: 75,
      speed: 60,
      cost: 90,
    },
    deprecated: true,
    replacedBy: 'deepseek-v4-flash',
    notes: 'DeepSeek 历史思考别名，官方将在 2026-07-24 后迁移到 V4 Flash 兼容路径',
  },
};

// ============================================================================
// Qwen / 阿里云通义千问 模型注册表
// ============================================================================

export const QWEN_MODELS: Record<string, ModelMetadata> = {
  /* 照 help.aliyun.com/zh/model-studio 的模型页核对。
   * qwen3.8-max: 官方写"上下文长度 1,000,000 / 最大输入 991,808 / 最大输出 131,072"。
   * 这里 maxInputTokens 取**最大输入** 991,808 而不是那个 1,000,000 的整数 ——
   * 上下文长度是"输入+输出"的总盘子, 拿它当输入上限会让表盘少报一截余量,
   * 压缩也会晚触发。 */
  'qwen3.8-max': {
    id: 'qwen3.8-max',
    displayName: 'Qwen 3.8 Max',
    provider: 'qwen',
    aliases: ['qwen3-8-max', 'qwen3.8max'],
    maxInputTokens: 991808,
    maxOutputTokens: 131072,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: { coding: 94, reasoning: 94, vision: 90, creativity: 91, speed: 74, cost: 62 },
    releaseDate: '2026-08',
    notes: '通义千问 3.8 Max 旗舰; 上下文 1M (最大输入 991,808) / 输出 131,072',
  },

  'qwen3.8-flash': {
    id: 'qwen3.8-flash',
    displayName: 'Qwen 3.8 Flash',
    provider: 'qwen',
    aliases: ['qwen3-8-flash'],
    maxInputTokens: 991808,
    maxOutputTokens: 131072,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: { coding: 85, reasoning: 84, vision: 86, creativity: 84, speed: 95, cost: 90 },
    releaseDate: '2026-08',
    notes: '通义千问 3.8 Flash — 快档',
  },

  'qwen3.7-max': {
    id: 'qwen3.7-max',
    displayName: 'Qwen 3.7 Max',
    provider: 'qwen',
    aliases: ['qwen3-7-max'],
    maxInputTokens: 1000000,
    maxOutputTokens: 128000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: {
      coding: 96,
      reasoning: 97,
      vision: 92,
      creativity: 92,
      speed: 72,
      cost: 45,
    },
    releaseDate: '2026-06',
    notes: '阿里云百炼官方 Qwen 3.7 Max 模型',
  },

  'qwen3.7-plus': {
    id: 'qwen3.7-plus',
    displayName: 'Qwen 3.7 Plus',
    provider: 'qwen',
    aliases: ['qwen3-7-plus'],
    maxInputTokens: 1000000,
    maxOutputTokens: 128000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: {
      coding: 94,
      reasoning: 95,
      vision: 90,
      creativity: 90,
      speed: 82,
      cost: 70,
    },
    releaseDate: '2026-06',
    notes: '阿里云百炼官方 Qwen 3.7 Plus 模型',
  },

  'qwen3.6-flash': {
    id: 'qwen3.6-flash',
    displayName: 'Qwen 3.6 Flash',
    provider: 'qwen',
    aliases: ['qwen3-6-flash'],
    maxInputTokens: 1000000,
    maxOutputTokens: 128000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: {
      coding: 90,
      reasoning: 91,
      vision: 88,
      creativity: 86,
      speed: 96,
      cost: 92,
    },
    releaseDate: '2026-04',
    notes: '阿里云百炼官方 Qwen 3.6 Flash 模型',
  },
};

// ============================================================================
// MiniMax 模型注册表
// ============================================================================

export const MINIMAX_MODELS: Record<string, ModelMetadata> = {
  'MiniMax-M3': {
    id: 'MiniMax-M3',
    displayName: 'MiniMax M3',
    provider: 'minimax',
    aliases: ['minimax-m3'],
    maxInputTokens: 1000000,
    maxOutputTokens: 524288,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: {
      coding: 97,
      reasoning: 95,
      vision: 91,
      creativity: 90,
      speed: 74,
      cost: 76,
    },
    releaseDate: '2026-06',
    notes: 'MiniMax 官方 M3 模型，面向 Agent 推理、工具调用、代码、多模态 Chat 和长上下文任务',
  },

  'MiniMax-M2.7': {
    id: 'MiniMax-M2.7',
    displayName: 'MiniMax M2.7',
    provider: 'minimax',
    aliases: ['minimax-m2.7'],
    maxInputTokens: 204800,
    maxOutputTokens: 204800,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: {
      coding: 96,
      reasoning: 94,
      vision: 90,
      creativity: 88,
      speed: 76,
      cost: 78,
    },
    releaseDate: '2026-03-18',
    notes: 'MiniMax 官方 M2.7 系列模型',
  },

  'MiniMax-M2.7-highspeed': {
    id: 'MiniMax-M2.7-highspeed',
    displayName: 'MiniMax M2.7 Highspeed',
    provider: 'minimax',
    aliases: ['minimax-m2.7-highspeed'],
    maxInputTokens: 204800,
    maxOutputTokens: 204800,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: {
      coding: 94,
      reasoning: 92,
      vision: 88,
      creativity: 86,
      speed: 92,
      cost: 84,
    },
    releaseDate: '2026-03-18',
    notes: 'MiniMax 官方 M2.7 高速版本',
  },

  'MiniMax-M2.5': {
    id: 'MiniMax-M2.5',
    displayName: 'MiniMax M2.5',
    provider: 'minimax',
    maxInputTokens: 204800,
    maxOutputTokens: 204800,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: {
      coding: 95,
      reasoning: 93,
      vision: 90,
      creativity: 88,
      speed: 70,
      cost: 80,
    },
    releaseDate: '2026-02',
    deprecated: true,
    replacedBy: 'MiniMax-M2.7',
    notes: 'MiniMax M2.5；保留为历史兼容项',
  },


  'minimax-text-01': {
    id: 'minimax-text-01',
    displayName: 'MiniMax Text-01',
    provider: 'minimax',
    maxInputTokens: 4000000,  // 惊人的 4M 上下文!
    maxOutputTokens: 1000000,
    supportsVision: false,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 88,
      reasoning: 90,
      vision: 0,
      creativity: 85,
      speed: 55,
      cost: 70,
    },
    deprecated: true,
    replacedBy: 'MiniMax-M3',
    notes: 'MiniMax Text-01；保留为历史兼容项',
  },

  'minimax-m1-80k': {
    id: 'minimax-m1-80k',
    displayName: 'MiniMax M1-80K',
    provider: 'minimax',
    maxInputTokens: 1000000,  // 1M context
    maxOutputTokens: 80000,   // 80K thinking budget
    supportsVision: false,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: {
      coding: 90,
      reasoning: 92,
      vision: 0,
      creativity: 82,
      speed: 65,
      cost: 75,
    },
    deprecated: true,
    replacedBy: 'MiniMax-M2.7',
    notes: 'MiniMax M1；保留为历史兼容项',
  },

  'minimax-m2.1': {
    id: 'minimax-m2.1',
    displayName: 'MiniMax M2.1',
    provider: 'minimax',
    maxInputTokens: 204800,
    maxOutputTokens: 64000,
    supportsVision: false,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 93,
      reasoning: 88,
      vision: 0,
      creativity: 80,
      speed: 82,
      cost: 85,
    },
    releaseDate: '2025-12',
    aliases: ['MiniMax-M2.1'],
    deprecated: true,
    replacedBy: 'MiniMax-M2.7',
    notes: 'MiniMax M2.1；保留为历史兼容项',
  },

  'minimax-vl-01': {
    id: 'minimax-vl-01',
    displayName: 'MiniMax VL-01',
    provider: 'minimax',
    maxInputTokens: 4000000,
    maxOutputTokens: 1000000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 85,
      reasoning: 88,
      vision: 92,
      creativity: 88,
      speed: 60,
      cost: 65,
    },
    deprecated: true,
    replacedBy: 'MiniMax-M3',
    notes: 'MiniMax VL-01；保留为历史兼容项',
  },
};

// ============================================================================
// GLM / 智谱 模型注册表
// ============================================================================

export const GLM_MODELS: Record<string, ModelMetadata> = {
  /* 核对: GLM-5.3 于 发布、08-19 开放 API,
   * 沿用 GLM-5.2 的 753.33B MoE 基座, 1M 上下文 / 128K 最大输出。 */
  'glm-5.3': {
    id: 'glm-5.3',
    displayName: 'GLM-5.3',
    provider: 'glm',
    aliases: ['glm5.3', 'glm-5-3'],
    maxInputTokens: 1000000,
    maxOutputTokens: 128000,
    supportsVision: false,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: { coding: 95, reasoning: 92, vision: 0, creativity: 88, speed: 80, cost: 88 },
    releaseDate: '2026-08-14',
    notes: 'GLM-5.3 — 面向复杂编程 / 长程 Agent / 网络安全; 1M 上下文 / 128K 输出',
  },

  'glm-5.2': {
    id: 'glm-5.2',
    displayName: 'GLM-5.2',
    provider: 'glm',
    aliases: ['glm5.2'],
    maxInputTokens: 1000000,
    maxOutputTokens: 128000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: {
      coding: 96,
      reasoning: 96,
      vision: 91,
      creativity: 92,
      speed: 76,
      cost: 58,
    },
    releaseDate: '2026-06',
    notes: '智谱官方 GLM-5.2 模型',
  },

  'glm-5.1': {
    id: 'glm-5.1',
    displayName: 'GLM-5.1',
    provider: 'glm',
    aliases: ['glm5.1'],
    maxInputTokens: 200000,
    maxOutputTokens: 128000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: {
      coding: 95,
      reasoning: 95,
      vision: 90,
      creativity: 91,
      speed: 78,
      cost: 62,
    },
    releaseDate: '2026-04',
    notes: '智谱官方 GLM-5.1 模型',
  },

  'glm-5-turbo': {
    id: 'glm-5-turbo',
    displayName: 'GLM-5 Turbo',
    provider: 'glm',
    aliases: ['glm5-turbo'],
    maxInputTokens: 200000,
    maxOutputTokens: 128000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: {
      coding: 91,
      reasoning: 91,
      vision: 88,
      creativity: 88,
      speed: 94,
      cost: 86,
    },
    releaseDate: '2026-04',
    notes: '智谱官方 GLM-5 Turbo 模型',
  },

  'glm-5': {
    id: 'glm-5',
    displayName: 'GLM-5',
    provider: 'glm',
    aliases: ['glm5'],
    maxInputTokens: 200000,
    maxOutputTokens: 128000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 93,
      reasoning: 92,
      vision: 88,
      creativity: 90,
      speed: 75,
      cost: 60,
    },
    releaseDate: '2026-02-11',
    deprecated: true,
    replacedBy: 'glm-5.2',
    notes: 'GLM-5；保留为历史兼容项',
  },

  'glm-4.7': {
    id: 'glm-4.7',
    displayName: 'GLM-4.7',
    provider: 'glm',
    maxInputTokens: 200000,
    maxOutputTokens: 128000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 90,
      reasoning: 88,
      vision: 85,
      creativity: 87,
      speed: 80,
      cost: 70,
    },
    releaseDate: '2025-12-22',
    deprecated: true,
    replacedBy: 'glm-5.1',
    notes: 'GLM-4.7；保留为历史兼容项',
  },

  'glm-4.6': {
    id: 'glm-4.6',
    displayName: 'GLM-4.6',
    provider: 'glm',
    maxInputTokens: 200000,
    maxOutputTokens: 128000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 88,
      reasoning: 86,
      vision: 83,
      creativity: 85,
      speed: 82,
      cost: 75,
    },
    releaseDate: '2025-09-10',
    deprecated: true,
    replacedBy: 'glm-5.1',
    notes: 'GLM-4.6；保留为历史兼容项',
  },

  'glm-4.5': {
    id: 'glm-4.5',
    displayName: 'GLM-4.5',
    provider: 'glm',
    maxInputTokens: 128000,
    maxOutputTokens: 32000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 86,
      reasoning: 84,
      vision: 80,
      creativity: 83,
      speed: 85,
      cost: 80,
    },
    releaseDate: '2025-07',
    deprecated: true,
    replacedBy: 'glm-5.1',
  },

  'glm-4-flash': {
    id: 'glm-4-flash',
    displayName: 'GLM-4 Flash',
    provider: 'glm',
    maxInputTokens: 128000,
    maxOutputTokens: 32000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 82,
      reasoning: 80,
      vision: 78,
      creativity: 80,
      speed: 95,
      cost: 92,
    },
    deprecated: true,
    replacedBy: 'glm-5-turbo',
    notes: 'GLM-4 Flash；保留为历史兼容项',
  },

  'glm-4-plus': {
    id: 'glm-4-plus',
    displayName: 'GLM-4 Plus',
    provider: 'glm',
    maxInputTokens: 128000,
    maxOutputTokens: 32000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 88,
      reasoning: 86,
      vision: 82,
      creativity: 85,
      speed: 78,
      cost: 65,
    },
    deprecated: true,
    replacedBy: 'glm-5.1',
  },

  'glm-4-air': {
    id: 'glm-4-air',
    displayName: 'GLM-4 Air',
    provider: 'glm',
    maxInputTokens: 128000,
    maxOutputTokens: 32000,
    supportsVision: false,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 80,
      reasoning: 78,
      vision: 0,
      creativity: 78,
      speed: 90,
      cost: 88,
    },
    deprecated: true,
    replacedBy: 'glm-5-turbo',
  },

  'glm-4-long': {
    id: 'glm-4-long',
    displayName: 'GLM-4 Long',
    provider: 'glm',
    maxInputTokens: 1000000,  // 1M 超长上下文!
    maxOutputTokens: 128000,
    supportsVision: false,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 85,
      reasoning: 88,
      vision: 0,
      creativity: 80,
      speed: 50,
      cost: 60,
    },
    deprecated: true,
    replacedBy: 'glm-5.2',
    notes: 'GLM-4 Long；保留为历史兼容项',
  },

  'glm-4-airx': {
    id: 'glm-4-airx',
    displayName: 'GLM-4 AirX',
    provider: 'glm',
    maxInputTokens: 8000,
    maxOutputTokens: 4096,
    supportsVision: false,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 70,
      reasoning: 68,
      vision: 0,
      creativity: 70,
      speed: 98,
      cost: 98,
    },
    deprecated: true,
    replacedBy: 'glm-5-turbo',
    notes: 'GLM-4 AirX；保留为历史兼容项',
  },
};

// ============================================================================
// xAI Grok 模型注册表
// ============================================================================

// ============================================================================
// Mistral / Groq / Together ——  新增
//
//   这三家以前**在这份注册表里一个模型都没有**, 而 protocolModels 又把它们的协议
//   映射成了 'openai' —— 于是用户在"添加服务商"里选 Mistral, 下拉里列出来的是
//   一整列 GPT-5.6。不报错, 只是一列错的东西, 照着选下去才发现调不通。
//
//   数据来源 (逐条核对):
//     · Mistral   docs.mistral.ai/models + 各模型页
//     · Groq      console.groq.com/docs/models.md (官方给了 context / max output 两列)
//     · Together  docs.together.ai/docs/serverless/models
//
//   Together 的 id 带厂商前缀 (deepseek-ai/... 、moonshotai/...), 那是它的路由格式,
//   **不能**跟各厂商自己的 id 混用, 所以单独一份而不是给已有条目加 alias。
// ============================================================================

export const MISTRAL_MODELS: Record<string, ModelMetadata> = {
  'mistral-large-latest': {
    id: 'mistral-large-latest',
    displayName: 'Mistral Large 3',
    provider: 'mistral',
    aliases: ['mistral-large-2512', 'mistral-large-3'],
    maxInputTokens: 256000,
    maxOutputTokens: 32000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: { coding: 84, reasoning: 85, vision: 82, creativity: 84, speed: 78, cost: 70 },
    releaseDate: '2025-12-02',
    notes: 'Mistral Large 3 — 256K 上下文, 文本+图像。别名 mistral-large-latest 会随代际漂移, 要稳定就钉 mistral-large-2512',
  },

  'mistral-medium-latest': {
    id: 'mistral-medium-latest',
    displayName: 'Mistral Medium 3.5',
    provider: 'mistral',
    aliases: ['mistral-medium-3-5', 'mistral-medium-3.5'],
    maxInputTokens: 262144,
    maxOutputTokens: 32000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: { coding: 88, reasoning: 86, vision: 82, creativity: 84, speed: 84, cost: 82 },
    releaseDate: '2026-04-29',
    notes: 'Mistral Medium 3.5 — 128B dense, 262,144 上下文, 推理强度可按请求配置',
  },

  'mistral-small-latest': {
    id: 'mistral-small-latest',
    displayName: 'Mistral Small 4',
    provider: 'mistral',
    aliases: ['mistral-small-4'],
    maxInputTokens: 128000,
    maxOutputTokens: 32000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: { coding: 76, reasoning: 75, vision: 76, creativity: 76, speed: 92, cost: 92 },
    releaseDate: '2026-03-16',
    notes: 'Mistral Small 4 (Apache 2.0)',
  },

  'magistral-medium-latest': {
    id: 'magistral-medium-latest',
    displayName: 'Magistral Medium',
    provider: 'mistral',
    aliases: ['magistral-medium-2509'],
    maxInputTokens: 128000,
    maxOutputTokens: 32000,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: { coding: 80, reasoning: 86, vision: 0, creativity: 78, speed: 76, cost: 76 },
    releaseDate: '2025-09',
    notes: 'Magistral Medium — 推理模型, 128K 上下文',
  },
};

export const GROQ_MODELS: Record<string, ModelMetadata> = {
  /* Groq 官方已把 Llama 系列聊天模型标为 deprecated, 建议改用 gpt-oss。
   * 这里照实标 —— 不标的话它们会一直排在下拉里, 用户选中后随时可能失效。 */
  'openai/gpt-oss-120b': {
    id: 'openai/gpt-oss-120b',
    displayName: 'GPT-OSS 120B (Groq)',
    provider: 'groq',
    aliases: ['gpt-oss-120b'],
    maxInputTokens: 131072,
    maxOutputTokens: 65536,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: { coding: 82, reasoning: 82, vision: 0, creativity: 78, speed: 98, cost: 90 },
    notes: 'Groq LPU 上的 gpt-oss 120B — 官方推荐的通用/推理主力',
  },

  'openai/gpt-oss-20b': {
    id: 'openai/gpt-oss-20b',
    displayName: 'GPT-OSS 20B (Groq)',
    provider: 'groq',
    aliases: ['gpt-oss-20b'],
    maxInputTokens: 131072,
    maxOutputTokens: 65536,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: { coding: 74, reasoning: 74, vision: 0, creativity: 72, speed: 99, cost: 95 },
    notes: 'gpt-oss 20B — 更小更快的一档',
  },

  'groq/compound': {
    id: 'groq/compound',
    displayName: 'Groq Compound',
    provider: 'groq',
    maxInputTokens: 131072,
    maxOutputTokens: 8192,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: { coding: 78, reasoning: 78, vision: 0, creativity: 74, speed: 96, cost: 88 },
    notes: 'Groq 自带工具编排的复合系统; 最大输出只有 8,192',
  },

  'llama-3.3-70b-versatile': {
    id: 'llama-3.3-70b-versatile',
    displayName: 'Llama 3.3 70B (Groq)',
    provider: 'groq',
    maxInputTokens: 131072,
    maxOutputTokens: 32768,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: { coding: 70, reasoning: 70, vision: 0, creativity: 70, speed: 96, cost: 90 },
    deprecated: true,
    replacedBy: 'openai/gpt-oss-120b',
    notes: 'Groq 已标记弃用 —— 官方建议改用 gpt-oss-120b',
  },

  'llama-3.1-8b-instant': {
    id: 'llama-3.1-8b-instant',
    displayName: 'Llama 3.1 8B Instant (Groq)',
    provider: 'groq',
    maxInputTokens: 131072,
    maxOutputTokens: 131072,
    supportsTools: true,
    supportsStreaming: true,
    scores: { coding: 55, reasoning: 55, vision: 0, creativity: 58, speed: 100, cost: 98 },
    deprecated: true,
    replacedBy: 'openai/gpt-oss-20b',
    notes: 'Groq 已标记弃用 —— 官方建议改用 gpt-oss-20b',
  },
};

export const TOGETHER_MODELS: Record<string, ModelMetadata> = {
  'deepseek-ai/DeepSeek-V4-Pro-0813': {
    id: 'deepseek-ai/DeepSeek-V4-Pro-0813',
    displayName: 'DeepSeek V4 Pro (Together)',
    provider: 'together',
    maxInputTokens: 1048576,
    maxOutputTokens: 128000,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: { coding: 95, reasoning: 94, vision: 0, creativity: 88, speed: 74, cost: 86 },
    releaseDate: '2026-08-13',
    notes: 'Together 上的 DeepSeek V4 Pro, 1,048,576 上下文',
  },

  'deepseek-ai/DeepSeek-V4-Flash-0731': {
    id: 'deepseek-ai/DeepSeek-V4-Flash-0731',
    displayName: 'DeepSeek V4 Flash (Together)',
    provider: 'together',
    maxInputTokens: 1000000,
    maxOutputTokens: 128000,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: { coding: 86, reasoning: 85, vision: 0, creativity: 82, speed: 92, cost: 94 },
    releaseDate: '2026-07-31',
    notes: 'Together 上的 DeepSeek V4 Flash',
  },

  'moonshotai/Kimi-K3': {
    id: 'moonshotai/Kimi-K3',
    displayName: 'Kimi K3 (Together)',
    provider: 'together',
    maxInputTokens: 1048576,
    maxOutputTokens: 131072,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: { coding: 94, reasoning: 93, vision: 90, creativity: 90, speed: 76, cost: 82 },
    releaseDate: '2026-07-16',
    notes: 'Together 上的 Kimi K3',
  },

  'zai-org/GLM-5.2': {
    id: 'zai-org/GLM-5.2',
    displayName: 'GLM-5.2 (Together)',
    provider: 'together',
    maxInputTokens: 1000000,
    maxOutputTokens: 128000,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: { coding: 92, reasoning: 90, vision: 0, creativity: 86, speed: 80, cost: 88 },
    releaseDate: '2026-06',
    notes: 'Together 上的 GLM-5.2',
  },

  'zai-org/GLM-5.3-Flash': {
    id: 'zai-org/GLM-5.3-Flash',
    displayName: 'GLM-5.3 Flash (Together)',
    provider: 'together',
    maxInputTokens: 1000000,
    maxOutputTokens: 128000,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: { coding: 88, reasoning: 86, vision: 0, creativity: 84, speed: 92, cost: 92 },
    releaseDate: '2026-08',
    notes: 'Together 上的 GLM-5.3 Flash',
  },

  'MiniMaxAI/MiniMax-M3': {
    id: 'MiniMaxAI/MiniMax-M3',
    displayName: 'MiniMax M3 (Together)',
    provider: 'together',
    /* 524,288 而不是 MiniMax 官方的 1,048,576 —— Together 这条路由上就是这个数。
     * 同一个模型在不同平台上限不同, 表盘按平台算才准。 */
    maxInputTokens: 524288,
    maxOutputTokens: 131072,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: { coding: 88, reasoning: 87, vision: 86, creativity: 86, speed: 82, cost: 88 },
    releaseDate: '2026-06-01',
    notes: 'Together 上的 MiniMax M3 —— 上下文 524,288 (低于 MiniMax 官方的 1M)',
  },

  'Qwen/Qwen3.6-Plus': {
    id: 'Qwen/Qwen3.6-Plus',
    displayName: 'Qwen 3.6 Plus (Together)',
    provider: 'together',
    maxInputTokens: 1000000,
    maxOutputTokens: 128000,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: { coding: 84, reasoning: 84, vision: 0, creativity: 82, speed: 84, cost: 86 },
    notes: 'Together 上的 Qwen 3.6 Plus',
  },

  'meta-llama/Llama-3.3-70B-Instruct-Turbo': {
    id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    displayName: 'Llama 3.3 70B Turbo (Together)',
    provider: 'together',
    maxInputTokens: 131072,
    maxOutputTokens: 32768,
    supportsTools: true,
    supportsStreaming: true,
    scores: { coding: 70, reasoning: 70, vision: 0, creativity: 70, speed: 88, cost: 90 },
    notes: 'Together 上的 Llama 3.3 70B Turbo',
  },
};

export const GROK_MODELS: Record<string, ModelMetadata> = {
  /* Grok entries use the provider model catalog's identifiers and published limits. */
  'grok-4.6': {
    id: 'grok-4.6',
    displayName: 'Grok 4.6',
    provider: 'xai',
    aliases: ['grok-4-6'],
    maxInputTokens: 500000,
    maxOutputTokens: 32000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: { coding: 96, reasoning: 95, vision: 92, creativity: 92, speed: 80, cost: 55 },
    releaseDate: '2026-08',
    notes: 'xAI 当前旗舰 — 编码 / 低幻觉率 / agentic 工具调用; 500K 上下文',
  },

  'grok-4.3': {
    id: 'grok-4.3',
    displayName: 'Grok 4.3',
    provider: 'xai',
    aliases: ['grok-4-3'],
    maxInputTokens: 1000000,
    maxOutputTokens: 32000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: { coding: 90, reasoning: 89, vision: 92, creativity: 89, speed: 84, cost: 66 },
    releaseDate: '2026-04',
    notes: 'Grok 4.3 — 1M 上下文, 原生视频输入',
  },

  'grok-4.5': {
    id: 'grok-4.5',
    displayName: 'Grok 4.5',
    provider: 'xai',
    aliases: ['grok-4-5', 'grok-4.5-latest', 'x-ai/grok-4.5'],
    maxInputTokens: 500000,
    maxOutputTokens: 128000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: {
      coding: 94,
      reasoning: 95,
      vision: 88,
      creativity: 92,
      speed: 78,
      cost: 40,
    },
    releaseDate: '2026',
    notes: 'xAI Grok 4.5，500K 上下文',
  },

  'grok-4': {
    id: 'grok-4',
    displayName: 'Grok 4',
    provider: 'xai',
    aliases: ['grok-4-latest', 'x-ai/grok-4'],
    maxInputTokens: 256000,
    maxOutputTokens: 128000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    scores: {
      coding: 92,
      reasoning: 93,
      vision: 86,
      creativity: 90,
      speed: 80,
      cost: 45,
    },
    releaseDate: '2026',
    notes: 'xAI Grok 4，256K 上下文',
  },

  'grok-composer-2.5-fast': {
    id: 'grok-composer-2.5-fast',
    displayName: 'Grok Composer 2.5 Fast',
    provider: 'xai',
    aliases: ['grok-composer-2.5', 'composer-2.5-fast'],
    maxInputTokens: 256000,
    maxOutputTokens: 64000,
    supportsVision: true,
    supportsTools: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    scores: {
      coding: 90,
      reasoning: 88,
      vision: 84,
      creativity: 86,
      speed: 92,
      cost: 55,
    },
    releaseDate: '2026',
    notes: 'xAI Grok Composer 2.5 Fast',
  },
};

// ============================================================================
// 模型注册表管理器
// ============================================================================

export class ModelRegistry {
  private models: Map<string, ModelMetadata> = new Map();

  constructor() {
    // 注册所有模型
    this.registerModels(OPENAI_MODELS);
    this.registerModels(ANTHROPIC_MODELS);
    this.registerModels(GEMINI_MODELS);
    this.registerModels(DOUBAO_MODELS);
    this.registerModels(KIMI_MODELS);
    this.registerModels(DEEPSEEK_MODELS);
    this.registerModels(QWEN_MODELS);
    this.registerModels(MINIMAX_MODELS);
    this.registerModels(GLM_MODELS);
    this.registerModels(GROK_MODELS);
    this.registerModels(MISTRAL_MODELS);
    this.registerModels(GROQ_MODELS);
    this.registerModels(TOGETHER_MODELS);
  }

  /** 批量注册模型 */
  private registerModels(models: Record<string, ModelMetadata>): void {
    for (const [id, metadata] of Object.entries(models)) {
      this.models.set(id, metadata);
      this.models.set(id.toLowerCase(), metadata);
      this.models.set(metadata.id.toLowerCase(), metadata);

      // 注册别名
      if (metadata.aliases) {
        for (const alias of metadata.aliases) {
          this.models.set(alias, metadata);
          this.models.set(alias.toLowerCase(), metadata);
        }
      }
    }
  }

  /** 获取模型元数据 */
  getModel(modelId: string): ModelMetadata | undefined {
    const normalized = modelId.trim();
    if (!normalized) return undefined;
    return this.models.get(normalized) ?? this.models.get(normalized.toLowerCase());
  }

  /** 获取所有模型 */
  getAllModels(): ModelMetadata[] {
    const uniqueModels = new Map<string, ModelMetadata>();
    for (const model of this.models.values()) {
      uniqueModels.set(model.id, model);
    }
    return Array.from(uniqueModels.values());
  }

  /** 获取指定 Provider 的所有模型 */
  getModelsByProvider(provider: string): ModelMetadata[] {
    return this.getAllModels().filter(m => m.provider === provider);
  }

  /** 检查模型是否存在 */
  hasModel(modelId: string): boolean {
    const normalized = modelId.trim();
    if (!normalized) return false;
    return this.models.has(normalized) || this.models.has(normalized.toLowerCase());
  }

  /** 转换为 ModelCapability 格式 (用于能力管理器) */
  toModelCapability(modelId: string): ModelCapability | undefined {
    const model = this.getModel(modelId);
    if (!model) return undefined;

    return {
      modelAlias: model.id,
      strengths: this.inferStrengths(model),
      scores: {
        coding: model.scores?.coding ?? 50,
        reasoning: model.scores?.reasoning ?? 50,
        vision: model.scores?.vision ?? 0,
        creativity: model.scores?.creativity ?? 50,
        speed: model.scores?.speed ?? 50,
        cost: model.scores?.cost ?? 50,
      },
      features: {
        supportsVision: model.supportsVision ?? false,
        supportsTools: model.supportsTools ?? false,
        supportsFunctionCalling: model.supportsFunctionCalling ?? false,
        supportsStreaming: model.supportsStreaming ?? false,
        maxContextTokens: model.maxInputTokens,
        maxOutputTokens: model.maxOutputTokens,
      },
    };
  }

  /** 根据评分推断擅长的任务类型 */
  private inferStrengths(model: ModelMetadata): TaskType[] {
    const strengths: TaskType[] = [];
    const scores = model.scores ?? {};

    if ((scores.coding ?? 0) >= 85) strengths.push('coding');
    if ((scores.reasoning ?? 0) >= 85) strengths.push('reasoning');
    if ((scores.vision ?? 0) >= 85) strengths.push('image_analysis');
    if ((scores.creativity ?? 0) >= 85) strengths.push('creative_writing');

    return strengths;
  }
}

// ============================================================================
// 导出单例实例
// ============================================================================

export const modelRegistry = new ModelRegistry();
