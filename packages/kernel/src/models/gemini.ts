/**
 * Google Gemini API provider
 *
 * 完整支持:
 * - Gemini API (/v1beta/models/{model}:streamGenerateContent)
 * - 流式响应 (SSE with alt=sse)
 * - 工具调用 (Function Calling)
 * - 多模态内容 (文本/图片/视频等)
 * - System Instructions
 * - Generation Config (temperature, topP, topK等)
 *
 * 参考: Google Gemini API文档
 */

import axios, { type AxiosInstance } from 'axios';
import { dumpLlmPayloadIfEnabled } from '../utils/payloadDump.js';
import type { Message, ChatCompletionResponse, Tool, ToolCall, LLMProvider, StructuredOutputDefinition } from '../types/index.js';
import { getTextFromContent } from '../utils/messageUtils.js';
import {
  type RetryConfig,
  type ProviderRetryConfig,
  mergeRetryConfig,
  getProviderRetryConfig,
} from '../types/retryConfig.js';
import {
  classifyError,
  parseRetryAfter,
} from '../types/errors.js';
import { getRetryDelay, sleep, abortableSleep, formatDelay } from '../utils/backoff.js';
import { fromGeminiFunctionCall } from './toolCallingNormalizer.js';
import { formatErrorForUI, formatErrorForLog } from '../utils/errorFormatter.js';
import { randomUUID } from 'crypto';
import os from 'os';
import { cliLogger, logCurlCommand, generateCurlCommand, debugLog, maskUrlSecrets } from '../platform/cliLogger.js';
import { createUtf8ChunkDecoder } from '../utils/utf8StreamDecoder.js';

type GeminiAuthMode = 'auto' | 'query' | 'header' | 'bearer';

function normalizePathPrefix(pathPrefix?: string): string {
  const defaultPrefix = '/v1beta/models';
  if (!pathPrefix) {
    return defaultPrefix;
  }

  const trimmed = pathPrefix.trim();
  if (!trimmed) {
    return defaultPrefix;
  }

  let normalized = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  normalized = normalized.replace(/\/+$/, '');

  if (!normalized.includes('/models')) {
    normalized = `${normalized}/models`;
  }

  return normalized;
}

function safeParseToolArgs(rawArgs: string): Record<string, any> {
  try {
    const parsed = JSON.parse(rawArgs);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, any>;
    }
    return { value: parsed };
  } catch {
    return {};
  }
}

// ============================================================================
// Gemini 常量定义
// ============================================================================

/** 合成的 thoughtSignature，用于跳过 API 验证 */
export const SYNTHETIC_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';

/** 默认 thinking 模式的最大 token 数，防止 thinking 循环 */
export const DEFAULT_THINKING_BUDGET = 8192;

// ============================================================================
// Gemini 类型定义
// ============================================================================

/** Gemini Content Part */
interface GeminiPart {
  text?: string;
  thought?: boolean; // If true, this is thinking/reasoning content, not actual response
  thoughtSignature?: string; // Thinking signature, should be ignored
  inlineData?: {
    mimeType: string;
    data: string;
  };
  fileData?: {
    mimeType: string;
    fileUri: string;
  };
  functionCall?: {
    name: string;
    args: Record<string, any> | string;
    id?: string;
  };
  functionResponse?: {
    name: string;
    id?: string;
    response: Record<string, any>;
  };
}

/** Gemini Content */
interface GeminiContent {
  parts: GeminiPart[];
  role: 'user' | 'model';
}

/** Gemini Function Declaration */
interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters?: Record<string, any>;
  parametersJsonSchema?: Record<string, any>;
}

/** Gemini Tool */
interface GeminiTool {
  functionDeclarations: GeminiFunctionDeclaration[];
}

/** Gemini Thinking Config - 控制 thinking 模式 */
interface GeminiThinkingConfig {
  /** thinking 模式的 token 预算 */
  thinkingBudget?: number;
  /** 是否包含 thoughts 在响应中 */
  includeThoughts?: boolean;
}

/** Gemini Generation Config */
interface GeminiGenerationConfig {
  temperature?: number;
  topP?: number;
  topK?: number;
  candidateCount?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
  responseMimeType?: string;
  responseSchema?: Record<string, any>;
  /** Thinking 模式配置 */
  thinkingConfig?: GeminiThinkingConfig;
}

/** Gemini System Instruction */
interface GeminiSystemInstruction {
  parts: Array<{ text: string }>;
  role?: 'user';
}

/** Gemini Request */
interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: GeminiSystemInstruction;
  tools?: GeminiTool[];
  generationConfig?: GeminiGenerationConfig;
}

/** Gemini Response Candidate */
interface GeminiCandidate {
  content: {
    parts: GeminiPart[];
    role: string;
  };
  finishReason?: string;
  index?: number;
  safetyRatings?: any[];
}

