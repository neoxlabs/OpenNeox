/**
 * 豆包 (Doubao) Responses API Provider
 *
 * 火山方舟豆包模型专用适配，完整支持:
 * - Responses API (/api/v3/responses)
 * - 上下文管理 (previous_response_id 链式引用)
 * - 上下文缓存 (前缀缓存/Session缓存)
 * - 深度思考控制 (thinking)
 * - 思考长度调节 (reasoning.effort)
 * - 工具调用 (Function Calling)
 * - 多模态理解 (图片/视频/文档)
 * - 流式响应 (SSE)
 *
 * 参考文档: https://www.volcengine.com/docs/82379/1399327
 */

import axios, { type AxiosInstance } from 'axios';
import { dumpLlmPayloadIfEnabled } from '../utils/payloadDump.js';
import { truncateToolOutput, WIRE_TOOL_OUTPUT_MAX_UNITS } from '../utils/toolOutputTruncation.js';
import { resolveEffortPayload, resolveDefaultThinkingLevel } from '../schemas/index.js';
import type {
  Message,
  ChatCompletionResponse,
  Tool,
  ToolCall,
  LLMProvider,
  StructuredOutputDefinition,
  TokenUsage,
} from '../types/index.js';
import { getTextFromContent } from '../utils/messageUtils.js';
import { logger } from '../utils/logger.js';
import { cliLogger } from '../platform/cliLogger.js';
import { getNeoxUserAgent } from '../utils/neoxUserAgent.js';
import {
  type RetryConfig,
  type ProviderRetryConfig,
  mergeRetryConfig,
} from '../types/retryConfig.js';
import { classifyError, parseRetryAfter } from '../types/errors.js';
import { createUtf8ChunkDecoder } from '../utils/utf8StreamDecoder.js';
import { getRetryDelay, sleep, abortableSleep, formatDelay } from '../utils/backoff.js';

// ============================================================================
// 豆包 Responses API 类型定义
// ============================================================================

type AbortLikeError = Error & { name: string };
type IndexedToolCall = ToolCall & { index?: number };

/** 深度思考配置 */
interface DoubaoThinkingConfig {
  /** enabled: 强制开启, disabled: 强制关闭, auto: 模型自行判断 */
  type: 'enabled' | 'disabled' | 'auto';
}

/** 思考长度配置 */
interface DoubaoReasoningConfig {
  /** minimal: 关闭思考, low: 轻量思考, medium: 均衡(默认), high: 深度分析 */
  effort?: 'minimal' | 'low' | 'medium' | 'high';
  summary?: 'auto' | 'concise' | 'detailed';
}

/** 缓存配置 */
interface DoubaoCachingConfig {
  type: 'enabled' | 'disabled';
  /** 前缀缓存模式 - 用于固定的系统提示词 */
  prefix?: boolean;
}

/** 文本格式配置 */
interface DoubaoTextConfig {
  format?: {
    type: 'text' | 'json_object' | 'json_schema';
    name?: string;
    schema?: Record<string, any>;
  };
}

/** 输入内容类型 */
type DoubaoInputContentType =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url?: string; file_id?: string }
  | { type: 'input_video'; file_id: string }
  | { type: 'input_file'; file_id: string };

/** 输入消息 */
interface DoubaoInputMessage {
  type: 'message';
  role: 'user' | 'assistant' | 'system';
  content: DoubaoInputContentType[];
  status?: 'completed';
}

/** 函数调用输入 */
interface DoubaoFunctionCallInput {
  type: 'function_call';
  id: string;
  call_id: string;
  name: string;
  arguments: string;
  status: 'completed';
}

/** 函数调用输出 */
interface DoubaoFunctionCallOutputInput {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

type DoubaoInputItem = DoubaoInputMessage | DoubaoFunctionCallInput | DoubaoFunctionCallOutputInput;

/** Responses API 请求 */
interface DoubaoResponsesRequest {
  model: string;
  input: DoubaoInputItem[] | Array<{role: string; content: string}> | string;
  instructions?: string;
  stream?: boolean;

  // Token 控制
  max_output_tokens?: number;
  max_input_tokens?: number;

  // 采样参数
  temperature?: number;
  top_p?: number;

  // 工具
  tools?: Array<{
    type: 'function';
    name: string;
    description?: string;
    parameters?: Record<string, any>;
  }>;
  tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };

