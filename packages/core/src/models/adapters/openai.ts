/**
 * OpenAI Provider Adapter
 *
 * 组合 OpenAIConstraints + OpenAIPromptBuilder + OpenAIProvider
 */

import { BaseAdapter, type ChatOptions, type PreparedRequest } from './base.js';
import { OpenAIConstraints } from '../constraints/openai.js';
import { OpenAIPromptBuilder } from '../prompts/openai.js';
import { OpenAIProvider, type OpenAIProviderConfig } from '@neoxlabs/kernel/models/openai.js';
import type { Message, ChatCompletionResponse } from '@neoxlabs/kernel/types/index.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

function thinkingOptions(options: ChatOptions): { reasoningEffortOverride?: 'minimal'; effortLevel?: string } {
  if (options.disableThinking) return { reasoningEffortOverride: 'minimal' };
  return options.effortLevel ? { effortLevel: options.effortLevel } : {};
}

/**
 * OpenAI Adapter 配置
 */
export interface OpenAIAdapterConfig {
  /** API Key */
  apiKey: string;

  /** Base URL */
  baseUrl?: string;

  /** 默认模型 */
  defaultModel?: string;

  /** 是否使用 Responses API */
  useResponsesAPI?: boolean;

  /** 最大输出 tokens */
  maxTokens?: number;

  /** 最大输入 tokens */
  maxInputTokens?: number;

  /** 其他 OpenAI Provider 配置 */
  [key: string]: any;
}

/**
 * OpenAI Adapter
 *
 * 自动：
 * 1. 验证参数（通过 OpenAIConstraints）
 * 2. 注入 system prompt（通过 OpenAIPromptBuilder）
 * 3. 应用 token 限制
 * 4. 调用 OpenAIProvider
 */
export class OpenAIAdapter extends BaseAdapter {
  readonly constraints: OpenAIConstraints;
  readonly promptBuilder: OpenAIPromptBuilder;
  private provider: OpenAIProvider;
  private defaultModel: string;

  constructor(config: OpenAIAdapterConfig) {
    super();

    this.constraints = new OpenAIConstraints();
    this.promptBuilder = new OpenAIPromptBuilder();
    if (!config.defaultModel || !config.defaultModel.trim()) {
      throw new Error('OpenAIAdapter: defaultModel is required (refusing silent fallback to "gpt-4o"). Check caller — runtime should pass llmConfig.model explicitly.');
    }
    this.defaultModel = config.defaultModel;

    // 创建底层 provider（只提取需要的字段，避免重复）
    const { apiKey, baseUrl, defaultModel, useResponsesAPI, maxTokens, maxInputTokens, ...rest } = config;
    this.provider = new OpenAIProvider({
      apiKey,
      baseUrl,
      defaultModel: this.defaultModel,
      useResponsesAPI,
      maxTokens,
      maxInputTokens,
      ...rest,
    } as OpenAIProviderConfig);
  }

  /**
   * 准备请求（覆盖以添加 OpenAI 特定逻辑）
   */
  prepareRequest(messages: Message[], options: ChatOptions): PreparedRequest {
    const model = options.model || this.defaultModel;
    if (!model || !model.trim()) {
      throw new Error('OpenAIAdapter.prepareRequest: model is required (options.model + this.defaultModel both empty). Caller must pass model explicitly.');
    }

    // 检测是否是 Responses API 模型
    const isResponsesAPI = this.constraints.isResponsesAPIModel(model);

    // 基础准备
    const prepared = super.prepareRequest(messages, { ...options, model });

    // 对于 Responses API，可能需要特殊处理
    if (isResponsesAPI) {
      // Responses API 特定的参数调整
      if (prepared.options.temperature === undefined) {
        // o1/o3 默认不使用 temperature
        delete prepared.options.temperature;
      }
    }

    return prepared;
  }

  /**
   * 发送聊天请求（非流式）
   */
  async chat(messages: Message[], options: ChatOptions): Promise<ChatCompletionResponse> {
    const prepared = this.prepareRequest(messages, options);

    // 检查验证结果
    if (!prepared.validation?.valid) {
      const errors = prepared.validation?.errors || [];
      throw new Error(`Invalid parameters: ${errors.join(', ')}`);
    }

    // 打印警告
    if (prepared.validation?.warnings && prepared.validation.warnings.length > 0) {
      cliLogger.warn('OpenAIAdapter', 'Warnings', prepared.validation.warnings);
    }

    // 调用底层 provider
    return this.provider.chat(prepared.messages, {
      model: prepared.options.model,
      tools: prepared.options.tools,
      temperature: prepared.options.temperature,
      structuredOutput: prepared.options.structuredOutput,
      maxInputTokens: prepared.options.maxInputTokens,
      /* disableThinking → reasoning_effort='minimal' (GPT-5+ reasoning 模型最低档).
       * OpenAI 没有 'disabled' / 'off' enum, minimal 是 effort 等价的"几乎不思考". */
      ...thinkingOptions(options),
    });
  }

  /**
   * 发送聊天请求（流式）
   */
  async *chatStreamed(messages: Message[], options: ChatOptions): AsyncGenerator<any> {
    const prepared = this.prepareRequest(messages, options);

    // 检查验证结果
    if (!prepared.validation?.valid) {
      const errors = prepared.validation?.errors || [];
      throw new Error(`Invalid parameters: ${errors.join(', ')}`);
    }

    // 打印警告
    if (prepared.validation?.warnings && prepared.validation.warnings.length > 0) {
      cliLogger.warn('OpenAIAdapter', 'Warnings', prepared.validation.warnings);
    }

    // 调用底层 provider
    yield* this.provider.chatStreamed(prepared.messages, {
      model: prepared.options.model,
      tools: prepared.options.tools,
      temperature: prepared.options.temperature,
      structuredOutput: prepared.options.structuredOutput,
      maxInputTokens: prepared.options.maxInputTokens,
      signal: options.signal,
      ...thinkingOptions(options),
    });
  }

  /**
   * 获取底层 provider（用于特殊情况）
   */
  getProvider(): OpenAIProvider {
    return this.provider;
  }

  /**
   * 获取模型能力信息
   */
  getModelCapabilities(model?: string) {
    const modelName = model || this.defaultModel;

    return {
      supportsVision: this.constraints.supportsVision(modelName),
      supportsTools: this.constraints.supportsTools(modelName),
      supportsReasoning: this.constraints.supportsReasoning(modelName),
      isResponsesAPI: this.constraints.isResponsesAPIModel(modelName),
      tokenLimits: this.constraints.getTokenLimits(modelName),
    };
  }
}

/**
 * 创建 OpenAI Adapter 的便捷函数
 */
export function createOpenAIAdapter(config: OpenAIAdapterConfig): OpenAIAdapter {
  return new OpenAIAdapter(config);
}