/** Gemini Usage Metadata */
interface GeminiUsageMetadata {
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
  cachedContentTokenCount?: number;
}

/** Gemini Response */
interface GeminiResponse {
  candidates: GeminiCandidate[];
  /** 提示词本身被拦: 此时没有 candidates, 只有 blockReason */
  promptFeedback?: { blockReason?: string };
  usageMetadata?: GeminiUsageMetadata;
  modelVersion?: string;
}

// ============================================================================
// Gemini 辅助类和函数
// ============================================================================

/**
 * 流式响应验证错误
 * 当流结束但内容无效时抛出
 */
export class InvalidStreamError extends Error {
  readonly errorType: 'NO_FINISH_REASON' | 'NO_RESPONSE_TEXT' | 'MALFORMED_FUNCTION_CALL';

  constructor(
    message: string,
    errorType: 'NO_FINISH_REASON' | 'NO_RESPONSE_TEXT' | 'MALFORMED_FUNCTION_CALL',
  ) {
    super(message);
    this.name = 'InvalidStreamError';
    this.errorType = errorType;
  }
}

/**
 * 判断模型是否为 Gemini 3 Preview 模型（需要 thinking 模式处理）
 */
function isPreviewModel(model: string): boolean {
  return model.includes('gemini-3') || model.includes('preview');
}

/**
 * 确保 active loop 中的 function call 都有 thoughtSignature
 *
 * Gemini thinking 模型要求：在每个 model turn 的第一个 function call
 * 必须有 thoughtSignature 属性，否则会返回 400 错误。
 *
 * 这个函数会找到最后一个用户文本消息作为 active loop 的起点，
 * 然后为后续所有 model turn 中缺少 thoughtSignature 的 function call 添加合成签名。
 */
function ensureActiveLoopHasThoughtSignatures(contents: GeminiContent[]): GeminiContent[] {
  // 找到 active loop 的起点：最后一个带 text 的 user turn
  let activeLoopStartIndex = -1;
  for (let i = contents.length - 1; i >= 0; i--) {
    const content = contents[i];
    if (content.role === 'user' && content.parts?.some((part) => part.text)) {
      activeLoopStartIndex = i;
      break;
    }
  }

  if (activeLoopStartIndex === -1) {
    return contents;
  }

  // 遍历 active loop 中的每个消息
  const newContents = contents.slice(); // 浅拷贝
  for (let i = activeLoopStartIndex; i < newContents.length; i++) {
    const content = newContents[i];
    if (content.role === 'model' && content.parts) {
      const newParts = content.parts.slice();
      for (let j = 0; j < newParts.length; j++) {
        const part = newParts[j];
        if (part.functionCall) {
          // 如果 function call 没有 thoughtSignature，添加合成签名
          if (!part.thoughtSignature) {
            newParts[j] = {
              ...part,
              thoughtSignature: SYNTHETIC_THOUGHT_SIGNATURE,
            };
            newContents[i] = {
              ...content,
              parts: newParts,
            };
          }
          break; // 只处理第一个 function call
        }
      }
    }
  }
  return newContents;
}

/**
 * 检查 function call 响应是否有效
 */
function isFunctionResponse(content: GeminiContent): boolean {
  return content.parts?.some((part) => part.functionResponse) ?? false;
}

// ============================================================================
// Provider Implementation
// ============================================================================

/** Gemini Thinking 配置类型 */
export interface GeminiThinkingSettings {
  type: 'enabled' | 'disabled';
  budget?: number;
}

export class GeminiProvider implements LLMProvider {
  private client: AxiosInstance;
  private apiKey: string;
  private baseURL: string;
  private pathPrefix: string;
  private userId: string;
  private retryConfig: RetryConfig;
  private authMode: GeminiAuthMode;
  /** Thinking 模式配置（运行时可动态设置）*/
  private thinkingSettings: GeminiThinkingSettings | null = null;

  constructor(
    apiKey: string,
    baseURL: string = 'https://generativelanguage.googleapis.com',
    retryConfig?: ProviderRetryConfig,
    options?: {
      pathPrefix?: string;
      authMode?: GeminiAuthMode;
    }
  ) {
    this.apiKey = apiKey;
    this.baseURL = baseURL.replace(/\/$/, '');
    this.pathPrefix = normalizePathPrefix(options?.pathPrefix);
    this.userId = randomUUID(); // Generate a unique user ID
    this.authMode = this.resolveAuthMode(options?.authMode);

    // Merge with provider-specific defaults
    this.retryConfig = mergeRetryConfig(
      getProviderRetryConfig('gemini'),
      retryConfig
    );

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': `GeminiCLI/v22.16.0 (${os.platform()}; ${os.arch()})`,
      'x-goog-api-client': 'google-genai-sdk/1.30.0 gl-node/v22.16.0',
      'x-gemini-api-privileged-user-id': this.userId,
    };

