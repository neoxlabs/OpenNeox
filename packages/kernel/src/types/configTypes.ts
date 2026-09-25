/**
 * 纯类型定义文件 - 供渲染进程使用
 * 从 utils/config.ts 分离出来，避免在浏览器环境中导入 Node.js 模块
 */

import type { ModelCompatOverrides } from './compat.js';
import type { ProviderRetryConfig } from './retryConfig.js';

export type ProviderProtocol =
  | 'openai'
  | 'openai-responses'
  | 'openai-images'      /* /v1/images/generations + /edits (OpenAI, OpenRouter, 字节 Seedream, 智谱 CogView) */
  | 'openai-tts'         /* /v1/audio/speech */
  | 'openai-stt'         /* /v1/audio/transcriptions */
  | 'openai-embedding'   /* /v1/embeddings */
  | 'anthropic'
  | 'anthropic-openai'
  | 'doubao'
  | 'doubao-images'      /* 字节 Seedream — OpenAI-images compat */
  | 'doubao-tts'         /* 火山 CosyVoice/Doubao-TTS 独立协议 */
  | 'gemini'
  | 'gemini-images'      /* Gemini 2.5 Flash Image (Nano Banana) */
  | 'grok'               /* xAI Grok (OpenAI-compat) */
  | 'grok-images'        /* Grok image gen (xAI native path) */
  | 'kimi'
  | 'deepseek'
  | 'minimax'
  | 'minimax-tts'
  | 'minimax-video'
  | 'qwen'
  | 'qwen-images'        /* 阿里通义万相 (dashscope-tasks 异步转 sync) */
  | 'dashscope-tts'      /* CosyVoice v2 (阿里百炼) */
  | 'glm'
  | 'glm-claude'
  | 'glm-images'         /* 智谱 CogView-4 */
  | 'kimi-claude'
  | 'openrouter'         /* OpenRouter — chat OpenAI-compat */
  | 'openrouter-images'  /* OpenRouter — image OpenAI-images compat, 部分模型支持 */
  | 'mistral'
  | 'groq'
  | 'together';          /* Together AI */

/* ==================== Modality 能力标签 ==================== */

/** 一个 provider / model 能做什么. UI 按 modality 过滤模型列表 (图片模式只显 image 模型),
 *  运行时 resolver 按 modality 挑 provider (imageService 调用时找 capabilities 含 image 的). */
export type Modality =
  | 'chat'         /* 文本 / 多模态对话 (llm.chat_completions) */
  | 'image'        /* 文生图 (/v1/images/generations) */
  | 'image-edit'   /* 图生图 / inpaint (/v1/images/edits) */
  | 'tts'          /* 文字转语音 */
  | 'stt'          /* 语音转文字 */
  | 'embedding'    /* 向量化 */
  | 'video'        /* 文生视频 */
  | 'rerank';      /* 检索重排 */

/** 单个 provider 具备的一项能力.
 *  一个 provider 可以有多项 (OpenAI 一个 key 走 chat + image + tts + stt + embedding). */
/**
 * ProviderCapability == 一条「渠道 (channel)」: 用某协议、打某端点、服务某模态、能到哪些模型。
 * 一个 provider(账户)可挂多条 —— chat 走 anthropic + 另一批模型走 openai + image 走 openai-images,
 * 共用账户的 Key 池。协议挂渠道, 不挂 provider、不挂 model (同一模型可出现在多条渠道)。
 */
export interface ProviderCapability {
  /** 稳定 id (可选, UI 生成; 无则按 index)。 */
  id?: string;
  modality: Modality;
  /** wire 协议 — 决定用哪个 adapter 说话. 允许多个 capability 用相同 protocol
   *  (比如 image / image-edit 都是 openai-images), endpoint 区分. */
  protocol: ProviderProtocol;
  /** 相对 baseUrl 的子路径, 默认按 protocol 推断. 手动覆盖用 (定制代理调整路径时). */
  endpoint?: string;
  /** 这条能力是否启用 (用户可以有能力但暂时关掉). */
  enabled?: boolean;
  /* ============ 渠道扩展  ============ */
  /** baseUrl 覆盖 —— 不填用 provider.baseUrl (多数渠道共用账户地址; 个别厂商图像端点不同才覆盖)。 */
  baseUrl?: string;
  /** urlSuffix 覆盖 —— 不填用 provider.urlSuffix / protocol 默认。 */
  urlSuffix?: string;
  /** 该渠道能到的模型 (provider.models 子集)。空/不填 = 该 modality 下所有模型走这条 (catch-all)。 */
  models?: string[];
  /** 展示名 (可选)。 */
  label?: string;
}

