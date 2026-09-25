/**
 * GLM Provider (智谱 AI)
 *
 * OpenAI-compatible wire format targeting https://open.bigmodel.cn/api/paas/v4
 * Supports GLM-5, GLM-4.7, GLM-4 series models.
 */

import type { Message, ChatCompletionResponse, Tool, LLMProvider, StructuredOutputDefinition, TokenUsage, MessageContentPart } from '../types/index.js';
import { dumpLlmPayloadIfEnabled } from '../utils/payloadDump.js';
import { getTextFromContent } from '../utils/messageUtils.js';
import { cliLogger } from '../platform/cliLogger.js';
import { resolveEffortPayload, resolveDefaultThinkingLevel } from '../schemas/index.js';
import type { ProviderRetryConfig } from '../types/retryConfig.js';
import { OpenAICompatibleClient } from './openaiCompatibleClient.js';
import { truncateToolOutput, WIRE_TOOL_OUTPUT_MAX_UNITS } from '../utils/toolOutputTruncation.js';

interface ToolCallRequest {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

type StreamLifecycleChunk = { type: 'stream_retry' | 'stream_recovered' };

function isStreamLifecycleChunk(chunk: unknown): chunk is StreamLifecycleChunk {
  return !!chunk && typeof chunk === 'object' && (((chunk as { type?: string }).type === 'stream_retry') || ((chunk as { type?: string }).type === 'stream_recovered'));
}

interface GLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | any[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCallRequest[];
}

interface ChatCompletionsRequest {
  model: string;
  messages: GLMMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream_options?: { include_usage?: boolean };
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description?: string;
      parameters?: Record<string, any>;
    };
  }>;
  response_format?: { type: 'json_object' };
  /* GLM 4.7+ thinking mode 控制；未指定时遵循上游默认，简单任务可显式 disable。 */
  thinking?: { type: 'enabled' | 'disabled'; clear_thinking?: boolean };
}

export interface GLMProviderConfig {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  maxTokens?: number;
  maxInputTokens?: number;
  retry?: ProviderRetryConfig;
  structuredOutputMode?: string;
  [key: string]: any;
}

export class GLMProvider implements LLMProvider {
  private client: OpenAICompatibleClient;
  private defaultModel: string;

  constructor(config: GLMProviderConfig) {
    this.defaultModel = config.defaultModel || 'glm-4-plus';

    this.client = new OpenAICompatibleClient({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl || 'https://open.bigmodel.cn/api/paas/v4',
      providerName: 'GLM',
      retry: config.retry,
    });
  }

  async chat(
    messages: Message[],
    options: {
      model?: string;
      tools?: Tool[];
      temperature?: number;
      structuredOutput?: StructuredOutputDefinition;
      maxInputTokens?: number;
      disableSystemPrompt?: boolean;
      signal?: AbortSignal;
      /* GLM 4.7+ thinking control. 不传 → 走 GLM 上游 default (4.7+ enabled, 慢);
       *   { type:'disabled' } → 关 thinking, 响应秒级 (适合 side-agent / summary);
       *   { type:'enabled', clear_thinking: false } → 开 + 保留 CoT 给下一轮回传 (Preserved Thinking). */
      thinking?: { type: 'enabled' | 'disabled'; clear_thinking?: boolean };
    }
  ): Promise<ChatCompletionResponse> {
    const model = options.model || this.defaultModel;
    const payload = this.buildChatCompletionsPayload(messages, {
      model,
      tools: options.tools,
      temperature: options.temperature ?? 0.7,
      structuredOutput: options.structuredOutput,
      maxInputTokens: options.maxInputTokens,
      stream: false,
      disableSystemPrompt: options.disableSystemPrompt,
      thinking: options.thinking,
    });

    const raw = await this.client.postJson<any>('/chat/completions', payload, options.signal);
    return this.normalizeChatResponse(raw);
  }

