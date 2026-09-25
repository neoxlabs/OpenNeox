/**
 * Anthropic (Claude) API provider
 *
 * 支持:
 * - 官方 Anthropic API
 * - 代理 API (Claude Code 模式)
 * - Prompt Caching (cache_control)
 * - Extended Thinking
 * - Web Search Tool
 */

import axios, { type AxiosInstance } from 'axios';
import { dumpLlmPayloadIfEnabled } from '../utils/payloadDump.js';
import { randomBytes, createHash } from 'crypto';
import { resolveEffortPayload, resolveDefaultThinkingLevel, getSchemaRegistry } from '../schemas/index.js';
import { fromClaudeToolUse } from './toolCallingNormalizer.js';
import type { Message, ChatCompletionResponse, Tool, LLMProvider, MessageContentPart } from '../types/index.js';
import { getTextFromContent } from '../utils/messageUtils.js';
import { logger } from '../utils/logger.js';
import { getNeoxUserAgent } from '../utils/neoxUserAgent.js';
import { cliLogger, logCurlCommand, generateCurlCommand } from '../platform/cliLogger.js';
import {
  type RetryConfig,
  type ProviderRetryConfig,
  mergeRetryConfig,
  getProviderRetryConfig,
} from '../types/retryConfig.js';
import {
  classifyError,
  parseRetryAfterFromHeaders,
  ErrorCategory,
} from '../types/errors.js';
import { getSmartRetryDelay, sleep, abortableSleep, formatDelay } from '../utils/backoff.js';
import { dumpLLMPayload } from '../utils/llmPayloadDump.js';
import { CLAUDE_CODE_BUILT_IN_TOOL_NAMES } from '../utils/anthropicCachePayloadAnalysis.js';
import { normalizeImageUrl } from '../utils/imageUrlNormalize.js';
import { createUtf8ChunkDecoder } from '../utils/utf8StreamDecoder.js';
import {
  CLAUDE_CODE_SYSTEM_PROMPT,
  DEFAULT_CLAUDE_CODE_BETA_FEATURES,
  buildClaudeCodeHeaders as buildClaudeCodeTransportHeaders,
  buildAnthropicAuthHeaders,
  buildClaudePromptCacheControl,
  splitSystemPromptForCaching, shouldUseClaudeCodeIdentity, isClaudeTarget,
} from './anthropicClaudeCode.js';
import { hoistToolResultImagesForDeepSeek, keepReplayableThinking, moveToolResultsFirst, vendorThinkingFallback } from './anthropicMessageCompat.js';
import { anthropicSessionHeaders, rememberAnthropicSession } from './anthropicSessionHeaders.js';
import {
  WIRE_TOOL_OUTPUT_MAX_UNITS,
  REQUEST_BODY_MAX_BYTES,
  REQUEST_BODY_WARNING_THRESHOLD,
  truncateToolOutput,
  formatResponseHeaders,
} from '../utils/toolOutputTruncation.js';

type RetryableStreamError = Error & {
  code?: string;
  isNetworkInterrupt?: boolean;
  toolName?: string;
};

// ============================================================================
// Types & Interfaces
// ============================================================================

/** Cache control for prompt caching */
export interface CacheControl {
  type: 'ephemeral';
  /** Cache TTL: '5m' (default) or '1h' (extended, costs more) */
  ttl?: '5m' | '1h';
}

/** Extended thinking configuration */
export interface ThinkingConfig {
  type: 'enabled' | 'disabled';
  /** Budget tokens for thinking (must be >= 1024) */
  budget_tokens?: number;
}

/** Metadata for request tracking */
export interface AnthropicMetadata {
  /** User ID (max 64 chars, no PII!) */
  user_id?: string;
  [key: string]: unknown;
}

/** Web search tool configuration */
export interface WebSearchConfig {
  enabled: boolean;
  /** Maximum search uses per request */
  max_uses?: number;
  /** User location for localized results */
  user_location?: {
    type: 'approximate';
    timezone?: string;
    country?: string;
    region?: string;
    city?: string;
  };
}

/** Provider configuration */
export interface AnthropicProviderConfig {
  authToken: string;
  baseUrl?: string;
  defaultModel?: string;
  maxTokens?: number;
  /** Stable metadata user_id override (optional) */
  userId?: string;
  /** Provider-specific retry configuration */
  retry?: ProviderRetryConfig;
  /** Custom beta features to enable */
  betaFeatures?: string[];
  /** @deprecated 用 claudeCodeMode='on' 替代. 保留是为了老配置读回来还能生效. */
  forceClaudeCodeMode?: boolean;
  /**
   * Anthropic 请求身份策略:
   *   'auto' (默认) → baseUrl 判 (api.anthropic.com=Neox 身份, 其余=Claude Code 伪装)
   *   'on' → 强制 Claude Code 伪装
   *   'off' → 强制 Neox 原生身份
   * 三态取代了 forceClaudeCodeMode 的二态. undefined 视作 'auto'.
   */
  claudeCodeMode?: 'auto' | 'on' | 'off';
  /** Custom system prompt prefix (for proxy mode) */
  systemPromptPrefix?: string;
  /** Disable cache_control for proxy providers that don't support it */
  disableCaching?: boolean;
  /** 透传 provider.extraHeaders (如 Accounthub 下发的 x-grok-*) */
  extraHeaders?: Record<string, string>;
}

/** Chat options */
export interface AnthropicChatOptions {
  model?: string;
  tools?: Tool[];
  temperature?: number;
  maxInputTokens?: number;
  maxTokens?: number;
  /** Enable prompt caching for system/tools (default: true for standard API, false for some proxies) */
  enableCaching?: boolean;
  /** Cache TTL for prompt caching */
  cacheTtl?: '5m' | '1h';
  /** Disable all cache_control (for proxy providers that don't support it) */
  disableCaching?: boolean;
  /** Extended thinking configuration */
  thinking?: ThinkingConfig;
  /** Custom metadata */
  metadata?: AnthropicMetadata;
  /** Web search configuration */
  webSearch?: WebSearchConfig;
  /** Top P sampling */
  topP?: number;
  /** Top K sampling */
  topK?: number;
  /** Stop sequences */
  stopSequences?: string[];
  /** Use streaming SSE transport (default: true, chat() side-queries can disable it) */
  stream?: boolean;
  /** Abort signal for request cancellation */
  signal?: AbortSignal;
  /** Fine-Grained Tool Streaming — 工具参数不缓冲直接流式输出 */
  enableFGTS?: boolean;
  requestPriority?: 'foreground' | 'background';
  effortLevel?: string;
}

/** Extended usage information with caching stats */
export interface AnthropicUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** Cache read tokens (10% cost) */
  cache_read_input_tokens?: number;
  /** Cache creation tokens (125% cost for 5m, more for 1h) */
  cache_creation_input_tokens?: number;
  /** 5-minute cache creation tokens */
  cache_creation_5m_tokens?: number;
  /** 1-hour cache creation tokens */
  cache_creation_1h_tokens?: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Default beta features for Claude Code mode */
const DEFAULT_BETA_FEATURES = DEFAULT_CLAUDE_CODE_BETA_FEATURES;

/** Anthropic API version */
const ANTHROPIC_VERSION = '2023-06-01';

/** Maximum user_id length (Anthropic enforces this) */
const MAX_USER_ID_LENGTH = 64;

/** Minimum tokens for thinking budget */
const MIN_THINKING_BUDGET = 1024;

/** Minimum tokens for cache breakpoint */
const MIN_CACHE_TOKENS = 1024;

/** Stream idle timeout - if no data received for this long, consider stream dead */
const STREAM_IDLE_TIMEOUT = 180000; // 180 seconds (3 minutes) - 允许较长的思考时间

/** First chunk timeout - maximum time to wait for first data from stream */
const STREAM_FIRST_CHUNK_TIMEOUT = 60000; // 60 seconds - 首次响应可以等待更久

/**
 * Claude Code 工具名映射表
 * 将我们的工具名转换为 Claude Code 官方工具名
 */
const TOOL_NAME_TO_CLAUDE_CODE: Record<string, string> = {
  // 文件操作
  'readfile': 'Read',
  'write_file': 'Write',
  'edit': 'Edit',
  'edit_file': 'Edit',
  // 搜索工具
  'glob_search': 'Glob',
  'glob': 'Glob',
  'search': 'Grep',
  // Shell 执行
  'execute_shell': 'Bash',
  'bash': 'Bash',
  'shell': 'Bash',
  // 任务管理
  'todo_write': 'TodoWrite',
  'task': 'Task',
  // Web 工具
  'web_fetch': 'WebFetch',
  'web_search': 'WebSearch',
  // 其他
  'ask_user': 'AskUserQuestion',
};

/**
 * Claude Code 工具名反向映射表
 * 将 Claude Code 工具名转换回我们的工具名
 */
const CLAUDE_CODE_TO_TOOL_NAME: Record<string, string> = {
  'Read': 'readfile',
  'Write': 'write_file',
  'Edit': 'edit',
  'Glob': 'glob_search',
  'Grep': 'search',
  'Bash': 'execute_shell',
  'TodoWrite': 'todo_write',
  'Task': 'task',
  'WebFetch': 'web_fetch',
  'WebSearch': 'web_search',
  'AskUserQuestion': 'ask_user',
};

// ============================================================================
// Streaming accumulator (index-addressed fold, 对齐官方 SDK 语义)
//
//   Anthropic 流式协议本身是"按 index 寻址的事件流": 每个 content_block_* 事件都带
//   `index`。我们不再靠事件顺序 + "当前/最后一个" 游标去猜, 而是把每个块按 index 存进
//   `blocks` Map, 事件即状态折叠 (fold)。这样对以下代理帧变体天然免疫, 无需任何 fallback:
//     · 块交错 (block A delta / block B delta / block A delta)
//     · 末尾块不 stop 直接 message_stop
//   唯一真错 = 完全没有终止信号 (message_stop / stop_reason 都没有) = 真·网络中断, 上抛重试。
// ============================================================================

type AnthropicBlockKind = 'text' | 'thinking' | 'redacted_thinking' | 'tool_use' | 'other';

interface AnthropicBlockAcc {
  index: number;              // SSE content block index (wire 地址)
  kind: AnthropicBlockKind;
  closed: boolean;
  // thinking
  thinking?: string;
  signature?: string;
  // redacted_thinking
  data?: string;
  // tool_use
  toolIndex?: number;         // dense 0-based 序号 (给 OpenAI 风格 tool_calls delta)
  toolId?: string;
  toolName?: string;
  args?: string;              // 累积的 input_json
}

interface AnthropicStreamState {
  blocks: Map<number, AnthropicBlockAcc>;
  toolCalls: any[];           // 内部一致性 & finalize 检查用 (消费端另从 delta 组装)
  nextToolIndex: number;
  roleSent: boolean;
  usage: any;
  stopReason: string | null;
  messageStopReceived: boolean;
}

// ============================================================================
// AnthropicProvider Class
// ============================================================================

export class AnthropicProvider implements LLMProvider {
  private client: AxiosInstance;
  private defaultModel: string;
  private maxTokens: number;
  private retryConfig: RetryConfig;
  private baseUrl: string;
  private authToken: string;
  private isProxyMode: boolean;
  private claudeCodeUserId: string;
  private betaFeatures: string[];
  private systemPromptPrefix: string | null;
  private sanitizeToolsForProxy: boolean;
  private disableCaching: boolean;
  private thinkingConfig: ThinkingConfig | null = null; // 动态 thinking 配置