/**
 * ProviderChannel == 一个「Tab」: 一个 key + 一个协议 (+ 可选限定模型 / baseUrl 覆盖)。
 * 一个 provider(账户) 挂若干 Tab。多个同协议 Tab = 多 key 轮换; 不同协议 Tab = 多协议路由。
 * modality 从 protocol 自动推 (openai→chat, openai-images→image), 不用用户选。
 */
export interface ProviderChannel {
  /** 稳定 id (UI 生成)。 */
  id?: string;
  /** 这个 Tab 的 key。存储时 wrap 加密, 读出解密。 */
  apiKey: string;
  /** 这个 Tab 的协议 —— 决定 adapter + modality。 */
  protocol: ProviderProtocol;
  /** 限定哪些模型走这个 Tab (provider.models 子集)。空 = 该 modality 全部 (catch-all)。 */
  models?: string[];
  /** baseUrl 覆盖 —— 不填用 provider.baseUrl。 */
  baseUrl?: string;
  /** urlSuffix 覆盖 —— 不填按 protocol 默认。 */
  urlSuffix?: string;
  /** 展示名 (可选, UI Tab 标题)。 */
  label?: string;
}

/** resolveChannel 的结果 —— 给定 (model, modality) 后, 该走哪个 Tab (协议 + key + 地址)。 */
export interface ResolvedChannel {
  protocol: ProviderProtocol;
  /** 该 Tab 的 key (已解密); 缺省 undefined → 调用方回落 provider.apiKey。 */
  apiKey?: string;
  /** 仅当 Tab 显式覆盖时有值; 否则 undefined → 调用方回落 provider.baseUrl。 */
  baseUrl?: string;
  urlSuffix?: string;
  endpoint?: string;
}

export type ApprovalMode = 'auto' | 'manual' | 'dangerous';
export type UserLanguage = 'zh' | 'en';

// ==================== 模型路由配置 ====================

/** 路由策略类型 */
export type RoutingStrategy = 'priority' | 'latency' | 'round-robin';

/** 单个模型的 Provider 路由项 */
export interface ModelProviderRoute {
  /** Provider ID */
  providerId: string;
  /** 该 Provider 中的模型名称（可能与别名不同） */
  modelName: string;
  /** 优先级 (1 最高) */
  priority: number;
  /** 是否启用 */
  enabled: boolean;
}

/** 模型路由配置 - 定义一个逻辑模型到多个 Provider 的映射 */
export interface ModelRouteConfig {
  /** 模型别名（逻辑名称，如 "claude-sonnet"） */
  modelAlias: string;
  /** 显示名称 */
  displayName?: string;
  /** 该模型的所有可用 Provider 路由（按优先级排序） */
  routes: ModelProviderRoute[];
  /** 路由策略 */
  strategy: RoutingStrategy;
  /** 是否启用自动故障转移 */
  autoFailover: boolean;
  /** 创建时间 */
  createdAt?: string;
  /** 更新时间 */
  updatedAt?: string;
}

/** 降级配置 */
export interface FallbackSettings {
  /** 是否启用自动降级 */
  autoFallback: boolean;
  /** 最大连续降级次数 */
  maxConsecutiveFallbacks: number;
  /** 降级冷却时间 (ms) */
  fallbackCooldownMs: number;
  /** 降级时通知用户 */
  notifyOnFallback: boolean;
  /** 恢复时通知用户 */
  notifyOnRecovery: boolean;
}

/** 恢复检测配置 */
export interface RecoverySettings {
  /** 是否启用自动恢复检测 */
  enabled: boolean;
  /** 检测间隔 (ms) */
  checkIntervalMs: number;
  /** 恢复确认次数 */
  confirmationCount: number;
  /** 恢复后自动切回 */
  autoSwitchBack: boolean;
}