  async *chatStreamed(
    messages: Message[],
    options: {
      model?: string;
      tools?: Tool[];
      temperature?: number;
      structuredOutput?: StructuredOutputDefinition;
      maxInputTokens?: number;
      disableSystemPrompt?: boolean;
      signal?: AbortSignal;
      /* GLM 4.7+ thinking control. 不传 → 走 GLM 上游 default (4.7+ enabled, 慢);
       *   { type:'disabled' } → 关 thinking, 响应秒级 (适合 side-agent / summary);
       *   { type:'enabled', clear_thinking: false } → 开 + 保留 CoT 给下一轮回传 (Preserved Thinking). */
      thinking?: { type: 'enabled' | 'disabled'; clear_thinking?: boolean };
      /** D13: schema-driven effort level. yaml effort_map[level] spread 进 payload. */
      effortLevel?: string;
    }
  ): AsyncGenerator<any> {
    const model = options.model || this.defaultModel;
    const payload = this.buildChatCompletionsPayload(messages, {
      model,
      tools: options.tools,
      temperature: options.temperature ?? 0.7,
      structuredOutput: options.structuredOutput,
      maxInputTokens: options.maxInputTokens,
      stream: true,
      disableSystemPrompt: options.disableSystemPrompt,
      thinking: options.thinking,
    });

    /* 用户没选 effort 时按 yaml default_level 注入默认思考档 (跟 anthropic/openai client 对齐) */
    const effectiveEffortLevel = options.effortLevel ?? resolveDefaultThinkingLevel(model) ?? undefined;
    if (effectiveEffortLevel) {
      const resolved = resolveEffortPayload(model, effectiveEffortLevel);
      for (const [k, v] of Object.entries(resolved.payload)) {
        if (!(k in payload)) (payload as any)[k] = v;
      }
    }

    for await (const chunk of this.client.streamJsonEvents('/chat/completions', payload, { signal: options.signal })) {
      if (isStreamLifecycleChunk(chunk)) {
        yield chunk;
        continue;
      }

      yield this.normalizeStreamChunk(chunk);
    }
  }

