/**
 * OpenAI-compatible LLM provider
 *
 * 完整支持:
 * - Chat Completions API (/v1/chat/completions)
 * - Responses API (/v1/responses)
 * - 流式响应 (SSE)
 * - 工具调用 (Function Calling)
 * - 多模态内容 (图片/音频/视频)
 * - PII 字段过滤
 *
 * 参考: reverse/<self-hosted-gateway>-main/dto/openai_request.go
 */

import axios, { type AxiosInstance } from 'axios';
import { headerSafeSessionId } from '../utils/headerSafeSessionId.js';
import { dumpLlmPayloadIfEnabled } from '../utils/payloadDump.js';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire as _createRequire } from 'node:module';
import type { Message, ChatCompletionResponse, Tool, ToolCall, LLMProvider, StructuredOutputDefinition } from '../types/index.js';
import { getTextFromContent } from '../utils/messageUtils.js';
import { createUtf8ChunkDecoder } from '../utils/utf8StreamDecoder.js';
import { getNeoxUserAgent } from '../utils/neoxUserAgent.js';
import { logger } from '../utils/logger.js';
import { cliLogger, generateCurlCommand } from '../platform/cliLogger.js';
import { modelVisionHeuristic } from '../platform/modelCapabilities.js';
import { ensureSchemaVisionAuthority } from '../schemas/loader.js';
import { stripInlineThinkFromChunks, stripInlineThinkFromText } from './inlineThinkStripper.js'; import { normalizeReasoningDelta } from './reasoningDelta.js';
import { getSchemaRegistry, resolveEffortPayload, resolveDefaultThinkingLevel } from '../schemas/index.js';
import { buildKernelInstructions } from '../core/instructionsBridge.js';
import { ToolCallSlotTracker } from '../core/streamToolCallSlots.js';
import { GPT_AGENTS_INSTRUCTIONS } from '../prompts/gptAgentsInstructions.generated.js';
import type { OpenAITransportProfile, ResolvedModelProfile } from '../profiles/index.js';
import { dumpLLMPayload } from '../utils/llmPayloadDump.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  type RetryConfig,
  type ProviderRetryConfig,
  mergeRetryConfig,
  getProviderRetryConfig,
} from '../types/retryConfig.js';
import {
  classifyError,
  parseRetryAfter,
  ErrorCategory,
} from '../types/errors.js';
import { getRetryDelay, sleep, abortableSleep, formatDelay } from '../utils/backoff.js';
import { formatErrorForUI, formatErrorForLog } from '../utils/errorFormatter.js';
import { safeJSONParse } from '../utils/streamProcessor.js';
import { truncateToolOutput, WIRE_TOOL_OUTPUT_MAX_UNITS } from '../utils/toolOutputTruncation.js';
import { truncateUtf16Safe } from '../utils/wireText.js';
import { normalizeImagePartsInContent, normalizeImageUrl } from '../utils/imageUrlNormalize.js';

/**
 * 判定 apiKey 是否是 NeoxCloud 颁发的.
 *
 *   anonkey_  匿名试用 key (control-plane /api/v1/anonymous/init mint)
 *   nxk_      正式用户 gateway API key (登录后 mint)
 *
 *   命中说明这条请求是走 NeoxCloud 网关的, 不是 BYOK 直连原厂. NeoxCloud 内部约定客户端
 *   只发 chat-format (Neox Protocol), 网关 translator 负责翻译到下游各家. 所以这里要强制
 *   关掉客户端按 model 名前缀触发的 useResponsesAPI / Responses API 路径.
 */
/* NEOX_DEBUG_REQUEST helpers — safe JSON parse / 文件追加, 给 axios interceptor 用 */
import * as _traceFs from 'node:fs';
import * as _tracePath from 'node:path';
import * as _traceOs from 'node:os';
import { NEOX_HOME_DIRNAME } from '../platform/neoxHome.js';
import { currentNeoxSessionId } from './neoxSessionHeader.js';
function safeJsonParseOrRaw(s: string): unknown {
  try { return JSON.parse(s); } catch {
    return s.length > 4096 ? truncateUtf16Safe(s, 4096) + '...<truncated>' : s;
  }
}
function appendTrace(filePath: string, patch: object): void {
  try {
    let existing: any = {};
    try { existing = JSON.parse(_traceFs.readFileSync(filePath, 'utf-8')); } catch { /* first append */ }
    _traceFs.writeFileSync(filePath, JSON.stringify({ ...existing, ...patch }, null, 2));
  } catch { /* ignore — trace 不能拖累 hot path */ }
}

function isNeoxCloudKey(apiKey: string | undefined | null): boolean {
  if (!apiKey || typeof apiKey !== 'string') return false;
  const trimmed = apiKey.trim();
  return trimmed.startsWith('anonkey_') || trimmed.startsWith('nxk_');
}

// ============================================================================
// OpenAI 类型定义 (参考 new-api dto/openai_request.go)
// ============================================================================

/** 响应格式类型 */
type ResponseFormatType = 'text' | 'json_object' | 'json_schema';

/** JSON Schema 定义 */
interface JsonSchemaDefinition {
  description?: string;
  name: string;
  schema?: Record<string, any>;
  strict?: boolean;
}

/** 响应格式 */
interface ResponseFormat {
  type: ResponseFormatType;
  json_schema?: JsonSchemaDefinition;
}

/** 流选项 */
interface StreamOptions {
  include_usage?: boolean;
}

/** 推理配置 (Responses API) */
interface ReasoningConfig {
  effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  summary?: 'auto' | 'concise' | 'detailed';
}

/** 文本配置 (Responses API) */
interface TextConfig {
  format?: { type: 'text' | 'json_object' | 'json_schema' };
  verbosity?: 'low' | 'medium' | 'high';
}

/** 工具调用请求 */
interface ToolCallRequest {
  id?: string;
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, any>;
    arguments?: string;
  };
}

/** 多模态内容类型 */
type ContentType = 'text' | 'image_url' | 'input_audio' | 'file' | 'video_url';

/** 图片 URL */
interface ImageUrl {
  url: string;
  detail?: 'auto' | 'low' | 'high';
}

/** 音频输入 */
interface InputAudio {
  data: string; // base64
  format: string;
}

/** 文件输入 */
interface FileInput {
  filename?: string;
  file_data?: string;
  file_id?: string;
}

/** 视频 URL */
interface VideoUrl {
  url: string;
}

/** 媒体内容 */
interface MediaContent {
  type: ContentType;
  text?: string;
  image_url?: ImageUrl | string;
  input_audio?: InputAudio;
  file?: FileInput;
  video_url?: VideoUrl | string;
  cache_control?: Record<string, any>; // OpenRouter
}

/** 消息结构 */
interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | MediaContent[] | null;
  name?: string;
  prefix?: boolean;
  reasoning_content?: string;
  reasoning?: string;
  tool_calls?: ToolCallRequest[];
  tool_call_id?: string;
}

/**
 * Chat Completions API 请求
 * 参考: new-api dto/openai_request.go GeneralOpenAIRequest
 */
interface ChatCompletionsRequest {
  // 基础字段
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  stream_options?: StreamOptions;

  // Token 控制
  max_tokens?: number;
  max_completion_tokens?: number;

  // 采样参数
  temperature?: number;
  top_p?: number;
  top_k?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  n?: number;
  seed?: number;

  // 推理模型参数
  reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  verbosity?: 'low' | 'medium' | 'high'; // GPT-5

  // 工具调用
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description?: string;
      parameters?: Record<string, any>;
    };
  }>;
  tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };
  parallel_tool_calls?: boolean;

  // 响应格式
  response_format?: ResponseFormat;

  // 日志概率
  logprobs?: boolean;
  top_logprobs?: number;
  logit_bias?: Record<string, number>;

  // 多模态
  modalities?: string[];
  audio?: Record<string, any>;

  // 用户与隐私相关 (PII) - 需要根据配置过滤
  user?: string;
  safety_identifier?: string;  // 默认应过滤
  store?: boolean;             // 根据配置过滤
  service_tier?: string;       // 默认应过滤

  // 缓存相关
  prompt_cache_key?: string;
  prompt_cache_retention?: Record<string, any>;

  // 元数据
  metadata?: Record<string, any>;
  prediction?: Record<string, any>;

  // 各厂商扩展参数
  extra_body?: Record<string, any>;          // Gemini
  search_parameters?: Record<string, any>;   // xAI
  web_search_options?: Record<string, any>;  // Claude
  vl_high_resolution_images?: boolean;       // 阿里千问
  enable_thinking?: boolean;                 // 阿里千问
  web_search?: Record<string, any>;          // 百度 v2
  thinking?: Record<string, any>;            // 豆包/智谱
}

/**
 * Responses API 请求
 * 参考: new-api dto/openai_request.go OpenAIResponsesRequest
 */
interface ResponsesAPIRequest {
  model: string;
  input: any[];
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
    strict?: boolean;
  } | {
    type: 'web_search' | 'web_search_preview';
    external_web_access?: boolean;  // Codex: live=true, cached=false
  }>;
  tool_choice?: any;
  parallel_tool_calls?: boolean;
  max_tool_calls?: number;

  // 高级配置
  reasoning?: ReasoningConfig;
  text?: TextConfig;
  truncation?: string;

  // 会话相关
  include?: string[];

  // 隐私相关 (PII)
  store?: boolean;
  service_tier?: string;

  // 缓存
  prompt_cache_key?: string;
  prompt_cache_retention?: Record<string, any>;

  // 元数据
  metadata?: Record<string, any>;
  user?: string;
  prompt?: string;
}

/** Usage 统计 */
interface UsageStats {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_write_input_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    text_tokens?: number;
    audio_tokens?: number;
    image_tokens?: number;
  };
  completion_tokens_details?: {
    text_tokens?: number;
    audio_tokens?: number;
    reasoning_tokens?: number;
  };
}

/** 流式响应 Choice */
interface StreamChoice {
  index: number;
  delta: {
    role?: string;
    content?: string;
    reasoning_content?: string;
    reasoning?: string;
    reasoning_complete?: boolean;
    tool_calls?: Array<{
      index?: number;
      id?: string;
      type?: string;
      function?: {
        name?: string;
        arguments?: string;
      };
    }>;
    /** OpenAI Responses API encrypted reasoning blob —
     *  下一轮请求必须把这个原样回传 (input 里加 type=reasoning item),
     *  否则 GPT-5/o-series 直接 400 invalid_prompt. agentLoop 在累积
     *  assistant message 时把这个累到 message.openai_reasoning_items 上. */
    _openai_reasoning_item?: {
      id?: string;
      summary?: Array<{ type?: string; text?: string }>;
      encrypted_content?: string;
    };
  };
  finish_reason?: string | null;
  logprobs?: any;
}

/** 流式响应 Chunk */
interface StreamChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  system_fingerprint?: string;
  choices: StreamChoice[];
  usage?: UsageStats;
  // Responses API 事件字段
  type?: string;
  delta?: string;
  item?: any;
  item_id?: string;
  output_index?: number;
  response?: any;
  error?: any;
  message?: string;
  errorCode?: string;
  attempt?: number;
  maxRetries?: number;
  delayMs?: number;
  webSearchId?: string;
  webSearchQuery?: string;
  webSearchStatus?: 'searching' | 'completed';
  webSearchResults?: Array<{ title: string; url: string; description: string; hostname: string }>;
}

type AbortLikeError = Error & { name: string };
type RetryableError = Error & { code?: string; retryable?: boolean };
type IndexedToolCall = ToolCall & { index?: number };

// ============================================================================
// PII 字段过滤配置
// ============================================================================

/** 渠道隐私设置 */
interface ChannelPrivacySettings {
  /** 是否允许 service_tier 透传 (默认过滤以避免额外计费) */
  allowServiceTier?: boolean;
  /** 是否禁用 store 透传 (默认允许透传，禁用后可能导致 Codex 无法使用) */
  disableStore?: boolean;
  /** 是否允许 safety_identifier 透传 (默认过滤以保护用户隐私) */
  allowSafetyIdentifier?: boolean;
}

/**
 * 该模型是否吃 `prompt_cache_key`。
 *
 * 这是 OpenAI 的扩展字段 (前缀缓存的路由亲和键), 别家协议不认 —— 严格实现的端点
 * 遇到未知参数会直接 400, 所以只对 OpenAI 家族发。gpt-5 系 / o 系 / 通用 gpt-* 都支持;
 * DeepSeek、GLM、Kimi、豆包等虽然也走 chat/completions 兼容层, 但缓存是各自实现的,
 * 不认这个字段, 一律不发。
 */
export function supportsPromptCacheKey(model: string | undefined | null): boolean {
  const m = (model || '').toLowerCase();
  if (!m) return false;
  /* 第三方中转常带前缀 (如 "gptpro-relay-b:gpt-5.6-sol"), 取最后一段判定 */
  const bare = m.includes(':') ? m.slice(m.lastIndexOf(':') + 1) : m;
  return /^gpt-/.test(bare) || /^o[345]/.test(bare) || /^chatgpt-/.test(bare);
}

/**
 * 移除禁用的 PII 字段
 * 参考: new-api relay/common/relay_info.go RemoveDisabledFields
 */
function removeDisabledFields<T extends Record<string, any>>(
  request: T,
  settings: ChannelPrivacySettings = {}
): T {
  const result = { ...request };

  // 默认移除 service_tier，除非明确允许（避免额外计费风险）
  if (!settings.allowServiceTier && 'service_tier' in result) {
    delete result.service_tier;
  }

  // 默认允许 store 透传，除非明确禁用（禁用可能影响 Codex 使用）
  if (settings.disableStore && 'store' in result) {
    delete result.store;
  }

  // 默认移除 safety_identifier，除非明确允许（保护用户隐私）
  if (!settings.allowSafetyIdentifier && 'safety_identifier' in result) {
    delete result.safety_identifier;
  }

  return result;
}

// ============================================================================
// 辅助函数
// ============================================================================

type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
/** API-compatible effort (without 'none' — when 'none' is selected, reasoning is omitted) */
type ApiReasoningEffort = Exclude<ReasoningEffort, 'none'>;
type ReasoningVerbosity = 'low' | 'medium' | 'high';
type ReasoningSummary = 'auto' | 'concise' | 'detailed';

/**
 * Get reasoning settings from model configuration or environment variables
 * Priority: model config > environment variables > profile defaults > null
 * Returns null when effort is 'none' (reasoning disabled)
 */
function getReasoningSettings(
  useResponsesAPI: boolean,
  modelConfig?: { reasoning?: { effort?: ReasoningEffort; summary?: ReasoningSummary; verbosity?: ReasoningVerbosity } },
  profileDefaults?: { effort?: ReasoningEffort; summary?: ReasoningSummary },
): {
  effort: ApiReasoningEffort;
  verbosity?: ReasoningVerbosity;
  summary?: ReasoningSummary;
} | null {
  if (!useResponsesAPI) {
    return null;
  }

  // Try model config first (user-configured per-model reasoning)
  if (modelConfig?.reasoning) {
    // 'none' = 不发送 reasoning 参数（等同于关闭推理）
    if (modelConfig.reasoning.effort === 'none') return null;
    return {
      effort: modelConfig.reasoning.effort || 'low',
      verbosity: modelConfig.reasoning.verbosity || 'low',
      summary: modelConfig.reasoning.summary || 'auto',
    };
  }

  // Fallback to environment variables
  const envEffort = (process.env.CD_REASONING_EFFORT || process.env.NEOX_REASONING_EFFORT) as ReasoningEffort | undefined;
  const envVerbosity = (process.env.CD_REASONING_VERBOSITY || process.env.NEOX_REASONING_VERBOSITY || process.env.NEOX_VERBOSITY) as ReasoningVerbosity | undefined;
  const envSummary = (process.env.CD_REASONING_SUMMARY || process.env.NEOX_REASONING_SUMMARY) as ReasoningSummary | undefined;

  // 'none' = 不发送 reasoning 参数
  if (envEffort === 'none') return null;

  // If any env var is set, use those values (with defaults for unset ones)
  if (envEffort || envVerbosity || envSummary) {
    return {
      effort: envEffort || 'low',
      verbosity: envVerbosity || 'low',
      summary: envSummary || 'auto',
    };
  }

  // Fallback to profile-level reasoning defaults (e.g., gpt-5.3-codex → medium)
  if (profileDefaults?.effort && profileDefaults.effort !== 'none') {
    return {
      effort: profileDefaults.effort as ApiReasoningEffort,
      summary: profileDefaults.summary || 'auto',
    };
  }

  // No config at all - return null (will not add reasoning to payload)
  return null;
}

// ============================================================================
// OpenAI Provider 配置
// ============================================================================

/** 豆包深度思考配置 */
export interface DoubaoThinkingConfig {
  /** enabled: 强制开启, disabled: 强制关闭, auto: 模型自行判断 */
  type: 'enabled' | 'disabled' | 'auto';
}

export interface OpenAIProviderConfig {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  /** 运行时模式（用于控制 prompt 注入策略） */
  runtimeMode?: 'agentic' | 'default';
  /** 使用 Responses API 代替 Chat Completions */
  useResponsesAPI?: boolean;
  /** Structured output format (json_schema by default) */
  structuredOutputMode?: 'json_schema' | 'json_object';
  /** 自定义 API 端点路径 (e.g., '/v1/messages' for Anthropic proxies) */
  apiEndpoint?: string;
  /** SSE 流格式 */
  streamFormat?: 'openai' | 'anthropic';
  /** Provider-specific 重试配置 */
  retry?: ProviderRetryConfig;
  /** PII 隐私设置 */
  privacySettings?: ChannelPrivacySettings;
  /** 会话 ID - 用于 Responses API 追踪多轮对话 */
  sessionId?: string;
  /** 豆包深度思考配置（仅对豆包 API 有效） */
  doubaoThinking?: DoubaoThinkingConfig;
  /** 当前激活的模型配置（用于读取 reasoning 等高级设置） */
  modelConfig?: import('../types/configTypes.js').ProviderModelConfig;
  /** 模型 profile（提示词/完成策略/传输策略） */
  modelProfile?: ResolvedModelProfile;
  /**
   * HMAC 请求签名 hook (可选) — 走 Neox cloud gateway 时必填,
   * 对 /chat/completions / /responses / /embeddings 自动签 X-Sig-* headers.
   *
   * 调用方 (electron main 进程) 提供回调, 内部用 neox-native 的 native module
   * 算 hmac, root secret 永远不进 JS heap. neox-core 不直接依赖 native 模块,
   * 也保留在 SDK 场景下 (其它 cloud / 自建 gateway) 不签的能力.
   *
   * 入参 path = 完整 URL path (e.g. /v1/chat/completions), bodyHexHash = sha256(body) hex.
   * 出参 4 元组同 NEOX_HMAC_ROOT_SECRET 协议 (server sigverify.go 的字段名).
   */
  hmacSigner?: (path: string, bodyHexHash: string) => Promise<{ ts: string; nonce: string; sig: string; version: string }>;