/** 模型路由总配置 */
export interface ModelRoutingConfig {
  /** 是否启用模型路由 */
  enabled: boolean;
  /** 模型路由映射 (modelAlias -> config) */
  routes: Record<string, ModelRouteConfig>;
  /** 健康检查配置 */
  healthCheck: {
    /** 连续失败多少次标记为不可用 */
    failureThreshold: number;
    /** 连续成功多少次恢复 */
    recoveryThreshold: number;
    /** 检查超时 (ms) */
    timeoutMs: number;
  };
  /** 降级配置 */
  fallback?: FallbackSettings;
  /** 恢复配置 */
  recovery?: RecoverySettings;
}

// ==================== 多模型协作配置 ====================

/** 任务类型枚举 */
export type TaskType =
  | 'image_analysis'
  | 'coding'
  | 'code_review'
  | 'debugging'
  | 'reasoning'
  | 'creative_writing'
  | 'summarization'
  | 'translation'
  | 'data_analysis'
  | 'general_qa';

/** 模型能力评分 */
export interface ModelCapabilityScores {
  coding: number;
  reasoning: number;
  vision: number;
  creativity: number;
  speed: number;
  cost: number;
}

/** 模型特殊能力 */
export interface ModelFeatures {
  supportsVision: boolean;
  supportsTools: boolean;
  supportsFunctionCalling: boolean;
  supportsStreaming: boolean;
  maxContextTokens: number;
  maxOutputTokens: number;
}

/** 模型能力定义 */
export interface ModelCapability {
  modelAlias: string;
  /** 擅长的任务类型 */
  strengths: TaskType[];
  /** 能力评分 (0-100) */
  scores: ModelCapabilityScores;
  /** 特殊能力 */
  features: ModelFeatures;
}

/** 任务路由规则 */
export interface TaskRoutingRule {
  taskType: TaskType;
  /** 首选模型列表（按优先级排序） */
  preferredModels: string[];
  /** 备选模型 */
  fallbackModel: string;
  /** 路由条件 */
  conditions?: {
    minConfidence?: number;
    maxLatency?: number;
    maxCost?: number;
  };
}

/** 上下文共享策略 */
export type ContextSharingStrategy = 'full' | 'summary' | 'selective';

/** 协作执行模式 */
export type OrchestrationMode = 'sequential' | 'parallel' | 'hybrid';

/** 多模型协作配置 */
export interface OrchestratorConfig {
  /** 是否启用多模型协作 */
  enabled: boolean;
  /** 任务路由规则 */
  taskRouting: TaskRoutingRule[];
  /** 上下文共享配置 */
  contextSharing: {
    strategy: ContextSharingStrategy;
    maxSharedTokens: number;
    /** 用于生成摘要的模型 */
    summarizerModel?: string;
  };
  /** 协作执行模式 */
  mode: OrchestrationMode;
  /** 任务分析器使用的模型 */
  analyzerModel?: string;
}

// ==================== Provider 配置 ====================

export interface ProviderModelConfig {
  name: string;
  label?: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
  compat?: ModelCompatOverrides;
  /** OpenAI Responses API reasoning configuration */
  reasoning?: {
    /** Reasoning effort level (max/ultra = GPT-5.6, ultra 仅 Sol/Terra) */
    effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
    /** Summary mode */
    summary?: 'auto' | 'concise' | 'detailed';
    /** Verbosity level (for some models) */
    verbosity?: 'low' | 'medium' | 'high';
  };
  /* ============ Modality 标签 (新增, 全部 optional 向后兼容) ============
   * 老 config 缺这些字段 → runtime 走 deriveModalitiesFromProtocol() 兜底推断. */
  /** 这个 model 能做哪些事. 图片模式模型下拉只列 modalities.includes('image') 的. */
  modalities?: Modality[];
  /** 支持的输入类型. 用于 UI 判定"能不能上传参考图给这个 model". */
  input?: Array<'text' | 'image' | 'audio' | 'video' | 'file' | 'mask'>;
  /** 输出类型. 决定 timeline 怎么渲染 (image → 图卡, audio → 播放器). */
  output?: Array<'text' | 'image' | 'audio' | 'video'>;
  /** 上下文窗口 (tokens). 从上游 /models 拉的元数据里带回来. */
  contextWindow?: number;
  /** 每 1M token 定价 (USD). BYOK 时显示给用户参考成本, 订阅无关. */
  pricingPer1M?: { input?: number; output?: number; imagePer?: { size: string; usd: number }[] };
}

