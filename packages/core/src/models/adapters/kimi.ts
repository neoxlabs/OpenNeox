/**
 * Kimi Provider Adapter
 *
 * Uses OpenAI-compatible wire format with Kimi-specific constraints.
 * - 所有线上模型 temperature 强制为 1, 支持 reasoning_content
 */

import { BaseAdapter, type ChatOptions, type PreparedRequest } from './base.js';
import { KimiConstraints, isFixedTemperatureModel } from '../constraints/kimi.js';
import { KimiPromptBuilder } from '../prompts/kimi.js';
import { KimiProvider, type KimiProviderConfig } from '@neoxlabs/kernel/models/kimi.js';
import type { Message, ChatCompletionResponse } from '@neoxlabs/kernel/types/index.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

export interface KimiAdapterConfig {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  maxTokens?: number;
  maxInputTokens?: number;
  [key: string]: any;
}

export class KimiAdapter extends BaseAdapter {
  readonly constraints: KimiConstraints;
  readonly promptBuilder: KimiPromptBuilder;
  private provider: KimiProvider;
  private defaultModel: string;

  constructor(config: KimiAdapterConfig) {
    super();

    this.constraints = new KimiConstraints();
    this.promptBuilder = new KimiPromptBuilder();
    this.defaultModel = config.defaultModel || 'kimi-k2.7-code';

    const { apiKey, baseUrl, defaultModel, maxTokens, maxInputTokens, ...rest } = config;
    this.provider = new KimiProvider({
      apiKey,
      baseUrl,
      defaultModel: this.defaultModel,
      maxTokens,
      maxInputTokens,
      ...rest,
      structuredOutputMode: 'json_object',
    } as KimiProviderConfig);
  }

  /** Resolve effective temperature: fixed models get 1, others keep user value */
  private resolveTemperature(model: string, temperature?: number): number {
    if (isFixedTemperatureModel(model)) {
      if (temperature !== undefined && temperature !== 1) {
        cliLogger.debug('KimiAdapter', `Model ${model} requires temperature=1, overriding ${temperature}`);
      }
      return 1;
    }
    return temperature ?? 0.7;
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
      cliLogger.warn('KimiAdapter', 'Warnings', prepared.validation.warnings);
    }

    const model = prepared.options.model || this.defaultModel;
    const temperature = this.resolveTemperature(model, prepared.options.temperature);

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
      cliLogger.warn('KimiAdapter', 'Warnings', prepared.validation.warnings);
    }

    const model = prepared.options.model || this.defaultModel;
    const temperature = this.resolveTemperature(model, prepared.options.temperature);

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

  getProvider(): KimiProvider {
    return this.provider;
  }
}

export function createKimiAdapter(config: KimiAdapterConfig): KimiAdapter {
  return new KimiAdapter(config);
}