  /**
   * 完全跳过 HMAC 签名 + fail-close 拦截.
   *
   *   场景:
   *     · BYOK SDK 用户直连公开 endpoint (OpenAI / Anthropic / OpenRouter / DeepSeek 等),
   *       这些 endpoint 不要求 Neox HMAC, 也没 @neoxlabs/native, 默认 fail-close 会拦死请求.
   *     · 第三方应用嵌入 kernel, 显式禁用 sign 即可.
   *
   *   Neox 自家产品 (cli / desktop / cloud-agent) 默认不传此选项 → fail-close 保持原状态.
   */
  disableSigning?: boolean;

  /** UI 语言, 透传给 system prompt 让 LLM 用对应语言回复. 不传默认 'zh' 保持兼容. */
  language?: 'zh' | 'en';
}

// ============================================================================
// HMAC signer (P1-1) — 自动从 @neoxlabs/native 加载, 双 process 共用
// ============================================================================
//
//   行为
//   ----
//   - 仅当 env NEOX_HMAC_ROOT_SECRET 非空时才尝试加载 native module
//     (跟 gateway sigverify.go 的 enabled 判断对齐)
//   - 加载失败 (native 没装 / 编译产物缺) → 静默返 null, 不签
//   - 业务可显式传 config.hmacSigner 覆盖此自动逻辑
//
//   为什么放这层而不是 server 入口
//   ------------------------------
//   chat 路径分散在 hostFactory / agenticRuntime / assistantRuntime / assistantSession
//   等处都会调 buildProvider, 一个个塞 hmacSigner 太散; OpenAIProvider 是真正
//   发请求的最末端, 在这里兜底覆盖率最高.

/** v2 签名上下文 — 绑 nxk + 设备指纹。nxkId 必填 (v2-only cutover 后 signer 会 fail-close)。 */
export type HmacSignContext = { nxkId: string; deviceFp?: string };
export type AutoHmacSigner = (path: string, bodyHexHash: string, ctx: HmacSignContext) => Promise<{ ts: string; nonce: string; sig: string; version: string; proto: 2 }>;
let _cachedAutoSigner: AutoHmacSigner | null | undefined = undefined;

/* 转出给包外用 —— 深引基线 (config/import-boundaries.json) 是"只减不增"的棘轮,
 * 而 `utils/neoxUserAgent.js` 不在放行清单里。基线开头写明修法是**走公开入口**,
 * 不是往清单里追加; models/openai.js 已在清单内, 且用它的地方本来就在这儿
 * 取 getNeoxDeviceFp, 两个东西一起拿反而更顺。 */
export { getNeoxUserAgent } from '../utils/neoxUserAgent.js';

const _FP_GLOBAL_KEY = '__NEOX_DEVICE_FP__';
export function setNeoxDeviceFp(fp: string): void {
  (globalThis as any)[_FP_GLOBAL_KEY] = (fp || '').trim();
}
export function getNeoxDeviceFp(): string {
  return (globalThis as any)[_FP_GLOBAL_KEY] ?? '';
}

/* @internal — 给 AnthropicProvider 等其它 provider 复用同一份 native signer 缓存.
 *
 *   注意: 不靠 env 当开关. P1 工作里 root secret 已经直接写进 native lib.rs (commit 12f48ecd),
 *   所以只要 @neoxlabs/native 加载成功就 enabled; 加载失败 (CLI/SDK 没装 / 编译产物
 *   缺 / Electron rebuild 没跑) → null, 那种场景多半也不走 cloud gateway.
 *   path 白名单 (shouldSignPath) 进一步把范围收到 chat/completions / responses /
 *   embeddings / messages, 直连外部 provider 不会乱签 (OpenAI / Anthropic 也忽略
 *   不认识的 header, 顶多浪费一次 sha256). */
/**
 * cloud-runtime 用 — 注入外部 HMAC signer (纯 JS, 不依赖 @neoxlabs/native 二进制).
 * 在第一次 LLM 请求之前调用, 后续 loadAutoHmacSigner 直接返这个.
 */
export function setExternalHmacSigner(signer: AutoHmacSigner | null): void {
  _cachedAutoSigner = signer;
}

/** 从 JWT (3 段 dot) 解 fp claim. 失败返 null (非 JWT / 损坏 / 没 fp claim). */
function extractFpFromJwt(token: string): string | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    let b64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) b64 += '=';
    const payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    return typeof payload?.fp === 'string' && payload.fp.length > 0 ? payload.fp : null;
  } catch {
    return null;
  }
}

export function loadAutoHmacSigner(): AutoHmacSigner | null {
  if (_cachedAutoSigner !== undefined) return _cachedAutoSigner;
  try {
    const requireResolve: (id: string) => any =
      (typeof require !== 'undefined' ? require : _createRequire(import.meta.url)) as any;
    const native = ((globalThis as any).__NEOX_NATIVE__ ?? requireResolve('@neoxlabs/native')) as {
      computeHmacSigV2: (ts: string, nonce: string, path: string, bodyHexHash: string, nxkId: string, deviceFp: string) => string;
      getSecretVersion: () => string;
    };
    if (typeof native.computeHmacSigV2 !== 'function') {
      throw new Error('native.computeHmacSigV2 missing — need rebuilt @neoxlabs/native (v2-only cutover 2026-07-03)');
    }
    const version = native.getSecretVersion();
    /* 从开源代码自行构建、没有注入 root secret 的 native 自报 unsigned —— 视同没有签名器,
     * 请求不带签名照发 (网关观察模式只记录, 不拦)。 */
    if (version === 'unsigned') {
      cliLogger.info('HMAC', 'native module is an unsigned build · requests go out without client signature');
      _cachedAutoSigner = null;
      return _cachedAutoSigner;
    }
    cliLogger.info('HMAC', `auto-signer loaded · secret-version=${version} · proto=v2`);
    _cachedAutoSigner = async (path: string, bodyHexHash: string, ctx?: HmacSignContext) => {
      if (!ctx?.nxkId) throw new Error(`HMAC v2 requires nxkId (path=${path})`);
      const ts = String(Math.floor(Date.now() / 1000));
      const nonce = randomBytes(8).toString('hex');
      const sig = native.computeHmacSigV2(ts, nonce, path, bodyHexHash, ctx.nxkId, ctx.deviceFp ?? '');
      return { ts, nonce, sig, version, proto: 2 };
    };
  } catch (err: any) {
    cliLogger.warn('HMAC', `auto-signer disabled · @neoxlabs/native not loadable: ${err?.message ?? err}`);
    _cachedAutoSigner = null;
  }
  return _cachedAutoSigner;
}

/* @internal — gateway sigverify 校验任何 enabled 的请求, 但本端只对几条 cloud LLM
 * 路径加 X-Sig-* (其它端点直连第三方就不签). 用 endsWith 匹配, 兼容多种 baseUrl 拼法
 * (e.g. http://localhost:8088 / http://localhost:8088/v1 / http://gateway/api/v1).
 *
 *   /models 也在列表 — 列表查询走网关代理时, 提前把签名加上, 等网关侧未来开启 GET 路径
 *   签验时不需要客户端发版. body 为空时签名仍能防 path 重放 (path+ts+nonce 唯一). */
export function shouldSignPath(pathname: string): boolean {
  return pathname.endsWith('/chat/completions')
    || pathname.endsWith('/responses')
    || pathname.endsWith('/embeddings')
    || pathname.endsWith('/messages')
    || pathname.endsWith('/models');
}

// ============================================================================
// OpenAI Provider 实现
// ============================================================================

export class OpenAIProvider implements LLMProvider {
  private client: AxiosInstance;
  private defaultModel: string;
  private isProxy: boolean;
  private useResponsesAPI: boolean;
  private apiEndpoint: string;
  private streamFormat: 'openai' | 'anthropic';
  private retryConfig: RetryConfig;
  private baseUrl: string;
  private privacySettings: ChannelPrivacySettings;
  private sessionId: string;
  private doubaoThinking?: DoubaoThinkingConfig;
  private apiKey: string; // 新增：用于 debug 日志中的 curl 命令
  private language: 'zh' | 'en';
  private modelConfig?: import('../types/configTypes.js').ProviderModelConfig;
  private structuredOutputMode: 'json_schema' | 'json_object';
  private modelProfile?: ResolvedModelProfile;
  private transportProfile?: OpenAITransportProfile;
  private requestTimeoutMs: number;
  private streamRequestTimeoutMs: number;
  private strictSSEDone: boolean;
  private runtimeMode: 'agentic' | 'default';
  private frozenMemoryContextBySession: Map<string, string | null>;
  private frozenAssistantContextBySession: Map<string, string | null>;
  private frozenInstructionsBySessionModel: Map<string, string>;
  private frozenAgentInstructionsBySession: Map<string, string | null>;

