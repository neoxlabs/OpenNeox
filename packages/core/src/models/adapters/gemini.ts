/**
 * Gemini Provider Adapter
 *
 * 组合 GeminiConstraints + GeminiPromptBuilder + GeminiProvider
 */

import { BaseAdapter, type ChatOptions, type PreparedRequest } from './base.js';
import { GeminiConstraints } from '../constraints/gemini.js';
import { GeminiPromptBuilder } from '../prompts/gemini.js';
import { GeminiProvider } from '@neoxlabs/kernel/models/gemini.js';
import type { Message, ChatCompletionResponse } from '@neoxlabs/kernel/types/index.js';
import type { ProviderRetryConfig } from '@neoxlabs/kernel/types/retryConfig.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

export interface GeminiAdapterConfig {
  apiKey: string;
  baseUrl?: string;
  urlSuffix?: string;
  defaultModel?: string;
  retry?: ProviderRetryConfig;
  [key: string]: any;
}

export class GeminiAdapter extends BaseAdapter {
  readonly constraints: GeminiConstraints;
  readonly promptBuilder: GeminiPromptBuilder;
  private provider: GeminiProvider;
  private defaultModel: string;

  constructor(config: GeminiAdapterConfig) {
    super();

    this.constraints = new GeminiConstraints();
    this.promptBuilder = new GeminiPromptBuilder();
    this.defaultModel = config.defaultModel || 'gemini-2.5-flash';

    const { apiKey, baseUrl, urlSuffix, retry } = config;
    this.provider = new GeminiProvider(apiKey, baseUrl, retry, {
      pathPrefix: urlSuffix,
    });
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
      cliLogger.warn('GeminiAdapter', 'Warnings', prepared.validation.warnings);
    }

    return this.provider.chat(prepared.messages, {
      model: prepared.options.model,
      tools: prepared.options.tools,
      temperature: prepared.options.temperature,
      structuredOutput: prepared.options.structuredOutput,
      maxInputTokens: prepared.options.maxInputTokens,
      topP: prepared.options.topP,
      topK: prepared.options.topK,
      stopSequences: prepared.options.stopSequences,
    });
  }

  async *chatStreamed(messages: Message[], options: ChatOptions): AsyncGenerator<any> {
    const prepared = this.prepareRequest(messages, options);

    if (!prepared.validation?.valid) {
      const errors = prepared.validation?.errors || [];
      throw new Error(`Invalid parameters: ${errors.join(', ')}`);
    }

    if (prepared.validation?.warnings && prepared.validation.warnings.length > 0) {
      cliLogger.warn('GeminiAdapter', 'Warnings', prepared.validation.warnings);
    }

    yield* this.provider.chatStreamed(prepared.messages, {
      model: prepared.options.model,
      tools: prepared.options.tools,
      temperature: prepared.options.temperature,
      structuredOutput: prepared.options.structuredOutput,
      maxInputTokens: prepared.options.maxInputTokens,
      topP: prepared.options.topP,
      topK: prepared.options.topK,
      stopSequences: prepared.options.stopSequences,
      signal: options.signal,
    });
  }

  getProvider(): GeminiProvider {
    return this.provider;
  }
}

export function createGeminiAdapter(config: GeminiAdapterConfig): GeminiAdapter {
  return new GeminiAdapter(config);
}