    if (this.authMode === 'header') {
      headers['x-goog-api-key'] = this.apiKey;
    } else if (this.authMode === 'bearer') {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    this.client = axios.create({
      baseURL: this.baseURL,
      timeout: 600000, // 10 minutes for long-running requests
      headers,
    });
  }

  private resolveAuthMode(mode?: GeminiAuthMode): GeminiAuthMode {
    if (mode && mode !== 'auto') {
      return mode;
    }

    const isOfficialHost = this.baseURL.includes('generativelanguage.googleapis.com');
    const looksLikeGoogleKey = this.apiKey.startsWith('AIza');

    if (isOfficialHost || looksLikeGoogleKey) {
      return 'query';
    }

    return 'bearer';
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * 动态设置 thinking 配置
   * 用于在运行时切换 Gemini thinking 模式
   */
  setThinking(config: GeminiThinkingSettings | null): void {
    this.thinkingSettings = config;
    if (process.env.CLI_DEBUG === '1') {
      debugLog('GEMINI', 'Thinking config updated', { config });
    }
  }

  /**
   * 获取当前 thinking 配置
   */
  getThinking(): GeminiThinkingSettings | null {
    return this.thinkingSettings;
  }

  /**
   * Convert Neox messages to Gemini format
   *
   * 关键：Gemini 要求同一个 model turn 中的所有 function calls
   * 必须在同一个 user turn 中有对应的 function responses
   */
  private convertMessages(messages: Message[]): {
    contents: GeminiContent[];
    systemInstruction?: GeminiSystemInstruction;
  } {
    const normalizedMessages = this.filterIncompleteToolCalls(messages);
    const systemMessages: string[] = [];
    const contents: GeminiContent[] = [];

    //  收集连续的 tool 消息，稍后合并
    let pendingToolResponses: GeminiPart[] = [];

    const flushToolResponses = () => {
      if (pendingToolResponses.length > 0) {
        contents.push({
          parts: pendingToolResponses,
          role: 'user',
        });
        pendingToolResponses = [];
      }
    };

    for (const msg of normalizedMessages) {
      if (msg.role === 'system') {
        // Collect system messages
        const text = getTextFromContent(msg.content);
        if (text) {
          systemMessages.push(text);
        }
      } else if (msg.role === 'user') {
        //  先 flush 之前的 tool responses
        flushToolResponses();

        // Convert user message
        const parts: GeminiPart[] = [];

        if (typeof msg.content === 'string') {
          parts.push({ text: msg.content });
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === 'text') {
              parts.push({ text: part.text });
            } else if (part.type === 'image_url') {
              // Extract base64 data from data URL
              const url = part.image_url.url;
              if (url.startsWith('data:')) {
                const match = url.match(/^data:([^;]+);base64,(.+)$/);
                if (match) {
                  parts.push({
                    inlineData: {
                      mimeType: match[1],
                      data: match[2],
                    },
                  });
                }
              }
            }
          }
        }

        contents.push({ parts, role: 'user' });
      } else if (msg.role === 'assistant') {
        //  先 flush 之前的 tool responses
        flushToolResponses();

        // Convert assistant message
        const parts: GeminiPart[] = [];

        // Add text content
        const text = getTextFromContent(msg.content);
        if (text) {
          parts.push({ text });
        }

        // Add tool calls as function calls
        if (msg.tool_calls) {
          for (const toolCall of msg.tool_calls) {
            const functionCallPart: GeminiPart = {
              functionCall: {
                name: toolCall.function.name,
                args: safeParseToolArgs(toolCall.function.arguments),
                id: toolCall.id,
              },
            };
            //  Gemini thinking 模式：添加 thoughtSignature（如果存在）
            if (toolCall.thoughtSignature) {
              functionCallPart.thoughtSignature = toolCall.thoughtSignature;
            }
            parts.push(functionCallPart);
          }
        }

        contents.push({ parts, role: 'model' });
      } else if (msg.role === 'tool') {
        //  收集 tool response，不立即创建 content
        // 等到遇到非 tool 消息或结束时再 flush
        //  图片 tool result: 提取文本作为 output (Gemini functionResponse 不支持内联图片)
        const content = (Array.isArray(msg.content) && msg.content.some((p: any) => p?.type === 'image_url'))
          ? ((msg.content as any[]).filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('\n') || '[image]')
          : (getTextFromContent(msg.content) || '');
        const toolName = msg.name || 'unknown';
        const functionResponse: GeminiPart['functionResponse'] = {
          name: toolName,
          response: { output: content },
        };
        if (msg.tool_call_id) {
          functionResponse.id = msg.tool_call_id;
        }
        pendingToolResponses.push({ functionResponse });
      }
    }

    //  最后 flush 剩余的 tool responses
    flushToolResponses();

    const result: {
      contents: GeminiContent[];
      systemInstruction?: GeminiSystemInstruction;
    } = { contents };

