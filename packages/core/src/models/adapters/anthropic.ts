/**
 * Anthropic (Claude) Provider Adapter
 *
 * 组合 AnthropicConstraints + AnthropicPromptBuilder + AnthropicProvider
 */

import { BaseAdapter, type ChatOptions, type PreparedRequest } from './base.js';
import { AnthropicConstraints } from '../constraints/anthropic.js';
import { AnthropicPromptBuilder } from '../prompts/anthropic.js';
import { AnthropicProvider, type AnthropicProviderConfig } from '@neoxlabs/kernel/models/anthropic.js';
import type { Message, ChatCompletionResponse } from '@neoxlabs/kernel/types/index.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

/**
 * Anthropic Adapter 配置
 */
export interface AnthropicAdapterConfig {
  /** Auth Token (API Key) */
  authToken: string;

  /** Base URL */
  baseUrl?: string;

  /** 默认模型 */
  defaultModel?: string;

  /** 最大输出 tokens */
  maxTokens?: number;

  /** 是否禁用缓存 */
  disableCaching?: boolean;

  /** Stable metadata user_id override (optional) */
  userId?: string;

  /**
   * Claude Code 身份策略 (auto/on/off). undefined 视作 'auto'.
   * 见 ProviderConfigEntry.claudeCodeMode 完整语义.
   */
  claudeCodeMode?: 'auto' | 'on' | 'off';

  /** 其他 Anthropic Provider 配置 */
  [key: string]: any;
}

/**
 * Anthropic Adapter
 *
 * 自动：
 * 1. 验证参数（通过 AnthropicConstraints）
 * 2. 注入 system prompt（通过 AnthropicPromptBuilder）
 * 3. 应用 token 限制和参数别名
 * 4. 调用 AnthropicProvider
 */
export class AnthropicAdapter extends BaseAdapter {
  readonly constraints: AnthropicConstraints;
  readonly promptBuilder: AnthropicPromptBuilder;
  private provider: AnthropicProvider;
  private defaultModel: string;
  private disableCaching: boolean;

  constructor(config: AnthropicAdapterConfig) {
    super();

    this.constraints = new AnthropicConstraints();
    this.promptBuilder = new AnthropicPromptBuilder();
    this.defaultModel = config.defaultModel || 'claude-3-5-sonnet-20241022';
    this.disableCaching = config.disableCaching || false;

    // 创建底层 provider（只提取需要的字段，避免重复）
    const { authToken, baseUrl, defaultModel, maxTokens, disableCaching, userId, ...rest } = config;
    this.provider = new AnthropicProvider({
      authToken,
      baseUrl,
      defaultModel: this.defaultModel,
      maxTokens,
      disableCaching: this.disableCaching,
      userId,
      ...rest,
    } as AnthropicProviderConfig);
  }

  /**
   * 准备请求（覆盖以添加 Anthropic 特定逻辑）
   */
  prepareRequest(messages: Message[], options: ChatOptions): PreparedRequest {
    const model = options.model || this.defaultModel;

    // 基础准备
    const prepared = super.prepareRequest(messages, { ...options, model });

    // Anthropic 特定的参数调整
    const finalOptions = { ...prepared.options };

    const requestedMaxTokens = finalOptions.maxTokens;
    if (requestedMaxTokens !== undefined) {
      finalOptions.max_tokens = requestedMaxTokens;
    }
    delete finalOptions.maxInputTokens;

    if (!finalOptions.max_tokens) {
      const limits = this.constraints.getTokenLimits(model);
      if (limits.found) finalOptions.max_tokens = Math.min(32000, limits.maxOutput);
    }

    // Prompt Caching 推荐
    if (!this.disableCaching && this.constraints.supportsPromptCaching(model)) {
      const systemPromptLength = prepared.messages[0]?.content?.length || 0;
      const cachingRec = this.promptBuilder.getCachingRecommendation(systemPromptLength);

      if (cachingRec.shouldUseCache) {
        finalOptions.enableCaching = true;
        finalOptions.cacheTtl = cachingRec.cacheTTL;
      }
    }

    return {
      ...prepared,
      options: finalOptions,
    };
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
      cliLogger.warn('AnthropicAdapter', 'Warnings', prepared.validation.warnings);
    }

    const preparedOptions = prepared.options as ChatOptions & Record<string, any>;

    // 调用底层 provider
    return this.provider.chat(prepared.messages, {
      model: preparedOptions.model,
      tools: preparedOptions.tools,
      temperature: preparedOptions.temperature,
      maxTokens: preparedOptions.max_tokens,
      enableCaching: preparedOptions.enableCaching,
      cacheTtl: preparedOptions.cacheTtl,
      disableCaching: preparedOptions.disableCaching,
      /* options.disableThinking → thinking:{type:'disabled'} (覆盖 caller 显式 thinking).
       * side-agent path 用这个统一开关跨 family 关 thinking. */
      thinking: options.disableThinking ? { type: 'disabled' as const } : preparedOptions.thinking,
      metadata: preparedOptions.metadata,
      webSearch: preparedOptions.webSearch,
      topP: preparedOptions.topP ?? preparedOptions.top_p,
      topK: preparedOptions.topK ?? preparedOptions.top_k,
      stopSequences: preparedOptions.stopSequences ?? preparedOptions.stop_sequences,
      stream: preparedOptions.stream,
      signal: options.signal,
      enableFGTS: preparedOptions.enableFGTS,
      ...(!options.disableThinking && options.effortLevel ? { effortLevel: options.effortLevel } : {}),
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
      cliLogger.warn('AnthropicAdapter', 'Warnings', prepared.validation.warnings);
    }

    const preparedOptions = prepared.options as ChatOptions & Record<string, any>;

    // 调用底层 provider
    yield* this.provider.chatStreamed(prepared.messages, {
      model: preparedOptions.model,
      tools: preparedOptions.tools,
      temperature: preparedOptions.temperature,
      maxTokens: preparedOptions.max_tokens,
      enableCaching: preparedOptions.enableCaching,
      cacheTtl: preparedOptions.cacheTtl,
      disableCaching: preparedOptions.disableCaching,
      thinking: options.disableThinking ? { type: 'disabled' as const } : preparedOptions.thinking,
      metadata: preparedOptions.metadata,
      webSearch: preparedOptions.webSearch,
      topP: preparedOptions.topP ?? preparedOptions.top_p,
      topK: preparedOptions.topK ?? preparedOptions.top_k,
      stopSequences: preparedOptions.stopSequences ?? preparedOptions.stop_sequences,
      signal: options.signal,
      enableFGTS: preparedOptions.enableFGTS,
      ...(!options.disableThinking && options.effortLevel ? { effortLevel: options.effortLevel } : {}),
    });
  }

  /**
   * 获取底层 provider（用于特殊情况）
   */
  getProvider(): AnthropicProvider {
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
      supportsThinking: (this.constraints as any).supportsThinking?.(modelName) || false,
      supportsPromptCaching: this.constraints.supportsPromptCaching(modelName),
      tokenLimits: this.constraints.getTokenLimits(modelName),
    };
  }

  /**
   * 获取 Prompt Caching 推荐
   */
  getCachingRecommendation(promptLength: number) {
    return this.promptBuilder.getCachingRecommendation(promptLength);
  }
}

/**
 * 创建 Anthropic Adapter 的便捷函数
 */
export function createAnthropicAdapter(config: AnthropicAdapterConfig): AnthropicAdapter {
  return new AnthropicAdapter(config);
}
