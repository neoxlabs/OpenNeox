/**
 * GLM Provider Adapter (智谱 AI)
 *
 * Uses OpenAI-compatible wire format with GLM-specific constraints.
 * Supports GLM-5, GLM-4.7, GLM-4 series.
 */

import { BaseAdapter, type ChatOptions, type PreparedRequest } from './base.js';
import { GLMConstraints } from '../constraints/glm.js';
import { OpenAIPromptBuilder } from '../prompts/openai.js';
import { GLMProvider, type GLMProviderConfig } from '@neoxlabs/kernel/models/glm.js';
import type { Message, ChatCompletionResponse } from '@neoxlabs/kernel/types/index.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

export interface GLMAdapterConfig {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  maxTokens?: number;
  maxInputTokens?: number;
  [key: string]: any;
}

export class GLMAdapter extends BaseAdapter {
  readonly constraints: GLMConstraints;
  readonly promptBuilder: OpenAIPromptBuilder;
  private provider: GLMProvider;
  private defaultModel: string;

  constructor(config: GLMAdapterConfig) {
    super();

    this.constraints = new GLMConstraints();
    this.promptBuilder = new OpenAIPromptBuilder();
    this.defaultModel = config.defaultModel || 'glm-4-plus';

    const { apiKey, baseUrl, defaultModel, maxTokens, maxInputTokens, ...rest } = config;
    this.provider = new GLMProvider({
      apiKey,
      baseUrl,
      defaultModel: this.defaultModel,
      maxTokens,
      maxInputTokens,
      ...rest,
      structuredOutputMode: 'json_object',
    } as GLMProviderConfig);
  }

  prepareRequest(messages: Message[], options: ChatOptions): PreparedRequest {
    const model = options.model || this.defaultModel;
    return super.prepareRequest(messages, { ...options, model });
  }

  async chat(messages: Message[], options: ChatOptions): Promise<ChatCompletionResponse> {
    const prepared = this.prepareRequest(messages, options);
    if (!prepared.validation?.valid) {
      const errors = prepared.validation?.errors || [];
      throw new Error(`Invalid parameters: ${errors.join(', ')}`);
    }
    if (prepared.validation?.warnings && prepared.validation.warnings.length > 0) {
      cliLogger.warn('GLMAdapter', 'Warnings', prepared.validation.warnings);
    }

    const model = prepared.options.model || this.defaultModel;
    const temperature = prepared.options.temperature ?? 0.7;

    return this.provider.chat(prepared.messages, {
      model,
      tools: prepared.options.tools,
      temperature,
      structuredOutput: prepared.options.structuredOutput,
      maxInputTokens: prepared.options.maxInputTokens,
      ...(options.disableThinking ? { thinking: { type: 'disabled' as const } } : {}),
    });
  }

  async *chatStreamed(messages: Message[], options: ChatOptions): AsyncGenerator<any> {
    const prepared = this.prepareRequest(messages, options);
    if (!prepared.validation?.valid) {
      const errors = prepared.validation?.errors || [];
      throw new Error(`Invalid parameters: ${errors.join(', ')}`);
    }
    if (prepared.validation?.warnings && prepared.validation.warnings.length > 0) {
      cliLogger.warn('GLMAdapter', 'Warnings', prepared.validation.warnings);
    }

    const model = prepared.options.model || this.defaultModel;
    const temperature = prepared.options.temperature ?? 0.7;

    yield* this.provider.chatStreamed(prepared.messages, {
      model,
      tools: prepared.options.tools,
      temperature,
      structuredOutput: prepared.options.structuredOutput,
      maxInputTokens: prepared.options.maxInputTokens,
      signal: options.signal,
      ...(options.disableThinking
        ? { thinking: { type: 'disabled' as const } }
        : options.effortLevel ? { effortLevel: options.effortLevel } : {}),
    });
  }

  getProvider(): GLMProvider {
    return this.provider;
  }
}

export function createGLMAdapter(config: GLMAdapterConfig): GLMAdapter {
  return new GLMAdapter(config);
}