  private mapTools(tools?: Tool[]): ChatCompletionsRequest['tools'] | undefined {
    if (!tools || tools.length === 0) return undefined;

    return tools.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  private formatMessagesForChatCompletions(messages: Message[], disableSystemPrompt?: boolean): GLMMessage[] {
    const sourceMessages = disableSystemPrompt
      ? messages.filter(message => message.role !== 'system')
      : messages;

    return sourceMessages
      .filter(message => {
        const hasContent = message.content && (
          typeof message.content === 'string'
            ? message.content.trim().length > 0
            : Array.isArray(message.content) && message.content.length > 0
        );
        const hasToolCalls = !!(message.tool_calls && message.tool_calls.length > 0);
        return hasContent || hasToolCalls;
      })
      .map(message => {
        const formatted: GLMMessage = {
          role: message.role as GLMMessage['role'],
          content: null,
        };

        if (message.role === 'tool') {
          const rawContent = typeof message.content === 'string'
            ? message.content
            : getTextFromContent(message.content);
          formatted.content = truncateToolOutput(rawContent, WIRE_TOOL_OUTPUT_MAX_UNITS);
        } else if (Array.isArray(message.content)) {
          formatted.content = message.content as MessageContentPart[];
        } else if (message.tool_calls && message.tool_calls.length > 0) {
          formatted.content = message.content || '';
        } else {
          formatted.content = message.content || null;
        }

        if (message.name) formatted.name = message.name;
        if (message.tool_call_id) formatted.tool_call_id = message.tool_call_id;
        if (message.tool_calls) {
          formatted.tool_calls = message.tool_calls.map(toolCall => ({
            id: toolCall.id,
            type: 'function' as const,
            function: {
              name: toolCall.function.name,
              arguments: toolCall.function.arguments,
            },
          }));
        }

        return formatted;
      });
  }

  private buildChatCompletionsPayload(
    messages: Message[],
    options: {
      model: string;
      tools?: Tool[];
      temperature: number;
      structuredOutput?: StructuredOutputDefinition;
      maxInputTokens?: number;
      stream: boolean;
      disableSystemPrompt?: boolean;
      thinking?: { type: 'enabled' | 'disabled'; clear_thinking?: boolean };
    }
  ): ChatCompletionsRequest {
    const { model, tools, temperature, structuredOutput, maxInputTokens, stream, disableSystemPrompt, thinking } = options;

    const payload: ChatCompletionsRequest = {
      model,
      messages: this.formatMessagesForChatCompletions(messages, disableSystemPrompt),
      stream,
      temperature,
    };

    /* GLM 4.7+ thinking 控制: 不传 → 走 GLM 上游 default (4.7+ enabled, 慢);
     * 传 { type:'disabled' } → 关 thinking, 响应秒级 (适合 side-agent / summary). */
    if (thinking) {
      payload.thinking = thinking;
    }

    /* 为 GLM thinking 模型按 family tier 设置默认输出预算；调用方显式值优先。 */
    const effectiveMaxTokens = maxInputTokens ?? this.defaultMaxTokensForModel(model);
    if (effectiveMaxTokens !== undefined) {
      payload.max_tokens = effectiveMaxTokens;
    }

    const mappedTools = this.mapTools(tools);
    if (mappedTools && mappedTools.length > 0) {
      payload.tools = mappedTools;
      /* GLM 只支持 tool_choice='auto' (官方 API ref). 即使 caller 给 required / 具名,
       * 我们刻意不发字段, GLM 走默认 auto. 如果上层 strict 模式想 force tool, 应该改 prompt
       * 引导而不是 tool_choice (传了 GLM 400). 详见 docs/MODEL_API_PROFILES.md §2. */
    }

    if (structuredOutput) {
      payload.response_format = { type: 'json_object' };
    }

    if (stream) {
      payload.stream_options = { include_usage: true };
    }

    dumpLlmPayloadIfEnabled('glm', payload);
    return payload;
  }

  /** GLM thinking-aware default max_tokens. 4.x 系列 thinking 轻, 5/5.1 重. */
  private defaultMaxTokensForModel(model: string): number | undefined {
    const lc = (model || '').toLowerCase();
    if (lc.startsWith('glm-5')) return 4000;          /* 5 / 5.1 / 5-turbo: thinking 重 */
    if (/^glm-4\.\d/.test(lc)) return 1500;            /* 4.5 / 4.6 / 4.7: thinking 中 */
    return undefined;                                   /* 其他模型遵循服务端默认 */
  }

  private normalizeUsage(rawUsage: any): TokenUsage {
    const usage = rawUsage || {};

    const promptTokens = Number(usage.prompt_tokens || 0);
    const completionTokens = Number(usage.completion_tokens || 0);
    const totalTokens = Number(usage.total_tokens || promptTokens + completionTokens);

    return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      cached_tokens: usage.cached_tokens,
      prompt_cache_hit_tokens: usage.prompt_cache_hit_tokens,
      prompt_cache_miss_tokens: usage.prompt_cache_miss_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens,
      cache_write_input_tokens: usage.cache_write_input_tokens,
      prompt_tokens_details: usage.prompt_tokens_details,
      completion_tokens_details: usage.completion_tokens_details,
    };
  }

  private normalizeChatResponse(raw: any): ChatCompletionResponse {
    const choices = Array.isArray(raw?.choices) ? raw.choices : [];

    if (choices.length === 0) {
      throw new Error('GLM returned empty choices');
    }

    const first = choices[0] || {};
    const message = first.message || {};
    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls.map((toolCall: any) => ({
          id: toolCall.id,
          type: 'function' as const,
          function: {
            name: toolCall?.function?.name || '',
            arguments: toolCall?.function?.arguments || '{}',
          },
        }))
      : undefined;

    return {
      id: raw?.id || `glm-${Date.now()}`,
      choices: [{
        message: {
          role: 'assistant',
          content: message.content ?? null,
          ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: first.finish_reason || 'stop',
      }],
      usage: this.normalizeUsage(raw?.usage),
    };
  }

  private normalizeStreamChunk(chunk: any): any {
    if (!chunk || typeof chunk !== 'object') {
      return {
        choices: [{ index: 0, delta: {}, finish_reason: null }],
      };
    }

    if (chunk.usage) {
      chunk.usage = this.normalizeUsage(chunk.usage);
    }

    if (!Array.isArray(chunk.choices)) {
      return {
        ...chunk,
        choices: [{ index: 0, delta: {}, finish_reason: null }],
      };
    }

    return chunk;
  }
}