  // 豆包特有配置
  thinking?: DoubaoThinkingConfig;
  reasoning?: DoubaoReasoningConfig;
  caching?: DoubaoCachingConfig;
  text?: DoubaoTextConfig;

  // 会话管理
  previous_response_id?: string;
  store?: boolean;
  expire_at?: number;

  // 元数据
  metadata?: Record<string, any>;
  user?: string;
}

/** 输出文本内容 */
interface DoubaoOutputText {
  type: 'output_text';
  text: string;
  annotations?: any[];
}

/** 思考摘要 */
interface DoubaoThinkingSummary {
  type: 'summary_text';
  text: string;
}

/** 推理输出 */
interface DoubaoReasoningOutput {
  id: string;
  type: 'reasoning';
  summary: DoubaoThinkingSummary[];
  status: 'completed';
}

/** 消息输出 */
interface DoubaoMessageOutput {
  type: 'message';
  id: string;
  role: 'assistant';
  content: DoubaoOutputText[];
  status: 'completed';
}

/** 函数调用输出 */
interface DoubaoFunctionCallOutput {
  type: 'function_call';
  id: string;
  call_id: string;
  name: string;
  arguments: string;
  status: 'completed';
}

type DoubaoOutputItem = DoubaoReasoningOutput | DoubaoMessageOutput | DoubaoFunctionCallOutput;

/** Usage 统计 */
interface DoubaoUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: {
    cached_tokens?: number;
  };
  output_tokens_details?: {
    reasoning_tokens?: number;
  };
}

/** Responses API 响应 */
interface DoubaoResponsesResponse {
  id: string;
  object: 'response';
  created_at: number;
  model: string;
  status: 'completed' | 'incomplete' | 'failed';
  incomplete_details?: { reason?: string };
  output: DoubaoOutputItem[];
  usage: DoubaoUsage;
  store: boolean;
  expire_at?: number;
  error?: {
    code: string;
    message: string;
  };
}

/** 流式事件类型 */
type DoubaoStreamEventType =
  | 'response.created'
  | 'response.in_progress'
  | 'response.output_item.added'
  | 'response.output_text.delta'
  | 'response.output_text.done'
  | 'response.reasoning_summary_part.added'
  | 'response.reasoning_summary_part.done'
  | 'response.reasoning_summary_text.delta'
  | 'response.reasoning_summary_text.done'
  | 'response.function_call_arguments.delta'
  | 'response.function_call_arguments.done'
  | 'response.output_item.done'
  | 'response.completed'
  | 'response.incomplete'
  | 'response.failed'
  | 'response.error';

/** 流式事件 */
interface DoubaoStreamEvent {
  type: DoubaoStreamEventType;
  response?: DoubaoResponsesResponse;
  output_index?: number;
  item_id?: string;
  item?: DoubaoOutputItem;
  delta?: string;
  error?: {
    code: string;
    message: string;
  };
}

/** 流式响应 Chunk (OpenAI 兼容格式) */
interface StreamChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  type?: string;
  error?: string;
  errorCode?: string;
  attempt?: number;
  maxRetries?: number;
  delayMs?: number;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: TokenUsage;
}

// ============================================================================
// 豆包 Provider 配置
// ============================================================================

export interface DoubaoProviderConfig {
  apiKey: string;
  /** 默认: https://ark.cn-beijing.volces.com/api/v3 */
  baseUrl?: string;
  /** 默认模型，如 doubao-seed-1-6-251015 */
  defaultModel?: string;
  /** 深度思考配置 */
  thinking?: DoubaoThinkingConfig;
  /** 思考长度配置 */
  reasoning?: DoubaoReasoningConfig;
  /** 缓存配置 */
  caching?: DoubaoCachingConfig;
  /** 是否存储对话 (默认 true) */
  store?: boolean;
  /** 重试配置 */
  retry?: ProviderRetryConfig;
}

// ============================================================================
// 豆包 Provider 实现
// ============================================================================

export class DoubaoProvider implements LLMProvider {
  private client: AxiosInstance;
  private defaultModel: string;
  private retryConfig: RetryConfig;
  private baseUrl: string;

  // 豆包特有配置
  private thinking?: DoubaoThinkingConfig;
  private reasoning?: DoubaoReasoningConfig;
  private caching: DoubaoCachingConfig;
  private store: boolean;

  // 会话管理 - 存储 response_id 用于多轮对话
  private lastResponseId: string | null = null;
  private sessionResponseIds: Map<string, string> = new Map();