  constructor(config: AnthropicProviderConfig) {
    this.authToken = config.authToken;
    this.baseUrl = (config.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '').replace(/\/v1$/, '');
    rememberAnthropicSession(this, config as { sessionId?: unknown });  /* opencode 要会话头, 见 anthropicSessionHeaders.ts */

    /* 三态身份策略 (auto/on/off) 决定 isProxyMode. isProxyMode=true 时会伪装 Claude Code CLI:
     *   system[0] 身份声明 + User-Agent claude-cli + PascalCase 工具名 + anthropic-beta headers +
     *   /v1/messages?beta=true + Bearer 授权 + 长格式 metadata.user_id.
     *
     *   'auto' (默认) — 按 baseUrl 判. api.anthropic.com 与模型厂商自家端点 (DeepSeek/Kimi/GLM…)
     *      走 Neox 原生, 其它一律伪装 (兼容 relay-g/timicc/packycode 等转卖 Claude 的中转站).
     *   'on' — 强制伪装. 用户想把自己 Anthropic key 挂到 Claude Code 用量池测试时用.
     *   'off' — 强制不伪装. 用户直连 api.anthropic.com 或走定制代理只吃标准 Anthropic 请求时用.
     *
     *   forceClaudeCodeMode 是旧字段, 若显式为 true 视作 'on' 兼容老配置; claudeCodeMode 优先. */
    const rawMode: 'auto' | 'on' | 'off' | undefined = config.claudeCodeMode
      ?? (config.forceClaudeCodeMode ? 'on' : undefined);
    this.isProxyMode = shouldUseClaudeCodeIdentity(this.baseUrl, rawMode ?? 'auto');

    // Generate stable user ID for session
    const rawUserId = typeof config.userId === 'string' ? config.userId.trim() : '';
    this.claudeCodeUserId = rawUserId
      ? this.sanitizeUserId(rawUserId)
      : this.generateSafeUserId();

    // Beta features
    this.betaFeatures = config.betaFeatures || DEFAULT_BETA_FEATURES;

    // System prompt prefix for proxy mode
    this.systemPromptPrefix = config.systemPromptPrefix || (this.isProxyMode ? CLAUDE_CODE_SYSTEM_PROMPT : null);

    // 不再对工具描述做特殊处理，完全匹配 Claude Code 格式
    this.sanitizeToolsForProxy = false;

    // Disable caching for proxy providers that don't support it
    this.disableCaching = config.disableCaching || false;

    // Create axios client with appropriate headers
    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        ...this.buildHeaders(),
        /* SSE 流式必须禁用上游压缩 — axios 默认 decompress=true 会用 zlib 缓冲小 chunk,
         * 表现成「流卡住 / 突然一整段吐出」。Claude Code / Cloud Code 走原生 SDK 不踩这个;
         * OpenAI 路径已 identity+decompress:false, Anthropic 对齐同一策略. */
        'Accept-Encoding': 'identity',
      },
      timeout: 300000, // 5 minutes for long responses
      decompress: false,
      // 允许所有状态码通过，我们自己处理错误
      // 这样可以正确读取流式响应中的错误信息
      validateStatus: () => true,
    });

    this.defaultModel = config.defaultModel || 'claude-sonnet-4-5-20250929';
    // 16384 对于启用 thinking 的请求来说可能不足，官方使用 32000
    this.maxTokens = config.maxTokens || 32000;

    // Initialize retry configuration
    const providerPreset = getProviderRetryConfig('anthropic', this.baseUrl);
    this.retryConfig = mergeRetryConfig(undefined, {
      ...providerPreset,
      ...config.retry,
    });

    this.debugLog('Initialized', {
      baseUrl: this.baseUrl,
      isProxyMode: this.isProxyMode,
      defaultModel: this.defaultModel,
      betaFeatures: this.betaFeatures,
    });
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * 动态设置 thinking 配置
   * 用于在运行时切换 extended thinking 模式
   */
  setThinking(config: ThinkingConfig | null): void {
    this.thinkingConfig = config;
    this.debugLog('Thinking config updated', { config });
  }

  /**
   * 动态设置 metadata.user_id（用于粘性会话）
   */
  setUserId(userId: string): void {
    const trimmed = userId?.trim?.() || '';
    if (!trimmed) {
      return;
    }
    this.claudeCodeUserId = this.sanitizeUserId(trimmed);
  }

  /**
   * 检测是否是 cache_control 不支持的错误
   * 某些代理 provider 不支持 cache_control 或 TTL 特性
   */
  private isCacheControlError(error: any): boolean {
    let errorStr = '';
    try {
      const data = error.response?.data;
      if (typeof data === 'string') {
        errorStr = data.toLowerCase();
      } else if (data && typeof data === 'object') {
        const safeData = { error: data.error, message: data.message, type: data.type, code: data.code };
        errorStr = JSON.stringify(safeData).toLowerCase();
      } else {
        errorStr = String(error.message || '').toLowerCase();
      }
    } catch {
      errorStr = String(error.message || '').toLowerCase();
    }
    return (
      errorStr.includes('cache_control') ||
      errorStr.includes('ttl=') ||
      errorStr.includes('ephemeral') ||
      (errorStr.includes('cache') && errorStr.includes('block'))
    );
  }

  async chat(
    messages: Message[],
    options: AnthropicChatOptions = {}
  ): Promise<ChatCompletionResponse> {
    // 合并 provider 配置的 disableCaching 选项
    // 动态 thinkingConfig 优先级: options.thinking > this.thinkingConfig
    const finalOptions = {
      ...options,
      disableCaching: options.disableCaching ?? this.disableCaching,
      thinking: options.thinking ?? this.thinkingConfig ?? undefined,
    };

    const maxRetries = this.retryConfig.requestMaxRetries;
    let lastError: Error | null = null;
    // 跟踪是否需要禁用缓存（cache_control 错误后使用）
    let shouldDisableCaching = finalOptions.disableCaching || false;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // 构建 payload（每次尝试可能需要不同的压缩级别或禁用缓存）
      const currentOptions = {
        ...finalOptions,
        ...(shouldDisableCaching ? { disableCaching: true } : {}),
      };
      const payload = this.buildPayload(messages, currentOptions);
      const helperMethod = payload.stream === false ? 'create' : 'stream';

      // 只在第一次尝试时记录完整请求
      if (attempt === 0) {
        this.logRequest(options.model || this.defaultModel, payload);
      }

      try {
        const startTime = Date.now();

        // 代理模式使用 /v1/messages?beta=true
        const apiPath = this.isProxyMode ? '/v1/messages?beta=true' : '/v1/messages';
        const response = await this.client.post(apiPath, payload, {
          responseType: payload.stream === false ? 'json' : 'stream',
          signal: options.signal,
          headers: this.buildHeaders(helperMethod),
        });

        if (response.status !== 200) {
          let errorData = '';
          if (payload.stream === false) {
            errorData = typeof response.data === 'string'
              ? response.data
              : JSON.stringify(response.data ?? {});
          } else {
            for await (const chunk of response.data) {
              errorData += chunk.toString();
            }
          }

          const fullUrl = `${this.baseUrl}${apiPath}`;
          const curlCmd = generateCurlCommand(fullUrl, this.buildHeaders(helperMethod), payload, false);
          cliLogger.error('CURL', '=== [chat] API Error - Full Request CURL ===');
          cliLogger.error('CURL', curlCmd);
          cliLogger.error('CURL', `=== Error Headers: ${formatResponseHeaders(response.headers)} ===`);
          cliLogger.error('CURL', `=== Error Response: ${errorData.substring(0, 1000)} ===`);

          // 创建一个带有 response 属性的错误对象，以便 classifyError 正确识别
          const error: any = new Error(`Anthropic API error: ${response.status}`);
          error.response = {
            status: response.status,
            headers: response.headers,
            data: errorData,
          };

          // 尝试解析 JSON 错误以获取更详细的信息
          try {
            const parsed = typeof response.data === 'object' && response.data !== null
              ? response.data
              : JSON.parse(errorData);
            error.response.data = parsed;
            if (parsed.error?.message) {
              error.message = `Anthropic API error: ${response.status} - ${parsed.error.message}`;
            } else if (parsed.message) {
              error.message = `Anthropic API error: ${response.status} - ${parsed.message}`;
            }
            this.debugLog('API Error Details', parsed);
          } catch {
            // HTML 或其他非 JSON 响应 - 保持原始数据
            this.debugLog('API Error (non-JSON)', { status: response.status, dataLength: errorData.length });
          }

          throw error;
        }

        const result = payload.stream === false
          ? this.convertResponse(response.data)
          : await this.collectStreamResponse(response.data);
        const duration = Date.now() - startTime;

        logger.llmResponse('anthropic', duration, result.usage, result.choices[0]);
        this.debugLog('Response', {
          duration: `${duration}ms`,
          usage: result.usage,
          stream: payload.stream !== false,
        });

        return result;
      } catch (error: any) {
        await this.normalizeAxiosStreamError(error);
        lastError = error;

        const classifiedError = classifyError(error);
        if (classifiedError.code === 'PROXY_UPSTREAM_FAILED') {
          // 记录请求规模，方便排查上游 400 错误
          const payloadSize = JSON.stringify(payload || {}).length;
          const msgCount = Array.isArray(messages) ? messages.length : 0;
          const promptChars = Array.isArray(messages)
            ? messages.reduce((sum, m) => {
              if (!m?.content) return sum;
              if (typeof m.content === 'string') return sum + m.content.length;
              if (Array.isArray(m.content)) {
                return sum + m.content
                  .map((c: any) => (typeof c.text === 'string' ? c.text.length : 0))
                  .reduce((s: number, n: number) => s + n, 0);
              }
              return sum;
            }, 0)
            : 0;

          cliLogger.warn('Anthropic', 'Upstream request failed (PROXY_UPSTREAM_FAILED)', {
            attempt: `${attempt + 1}/${maxRetries + 1}`,
            payloadSize,
            msgCount,
            promptChars,
            status: error.response?.status,
          });
        }

        this.debugLog('Error', {
          message: error.message,
          category: classifiedError.category,
          code: classifiedError.code,
          attempt: `${attempt + 1}/${maxRetries + 1}`,
        });

        logger.llmError('anthropic', error);

        // 某些代理 provider 不支持 cache_control 或 TTL 特性
        if (this.isCacheControlError(error) && !shouldDisableCaching) {
          shouldDisableCaching = true;
          this.disableCaching = true; // 永久禁用该 provider 的缓存
          this.debugLog('Cache control not supported, disabling caching for retry', {
            errorMessage: error.message,
            attempt: attempt + 1,
          });
          cliLogger.warn('Anthropic', '⚠️ Provider 不支持 cache_control，已自动禁用缓存重试...');
          // 不消耗重试次数，直接重试
          continue;
        }

        if (!classifiedError.retryable || attempt === maxRetries) {
          throw classifiedError;
        }

        if (
          finalOptions.requestPriority === 'background'
          && classifiedError.category === ErrorCategory.RETRYABLE_RATE_LIMIT
        ) {
          cliLogger.info('Anthropic', `background request hit ${classifiedError.code}, failing fast (not retrying)`);
          throw classifiedError;
        }

        // 使用增强的 header 解析，支持多种格式
        const serverDelay = parseRetryAfterFromHeaders(error.response?.headers);
        // 使用智能退避策略：速率限制类错误使用更长延迟
        const delay = getSmartRetryDelay(
          classifiedError.category,
          attempt + 1,
          serverDelay || classifiedError.retryAfter
        );

        const isRateLimit = classifiedError.category === ErrorCategory.RETRYABLE_RATE_LIMIT;
        const retryMsg = isRateLimit
          ? `⏳ API 代理速率限制，${formatDelay(delay)} 后重试...`
          : `Retrying in ${formatDelay(delay)}...`;

        this.debugLog('Retrying', {
          delay: formatDelay(delay),
          attempt: attempt + 1,
          isRateLimit,
          serverDelay: serverDelay ? formatDelay(serverDelay) : 'none',
          retryMsg,
        });

        try {
          await abortableSleep(delay, finalOptions.signal);
        } catch (abortError: any) {
          if (abortError?.name === 'AbortError') {
            this.debugLog('Chat retry interrupted by user');
            throw abortError;
          }
          throw abortError;
        }
      }
    }

    throw lastError || new Error('Unknown error during retry');
  }

  /**
   * 收集流式响应并组装成完整的 ChatCompletionResponse
   */
  private async collectStreamResponse(stream: any): Promise<ChatCompletionResponse> {
    let buffer = '';
    let textContent = '';
    const toolCalls: any[] = [];
    /* Anthropic content block index → toolCalls 下标 (并行 tool_use 的 delta 会交错) */
    const blockIndexToToolIndex = new Map<number, number>();
    let reasoningContent = '';
    let finalUsage: any = null;
    let messageId = '';
    let stopReason = '';

    const decodeChunk = createUtf8ChunkDecoder();
    for await (const chunk of stream) {
      const chunkStr = decodeChunk(chunk);
      buffer += chunkStr;

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine || !trimmedLine.startsWith('data: ')) continue;

        const data = trimmedLine.slice(6);
        if (data === '[DONE]') continue;

        try {
          const event = JSON.parse(data);

          // Debug: log all SSE events for troubleshooting (类似官方截图的格式)
          if (process.env.CLI_DEBUG === '1') {
            // 格式: event_type  {"type":"...", ...}
            const eventPreview = JSON.stringify(event).substring(0, 80);
            cliLogger.debug('SSE', `${event.type.padEnd(20)} ${eventPreview}${JSON.stringify(event).length > 80 ? '...' : ''}`);
          }

          switch (event.type) {
            case 'message_start':
              messageId = event.message?.id || '';
              finalUsage = event.message?.usage;
              break;

            case 'content_block_start':
              if (event.content_block?.type === 'tool_use') {
                const toolUse = event.content_block;
                /* Anthropic content block index → toolCalls 下标. 并行 tool_use 的
                 * input_json_delta 会交错到达, 只能靠它归位 (见下方 delta 分支注释)。 */
                blockIndexToToolIndex.set(event.index, toolCalls.length);
                // 将 Claude Code 工具名转换回我们的工具名
                const originalName = this.isProxyMode
                  ? (CLAUDE_CODE_TO_TOOL_NAME[toolUse.name] || this.fromClaudeCodeToolName(toolUse.name))
                  : toolUse.name;
                const initial = fromClaudeToolUse({
                  type: 'tool_use',
                  id: toolUse.id,
                  name: originalName,
                  input: undefined,
                });
                if (initial) {
                  initial.function.arguments = ''; // 流式重置, 等 input_json_delta 累积
                  toolCalls.push(initial);
                }
              }
              break;

            case 'content_block_delta':
              if (event.delta?.type === 'text_delta') {
                textContent += event.delta.text || '';
              } else if (event.delta?.type === 'input_json_delta') {
                const mappedIndex = blockIndexToToolIndex.get(event.index);
                const target = mappedIndex !== undefined ? toolCalls[mappedIndex] : undefined;
                if (target) {
                  target.function.arguments += event.delta.partial_json || '';
                }
              } else if (event.delta?.type === 'thinking_delta') {
                reasoningContent += event.delta.thinking || '';
              }
              break;

            case 'message_delta':
              if (event.usage) {
                finalUsage = { ...finalUsage, ...event.usage };
              }
              if (typeof event.delta?.stop_reason === 'string') stopReason = event.delta.stop_reason;
              break;
          }
        } catch (parseError) {
          // Log parse errors in debug mode
          if (process.env.CLI_DEBUG === '1') {
            cliLogger.warn('Anthropic', `Stream parse error: ${parseError}, data: ${data.substring(0, 200)}`);
          }
        }
      }
    }

    const usage = this.buildUsageFromRaw(finalUsage);

    return {
      id: messageId,
      choices: [{
        message: {
          role: 'assistant' as const,
          content: textContent || '',
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
        },
        finish_reason: ((mapped) => (mapped === 'stop' && toolCalls.length > 0 ? 'tool_calls' : mapped))(this.convertStopReason(stopReason ?? '')),
      }],
      usage,
    };
  }

  async *chatStreamed(
    messages: Message[],
    options: AnthropicChatOptions = {}
  ): AsyncGenerator<any> {
    /* 调试: NEOX_DUMP_LLM=1 时落 payload, 否则零开销. 详见 utils/llmPayloadDump.ts. */
    dumpLLMPayload({
      source: 'AnthropicProvider.chatStreamed',
      baseUrl: this.baseUrl,
      isProxyMode: this.isProxyMode,
      systemPromptPrefix: this.systemPromptPrefix,
      messages,
      system: (options as any).system,
      tools: options.tools,
    });

    // 合并 provider 配置的 disableCaching 选项
    // 动态 thinkingConfig 优先级: options.thinking > this.thinkingConfig
    const finalOptions = {
      ...options,
      disableCaching: options.disableCaching ?? this.disableCaching,
      thinking: options.thinking ?? this.thinkingConfig ?? undefined,
    };

    const maxStreamRetries = this.retryConfig.streamMaxRetries;
    let streamRetries = 0;
    // 跟踪是否需要禁用缓存（cache_control 错误后使用）
    let shouldDisableCaching = finalOptions.disableCaching || false;
    let isFirstAttempt = true;
    /* 本请求已经把正文/思考/工具参数吐给上层了没有。吐过之后 provider 不许自己整段重发:
     * 上层已经攒着上一次的半截, 重发的内容会接在后面 —— 同一句话出现两遍, 工具参数在同一个
     * index 上串成坏 JSON。交给 runner 级重试, 它会告诉界面撤掉哪些 (streamRetryDiscard)。
     * openai.ts 的 emittedStreamEvent 是同一条规矩。 */
    let emittedContent = false;

    while (true) {
      // 防止 runTask 结束后的幽灵重试（Ghost Retry）
      if (options.signal?.aborted) {
        this.debugLog('chatStreamed: signal aborted at loop start, exiting');
        return;
      }

      // 构建 payload（每次尝试可能需要禁用缓存）
      const currentOptions = {
        ...finalOptions,
        ...(shouldDisableCaching ? { disableCaching: true } : {}),
      };
      const payload = this.buildPayload(messages, currentOptions);
      payload.stream = true;

      // 只在第一次尝试时记录完整请求
      if (isFirstAttempt) {
        this.logRequest(options.model || this.defaultModel, payload, true);
        isFirstAttempt = false;
      }
      try {
        const startTime = Date.now();
        // 代理模式使用 /v1/messages?beta=true
        const apiPath = this.isProxyMode ? '/v1/messages?beta=true' : '/v1/messages';
        const response = await this.client.post(apiPath, payload, {
          responseType: 'stream',
          signal: options.signal,
        });

        this.debugLog('Stream started', { status: response.status });

        if (response.status !== 200) {
          let errorData = '';
          for await (const chunk of response.data) {
            errorData += chunk.toString();
          }

          const fullUrl = `${this.baseUrl}${apiPath}`;
          const curlCmd = generateCurlCommand(fullUrl, this.buildHeaders(), payload, false);
          cliLogger.error('CURL', '=== [chatStreamed] API Error - Full Request CURL ===');
          cliLogger.error('CURL', curlCmd);
          cliLogger.error('CURL', `=== Error Headers: ${formatResponseHeaders(response.headers)} ===`);
          cliLogger.error('CURL', `=== Error Response: ${errorData.substring(0, 1000)} ===`);

          // 创建一个带有 response 属性的错误对象，以便 classifyError 正确识别
          // Create an error object with response property for proper classification
          const error: any = new Error(`Anthropic API error: ${response.status}`);
          error.response = {
            status: response.status,
            headers: response.headers,
            data: errorData,
          };

          // 尝试解析 JSON 错误以获取更详细的信息
          try {
            const parsed = JSON.parse(errorData);
            error.response.data = parsed;
            if (parsed.error?.message) {
              error.message = `Anthropic API error: ${response.status} - ${parsed.error.message}`;
            } else if (parsed.message) {
              error.message = `Anthropic API error: ${response.status} - ${parsed.message}`;
            }
            this.debugLog('API Error Details (stream)', parsed);
          } catch {
            // HTML 或其他非 JSON 响应 - 保持原始数据
            this.debugLog('API Error (non-JSON, stream)', { status: response.status, dataLength: errorData.length });
          }

          throw error;
        }

        // Stream processing state — 全部收敛到 index 寻址的累积器 state, 不再有游标标量
        let buffer = '';
        let lastEventTime = Date.now();   // 跟踪最后一次收到事件的时间
        const state: AnthropicStreamState = {
          blocks: new Map(),
          toolCalls: [],
          nextToolIndex: 0,
          roleSent: false,
          usage: null,
          stopReason: null,
          messageStopReceived: false,
        };

        // 使用带超时的流迭代器，防止代理不响应导致完全卡住
        const decodeChunk = createUtf8ChunkDecoder();
        for await (const chunk of this.createTimeoutStream(response.data, options.signal)) {
          lastEventTime = Date.now();  // 更新最后事件时间
          /* StringDecoder: 跨 chunk 的半个多字节字符要留到下一块 (见 utf8StreamDecoder) */
          const chunkStr = decodeChunk(chunk);
          buffer += chunkStr;

          // SSE 格式：事件之间用双换行符分隔
          // 某些代理（如 relay-g）可能在 JSON 中间插入单换行符
          // 所以我们用双换行符（\n\n）分割事件，而不是单换行符
          const events = buffer.split(/\n\n+/);
          buffer = events.pop() || ''; // 最后一个可能不完整，保留在 buffer 中

          for (const eventBlock of events) {
            const lines = eventBlock.split('\n');
            let dataContent = '';

            for (const line of lines) {
              const trimmedLine = line.trim();
              if (!trimmedLine) continue;

              if (trimmedLine.startsWith('event:')) {
                // event 行，跳过（我们从 data 中获取 type）
                continue;
              } else if (trimmedLine.startsWith('data:')) {
                // 提取 data 内容（可能有空格也可能没有）
                let data = trimmedLine.slice(5);
                if (data.startsWith(' ')) {
                  data = data.slice(1);
                }
                dataContent += data;
              } else {
                // 某些代理可能把 JSON 分成多行，这里继续收集
                dataContent += trimmedLine;
              }
            }

            if (!dataContent || dataContent === '[DONE]') continue;

            // 解析单独放进窄 try — 只有 JSON 解析失败才忽略 (跨 chunk 被切断, 等后续拼接);
            // reducer 抛出的 error 事件必须冒泡到外层重试逻辑, 不能被吞。
            let event: any;
            try {
              event = JSON.parse(dataContent.trim());
            } catch {
              continue;
            }

            // Debug: log all SSE events (类似官方截图格式)
            if (process.env.CLI_DEBUG === '1') {
              const eventPreview = JSON.stringify(event).substring(0, 80);
              cliLogger.debug('SSE', `${(event.type || '?').padEnd(20)} ${eventPreview}${JSON.stringify(event).length > 80 ? '...' : ''}`);
            }

            // 单事件折叠进 index 寻址的 state, 拿回要 emit 的增量 chunk 列表
            const { yields } = this.reduceAnthropicStreamEvent(event, state);
            for (const chunk of yields) {
              const d = (chunk as any)?.choices?.[0]?.delta;
              if (d && (d.content || d.reasoning_content || d.tool_calls)) emittedContent = true;
              yield chunk;
            }
          }

          // 发送多个完整的 message（多个 message_start → message_stop 周期）。
          // 正常的 Anthropic API 每个请求只返回一个 message。
          // 如果不在 message_stop 后 break，第二个 message 会被合并到同一个响应中，
          // 导致 runner 在一次迭代中处理两轮不同的工具调用，破坏 tool_call/tool_result 配对。
          if (state.messageStopReceived) {
            this.debugLog('Stream: message_stop received, breaking out of stream loop');
            break;
          }
        }

        // ============================================================
        // 流收尾 — 全部走 index 寻址, 无任何"块计数平衡"断言
        // ============================================================
        const duration = Date.now() - startTime;

        // 1) 关闭所有仍开着的块 (漏发 content_block_stop 天然容错): 按 index 升序结算,
        //    thinking 补发 reasoning_complete, tool_use 补做 JSON 校验/自愈。
        for (const idx of [...state.blocks.keys()].sort((a, b) => a - b)) {
          for (const chunk of this.closeBlock(state, idx)) {
            yield chunk;
          }
        }

        // 2) 按 index 顺序收集 thinking_blocks (多轮对话回传, 保 signature)
        const thinkingBlocks: Array<{ type: string; thinking?: string; signature?: string; data?: string }> = [];
        for (const idx of [...state.blocks.keys()].sort((a, b) => a - b)) {
          const b = state.blocks.get(idx)!;
          if (b.kind === 'thinking') {
            thinkingBlocks.push({ type: 'thinking', thinking: b.thinking || '', signature: b.signature || '' });
          } else if (b.kind === 'redacted_thinking') {
            thinkingBlocks.push({ type: 'redacted_thinking', data: b.data });
          }
        }
        const toolCalls = state.toolCalls;

        this.debugLog('Stream completion check', {
          messageStopReceived: state.messageStopReceived,
          stopReason: state.stopReason,
          blocks: state.blocks.size,
          toolCallsCount: toolCalls.length,
          duration: `${duration}ms`,
        });

        // 3) 唯一的完整性判据: 完全没有终止信号 (message_stop / stop_reason 都缺) = 真·网络中断。
        //    这是系统边界失败, 必须上抛 → 走重试 / 上屏, 绝不静默兜底。
        //    其余一切"块没配平"在 index 寻址下都无意义, 一律不当错误 (这才是最高容错的来源:
        //    我们用协议自带的 index 地址组装内容, 不靠帧是否规整)。
        if (!state.messageStopReceived && !state.stopReason) {
          const incompleteError = new Error(
            state.blocks.size === 0
              ? `Stream incomplete: empty upstream response (no message_start / message_stop). Often means the gateway returned 200 with no body or an unparsed error (e.g. Grok 426 version gate).`
              : `Stream incomplete: no termination signal (message_stop / stop_reason absent, blocks=${state.blocks.size})`
          ) as RetryableStreamError;
          incompleteError.code = 'STREAM_INCOMPLETE';
          incompleteError.isNetworkInterrupt = true;
          this.debugLog('Stream incomplete detected (no termination signal)', {
            blocks: state.blocks.size,
            toolCallsCount: toolCalls.length,
            duration: `${duration}ms`,
          });
          throw incompleteError;
        }

        if (state.stopReason === 'max_tokens') {
          cliLogger.warn('Anthropic', '⚠️ Response truncated due to max_tokens limit. Consider increasing max_tokens or breaking down the task.');
        }

        this.debugLog('finalUsage before build', state.usage);
        const usage = this.buildUsageFromRaw(state.usage);
        this.debugLog('usage after build', usage);

        // Warn if stream completed with no content (potential API issue)
        if (!state.roleSent && toolCalls.length === 0) {
          cliLogger.warn('Anthropic', `⚠️ Stream completed with no content! duration: ${duration}ms, usage: ${JSON.stringify(state.usage)}`);
        }

        logger.llmResponse('anthropic-stream', duration, usage || {}, {});
        this.debugLog('Stream complete', { duration: `${duration}ms` });

        // Final chunk - include thinking_blocks for multi-turn conversation
        yield {
          choices: [{ delta: {}, finish_reason: this.convertStopReason(state.stopReason ?? ''), index: 0 }],
          ...(usage ? { usage } : {}),
          ...(thinkingBlocks.length > 0 ? { thinking_blocks: thinkingBlocks } : {}),
        };

        return;
      } catch (error: any) {
        await this.normalizeAxiosStreamError(error);
        const classifiedError = classifyError(error);

        this.debugLog('Stream error', {
          message: error.message,
          category: classifiedError.category,
          retryable: classifiedError.retryable,
        });

        const apiPath = this.isProxyMode ? '/v1/messages?beta=true' : '/v1/messages';
        const fullUrl = `${this.baseUrl}${apiPath}`;
        const curlCmd = generateCurlCommand(fullUrl, this.buildHeaders(), payload, false);
        cliLogger.error('CURL', '=== [chatStreamed catch] Stream Error - Full Request CURL ===');
        cliLogger.error('CURL', curlCmd);
        cliLogger.error('CURL', `=== Error: ${classifiedError.message} ===`);

        logger.llmError('anthropic-stream', error);

        // 某些代理 provider 不支持 cache_control 或 TTL 特性
        if (this.isCacheControlError(error) && !shouldDisableCaching) {
          shouldDisableCaching = true;
          this.disableCaching = true; // 永久禁用该 provider 的缓存
          this.debugLog('Cache control not supported, disabling caching for retry', {
            errorMessage: error.message,
            attempt: streamRetries + 1,
          });
          cliLogger.warn('Anthropic', '⚠️ Provider 不支持 cache_control，已自动禁用缓存重试...');
          // 不消耗重试次数，直接重试
          continue;
        }

        if (!emittedContent && classifiedError.retryable && streamRetries < maxStreamRetries) {
          // 如果 runTask 已经完成并清理了 abortController，
          // 这里的重试会变成幽灵请求（Ghost Retry），
          // 导致工具在 "Run completed" 之后继续执行！
          if (options.signal?.aborted) {
            this.debugLog('Stream retry skipped: signal already aborted');
            throw error; // 不重试，直接抛出
          }
          /* 后台优先级请求遇容量类错误直接失败, 给前台让路. */
          if (
            finalOptions.requestPriority === 'background'
            && classifiedError.category === ErrorCategory.RETRYABLE_RATE_LIMIT
          ) {
            cliLogger.info('Anthropic', `background stream hit ${classifiedError.code}, failing fast`);
            throw classifiedError;
          }
          streamRetries++;

          // 使用增强的 header 解析，支持多种格式
          const serverDelay = parseRetryAfterFromHeaders(error.response?.headers);
          // 使用智能退避策略
          const delay = getSmartRetryDelay(
            classifiedError.category,
            streamRetries,
            serverDelay || classifiedError.retryAfter
          );

          const isRateLimit = classifiedError.category === ErrorCategory.RETRYABLE_RATE_LIMIT;
          const isStreamIncomplete = classifiedError.category === ErrorCategory.RETRYABLE_STREAM;

          this.debugLog('Stream retrying', {
            delay: formatDelay(delay),
            attempt: `${streamRetries}/${maxStreamRetries}`,
            isRateLimit,
            isStreamIncomplete,
          });

          // 通过事件系统显示重试信息（不直接 console.log，避免破坏 TUI 布局）
          yield {
            type: 'stream_retry',
            error: classifiedError.message,
            errorCode: classifiedError.code,
            attempt: streamRetries,
            maxRetries: maxStreamRetries,
            delayMs: delay,
            isRateLimit,
            isNetworkError: isStreamIncomplete,
          };

          try {
            await abortableSleep(delay, options.signal);
          } catch (abortError: any) {
            if (abortError?.name === 'AbortError') {
              this.debugLog('Stream retry interrupted by user');
              throw abortError; // 向上抛出中断错误
            }
            throw abortError;
          }

          // This ensures UI updates status to "Reconnecting..." before retry starts
          this.debugLog('Stream retry starting', { attempt: streamRetries });
          yield {
            type: 'stream_recovered',
            attempt: streamRetries,
            maxRetries: maxStreamRetries,
          };

          continue;
        }

        throw classifiedError;
      }
    }
  }

  // ==========================================================================
  // Payload Building
  // ==========================================================================

  private buildPayload(messages: Message[], options: AnthropicChatOptions): any {
    const model = options.model || this.defaultModel;
    const { system, anthropicMessages } = this.convertMessages(messages, options);

    // 代理模式：保持与真实 Claude Code 请求格式一致
    // system 有两个 text block：
    // 1. 固定的 Claude Code 身份声明
    // 2. 用户的 instructions（如果有）
    const finalMessages = anthropicMessages;

    // 构建 system 数组，匹配真实 Claude Code 格式
    const systemBlocks = this.buildSystemBlocks(system, options);

    if (process.env.CLI_DEBUG === '1' && system) {
      const markers = [
        '## 项目记忆',
        '## 上次任务摘要',
        '## Project Memory',
        '## Last Run Summary',
      ];
      const hasMemory = markers.some(marker => system.includes(marker));
      const markerIndex = markers.reduce((found, marker) => {
        if (found >= 0) return found;
        return system.indexOf(marker);
      }, -1);
      const snippet = markerIndex >= 0 ? system.slice(markerIndex, markerIndex + 300) : undefined;
      cliLogger.info('MEMORY_INJECT', 'Anthropic system memory check', {
        hasMemory,
        systemLength: system.length,
        snippet,
      });
    }

    // 构建 payload，字段顺序严格匹配 Claude Code 请求格式
    // 顺序: model -> system -> metadata -> max_tokens -> temperature -> stream -> messages -> tools
    const requestMaxTokens = this.resolveRequestMaxTokens(options);
    const payload: any = {
      model: this.normalizeModelName(model),
      system: systemBlocks,
      metadata: this.buildMetadata(options.metadata),
      max_tokens: requestMaxTokens,
    };

    // Temperature (not allowed with thinking)
    if (!options.thinking?.type || options.thinking.type === 'disabled') {
      payload.temperature = options.temperature ?? 0.7;
    }

    // stream 必须在 messages 之前
    payload.stream = options.stream ?? true;

    // messages
    payload.messages = finalMessages;

    // Tools - 在 messages 之后
    if (options.tools?.length) {
      payload.tools = this.buildToolsPayload(options.tools, options);
    }

    // Web search tool
    if (options.webSearch?.enabled) {
      payload.tools = payload.tools || [];
      payload.tools.push(this.buildWebSearchTool(options.webSearch));
    }

    // 确保最后一个 tool 有 cache_control（用于 Prompt Caching）
    // 注意：必须在所有 tools 添加完成后执行
    if (payload.tools?.length > 0) {
      this.ensureLastToolCacheControl(payload.tools, options);
    }

    // Extended thinking
    if (this.shouldEnableThinking(model, options, requestMaxTokens)) {
      payload.thinking = this.buildThinkingPayload(options, requestMaxTokens);
      // Thinking requires specific settings
      delete payload.temperature;
      payload.temperature = 1.0;
      /* Anthropic 协议: thinking 启用时 tool_choice 仅支持 {type:"auto"} / {type:"none"};
       * any / 具名 直接 400 (https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking).
       * 当前 adapter 不发 tool_choice 字段, Anthropic 走默认 auto, 跟 thinking 兼容.
       * **如果将来加 tool_choice 出口**, 这里必须 force-clamp 到 auto/none:
       *   if (payload.tool_choice && !['auto','none'].includes(payload.tool_choice.type)) {
       *     payload.tool_choice = { type: 'auto' }; // warn
       *   }
       * 详见 内部设计文档 §5. */
    }

    // 以下字段 Claude Code 不使用，移除以避免代理站检测
    // - top_p, top_k: Claude Code 不设置
    // - stop_sequences: Claude Code 不设置
    // - max_input_tokens: Claude Code 不设置

    const effectiveEffortLevel =
      options.effortLevel
      ?? (options.thinking === undefined && payload.thinking === undefined
        ? resolveDefaultThinkingLevel(model) ?? undefined
        : undefined);

    if (effectiveEffortLevel && options.thinking === undefined) {
      const resolved = resolveEffortPayload(model, effectiveEffortLevel);
      let thinkingSetFromEffortMap = false;
      for (const [k, v] of Object.entries(resolved.payload)) {
        payload[k] = v;
        if (k === 'thinking') thinkingSetFromEffortMap = true;
      }
      if (thinkingSetFromEffortMap && payload.thinking?.type === 'enabled') {
        /* Anthropic 协议: thinking enabled 时 temperature 必须 1.0 (否则 400)。 */
        delete payload.temperature;
        payload.temperature = 1.0;
      } else if (thinkingSetFromEffortMap && payload.thinking?.type === 'adaptive') {
        /* Opus 4.7/4.8 adaptive thinking 不带自定义采样参数; 默认 temperature=0.7 会 400。 */
        delete payload.temperature;
      } else if (thinkingSetFromEffortMap && payload.thinking?.type === 'disabled') {
        /* 用户显式关思考 ('off' 档): Anthropic 不接受 {type:disabled}, 直接不发字段 */
        delete payload.thinking;
      }
    }

    // 预算检查：检测请求体是否过大
    this.checkRequestBudget(payload);

    dumpLlmPayloadIfEnabled('anthropic', payload);
    return payload;
  }

  /**
   * 检查请求体大小，防止上游代理 400 错误
   * P1-3: 发送前预算检查
   */
  private checkRequestBudget(payload: any): void {
    const payloadStr = JSON.stringify(payload);
    const bodySize = payloadStr.length;

    if (bodySize > REQUEST_BODY_MAX_BYTES) {
      this.debugLog('Request body exceeds limit', {
        bodySize,
        limit: REQUEST_BODY_MAX_BYTES,
        messageCount: payload.messages?.length || 0,
      });

      // 记录详细的消息分析
      if (payload.messages) {
        const messageSizes = payload.messages.map((msg: any, idx: number) => ({
          index: idx,
          role: msg.role,
          contentSize: JSON.stringify(msg.content || '').length,
        }));

        // 找出最大的几条消息
        const sortedBySizes = [...messageSizes].sort((a, b) => b.contentSize - a.contentSize);
        this.debugLog('Largest messages in request', {
          top5: sortedBySizes.slice(0, 5),
        });
      }

      // 发出警告而不是抛出错误，让请求继续（上游会返回 400，由重试逻辑处理）
      console.warn(`[Anthropic] ⚠️ Request body size (${(bodySize / 1024 / 1024).toFixed(2)}MB) exceeds ${(REQUEST_BODY_MAX_BYTES / 1024 / 1024).toFixed(1)}MB limit. Request may fail.`);
    } else if (bodySize > REQUEST_BODY_WARNING_THRESHOLD) {
      this.debugLog('Request body approaching limit', {
        bodySize,
        limit: REQUEST_BODY_MAX_BYTES,
        percentage: ((bodySize / REQUEST_BODY_MAX_BYTES) * 100).toFixed(1) + '%',
      });
    }
  }

  /**
   * 将用户 system prompt 合并到第一条用户消息中
   */
  private mergeSystemIntoMessages(system: string, messages: any[]): any[] {
    const result = [...messages];
    const firstUserMsgIndex = result.findIndex(m => m.role === 'user');

    if (firstUserMsgIndex >= 0) {
      const firstUserMsg = result[firstUserMsgIndex];
      const systemContext = {
        type: 'text',
        text: `<system_context>\n${system}\n</system_context>`,
      };

      if (Array.isArray(firstUserMsg.content)) {
        // 在用户消息内容前插入 system 上下文
        result[firstUserMsgIndex] = {
          ...firstUserMsg,
          content: [systemContext, ...firstUserMsg.content],
        };
      } else if (typeof firstUserMsg.content === 'string') {
        // 字符串内容转为数组格式
        result[firstUserMsgIndex] = {
          ...firstUserMsg,
          content: [
            systemContext,
            { type: 'text', text: firstUserMsg.content },
          ],
        };
      }
    }

    return result;
  }

  // buildSystemPayload 已废弃，直接在 buildPayload 中处理

  private buildSystemBlocks(system: string | null, options: AnthropicChatOptions): any[] {
    const systemBlocks: any[] = [];

    const appendBlock = (text: string, cacheMode: 'default' | 'global' | 'none', addLeadingNewline = false) => {
      const block: any = {
        type: 'text',
        text: addLeadingNewline ? `\n${text}` : text,
      };

      if (!options.disableCaching && cacheMode !== 'none') {
        block.cache_control = buildClaudePromptCacheControl( // scope 只配伪装时才发的 beta 头
          cacheMode === 'global' && this.isProxyMode ? { scope: 'global' } : undefined,
        );
      }

      systemBlocks.push(block);
    };

    if (this.isProxyMode) {
      appendBlock(CLAUDE_CODE_SYSTEM_PROMPT, 'none');
    }

    if (!system) {
      return systemBlocks;
    }

    const promptBlocks = splitSystemPromptForCaching(system);
    promptBlocks.forEach((block, index) => {
      appendBlock(block.text, block.cacheMode, index === 0);
    });

    return systemBlocks;
  }

  /**
   * 构建 tools payload — 分区稳定排序, built-in 前置.
   *
   * 关键 (对齐 Claude Code claude_code_system_cache_policy):
   *   Anthropic server 会给 built-in 6 工具 (Bash/Read/Write/Edit/Grep/AskUserQuestion 等)
   *   打一个 global cache breakpoint. 前提是这些 built-in 在 tools[] 里**连续排在开头**,
   *   否则任何 MCP/custom 工具穿插进 built-in 中间, 后续所有 cache key 就作废.
   *
   *   之前实现 (flat localeCompare) 例子:
   *     [AbandonTarget, ActivateTarget, ..., AskUserQuestion, Bash, ..., Edit, ..., Read, ..., Write]
   *     ↑ 第 0 位 AbandonTarget 就把 built-in 前缀打散了 → built_in_prefix=0 → 全都不命中
   *
   *   分区后:
   *     [AskUserQuestion, Bash, Edit, Grep, Read, Write, AbandonTarget, ActivateTarget, ...]
   *     ↑ built-in 段连续 6 位, 剩下 custom 按字母序追加
   *
   *   isProxyMode=true (Claude Code 代理) 时 transformToolDefinition 会把内部名 remap 成
   *   PascalCase (execute_shell→Bash, readfile→Read, ...), 分区判定用 CLAUDE_CODE_BUILT_IN_TOOL_NAMES.
   *   isProxyMode=false (官方 API 或非 Claude Code 代理) 时不 remap, 分区 set 匹配不到, 全走
   *   custom 分区退化到原有单一 alpha 排序 — 安全兜底, 不改变非代理行为.
   */
  private buildToolsPayload(tools: Tool[], options: AnthropicChatOptions): any[] {
    const claudeTools = tools.map(tool => {
      const def = this.transformToolDefinition(tool);
      // FGTS: 工具参数不缓冲直接流式输出
      if (options.enableFGTS) {
        def.eager_input_streaming = true;
      }
      return def;
    });

    const byName = (l: any, r: any) => String(l.name || '').localeCompare(String(r.name || ''));
    const isBuiltIn = (t: any) => CLAUDE_CODE_BUILT_IN_TOOL_NAMES.has(String(t.name || ''));

    const builtIn = claudeTools.filter(isBuiltIn).sort(byName);
    const custom = claudeTools.filter(t => !isBuiltIn(t)).sort(byName);
    return [...builtIn, ...custom];
  }

  /**
   * 给 tools 数组打 cache_control anchor — 定位在 **最后一个 built-in tool** 上,
   * 而不是数组最末尾 (通常是某个 custom tool).
   *
   * 为什么不打末尾:
   *   custom / MCP tools 在会话生命周期里可能变 (加载/卸载/参数刷新), 打末尾 cache
   *   anchor 会因为 tail 变化让整个 tools[] 的 prefix hash 失效. built-in 6 工具是
   *   稳定不变的, 打在 built-in 段末尾, 前面的 built-in prefix (system + built-in 6)
   *   永远命中, 后面 custom 变不影响.
   *
   *   配合 buildToolsPayload 的分区排序 (built-in 前, custom 后), built-in 段末尾就是
   *   最后一个 built-in tool 的位置. 找不到 built-in (纯 custom 场景) 才退回原逻辑
   *   (数组末尾), 保持行为兜底.
   */
  private ensureLastToolCacheControl(tools: any[], options: AnthropicChatOptions): void {
    if (tools.length === 0) return;
    if (options.disableCaching) return;

    let anchorIdx = -1;
    for (let i = tools.length - 1; i >= 0; i--) {
      if (CLAUDE_CODE_BUILT_IN_TOOL_NAMES.has(String(tools[i].name || ''))) {
        anchorIdx = i;
        break;
      }
    }
    if (anchorIdx < 0) {
      anchorIdx = tools.length - 1;
    }

    tools[anchorIdx].cache_control = { type: 'ephemeral' };

    this.debugLog('Added cache_control to tools[]', {
      anchorIdx,
      toolName: tools[anchorIdx].name,
      builtInAnchored: anchorIdx < tools.length - 1 || CLAUDE_CODE_BUILT_IN_TOOL_NAMES.has(String(tools[anchorIdx].name || '')),
    });
  }

  private buildWebSearchTool(config: WebSearchConfig): any {
    const tool: any = {
      type: 'web_search_20250305',
      name: 'web_search',
    };

    if (config.max_uses) {
      tool.max_uses = config.max_uses;
    }

    if (config.user_location) {
      tool.user_location = config.user_location;
    }

    return tool;
  }

  private resolveRequestMaxTokens(options: AnthropicChatOptions): number {
    const OUTPUT_TOKENS_CAP = 32000;
    const requested = typeof options.maxInputTokens === 'number' && Number.isFinite(options.maxInputTokens) && options.maxInputTokens > 0
      ? options.maxInputTokens
      : typeof options.maxTokens === 'number' && Number.isFinite(options.maxTokens) && options.maxTokens > 0
        ? options.maxTokens
        : this.maxTokens;
    return Math.min(Math.floor(requested), OUTPUT_TOKENS_CAP);
  }

  private buildThinkingPayload(options: AnthropicChatOptions, requestMaxTokens: number): any {
    const budgetTokens = options.thinking?.budget_tokens ?? (requestMaxTokens - 1);

    return {
      type: 'enabled',
      budget_tokens: Math.max(Math.min(budgetTokens, requestMaxTokens - 1), MIN_THINKING_BUDGET),
    };
  }

  private buildMetadata(customMetadata?: AnthropicMetadata): any {
    const metadata: any = { ...customMetadata };

    // Ensure user_id is safe
    if (metadata.user_id) {
      metadata.user_id = this.sanitizeUserId(metadata.user_id);
    } else {
      metadata.user_id = this.claudeCodeUserId;
    }

    return metadata;
  }

  private shouldEnableThinking(model: string, options: AnthropicChatOptions, requestMaxTokens: number): boolean {
    const canFitThinkingBudget = requestMaxTokens > MIN_THINKING_BUDGET;

    if (options.thinking?.type === 'enabled') {
      return canFitThinkingBudget;
    }
    if (options.thinking?.type === 'disabled') return false;
    if (!canFitThinkingBudget) return false;

    if (model.endsWith('-thinking')) return true;
    if (model.includes('opus-4-6') || model.includes('opus-4.6') || model.includes('opus-4-5') || model.includes('opus-4.5')) return true;

    return false;
  }

  private normalizeModelName(model: string): string {
    // Remove -thinking suffix for actual API call if thinking is handled separately
    if (model.endsWith('-thinking')) {
      return model.replace(/-thinking$/, '');
    }
    return model;
  }

  // ==========================================================================
  // Message Conversion
  // ==========================================================================

  private convertMessages(
    messages: Message[],
    options: AnthropicChatOptions
  ): { system: string | null; anthropicMessages: any[] } {
    const normalizedMessages = this.normalizeMessages(messages);
    const systemParts: string[] = [];
    const convertedMessages: any[] = [];

    for (const msg of normalizedMessages) {
      if (msg.role === 'system') {
        const text = getTextFromContent(msg.content).trim();
        if (text) {
          systemParts.push(text);
        }
        continue;
      }

      const converted = this.convertSingleMessage(msg, isClaudeTarget(this.baseUrl, options.model || this.defaultModel));
      if (converted) {
        convertedMessages.push(converted);
      }
    }

    // 合并转换后连续的 user 消息 (特别是 tool_result)
    // Anthropic API 要求 user/assistant 消息必须交替出现
    const mergedMessages = this.mergeConsecutiveUserMessages(convertedMessages); hoistToolResultImagesForDeepSeek(mergedMessages, this.baseUrl, options.model || this.defaultModel);

    // 验证并修复 tool_result / tool_use 配对
    // Anthropic API 要求每个 tool_result 必须有前一条 assistant 消息中对应的 tool_use
    const validatedMessages = this.validateToolResultPairs(mergedMessages);

    const anthropicMessages = validatedMessages;

    // Ensure first message is from user (Anthropic requirement)
    if (anthropicMessages.length > 0 && anthropicMessages[0].role !== 'user') {
      anthropicMessages.unshift({
        role: 'user',
        content: [{ type: 'text', text: '...' }],
      });
    }

    // 代理模式和官方 API 模式：为消息添加 cache_control（匹配 Claude Code 格式）
    // 给最后一个 tool_result block 添加 cache_control
    // 注意：某些代理可能会自动添加 cache_control，通过 disableCaching 配置禁用
    if (anthropicMessages.length > 0 && !options.disableCaching) {
      this.addMessageCacheControl(anthropicMessages);
    }
    this.stripCacheReferences(anthropicMessages);

    const system = systemParts.length > 0 ? systemParts.join('\n\n') : null;
    return { system, anthropicMessages };
  }

  private addMessageCacheControl(messages: any[]): void {
    let lastToolResultFound = false;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;

      for (let j = msg.content.length - 1; j >= 0; j--) {
        const block = msg.content[j];
        if (!lastToolResultFound && block.type === 'tool_result') {
          block.cache_control = { type: 'ephemeral' };
          lastToolResultFound = true;
          this.debugLog('Added cache_control to tool_result', { tool_use_id: block.tool_use_id });
          break;
        }
      }
      if (lastToolResultFound) break;
    }

    if (!lastToolResultFound) {
      this.addTextBlockCacheControl(messages);
    }
  }

  /* 官方 Anthropic API 前净化残留 cache_reference. 覆盖两个来源:
   *   1) 修 gate 前老代码留下的 in-memory session state (最常见 — 用户"继续"就中招)
   *   2) 未来任意路径不小心加进来 (defense in depth) */
  private stripCacheReferences(messages: any[]): number {
    let stripped = 0;
    for (const msg of messages) {
      if (!msg || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block && typeof block === 'object' && 'cache_reference' in block) {
          delete block.cache_reference;
          stripped += 1;
        }
      }
    }
    if (stripped > 0) {
      this.debugLog('Stripped cache_reference from tool_result blocks for official API', { stripped });
    }
    return stripped;
  }

  private addCacheReferencesBeforeBreakpoint(messages: any[]): void {
    let lastCacheControlMessageIndex = -1;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!Array.isArray(msg.content)) continue;
      if (msg.content.some((block: any) => block && typeof block === 'object' && block.cache_control)) {
        lastCacheControlMessageIndex = i;
      }
    }

    if (lastCacheControlMessageIndex <= 0) return;

    let attachedCount = 0;
    for (let i = 0; i < lastCacheControlMessageIndex; i++) {
      const msg = messages[i];
      if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;

      for (const block of msg.content) {
        if (block?.type === 'tool_result' && block.tool_use_id && !block.cache_reference) {
          block.cache_reference = block.tool_use_id;
          attachedCount += 1;
        }
      }
    }

    if (attachedCount > 0) {
      this.debugLog('Added cache_reference to cached tool results', {
        lastCacheControlMessageIndex,
        attachedCount,
      });
    }
  }

  private addTextBlockCacheControl(messages: any[]): void {
    // 从后往前找最后一条 user 消息
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== 'user') continue;

      if (Array.isArray(msg.content)) {
        // 数组格式，找最后一个 text block
        for (let j = msg.content.length - 1; j >= 0; j--) {
          if (msg.content[j].type === 'text') {
            msg.content[j].cache_control = { type: 'ephemeral' };
            this.debugLog('Added cache_control to user text block');
            return;
          }
        }
      }
      // 注意：如果是纯字符串格式，无法添加 cache_control
      // 这是符合预期的，因为真实 Claude Code 请求中简单消息就是字符串
    }
  }

  /**
   * 验证并修复 tool_result / tool_use 配对
   * 确保：
   * 1. 每个 tool_result 都有前一条 assistant 消息中对应的 tool_use
   * 2. 每个 tool_use 都有下一条 user 消息中对应的 tool_result
   * 移除孤立的 tool_result 和 tool_use
   */
  private validateToolResultPairs(messages: any[]): any[] {
    // 第一遍：收集所有 tool_use ids 和 tool_result ids
    const allToolUseIds = new Set<string>();
    const allToolResultIds = new Set<string>();

    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue;

      for (const block of msg.content) {
        if (block.type === 'tool_use' && block.id) {
          allToolUseIds.add(block.id);
        }
        if (block.type === 'tool_result' && block.tool_use_id) {
          allToolResultIds.add(block.tool_use_id);
        }
      }
    }

    // 找出有配对的 tool ids（同时存在于 tool_use 和 tool_result 中）
    const pairedToolIds = new Set<string>();
    for (const id of allToolUseIds) {
      if (allToolResultIds.has(id)) {
        pairedToolIds.add(id);
      }
    }

    this.debugLog('Tool pairing analysis', {
      toolUseCount: allToolUseIds.size,
      toolResultCount: allToolResultIds.size,
      pairedCount: pairedToolIds.size,
      orphanToolUseIds: Array.from(allToolUseIds).filter(id => !pairedToolIds.has(id)),
      orphanToolResultIds: Array.from(allToolResultIds).filter(id => !pairedToolIds.has(id)),
    });

    // 第二遍：过滤消息，只保留有配对的 tool_use 和 tool_result
    const result: any[] = [];

    for (const msg of messages) {
      if (!Array.isArray(msg.content)) {
        result.push(msg);
        continue;
      }

      const filteredContent = msg.content.filter((block: any) => {
        // 过滤孤立的 tool_use
        if (block.type === 'tool_use') {
          const isPaired = pairedToolIds.has(block.id);
          if (!isPaired) {
            this.debugLog('Removing orphan tool_use', { id: block.id });
          }
          return isPaired;
        }

        // 过滤孤立的 tool_result
        if (block.type === 'tool_result') {
          const isPaired = pairedToolIds.has(block.tool_use_id);
          if (!isPaired) {
            this.debugLog('Removing orphan tool_result', { tool_use_id: block.tool_use_id });
          }
          return isPaired;
        }

        // 保留其他内容（text, thinking 等）
        return true;
      });

      // 只有当还有内容时才添加消息
      if (filteredContent.length > 0) {
        result.push({ ...msg, content: filteredContent });
      } else {
        this.debugLog('Skipping empty message after tool pairing filter', { role: msg.role });
      }
    }

    return result;
  }

  /**
   * 合并转换后连续的 user 消息
   * 当多个 tool_result 连续出现时，它们都被转换为 role: 'user'
   * Anthropic API 要求消息必须 user/assistant 交替，所以需要合并
   */
  private mergeConsecutiveUserMessages(messages: any[]): any[] {
    if (messages.length === 0) return [];

    const merged: any[] = [];

    for (const msg of messages) {
      const lastMsg = merged[merged.length - 1];

      // 如果当前是 user 消息，且上一个也是 user 消息，合并 content
      if (lastMsg && lastMsg.role === 'user' && msg.role === 'user') {
        // 确保 content 都是数组格式
        const lastContent = Array.isArray(lastMsg.content) ? lastMsg.content : [{ type: 'text', text: lastMsg.content }];
        const currentContent = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }];
        lastMsg.content = [...lastContent, ...currentContent];
      } else {
        merged.push(msg);
      }
    }

    moveToolResultsFirst(merged); // tool_result 必须排在 user 消息最前面, 见 anthropicMessageCompat
    return merged;
  }

  private convertSingleMessage(msg: Message, claudeTarget = true): any | null {
    if (msg.role === 'tool') {
      if (Array.isArray(msg.content) && msg.content.some((p: any) => p?.type === 'image_url')) {
        const contentBlocks: any[] = [];
        for (const part of msg.content as any[]) {
          if (part?.type === 'text') {
            contentBlocks.push({ type: 'text', text: part.text });
          } else if (part?.type === 'image_url') {
            const imageBlock = this.convertImageUrl(part.image_url.url);
            if (imageBlock) contentBlocks.push(imageBlock);
          }
        }
        return {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: msg.tool_call_id,
            content: contentBlocks,
          }],
        };
      }

      // 使用 Codex 风格的截断策略处理 tool_result
      // 防止大型工具输出导致 context 爆炸
      const rawContent = getTextFromContent(msg.content);
      const truncatedContent = truncateToolOutput(rawContent, WIRE_TOOL_OUTPUT_MAX_UNITS);

      if (rawContent.length !== truncatedContent.length) {
        this.debugLog('Tool output truncated', {
          tool_call_id: msg.tool_call_id,
          original: rawContent.length,
          truncated: truncatedContent.length,
        });
      }

      return {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.tool_call_id,
          content: truncatedContent,
        }],
      };
    }

    if (msg.role === 'assistant') {
      const content: any[] = [];

      // 处理 thinking/reasoning content（必须在最前面）
      // 当 thinking 启用时，Anthropic 要求 assistant 消息以 thinking block 开头
      //
      // 1. thinking blocks 必须保持原样，不能被修改
      // 2. 如果原始响应包含 thinking blocks，必须原样传递
      // 3. 我们在 runner.ts 存储时已经过滤了无效的 thinking blocks
      // 4. 这里直接使用存储的 thinking_blocks，完全不修改
      let hasThinkingBlocks = false;
      const replayable = keepReplayableThinking(msg.thinking_blocks ?? [], claudeTarget); // Claude 丢别家签名
      if (replayable.length > 0) {
        hasThinkingBlocks = true;
        for (const block of replayable) {
          if (block.type === 'thinking') {
            // 完全保留原始数据，包括可能为空的字段
            const thinkingBlock: any = {
              type: 'thinking',
              thinking: block.thinking,
            };
            // 只有当 signature 存在时才添加（不设置默认值）
            if (block.signature !== undefined) {
              thinkingBlock.signature = block.signature;
            }
            content.push(thinkingBlock);
          } else if (block.type === 'redacted_thinking') {
            const redactedBlock: any = {
              type: 'redacted_thinking',
            };
            // 只有当 data 存在时才添加
            if (block.data !== undefined) {
              redactedBlock.data = block.data;
            }
            content.push(redactedBlock);
          }
        }
      }
      // 注意：不再使用 reasoning_content 作为回退创建 thinking block
      // 因为没有 signature 的 thinking block 会导致 API 错误
      // reasoning_content 仅用于 UI 显示，不参与 API 传递 —— 只对 Claude 成立, 非 Claude 见 vendorThinkingFallback
      else if (vendorThinkingFallback(msg, claudeTarget)) content.push(vendorThinkingFallback(msg, claudeTarget));

      const textContent = getTextFromContent(msg.content);
      if (textContent) {
        const trimmedText = textContent.trimEnd();
        content.push({ type: 'text', text: trimmedText || '.' });
      }
      // Claude API 要求：
      // 1. final block cannot be thinking
      // 2. final content cannot end with trailing whitespace
      // 所以用 "." 而不是空格
      else if (hasThinkingBlocks) {
        content.push({ type: 'text', text: '.' });
        this.debugLog('Added placeholder text after thinking (no text content)');
      }

      if (msg.tool_calls) {
        for (const toolCall of msg.tool_calls) {
          const rawArgs = (toolCall.function.arguments || '').trim();
          let parsedArgs: any = {};

          if (rawArgs.length > 0) {
            try {
              parsedArgs = JSON.parse(rawArgs);
            } catch {
              this.debugLog('Failed to parse tool arguments', {
                tool: toolCall.function.name
              });
            }
          }

          // 在代理模式下，将工具名转换为 Claude Code 格式
          const claudeCodeName = this.isProxyMode
            ? (TOOL_NAME_TO_CLAUDE_CODE[toolCall.function.name] || this.toClaudeCodeToolName(toolCall.function.name))
            : toolCall.function.name;

          content.push({
            type: 'tool_use',
            id: toolCall.id,
            name: claudeCodeName,
            input: parsedArgs,
          });
        }
      }

      // Claude API 要求：The final block in an assistant message cannot be `thinking`
      // 这个检查必须在所有内容添加完成之后执行
      if (content.length > 0) {
        const lastBlock = content[content.length - 1];
        this.debugLog('Assistant message final check', {
          contentLength: content.length,
          lastBlockType: lastBlock.type,
          hasThinkingBlocks,
          blockTypes: content.map(b => b.type),
          lastBlockTextPreview: lastBlock.type === 'text' ? (lastBlock.text || '').substring(0, 50) : undefined,
        });

        // 检查是否以 thinking 结尾
        if (lastBlock.type === 'thinking' || lastBlock.type === 'redacted_thinking') {
          content.push({ type: 'text', text: '.' });
          this.debugLog('Fixed: Added text block after thinking');
        }
        // 确保 text block 有实际内容
        else if (lastBlock.type === 'text' && (!lastBlock.text || !lastBlock.text.trim())) {
          // 检查是否有 thinking blocks
          const hasThinking = content.some(b => b.type === 'thinking' || b.type === 'redacted_thinking');
          if (hasThinking) {
            lastBlock.text = '.'; // 使用 '.' 而非空格 - API 不允许尾部空白
            this.debugLog('Fixed: Ensured text block has content after thinking');
          }
        }
      }

      return content.length > 0 ? { role: 'assistant', content } : null;
    }

    // User message - 匹配 Claude Code 格式
    // 真实 Claude Code 请求中，简单 user 消息是纯字符串，多模态内容才是数组
    if (Array.isArray(msg.content)) {
      // 检查是否只有一个纯文本内容
      const textParts = msg.content.filter(p => p.type === 'text');
      const hasNonText = msg.content.some(p => p.type !== 'text');

      if (!hasNonText && textParts.length === 1) {
        // 只有一个文本部分，使用纯字符串格式
        const text = (textParts[0] as { type: 'text'; text: string }).text;
        return text.trim() ? { role: 'user', content: text } : null;
      }

      // 多模态或多个内容块，使用数组格式
      const anthropicContent = this.convertMultimodalContent(msg.content);
      return anthropicContent.length > 0
        ? { role: 'user', content: anthropicContent }
        : null;
    }

    const textContent = getTextFromContent(msg.content);
    if (!textContent.trim()) return null;

    // 简单 user 消息使用纯字符串格式（匹配真实 Claude Code 请求）
    return {
      role: 'user',
      content: textContent,
    };
  }

  private convertMultimodalContent(content: MessageContentPart[]): any[] {
    const result: any[] = [];

    for (const part of content) {
      if (part.type === 'text') {
        result.push({ type: 'text', text: part.text });
      } else if (part.type === 'image_url') {
        const imageBlock = this.convertImageUrl(part.image_url.url);
        if (imageBlock) {
          result.push(imageBlock);
        }
      }
    }

    return result;
  }

  private convertImageUrl(rawUrl: string): any | null {
    /* 裸 base64 (没有 data: 前缀) 在这条线上更阴 —— 下面两个分支都不命中, 返回 null,
     * 图被**静默丢掉**: 模型没看见却照样回答。先归一, 见 imageUrlNormalize 文件头。 */
    const url = normalizeImageUrl(rawUrl);
    if (url.startsWith('data:')) {
      const match = url.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        return {
          type: 'image',
          source: {
            type: 'base64',
            media_type: match[1],
            data: match[2],
          },
        };
      }
    } else {
      return {
        type: 'image',
        source: {
          type: 'url',
          url: url,
        },
      };
    }
    return null;
  }

  /**
   * 规范化消息列表：过滤空消息，保留原始顺序。
   */
  private normalizeMessages(messages: Message[]): Message[] {
    const nonEmptyMessages = messages.filter(msg => {
      const hasToolCalls = msg.role === 'assistant' && !!(msg.tool_calls && msg.tool_calls.length > 0);
      const hasThinkingBlocks = msg.role === 'assistant' && !!(msg.thinking_blocks && msg.thinking_blocks.length > 0);
      if (hasToolCalls || hasThinkingBlocks) return true;
      if (!msg.content) return false;
      if (typeof msg.content === 'string') return msg.content.trim().length > 0;
      if (Array.isArray(msg.content)) return msg.content.length > 0;
      return true;
    });

    if (nonEmptyMessages.length === 0) return [];

    this.validateMessageAlternation(nonEmptyMessages);

    return nonEmptyMessages;
  }

  /**
   * 验证消息交替（仅用于调试日志，不修改数据）
   */
  private validateMessageAlternation(messages: Message[]): void {
    const nonSystemMessages = messages.filter(m => m.role !== 'system');
    let hasAlternationError = false;

    for (let i = 1; i < nonSystemMessages.length; i++) {
      if (nonSystemMessages[i].role === nonSystemMessages[i - 1].role) {
        hasAlternationError = true;
        this.debugLog('Message alternation warning', {
          index: i,
          prevRole: nonSystemMessages[i - 1].role,
          currentRole: nonSystemMessages[i].role,
        });
      }
    }

    if (!hasAlternationError && nonSystemMessages.length > 1) {
      this.debugLog('Message alternation OK', {
        messageCount: nonSystemMessages.length,
        roles: nonSystemMessages.map(m => m.role),
      });
    }
  }

  // ==========================================================================
  // Response Conversion
  // ==========================================================================

  private convertResponse(anthropicResponse: any): ChatCompletionResponse {
    this.debugLog('Raw response', anthropicResponse);

    const content = anthropicResponse.content || [];
    let textContent = '';
    const toolCalls: any[] = [];
    let reasoningContent = '';

    for (const block of content) {
      if (block.type === 'text') {
        textContent += block.text;
      } else if (block.type === 'tool_use') {
        // 将 Claude Code 工具名转换回我们的工具名
        const originalName = this.isProxyMode
          ? (CLAUDE_CODE_TO_TOOL_NAME[block.name] || this.fromClaudeCodeToolName(block.name))
          : block.name;
        const tc = fromClaudeToolUse({
          type: 'tool_use',
          id: block.id,
          name: originalName,
          input: block.input as Record<string, unknown> | undefined,
        });
        if (tc) toolCalls.push(tc);
      } else if (block.type === 'thinking') {
        reasoningContent = block.thinking || '';
      }
    }

    const usage = this.buildUsageFromRaw(anthropicResponse.usage);

    return {
      id: anthropicResponse.id,
      choices: [{
        message: {
          role: 'assistant' as const,
          content: textContent || '',
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
        },
        finish_reason: this.convertStopReason(anthropicResponse.stop_reason),
      }],
      usage,
    };
  }

  private buildUsageFromRaw(rawUsage: any): AnthropicUsage {
    if (!rawUsage) {
      return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    }

    const usage: AnthropicUsage = {
      prompt_tokens: rawUsage.input_tokens || 0,
      completion_tokens: rawUsage.output_tokens || 0,
      total_tokens: (rawUsage.input_tokens || 0) + (rawUsage.output_tokens || 0),
    };

    // Cache information
    if (rawUsage.cache_read_input_tokens) {
      usage.cache_read_input_tokens = rawUsage.cache_read_input_tokens;
    }
    if (rawUsage.cache_creation_input_tokens) {
      usage.cache_creation_input_tokens = rawUsage.cache_creation_input_tokens;
    }

    // Extended cache info
    if (rawUsage.cache_creation) {
      if (rawUsage.cache_creation.ephemeral_5m_input_tokens) {
        usage.cache_creation_5m_tokens = rawUsage.cache_creation.ephemeral_5m_input_tokens;
      }
      if (rawUsage.cache_creation.ephemeral_1h_input_tokens) {
        usage.cache_creation_1h_tokens = rawUsage.cache_creation.ephemeral_1h_input_tokens;
      }
    }

    return usage;
  }

  private convertStopReason(stopReason: string): string {
    switch (stopReason) {
      case 'end_turn': return 'stop';
      case 'stop_sequence': return 'stop';
      case 'max_tokens': return 'length';
      case 'model_context_window_exceeded': return 'length';
      case 'tool_use': return 'tool_calls';
      case 'refusal': return 'content_filter';
      default: return 'stop';
    }
  }

  // ==========================================================================
  // Stream Event Handling — index 寻址折叠 (fold), 对齐官方 SDK 语义
  // ==========================================================================

  /**
   * 把单个 SSE 事件折叠进 index 寻址的 state, 返回需要 emit 给消费端的增量 chunk。
   * 不做任何"块顺序 / 计数配平"假设 —— 所有内容按协议自带的 content block `index` 归位。
   */
  private reduceAnthropicStreamEvent(
    event: any,
    state: AnthropicStreamState
  ): { yields: any[] } {
    const yields: any[] = [];

    switch (event.type) {
      case 'message_start': {
        this.debugLog('message_start usage', event.message?.usage);
        if (event.message?.usage) state.usage = event.message.usage;
        // yield message_start 让 watchdog 切到 idle 超时, 避免 extended thinking 阶段误判 first_chunk 超时
        yields.push({ type: 'message_start', message: { id: event.message?.id, model: event.message?.model } });
        break;
      }

      case 'content_block_start': {
        const i = typeof event.index === 'number' ? event.index : state.blocks.size;
        const cb = event.content_block || {};
        const t: AnthropicBlockKind =
          cb.type === 'text' || cb.type === 'thinking' || cb.type === 'redacted_thinking' || cb.type === 'tool_use'
            ? cb.type : 'other';

        if (t === 'tool_use') {
          const toolIndex = state.nextToolIndex++;
          // 代理模式下把 Claude Code 工具名映射回我们的工具名
          const originalName = this.isProxyMode
            ? (CLAUDE_CODE_TO_TOOL_NAME[cb.name] || this.fromClaudeCodeToolName(cb.name))
            : cb.name;
          // 统一走 normalizer 起 frame (跟非流式 chat() 同源), input 为空对象时 trim 回 '' 让 delta 增量追加
          const initialBlock = fromClaudeToolUse({
            type: 'tool_use',
            id: cb.id,
            name: originalName,
            input: cb.input as Record<string, unknown> | undefined,
          });
          const initialArgsRaw = initialBlock?.function.arguments ?? '';
          const args = initialArgsRaw === '{}' ? '' : initialArgsRaw;
          const toolId = initialBlock?.id ?? cb.id;

          state.blocks.set(i, { index: i, kind: 'tool_use', closed: false, toolIndex, toolId, toolName: originalName, args });
          state.toolCalls.push({ index: toolIndex, id: toolId, type: 'function', function: { name: originalName, arguments: args } });

          yields.push({
            choices: [{
              delta: { tool_calls: [{ index: toolIndex, id: cb.id, type: 'function', function: { name: originalName } }] },
              index: 0,
            }],
          });
        } else if (t === 'text') {
          state.blocks.set(i, { index: i, kind: 'text', closed: false });
          if (!state.roleSent) {
            state.roleSent = true;
            yields.push({ choices: [{ delta: { role: 'assistant' }, index: 0 }] });
          }
        } else if (t === 'thinking') {
          state.blocks.set(i, { index: i, kind: 'thinking', closed: false, thinking: '', signature: '' });
        } else if (t === 'redacted_thinking') {
          // redacted_thinking 在 start 时就带完整 data, 直接标记已关闭
          state.blocks.set(i, { index: i, kind: 'redacted_thinking', closed: true, data: cb.data });
        } else {
          state.blocks.set(i, { index: i, kind: 'other', closed: false });
        }
        break;
      }

      case 'content_block_delta': {
        const i = typeof event.index === 'number' ? event.index : this.lastOpenBlockIndex(state);
        const d = event.delta || {};
        let blk = state.blocks.get(i);

        if (d.type === 'text_delta') {
          // 容错: delta 先于 start 到达 (罕见) 也按 index 懒建块, 不抛错
          if (!blk) { blk = { index: i, kind: 'text', closed: false }; state.blocks.set(i, blk); }
          yields.push({ choices: [{ delta: { content: d.text || '' }, index: 0 }] });
        } else if (d.type === 'input_json_delta') {
          if (!blk || blk.kind !== 'tool_use') blk = this.findToolBlock(state, i);
          if (blk && blk.kind === 'tool_use') {
            const piece = d.partial_json || '';
            blk.args = (blk.args || '') + piece;
            const tc = state.toolCalls.find(t => t.index === blk!.toolIndex);
            if (tc) tc.function.arguments += piece;
            yields.push({
              choices: [{
                delta: { tool_calls: [{ index: blk.toolIndex, function: { arguments: piece } }] },
                index: 0,
              }],
            });
          } else {
            // 没有任何 tool_use 块能承接的 input_json — 无法凭空造工具名, 记录后丢弃 (真实 provider 不会走到)
            this.debugLog('input_json_delta with no tool_use block to attach', { index: i });
          }
        } else if (d.type === 'thinking_delta') {
          if (!blk) { blk = { index: i, kind: 'thinking', closed: false, thinking: '', signature: '' }; state.blocks.set(i, blk); }
          if (blk.kind === 'thinking') blk.thinking = (blk.thinking || '') + (d.thinking || '');
          yields.push({ choices: [{ delta: { reasoning_content: d.thinking }, index: 0 }] });
        } else if (d.type === 'signature_delta') {
          if (blk && blk.kind === 'thinking') blk.signature = (blk.signature || '') + (d.signature || '');
        }
        break;
      }

      case 'content_block_stop': {
        const i = typeof event.index === 'number' ? event.index : this.lastOpenBlockIndex(state);
        for (const chunk of this.closeBlock(state, i)) yields.push(chunk);
        break;
      }

      case 'message_delta': {
        // 兼容标准 (event.delta.stop_reason) 与代理顶层 (event.stop_reason)
        const sr = event.delta?.stop_reason || event.stop_reason;
        if (sr) state.stopReason = sr;
        // usage 增量合并 (message_delta 通常只带 output_tokens, 不能覆盖 cache_read 等字段)
        if (event.usage) state.usage = state.usage ? { ...state.usage, ...event.usage } : event.usage;
        break;
      }

      case 'message_stop':
        this.debugLog('Message stop received');
        state.messageStopReceived = true;
        break;

      case 'ping':
        break;

      case 'error': {
        const err = new Error(event.error?.message || 'Stream error') as RetryableStreamError;
        // 上游流内 error 事件 → 冒泡到外层重试/上屏逻辑, 不吞
        err.code = event.error?.type || 'STREAM_ERROR';
        throw err;
      }

      default: {
        // 兼容非标准结束事件 & 任意藏在未知事件里的 stop_reason
        const et = (event.type || '').toLowerCase();
        if (et === 'done' || et === 'stream_end' || et === 'end') {
          this.debugLog('Alternative message stop received', { type: event.type });
          state.messageStopReceived = true;
          break;
        }
        const anySr = event.stop_reason || event.delta?.stop_reason;
        if (anySr) {
          this.debugLog('stop_reason found in unknown event', { type: event.type, stopReason: anySr });
          state.stopReason = anySr;
        } else {
          this.debugLog('Unknown event type', { type: event.type });
        }
        break;
      }
    }

    return { yields };
  }

  /**
   * 结算一个 content block (幂等): thinking 补发 reasoning_complete, tool_use 校验/自愈 JSON 参数。
   * 已关闭的块直接返回空。找不到块也不抛 —— 漏发 stop / 重复 stop 都安全。
   */
  private closeBlock(state: AnthropicStreamState, index: number): any[] {
    const blk = state.blocks.get(index);
    if (!blk || blk.closed) return [];
    blk.closed = true;

    if (blk.kind === 'thinking') {
      return [{ choices: [{ delta: { reasoning_complete: true }, index: 0 }] }];
    }
    if (blk.kind === 'tool_use') {
      const tc = state.toolCalls.find(t => t.index === blk.toolIndex);
      const args = tc?.function?.arguments;
      if (tc && typeof args === 'string' && args.trim()) {
        try {
          JSON.parse(args);
        } catch {
          const fixed = this.tryFixJson(args);
          if (fixed) {
            tc.function.arguments = fixed;
            this.debugLog('Auto-fixed tool arguments on block close', { tool: tc.function.name });
          } else {
            this.debugLog('Invalid tool arguments JSON (left as-is for consumer self-heal)', { tool: tc.function.name });
          }
        }
      }
    }
    return [];
  }

  /** 事件没带 index 时的兜底: 取最后一个仍开着的块 index (顺序帧下即"当前块")。 */
  private lastOpenBlockIndex(state: AnthropicStreamState): number {
    let best = -1;
    for (const [idx, b] of state.blocks) {
      if (!b.closed && idx > best) best = idx;
    }
    if (best >= 0) return best;
    let max = 0;
    for (const idx of state.blocks.keys()) if (idx > max) max = idx;
    return max;
  }

  private findToolBlock(state: AnthropicStreamState, preferIndex: number): AnthropicBlockAcc | undefined {
    const at = state.blocks.get(preferIndex);
    if (at && at.kind === 'tool_use') return at;
    const open: AnthropicBlockAcc[] = [];
    for (const b of state.blocks.values()) {
      if (b.kind === 'tool_use' && !b.closed) open.push(b);
    }
    if (open.length === 1) return open[0];
    if (open.length > 1) {
      cliLogger.warn(
        'Anthropic',
        `input_json_delta 的 index=${preferIndex} 没有对应的 tool_use 块, 且同时有 ${open.length} 个未关闭的 tool_use `
        + '—— 无法确定归属, 丢弃这一片以免污染其它工具的参数 (猜错会同时毁掉两个调用)',
      );
    }
    return undefined;
  }

  private tryFixJson(json: string): string | null {
    // Try adding closing brace
    let fixed = json.trim();
    if (!fixed.endsWith('}')) {
      fixed += '}';
      try {
        JSON.parse(fixed);
        return fixed;
      } catch { }
    }

    // Try removing trailing comma
    fixed = json.replace(/,\s*$/, '');
    if (!fixed.endsWith('}')) fixed += '}';
    try {
      JSON.parse(fixed);
      return fixed;
    } catch { }

    // Force close all structures
    let braceCount = 0;
    let bracketCount = 0;
    let inString = false;
    let escapeNext = false;

    for (const char of json) {
      if (escapeNext) { escapeNext = false; continue; }
      if (char === '\\') { escapeNext = true; continue; }
      if (char === '"') { inString = !inString; continue; }
      if (!inString) {
        if (char === '{') braceCount++;
        else if (char === '}') braceCount--;
        else if (char === '[') bracketCount++;
        else if (char === ']') bracketCount--;
      }
    }

    fixed = json;
    if (inString) fixed += '"';
    while (bracketCount > 0) { fixed += ']'; bracketCount--; }
    while (braceCount > 0) { fixed += '}'; braceCount--; }

    try {
      JSON.parse(fixed);
      return fixed;
    } catch {
      return null;
    }
  }

  // ==========================================================================
  // Tool Handling
  // ==========================================================================

  private transformToolDefinition(tool: Tool): any {
    // 在代理模式下，将工具名转换为 Claude Code 格式
    const claudeCodeName = this.isProxyMode
      ? (TOOL_NAME_TO_CLAUDE_CODE[tool.name] || this.toClaudeCodeToolName(tool.name))
      : tool.name;

    // 代理模式下，需要移除 input_schema 中 properties 字段的 description
    // 因为真正的 Claude Code 工具定义中没有这些 description
    if (this.isProxyMode) {
      const cleanedSchema = this.stripSchemaPropertyDescriptions(tool.parameters);
      return {
        name: claudeCodeName,
        description: tool.description,
        input_schema: cleanedSchema,
      };
    }

    if (!this.sanitizeToolsForProxy) {
      return {
        name: claudeCodeName,
        description: tool.description,
        input_schema: tool.parameters,
      };
    }

    // Sanitize for strict proxies
    const description = this.truncateDescription(tool.description || tool.name);
    const inputSchema = this.stripSchemaDescriptions(tool.parameters);

    return {
      name: claudeCodeName,
      description,
      input_schema: inputSchema,
    };
  }

  /**
   * 移除 schema properties 中的 description 字段（保留顶层结构）
   * Claude Code 的工具定义中，properties 内部没有 description
   */
  private stripSchemaPropertyDescriptions(schema: any): any {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) {
      return schema.map(item => this.stripSchemaPropertyDescriptions(item));
    }

    const clone: Record<string, any> = { ...schema };

    // 对于 properties 内部的每个字段，移除 description
    if (clone.properties && typeof clone.properties === 'object') {
      const cleanedProps: Record<string, any> = {};
      for (const [key, value] of Object.entries(clone.properties)) {
        if (value && typeof value === 'object') {
          const propClone: Record<string, any> = { ...(value as object) };
          delete propClone.description; // 移除属性级别的 description
          // 递归处理嵌套对象
          if (propClone.properties) {
            propClone.properties = this.stripSchemaPropertyDescriptions({ properties: propClone.properties }).properties;
          }
          if (propClone.items) {
            propClone.items = this.stripSchemaPropertyDescriptions(propClone.items);
          }
          cleanedProps[key] = propClone;
        } else {
          cleanedProps[key] = value;
        }
      }
      clone.properties = cleanedProps;
    }

    // 递归处理 items (数组类型)
    if (clone.items) {
      clone.items = this.stripSchemaPropertyDescriptions(clone.items);
    }

    // 递归处理 oneOf, anyOf, allOf
    for (const key of ['oneOf', 'anyOf', 'allOf']) {
      if (clone[key] && Array.isArray(clone[key])) {
        clone[key] = clone[key].map((item: any) => this.stripSchemaPropertyDescriptions(item));
      }
    }

    return clone;
  }

  /**
   * 将 snake_case 工具名转换为 PascalCase (Claude Code 格式)
   * 例如: readfile -> Read, execute_shell -> ExecuteShell
   */
  private toClaudeCodeToolName(name: string): string {
    return name
      .split('_')
      .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join('');
  }

  /**
   * 将 PascalCase 工具名转换回 snake_case
   * 例如: Read -> readfile, ExecuteShell -> execute_shell
   * 同时清理可能的畸形字符（如流中断导致的 " /> 等）
   */
  private fromClaudeCodeToolName(name: string): string {
    // 清理可能的畸形字符（流中断可能导致工具名包含额外字符）
    const cleanName = name.replace(/["\s/>]+$/g, '').trim();

    return cleanName
      .replace(/([A-Z])/g, '_$1')
      .toLowerCase()
      .replace(/^_/, '');
  }

  private truncateDescription(text: string | undefined): string {
    if (!text) return 'Utility tool';
    const singleLine = text.replace(/\s+/g, ' ').trim();
    if (!singleLine) return 'Utility tool';
    return singleLine.length > 120 ? `${singleLine.slice(0, 117)}...` : singleLine;
  }

  private stripSchemaDescriptions(schema: any): any {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) {
      return schema.map(item => this.stripSchemaDescriptions(item));
    }

    const clone: Record<string, any> = { ...schema };
    delete clone.description;

    if (clone.properties && typeof clone.properties === 'object') {
      const sanitizedProps: Record<string, any> = {};
      for (const [key, value] of Object.entries(clone.properties)) {
        sanitizedProps[key] = this.stripSchemaDescriptions(value);
      }
      clone.properties = sanitizedProps;
    }

    for (const key of ['items', 'oneOf', 'anyOf', 'allOf']) {
      if (clone[key]) {
        clone[key] = Array.isArray(clone[key])
          ? clone[key].map((item: any) => this.stripSchemaDescriptions(item))
          : this.stripSchemaDescriptions(clone[key]);
      }
    }

    return clone;
  }

  // ==========================================================================
  // Headers & Authentication
  // ==========================================================================

  private buildHeaders(helperMethod: 'stream' | 'create' = 'stream'): Record<string, string> {
    if (this.isProxyMode) {
      return this.buildClaudeCodeHeaders(helperMethod);
    }
    return this.buildOfficialHeaders();
  }

  private buildOfficialHeaders(): Record<string, string> {
    return {
      ...buildAnthropicAuthHeaders(this.authToken),
      'anthropic-version': ANTHROPIC_VERSION,
      'Content-Type': 'application/json',
      'User-Agent': getNeoxUserAgent(),
      'Accept-Encoding': 'identity', ...anthropicSessionHeaders(this),
    };
  }

  private buildClaudeCodeHeaders(helperMethod: 'stream' | 'create' = 'stream'): Record<string, string> {
    return {
      ...buildClaudeCodeTransportHeaders({
        authToken: this.authToken,
        betaFeatures: this.betaFeatures,
        helperMethod,
      }),
      'Accept-Encoding': 'identity', ...anthropicSessionHeaders(this),
    };
  }

  // ==========================================================================
  // User ID & PII Handling
  // ==========================================================================

  private generateSafeUserId(): string {
    if (this.isProxyMode) {
      // 代理模式：使用 Claude Code 完整格式 (123 字符)
      // 格式: user_<64字符hex>_account__session_<uuid>
      const randomHex = randomBytes(32).toString('hex'); // 64 chars
      const uuid = this.generateUUID();
      return `user_${randomHex}_account__session_${uuid}`;
    }

    // 官方 API 模式：使用安全的短格式 (<= 64 字符)
    const randomHex = randomBytes(16).toString('hex'); // 32 chars
    const sessionSuffix = randomBytes(4).toString('hex'); // 8 chars
    return `user_${randomHex}_session_${sessionSuffix}`; // 52 chars
  }

  private generateUUID(): string {
    // 生成 UUID v4 格式
    const bytes = randomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  private sanitizeUserId(userId: string): string {
    // 代理模式下不做长度限制，使用完整的 Claude Code 格式
    if (this.isProxyMode) {
      // 只检查 PII，不限制长度
      if (/^[\w.+-]+@[\w.-]+\.\w+$/.test(userId)) {
        // 如果是邮箱，生成 Claude Code 格式的 user_id
        const hash = createHash('sha256').update(userId).digest('hex');
        const uuid = this.generateUUID();
        return `user_${hash}_account__session_${uuid}`;
      }
      if (/^\+?[\d\s-]{10,}$/.test(userId)) {
        // 如果是电话号码，生成 Claude Code 格式的 user_id
        const hash = createHash('sha256').update(userId).digest('hex');
        const uuid = this.generateUUID();
        return `user_${hash}_account__session_${uuid}`;
      }
      return userId;
    }

    // 官方 API 模式：限制长度
    if (userId.length > MAX_USER_ID_LENGTH) {
      return createHash('sha256').update(userId).digest('hex').slice(0, MAX_USER_ID_LENGTH);
    }

    // Check for PII (email)
    if (/^[\w.+-]+@[\w.-]+\.\w+$/.test(userId)) {
      return createHash('sha256').update(userId).digest('hex').slice(0, MAX_USER_ID_LENGTH);
    }

    // Check for phone-like patterns
    if (/^\+?[\d\s-]{10,}$/.test(userId)) {
      return createHash('sha256').update(userId).digest('hex').slice(0, MAX_USER_ID_LENGTH);
    }

    return userId;
  }

  // ==========================================================================
  // Error Handling
  // ==========================================================================

  private async normalizeAxiosStreamError(error: any): Promise<void> {
    const data = error?.response?.data;
    if (!data || typeof data !== 'object') return;

    const isReadable = typeof (data as { pipe?: unknown }).pipe === 'function';
    if (!isReadable) return;

    try {
      const raw = await this.readStreamToString(data);
      try {
        error.response.data = JSON.parse(raw);
      } catch {
        error.response.data = raw;
      }
    } catch {
      // Ignore
    }
  }

  private readStreamToString(stream: any): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer | string) => {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      });
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      stream.on('error', reject);
    });
  }

  /**
   * 创建带超时的流迭代器
   * 解决代理服务器不响应导致 CLI 完全卡住的问题
   *
   * 关键问题：`for await (const chunk of stream)` 会阻塞事件循环
   * 当代理连接成功但不发送数据时，整个 Node.js 进程会卡住
   * 即使 stdin 状态正常，键盘输入也无法被处理
   *
   * 解决方案：使用 Promise.race 配合超时，定期让出控制权给事件循环
   */
  private async *createTimeoutStream(
    stream: any,
    signal?: AbortSignal
  ): AsyncGenerator<Buffer> {
    let receivedFirstChunk = false;
    let lastDataTime = Date.now();
    let chunkCount = 0;

    // 设置流的超时处理
    const streamIterator = stream[Symbol.asyncIterator]();

    // This prevents the stream from completely blocking stdin/signal processing
    const yieldToEventLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

    if (process.env.CLI_DEBUG === '1') {
      cliLogger.debug('STREAM', '🌊 Stream processing started');
    }

    while (true) {
      // 检查是否被取消
      if (signal?.aborted) {
        this.debugLog('Stream aborted by signal');
        if (process.env.CLI_DEBUG === '1') {
          cliLogger.debug('STREAM', `⛔ Stream aborted after ${chunkCount} chunks`);
        }
        stream.destroy?.();
        throw new Error('Request aborted');
      }

      // This helps with stdin recovery after window switch (SIGCONT)
      await yieldToEventLoop();

      // 根据是否已收到数据选择不同的超时时间
      const timeout = receivedFirstChunk ? STREAM_IDLE_TIMEOUT : STREAM_FIRST_CHUNK_TIMEOUT;

      // 用于保存定时器引用以便清理
      let timeoutTimer: NodeJS.Timeout | undefined;

      try {
        // This is critical for ESC key responsiveness
        const abortPromise = signal ? new Promise<never>((_, reject) => {
          const abortHandler = () => {
            reject(new Error('Request aborted'));
          };
          if (signal.aborted) {
            // Already aborted - reject immediately
            abortHandler();
          } else {
            signal.addEventListener('abort', abortHandler, { once: true });
          }
        }) : null;

        // 使用 Promise.race 实现超时
        const racingPromises: Promise<any>[] = [
          streamIterator.next(),
          new Promise<{ done: true; value: undefined; timeout: true }>((_, reject) => {
            timeoutTimer = setTimeout(() => {
              reject(new Error(
                receivedFirstChunk
                  ? `Stream idle timeout: no data for ${STREAM_IDLE_TIMEOUT / 1000}s`
                  : `Stream first chunk timeout: no response for ${STREAM_FIRST_CHUNK_TIMEOUT / 1000}s`
              ));
            }, timeout);
          }),
        ];

        // Add abort promise to race if signal exists
        if (abortPromise) {
          racingPromises.push(abortPromise);
        }

        const result = await Promise.race(racingPromises);

        // 清理定时器
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
        }

        if (result.done) {
          if (process.env.CLI_DEBUG === '1') {
            cliLogger.debug('STREAM', `✅ Stream completed successfully (${chunkCount} chunks, ${Date.now() - lastDataTime}ms)`);
          }
          return;
        }

        receivedFirstChunk = true;
        lastDataTime = Date.now();
        chunkCount++;

        if (process.env.CLI_DEBUG === '1' && chunkCount % 100 === 0) {
          cliLogger.debug('STREAM', `📦 Processed ${chunkCount} chunks`);
        }

        yield result.value;
      } catch (error: any) {
        // 清理定时器
        if (timeoutTimer) clearTimeout(timeoutTimer);

        const isAbort = signal?.aborted === true
          || error?.name === 'AbortError'
          || error?.code === 'ERR_CANCELED'
          || error?.message === 'Request aborted';
        this.debugLog('Stream timeout or abort', {
          error: error.message,
          isAbort,
          receivedFirstChunk,
          idleTime: `${(Date.now() - lastDataTime) / 1000}s`,
        });

        // 销毁流
        stream.destroy?.();

        if (isAbort) {
          error.name = 'AbortError';
          error.code = 'ERR_CANCELED';
          error.category = 'canceled';
          throw error;
        }

        /* 走到这里 = 不是取消, 就是"流断了"。真超时 (上面 race 里我们自己抛的那两条) 才打
         * STREAM_TIMEOUT; 连接被重置这类**有自己 code 的**保留原样 (ECONNRESET / EPIPE →
         * classifyError 归 RETRYABLE_NETWORK), 别用超时码盖掉真实原因。两者都可重试。 */
        if (!error.code || /timeout/i.test(String(error?.message ?? ''))) {
          error.code = 'STREAM_TIMEOUT';
        }
        error.isNetworkInterrupt = true;
        throw error;
      }
    }
  }

  // ==========================================================================
  // Logging & Debugging
  // ==========================================================================

  private debugLog(message: string, data?: any): void {
    if (process.env.CLI_DEBUG === '1') {
      cliLogger.debug('Anthropic', data ? `${message} ${JSON.stringify(data, null, 2)}` : message);
    }
  }

  private logRequest(model: string, payload: any, isStream = false): void {
    if (process.env.CLI_DEBUG_PAYLOAD === '1') {
      this.debugLog('Full payload', JSON.stringify(payload, null, 2));
    }

    const apiPath = this.isProxyMode ? '/v1/messages?beta=true' : '/v1/messages';
    const fullUrl = `${this.baseUrl}${apiPath}`;

    // 构建完整的请求头（用于 curl 命令）
    const helperMethod = payload?.stream === false ? 'create' : 'stream';
    const fullHeaders = this.buildHeaders(helperMethod);

    // 打印可复制的 curl 命令（CLI_DEBUG=1 时生效）
    logCurlCommand(fullUrl, fullHeaders, payload);

    const logHeaders = this.isProxyMode
      ? {
        Authorization: 'Bearer ***',
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-beta': this.betaFeatures.join(','),
        'Content-Type': 'application/json',
      }
      : {
        'anthropic-api-key': '***',
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      };

    logger.llmRequest(
      isStream ? 'anthropic-stream' : 'anthropic',
      model,
      payload,
      fullUrl,
      logHeaders
    );

    this.debugLog(`${isStream ? 'Stream ' : ''}Request`, {
      url: fullUrl,
      model,
      isProxyMode: this.isProxyMode,
    });
  }
}

// Export default for backwards compatibility
export default AnthropicProvider;