  constructor(config: OpenAIProviderConfig) {
    /* baseUrl 必须由 caller 显式提供. Neox 不存在"兜底打 api.openai.com"这种行为 — NeoxCloud
     * 才是默认归宿. 走到这里 baseUrl 还是空 = 上游 (NeoxCloud routing resolver) 没把 sentinel
     * 改写出来, 或者 BYOK provider 配置缺 baseUrl. 都是 fail-fast 场景. */
    const rawBaseUrl = (config.baseUrl ?? '').trim();
    if (!rawBaseUrl) {
      throw new Error(
        'OpenAIProvider: baseUrl 为空 — NeoxCloud 路由未注入 gatewayBase, 或 BYOK provider 漏配 baseUrl. ' +
        '检查 ~/.neox/routing.json (gatewayBase 字段) 或重新登录: neox login.',
      );
    }
    this.baseUrl = rawBaseUrl;
    this.isProxy = !rawBaseUrl.includes('api.openai.com');
    this.modelProfile = config.modelProfile;
    this.transportProfile = config.modelProfile?.transport?.openai;

    /* 协议契约 — 走 NeoxCloud 网关时永远只发 chat-format (Neox Protocol).
     *
     *   背景: 客户端按 model 名前缀 (gpt-5.* 等) 选 Responses API 是给 BYOK 第三方 key 直连
     *   原厂上游用的; 走 NeoxCloud 时下游协议由网关 translator 决定, 客户端要保持单一协议契约.
     *
     *   识别方式: apiKey 以 anonkey_ 或 nxk_ 开头 — 这两个前缀永远只由 NeoxCloud 颁发.
     *   BYOK 的 OpenAI/Anthropic 等 sk-... key 自然不命中. */
    const goingThroughNeoxCloud = isNeoxCloudKey(config.apiKey);
    const officialOpenAIBase = !config.baseUrl
      || /(^|\.|\/\/)(api\.openai\.com|chatgpt\.com)([/:]|$)/i.test(config.baseUrl);
    if (goingThroughNeoxCloud) {
      this.useResponsesAPI = false;
    } else if (this.transportProfile?.forceResponsesAPI !== undefined) {
      this.useResponsesAPI = (this.transportProfile.forceResponsesAPI && officialOpenAIBase)
        || (config.useResponsesAPI ?? false);
    } else {
      this.useResponsesAPI = config.useResponsesAPI ?? false;
    }
    cliLogger.info('NEOX_DIAG', 'openai-provider-ctor', {
      baseUrl: config.baseUrl,
      apiKeyPrefix: typeof config.apiKey === 'string' ? config.apiKey.slice(0, 12) + '...' : '(undef)',
      apiKeyLen: typeof config.apiKey === 'string' ? config.apiKey.length : 0,
      goingThroughNeoxCloud,
      useResponsesAPI: this.useResponsesAPI,
      forceResponsesAPI: this.transportProfile?.forceResponsesAPI,
      configUseResponsesAPI: config.useResponsesAPI,
      modelProfileId: config.modelProfile?.id,
      defaultModel: config.defaultModel,
    });
    this.apiEndpoint = config.apiEndpoint || '/chat/completions';
    this.streamFormat = config.streamFormat || 'openai';
    this.apiKey = config.apiKey; // 存储 apiKey
    this.language = config.language ?? 'zh';
    // 生成唯一的会话 ID，用于 Responses API 追踪
    this.sessionId = config.sessionId || `session-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    this.privacySettings = config.privacySettings || {};
    // 豆包深度思考配置
    this.doubaoThinking = config.doubaoThinking;
    // 模型配置（包含 reasoning 等高级设置）
    this.modelConfig = config.modelConfig;
    this.structuredOutputMode = config.structuredOutputMode || 'json_schema';
    this.defaultModel = config.defaultModel || 'gpt-4';
    this.runtimeMode = config.runtimeMode || 'default';
    this.frozenMemoryContextBySession = new Map();
    this.frozenAssistantContextBySession = new Map();
    this.frozenInstructionsBySessionModel = new Map();
    this.frozenAgentInstructionsBySession = new Map();

    const providerPreset = getProviderRetryConfig('openai', this.baseUrl);
    this.retryConfig = mergeRetryConfig(undefined, {
      ...providerPreset,
      ...this.transportProfile?.retry,
      ...config.retry,
    });

    this.requestTimeoutMs = this.transportProfile?.requestTimeoutMs ?? 120000;
    this.streamRequestTimeoutMs = this.transportProfile?.streamRequestTimeoutMs
      ?? Math.max(this.retryConfig.streamIdleTimeoutMs + 60000, this.retryConfig.connectTimeoutMs + 15000);
    this.strictSSEDone = this.transportProfile?.strictSSEDone ?? false;

    /* JWT 是 user 态 token → 解 fp claim 加 X-Device-FP header.
     * gateway 强制校验 JWT.fp == header X-Device-FP. */
    const fpFromJwt = extractFpFromJwt(config.apiKey);
    cliLogger.info('OpenAI', `JWT fp claim extract: ${fpFromJwt ? `present(${fpFromJwt.slice(0,8)}...)` : 'MISSING'}`);

    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'Accept-Encoding': 'identity',
        /* 给 cloud gateway 一个能识别 OS + Desktop/CLI 的 UA, 否则默认 axios/X.Y.Z 在
         * /usage 流水里看不出哪台机器发的. 详见 utils/neoxUserAgent.ts. */
        'User-Agent': getNeoxUserAgent(),
        'X-Neox-Lang': process.env.NEOX_LANGUAGE === 'en' ? 'en' : 'zh',
        'session_id': headerSafeSessionId(this.sessionId),
        'conversation_id': headerSafeSessionId(this.sessionId),
        ...(fpFromJwt ? { 'X-Device-FP': fpFromJwt } : {}),
      },
      timeout: this.requestTimeoutMs,
      decompress: false,
    });

    /* X-Neox-Session: 只发给 Neox 网关 (订阅), 值是用户视角的主会话 id —— 网关按它限
     * "同时运行的会话数"。每次请求现取 (同一个 provider 实例可能先后服务不同会话),
     * 取不到就不带, 网关退回只按在途并发限。详见 neoxSessionHeader.ts。 */
    if (isNeoxCloudKey(config.apiKey)) {
      this.client.interceptors.request.use(axiosConfig => {
        const sid = currentNeoxSessionId();
        if (sid) (axiosConfig.headers as any)['X-Neox-Session'] = sid;
        return axiosConfig;
      });
    }
    const byokAutoSkip = !isNeoxCloudKey(config.apiKey);
    const disableSigning = config.disableSigning ?? byokAutoSkip;
    const hmacSigner = disableSigning ? null : (config.hmacSigner ?? loadAutoHmacSigner());
    if (disableSigning) {
      cliLogger.info('OpenAI', `provider built · signing/AEAD disabled (${config.disableSigning != null ? 'by config' : 'BYOK auto-detected from apiKey'}, baseUrl=${this.baseUrl})`);
    } else if (hmacSigner) {
      let firstSignLogged = false;
      let fpEmptyWarned = false;
      this.client.interceptors.request.use(async axiosConfig => {
        const baseURL = axiosConfig.baseURL ?? this.baseUrl;
        /* axios 的 baseURL + url 是字面拼接, 而 new URL(url, baseURL) 在 url 以 '/'
         * 起头时会把 baseURL 的 path 整段替换掉 (WHATWG URL 规范). 所以我们必须用
         * 字面拼接 + 单参 URL 解析, 不能直接传给双参 URL constructor.
         * baseURL='http://x/v1' + url='/responses' → '/v1/responses' (而不是 '/responses') */
        const cleanBase = (baseURL ?? '').replace(/\/+$/, '');
        const rawUrl = axiosConfig.url ?? '/';
        const cleanUrl = rawUrl.startsWith('/') ? rawUrl : '/' + rawUrl;
        const fullUrl = new URL(cleanBase + cleanUrl);
        const sigPath = fullUrl.pathname;
        /* 仅对 cloud gateway 关心的几条 LLM 路径签名 (chat/completions, responses,
         * embeddings, messages); 其它端点 (auth, etc.) 不签. 这里 noop, 不在 fail-closed 范围内. */
        if (!shouldSignPath(sigPath)) {
          return axiosConfig;
        }
        /* 序列化 body 跟服务端校验保持一致: server 拿到 raw bytes 算 sha256,
         * axios 会把 object 序列化成 JSON 发出去, 这里也用 JSON.stringify 抢在前面.
         * 流式 (responseType=stream) 也走同 payload, 不影响. */
        let bodyStr = '';
        if (axiosConfig.data !== undefined && axiosConfig.data !== null) {
          bodyStr = typeof axiosConfig.data === 'string' ? axiosConfig.data : JSON.stringify(axiosConfig.data);
        }

        if (bodyStr.length > 0 && typeof axiosConfig.data !== 'string') {
          axiosConfig.data = bodyStr;
          axiosConfig.headers = axiosConfig.headers ?? {};
          (axiosConfig.headers as any)['Content-Type'] = 'application/json';
        }

        const bodyHexHash = createHash('sha256').update(bodyStr).digest('hex');
        /* v2: nxkId = sha256(nxk)[:16] (与服务端 nxkFingerprint 逐字节对齐).
         * deviceFp 优先宿主注入的真实机器指纹 (setNeoxDeviceFp), 回落 JWT fp claim. */
        const nxkId = createHash('sha256').update(config.apiKey).digest('hex').slice(0, 16);
        const deviceFp = getNeoxDeviceFp() || (fpFromJwt ?? '');
        /* 空 fp 会被 NeoxCloud 拒 (客户端表现为"签名校验失败"), 真因通常是某个宿主入口没注入指纹 ——
         * 历史上 CLI / 桌面 / worker / daemon 各漏过一次。请求照发, 但日志里必须能一眼看出是 fp 空。 */
        if (!deviceFp && !fpEmptyWarned) {
          fpEmptyWarned = true;
          cliLogger.error(
            'OpenAI',
            `X-Device-FP 为空 — 本进程没注入设备指纹, NeoxCloud 会拒 (表现为"请求签名校验失败")。`
            + ` 宿主入口需调 setNeoxDeviceFp() 或设 NEOX_DEVICE_FP · path=${sigPath}`,
          );
        }
        let sig: { ts: string; nonce: string; sig: string; version: string; proto?: number };
        try {
          sig = await hmacSigner(sigPath, bodyHexHash, { nxkId, deviceFp });
        } catch (err) {
          const msg = (err as Error)?.message ?? String(err);
          cliLogger.warn('OpenAI', `hmac sign failed — sending unsigned · path=${sigPath} · ${msg}`);
          axiosConfig.headers = axiosConfig.headers ?? {};
          (axiosConfig.headers as any)['X-Device-FP'] = deviceFp;
          return axiosConfig;
        }
        axiosConfig.headers = axiosConfig.headers ?? {};
        (axiosConfig.headers as any)['X-Sig-Ts'] = sig.ts;
        (axiosConfig.headers as any)['X-Sig-Nonce'] = sig.nonce;
        (axiosConfig.headers as any)['X-Sig'] = sig.sig;
        (axiosConfig.headers as any)['X-Client-Version'] = sig.version;
        /* v2-only: X-Sig-Proto 无条件, X-Device-FP 无条件 (nxk 模式暂无真实 fp → 空串仍必带,
         * 两端签算里 fp 一致才过 HMAC; 服务端目前 fp 允许空, 后续 fp 注册+校验会强制非空)。 */
        (axiosConfig.headers as any)['X-Sig-Proto'] = '2';
        (axiosConfig.headers as any)['X-Device-FP'] = deviceFp;
        if (!firstSignLogged) {
          cliLogger.info('OpenAI', `hmac signed first request · path=${sigPath} version=${sig.version}`);
          firstSignLogged = true;
        }
        if (process.env.NEOX_DUMP_CURL === '1') {
          try {
            const fs = await import('fs');
            const path = await import('path');
            const os = await import('os');
            const dumpDir = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'logs');
            fs.mkdirSync(dumpDir, { recursive: true });
            const today = new Date().toISOString().slice(0, 10);
            const file = path.join(dumpDir, `neox-curl-${today}.sh`);
            const fullUrl = (axiosConfig.baseURL ?? '').replace(/\/+$/, '') + (axiosConfig.url ?? '');
            const ts = new Date().toISOString();
            /* 把 body 写到独立 JSON 文件, curl 引用; 避免一行几十 KB 难读 */
            const bodyFile = path.join(dumpDir, `neox-curl-body-${sig.ts}-${sig.nonce.slice(0, 8)}.json`);
            fs.writeFileSync(bodyFile, bodyStr);
            const headers = axiosConfig.headers as Record<string, string>;
            const headerArgs = Object.entries(headers)
              .filter(([k]) => k.toLowerCase() !== 'content-length')
              .map(([k, v]) => `  -H "${k}: ${String(v).replace(/"/g, '\\"')}"`).join(' \\\n');
            const curl = `# ${ts} sigPath=${sigPath} bodyBytes=${bodyStr.length}\ntime curl -N -sS -o /tmp/neox-curl-out.txt -w "\\nstatus=%{http_code} dns=%{time_namelookup}s conn=%{time_connect}s firstByte=%{time_starttransfer}s total=%{time_total}s\\n" \\\n  -X POST "${fullUrl}" \\\n${headerArgs} \\\n  --data-binary "@${bodyFile}"\n`;
            fs.appendFileSync(file, curl + '\n');
            cliLogger.info('NEOX_DUMP_CURL', `curl dumped → ${file} (body: ${bodyFile})`);
          } catch (err) {
            cliLogger.warn('NEOX_DUMP_CURL', `failed to dump curl: ${(err as Error)?.message ?? err}`);
          }
        }
        return axiosConfig;
      });

    } else {
      /* 没有签名器 (未签名构建 / native 没装): NeoxCloud 请求不带签名照发, 网关观察模式只记录。
       * 设备指纹照带 —— 它跟签名无关, 网关用它做设备维度的额度与风控。 */
      this.client.interceptors.request.use(axiosConfig => {
        const deviceFp = getNeoxDeviceFp() || (fpFromJwt ?? '');
        if (deviceFp) {
          axiosConfig.headers = axiosConfig.headers ?? {};
          (axiosConfig.headers as any)['X-Device-FP'] = deviceFp;
        }
        return axiosConfig;
      });
      cliLogger.info('OpenAI', `provider built · no client signer, NeoxCloud requests go out unsigned (baseUrl=${this.baseUrl})`);
    }

    if (process.env.CLI_DEBUG === '1') {
      cliLogger.debug('OpenAI', 'Initialized with:', {
        baseUrl: this.baseUrl,
        isProxy: this.isProxy,
        useResponsesAPI: this.useResponsesAPI,
        apiEndpoint: this.apiEndpoint,
        streamFormat: this.streamFormat,
        requestTimeoutMs: this.requestTimeoutMs,
        streamRequestTimeoutMs: this.streamRequestTimeoutMs,
        strictSSEDone: this.strictSSEDone,
        runtimeMode: this.runtimeMode,
        profile: this.modelProfile?.id,
        profileSources: this.modelProfile?.sourceProfileIds,
      });
    }

    if (process.env.NEOX_DEBUG_REQUEST === '1') {
      const REDACT_HEADER_KEYS = ['authorization', 'x-sig', 'x-sig-ts', 'x-sig-nonce', 'cookie'];
      const redactHeaders = (h: any): Record<string, string> => {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(h || {})) {
          const key = k.toLowerCase();
          const isSecret = REDACT_HEADER_KEYS.some((s) => key === s || key.startsWith(s + '-'));
          out[k] = isSecret ? '<REDACTED>' : String(v);
        }
        return out;
      };
      const dumpDir = _tracePath.join(_traceOs.homedir(), NEOX_HOME_DIRNAME, 'logs', 'llm-traces');
      try { _traceFs.mkdirSync(dumpDir, { recursive: true }); } catch { /* exists */ }
      /* request 落 startMs/url/body, response interceptor 拿到后再追加 */
      const pending = new WeakMap<object, { startMs: number; path: string; tracePath: string }>();

      this.client.interceptors.request.use((axiosConfig) => {
        try {
          const startMs = Date.now();
          const baseURL = axiosConfig.baseURL ?? this.baseUrl;
          const cleanBase = (baseURL ?? '').replace(/\/+$/, '');
          const cleanUrl = (axiosConfig.url ?? '/').startsWith('/') ? (axiosConfig.url ?? '/') : '/' + (axiosConfig.url ?? '');
          const fullUrl = cleanBase + cleanUrl;
          let pathSlug = '';
          try { pathSlug = new URL(fullUrl).pathname.replace(/[^a-zA-Z0-9]/g, '_').slice(-40); } catch { /* */ }
          const tracePath = _tracePath.join(dumpDir, `${startMs}_${pathSlug}.json`);
          const bodyStr = axiosConfig.data === undefined ? null
            : (typeof axiosConfig.data === 'string' ? axiosConfig.data : JSON.stringify(axiosConfig.data));
          const requestRec = {
            startMs,
            method: (axiosConfig.method || 'POST').toUpperCase(),
            url: fullUrl,
            headers: redactHeaders(axiosConfig.headers),
            body: bodyStr ? safeJsonParseOrRaw(bodyStr) : null,
            bodyBytes: bodyStr?.length ?? 0,
          };
          _traceFs.writeFileSync(tracePath, JSON.stringify({ request: requestRec }, null, 2));
          pending.set(axiosConfig, { startMs, path: pathSlug, tracePath });
          cliLogger.info('LLM_TRACE', `→ ${requestRec.method} ${fullUrl} (${requestRec.bodyBytes}B) → ${tracePath}`);
        } catch (err) {
          cliLogger.warn('LLM_TRACE', `request hook failed: ${(err as Error)?.message ?? err}`);
        }
        return axiosConfig;
      });

      this.client.interceptors.response.use(
        (response) => {
          try {
            const rec = pending.get(response.config);
            if (!rec) return response;
            const endMs = Date.now();
            const isStream = response.config.responseType === 'stream';
            const respRec: any = {
              endMs,
              durationMs: endMs - rec.startMs,
              status: response.status,
              headers: redactHeaders(response.headers),
              streaming: isStream,
            };
            if (isStream) {
              respRec.note = 'stream body skipped (use OpenAI streaming layer dump for chunks)';
            } else {
              respRec.body = response.data;
            }
            appendTrace(rec.tracePath, { response: respRec });
            cliLogger.info('LLM_TRACE', `← ${response.status} ${respRec.durationMs}ms (${isStream ? 'stream' : 'json'}) ← ${rec.tracePath}`);
          } catch (err) {
            cliLogger.warn('LLM_TRACE', `response hook failed: ${(err as Error)?.message ?? err}`);
          }
          return response;
        },
        (error) => {
          try {
            const cfg = error?.config;
            const rec = cfg && pending.get(cfg);
            if (rec) {
              const endMs = Date.now();
              const errRec = {
                endMs,
                durationMs: endMs - rec.startMs,
                status: error?.response?.status ?? null,
                headers: error?.response?.headers ? redactHeaders(error.response.headers) : null,
                body: error?.response?.data ?? null,
                message: error?.message ?? String(error),
                code: error?.code ?? null,
              };
              appendTrace(rec.tracePath, { error: errRec });
              cliLogger.warn('LLM_TRACE', `✗ ${errRec.status ?? 'NETERR'} ${errRec.durationMs}ms ${errRec.message} ← ${rec.tracePath}`);
            }
          } catch (e) {
            cliLogger.warn('LLM_TRACE', `error hook failed: ${(e as Error)?.message ?? e}`);
          }
          return Promise.reject(error);
        },
      );

      cliLogger.info('LLM_TRACE', `NEOX_DEBUG_REQUEST=1 → traces will dump to ${dumpDir}`);
    }
  }

  // ============================================================================
  // 公共接口
  // ============================================================================

  private noteImageCompat(messages: Message[], model: string): void {
    const hasImage = messages.some(msg =>
      Array.isArray(msg.content) && (msg.content as any[]).some(p => p?.type === 'image_url'),
    );
    if (!hasImage) return;
    ensureSchemaVisionAuthority();
    if (modelVisionHeuristic(model)) return;
    /* 已知纯文本 + 带图: 照发, 只留一条线索 —— 上游真报错时这行日志能立刻定位 */
    cliLogger.info('OpenAI',
      `[VISION] model "${model}" 在我们的能力表里标记为纯文本, 但仍按用户意图把图片发给上游 (上游拒收时会原样报错)`);
  }

  async chat(
    messages: Message[],
    options: {
      model?: string;
      tools?: Tool[];
      temperature?: number;
      structuredOutput?: StructuredOutputDefinition;
      maxInputTokens?: number;
      maxTokens?: number;
      signal?: AbortSignal;
      /** 'background' 时容量类错误 (RATE_LIMIT / 502/503/504) 不重试, 给前台让路. */
      requestPriority?: 'foreground' | 'background';
      /** Per-call reasoning_effort override. side-agent 应传 'minimal' (gpt-5+ 等 reasoning 模型),
       *  减 thinking 让响应快 + 节省 tokens. 不传则走 model profile / env default. */
      reasoningEffortOverride?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
      effortLevel?: string;
    } = {}
  ): Promise<ChatCompletionResponse> {
    const { model = this.defaultModel } = options;
    this.noteImageCompat(messages, model);

    if (this.shouldUseResponsesAPI(model)) {
      return this.chatWithResponsesAPI(messages, options);
    }

    return this.chatWithChatCompletions(messages, options);
  }

  async *chatStreamed(
    messages: Message[],
    options: {
      model?: string;
      tools?: Tool[];
      temperature?: number;
      structuredOutput?: StructuredOutputDefinition;
      maxInputTokens?: number;
      signal?: AbortSignal;
      prediction?: { type: 'content'; content: string };
      /** 'background' 时容量类错误不重试. */
      requestPriority?: 'foreground' | 'background';
      /** Per-call reasoning_effort override (side-agent 用 'minimal'). */
      reasoningEffortOverride?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
    } = {}
  ): AsyncGenerator<StreamChunk> {
    const { model = this.defaultModel } = options;
    this.noteImageCompat(messages, model);

    /* 调试: NEOX_DUMP_LLM=1 时落 payload, 否则零开销. 详见 utils/llmPayloadDump.ts. */
    dumpLLMPayload({
      source: 'OpenAIProvider.chatStreamed',
      model,
      useResponsesAPI: this.useResponsesAPI,
      baseUrl: this.baseUrl,
      apiEndpoint: this.apiEndpoint,
      apiKeyPrefix: typeof this.apiKey === 'string' ? this.apiKey.slice(0, 12) : '(empty)',
      messages,
      tools: options.tools,
    });

    if (this.shouldUseResponsesAPI(model)) {
      yield* this.chatStreamedWithResponsesAPI(messages, options);
    } else {
      /* inline <think> 剥离 — 第三方 OpenAI-compat 中转 (R1 代理/vLLM/ollama) 会把思考
       * inline 进 content 而不是独立 reasoning_content 字段, 这里统一切回 reasoning 通道。
       * 官方 Responses API 无此形态, 不走这层。 */
      yield* stripInlineThinkFromChunks(this.chatStreamedWithChatCompletions(messages, options));
    }
  }

  // ============================================================================
  // Chat Completions API 实现
  // ============================================================================

  private async chatWithChatCompletions(
    messages: Message[],
    options: {
      model?: string;
      tools?: Tool[];
      temperature?: number;
      structuredOutput?: StructuredOutputDefinition;
      maxInputTokens?: number;
      maxTokens?: number;
      signal?: AbortSignal;
      requestPriority?: 'foreground' | 'background';
      /** Phase 2.5: schema-defined effort level.
       *   Translated via schema.effort_map[level] into family-specific fields
       *   (e.g. claude → thinking budget, openai → reasoning_effort). */
      effortLevel?: string;
      reasoningEffortOverride?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
    }
  ): Promise<ChatCompletionResponse> {
    /* 同步 chat() 也必须对上游发 stream:true, 再在本地收齐 JSON.
     *
     * BYOK → AccountHub 走 Responses API: chatWithResponsesAPI 本来就是这么做的,
     * 所以上游一直在流, 首 token 秒出. NeoX 订阅把 useResponsesAPI 强制关掉之后,
     * 旧实现真的 POST stream:false —— gpt-5.6-luna 这类 reasoning 模型会把整段
     * 思考+正文缓冲 2–5 分钟, 网关 90s 预算先把连接掐了. 主 UI 的 chatStreamed
     * 不受影响; 中招的是摘要 / 压缩 / websearch 这些走 .chat() 的后台调用,
     * 而 5.6-sol/terra 的"轻量摘要模型"就是 luna. */
    const contentChunks: string[] = [];
    const reasoningChunks: string[] = [];
    const toolCalls: IndexedToolCall[] = [];
    const toolCallSlots = new ToolCallSlotTracker();
    let usage: UsageStats | undefined;
    let finishReason = 'stop';

    for await (const chunk of this.chatStreamedWithChatCompletions(messages, {
      model: options.model,
      tools: options.tools,
      temperature: options.temperature,
      structuredOutput: options.structuredOutput,
      maxInputTokens: options.maxInputTokens,
      maxTokens: options.maxTokens,
      signal: options.signal,
      effortLevel: options.effortLevel ?? options.reasoningEffortOverride,
    })) {
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (delta) {
        if (delta.content) contentChunks.push(delta.content);
        if (delta.reasoning_content) reasoningChunks.push(delta.reasoning_content);
        if (delta.tool_calls) {
          for (const toolCall of delta.tool_calls) {
            /* 槽位归属跟 runner 同一套规则 (同 index 带新 id = 新调用), 见 streamToolCallSlots.ts */
            const slot = toolCallSlots.resolve(toolCall);
            const existing = toolCalls.find(tc => tc.index === slot);
            if (existing) {
              if (toolCall.function?.arguments) {
                existing.function.arguments += toolCall.function.arguments;
              }
            } else {
              toolCalls.push({
                id: toolCall.id || `call_${toolCalls.length}`,
                type: 'function',
                function: {
                  name: toolCall.function?.name || '',
                  arguments: toolCall.function?.arguments || '',
                },
                index: slot,
              } as IndexedToolCall);
            }
          }
        }
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (chunk.usage) usage = chunk.usage;
    }

    const joined = contentChunks.join('');
    const reasoning = reasoningChunks.join('');
    let content: string | null = joined.length > 0 ? joined : null;
    let reasoningContent = reasoning || undefined;
    if (content && !reasoningContent) {
      const stripped = stripInlineThinkFromText(content);
      if (stripped.reasoning) {
        content = stripped.content;
        reasoningContent = stripped.reasoning;
      }
    }

    return {
      id: `chatcmpl-${Date.now()}`,
      choices: [{
        message: {
          role: 'assistant',
          content,
          ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      }],
      usage: usage || { total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 },
    };
  }

  private async *chatStreamedWithChatCompletions(
    messages: Message[],
    options: {
      model?: string;
      tools?: Tool[];
      temperature?: number;
      structuredOutput?: StructuredOutputDefinition;
      maxInputTokens?: number;
      maxTokens?: number;
      signal?: AbortSignal;
      prediction?: { type: 'content'; content: string };
      effortLevel?: string;
    }
  ): AsyncGenerator<StreamChunk> {
    const { model = this.defaultModel, tools, temperature = 0.7, maxInputTokens, signal, effortLevel } = options;

    const payload = this.buildChatCompletionsPayload(messages, {
      model,
      tools,
      temperature,
      structuredOutput: options.structuredOutput,
      maxInputTokens,
      maxOutputTokens: options.maxTokens,
      stream: true,
      prediction: options.prediction,
      effortLevel,
    });

    const requestUrl = `${this.client.defaults.baseURL}${this.apiEndpoint}`;
    cliLogger.info('NEOX_DIAG', 'chat-stream-open', {
      url: requestUrl,
      model,
      apiKeyPrefix: typeof this.apiKey === 'string' ? this.apiKey.slice(0, 12) + '...' : '(empty)',
      useResponsesAPI: this.useResponsesAPI,
      msgCount: payload.messages?.length,
      stream: payload.stream,
    });
    logger.llmRequest('openai-stream', model, payload, requestUrl, { 'Authorization': 'Bearer ***' });

    dumpLLMPayload({
      source: 'OpenAIProvider.chatStreamedWithChatCompletions',
      url: requestUrl,
      model,
      apiKeyPrefix: typeof this.apiKey === 'string' ? this.apiKey.slice(0, 12) : '(empty)',
      payload,
    });

    {
      const payloadBytes = JSON.stringify(payload).length;
      const lastMsg = payload.messages?.[payload.messages.length - 1];
      const lastMsgPreview = typeof lastMsg?.content === 'string'
        ? lastMsg.content.replace(/\n/g, '↵').substring(0, 100)
        : Array.isArray(lastMsg?.content) ? `[${lastMsg.content.length} parts]` : '(null)';
      const roles = payload.messages?.map((m: any) => m.role).join(',') ?? '';
      cliLogger.info('OpenAI', `[HTTP_REQ] POST ${requestUrl} (stream) | model=${model} msgs=${payload.messages?.length} tools=${payload.tools?.length ?? 0} payload=${(payloadBytes / 1024).toFixed(1)}KB | roles=[${roles}] | last=[${lastMsg?.role}] "${lastMsgPreview}"`);
    }

    if (process.env.CLI_DEBUG === '1') {
      cliLogger.debug('OpenAI', 'Chat Completions Stream Request', {
        url: requestUrl,
        endpoint: this.apiEndpoint,
        payload: payload
      });
    }

    const maxStreamRetries = this.retryConfig.streamMaxRetries;
    let streamRetries = 0;

    while (true) {
      let cleanupAttempt: (() => void) | undefined;
      let emittedStreamEvent = false;
      try {
        // Check if already aborted before making request
        if (signal?.aborted) {
          const abortError = new Error('Request aborted') as AbortLikeError;
          abortError.name = 'AbortError';
          throw abortError;
        }

        const startTime = Date.now();
        // hanging in the background. Use a per-attempt AbortController and wire it to the caller
        // signal so header wait actually stops and the runtime can emit run_result/error.
        const connectTimeoutMs = this.retryConfig.connectTimeoutMs;
        const attemptController = new AbortController();
        const abortAttempt = (reason?: any) => {
          if (!attemptController.signal.aborted) {
            attemptController.abort(reason);
          }
        };
        const onCallerAbort = () => abortAttempt(signal?.reason ?? new Error('Request aborted'));
        if (signal?.aborted) onCallerAbort();
        else signal?.addEventListener('abort', onCallerAbort, { once: true });

        const connectTimer = setTimeout(() => {
          const err = Object.assign(
            new Error(`Connect timeout: no response headers in ${connectTimeoutMs}ms`),
            { code: 'NEOX_CONNECT_TIMEOUT', retryable: true }
          );
          cliLogger.warn('OpenAI', 'Connect timeout triggered — aborting stream request', {
            model,
            endpoint: this.apiEndpoint,
            connectTimeoutMs,
            requestTimeoutMs: this.streamRequestTimeoutMs,
          });
          abortAttempt(err);
        }, connectTimeoutMs);
        if (connectTimer.unref) connectTimer.unref();

        let attemptStream: { destroy?: () => void } | undefined;
        cleanupAttempt = () => {
          clearTimeout(connectTimer);
          signal?.removeEventListener('abort', onCallerAbort);
          attemptStream?.destroy?.();
          abortAttempt();
        };
        let response;
        try {
          response = await this.client.post(this.apiEndpoint, payload, {
            responseType: 'stream',
            signal: attemptController.signal,
            timeout: Math.min(this.streamRequestTimeoutMs, Math.max(connectTimeoutMs + 15_000, connectTimeoutMs)),
            ...(options.effortLevel && !['standard', 'medium'].includes(options.effortLevel)
              ? { headers: { 'X-Neox-Effort': options.effortLevel } } as any
              : {}),
          });
          attemptStream = response.data;
        } catch (err: any) {
          attemptStream = err.response?.data;
          const reason = attemptController.signal.reason as any;
          if (attemptController.signal.aborted && reason?.code === 'NEOX_CONNECT_TIMEOUT') {
            throw reason;
          }
          throw err;
        } finally {
          if (connectTimer) clearTimeout(connectTimer);
        }

        if (process.env.CLI_DEBUG === '1') {
          cliLogger.debug('OpenAI', 'Stream Started', { status: response.status });
        }

        if (response.status !== 200) {
          let errorData = '';
          for await (const chunk of response.data) {
            errorData += chunk.toString();
          }
          throw new Error(`OpenAI API error: ${response.status} - ${errorData}`);
        }

        const streamForParse: any = response.data;
        // 根据流格式选择解析器
        const parsedStream = this.streamFormat === 'anthropic'
          ? this.parseAnthropicStreamResponse(streamForParse)
          : this.parseOpenAIStreamResponse(streamForParse, signal, {
            requireDone: false,
            responseMeta: {
              status: response.status,
              contentType: String(response.headers?.['content-type'] ?? ''),
              endpoint: `${this.client.defaults.baseURL ?? ''}${this.apiEndpoint}`,
            },
          });
        for await (const chunk of parsedStream) {
          emittedStreamEvent = true;
          yield chunk;
        }

        const duration = Date.now() - startTime;
        logger.llmResponse('openai-stream', duration, {}, {});

        if (process.env.CLI_DEBUG === '1') {
          cliLogger.debug('OpenAI', 'Stream Complete', { duration: `${duration}ms` });
        }

        return;

      } catch (error: any) {
        if (signal?.aborted) {
          throw Object.assign(new Error('Request aborted'), { name: 'AbortError' });
        }
        // 需要先尝试读取 stream 内容，提取真实错误信息
        if (error.response?.data) {
          const data = error.response.data;
          // Case 1: data 是 ReadableStream（未消费）
          if (typeof data?.on === 'function' || typeof data?.[Symbol.asyncIterator] === 'function') {
            try {
              let streamBody = '';
              for await (const chunk of data) {
                streamBody += chunk.toString();
                if (streamBody.length > 2000) break;
              }
              if (streamBody) {
                const parsed = await safeJSONParse(streamBody);
                if (parsed) {
                  error.response.data = parsed;
                } else {
                  error.response.data = streamBody;
                }
                const apiMsg = parsed?.error?.message || parsed?.message;
                if (apiMsg && error.message === `Request failed with status code ${error.response.status}`) {
                  error.message = apiMsg;
                }
              }
            } catch {
              // stream 读取失败，保持原样
            }
          }
          // Case 2: data 是空对象 {}（stream 已被消费），axios 消息是泛化的
          else if (typeof data === 'object' && Object.keys(data).length === 0) {
            if (error.message === `Request failed with status code ${error.response.status}`) {
              error.message = `API error ${error.response.status}: ${model} - response body was empty (stream consumed). Check model parameters.`;
            }
          }
        }

        // Close the failed socket before waiting or starting another attempt.
        cleanupAttempt?.();
        cleanupAttempt = undefined;
        if (signal?.aborted) {
          throw Object.assign(new Error('Request aborted'), { name: 'AbortError' });
        }
        const classifiedError = classifyError(error);

        // 始终打印请求 URL，方便排查代理问题
        cliLogger.error('OpenAI', `Stream Error - Request URL: ${requestUrl}`);
        cliLogger.error('OpenAI', `Error: ${error.message}`);
        cliLogger.error('OpenAI', 'Stream Error Meta', {
          code: error?.code,
          errno: error?.errno,
          syscall: error?.syscall,
          status: error?.response?.status,
          requestId:
            error?.response?.headers?.['x-request-id'] ||
            error?.response?.headers?.['request-id'] ||
            error?.response?.headers?.['openai-request-id'],
        });
        cliLogger.warn('OpenAI', 'Stream Retry Diagnostic', {
          model,
          baseUrl: this.baseUrl,
          endpoint: this.apiEndpoint,
          useResponsesAPI: this.useResponsesAPI,
          streamFormat: this.streamFormat,
          profile: this.modelProfile?.id,
          profileSources: this.modelProfile?.sourceProfileIds,
          requestTimeoutMs: this.streamRequestTimeoutMs,
          streamRetries,
          maxStreamRetries,
          classifiedCode: classifiedError.code,
          classifiedCategory: classifiedError.category,
          classifiedRetryable: classifiedError.retryable,
          classifiedRetryAfterMs: classifiedError.retryAfter,
          errorName: error?.name,
          errorCode: error?.code,
          errorErrno: error?.errno,
          errorSyscall: error?.syscall,
          hasResponse: Boolean(error?.response),
          status: error?.response?.status,
        });
        if (error.response?.data) {
          try {
            const data = error.response.data;
            if (typeof data === 'string') {
              cliLogger.error('OpenAI', `Response: ${data.substring(0, 500)}`);
            } else if (data && typeof data === 'object') {
              const safeData = { error: data.error, message: data.message, type: data.type, code: data.code };
              cliLogger.error('OpenAI', `Response: ${JSON.stringify(safeData).substring(0, 500)}`);
            }
          } catch {
            cliLogger.error('OpenAI', 'Response: [Could not serialize error data]');
          }
        }
        if (process.env.CLI_DEBUG === '1') {
          cliLogger.debug('OpenAI', 'Stream Error Details', {
            url: requestUrl,
            message: error.message,
            retryable: classifiedError.retryable,
            status: error.response?.status,
          });
        }

        logger.llmError('openai-stream', error);

        // Once events have escaped, replaying the payload could duplicate text or tool calls.
        if (!emittedStreamEvent && classifiedError.retryable && streamRetries < maxStreamRetries) {
          streamRetries++;

          const retryAfter = error.response?.headers?.['retry-after'];
          const serverDelay = parseRetryAfter(retryAfter);
          const delay = getRetryDelay(serverDelay, streamRetries, this.retryConfig);

          cliLogger.info('OpenAI',
            `Stream failed (${classifiedError.code}), ` +
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
            await abortableSleep(delay, signal);
          } catch (abortError: any) {
            if (abortError?.name === 'AbortError') {
              throw abortError;
            }
            throw abortError;
          }

          // anthropic.ts 已有此逻辑, openai.ts 之前缺失导致 banner 卡在 "重连中".
          yield {
            choices: [],
            type: 'stream_recovered',
            attempt: streamRetries,
            maxRetries: maxStreamRetries,
          };
          continue;
        }

        throw classifiedError;
      } finally {
        cleanupAttempt?.();
      }
    }
  }

  private buildChatCompletionsPayload(
    messages: Message[],
    options: {
      model: string;
      tools?: Tool[];
      temperature: number;
      structuredOutput?: StructuredOutputDefinition;
      maxInputTokens?: number;
      maxOutputTokens?: number;
      stream: boolean;
      prediction?: { type: 'content'; content: string };
      effortLevel?: string;
    }
  ): ChatCompletionsRequest {
    const { model: rawModel, tools, temperature, structuredOutput, maxInputTokens, stream, prediction, effortLevel } = options;
    /* Phase 2.5: schema effort_map 解析. 三件事:
     *   1. upstream_slug_override — 整体换 upstream slug (fast → -fast 变体)
     *   2. payload fields spread — thinking/reasoning_effort/verbosity 等家族字段
     *   3. billing_multiplier — 仅供 UI 显示, 计费在网关侧应用; 这里不动 payload */
    let model = rawModel;
    let effortPayloadExtras: Record<string, unknown> | null = null;
    const effectiveEffortLevel = effortLevel ?? resolveDefaultThinkingLevel(rawModel) ?? undefined;
    if (effectiveEffortLevel) {
      const resolved = resolveEffortPayload(rawModel, effectiveEffortLevel);
      if (resolved.upstreamSlugOverride) model = resolved.upstreamSlugOverride;
      if (Object.keys(resolved.payload).length > 0) effortPayloadExtras = resolved.payload;
    }

    const formattedMessages = this.formatMessagesForChatCompletions(messages, model);

    // 检测是否是豆包 API（对参数支持有限制）
    const isDoubaoAPI = this.baseUrl.includes('ark.cn-beijing.volces.com');

    // 豆包 API 使用精简的 payload，只保留基础参数
    if (isDoubaoAPI) {
      const doubaoPayload: ChatCompletionsRequest = {
        model,
        messages: formattedMessages,
        stream,
      };

      // 深度思考配置（仅对 doubao-seed 系列模型有效）
      if (this.doubaoThinking && model.includes('doubao-seed')) {
        doubaoPayload.thinking = {
          type: this.doubaoThinking.type,
        };

        if (process.env.CLI_DEBUG === '1') {
          cliLogger.debug('OpenAI', `Doubao thinking mode: ${this.doubaoThinking.type}`);
        }
      }

      // 工具调用
      if (tools && tools.length > 0) {
        doubaoPayload.tools = tools.map(tool => ({
          type: 'function' as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        }));

        if (process.env.CLI_DEBUG === '1') {
          cliLogger.debug('OpenAI', `Added ${doubaoPayload.tools.length} tools to Doubao payload`);
        }
      }

      dumpLlmPayloadIfEnabled('openai-doubao', doubaoPayload);
      return doubaoPayload;
    }

    // 标准 OpenAI 兼容 API 使用完整 payload
    const payload: ChatCompletionsRequest = {
      model,
      messages: formattedMessages,
      temperature,
      stream,
    };

    // 流式选项 - 请求返回 usage 统计
    if (stream) {
      payload.stream_options = { include_usage: true };
    }

    //   旧 bug: payload.max_tokens = maxInputTokens(往往是 200000/400000/1000000 这种 context size)
    //   把 context window 当 output 上限传给上游, Anthropic/代理会按这个值预留 token 预算,
    //   导致首字延迟显著拉长, 长任务直接 STREAM_TIMEOUT.
    //   Claude Code 等成熟客户端默认 max_tokens=32000 左右, 我们对齐到 32K 上限.
    //
    //   字段名按 family 选 (OpenAI gpt-5+ / Kimi k2.5+ 把 max_tokens deprecated, 新名是 max_completion_tokens.
    //   DeepSeek / GLM / Anthropic 仍用 max_tokens 不变.
    //   详见 内部设计文档 §3 §4):
    const useMaxCompletionTokens =
      /^gpt-5/i.test(model) ||  /* OpenAI GPT-5 系 */
      /^o[345]/i.test(model) || /* OpenAI o3/o4/o5 reasoning 系 */
      /^kimi-k2/i.test(model);  /* Kimi k2+ 新协议 */
    const outputCap = options.maxOutputTokens && options.maxOutputTokens > 0
      ? options.maxOutputTokens
      : 32000;
    if (useMaxCompletionTokens) {
      payload.max_completion_tokens = outputCap;
    } else {
      payload.max_tokens = outputCap;
    }

    if (this.sessionId && process.env.NEOX_DISABLE_PROMPT_CACHE_KEY !== '1' && supportsPromptCacheKey(model)) {
      payload.prompt_cache_key = this.sessionId;
    }


    // 工具
    if (tools && tools.length > 0) {
      payload.tools = tools.map(tool => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));

      if (process.env.CLI_DEBUG === '1') {
        cliLogger.debug('OpenAI', `Added ${payload.tools.length} tools to Chat Completions payload`);
      }
    }

    if (payload.messages.length > 0) {
      this.injectPromptCacheBreakpoints(payload, model);
    }

    // 响应格式
    if (structuredOutput) {
      if (this.structuredOutputMode === 'json_object') {
        payload.response_format = { type: 'json_object' };
      } else {
        payload.response_format = {
          type: 'json_schema',
          json_schema: {
            name: structuredOutput.name,
            schema: structuredOutput.schema,
            strict: structuredOutput.strict ?? true,
          },
        };
      }
    }

    if (prediction) {
      payload.prediction = prediction;
      if (process.env.CLI_DEBUG === '1') {
        cliLogger.debug('OpenAI', `Predicted Outputs enabled: ${prediction.content.length} chars`);
      }
    }

    /* Phase 2.5: 应用 effort_map extras (thinking / reasoning_effort / verbosity / etc).
     *   覆盖前面计算出的 reasoning_effort (用户显式选 effort > profile default). */
    if (effortPayloadExtras) {
      Object.assign(payload as unknown as Record<string, unknown>, effortPayloadExtras);
    }

    // PII 字段过滤
    const finalPayload = removeDisabledFields(payload, this.privacySettings);
    dumpLlmPayloadIfEnabled('openai', finalPayload);
    return finalPayload;
  }

  private injectPromptCacheBreakpoints(payload: ChatCompletionsRequest, model: string): void {
    const schema: any = getSchemaRegistry().resolveModel(model);
    const pc = schema?.capabilities?.prompt_cache;
    if (!schema || !pc?.supported) return;

    if (pc.type !== 'ephemeral') return;

    const targets: ('tools_last' | 'system_first' | 'last_user_or_tool')[] =
      pc.breakpoint_targets ?? ['tools_last', 'system_first', 'last_user_or_tool'];
    const messages = payload.messages;
    if (targets.includes('tools_last') && payload.tools && payload.tools.length > 0) {
      (payload.tools[payload.tools.length - 1] as any).cache_control = { type: 'ephemeral' };
    }
    if (targets.includes('system_first') && messages[0]?.role === 'system') {
      this.addCacheControlToMessageContent(messages[0]);
    }
    if (targets.includes('last_user_or_tool')) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === 'user' || m.role === 'tool') {
          this.addCacheControlToMessageContent(m);
          break;
        }
      }
    }
  }


  /** content string → wrap [{type:'text', text, cache_control}]; array → 末尾 block 加 cache_control. */
  private addCacheControlToMessageContent(msg: OpenAIMessage): void {
    if (typeof msg.content === 'string') {
      const text = msg.content;
      if (!text || text.length === 0) return;
      msg.content = [{ type: 'text', text, cache_control: { type: 'ephemeral' } } as MediaContent];
      return;
    }
    if (Array.isArray(msg.content) && msg.content.length > 0) {
      const last = msg.content[msg.content.length - 1];
      if (last && typeof last === 'object') {
        last.cache_control = { type: 'ephemeral' };
      }
    }
  }

  private sanitizeMessagesForOpenAI(messages: Message[]): Message[] {
    if (messages.length === 0) return messages;
    const firstNonSystemIdx = messages.findIndex(m => m.role !== 'system');
    if (firstNonSystemIdx === -1) return messages;
    return messages.map((msg, idx) => {
      if (msg.role !== 'system') return msg;
      if (idx < firstNonSystemIdx) return msg;
      /* 中段 / 末尾的 system → user 带 [System note]: 前缀 */
      const text = typeof msg.content === 'string'
        ? msg.content
        : (Array.isArray(msg.content) ? getTextFromContent(msg.content) : '');
      return {
        ...msg,
        role: 'user' as const,
        content: text ? `[System note]: ${text}` : msg.content,
      };
    });
  }

  private formatMessagesForChatCompletions(messages: Message[], model?: string): OpenAIMessage[] {
    const reasoningPassback = resolveReasoningPassbackPolicy(model);
    return this.sanitizeMessagesForOpenAI(messages)
      .filter(msg => {
        const hasContent = msg.content && (
          typeof msg.content === 'string'
            ? msg.content.trim().length > 0
            : Array.isArray(msg.content) && msg.content.length > 0
        );
        const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
        return hasContent || hasToolCalls;
      })
      .map(msg => {
        const formatted: OpenAIMessage = {
          role: msg.role as OpenAIMessage['role'],
          content: null,
        };

        // 处理 tool result：应用 Codex-style 截断防止上下文爆炸
        if (msg.role === 'tool') {
          if (Array.isArray(msg.content) && msg.content.some((p: any) => p?.type === 'image_url')) {
            // 多模态 tool result (包含图片) — 保留原始 content parts (同样归一 url)
            formatted.content = normalizeImagePartsInContent(msg.content) as MediaContent[];
          } else {
            const rawContent = typeof msg.content === 'string'
              ? msg.content
              : getTextFromContent(msg.content);
            formatted.content = truncateToolOutput(rawContent, WIRE_TOOL_OUTPUT_MAX_UNITS);
          }
        }
        // 处理多模态内容
        else if (Array.isArray(msg.content)) {
          /* 发线前归一 image_url —— 裸 base64 (没有 data: 前缀) 上游一律 400,
           * 而它一旦进了历史就每轮重传, 会话被永久钉死 (见 imageUrlNormalize 文件头)。 */
          formatted.content = normalizeImagePartsInContent(msg.content) as MediaContent[];
        } else if (msg.tool_calls && msg.tool_calls.length > 0) {
          formatted.content = msg.content || '';
        } else {
          formatted.content = msg.content || null;
        }

        if (msg.name) formatted.name = msg.name;
        if (msg.tool_call_id) formatted.tool_call_id = msg.tool_call_id;
        if (msg.tool_calls) {
          formatted.tool_calls = msg.tool_calls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          }));
        }

        /* Family-declared passback. DeepSeek with tools requires reasoning from
         * every assistant turn, not only messages containing tool_calls. */
        if (msg.role === 'assistant') {
          const keep =
            reasoningPassback === 'always' ||
            (reasoningPassback === 'with_tool_calls' && !!msg.tool_calls && msg.tool_calls.length > 0);
          if (keep && typeof msg.reasoning_content === 'string') {
            formatted.reasoning_content = msg.reasoning_content;
          } else if (reasoningPassback === 'always') {
            // Legacy/non-thinking history has no reasoning to replay, but the field is required.
            formatted.reasoning_content = '';
          }
        }

        return formatted;
      });
  }

  // ============================================================================
  // Responses API 实现
  // ============================================================================

  private async chatWithResponsesAPI(
    messages: Message[],
    options: {
      model?: string;
      tools?: Tool[];
      temperature?: number;
      structuredOutput?: StructuredOutputDefinition;
      maxInputTokens?: number;
      reasoningEffortOverride?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
    }
  ): Promise<ChatCompletionResponse> {
    // Responses API 要求 stream=true，所以收集流式响应
    const contentChunks: string[] = [];
    const toolCalls: IndexedToolCall[] = [];
    const toolCallSlots = new ToolCallSlotTracker();
    let usage: UsageStats | undefined;
    let finishReason = 'stop';

    for await (const chunk of this.chatStreamedWithResponsesAPI(messages, options)) {
      const delta = chunk.choices?.[0]?.delta;
      if (delta) {
        if (delta.content) contentChunks.push(delta.content);
        if (delta.tool_calls) {
          for (const toolCall of delta.tool_calls) {
            /* 槽位归属跟 runner 同一套规则 (同 index 带新 id = 新调用), 见 streamToolCallSlots.ts */
            const slot = toolCallSlots.resolve(toolCall);
            const existing = toolCalls.find(tc => tc.index === slot);
            if (existing) {
              if (toolCall.function?.arguments) {
                existing.function.arguments += toolCall.function.arguments;
              }
            } else {
              toolCalls.push({
                id: toolCall.id || `call_${toolCalls.length}`,
                type: 'function',
                function: {
                  name: toolCall.function?.name || '',
                  arguments: toolCall.function?.arguments || '',
                },
                index: slot,
              } as ToolCall & { index?: number });
            }
          }
        }
      }

      if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
      if (chunk.usage) {
        usage = chunk.usage;
      }
    }

    return {
      id: `chatcmpl-${Date.now()}`,
      choices: [{
        message: {
          role: 'assistant',
          content: contentChunks.length > 0 ? contentChunks.join('') : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      }],
      usage: usage || { total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 },
    };
  }

  private async *chatStreamedWithResponsesAPI(
    messages: Message[],
    options: {
      model?: string;
      tools?: Tool[];
      temperature?: number;
      structuredOutput?: StructuredOutputDefinition;
      maxInputTokens?: number;
      signal?: AbortSignal;
      reasoningEffortOverride?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
    }
  ): AsyncGenerator<StreamChunk> {
    const { model = this.defaultModel, tools, temperature = 0.7, structuredOutput, maxInputTokens, signal, reasoningEffortOverride } = options;
    let payload = this.buildResponsesAPIPayload(messages, {
      model,
      tools,
      temperature,
      structuredOutput,
      maxInputTokens,
      reasoningEffortOverride,
    });

    const requestUrl = `${this.client.defaults.baseURL}/responses`;
    cliLogger.info('NEOX_DIAG', 'responses-stream-open', {
      url: requestUrl,
      model,
      apiKeyPrefix: typeof this.apiKey === 'string' ? this.apiKey.slice(0, 12) + '...' : '(empty)',
      useResponsesAPI: this.useResponsesAPI,
    });
    logger.llmRequest('openai-responses-stream', model, payload, requestUrl, { 'Authorization': 'Bearer ***' });

    {
      const payloadBytes = JSON.stringify(payload).length;
      const inputItems = Array.isArray(payload.input) ? payload.input.length : 0;
      const lastInput = Array.isArray(payload.input) ? payload.input[payload.input.length - 1] : null;
      const lastRole = lastInput?.role ?? lastInput?.type ?? '?';
      const lastPreview = typeof lastInput?.content === 'string'
        ? lastInput.content.replace(/\n/g, '↵').substring(0, 100)
        : '(structured)';
      cliLogger.info('OpenAI', `[HTTP_REQ] POST ${requestUrl} (responses-stream) | model=${model} inputs=${inputItems} tools=${payload.tools?.length ?? 0} payload=${(payloadBytes / 1024).toFixed(1)}KB | last=[${lastRole}] "${lastPreview}"`);
    }

    dumpLlmPayloadIfEnabled('openai-responses', payload);

    if (process.env.CLI_DEBUG === '1') {
      cliLogger.info('OpenAI', 'Responses API Stream Request', {
        url: requestUrl,
        toolsCount: payload.tools?.length || 0,
      });
      if (process.env.CLI_DEBUG_PAYLOAD === '1') {
        cliLogger.debug('OpenAI', 'Full Payload', payload);
      }

      const curlCommand = generateCurlCommand(
        requestUrl,
        {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'Authorization': `Bearer ${this.apiKey}`,
          'conversation_id': headerSafeSessionId(this.sessionId),
          'session_id': headerSafeSessionId(this.sessionId),
          'user-agent': 'neox-cli/1.0.0',
        },
        payload,
        false,   /* body 不遮: 缓存前缀 drift 就是要 diff 完整 payload 才定得了罪 */
      );

      cliLogger.info('CURL', '═'.repeat(80));
      cliLogger.info('CURL', 'Responses API CURL (凭证已遮蔽, 复制后自行替换):');
      cliLogger.info('CURL', curlCommand);
      cliLogger.info('CURL', '═'.repeat(80));
    }

    const maxStreamRetries = this.retryConfig.streamMaxRetries;
    let streamRetries = 0;

    while (true) {
      let cleanupAttempt: (() => void) | undefined;
      let emittedStreamEvent = false;
      try {
        if (signal?.aborted) {
          const abortError = new Error('Request aborted') as AbortLikeError;
          abortError.name = 'AbortError';
          throw abortError;
        }

        const startTime = Date.now();

        const headers: Record<string, string> = {
          'Accept': 'text/event-stream',
          'conversation_id': headerSafeSessionId(this.sessionId),
          'session_id': headerSafeSessionId(this.sessionId),
          'originator': 'codex_cli_rs',
          'x-codex-beta-features': 'shell_snapshot',
        };

        // axios/socket alive and can keep the agent turn stuck after the UI has no events.
        const connectTimeoutMs = this.retryConfig.connectTimeoutMs;
        const attemptController = new AbortController();
        const abortAttempt = (reason?: any) => {
          if (!attemptController.signal.aborted) {
            attemptController.abort(reason);
          }
        };
        const onCallerAbort = () => abortAttempt(signal?.reason ?? new Error('Request aborted'));
        if (signal?.aborted) onCallerAbort();
        else signal?.addEventListener('abort', onCallerAbort, { once: true });

        const connectTimer = setTimeout(() => {
          const err = Object.assign(
            new Error(`Connect timeout: no response headers in ${connectTimeoutMs}ms`),
            { code: 'NEOX_CONNECT_TIMEOUT', retryable: true }
          );
          cliLogger.warn('OpenAI', 'Connect timeout triggered — aborting responses stream request', {
            model,
            connectTimeoutMs,
            requestTimeoutMs: this.streamRequestTimeoutMs,
          });
          abortAttempt(err);
        }, connectTimeoutMs);
        if (connectTimer.unref) connectTimer.unref();

        let attemptStream: { destroy?: () => void } | undefined;
        cleanupAttempt = () => {
          clearTimeout(connectTimer);
          signal?.removeEventListener('abort', onCallerAbort);
          attemptStream?.destroy?.();
          abortAttempt();
        };
        let response;
        try {
          response = await this.client.post('/responses', payload, {
            responseType: 'stream',
            signal: attemptController.signal,
            headers,
            timeout: Math.min(this.streamRequestTimeoutMs, Math.max(connectTimeoutMs + 15_000, connectTimeoutMs)),
          });
          attemptStream = response.data;
        } catch (err: any) {
          attemptStream = err.response?.data;
          const reason = attemptController.signal.reason as any;
          if (attemptController.signal.aborted && reason?.code === 'NEOX_CONNECT_TIMEOUT') {
            throw reason;
          }
          throw err;
        } finally {
          if (connectTimer) clearTimeout(connectTimer);
        }

        if (process.env.CLI_DEBUG === '1') {
          cliLogger.debug('OpenAI', 'Responses API Stream Started', { status: response.status });
        }

        if (response.status !== 200) {
          let errorData = '';
          for await (const chunk of response.data) {
            errorData += chunk.toString();
          }
          const formatted = formatErrorForUI(errorData, response.status);
          throw new Error(`OpenAI Responses API error: ${response.status} - ${formatted.message}`);
        }

        const parsedStream = this.parseResponsesAPIStream(response.data, signal, {
          status: response.status,
          contentType: String(response.headers?.['content-type'] ?? ''),
          endpoint: `${this.client.defaults.baseURL ?? ''}/responses`,
        });
        for await (const chunk of parsedStream) {
          emittedStreamEvent = true;
          yield chunk;
        }

        const duration = Date.now() - startTime;
        logger.llmResponse('openai-responses-stream', duration, {}, {});

        if (process.env.CLI_DEBUG === '1') {
          cliLogger.debug('OpenAI', 'Responses API Stream Complete', { duration: `${duration}ms` });
        }

        return;
      } catch (error: any) {
        if (signal?.aborted) {
          throw Object.assign(new Error('Request aborted'), { name: 'AbortError' });
        }
        // 提取错误数据 - 处理流响应和循环引用
        let errorData: string | undefined;
        const status = error.response?.status;

        if (error.response?.data) {
          const data = error.response.data;
          try {
            // 如果 data 是流（有 on 方法），需要读取它
            if (data && typeof data.on === 'function') {
              let streamData = '';
              try {
                for await (const chunk of data) {
                  streamData += chunk.toString();
                  if (streamData.length > 2000) break;
                }
                errorData = streamData;
              } catch {
                errorData = '[Could not read error stream]';
              }
            } else if (typeof data === 'string') {
              errorData = data;
            } else if (data && typeof data === 'object') {
              // 安全提取可序列化的属性
              const safeData = {
                error: data.error,
                message: data.message,
                type: data.type,
                code: data.code,
              };
              errorData = JSON.stringify(safeData);
            }
          } catch {
            errorData = '[Could not parse error data]';
          }
        }

        cleanupAttempt?.();
        cleanupAttempt = undefined;
        if (signal?.aborted) {
          throw Object.assign(new Error('Request aborted'), { name: 'AbortError' });
        }
        if (process.env.CLI_DEBUG === '1') {
          cliLogger.error('OpenAI', 'Responses API Stream Error', {
            status,
            errorData,
            message: error.message,
          });
        }

        cliLogger.error('OpenAI', 'Responses Stream Error - Request URL: ' + requestUrl);
        cliLogger.error('OpenAI', 'Error: ' + (error.message || 'Unknown error'));
        cliLogger.error('OpenAI', 'Responses Stream Error Meta', {
          model,
          code: error?.code,
          errno: error?.errno,
          syscall: error?.syscall,
          status,
          requestId:
            error?.response?.headers?.['x-request-id'] ||
            error?.response?.headers?.['request-id'] ||
            error?.response?.headers?.['openai-request-id'],
          streamRetries,
          maxStreamRetries,
          timeoutMs: this.streamRequestTimeoutMs,
        });

        logger.llmError('openai-responses-stream', error);

        const classifiedError = classifyError(error);
        cliLogger.warn('OpenAI', 'Responses Retry Diagnostic', {
          model,
          baseUrl: this.baseUrl,
          endpoint: '/responses',
          useResponsesAPI: this.useResponsesAPI,
          profile: this.modelProfile?.id,
          profileSources: this.modelProfile?.sourceProfileIds,
          requestTimeoutMs: this.streamRequestTimeoutMs,
          streamRetries,
          maxStreamRetries,
          classifiedCode: classifiedError.code,
          classifiedCategory: classifiedError.category,
          classifiedRetryable: classifiedError.retryable,
          classifiedRetryAfterMs: classifiedError.retryAfter,
          errorName: error?.name,
          errorCode: error?.code,
          errorErrno: error?.errno,
          errorSyscall: error?.syscall,
          hasResponse: Boolean(error?.response),
          status,
        });

        if (!emittedStreamEvent && classifiedError.retryable && streamRetries < maxStreamRetries) {
          streamRetries++;

          const retryAfter = error.response?.headers?.['retry-after'];
          const serverDelay = parseRetryAfter(retryAfter);
          const delay = getRetryDelay(serverDelay, streamRetries, this.retryConfig);

          cliLogger.info('OpenAI',
            `Responses stream failed (${classifiedError.code}), ` +
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

          await abortableSleep(delay, signal);

          yield {
            choices: [],
            type: 'stream_recovered',
            attempt: streamRetries,
            maxRetries: maxStreamRetries,
          };
          continue;
        }

        if (status && errorData) {
          const formatted = formatErrorForUI(errorData, status);
          const enriched: any = new Error(`${formatted.message}${formatted.detail ? '\n' + formatted.detail : ''}`);
          enriched.code = `HTTP_${status}`;
          enriched.httpStatus = status;
          enriched.rawBody = typeof errorData === 'string' ? errorData.slice(0, 800) : JSON.stringify(errorData).slice(0, 800);
          enriched.retryable = false;
          throw enriched;
        }

        throw classifiedError;
      } finally {
        cleanupAttempt?.();
      }
    }
  }

  private buildResponsesAPIPayload(
    messages: Message[],
    options: {
      model: string;
      tools?: Tool[];
      temperature: number;
      structuredOutput?: StructuredOutputDefinition;
      maxInputTokens?: number;
      reasoningEffortOverride?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
    }
  ): ResponsesAPIRequest {
    const { model, tools, temperature, structuredOutput, maxInputTokens, reasoningEffortOverride } = options;

    const input = this.convertToResponsesInput(messages);
    const instructions = this.buildResponsesInstructions(model)
      ?? this.extractResponsesInstructionsFromSystemMessages(messages);

    // Codex 真实请求总是包含 instructions，字段顺序：model, instructions, input, ...
    if (!instructions) {
      throw new Error('[OpenAI Responses API] instructions field is required but no system message found');
    }

    // Responses API 要求至少有一条 user 消息
    if (!input || input.length === 0) {
      throw new Error('[OpenAI Responses API] input array is empty - at least one user message is required');
    }

    if (process.env.CLI_DEBUG === '1') {
      cliLogger.debug('OpenAI', 'Building Responses API payload', {
        instructionsLength: instructions.length,
        instructionsPreview: instructions.substring(0, 300),
        inputItems: input.length,
        inputPreview: JSON.stringify(input.slice(0, 2), null, 2)
      });

      cliLogger.debug('OpenAI', 'Full input array for Response API:', {
        totalMessages: messages.length,
        messageRoles: messages.map(m => m.role),
        inputCount: input.length,
        fullInput: JSON.stringify(input, null, 2)
      });

      // 验证 function_call 和 function_call_output 的 ID 匹配
      const functionCalls = input.filter((item: any) => item.type === 'function_call');
      const functionOutputs = input.filter((item: any) => item.type === 'function_call_output');

      cliLogger.debug('OpenAI', 'Function call ID matching check:', {
        callCount: functionCalls.length,
        outputCount: functionOutputs.length,
        callIds: functionCalls.map((c: any) => ({ id: c.id || c.call_id, name: c.name })),
        outputIds: functionOutputs.map((o: any) => ({ call_id: o.call_id })),
      });

      // 检查是否有未匹配的 output
      const callIdSet = new Set(functionCalls.map((c: any) => c.call_id || c.id));
      const unmatchedOutputs = functionOutputs.filter((o: any) => !callIdSet.has(o.call_id));
      if (unmatchedOutputs.length > 0) {
        cliLogger.warn('OpenAI', `⚠️ Found ${unmatchedOutputs.length} unmatched function_call_output!`, {
          unmatchedCallIds: unmatchedOutputs.map((o: any) => o.call_id)
        });
      }
    }

    // JSON.stringify 会保留插入顺序，字段顺序会直接影响 prompt cache 的前缀匹配
    const payload = {
      model,
      instructions,
    } as ResponsesAPIRequest;

    // 优先级：per-call override (side-agent) > 模型配置 > 环境变量 > profile 默认 > 无
    // 注: reasoning 配置必须先于 tools 计算, 因为 effort=minimal 时 parallel_tool_calls 要 force false
    const baseReasoning = getReasoningSettings(true, this.modelConfig, this.modelProfile?.reasoning);
    const reasoningSettings = reasoningEffortOverride
      ? { effort: reasoningEffortOverride, summary: baseReasoning?.summary ?? 'auto' }
      : baseReasoning;
    if (reasoningSettings) {
      payload.reasoning = {
        effort: reasoningSettings.effort,
        summary: reasoningSettings.summary || 'auto',
      };
    }

    if (tools && tools.length > 0) {
      const stableTools = [...tools].sort((a, b) => a.name.localeCompare(b.name));
      payload.tools = stableTools.map(tool => this.formatResponsesTool(tool));
      payload.tool_choice = 'auto';
      /* OpenAI Responses API: reasoning_effort=minimal 时 parallel_tool_calls=true 不支持
       * (400 或静默降级). 强制 demotion 到 false, 避免报错. 详见 内部设计文档 §4. */
      const profileParallel = this.transportProfile?.parallelToolCalls ?? true;
      if (reasoningSettings?.effort === 'minimal') {
        payload.parallel_tool_calls = false;
        if (profileParallel) {
          cliLogger.debug('OpenAI', 'parallel_tool_calls force-disabled (reasoning_effort=minimal incompatible)');
        }
      } else {
        payload.parallel_tool_calls = profileParallel;
      }

      if (process.env.CLI_DEBUG === '1') {
        cliLogger.debug('OpenAI', `Added ${payload.tools.length} tools`);
      }
    }

    // Codex 源码: model_verbosity → Responses API text: { verbosity: 'low' | 'medium' | 'high' }
    const envVerbosity = process.env.NEOX_VERBOSITY as 'low' | 'medium' | 'high' | undefined;
    if (envVerbosity && ['low', 'medium', 'high'].includes(envVerbosity)) {
      payload.text = { verbosity: envVerbosity };
    }

    // Codex uses: { type: "web_search", external_web_access: true/false }
    // - live: external_web_access = true (real-time internet search)
    // - cached: external_web_access = false (cached search results)
    const webSearchMode = process.env.NEOX_WEB_SEARCH || 'disabled';
    if (webSearchMode !== 'disabled') {
      const webSearchTool: NonNullable<ResponsesAPIRequest['tools']>[number] = webSearchMode === 'live'
        ? { type: 'web_search' as const, external_web_access: true }
        : webSearchMode === 'cached'
          ? { type: 'web_search' as const, external_web_access: false }
          : { type: 'web_search' as const };

      if (payload.tools) {
        const hasWebSearch = payload.tools.some((t: any) => t.type === 'web_search' || t.type === 'web_search_preview' || t.name === 'web_search');
        if (!hasWebSearch) {
          payload.tools.push(webSearchTool);
        }
      } else {
        payload.tools = [webSearchTool];
      }
    }

    payload.store = false;
    payload.stream = true;

    const envServiceTier = process.env.NEOX_SERVICE_TIER;
    if (envServiceTier && envServiceTier !== 'auto') {
      payload.service_tier = envServiceTier;
    }

    const includeFields = new Set<string>(Array.isArray(payload.include) ? payload.include : []);
    if (reasoningSettings) {
      includeFields.add('reasoning.encrypted_content');
    }
    if (webSearchMode !== 'disabled') {
      includeFields.add('web_search_call.action.sources');
    }
    if (includeFields.size > 0) {
      payload.include = Array.from(includeFields).sort();
    }

    payload.prompt_cache_key = this.sessionId;

    payload.input = input;

    // - temperature (已移除)
    // - text (已移除)
    // - max_input_tokens (已移除)
    // - response_format (Codex 不使用 structured output)
    // - metadata, user, etc. (已移除)

    // PII 字段过滤 (保留 store/service_tier 等逻辑)
    const effectivePrivacy = { ...this.privacySettings };
    // 如果用户明确设置了 service_tier，允许透传
    if (payload.service_tier) {
      effectivePrivacy.allowServiceTier = true;
    }
    return removeDisabledFields(payload, effectivePrivacy);
  }

  private buildResponsesInstructions(model: string): string | undefined {
    const cacheKey = `${this.sessionId}::${model}`;
    const cached = this.frozenInstructionsBySessionModel.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const instructions = buildKernelInstructions({
      workDir: process.cwd(),
      language: this.language,
      protocol: 'openai-responses',
      model,
      baseUrl: this.baseUrl,
      modelProfile: this.modelProfile,
    });
    // 纯 kernel(无 systemPrompt 注入)→ 不自建 Neox 指令, 调用方走 messages 传 system
    if (instructions === undefined) return undefined;

    if (process.env.CLI_DEBUG === '1') {
      cliLogger.debug('OpenAI', 'Built Responses instructions from model profile', {
        model,
        profile: this.modelProfile?.id,
        profileSources: this.modelProfile?.sourceProfileIds,
        instructionsLength: instructions.length,
        instructionsPreview: instructions.substring(0, 200),
      });
    }

    if (instructions) {
      this.frozenInstructionsBySessionModel.set(cacheKey, instructions);
    }

    return instructions;
  }

  private extractResponsesInstructionsFromSystemMessages(messages: Message[]): string | undefined {
    const parts = messages
      .filter(msg => msg.role === 'system')
      .map(msg => {
        const text = typeof msg.content === 'string'
          ? msg.content
          : getTextFromContent(msg.content);
        return text?.trim() || '';
      })
      .filter(Boolean);

    if (parts.length === 0) return undefined;
    return parts.join('\n\n');
  }

  private convertToResponsesInput(messages: Message[]): any[] {
    // 而不是把整条 assistant (含 reasoning) 删掉。OpenAI Responses API 要求每个 function_call
    // 必须有同 call_id 的 function_call_output, 否则 400 invalid_prompt。
    // 孤儿的成因: HTTP 401/网络错/用户中断 等导致工具还没执行 LLM 调用就挂了, 旧实现是丢消息,
    // 但这会丢掉 reasoning + 这一轮意图, 模型重连后没法连续推理 — 现在改为合成.
    const nonSystemMessages = messages.filter(msg => msg.role !== 'system');
    const useIncremental = false;
    const conversationItems = this.buildConversationItemsWithSyntheticOutputs(nonSystemMessages);
    const prefixItems: any[] = [];

    // 固定前缀区：所有跨轮稳定上下文都放在历史消息前，保证前缀缓存可命中。
    const agentInstructions = this.getSessionStableAgentInstructions();
    if (agentInstructions && !useIncremental) {
      prefixItems.push({
        type: 'message',
        role: 'user',
        status: 'completed',
        content: [{ type: 'input_text', text: agentInstructions }],
      });
    }

    const memoryContext = this.getSessionStableMemoryContext(messages);
    if (memoryContext && !useIncremental) {
      prefixItems.push({
        type: 'message',
        role: 'developer',
        status: 'completed',
        content: [
          {
            type: 'input_text',
            text: `<memory_context>\n${memoryContext}\n</memory_context>`,
          },
        ],
      });
    }

    const assistantContext = this.getSessionStableAssistantContext(messages);
    if (assistantContext && !useIncremental) {
      prefixItems.push({
        type: 'message',
        role: 'developer',
        status: 'completed',
        content: [{
          type: 'input_text',
          text: `<neox_assistant_persona>\n${assistantContext}\n</neox_assistant_persona>`,
        }],
      });

      if (process.env.CLI_DEBUG === '1') {
        cliLogger.debug('OpenAI', 'Injected assistant context as developer message', {
          length: assistantContext.length,
          preview: assistantContext.substring(0, 200),
        });
      }
    }

    const items = [...prefixItems, ...conversationItems];

    if (process.env.CLI_DEBUG === '1') {
      const functionCalls = items.filter(item => item.type === 'function_call');
      const functionCallOutputs = items.filter(item => item.type === 'function_call_output');

      cliLogger.debug('OpenAI', 'Responses API input structure:', {
        totalItems: items.length,
        prefixItems: prefixItems.length,
        conversationItems: conversationItems.length,
        functionCalls: functionCalls.length,
        functionCallOutputs: functionCallOutputs.length,
      });

      // 记录所有 function_call 和对应的 output
      if (functionCalls.length > 0 || functionCallOutputs.length > 0) {
        cliLogger.debug('OpenAI', 'Function calls in input:',
          functionCalls.map(fc => ({ call_id: fc.call_id, name: fc.name }))
        );
        cliLogger.debug('OpenAI', 'Function call outputs in input:',
          functionCallOutputs.map(fco => ({ call_id: fco.call_id }))
        );

        // 检查是否有 function_call 没有对应的 output
        const callIds = new Set(functionCalls.map(fc => fc.call_id));
        const outputIds = new Set(functionCallOutputs.map(fco => fco.call_id));
        const missingOutputs = [...callIds].filter(id => !outputIds.has(id));

        if (missingOutputs.length > 0) {
          cliLogger.warn('OpenAI', '⚠️ Found function_calls without outputs:', missingOutputs);
        }
      }
    }

    return items;
  }

  private extractMemoryContext(messages: Message[]): string | null {
    const systemMessages = messages.filter(msg => msg.role === 'system');
    const markers = [
      '## 项目记忆',
      '## 上次任务摘要',
      '## Project Memory',
      '## Last Run Summary',
    ];
    for (const msg of systemMessages) {
      const text = typeof msg.content === 'string' ? msg.content : getTextFromContent(msg.content);
      if (!text) continue;
      const sections = markers
        .map(marker => this.extractMarkdownSection(text, marker))
        .filter((section): section is string => Boolean(section));
      if (sections.length > 0) {
        return sections.join('\n\n').trim();
      }
    }
    return null;
  }

  private getSessionStableMemoryContext(messages: Message[]): string | null {
    const cached = this.frozenMemoryContextBySession.get(this.sessionId);
    if (cached) {
      return cached;
    }

    const extracted = this.extractMemoryContext(messages);
    if (extracted && extracted.length > 0) {
      this.frozenMemoryContextBySession.set(this.sessionId, extracted);
    }
    if (extracted && process.env.CLI_DEBUG === '1') {
      cliLogger.debug('OpenAI', 'Frozen memory_context for session', {
        sessionId: this.sessionId,
        length: extracted.length,
        preview: extracted.substring(0, 120),
      });
    }
    return extracted && extracted.length > 0 ? extracted : null;
  }

  private getSessionStableAssistantContext(messages: Message[]): string | null {
    const cached = this.frozenAssistantContextBySession.get(this.sessionId);
    if (cached) {
      return cached;
    }

    const extracted = this.extractAssistantContext(messages);
    if (extracted && extracted.length > 0) {
      this.frozenAssistantContextBySession.set(this.sessionId, extracted);
    }
    if (extracted && process.env.CLI_DEBUG === '1') {
      cliLogger.debug('OpenAI', 'Frozen assistant_context for session', {
        sessionId: this.sessionId,
        length: extracted.length,
        preview: extracted.substring(0, 120),
      });
    }
    return extracted && extracted.length > 0 ? extracted : null;
  }

  private extractMarkdownSection(text: string, heading: string): string | null {
    const startIndex = text.indexOf(heading);
    if (startIndex < 0) return null;

    const afterHeading = text.substring(startIndex + heading.length);
    const nextHeadingRelativeIndex = afterHeading.search(/\n##\s+/);
    const endIndex = nextHeadingRelativeIndex >= 0
      ? startIndex + heading.length + nextHeadingRelativeIndex
      : text.length;
    return text.substring(startIndex, endIndex).trim();
  }

  private extractAssistantContext(messages: Message[]): string | null {
    const systemMessages = messages.filter(msg => msg.role === 'system');

    // agentic 模式下直接冻结并注入首条 system 全量内容，确保 Neox 身份/规则完整保留。
    // 注意：memory_context 在 agentic 模式会单独关闭，避免重复注入相同信息。
    if (this.runtimeMode === 'agentic') {
      for (const msg of systemMessages) {
        const text = typeof msg.content === 'string' ? msg.content : getTextFromContent(msg.content);
        const trimmed = text?.trim();
        if (trimmed && trimmed.length > 50) {
          return trimmed;
        }
      }
      return null;
    }

    // 已知标记：assistant 模式角色/行为规则内容的起始点
    const startMarkers = [
      '## 角色',           // buildAssistantInstructions() 输出起始
      '## 你的工作方式',    // 工作方式
      '## ❗ Neox 行为规则', // quickResponseRule  
    ];

    // 已由 extractMemoryContext 单独处理的标记 — 需要从结果中排除
    const memoryMarkers = [
      '## 项目记忆',
      '## 上次任务摘要',
      '## Project Memory',
      '## Last Run Summary',
      '## 相关记忆',
    ];

    for (const msg of systemMessages) {
      const text = typeof msg.content === 'string' ? msg.content : getTextFromContent(msg.content);
      if (!text) continue;

      // 查找 assistant 内容起始位置（取最早出现的标记）
      let startIndex = -1;
      for (const marker of startMarkers) {
        const idx = text.indexOf(marker);
        if (idx >= 0 && (startIndex < 0 || idx < startIndex)) {
          startIndex = idx;
        }
      }

      if (startIndex < 0) continue;

      // 提取从角色标记开始到结尾的内容
      let contextContent = text.substring(startIndex);

      // 移除已由 extractMemoryContext 单独处理的内存片段
      for (const memMarker of memoryMarkers) {
        const memIdx = contextContent.indexOf(memMarker);
        if (memIdx >= 0) {
          // 找到下一个 ## 标记作为截断点
          const afterMem = contextContent.substring(memIdx + memMarker.length);
          const nextSectionIdx = afterMem.search(/\n## /);
          if (nextSectionIdx >= 0) {
            // 移除 memory 段落，保留后续内容
            contextContent = contextContent.substring(0, memIdx) + afterMem.substring(nextSectionIdx);
          } else {
            // memory 在末尾，直接截断
            contextContent = contextContent.substring(0, memIdx);
          }
        }
      }

      const trimmed = contextContent.trim();
      if (trimmed.length > 50) { // 至少有实质内容才注入
        return trimmed;
      }
    }

    return null;
  }

  private collectMissingToolCallIds(
    assistantMsg: Message,
    allMessages: Message[],
    msgIndex: number,
  ): Array<{ id: string; name: string; arguments: string }> {
    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) return [];

    const toolOutputIds = new Set<string>();
    for (let i = msgIndex + 1; i < allMessages.length; i++) {
      const nextMsg = allMessages[i];
      if (nextMsg.role === 'tool' && nextMsg.tool_call_id) {
        toolOutputIds.add(nextMsg.tool_call_id);
      }
      if (nextMsg.role === 'assistant') break;
    }

    const missing: Array<{ id: string; name: string; arguments: string }> = [];
    for (const tc of assistantMsg.tool_calls) {
      if (!toolOutputIds.has(tc.id)) {
        missing.push({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments || '',
        });
      }
    }
    return missing;
  }

  /**
   * 把所有非 system 消息转成 Responses API items, 顺手为孤儿 function_call 合成
   * function_call_output 占位 — 让 OpenAI 不再 400 invalid_prompt, 同时 LLM 能看到
   * "这一轮调用被中断了"的事实, 不会傻乎乎重发同一组工具.
   */
  private buildConversationItemsWithSyntheticOutputs(messages: Message[]): any[] {
    const out: any[] = [];
    let syntheticCount = 0;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const items = this.convertMessageToResponsesItems(msg);
      out.push(...items);

      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        const missing = this.collectMissingToolCallIds(msg, messages, i);
        for (const m of missing) {
          out.push({
            type: 'function_call_output',
            call_id: m.id,
            output: this.buildInterruptedToolOutput(m.name, m.arguments),
          });
          syntheticCount++;
        }
      }
    }

    if (syntheticCount > 0) {
      cliLogger.warn('OpenAI', `Synthesized ${syntheticCount} interrupted tool outputs to heal orphan function_calls (BYOK direct path)`);
    }

    return out;
  }

  /** 给中断的工具调用合成一条简短、机器/人都能看懂的 output 字符串. */
  private buildInterruptedToolOutput(toolName: string, args: string): string {
    /* 只摘要前 200 字符防止 args 异常长把 prompt 撑爆. JSON.parse 失败就用原文. */
    let argSummary = '';
    if (args && args.length > 0) {
      const trimmed = args.length > 200 ? args.slice(0, 200) + '…(truncated)' : args;
      argSummary = ` Args: ${trimmed}`;
    }
    return [
      `[interrupted] Tool "${toolName}" did not produce an output in the previous turn.${argSummary}`,
      `Likely cause: the upstream model request was aborted before this tool ran (auth error, network glitch, rate limit, or user cancellation).`,
      `The conversation has resumed — re-evaluate the situation before retrying. Do NOT assume this tool already ran or that any side effect was applied.`,
    ].join('\n');
  }

  private convertMessageToResponsesItems(msg: Message): any[] {
    if (msg.role === 'assistant') {
      const items: any[] = [];

      // OpenAI Responses API: 上一轮 response 里带 encrypted_content 的 reasoning items
      // 必须原样回传, 顺序是 reasoning → message → function_call. 否则 GPT-5/o-series
      // 直接 400 invalid_prompt — 推理链断了模型无法连贯继续 tool_call 后的判断.
      // openai_reasoning_items 由 runner.ts 在 stream 累积时塞进来.
      if (Array.isArray(msg.openai_reasoning_items) && msg.openai_reasoning_items.length > 0) {
        for (const item of msg.openai_reasoning_items) {
          if (!item || (!item.id && !item.encrypted_content)) continue;
          const reasoningItem: any = { type: 'reasoning' };
          if (item.id) reasoningItem.id = item.id;
          if (Array.isArray(item.summary)) reasoningItem.summary = item.summary;
          if (item.encrypted_content) reasoningItem.encrypted_content = item.encrypted_content;
          items.push(reasoningItem);
        }
      }

      const textContent = getTextFromContent(msg.content);

      if (textContent.trim().length > 0) {
        items.push({
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: textContent, annotations: [] }],
        });
      }

      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        for (const toolCall of msg.tool_calls) {
          // 移除额外的 id 字段，只使用 call_id（与 Codex 一致）
          const originalId = toolCall.id;

          if (process.env.CLI_DEBUG === '1') {
            cliLogger.debug('OpenAI', 'Function call ID (no normalization):', {
              originalId,
              toolName: toolCall.function.name,
              argsLength: toolCall.function.arguments?.length || 0,
            });
          }

          items.push({
            type: 'function_call',
            call_id: originalId,
            name: toolCall.function.name,
            arguments: toolCall.function.arguments || '',
            status: 'completed',
          });

          if (process.env.CLI_DEBUG === '1') {
            cliLogger.debug('OpenAI', 'Sending function_call to API:', {
              call_id: originalId,
              name: toolCall.function.name,
            });
          }
        }
      }

      return items;
    }

    if (msg.role === 'tool') {
      const originalId = msg.tool_call_id || msg.name;
      const rawOutput = getTextFromContent(msg.content);
      // Apply Codex-style truncation to prevent context explosion
      const truncatedOutput = truncateToolOutput(rawOutput, WIRE_TOOL_OUTPUT_MAX_UNITS);

      if (process.env.CLI_DEBUG === '1') {
        cliLogger.debug('OpenAI', 'Sending function_call_output (no normalization):', {
          callId: originalId,
          toolName: msg.name,
          outputLength: truncatedOutput.length,
          wasTruncated: rawOutput.length !== truncatedOutput.length,
        });
      }

      return [{
        type: 'function_call_output',
        call_id: originalId,
        output: truncatedOutput,
      }];
    }

    // User message - 支持多模态
    if (Array.isArray(msg.content)) {
      const contentItems: any[] = [];
      for (const part of msg.content) {
        if (part.type === 'text' && part.text.trim()) {
          contentItems.push({ type: 'input_text', text: part.text });
        } else if (part.type === 'image_url') {
          contentItems.push({ type: 'input_image', image_url: normalizeImageUrl(part.image_url.url) });
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

  // 不再需要 ID 规范化，直接使用 API 返回的原始 ID（与 Codex 一致）

  /**
   * 获取 GPT Agent 工作流程优化指令
   * 类似 Codex 的 AGENTS.md 机制
   */
  private getGPTAgentInstructions(): string | null {
    try {
      // 指令从烘焙常量取 (scripts/bake-prompts.mjs 由 .md 生成 base64), 不再明文随包分发。
      // 旧方案 readFileSync('../prompts/gpt-agents-instructions.md') 会把完整指令原样打进 asar,
      // 解包即 cat → 核心 IP 白扒。现内联进 bundle: 桌面走 fortress 混淆, CLI 也不再是独立可 cat 文件。
      const instructions = GPT_AGENTS_INSTRUCTIONS;

      // 格式化为 Codex 风格的 AGENTS.md 格式
      const formattedInstructions = `# AGENTS.md instructions for GPT models\n\n<INSTRUCTIONS>\n${instructions}\n</INSTRUCTIONS>`;

      if (process.env.CLI_DEBUG === '1') {
        cliLogger.debug('OpenAI', 'Loaded GPT Agent instructions (baked):', {
          length: instructions.length,
          preview: instructions.substring(0, 200),
        });
      }

      return formattedInstructions;
    } catch (error) {
      // 如果文件不存在或读取失败，返回 null（优雅降级）
      if (process.env.CLI_DEBUG === '1') {
        cliLogger.warn('OpenAI', 'Failed to load GPT Agent instructions:', error);
      }
      return null;
    }
  }

  private getSessionStableAgentInstructions(): string | null {
    if (this.frozenAgentInstructionsBySession.has(this.sessionId)) {
      return this.frozenAgentInstructionsBySession.get(this.sessionId) ?? null;
    }

    const extracted = this.getGPTAgentInstructions();
    const frozen = extracted && extracted.length > 0 ? extracted : null;
    this.frozenAgentInstructionsBySession.set(this.sessionId, frozen);
    return frozen;
  }

  private formatResponsesFunctionTool(tool: Tool): NonNullable<ResponsesAPIRequest['tools']>[number] {
    // 参考 Codex 真实请求抓包数据
    const useStrictMode = false; // Codex-style: 不强制 strict 模式

    if (!useStrictMode) {
      // 简化模式：不修改 schema，直接使用原始参数
      return {
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: false,
      };
    }

    // Strict 模式（已废弃，保留代码以备后用）
    const originalRequired = new Set(tool.parameters.required || []);
    const propertiesEntries = Object.entries(tool.parameters.properties || {});

    const normalizedProperties = Object.fromEntries(
      propertiesEntries.map(([key, schema]) => [
        key,
        originalRequired.has(key) ? { ...schema } : this.makeSchemaNullable(schema),
      ]),
    );

    const parameters = {
      ...tool.parameters,
      properties: normalizedProperties,
      required: Object.keys(normalizedProperties),
      additionalProperties: false,
    };

    return {
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters,
      strict: true,
    };
  }

  private formatResponsesTool(tool: Tool): NonNullable<ResponsesAPIRequest['tools']>[number] {
    if (this.shouldUseNativeResponsesWebSearch(tool)) {
      const configuredType = (process.env.NEOX_OPENAI_WEB_SEARCH_TOOL_TYPE || '').trim().toLowerCase();
      const webSearchType = configuredType === 'web_search_preview' ? 'web_search_preview' : 'web_search';

      if (process.env.CLI_DEBUG === '1') {
        cliLogger.debug('OpenAI', 'Using native Responses web_search tool', {
          tool: tool.name,
          type: webSearchType,
        });
      }

      return {
        type: webSearchType,
      };
    }

    return this.formatResponsesFunctionTool(tool);
  }

  private shouldUseNativeResponsesWebSearch(tool: Tool): boolean {
    if (tool.name !== 'web_search') {
      return false;
    }

    if (/(^|[/.])api\.deepseek\.com([/:]|$)/.test(String(this.baseUrl || '').toLowerCase())) {
      return false;
    }

    const forceFunctionTool = String(process.env.NEOX_FORCE_FUNCTION_WEB_SEARCH || '').trim();
    return forceFunctionTool !== '1' && forceFunctionTool.toLowerCase() !== 'true';
  }

  private makeSchemaNullable(schema: any): any {
    if (!schema || typeof schema !== 'object') return schema;

    const updated: any = { ...schema };

    if (updated.type) {
      if (Array.isArray(updated.type)) {
        if (!updated.type.includes('null')) {
          updated.type = [...updated.type, 'null'];
        }
      } else if (updated.type !== 'null') {
        updated.type = [updated.type, 'null'];
      }
    }

    if (Array.isArray(updated.enum) && !updated.enum.includes(null)) {
      updated.enum = [...updated.enum, null];
    }

    if (Array.isArray(updated.anyOf)) {
      updated.anyOf = updated.anyOf.map((option: any) => this.makeSchemaNullable(option));
    }

    if (Array.isArray(updated.oneOf)) {
      updated.oneOf = updated.oneOf.map((option: any) => this.makeSchemaNullable(option));
    }

    if (Array.isArray(updated.allOf)) {
      updated.allOf = updated.allOf.map((option: any) => this.makeSchemaNullable(option));
    }

    return updated;
  }

  // ============================================================================
  // 流解析器
  // ============================================================================

  /**
   * 解析 OpenAI SSE 流响应
   * 
   * 优化：定期让出事件循环控制权，避免长时间阻塞
   */
  private async *parseOpenAIStreamResponse(
    stream: any,
    signal?: AbortSignal,
    options?: {
      requireDone?: boolean;
      /** EMPTY_STREAM 诊断: HTTP 状态/内容类型/端点 — 调用方从 response 捎带 */
      responseMeta?: { status?: number; contentType?: string; endpoint?: string };
    }
  ): AsyncGenerator<StreamChunk> {
    let buffer = '';
    /* 每条流一个解码器 (内部存着跨 chunk 的半个字符, 不能复用) */
    const decodeChunk = createUtf8ChunkDecoder();
    let chunkCount = 0;
    let sseEventCount = 0;
    let doneSeen = false;
    let sseParseFailStreak = 0;
    let finishReasonSeen = false;
    let dataLines: string[] = [];
    const requireDone = options?.requireDone ?? process.env.NEOX_STRICT_SSE_DONE === '1';
    const startedAt = Date.now();
    let lastEventAt = startedAt;

    const yieldToEventLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

    const processDataPayload = function* (payload: string): Generator<StreamChunk> {
      const normalized = payload.trim();
      if (!normalized) {
        return;
      }

      if (normalized === '[DONE]') {
        doneSeen = true;
        if (process.env.CLI_DEBUG === '1') {
          cliLogger.debug('OpenAI', 'Stream Received [DONE]', {
            chunks: chunkCount,
            events: sseEventCount,
            durationMs: Date.now() - startedAt,
          });
        }
        return;
      }

      try {
        const parsed = JSON.parse(normalized); normalizeReasoningDelta(parsed);
        if (parsed?.error) {
          throw Object.assign(new Error(parsed.error.message || 'Upstream stream failed'), {
            code: parsed.error.code || 'UPSTREAM_STREAM_ERROR',
            retryable: parsed.error.retryable === true,
            requestId: parsed.error.requestId,
            isStreamError: true,
          });
        }
        sseEventCount++;
        lastEventAt = Date.now();
        receivedFirstByte = true;
        if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null; }

        // 追踪完成信号：有完成信号说明 LLM 回复语义上已完成
        // Chat Completions 格式: choices[0].finish_reason
        // Responses API 格式: type === 'response.completed' / 'response.output_item.done' / 'response.failed'
        if (parsed.choices?.[0]?.finish_reason
          || parsed.type === 'response.completed'
          || parsed.type === 'response.incomplete'
          || parsed.type === 'response.output_item.done'
          || parsed.type === 'response.failed') {
          finishReasonSeen = true;
        }

        if (process.env.CLI_DEBUG === '1') {
          cliLogger.debug('OpenAI', 'Stream Chunk', parsed);
        }
        sseParseFailStreak = 0;  /* 成功一帧就 reset 累积 */
        yield parsed;
      } catch (parseErr) {
        if ((parseErr as { isStreamError?: boolean })?.isStreamError) throw parseErr;
        cliLogger.warn('NEOX_DIAG', 'sse-parse-fail', { data: normalized.slice(0, 200), err: String(parseErr) });
        if (process.env.CLI_DEBUG === '1') {
          cliLogger.warn('OpenAI', 'Stream Invalid JSON', { data: normalized });
        }
        sseParseFailStreak++;
        if (sseParseFailStreak >= 5 && sseEventCount === 0) {
          const err: any = new Error(
            `SSE protocol error: 5 consecutive JSON parse failures, no valid frames received. First payload: ${normalized.slice(0, 200)}`
          );
          err.code = 'SSE_PROTOCOL_ERROR';
          err.retryable = false;
          throw err;
        }
      }
    };

    // 防止代理/API 停止发送数据但不关闭连接导致的无限等待
    const idleTimeoutMs = this.retryConfig.streamIdleTimeoutMs;
    const firstByteTimeoutMs = this.retryConfig.firstByteTimeoutMs;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let firstByteTimer: ReturnType<typeof setTimeout> | null = null;
    let receivedFirstByte = false;

    // 包装 stream 迭代器，为每次 chunk 读取添加 idle 超时 + first-byte 超时
    const withIdleTimeout = async function* (source: AsyncIterable<any>, timeoutMs: number) {
      const iterator = source[Symbol.asyncIterator]();

      const firstBytePromise = new Promise<never>((_, reject) => {
        firstByteTimer = setTimeout(() => {
          reject(Object.assign(
            new Error(`First-byte timeout: no SSE data received for ${Math.round(firstByteTimeoutMs / 1000)}s after connect`),
            { code: 'FIRST_BYTE_TIMEOUT', retryable: true }
          ));
        }, firstByteTimeoutMs);
        if (firstByteTimer.unref) firstByteTimer.unref();
      });

      while (true) {
        const racers: Promise<any>[] = [iterator.next()];
        if (receivedFirstByte) {
          racers.push(new Promise<never>((_, reject) => {
            idleTimer = setTimeout(() => {
              reject(Object.assign(
                new Error(`Stream idle timeout: no data received for ${Math.round(timeoutMs / 1000)}s`),
                { code: 'STREAM_IDLE_TIMEOUT', retryable: true }
              ));
            }, Math.max(1, timeoutMs - (Date.now() - lastEventAt)));
          }));
        }

        // 首字节超时仅在收到第一个 chunk 之前生效
        if (!receivedFirstByte) {
          racers.push(firstBytePromise);
        }

        const result = await Promise.race(racers);
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }

        if (result.done) return;
        yield result.value;
      }
    };

    try {
      for await (const chunk of withIdleTimeout(stream, idleTimeoutMs)) {
        // 检查是否被取消
        if (signal?.aborted) {
          if (process.env.CLI_DEBUG === '1') {
            cliLogger.debug('OpenAI', 'Stream aborted by signal');
          }
          throw new Error('Request aborted');
        }

        // 定期让出控制权（每 20 个 chunk）
        if (chunkCount++ % 20 === 0) {
          await yieldToEventLoop();
        }

        buffer += decodeChunk(chunk);
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const rawLine of lines) {
          const line = rawLine.replace(/\r$/, '');

          // SSE 事件边界：空行表示一个 event 结束
          if (line === '') {
            if (dataLines.length === 0) {
              continue;
            }

            const payload = dataLines.join('\n');
            dataLines = [];
            yield* processDataPayload(payload);
            if (doneSeen) {
              return;
            }
            continue;
          }

          if (!line.startsWith('data:')) {
            continue;
          }

          // 支持 data:xxx 与 data: xxx 两种格式
          const data = line.slice(5).replace(/^\s/, '');
          dataLines.push(data);
        }
      }
    } finally {
      if (idleTimer) { clearTimeout(idleTimer); }
      if (firstByteTimer) { clearTimeout(firstByteTimer); }
    }

    // 流关闭时，尝试处理最后未 flush 的 event 数据
    if (dataLines.length > 0) {
      const payload = dataLines.join('\n');
      dataLines = [];
      yield* processDataPayload(payload);
    }

    // Stream ended without explicit [DONE] marker
    if (!doneSeen && !signal?.aborted) {
      const tail = `${buffer}${buffer && dataLines.length > 0 ? '\n' : ''}${dataLines.join('\n')}`;
      const tailPreview = tail.slice(-200);
      cliLogger.warn('OpenAI', 'SSE stream ended before [DONE]', {
        chunks: chunkCount,
        events: sseEventCount,
        durationMs: Date.now() - startedAt,
        tailBytes: Buffer.byteLength(tail || '', 'utf8'),
        tailPreview,
      });

      if (sseEventCount === 0) {
        const meta = options?.responseMeta;
        const proxyEnv = process.env.HTTPS_PROXY || process.env.https_proxy
          || process.env.HTTP_PROXY || process.env.http_proxy || '';
        const diagParts = [
          meta?.status !== undefined ? `HTTP ${meta.status}` : null,
          meta?.contentType ? `content-type: ${meta.contentType}` : null,
          meta?.endpoint ? `endpoint: ${meta.endpoint}` : null,
          proxyEnv ? `⚠️ proxy env active: ${proxyEnv} (若上游无请求记录, 大概率被本机代理拦截 — 给该域配直连/NO_PROXY)` : null,
        ].filter(Boolean).join(', ');
        const emptyErr: any = new Error(
          `Upstream returned no valid SSE data${diagParts ? ` (${diagParts})` : ''}. Tail: ${tailPreview || '(empty)'}`
        );
        emptyErr.code = 'EMPTY_STREAM';
        emptyErr.retryable = false;
        emptyErr.rawBody = tail.slice(0, 800);
        throw emptyErr;
      }

      // BehaviorProfile 驱动：retryOnIncompleteStream 也触发重试
      // 关键：如果已经收到 finish_reason，说明 LLM 回复语义上已完成，
      // 只是 proxy 没发 [DONE]（常见行为），这时不应重试
      const isRealTruncation = !finishReasonSeen;
      const shouldRetry = requireDone
        || (this.modelProfile?.behavior?.retryOnIncompleteStream
          && sseEventCount > 0
          && isRealTruncation);

      if (shouldRetry) {
        const error = new Error('SSE stream ended before [DONE] — suspected truncation') as RetryableError;
        error.code = 'STREAM_INCOMPLETE';
        error.retryable = true;
        throw error;
      }
    }
  }

  /**
   * 解析 Responses API SSE 流响应
   */
  private async *parseResponsesAPIStream(
    stream: any,
    signal?: AbortSignal,
    responseMeta?: { status?: number; contentType?: string; endpoint?: string },
  ): AsyncGenerator<StreamChunk> {
    const toolCallState = new Map<string, { id: string; name: string; index: number; arguments: string; completed: boolean }>();
    let nextToolCallIndex = 0;
    let finalResponseData: any = null;
    let finalUsage: any = null;
    /* response.incomplete 的原因 (输出上限 / 内容过滤), 见该 case */
    let incompleteFinishReason: 'length' | 'content_filter' | undefined;
    let hasEmittedContent = false;
    let hasEmittedReasoning = false;
    let roleSent = false;

    const WARN_TOOL_ARGS_BYTES = 100000; // 100KB - 警告阈值

    const createStreamIncompleteError = (message: string): Error => {
      const error = new Error(message) as RetryableError;
      error.code = 'STREAM_INCOMPLETE';
      return error;
    };

    const emitDeltaChunk = (delta: any): StreamChunk => {
      const payloadDelta: any = { ...delta };
      if (!roleSent) {
        payloadDelta.role = 'assistant';
        roleSent = true;
      }
      return {
        choices: [{ index: 0, delta: payloadDelta }],
      };
    };

    const mapWebSearchResults = (sources: any[] = []) =>
      sources
        .map((src: any) => {
          const url = typeof src?.url === 'string' ? src.url : '';
          let hostname = '';
          if (typeof src?.hostname === 'string') {
            hostname = src.hostname;
          } else if (url) {
            try {
              hostname = new URL(url).hostname;
            } catch {
              hostname = url;
            }
          }
          return {
            title: typeof src?.title === 'string' ? src.title : '',
            url,
            description: typeof src?.snippet === 'string'
              ? src.snippet
              : (typeof src?.text === 'string' ? src.text : ''),
            hostname,
          };
        })
        .filter((item: any) => item.title && item.url);

    const emitWebSearchStarted = (item: any, fallbackKey: string): StreamChunk => {
      const key = item?.id || fallbackKey;
      const query = item?.action?.query || item?.action?.queries?.[0] || '';
      const existing = toolCallState.get(key);
      if (!existing) {
        toolCallState.set(key, {
          id: key,
          name: 'web_search',
          index: -1,
          arguments: JSON.stringify({ query }),
          completed: false,
        });
      }
      hasEmittedContent = true;
      return {
        choices: [],
        type: 'web_search_event',
        webSearchId: key,
        webSearchQuery: query,
        webSearchStatus: 'searching',
      };
    };

    const emitWebSearchCompleted = (item: any, fallbackKey: string): StreamChunk => {
      const key = item?.id || fallbackKey;
      const query = item?.action?.query || item?.action?.queries?.[0] || '';
      const state = toolCallState.get(key);
      const results = mapWebSearchResults(item?.action?.sources || []);
      if (state) {
        state.completed = true;
      }
      hasEmittedContent = true;
      return {
        choices: [],
        type: 'web_search_event',
        webSearchId: key,
        webSearchQuery: query,
        webSearchStatus: 'completed',
        webSearchResults: results,
      };
    };

    // Responses API often ends with response.completed but without [DONE] on some proxies; completeness is validated below.
    for await (const event of this.parseOpenAIStreamResponse(stream, signal, { requireDone: false, responseMeta })) {
      if (!event || typeof event !== 'object') continue;

      switch (event.type) {
        case 'response.output_text.delta': {
          const text = typeof event.delta === 'string' ? event.delta : '';
          if (!text) break;
          hasEmittedContent = true;
          yield emitDeltaChunk({ content: text });
          break;
        }

        case 'response.output_item.added': {
          if (event.item?.type === 'function_call') {
            const key = event.item.id || `item_${event.output_index}`;
            const state = {
              id: event.item.call_id || event.item.id || `call_${Date.now()}_${nextToolCallIndex}`,
              name: event.item.name,
              index: nextToolCallIndex++,
              arguments: '',
              completed: false,
            };
            toolCallState.set(key, state);

            if (process.env.CLI_DEBUG === '1') {
              cliLogger.debug('OpenAI', 'Function call added from stream:', {
                key,
                id: state.id,
                call_id: event.item.call_id,
                item_id: event.item.id,
                name: state.name,
                index: state.index,
              });
            }

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
            // Codex 源码: encrypted_content 是 OpenAI 服务端加密，客户端不解密
            // 作用: 存入上下文历史，下轮请求时原样回传给 API（保持推理连贯性）
            hasEmittedReasoning = true;
            if (process.env.CLI_DEBUG === '1') {
              const encLen = event.item.encrypted_content?.length || 0;
              cliLogger.debug('OpenAI', `Reasoning item added (encrypted: ${encLen} chars)`);
            }
            // 发出一个空的 reasoning_content 触发 UI 的 thinking 指示器
            yield emitDeltaChunk({ reasoning_content: '' });

            // 如果有 summary 文本，也发出来
            const summaries = event.item.summary || [];
            for (const s of summaries) {
              const text = s?.text || '';
              if (text) {
                yield emitDeltaChunk({ reasoning_content: text });
              }
            }
          } else if (event.item?.type === 'web_search_call') {
            const key = event.item.id || `web_search_${event.output_index}`;
            const query = event.item.action?.query || event.item.action?.queries?.[0] || '';

            if (process.env.CLI_DEBUG === '1') {
              cliLogger.debug('OpenAI', 'Native web_search_call started', { key, query });
            }

            yield emitWebSearchStarted(event.item, `web_search_${event.output_index}`);
          }
          break;
        }

        case 'response.function_call_arguments.delta': {
          const state = event.item_id ? toolCallState.get(event.item_id) : undefined;
          if (!state) break;

          const currentSize = Buffer.byteLength(state.arguments, 'utf8');
          const argsDelta = typeof event.delta === 'string' ? event.delta : '';
          if (!argsDelta) break;

          // 对于大参数（>50KB），使用 setImmediate 让出控制权
          if (currentSize > 50000) {
            await new Promise(resolve => setImmediate(resolve));
          }

          state.arguments += argsDelta;
          hasEmittedContent = true;

          const newSize = Buffer.byteLength(state.arguments, 'utf8');
          if (newSize > WARN_TOOL_ARGS_BYTES && currentSize <= WARN_TOOL_ARGS_BYTES) {
            cliLogger.warn('OpenAI', `Tool ${state.name} arguments size exceeds ${WARN_TOOL_ARGS_BYTES} bytes (${newSize} bytes)`);
          }

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

        case 'response.output_item.done': {
          if (event.item?.type === 'function_call') {
            const key = event.item.id || `item_${event.output_index}`;
            const state = toolCallState.get(key);
            if (state) {
              state.completed = true;
              if (process.env.CLI_DEBUG === '1') {
                const argsSize = Buffer.byteLength(state.arguments, 'utf8');
                cliLogger.debug('OpenAI', `Tool ${state.name} arguments complete (${argsSize} bytes)`);
              }
            }
          } else if (event.item?.type === 'reasoning') {
            // Codex 源码: event_mapping.rs L107-133 — 只显示 summary，不解密 encrypted_content.
            // 但 OpenAI 协议要求下一轮请求里把这个 reasoning item 原样回传 (input 里 type=reasoning),
            // 否则 GPT-5/o-series 直接拒 invalid_prompt — 推理链断了模型无法连贯继续.
            //   _openai_reasoning_item 走 chunk delta, agentLoop 累到 message.openai_reasoning_items 上.
            //   convertMessageToResponsesItems 在重建 input 时再把它 emit 出去.
            const reasoningItem = {
              id: event.item.id,
              summary: Array.isArray(event.item.summary) ? event.item.summary : undefined,
              encrypted_content: event.item.encrypted_content,
            };
            if (reasoningItem.id || reasoningItem.encrypted_content) {
              if (process.env.CLI_DEBUG === '1') {
                cliLogger.debug('OpenAI', `Reasoning item done — encrypted=${reasoningItem.encrypted_content?.length || 0} chars summary=${reasoningItem.summary?.length || 0}`);
              }
              yield emitDeltaChunk({ _openai_reasoning_item: reasoningItem });
            }
            const summaries = event.item.summary || [];
            for (const s of summaries) {
              const text = s?.text || '';
              if (text) {
                hasEmittedReasoning = true;
                yield emitDeltaChunk({ reasoning_content: text });
              }
            }
          } else if (event.item?.type === 'web_search_call') {
            const key = event.item.id || `web_search_${event.output_index}`;
            const query = event.item.action?.query || event.item.action?.queries?.[0] || '';
            const state = toolCallState.get(key);
            const results = mapWebSearchResults(event.item.action?.sources || []);

            if (process.env.CLI_DEBUG === '1') {
              cliLogger.debug('OpenAI', 'Native web_search_call completed', {
                key, query, resultsCount: results.length,
              });
            }

            if (!state) {
              yield emitWebSearchStarted(event.item, `web_search_${event.output_index}`);
            }
            yield emitWebSearchCompleted(event.item, `web_search_${event.output_index}`);
          }
          break;
        }

        case 'response.completed': {
          finalResponseData = event.response;
          finalUsage = event.response?.usage;
          break;
        }

        // 当 OpenAI 因 token 限制或内容过滤返回不完整响应时触发
        case 'response.incomplete': {
          const reason = event.response?.incomplete_details?.reason || 'unknown';
          cliLogger.warn('OpenAI', `Incomplete response returned, reason: ${reason}`);
          incompleteFinishReason = reason === 'content_filter' ? 'content_filter' : 'length';
          finalResponseData = event.response ?? {};
          finalUsage = event.response?.usage;
          break;
        }

        // 将 reasoning delta 转换为 reasoning_content，走现有的 reasoning 渲染管线
        case 'response.reasoning_summary_text.delta': {
          const text = typeof event.delta === 'string' ? event.delta : '';
          if (!text) break;
          hasEmittedReasoning = true;
          if (process.env.CLI_DEBUG === '1') {
            cliLogger.debug('OpenAI', 'Reasoning summary delta', { text: text.slice(0, 200) });
          }
          yield emitDeltaChunk({ reasoning_content: text });
          break;
        }

        case 'response.reasoning_text.delta': {
          const text = typeof event.delta === 'string' ? event.delta : '';
          if (!text) break;
          hasEmittedReasoning = true;
          yield emitDeltaChunk({ reasoning_content: text });
          break;
        }

        case 'response.reasoning_summary_part.added': {
          // 推理部分开始标记，无需特殊处理
          break;
        }

        case 'response.error':
        case 'response.failed': {
          const errorPayload = event.response?.error || event.error || {};
          const code = errorPayload?.code || 'response_failed';
          const message = errorPayload?.message || event.message || 'Responses stream failed';
          const status =
            (typeof errorPayload?.status === 'number' ? errorPayload.status : undefined)
            ?? (typeof event.response?.status_code === 'number' ? event.response.status_code : undefined)
            ?? 400;

          // 某些兼容代理只通过 response.failed 返回业务错误，不会走 HTTP 非 2xx 分支。
          // 把结构化错误挂到异常对象，便于上层统一做错误分类和重试判断。
          const streamFailure = new Error(message) as Error & {
            code?: string;
            response?: { status?: number; data?: unknown };
            isResponsesFailedEvent?: boolean;
          };
          streamFailure.code = code;
          streamFailure.response = {
            status,
            data: event.response || event,
          };
          streamFailure.isResponsesFailedEvent = true;
          throw streamFailure;
        }
      }

      if (hasEmittedReasoning && (event.type === 'response.output_text.delta' || event.type === 'response.completed')) {
        hasEmittedReasoning = false; // 只发一次
        yield {
          choices: [{ index: 0, delta: { reasoning_complete: true } }],
        };
      }

      // 没有这个退出点，当代理不发 [DONE] 也不关闭 TCP 连接时，
      // for-await 会永远挂住，导致 UI 卡在 "Planning next steps..."
      if (finalResponseData) {
        break;
      }
    }

    const incompleteCalls: string[] = [];
    for (const [key, state] of toolCallState.entries()) {
      if (!state.completed) {
        incompleteCalls.push(`${state.name} (${Buffer.byteLength(state.arguments, 'utf8')} bytes)`);
      }
    }

    /* 被输出上限 / 过滤掐断时最后一个调用本来就没写完 —— runner 的截断守卫会拦下它并告诉模型,
     * 这里再当流故障抛出去, 就又变回"重试同一个请求"了。 */
    if (incompleteCalls.length > 0 && !incompleteFinishReason) {
      cliLogger.error('OpenAI',
        `⚠️ Responses API stream ended with ${incompleteCalls.length} incomplete tool calls: ${incompleteCalls.join(', ')}`
      );
      cliLogger.error('OpenAI',
        'This indicates a streaming issue with the API/proxy server. ' +
        'The tool calls received incomplete arguments and may fail execution.'
      );
      throw createStreamIncompleteError(
        `Responses stream ended with incomplete tool calls: ${incompleteCalls.join(', ')}`
      );
    }

    if (!finalResponseData) {
      throw createStreamIncompleteError('Responses stream closed before response.completed');
    }

    const outputItems = Array.isArray(finalResponseData.output) ? finalResponseData.output : [];

    for (let index = 0; index < outputItems.length; index += 1) {
      const item = outputItems[index];
      if (item?.type !== 'web_search_call') continue;
      const key = item.id || `web_search_completed_${index}`;
      const state = toolCallState.get(key);
      if (!state) {
        yield emitWebSearchStarted(item, key);
      }
      if (!state?.completed) {
        yield emitWebSearchCompleted(item, key);
      }
    }

    // 如果没有 emit 任何内容，从最终响应中提取
    if (!hasEmittedContent && finalResponseData) {
      let textContent = '';

      for (const item of outputItems) {
        if (item?.type === 'message' && Array.isArray(item.content)) {
          for (const contentPart of item.content) {
            if (contentPart?.type === 'output_text' && typeof contentPart.text === 'string') {
              textContent += contentPart.text;
            }
          }
        }
      }

      if (textContent) {
        yield {
          choices: [{
            index: 0,
            delta: { role: 'assistant', content: textContent },
          }],
        };
      }
    }

    // 发送最终 chunk
    const finishChunk: StreamChunk = {
      choices: [{ index: 0, delta: {}, finish_reason: incompleteFinishReason ?? 'stop' }],
    };

    if (finalUsage) {
      finishChunk.usage = this.normalizeUsage(finalUsage);
    }

    yield finishChunk;
  }

  /**
   * 解析 Anthropic SSE 流并转换为 OpenAI 格式
   * 用于返回 Anthropic 格式的代理服务器
   */
  private async *parseAnthropicStreamResponse(stream: any): AsyncGenerator<StreamChunk> {
    let buffer = '';
    const decodeChunk = createUtf8ChunkDecoder();
    const toolCalls: Array<{
      index: number;
      id: string;
      type: string;
      function: { name: string; arguments: string };
    }> = [];
    let currentToolCallIndex = 0;
    let roleSent = false;
    let finalUsage: any = null;
    let stopReason: string | undefined;
    /* Anthropic content block index → toolCalls 下标. 并行 tool_use 的 delta 会交错到达,
     * 只能靠 event.index 归位。 */
    const blockIndexToToolIndex = new Map<number, number>();

    for await (const chunk of stream) {
      buffer += decodeChunk(chunk);   /* 跨 chunk 的半个汉字要留到下一块再解, 见 utf8StreamDecoder */
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine || !trimmedLine.startsWith('data: ')) continue;

        const data = trimmedLine.slice(6);
        if (data === '[DONE]') continue;

        /* 只有 JSON.parse 放进 try: 原来整个 switch 都在 try 里, `case 'error'` 的 throw
         * 被同一个 catch 当成"坏 JSON"吞掉 —— 上游报错 (overloaded 等) 变成一条没有下文的空回复。 */
        let event: any;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        {
          switch (event.type) {
            case 'message_start':
              if (event.message?.usage) {
                finalUsage = event.message.usage;
              }
              break;

            case 'content_block_start':
              if (event.content_block?.type === 'text') {
                if (!roleSent) {
                  roleSent = true;
                  yield { choices: [{ delta: { role: 'assistant' }, index: 0 }] };
                }
              } else if (event.content_block?.type === 'tool_use') {
                const toolUse = event.content_block;
                /* 记下 Anthropic 的 content block index → 我们的 tool index 映射。
                 * 后续 input_json_delta 必须靠它归位, 不能按"最后一个"猜 (见下方注释)。 */
                blockIndexToToolIndex.set(event.index, currentToolCallIndex);
                toolCalls.push({
                  index: currentToolCallIndex,
                  id: toolUse.id,
                  type: 'function',
                  function: { name: toolUse.name, arguments: '' },
                });

                yield {
                  choices: [{
                    delta: {
                      tool_calls: [{
                        index: currentToolCallIndex,
                        id: toolUse.id,
                        type: 'function',
                        function: { name: toolUse.name },
                      }],
                    },
                    index: 0,
                  }],
                };

                currentToolCallIndex++;
              }
              break;

            case 'content_block_delta':
              if (event.delta?.type === 'text_delta') {
                const text = event.delta.text || '';
                yield { choices: [{ delta: { content: text }, index: 0 }] };
              } else if (event.delta?.type === 'input_json_delta') {
                const argsDelta = event.delta.partial_json || '';
                const mappedIndex = blockIndexToToolIndex.get(event.index);
                const target = mappedIndex !== undefined
                  ? toolCalls.find(tc => tc.index === mappedIndex)
                  : undefined;
                if (target) {
                  target.function.arguments += argsDelta;

                  yield {
                    choices: [{
                      delta: {
                        tool_calls: [{
                          index: target.index,
                          function: { arguments: argsDelta },
                        }],
                      },
                      index: 0,
                    }],
                  };
                }
              }
              break;

            case 'message_delta':
              if (event.usage) {
                finalUsage = event.usage;
              }
              if (typeof event.delta?.stop_reason === 'string') stopReason = event.delta.stop_reason;
              break;

            case 'error':
              throw new Error(event.error?.message || 'Stream error');
          }
        }
      }
    }

    const truncated = stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded';
    const finishReason = truncated ? 'length'
      : stopReason === 'refusal' ? 'content_filter'
      : toolCalls.length > 0 ? 'tool_calls' : 'stop';
    const finishChunk: StreamChunk = {
      choices: [{
        delta: {},
        finish_reason: finishReason,
        index: 0,
      }],
    };

    if (finalUsage) {
      finishChunk.usage = this.normalizeUsage(finalUsage);
    }

    yield finishChunk;
  }

  // ============================================================================
  // 辅助方法
  // ============================================================================

  /**
   * 规范化 usage 对象，统一处理 OpenAI 和 Anthropic 格式
   * 提取缓存 tokens 信息
   */
  private normalizeUsage(rawUsage: any): UsageStats {
    const usage: UsageStats = {
      prompt_tokens: rawUsage.input_tokens ?? rawUsage.prompt_tokens ?? 0,
      completion_tokens: rawUsage.output_tokens ?? rawUsage.completion_tokens ?? 0,
      total_tokens: 0,
    };

    usage.total_tokens = rawUsage.total_tokens ?? (usage.prompt_tokens + usage.completion_tokens);

    // OpenAI Responses API: input_tokens_details
    const normalizedPromptDetails =
      rawUsage.prompt_tokens_details ??
      rawUsage.input_tokens_details ??
      rawUsage.prompt_token_details;

    if (normalizedPromptDetails?.cached_tokens !== undefined) {
      usage.prompt_tokens_details = {
        cached_tokens: normalizedPromptDetails.cached_tokens,
        text_tokens: normalizedPromptDetails.text_tokens,
        audio_tokens: normalizedPromptDetails.audio_tokens,
        image_tokens: normalizedPromptDetails.image_tokens,
      };
    }

    // OpenAI Responses API: output_tokens_details
    const normalizedCompletionDetails =
      rawUsage.completion_tokens_details ??
      rawUsage.output_tokens_details;

    if (normalizedCompletionDetails) {
      usage.completion_tokens_details = {
        text_tokens: normalizedCompletionDetails.text_tokens,
        audio_tokens: normalizedCompletionDetails.audio_tokens,
        reasoning_tokens: normalizedCompletionDetails.reasoning_tokens,
      };
    }

    // Top-level cached_tokens (Kimi API format)
    if (rawUsage.cached_tokens !== undefined) {
      usage.cached_tokens = rawUsage.cached_tokens;
    } else if (normalizedPromptDetails?.cached_tokens !== undefined) {
      // OpenAI Responses API: keep a unified top-level cached_tokens for downstream logic
      usage.cached_tokens = normalizedPromptDetails.cached_tokens;
    }

    // OpenAI prompt_cache_hit_tokens (older format)
    if (rawUsage.prompt_cache_hit_tokens !== undefined) {
      usage.prompt_cache_hit_tokens = rawUsage.prompt_cache_hit_tokens;
    }

    // OpenAI prompt_cache_miss_tokens (proxy/vendor extension)
    if (rawUsage.prompt_cache_miss_tokens !== undefined) {
      usage.prompt_cache_miss_tokens = rawUsage.prompt_cache_miss_tokens;
    }

    // Anthropic cache fields (for Anthropic proxies using OpenAI format)
    if (rawUsage.cache_read_input_tokens !== undefined) {
      usage.cache_read_input_tokens = rawUsage.cache_read_input_tokens;
    } else if (normalizedPromptDetails?.cache_read_tokens !== undefined) {
      usage.cache_read_input_tokens = normalizedPromptDetails.cache_read_tokens;
    }
    if (rawUsage.cache_creation_input_tokens !== undefined) {
      usage.cache_creation_input_tokens = rawUsage.cache_creation_input_tokens;
    }

    // OpenAI-compatible vendor extensions for cache write accounting.
    // (按正常输入价计费, 自动缓存无写入费), 归入 cache write 会让非缓存 input 恒为 0。
    const vendorCacheWrite =
      rawUsage.cache_write_input_tokens ??
      normalizedPromptDetails?.cache_write_tokens ??
      normalizedPromptDetails?.cache_creation_tokens;
    if (vendorCacheWrite !== undefined) {
      usage.cache_write_input_tokens = vendorCacheWrite;
    }

    return usage;
  }

  private shouldUseResponsesAPI(model?: string): boolean {
    return this.useResponsesAPI;
  }

  /**
   * 更新会话 ID
   * 用于在外部需要绑定特定 session 时调用
   */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
    if (process.env.CLI_DEBUG === '1') {
      cliLogger.debug('OpenAI', `Session ID updated to: ${sessionId}`);
    }
  }

  /**
   * 获取当前会话 ID
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * 设置豆包深度思考模式
   * @param config 思考配置，或 undefined 清除配置
   */
  setDoubaoThinking(config: DoubaoThinkingConfig | undefined): void {
    this.doubaoThinking = config;
    if (process.env.CLI_DEBUG === '1') {
      cliLogger.debug('OpenAI', `Doubao thinking updated to: ${config?.type || 'undefined'}`);
    }
  }

  /**
   * 获取当前豆包深度思考配置
   */
  getDoubaoThinking(): DoubaoThinkingConfig | undefined {
    return this.doubaoThinking;
  }
}

/* ────────────────────  reasoning_content 回传策略  ──────────────────── */

type ReasoningPassbackPolicy = 'with_tool_calls' | 'never' | 'always';

const reasoningPassbackCache = new Map<string, ReasoningPassbackPolicy>();

/**
 * 按 model → family yaml 解析 thinking.passback (声明化的 provider quirk)。
 * Undeclared families retain the legacy 'with_tool_calls' default.
 * DeepSeek explicitly declares 'always'; non-tool replies must retain reasoning too.
 */
export function resolveReasoningPassbackPolicy(model?: string): ReasoningPassbackPolicy {
  if (!model) return 'with_tool_calls';
  const cached = reasoningPassbackCache.get(model);
  if (cached) return cached;
  let policy: ReasoningPassbackPolicy = 'with_tool_calls';
  const family = getSchemaRegistry().detectFamily({ model });
  const declared = family?.capabilities?.thinking?.passback;
  if (declared) policy = declared;
  reasoningPassbackCache.set(model, policy);
  return policy;
}