  constructor(config: DoubaoProviderConfig) {
    this.baseUrl = config.baseUrl || 'https://ark.cn-beijing.volces.com/api/v3';
    this.defaultModel = config.defaultModel || 'doubao-seed-1-6-251015';
    this.thinking = config.thinking; // 不设置默认值，让模型自动判断（auto模式）
    this.reasoning = config.reasoning; // 不设置默认值
    // Session 缓存默认开启，利用 previous_response_id 实现多轮对话上下文复用
    this.caching = config.caching || { type: 'enabled' };
    this.store = config.store ?? true;

    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': getNeoxUserAgent(),
      },
      timeout: 180000, // 豆包深度思考可能需要较长时间
    });

    // 默认重试配置
    this.retryConfig = mergeRetryConfig(undefined, {
      requestMaxRetries: 3,
      streamMaxRetries: 5,
      ...config.retry,
    });

    if (process.env.CLI_DEBUG_CONSOLE === '1') {
      console.log('[Doubao] Initialized with:', {
        baseUrl: this.baseUrl,
        defaultModel: this.defaultModel,
        thinking: this.thinking,
        caching: this.caching,
        store: this.store,
      });
    }
  }

  // ============================================================================
  // 公共接口
  // ============================================================================

  async chat(
    messages: Message[],
    options: {
      model?: string;
      tools?: Tool[];
      temperature?: number;
      structuredOutput?: StructuredOutputDefinition;
      maxInputTokens?: number;
      sessionId?: string;
    } = {}
  ): Promise<ChatCompletionResponse> {
    // 豆包 Responses API 必须使用流式，收集后返回
    const contentChunks: string[] = [];
    const reasoningChunks: string[] = [];
    const toolCalls: IndexedToolCall[] = [];
    let usage: TokenUsage | undefined;
    let responseId: string | undefined;
    let finishReason = 'stop';

    for await (const chunk of this.chatStreamed(messages, options)) {
      const delta = chunk.choices?.[0]?.delta;
      if (delta) {
        if (delta.content) contentChunks.push(delta.content);
        if (delta.reasoning_content) reasoningChunks.push(delta.reasoning_content);
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const existing = toolCalls.find(t => t.index === tc.index);
            if (existing) {
              if (tc.function?.arguments) {
                existing.function.arguments += tc.function.arguments;
              }
            } else {
              toolCalls.push({
                id: tc.id || `call_${toolCalls.length}`,
                type: 'function',
                function: {
                  name: tc.function?.name || '',
                  arguments: tc.function?.arguments || '',
                },
                index: tc.index,
              } as ToolCall & { index?: number });
            }
          }
        }
      }

      if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
      if (chunk.usage) usage = chunk.usage;
      if (chunk.id) responseId = chunk.id;
    }

    // 保存 response_id 用于后续多轮对话
    if (responseId) {
      this.lastResponseId = responseId;
      if (options.sessionId) {
        this.sessionResponseIds.set(options.sessionId, responseId);
      }
    }

    return {
      id: responseId || `chatcmpl-${Date.now()}`,
      choices: [{
        message: {
          role: 'assistant',
          content: contentChunks.length > 0 ? contentChunks.join('') : null,
          reasoning_content: reasoningChunks.length > 0 ? reasoningChunks.join('') : undefined,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      }],
      usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }

  async *chatStreamed(
    messages: Message[],
    options: {
      model?: string;
      tools?: Tool[];
      temperature?: number;
      structuredOutput?: StructuredOutputDefinition;
      maxInputTokens?: number;
      sessionId?: string;
      previousResponseId?: string;
      signal?: AbortSignal;
      effortLevel?: string;
    } = {}
  ): AsyncGenerator<StreamChunk> {
    const { model = this.defaultModel, tools, temperature = 0.7, sessionId, signal } = options;

    // 获取 previous_response_id
    let previousResponseId = options.previousResponseId;
    if (!previousResponseId && sessionId) {
      previousResponseId = this.sessionResponseIds.get(sessionId);
    }
    if (!previousResponseId) {
      previousResponseId = this.lastResponseId || undefined;
    }

    const payload = this.buildPayload(messages, {
      model,
      tools,
      temperature,
      structuredOutput: options.structuredOutput,
      maxInputTokens: options.maxInputTokens,
      previousResponseId,
    });

    /* D13: yaml effort_map[level] fields spread 进 payload */
    const effectiveEffortLevel = options.effortLevel ?? resolveDefaultThinkingLevel(model) ?? undefined;
    if (effectiveEffortLevel) {
      const resolved = resolveEffortPayload(model, effectiveEffortLevel);
      for (const [k, v] of Object.entries(resolved.payload)) {
        if (!(k in payload)) (payload as any)[k] = v;
      }
    }

    const requestUrl = `${this.baseUrl}/responses`;
    logger.llmRequest('doubao-responses', model, payload, requestUrl, { 'Authorization': 'Bearer ***' });

    if (process.env.CLI_DEBUG_CONSOLE === '1') {
      console.log('\n[Doubao Responses API Request]');
      console.log('URL:', requestUrl);
      console.log('Payload:', JSON.stringify(payload, null, 2));
    }

    const maxStreamRetries = this.retryConfig.streamMaxRetries;
    let streamRetries = 0;
    /* 吐过内容就不在这里整段重发 (会跟上层攒着的半截拼成两遍), 交给 runner 级重试 —— 同 anthropic.ts */
    let emittedContent = false;

    while (true) {
      try {
        // Check if already aborted before making request
        if (signal?.aborted) {
          const abortError = new Error('Request aborted') as AbortLikeError;
          abortError.name = 'AbortError';
          throw abortError;
        }

        const startTime = Date.now();
        const response = await this.client.post('/responses', payload, {
          responseType: 'stream',
          signal,
          headers: {
            'Accept': 'text/event-stream',
          },
        });

        if (process.env.CLI_DEBUG_CONSOLE === '1') {
          console.log('\n[Doubao Stream Started]');
          console.log('Status:', response.status);
        }

        if (response.status !== 200) {
          let errorData = '';
          for await (const chunk of response.data) {
            errorData += chunk.toString();
          }
          throw new Error(`Doubao API error: ${response.status} - ${errorData}`);
        }

        for await (const chunk of this.parseStreamResponse(response.data)) {
          const d = chunk.choices?.[0]?.delta as any;
          if (d && (d.content || d.reasoning_content || d.tool_calls)) emittedContent = true;
          yield chunk;
        }

        const duration = Date.now() - startTime;
        logger.llmResponse('doubao-responses', duration, {}, {});

        if (process.env.CLI_DEBUG_CONSOLE === '1') {
          console.log('\n[Doubao Stream Complete]');
          console.log('Duration:', `${duration}ms`);
        }

        return;

      } catch (error: any) {
        // 尝试从 axios 错误响应中读取详细错误信息
        let errorDetails = '';
        if (error.response?.data) {
          try {
            // 如果 data 是流，尝试读取内容
            if (typeof error.response.data.on === 'function') {
              const chunks: Buffer[] = [];
              for await (const chunk of error.response.data) {
                chunks.push(Buffer.from(chunk));
              }
              const rawData = Buffer.concat(chunks).toString('utf-8');
              try {
                const parsed = JSON.parse(rawData);
                const safeData = parsed.error || { message: parsed.message, code: parsed.code, type: parsed.type };
                errorDetails = JSON.stringify(safeData, null, 2);
              } catch {
                errorDetails = rawData;
              }
            } else if (typeof error.response.data === 'string') {
              errorDetails = error.response.data;
            } else if (error.response.data.error) {
              const errObj = error.response.data.error;
              const safeErr = { message: errObj.message, code: errObj.code, type: errObj.type };
              errorDetails = JSON.stringify(safeErr, null, 2);
            } else {
              const data = error.response.data;
              const safeData = { message: data.message, code: data.code, type: data.type, error: data.error };
              errorDetails = JSON.stringify(safeData, null, 2);
            }
          } catch (readError) {
            errorDetails = `HTTP ${error.response?.status || 'unknown'} (无法读取响应体: ${readError})`;
          }
        }

        const classifiedError = classifyError(error);

        if (process.env.CLI_DEBUG_CONSOLE === '1') {
          console.log('\n[Doubao Stream Error]');
          console.log('Message:', error.message);
          console.log('Status:', error.response?.status);
          console.log('Error Details:', errorDetails || 'none');
          console.log('Retryable:', classifiedError.retryable);
        }

        // 如果有详细错误信息，添加到 classifiedError
        if (errorDetails) {
          classifiedError.message = `${error.message}\n${errorDetails}`;
        }

        logger.llmError('doubao-responses', error);

        if (!emittedContent && classifiedError.retryable && streamRetries < maxStreamRetries) {
          streamRetries++;

          const retryAfter = error.response?.headers?.['retry-after'];
          const serverDelay = parseRetryAfter(retryAfter);
          const delay = getRetryDelay(serverDelay, streamRetries, this.retryConfig);

          console.log(
            `[Doubao] Stream failed (${classifiedError.code}), ` +
            `reconnecting in ${formatDelay(delay)} (${streamRetries}/${maxStreamRetries})...`
          );

          yield {
            choices: [],
            type: 'stream_retry',
            error: classifiedError.message,
            errorCode: classifiedError.code,
            attempt: streamRetries,
            maxRetries: maxStreamRetries,
            delayMs: delay,
          };

          try {
            await abortableSleep(delay, options.signal);
          } catch (abortError: any) {
            if (abortError?.name === 'AbortError') {
              throw abortError;
            }
            throw abortError;
          }
          continue;
        }

        throw classifiedError;
      }
    }
  }

  // ============================================================================
  // 会话管理
  // ============================================================================

  /**
   * 获取指定会话的 previous_response_id
   */
  getResponseId(sessionId?: string): string | null {
    if (sessionId) {
      return this.sessionResponseIds.get(sessionId) || null;
    }
    return this.lastResponseId;
  }

  /**
   * 设置指定会话的 previous_response_id
   */
  setResponseId(responseId: string, sessionId?: string): void {
    this.lastResponseId = responseId;
    if (sessionId) {
      this.sessionResponseIds.set(sessionId, responseId);
    }
  }

  /**
   * 清除会话的 response_id (开始新对话)
   */
  clearSession(sessionId?: string): void {
    if (sessionId) {
      this.sessionResponseIds.delete(sessionId);
    } else {
      this.lastResponseId = null;
    }
  }

  /**
   * 更新深度思考配置
   */
  setThinking(config: DoubaoThinkingConfig): void {
    this.thinking = config;
  }

  /**
   * 更新缓存配置
   */
  setCaching(config: DoubaoCachingConfig): void {
    this.caching = config;
  }

  // ============================================================================
  // 请求构建
  // ============================================================================

  private buildPayload(
    messages: Message[],
    options: {
      model: string;
      tools?: Tool[];
      temperature: number;
      structuredOutput?: StructuredOutputDefinition;
      maxInputTokens?: number;
      previousResponseId?: string;
    }
  ): DoubaoResponsesRequest {
    const { model, tools, temperature, structuredOutput, maxInputTokens, previousResponseId } = options;

    // 豆包上下文管理：
    // - 有 previous_response_id：只发送最新的用户消息/工具结果（服务端自动加载历史）
    // - 无 previous_response_id：发送完整对话历史（首轮对话）
    const input = this.convertToDoubaoInput(messages, previousResponseId);
    const instructions = this.extractSystemInstructions(messages);

    const payload: DoubaoResponsesRequest = {
      model,
      input,
      stream: true,
      temperature,
      // store: this.store,  // 暂时移除，测试是否是这个参数导致的400
    };

    // 豆包不使用 instructions 字段，因为和 caching 冲突
    // 系统提示词通过 input 中的 system 消息传递
    // if (instructions) {
    //   payload.instructions = instructions;
    // }

    // 会话管理 - 使用 previous_response_id 链接上下文
    if (previousResponseId) {
      payload.previous_response_id = previousResponseId;
    }

    // 深度思考 - 只在明确配置时才发送，否则让模型自动判断（auto模式）
    if (this.thinking) {
      payload.thinking = this.thinking;
    }

    // 思考长度 - 只在明确配置时才发送
    if (this.reasoning) {
      payload.reasoning = this.reasoning;
    }

    // Session 缓存 - 暂时禁用，因为和 tools 冲突
    // 使用 previous_response_id 时不能发送 tools
    // if (this.caching.type === 'enabled') {
    //   payload.caching = this.caching;
    // }

    // Token 限制 - 注意：Responses API 不支持 max_input_tokens，暂时移除
    // if (maxInputTokens !== undefined) {
    //   payload.max_input_tokens = maxInputTokens;
    // }

    // 工具
    if (tools && tools.length > 0) {
      payload.tools = tools.map(tool => ({
        type: 'function' as const,
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));

      if (process.env.CLI_DEBUG_CONSOLE === '1') {
        console.log(`[Doubao] Added ${payload.tools.length} tools`);
      }
    }

    // 结构化输出
    if (structuredOutput) {
      payload.text = {
        format: {
          type: 'json_schema',
          name: structuredOutput.name,
          schema: structuredOutput.schema,
        },
      };
    }

    dumpLlmPayloadIfEnabled('doubao', payload);
    return payload;
  }

  private extractSystemInstructions(messages: Message[]): string | undefined {
    const systemMessages = messages
      .filter(msg => msg.role === 'system')
      .map(msg => getTextFromContent(msg.content).trim())
      .filter(text => text.length > 0);

    return systemMessages.length > 0 ? systemMessages.join('\n\n') : undefined;
  }

  private convertToDoubaoInput(messages: Message[], previousResponseId?: string): Array<{role: string; content: string}> | DoubaoInputItem[] {
    const toolCallIdMap = new Map<string, string>();

    // 不过滤 system 消息，因为豆包不使用 instructions 字段（和 caching 冲突）
    // system 消息通过 input 传递

    // 检查是否有工具调用相关的消息
    const hasToolMessages = messages.some(msg => 
      msg.role === 'tool' || 
      (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0)
    );

    // 如果没有工具调用，使用简单的 OpenAI 兼容格式
    if (!hasToolMessages) {
      return messages.map(msg => ({
        role: msg.role,
        content: getTextFromContent(msg.content),
      }));
    }
    
    // 过滤掉 system 消息用于工具调用场景（工具调用格式不支持 system）
    const nonSystemMessages = messages.filter(msg => msg.role !== 'system');

    // 有工具调用时，使用完整的 DoubaoInputItem 格式
    // 如果有 previous_response_id（多轮对话），只发送最新的交互
    if (previousResponseId) {
      // 找到最后一组交互：
      // - 最后的 user 消息
      // - 工具调用的结果（tool 消息）
      const result: DoubaoInputItem[] = [];

      // 从后往前找，收集最新的一轮交互
      let foundUserMessage = false;
      for (let i = nonSystemMessages.length - 1; i >= 0; i--) {
        const msg = nonSystemMessages[i];

        if (msg.role === 'user' && !foundUserMessage) {
          // 最新的用户消息 - 使用完整格式（和健康检测一致）
          result.unshift(...this.convertMessageToInputItems(msg, toolCallIdMap));
          foundUserMessage = true;
        } else if (msg.role === 'tool' && foundUserMessage) {
          // 工具调用结果
          result.unshift(...this.convertMessageToInputItems(msg, toolCallIdMap));
        } else if (foundUserMessage) {
          // 已经找到用户消息，停止收集
          break;
        }
      }

      return result;
    }

    // 首轮对话：使用完整格式（和健康检测一致）
    return nonSystemMessages.flatMap(msg =>
      this.convertMessageToInputItems(msg, toolCallIdMap)
    ).filter(item => item !== null);
  }

  private convertMessageToInputItems(msg: Message, idMap: Map<string, string>): DoubaoInputItem[] {
    if (msg.role === 'assistant') {
      const items: DoubaoInputItem[] = [];
      const textContent = getTextFromContent(msg.content);

      if (textContent.trim().length > 0) {
        items.push({
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'input_text', text: textContent }],
        });
      }

      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        for (const toolCall of msg.tool_calls) {
          const normalizedId = this.normalizeCallId(toolCall.id, idMap);
          items.push({
            type: 'function_call',
            id: normalizedId,
            call_id: normalizedId,
            name: toolCall.function.name,
            arguments: toolCall.function.arguments || '',
            status: 'completed',
          });
        }
      }

      return items;
    }

    if (msg.role === 'tool') {
      const normalizedId = this.normalizeCallId(msg.tool_call_id || msg.name, idMap);
      const rawOutput = getTextFromContent(msg.content);
      const truncatedOutput = truncateToolOutput(rawOutput, WIRE_TOOL_OUTPUT_MAX_UNITS);
      return [{
        type: 'function_call_output',
        call_id: normalizedId,
        output: truncatedOutput,
      }];
    }

    // User message - 支持多模态
    if (Array.isArray(msg.content)) {
      const contentItems: DoubaoInputContentType[] = [];
      for (const part of msg.content) {
        if (part.type === 'text' && part.text.trim()) {
          contentItems.push({ type: 'input_text', text: part.text });
        } else if (part.type === 'image_url') {
          contentItems.push({ type: 'input_image', image_url: part.image_url.url });
        }
      }
      if (contentItems.length === 0) return [];
      return [{ type: 'message', role: 'user', content: contentItems }];
    }

    const textContent = getTextFromContent(msg.content);
    if (!textContent || textContent.trim().length === 0) return [];

    return [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: textContent }],
    }];
  }

  private normalizeCallId(originalId: string | undefined, idMap: Map<string, string>): string {
    if (originalId && idMap.has(originalId)) {
      return idMap.get(originalId)!;
    }

    let normalizedId: string;
    if (originalId) {
      // 豆包使用 fc_ 前缀
      normalizedId = originalId.startsWith('fc_') ? originalId : `fc_${originalId}`;
    } else {
      normalizedId = `fc_${Math.random().toString(36).slice(2, 10)}`;
    }

    if (originalId) {
      idMap.set(originalId, normalizedId);
    } else {
      idMap.set(normalizedId, normalizedId);
    }

    return normalizedId;
  }

  // ============================================================================
  // 流解析
  // ============================================================================

  private async *parseStreamResponse(stream: any): AsyncGenerator<StreamChunk> {
    let buffer = '';
    const toolCallState = new Map<string, { id: string; name: string; index: number; arguments: string }>();
    let nextToolCallIndex = 0;
    let finalResponseData: DoubaoResponsesResponse | null = null;
    let finalUsage: DoubaoUsage | null = null;
    let incompleteFinishReason: 'length' | 'content_filter' | undefined;
    let sawTerminalEvent = false;
    let hasEmittedContent = false;
    let roleSent = false;
    let responseId: string | undefined;

    const emitDeltaChunk = (delta: any): StreamChunk => {
      const payloadDelta: any = { ...delta };
      if (!roleSent) {
        payloadDelta.role = 'assistant';
        roleSent = true;
      }
      return {
        id: responseId,
        choices: [{ index: 0, delta: payloadDelta }],
      };
    };

    const decodeChunk = createUtf8ChunkDecoder();
    for await (const chunk of stream) {
      buffer += decodeChunk(chunk);   /* 跨 chunk 的半个汉字要留到下一块 (见 utf8StreamDecoder) */
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine || !trimmedLine.startsWith('data: ')) continue;

        const data = trimmedLine.slice(6);
        if (data === '[DONE]') {
          if (process.env.CLI_DEBUG_CONSOLE === '1') {
            console.log('[Doubao Stream] Received [DONE]');
          }
          continue;
        }

        let event: DoubaoStreamEvent;
        try {
          event = JSON.parse(data);
        } catch {
          if (process.env.CLI_DEBUG_CONSOLE === '1') {
            console.log('[Doubao Stream] Invalid JSON:', data);
          }
          continue;
        }

        if (process.env.CLI_DEBUG_CONSOLE === '1') {
          console.log('[Doubao Stream Event]', event.type, JSON.stringify(event, null, 2).slice(0, 200));
        }

        switch (event.type) {
          case 'response.created':
          case 'response.in_progress':
            if (event.response?.id) {
              responseId = event.response.id;
            }
            break;

          case 'response.output_text.delta': {
            const text = typeof event.delta === 'string' ? event.delta : '';
            if (!text) break;
            hasEmittedContent = true;
            yield emitDeltaChunk({ content: text });
            break;
          }

          // 处理思考过程的实时流式输出
          case 'response.reasoning_summary_text.delta': {
            const text = typeof event.delta === 'string' ? event.delta : '';
            if (!text) break;
            hasEmittedContent = true;
            yield emitDeltaChunk({ reasoning_content: text });
            break;
          }

          case 'response.reasoning_summary_part.added':
          case 'response.reasoning_summary_part.done':
            // 这些事件只是标记，不需要特殊处理
            break;

          case 'response.output_item.added': {
            if (event.item?.type === 'function_call') {
              const item = event.item as DoubaoFunctionCallOutput;
              const key = item.id || `item_${event.output_index}`;
              const state = {
                id: item.call_id || item.id || `call_${Date.now()}_${nextToolCallIndex}`,
                name: item.name,
                index: nextToolCallIndex++,
                arguments: '',
              };
              toolCallState.set(key, state);

              hasEmittedContent = true;
              yield emitDeltaChunk({
                tool_calls: [{
                  index: state.index,
                  id: state.id,
                  type: 'function',
                  function: { name: state.name },
                }],
              });
            } else if (event.item?.type === 'reasoning') {
              // 推理/思考内容开始
              const reasoningItem = event.item as DoubaoReasoningOutput;
              if (reasoningItem.summary?.length > 0) {
                const summaryText = reasoningItem.summary
                  .map(s => s.text)
                  .join('\n');
                if (summaryText) {
                  yield emitDeltaChunk({ reasoning_content: summaryText });
                }
              }
            }
            break;
          }

          case 'response.function_call_arguments.delta': {
            const state = event.item_id ? toolCallState.get(event.item_id) : undefined;
            if (!state) break;

            const argsDelta = typeof event.delta === 'string' ? event.delta : '';
            if (!argsDelta) break;

            state.arguments += argsDelta;
            hasEmittedContent = true;

            yield emitDeltaChunk({
              tool_calls: [{
                index: state.index,
                id: state.id,
                type: 'function',
                function: { name: state.name, arguments: argsDelta },
              }],
            });
            break;
          }

          case 'response.incomplete':
          case 'response.completed': {
            finalResponseData = event.response || null;
            finalUsage = event.response?.usage || null;
            sawTerminalEvent = true;
            if (event.type === 'response.incomplete' || event.response?.status === 'incomplete') {
              const reason = event.response?.incomplete_details?.reason;
              cliLogger.warn('Doubao', `Incomplete response returned, reason: ${reason ?? 'unknown'}`);
              incompleteFinishReason = reason === 'content_filter' ? 'content_filter' : 'length';
            }
            if (event.response?.id) {
              responseId = event.response.id;
              this.lastResponseId = responseId;
            }
            break;
          }

          case 'response.error':
          case 'response.failed': {
            const message = event.error?.message || event.error?.code || 'Doubao stream failed';
            throw new Error(message);
          }
        }
      }
    }

    // 如果没有 emit 任何内容，从最终响应中提取
    if (!hasEmittedContent && finalResponseData) {
      const outputItems = Array.isArray(finalResponseData.output) ? finalResponseData.output : [];
      let textContent = '';
      let reasoningContent = '';

      for (const item of outputItems) {
        if (item?.type === 'message' && Array.isArray((item as DoubaoMessageOutput).content)) {
          for (const contentPart of (item as DoubaoMessageOutput).content) {
            if (contentPart?.type === 'output_text' && typeof contentPart.text === 'string') {
              textContent += contentPart.text;
            }
          }
        } else if (item?.type === 'reasoning') {
          const reasoningItem = item as DoubaoReasoningOutput;
          if (reasoningItem.summary?.length > 0) {
            reasoningContent = reasoningItem.summary.map(s => s.text).join('\n');
          }
        }
      }

      if (textContent || reasoningContent) {
        yield {
          id: responseId,
          choices: [{
            index: 0,
            delta: {
              role: 'assistant',
              content: textContent || undefined,
              reasoning_content: reasoningContent || undefined,
            },
          }],
        };
      }
    }

    /* 连接断了、没等到 completed/incomplete: 原来照样报 tool_calls, 半截参数被 JSON 自愈后执行。
     * 当成网络中断抛给外层的重连逻辑 (classifyError 认 STREAM_INCOMPLETE 为可重试)。 */
    if (!sawTerminalEvent) {
      throw Object.assign(new Error('Doubao stream closed before response.completed'), { code: 'STREAM_INCOMPLETE' });
    }

    // 发送最终 chunk
    const finishChunk: StreamChunk = {
      id: responseId,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: incompleteFinishReason ?? (toolCallState.size > 0 ? 'tool_calls' : 'stop'),
      }],
    };

    if (finalUsage) {
      finishChunk.usage = this.normalizeUsage(finalUsage);
    }

    yield finishChunk;
  }

  private normalizeUsage(rawUsage: DoubaoUsage): TokenUsage {
    const usage: TokenUsage = {
      prompt_tokens: rawUsage.input_tokens || 0,
      completion_tokens: rawUsage.output_tokens || 0,
      total_tokens: rawUsage.total_tokens || 0,
    };

    if (rawUsage.input_tokens_details?.cached_tokens !== undefined) {
      usage.cached_tokens = rawUsage.input_tokens_details.cached_tokens;
      usage.prompt_tokens_details = {
        cached_tokens: rawUsage.input_tokens_details.cached_tokens,
      };
    }

    if (rawUsage.output_tokens_details?.reasoning_tokens !== undefined) {
      usage.completion_tokens_details = {
        reasoning_tokens: rawUsage.output_tokens_details.reasoning_tokens,
      };
    }

    return usage;
  }
}