    if (systemMessages.length > 0) {
      result.systemInstruction = {
        parts: systemMessages.map(text => ({ text })),
        role: 'user',
      };
    }

    return result;
  }

  /**
   * Gemini 要求 functionResponse 紧跟对应的 functionCall。
   * 过滤掉缺少 tool outputs 的 assistant 消息，以及孤立的 tool 消息。
   */
  private filterIncompleteToolCalls(messages: Message[]): Message[] {
    const filtered: Message[] = [];
    let i = 0;

    while (i < messages.length) {
      const msg = messages[i];

      if (msg.role === 'system') {
        filtered.push(msg);
        i++;
        continue;
      }

      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        const toolCalls = msg.tool_calls;
        const toolCallCount = toolCalls.length;
        const callsHaveIds = toolCalls.every(tc => !!tc.id);

        const interleaved: Message[] = [];
        const toolResponses: Message[] = [];
        let j = i + 1;

        while (j < messages.length) {
          const next = messages[j];
          if (next.role === 'system') {
            interleaved.push(next);
            j++;
            continue;
          }
          if (next.role !== 'tool') {
            break;
          }
          interleaved.push(next);
          toolResponses.push(next);
          j++;
        }

        const responseCount = toolResponses.length;
        const responsesHaveIds = toolResponses.every(tr => !!tr.tool_call_id);

        let hasAllResponses = responseCount === toolCallCount;
        if (hasAllResponses && callsHaveIds && responsesHaveIds) {
          const responseIds = new Set(
            toolResponses
              .map(tr => tr.tool_call_id)
              .filter((id): id is string => !!id),
          );
          for (const call of toolCalls) {
            if (!responseIds.has(call.id)) {
              hasAllResponses = false;
              break;
            }
          }
        }

        if (hasAllResponses) {
          filtered.push(msg);
          for (const item of interleaved) {
            filtered.push(item);
          }
        } else {
          if (process.env.CLI_DEBUG === '1') {
            cliLogger.debug('GEMINI', 'Filtering incomplete tool call turn', {
              toolCalls: toolCalls.map(tc => ({ id: tc.id, name: tc.function.name })),
              responseCount,
            });
          }
          for (const item of interleaved) {
            if (item.role === 'system') {
              filtered.push(item);
            }
          }
        }

        i = j;
        continue;
      }

      if (msg.role === 'tool') {
        if (process.env.CLI_DEBUG === '1') {
          cliLogger.debug('GEMINI', 'Dropping orphan tool message', {
            toolCallId: msg.tool_call_id,
            toolName: msg.name,
          });
        }
        i++;
        continue;
      }

      filtered.push(msg);
      i++;
    }

    return filtered;
  }

  /**
   * Convert Neox tools to Gemini format
   */
  private convertTools(tools: Tool[]): GeminiTool[] {
    if (!tools || tools.length === 0) {
      return [];
    }

    const functionDeclarations: GeminiFunctionDeclaration[] = tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: {
        type: tool.parameters.type,
        properties: tool.parameters.properties,
        required: tool.parameters.required,
        additionalProperties: tool.parameters.additionalProperties,
      },
      parametersJsonSchema: {
        type: tool.parameters.type,
        properties: tool.parameters.properties,
        required: tool.parameters.required,
        additionalProperties: tool.parameters.additionalProperties,
      },
    }));

    return [{ functionDeclarations }];
  }

  /**
   * Build generation config
   */
  private buildGenerationConfig(options: {
    temperature?: number;
    structuredOutput?: StructuredOutputDefinition;
    topP?: number;
    topK?: number;
    stopSequences?: string[];
    maxOutputTokens?: number;
    /** 是否启用 thinking 模式 */
    enableThinking?: boolean;
    /** thinking 模式的 token 预算 */
    thinkingBudget?: number;
  }): GeminiGenerationConfig {
    const config: GeminiGenerationConfig = {
      temperature: options.temperature ?? 1.0,
      topP: options.topP ?? 0.95,
      topK: options.topK ?? 64,
    };

    if (options.maxOutputTokens !== undefined) {
      config.maxOutputTokens = options.maxOutputTokens;
    }

    if (options.stopSequences && options.stopSequences.length > 0) {
      config.stopSequences = options.stopSequences;
    }

    if (options.structuredOutput) {
      config.responseMimeType = 'application/json';
      config.responseSchema = options.structuredOutput.schema;
    }

    //  添加 thinking 配置支持
    if (options.enableThinking) {
      config.thinkingConfig = {
        thinkingBudget: options.thinkingBudget ?? DEFAULT_THINKING_BUDGET,
        includeThoughts: true,
      };
    }

    return config;
  }

  /**
   * Parse SSE response
   * Gemini API returns JSON directly without "data: " prefix, or with "data: " prefix
   */
  private parseSSELine(line: string): GeminiResponse | null {
    let data = line.trim();

    // Skip empty lines
    if (!data) {
      return null;
    }

    // Handle standard SSE format with "data:" prefix
    if (data.startsWith('data:')) {
      data = data.slice(5).trim();
    }

    // Skip [DONE] marker
    if (data === '[DONE]') {
      return null;
    }

    // Must start with { to be valid JSON
    if (!data.startsWith('{')) {
      return null;
    }

    try {
      return JSON.parse(data);
    } catch (err) {
      // Silently ignore parse errors for SSE
      return null;
    }
  }

  /**
   * Convert Gemini response to Neox format
   */
  private convertResponse(response: GeminiResponse, requestId: string): ChatCompletionResponse {
    const candidate = response.candidates?.[0];
    if (!candidate) {
      const blocked = response.promptFeedback?.blockReason;
      throw new Error(blocked
        ? `Gemini blocked the prompt (${blocked})`
        : 'No candidate in Gemini response');
    }

    const parts = candidate.content?.parts || [];
    let content: string | null = null;
    const toolCalls: ToolCall[] = [];

    for (const part of parts) {
      if (part.text) {
        content = (content || '') + part.text;
      } else if (part.functionCall) {
        /* wire→internal 统一走 fromGeminiFunctionCall (D14 normalizer) */
        const normalized = fromGeminiFunctionCall(part);
        if (normalized) toolCalls.push(normalized);
      }
    }

    const usage = response.usageMetadata || {
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      totalTokenCount: 0,
    };

    const normalizedFinishReason = candidate.finishReason === 'STOP'
      ? (toolCalls.length > 0 ? 'tool_calls' : 'stop')
      : (candidate.finishReason || 'stop').toLowerCase();

    return {
      id: requestId,
      choices: [{
        message: {
          role: 'assistant',
          content,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
        finish_reason: normalizedFinishReason,
      }],
      usage: {
        prompt_tokens: usage.promptTokenCount,
        completion_tokens: usage.candidatesTokenCount,
        total_tokens: usage.totalTokenCount,
        cached_tokens: usage.cachedContentTokenCount,
      },
    };
  }

  /**
   * Make API request with retry logic
   */
  private async makeRequest<T>(
    fn: () => Promise<T>,
    context: string
  ): Promise<T> {
    let lastError: any;
    let attempt = 0;

    while (attempt <= this.retryConfig.requestMaxRetries) {
      try {
        return await fn();
      } catch (err: any) {
        lastError = err;
        attempt++;

        const errorType = classifyError(err);
        const retryAfter = parseRetryAfter(err.response?.headers?.['retry-after']);

        // Don't retry if not retryable or out of attempts
        if (!errorType.retryable || attempt > this.retryConfig.requestMaxRetries) {
          break;
        }

        // Calculate delay
        const delay = getRetryDelay(
          retryAfter,
          attempt,
          this.retryConfig
        );
        await sleep(delay);
      }
    }

    throw lastError;
  }

  /**
   * Non-streaming chat completion
   */
  async chat(
    messages: Message[],
    options: {
      model?: string;
      tools?: Tool[];
      temperature?: number;
      structuredOutput?: StructuredOutputDefinition;
      topP?: number;
      topK?: number;
      stopSequences?: string[];
      maxInputTokens?: number;
      signal?: AbortSignal;
    }
  ): Promise<ChatCompletionResponse> {
    const model = options.model || 'gemini-2.5-flash';
    const { contents, systemInstruction } = this.convertMessages(messages);
    const tools = this.convertTools(options.tools || []);
    const generationConfig = this.buildGenerationConfig({
      temperature: options.temperature,
      structuredOutput: options.structuredOutput,
      topP: options.topP,
      topK: options.topK,
      stopSequences: options.stopSequences,
      maxOutputTokens: options.maxInputTokens,
    });

    const request: GeminiRequest = {
      contents,
      systemInstruction,
      generationConfig,
    };
    dumpLlmPayloadIfEnabled('gemini', request);

    if (tools.length > 0) {
      request.tools = tools;
    }

    const requestId = `gemini-${Date.now()}`;

    const endpoint = `${this.pathPrefix}/${model}:generateContent`;
    const params = this.authMode === 'query' ? { key: this.apiKey } : undefined;

    return this.makeRequest(async () => {
      const response = await this.client.post(endpoint, request, {
        params,
        signal: options.signal,
      });

      return this.convertResponse(response.data, requestId);
    }, 'chat');
  }

  /**
   * Streaming chat completion
   */
  async *chatStreamed(
    messages: Message[],
    options: {
      model?: string;
      tools?: Tool[];
      temperature?: number;
      structuredOutput?: StructuredOutputDefinition;
      topP?: number;
      topK?: number;
      stopSequences?: string[];
      maxInputTokens?: number;
      signal?: AbortSignal;
      /** 是否启用 thinking 模式 (Gemini 3 Pro Preview) */
      enableThinking?: boolean;
      /** thinking 模式的 token 预算 */
      thinkingBudget?: number;
    }
  ): AsyncGenerator<any> {
    const model = options.model || 'gemini-2.5-flash';
    const { contents, systemInstruction } = this.convertMessages(messages);
    const tools = this.convertTools(options.tools || []);

    //  合并运行时 thinking 配置和参数配置
    // 优先级: options.enableThinking > this.thinkingSettings > isPreviewModel
    const isThinkingModel = isPreviewModel(model);
    const runtimeThinkingEnabled = this.thinkingSettings?.type === 'enabled';
    const runtimeThinkingDisabled = this.thinkingSettings?.type === 'disabled';

    // 最终 thinking 配置
    const shouldEnableThinking =
      options.enableThinking !== undefined ? options.enableThinking :
      runtimeThinkingEnabled ? true :
      runtimeThinkingDisabled ? false :
      isThinkingModel; // Preview 模型默认开启

    const thinkingBudget =
      options.thinkingBudget ??
      this.thinkingSettings?.budget ??
      DEFAULT_THINKING_BUDGET;

    const generationConfig = this.buildGenerationConfig({
      temperature: options.temperature,
      structuredOutput: options.structuredOutput,
      topP: options.topP,
      topK: options.topK,
      stopSequences: options.stopSequences,
      maxOutputTokens: options.maxInputTokens,
      //  使用合并后的 thinking 配置
      enableThinking: shouldEnableThinking,
      thinkingBudget: thinkingBudget,
    });

    //  对 Preview 模型应用 thoughtSignature 处理
    const processedContents = isPreviewModel(model)
      ? ensureActiveLoopHasThoughtSignatures(contents)
      : contents;

    const request: GeminiRequest = {
      contents: processedContents,
      systemInstruction,
      generationConfig,
    };
    dumpLlmPayloadIfEnabled('gemini', request);

    if (tools.length > 0) {
      request.tools = tools;
    }

    const requestId = `gemini-${Date.now()}`;
    const endpoint = `${this.pathPrefix}/${model}:streamGenerateContent`;
    const fullUrl = `${this.baseURL}${endpoint}`;

    //  准备请求参数用于日志
    const params = this.authMode === 'query'
      ? { key: this.apiKey, alt: 'sse' }
      : { alt: 'sse' };

    // 构建完整URL（包含query参数）
    const urlWithParams = new URL(fullUrl);
    for (const [key, value] of Object.entries(params)) {
      urlWithParams.searchParams.append(key, value);
    }

    //  构建请求头
    const requestHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': '*/*',
    };
    if (this.authMode === 'header') {
      requestHeaders['x-goog-api-key'] = this.apiKey;
    } else if (this.authMode === 'bearer') {
      requestHeaders['Authorization'] = `Bearer ${this.apiKey}`;
    }

    //  CLI_DEBUG 模式下记录完整的 curl 命令
    if (process.env.CLI_DEBUG === '1') {
      cliLogger.info('GEMINI', '=== Gemini Stream Request ===');
      cliLogger.info('GEMINI', `URL: ${maskUrlSecrets(urlWithParams.toString())}`);
      cliLogger.info('GEMINI', `Model: ${model}`);
      cliLogger.info('GEMINI', `AuthMode: ${this.authMode}`);
      cliLogger.info('GEMINI', `Tools: ${tools.length > 0 ? tools[0].functionDeclarations.length : 0}`);
      cliLogger.info('GEMINI', `Contents: ${contents.length} messages`);

      // 记录完整的 curl 命令
      const curlCmd = generateCurlCommand(urlWithParams.toString(), requestHeaders, request);
      cliLogger.info('GEMINI_CURL', curlCmd);

      // 记录请求体摘要
      cliLogger.debug('GEMINI', 'Request body:', {
        contentsCount: request.contents.length,
        hasSystemInstruction: !!request.systemInstruction,
        toolsCount: request.tools?.[0]?.functionDeclarations?.length || 0,
        generationConfig: request.generationConfig,
      });
    }

    // Debug console logging (使用 debugLog 统一管理)
    if (process.env.CLI_DEBUG === '1') {
      debugLog('GEMINI', '[Gemini Stream Request]');
      debugLog('GEMINI', `URL: ${maskUrlSecrets(urlWithParams.toString())}`);
      debugLog('GEMINI', `Model: ${model}`);
      debugLog('GEMINI', `Tools: ${tools.length > 0 ? tools[0].functionDeclarations.length : 0}`);
      debugLog('GEMINI', `Contents: ${contents.length} messages`);

      // 打印完整的 curl 命令
      const curlCmd = generateCurlCommand(urlWithParams.toString(), requestHeaders, request);
      debugLog('GEMINI_CURL', curlCmd);
    }

    const startTime = Date.now();

    // Make request and get stream
    const response = await this.makeRequest(async () => {
      const params = this.authMode === 'query'
        ? { key: this.apiKey, alt: 'sse' }
        : { alt: 'sse' };

      return await this.client.post(endpoint, request, {
        params,
        responseType: 'stream',
        signal: options.signal,
        headers: {
          'Accept': '*/*',
          'Accept-Language': '*',
          'sec-fetch-mode': 'cors',
          'Accept-Encoding': 'br, gzip, deflate',
        },
      });
    }, 'chatStreamed');

    if (process.env.CLI_DEBUG === '1') {
      debugLog('GEMINI', '[Gemini Stream Started]');
      debugLog('GEMINI', `Status: ${response.status}`);
    }

    // Yield from stream generator
    yield* this.streamGenerator(response.data, requestId, startTime);
  }

  /**
   * Convert Node.js stream to async generator
   */
  private async *streamGenerator(
    stream: any,
    requestId: string,
    startTime?: number
  ): AsyncGenerator<any> {
    let buffer = '';
    let dataLines: string[] = [];
    let accumulatedContent = '';
    const accumulatedToolCalls: ToolCall[] = [];
    let lastUsage: any = undefined;

    const processResponse = (response: GeminiResponse): any[] => {
      const events: any[] = [];
      const candidate = response.candidates?.[0];
      if (!candidate) {
        if (response.promptFeedback?.blockReason) {
          cliLogger.warn('GEMINI', `Prompt blocked: ${response.promptFeedback.blockReason}`);
          events.push({ id: requestId, choices: [{ index: 0, delta: {}, finish_reason: 'content_filter' }] });
          return events;
        }
        if (process.env.CLI_DEBUG === '1') {
          debugLog('GEMINI', `No candidate in response: ${JSON.stringify(response).slice(0, 200)}`);
        }
        return events;
      }

      // Track usage
      if (response.usageMetadata) {
        lastUsage = response.usageMetadata;
      }

      const parts = candidate.content?.parts;
      if (!parts || parts.length === 0) {
        if (process.env.CLI_DEBUG === '1') {
          debugLog('GEMINI', `No parts in candidate: ${JSON.stringify(candidate).slice(0, 200)}`);
        }
      } else {
        for (const part of parts) {
          //  FIX: 区分思考内容和最终回答
          // Gemini thinking 模型返回格式：
          // 1. thought: true, 无 thoughtSignature → 纯思考过程（显示为 Reasoning）
          // 2. thought: true, 有 thoughtSignature → 带签名的最终回答（显示为正常内容）
          // 3. 无 thought 标记 → 普通内容

          // Case 1: 纯思考内容（thought: true 且没有 thoughtSignature）
          if (part.thought && !part.thoughtSignature && part.text) {
            if (process.env.CLI_DEBUG === '1') {
              debugLog('GEMINI', `Yielding reasoning: ${part.text.slice(0, 50)}...`);
            }
            events.push({
              choices: [{
                index: 0,
                delta: { reasoning_content: part.text },
              }],
            });
            continue;
          }

          // Case 2 & 3: 最终回答（有 thoughtSignature 或普通文本）
          if (part.text) {
            if (part.thoughtSignature && process.env.CLI_DEBUG === '1') {
              debugLog('GEMINI', `Yielding final answer (with signature): ${part.text.slice(0, 100)}...`);
            } else if (process.env.CLI_DEBUG === '1') {
              debugLog('GEMINI', `Yielding content: ${part.text.slice(0, 100)}...`);
            }

            accumulatedContent += part.text;
            events.push({
              choices: [{
                index: 0,
                delta: { content: part.text },
              }],
            });
          } else if (part.functionCall) {
            /* wire→internal 统一走 fromGeminiFunctionCall (D14 normalizer), 与非流式 convertResponse 一致 */
            const normalized = fromGeminiFunctionCall(part);
            if (!normalized) continue;
            //  Gemini thinking 模式：function call 也可能带有 thoughtSignature
            const toolCall: ToolCall = {
              ...normalized,
              ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
            };
            accumulatedToolCalls.push(toolCall);
            events.push({
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: accumulatedToolCalls.length - 1,
                    id: toolCall.id,
                    type: 'function',
                    function: {
                      name: toolCall.function.name,
                      arguments: toolCall.function.arguments,
                    },
                    //  传递 thoughtSignature
                    ...(toolCall.thoughtSignature ? { thoughtSignature: toolCall.thoughtSignature } : {}),
                  }],
                },
              }],
            });
          }
        }
      }

      if (candidate.finishReason) {
        const usage = lastUsage || {
          promptTokenCount: 0,
          candidatesTokenCount: 0,
          totalTokenCount: 0,
        };

        //  完整记录响应日志
        if (process.env.CLI_DEBUG === '1') {
          const duration = startTime ? Date.now() - startTime : 0;
          cliLogger.info('GEMINI', '=== Gemini Stream Complete ===');
          cliLogger.info('GEMINI', `Duration: ${duration}ms`);
          cliLogger.info('GEMINI', `Finish Reason: ${candidate.finishReason}`);
          cliLogger.info('GEMINI', `Tool Calls: ${accumulatedToolCalls.length}`);
          cliLogger.info('GEMINI', `Accumulated Content Length: ${accumulatedContent.length}`);
          cliLogger.info('GEMINI', `Usage: prompt=${usage.promptTokenCount}, completion=${usage.candidatesTokenCount}, total=${usage.totalTokenCount}`);

          // 记录完整响应内容
          if (accumulatedContent) {
            cliLogger.info('GEMINI', `Content Preview: ${accumulatedContent.slice(0, 500)}...`);
          }
          if (accumulatedToolCalls.length > 0) {
            cliLogger.info('GEMINI', `Tool Calls Detail:`, accumulatedToolCalls.map(tc => ({
              id: tc.id,
              name: tc.function.name,
              argsLength: tc.function.arguments.length,
            })));
          }
        }

        if (process.env.CLI_DEBUG === '1') {
          const duration = startTime ? Date.now() - startTime : 0;
          debugLog('GEMINI', '[Gemini Stream Complete]');
          debugLog('GEMINI', `Duration: ${duration}ms`);
          debugLog('GEMINI', `Finish Reason: ${candidate.finishReason}`);
          debugLog('GEMINI', `Tool Calls: ${accumulatedToolCalls.length}`);
          debugLog('GEMINI', `Accumulated Content Length: ${accumulatedContent.length}`);
          debugLog('GEMINI', `Usage: prompt=${usage.promptTokenCount}, completion=${usage.candidatesTokenCount}, total=${usage.totalTokenCount}`);
          if (accumulatedContent) {
            debugLog('GEMINI', `Content Preview: ${accumulatedContent.slice(0, 500)}`);
          }
        }

        const normalizedFinish = candidate.finishReason === 'STOP'
          ? (accumulatedToolCalls.length > 0 ? 'tool_calls' : 'stop')
          : candidate.finishReason.toLowerCase();

        events.push({
          id: requestId,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: normalizedFinish,
          }],
          usage: {
            prompt_tokens: usage.promptTokenCount,
            completion_tokens: usage.candidatesTokenCount,
            total_tokens: usage.totalTokenCount,
            cached_tokens: usage.cachedContentTokenCount,
          },
        });
      }

      return events;
    };

    const decodeChunk = createUtf8ChunkDecoder();
    try {
      for await (const chunk of stream) {
        /* StringDecoder: 跨 chunk 的半个多字节字符不能就地解 (见 utf8StreamDecoder) */
        const chunkStr = decodeChunk(chunk);
        buffer += chunkStr;

        // Debug: print raw chunk
        if (process.env.CLI_DEBUG === '1') {
          debugLog('GEMINI', `Raw chunk (${chunkStr.length} bytes): ${chunkStr.slice(0, 200)}...`);
        }

        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';

        for (const rawLine of lines) {
          const line = rawLine.trimEnd();
          if (!line) {
            if (dataLines.length === 0) {
              continue;
            }
            const payload = dataLines.join('\n');
            dataLines = [];
            const response = this.parseSSELine(payload);
            if (!response) {
              if (process.env.CLI_DEBUG === '1' && payload.length > 0) {
                debugLog('GEMINI', `Failed to parse event: ${payload.slice(0, 100)}...`);
              }
              continue;
            }
            for (const event of processResponse(response)) {
              yield event;
            }
            continue;
          }

          if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart());
            continue;
          }

          const response = this.parseSSELine(line);
          if (!response) {
            if (process.env.CLI_DEBUG === '1' && line.length > 0) {
              debugLog('GEMINI', `Failed to parse line: ${line.slice(0, 100)}...`);
            }
            continue;
          }
          for (const event of processResponse(response)) {
            yield event;
          }
        }
      }

      if (dataLines.length > 0) {
        const response = this.parseSSELine(dataLines.join('\n'));
        if (response) {
          for (const event of processResponse(response)) {
            yield event;
          }
        }
      }
    } catch (err: any) {
      // Log error
      if (process.env.CLI_DEBUG === '1') {
        const duration = startTime ? Date.now() - startTime : 0;
        debugLog('GEMINI', '[Gemini Stream Error]');
        debugLog('GEMINI', `Duration: ${duration}ms`);
        debugLog('GEMINI', `Error: ${err.message || err}`);
        if (err.response?.data) {
          debugLog('GEMINI', `Response: ${JSON.stringify(err.response.data)}`);
        }
      }
      // Re-throw stream errors for upstream handling
      throw err;
    }
  }
}