export interface ProviderConfigEntry {
  id: string;
  name: string;
  /** 主协议 — 决定 chat 走哪个 adapter. 老 config 的唯一协议字段, 保留兼容.
   *  多能力 provider (OpenAI 既有 chat 又有 image) 用 capabilities 描述完整能力集, 主协议是 chat. */
  protocol: ProviderProtocol;
  /** 主 API Key —— = channels[0].apiKey 的镜像 (始终存在, 老消费方直接读它拿主 Tab 的 key). 存储时 wrap 加密。 */
  apiKey: string;
  /* ============ Tab / 渠道 (v2) ============
   * 一个 provider(账户) = 若干 Tab, 每个 Tab = 一个 key + 一个协议 (+ 可选限定模型/baseUrl)。
   * 默认无 channels = 单 Tab = 今天的扁平 {protocol, apiKey, baseUrl} (向后兼容)。
   * 有 channels 时它是全部 Tab 的真源; 扁平 protocol/apiKey/baseUrl 镜像 channels[0] 供老消费方读。
   * 每 Tab 的 apiKey 同主 key 一样 wrap 加密存、unwrap 解密读。 */
  channels?: ProviderChannel[];
  baseUrl?: string;
  urlSuffix?: string;
  maxTokens?: number;
  maxInputTokens?: number;
  models: ProviderModelConfig[];
  defaultModel?: string;
  lastSelectedModel?: string;
  createdAt?: string;
  updatedAt?: string;
  /** Provider-specific retry configuration */
  retry?: ProviderRetryConfig;
  /** Disable cache_control for proxy providers that don't support it */
  disableCaching?: boolean;
  /* ============ 多能力扩展 ============
   * 老 config 缺 capabilities → runtime 走 deriveCapabilitiesFromProtocol() 从主 protocol 推一条 chat 能力.
   * 用户在设置里"添加图像能力"时 append 一条 {modality:'image', protocol:'openai-images'} 进这个数组.
   * 这样一个 OpenRouter provider 一个 key, 就能同时挂 chat + image + tts + stt + embedding. */
  capabilities?: ProviderCapability[];
  /** Provider 展示图标 (URL 或 data URL); 由 preset 提供, 用户手动加时留空. */
  iconUrl?: string;
  /** 关联的 preset id (OpenAI/OpenRouter/Doubao/...), 用于设置页显示 badge + 自动应用 preset 升级. */
  presetId?: string;
  /** 额外 headers, OpenRouter 要求 HTTP-Referer + X-Title. */
  extraHeaders?: Record<string, string>;
  /** 图生图 (edit) 上游载荷格式 —— 不同 provider/代理不一样 (协议层, 非 OpenRouter):
   *   'images-array' = { images:[{image_url:{url}}] } (现代 gpt-image 代理默认) · 'image-field' = 经典 { image }.
   *  按 provider 确定, 设置页可选; 绝不运行时试错. OpenRouter 走独立 input_references, 不用此项. */
  imageEditFormat?: 'images-array' | 'image-field';
  /** openai-responses: 是否注入 Codex 官方 instructions. undefined/true=注入; false=降级 layered
   * (第三方 responses 代理对 codex instructions 报 invalid_prompt 400 时用户可关). */
  injectCodexPrompt?: boolean;
  /**
   * Anthropic 请求身份策略 (BYOK/订阅共用). 只对 protocol='anthropic' 生效.
   *
   *   - 'auto' (默认): 按 baseUrl 判. api.anthropic.com → 走 Neox 官方身份;
   *     其它一律伪装 Claude Code (兼容第三方 Anthropic 兼容代理).
   *   - 'on': 强制伪装 Claude Code CLI. system[0] 注入身份声明 +
   *     User-Agent claude-cli + PascalCase 工具名 + anthropic-beta headers +
   *     /v1/messages?beta=true. 用户想把自己的 Anthropic key 挂到 Claude Code 用量池测试时用.
   *   - 'off': 强制 Neox 原生身份. 不注入 system 前缀, 走 Neox User-Agent, tools 名不 remap,
   *     走 /v1/messages 标准路径. 用户直连 api.anthropic.com 或某个拒 Claude Code 头的定制代理时用.
   *
   * 未配置 = undefined = 视作 'auto' 保持向后兼容.
   */
  claudeCodeMode?: 'auto' | 'on' | 'off';
}
