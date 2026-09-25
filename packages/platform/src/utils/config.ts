import fs from 'fs';
import path from 'path';
import os from 'os';
import { createHash, randomBytes } from 'crypto';

import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { setKernelConfigProvider } from '@neoxlabs/kernel';
import type { ModelCompatOverrides } from '@neoxlabs/kernel/types/compat.js';
import type { ProviderRetryConfig, RetryConfig } from '@neoxlabs/kernel/types/retryConfig.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

// 导入类型供文件内部使用
import type {
  ProviderProtocol,
  ApprovalMode,
  UserLanguage,
  RoutingStrategy,
  ModelProviderRoute,
  ModelRouteConfig,
  FallbackSettings,
  RecoverySettings,
  ModelRoutingConfig,
  TaskType,
  ModelCapabilityScores,
  ModelFeatures,
  ModelCapability,
  TaskRoutingRule,
  ContextSharingStrategy,
  OrchestrationMode,
  OrchestratorConfig,
  ProviderModelConfig,
  ProviderConfigEntry,
  ProviderChannel,
} from '@neoxlabs/kernel/types/configTypes.js';

// 重新导出类型（保持向后兼容）
export type {
  ProviderProtocol,
  ApprovalMode,
  UserLanguage,
  RoutingStrategy,
  ModelProviderRoute,
  ModelRouteConfig,
  FallbackSettings,
  RecoverySettings,
  ModelRoutingConfig,
  TaskType,
  ModelCapabilityScores,
  ModelFeatures,
  ModelCapability,
  TaskRoutingRule,
  ContextSharingStrategy,
  OrchestrationMode,
  OrchestratorConfig,
  ProviderModelConfig,
  ProviderConfigEntry,
  ProviderChannel,
} from '@neoxlabs/kernel/types/configTypes.js';


/** 分析后的任务 */
export interface AnalyzedTask {
  type: TaskType;
  description: string;
  confidence: number;
  dependencies: number[];
  requiresVision: boolean;
  estimatedComplexity: 'low' | 'medium' | 'high';
}

/** 任务分析结果 */
export interface TaskAnalysis {
  tasks: AnalyzedTask[];
  suggestedWorkflow: OrchestrationMode;
}

/** 任务执行结果 */
export interface TaskResult {
  task: AnalyzedTask;
  model: string;
  output: string;
  metadata?: {
    latency?: number;
    tokensUsed?: number;
    cost?: number;
  };
}

/** 协作响应 */
export interface OrchestratedResponse {
  results: TaskResult[];
  synthesizedOutput: string;
  metadata: {
    totalLatency: number;
    totalTokensUsed: number;
    totalCost: number;
    modelsUsed: string[];
  };
}

/** Web Search configuration */
export interface WebSearchConfig {
  /** Whether web search is enabled. Missing = on (native-provider default); only explicit false disables. */
  enabled?: boolean;
  engine?: 'auto' | 'bocha' | 'serper' | 'custom';
  /** Optional custom WebSearch endpoint URL (engine=custom 用) */
  url?: string;
  /** 外部搜索 API key (engine=bocha/serper 用) */
  apiKey?: string;
}

/** Java Debug configuration */
export interface JavaDebugConfig {
  /** Whether Java Debug is enabled */
  enabled: boolean;
  /** Path to java-debug JAR file (optional, uses bundled JAR if not provided) */
  jarPath?: string;
  /** Path to JDK home (optional, uses JAVA_HOME if not provided) */
  javaHome?: string;
}

/** LSP (Language Server Protocol) configuration */
export interface LspServerEntry {
  /** Language ID, e.g. 'typescript', 'python', 'java', 'go', 'rust' */
  languageId: string;
  /** Command to launch the server */
  command: string;
  /** Command arguments */
  args?: string[];
  /** Whether this server is enabled */
  enabled: boolean;
}

export interface LspFeatureConfig {
  /** Show hover documentation (default: false) */
  hover?: boolean;
  /** Show diagnostics/errors (default: false) */
  diagnostics?: boolean;
  /** Provide code completion hints (default: false) */
  completion?: boolean;
  /** Code actions / quick fixes (default: false) */
  codeActions?: boolean;
  /** Find references (default: false) */
  references?: boolean;
  /** Go to definition (default: false) */
  definition?: boolean;
  /** Rename symbol (default: false) */
  rename?: boolean;
  /** Format document (default: false) */
  format?: boolean;
  /** Inlay hints (default: false) */
  inlayHints?: boolean;
}

export interface LspConfig {
  /** Global LSP switch (default: false) */
  enabled?: boolean;
  /** Per-feature toggles */
  features?: LspFeatureConfig;
  /** Language server entries */
  servers?: LspServerEntry[];
}

/** readfile configuration */
export interface SmartReadConfig {
  /** Whether readfile tools are enabled (default: true) */
  enabled: boolean;
  /** Auto-prompt user to build index for large projects */
  autoPromptIndex?: boolean;
  /** Supported languages for indexing */
  languages?: string[];
  /** File patterns to include */
  include?: string[];
  /** File patterns to exclude */
  exclude?: string[];
  /** Cache directory for index files */
  cacheDir?: string;
}

/** Remote access configuration (LAN/VPS) */
export interface RemoteAccessConfig {
  /** Whether remote access is enabled */
  enabled?: boolean;
  /** Network mode */
  networkMode?: 'lan' | 'vps';
  /** Bind host for LAN server */
  host?: string;
  /** Bind port for server (default 4399) */
  port?: number;
  /** Pairing token (Bearer auth) */
  token?: string;
  /** Allow voice input from remote */
  allowVoice?: boolean;
  /** Auto-approve safe tools for remote sessions */
  autoApprove?: boolean;
  /** Extra CORS origins to allow */
  corsOrigins?: string[];
}

// ==================== 协作模式配置 ====================

/** Agent 模型引用 */
export interface AgentModelRef {
  /** Provider ID (来自 ProviderStore) */
  providerId: string;
  /** 模型名称 */
  model: string;
}

/** Worker 池中的模型配置 */
export interface WorkerModelEntry {
  /** Provider ID */
  providerId: string;
  /** 模型名称 */
  model: string;
  /** 是否启用 */
  enabled: boolean;
  /** 模型特色标签 (LLM 选择依据) - 从 ModelRegistry 自动填充 */
  traits?: string[];
}

export type AssistantCollaborationMode = 'flexible' | 'organization';

export const DEFAULT_CLAUDE_EXPLORE_USE_HAIKU = true;
export const DEFAULT_CLAUDE_OPUS_FALLBACK_WHEN_NO_HAIKU = false;

/** 本地 Neox server 的出厂端口。**唯一真源**, 别再到处写字面量 4399。 */
export const FACTORY_SERVER_PORT = 4399;

export function getDefaultServerPort(): number {
  const raw = process.env.NEOX_SERVER_PORT;
  if (!raw) return FACTORY_SERVER_PORT;
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return FACTORY_SERVER_PORT;
  return port;
}

/** 本地 server 的默认 baseUrl (含 NEOX_SERVER_PORT 覆盖) */
export function getDefaultServerBaseUrl(): string {
  return `http://127.0.0.1:${getDefaultServerPort()}`;
}

/** 子 Agent 并发策略默认值 — 'auto' 保持现有行为不变 */
export const DEFAULT_CONCURRENCY_PROFILE: 'auto' | 'low' = 'auto';

/** 侧路 Agent feature 开关 */
export interface SideAgentFeatures {
  /** explore 任务 Agent 用小模型 */
  explore?: boolean;
  /** tool batch 执行后生成一行摘要（对齐 CC toolUseSummaryGenerator） */
  toolUseSummary?: boolean;
  /** 会话开始后自动生成标题（对齐 CC sessionTitle） */
  sessionTitle?: boolean;
}

/** 侧路 Agent 模型统一配置 — 控制所有辅助 LLM 调用 */
export interface SideAgentConfig {
  /** 全局开关 — false 时所有 side-agent 走主会话模型 */
  enabled?: boolean;
  /** 侧路 Agent 使用的 provider（不配置则自动选择） */
  providerId?: string;
  /** 侧路 Agent 使用的模型（不配置则自动选择） */
  model?: string;
  /** 各场景独立开关 */
  features?: SideAgentFeatures;
  /** Claude 专属:Haiku 不可用时允许回退到 Opus (其他 family 无效) */
  claudeFallbackToOpusWhenNoHaiku?: boolean;
  disableThinking?: boolean;
}

export const DEFAULT_SIDE_AGENT_ENABLED = true;
export const DEFAULT_SIDE_AGENT_DISABLE_THINKING = true;
export const DEFAULT_SIDE_AGENT_FEATURES: Required<SideAgentFeatures> = {
  explore: true,
  toolUseSummary: true,
  sessionTitle: true,
};

/** assistant 模式配置 */
export interface AssistantConfig {
  /** assistant 模式: 主 Agent 模型 (主协调). agentic 模式: 不使用 */
  mainAgent?: AgentModelRef;
  /** agentic 模式: 派出去的独立任务 Agent (explore / 未来 worker) 用的模型 */
  taskAgent?: AgentModelRef;
  /** 监督 Agent 使用的模型 */
  supervisorAgent?: AgentModelRef;
  /** Worker 可用的模型池 - LLM 根据 traits 自动选择 */
  workerPool: WorkerModelEntry[];
  /** 最大并发 Worker 数 */
  maxConcurrent?: number;
  /** Assistant 协作架构 */
  collaborationMode?: AssistantCollaborationMode;
  /** @deprecated 迁移到 sideAgent.features.explore — 仅保留向后兼容 */
  claudeExploreUseHaiku?: boolean;
  /** @deprecated 迁移到 sideAgent.claudeFallbackToOpusWhenNoHaiku — 仅保留向后兼容 */
  claudeFallbackToOpusWhenNoHaiku?: boolean;
  /** 侧路 Agent 模型统一配置 */
  sideAgent?: SideAgentConfig;
  /** 创建时间 */
  createdAt?: string;
  /** 更新时间 */
  updatedAt?: string;
}

/** 运行模式标识 */
export type RunModeScope = 'agentic';

/** 按运行模式隔离的配置 */
export interface RunModeConfig {
  /** assistant 模式: 主协调模型 (leader). agentic 模式: 不使用,见 taskAgent */
  mainAgent?: AgentModelRef;
  /** agentic 模式: 派出去的独立任务 Agent (explore / 未来 worker) 用的模型 */
  taskAgent?: AgentModelRef;
  /** 该模式可用模型池 */
  workerPool?: WorkerModelEntry[];
  /** 并发上限 */
  maxConcurrent?: number;
  /** Assistant 协作架构 */
  collaborationMode?: AssistantCollaborationMode;
  /** @deprecated 迁移到 sideAgent.features.explore */
  claudeExploreUseHaiku?: boolean;
  /** @deprecated 迁移到 sideAgent.claudeFallbackToOpusWhenNoHaiku */
  claudeFallbackToOpusWhenNoHaiku?: boolean;
  /** 侧路 Agent 模型统一配置 */
  sideAgent?: SideAgentConfig;
  /** 创建时间 */
  createdAt?: string;
  /** 更新时间 */
  updatedAt?: string;
}

/** 运行配置中心 */
export interface RunConfig {
  /** 按模式拆分的配置 */
  modes?: Partial<Record<RunModeScope, RunModeConfig>>;
}

export interface NeoxConfig {
  providers?: Record<string, ProviderConfigEntry>;
  defaultProviderId?: string;
  approvalMode?: ApprovalMode;
  /**
   * 子 Agent 并发策略:
   * - 'auto' (默认): 现有行为 — explore 子 Agent 可降级到同家族 fast 变种, 正常并发.
   * - 'low': 单模型 + 低并发 — 子 Agent 一律用主模型 (不降级 flash/haiku, 不分主/副),
   *          并发上限拉到 1 (串行). 给并发不足 / 限流的用户用.
   */
  concurrencyProfile?: 'auto' | 'low';
  piiFilterEnabled?: boolean;
  /** Anthropic official API metadata user_id (<= 64 chars) */
  anthropicUserId?: string;
  /** Deprecated: Anthropic proxy/Claude Code metadata user_id (full format) */
  anthropicProxyUserId?: string;
  /** Anthropic Claude Code client id (64 hex chars) */
  anthropicClientId?: string;
  /** Global retry configuration */
  retry?: Partial<RetryConfig>;
  /** User language preference: 'zh' (Chinese) or 'en' (English), defaults to 'zh' */
  language?: UserLanguage;
  /** Whether the user has completed the onboarding flow */
  hasSeenOnboarding?: boolean;
  /** Recent workspace paths */
  recentWorkspaces?: string[];
  /** Enable verbose CLI debugging logs */
  cliDebug?: boolean;
  /** Agent sandbox mode - execute commands in isolated environment */
  agentSandboxEnabled?: boolean;
  /**
   * Agent Runtime 能力开关(2026-04 superpower 大更新)
   * — OS 沙箱 / 超时转后台 / PTY / 通知 / thread depth / rollout / bash 超时 / approval cache
   * 每项都可单独 override 环境变量,未设时使用安全默认值
   */
  agentRuntime?: AgentRuntimeConfig;
  /** Agent approval mode - 'auto' or 'manual' confirmation for actions */
  agentApprovalMode?: ApprovalMode;
  /** Agent scoped approval mode overrides (key = agent/role name) */
  agentApprovalScopes?: Record<string, ApprovalMode>;
  /** Web search configuration (using Serper.dev) */
  webSearch?: WebSearchConfig;
  /** Java Debug configuration */
  javaDebug?: JavaDebugConfig;
  /** readfile configuration */
  smartRead?: SmartReadConfig;
  /** Provider health check interval in minutes (default: 1) */
  providerHealthCheckIntervalMinutes?: number;
  /** Auto health check on page load (default: true) */
  autoHealthCheckEnabled?: boolean;
  /** Enabled tools map - tool name to enabled status */
  enabledTools?: Record<string, boolean>;
  /** 模型路由配置 - 同一模型多 Provider 自动切换 */
  modelRouting?: ModelRoutingConfig;
  /** 多模型协作配置 - 不同模型各司其职 */
  orchestrator?: OrchestratorConfig;
  /** 上下文管理配置 */
  context?: ContextManagementConfig;
  /** 记忆系统配置 */
  memory?: MemoryConfig;
  /** 远程访问配置 */
  remote?: RemoteAccessConfig;
  /** 连接远程 Neox Server（Docker 部署等场景） */
  remoteServer?: {
    /** 远程服务器 URL，如 http://192.168.1.100:4399 */
    url: string;
    /** Bearer Token（服务端 /remote 生成的配对 token） */
    token?: string;
  };
  /** 监督 Agent 配置 */
  supervisor?: SupervisorConfig;
  /** 完成提示配置 (声音/通知) */
  completionAlerts?: CompletionAlertConfig;
  tts?: TTSConfig;
  stt?: STTConfig;
  voiceChatModel?: string;
  /** 模型定价配置 (用于费用计算) */
  modelPricing?: ModelPricingConfig[];
  /** MCP 配置 */
  mcp?: MCPConfig;
  runMode?: 'agentic';
  lifeQuietHours?: { enabled: boolean; start: string; end: string };
  defaultAgentMode?: 'work' | 'code';
  runConfig?: RunConfig;
  assistant?: AssistantConfig;
  /** Channel 适配器配置 */
  channels?: import('../channels/types.js').ChannelConfig;
  /** 代码索引配置 */
  indexing?: {
    excludePatterns?: string[];
    autoIndex?: boolean;
    maxFileSize?: number;
  };
  /** Per-profile toolset overrides — profile ID → disabled tool names */
  toolsetOverrides?: Record<string, string[]>;
  /** Per-model toolset overrides — normalized model name → disabled tool names */
  toolsetOverridesByModel?: Record<string, string[]>;
  modelProfileOverrides?: Record<string, Record<string, unknown>>;
  taskAgentByModel?: Record<string, { providerId: string; model: string }>;
  /** 实验性功能开关 */
  experimental?: ExperimentalConfig;
  /** Model Config (Codex-style: reasoning_summary, verbosity, service_tier, etc.) */
  modelConfig?: {
    reasoning_summary?: string;
    verbosity?: string;
    personality?: string;
    web_search?: string;
    hide_agent_reasoning?: boolean;
    context_window?: number;
    auto_compact_limit?: number;
    service_tier?: string;
  };
  /** Reasoning effort (xhigh/high/medium/low/minimal/none) */
  reasoningEffort?: string;
  pet?: {
    /** 是否启用（默认 true） */
    enabled?: boolean;
    /** 渲染模式：simple=2D图标, 3d=Three.js水豚 */
    mode?: 'simple' | '3d';
  };
  /**
   * Editor inline completion (ghost text) — pin a fast model across providers.
   * - `enabled: false` 完全关闭 ghost text(Cmd+K 不受影响).
   * - 未设 providerId/model → 走 default provider + fast-hint 启发式.
   * - 设了 providerId/model → 强制使用该 provider/model.
   */
  inlineCompletion?: {
    enabled?: boolean;
    providerId?: string;
    model?: string;
  };
}

/** 实验性功能配置 */
export interface ExperimentalConfig {
  /** Fine-Grained Tool Streaming — 工具参数不缓冲直接流式输出（仅 Anthropic） */
  enableFGTS?: boolean;
  /** Programmatic Tool Calling — Agent 写代码编排多个工具调用 */
  enablePTC?: boolean;
  enableCheckpoint?: boolean;
  /** Guardrails 兼容模式（开启后默认组合不启用危险命令/SQL 阻断） */
  guardrailsCompatMode?: boolean;
  documentParseMode?: 'local' | 'cloud';
  /** Jev 加持 (TypeSafe System One 分类模型): 预判本轮要用的工具包等快判断。用户自带 key。 */
  jev?: {
    enabled?: boolean;
    /** wrapApiKey 密文 (enc:v1:…), 读时 unwrapApiKey */
    apiKey?: string;
    /** 缺省 jev-latest */
    model?: string;
  };
}

/**
 * Agent Runtime 配置 — 2026-04 "Agent Superpower" 新能力的集中开关。
 * 每项都默认 `undefined`(未设置),业务代码读取时 fallback 到环境变量再 fallback 到默认值。
 * 环境变量仍然被支持,作为临时覆盖 / CI / debug 用。
 */
export interface AgentRuntimeConfig {
  /** OS 级沙箱(macOS sandbox-exec / Linux unshare)。默认 **关闭** — 安全性 vs 兼容性权衡 */
  osSandbox?: {
    /** 是否启用 OS 内核强制,缺省 false */
    enabled?: boolean;
    /** 逻辑档 (单一真源, 与 SandboxMode/CLI 对齐)。UI + CLI 都写这个。 */
    mode?: 'read-only' | 'workspace-write' | 'danger-full-access';
    /** 网络: 仅 workspace-write 下有意义, 默认 true(除非显式关) */
    allowNetwork?: boolean;
    /** @deprecated 旧词汇 strict/moderate/permissive, 仅用于向后迁移读取 */
    level?: 'strict' | 'moderate' | 'permissive';
  };
  /** 前台 bash 命令超时时自动转为后台继续跑(不 kill),默认 **开启** */
  adoptOnTimeout?: {
    enabled?: boolean;
  };
  /** 假 TTY 让 npm install / docker build 等带彩色进度条,默认 **开启**(不可用时 fallback 到 execa) */
  pty?: {
    enabled?: boolean;
  };
  /** OS 系统通知中心推送(bash/agent 完成、context near limit),默认 **开启** */
  osNotifications?: {
    enabled?: boolean;
  };
  /** Sub-agent 最大递归 fork 深度,默认 3 */
  threadDepth?: {
    max?: number;
  };
  maxConcurrentTeams?: number;
  autoContinue?: 'on' | 'off';
  /** Rollout JSONL 持久化目录。默认 **关闭**(undefined);设置路径即启用 */
  rollout?: {
    dir?: string | null;
  };
  /** 前台 bash 命令超时 */
  bashTimeout?: {
    /** 默认超时(毫秒),默认 120000 */
    defaultMs?: number;
    /** 最大超时上限(毫秒),默认 600000 */
    maxMs?: number;
  };
  /** 同 session 同命令 ApprovalCache,默认 **开启** */
  approvalCache?: {
    enabled?: boolean;
  };
  gitCoAuthor?: {
    enabled?: boolean;
  };
  modelOrchestration?: 'off' | 'on';
  /**
   * 编排偏好提示 — 用户的自然语言模型偏好 (如 "审查都用 GPT"), 非硬绑定。
   * neox_config 的 routing 域可读; 写入走 propose_set 提案 + 用户确认。
   */
  modelOrchestrationHints?: string[];
  servicesStopConfirmation?: 'never' | 'always';
}

/** 上下文管理配置 */
export interface ContextManagementConfig {
  /** 压缩模式: sync=同步裁剪, async=异步LLM压缩 */
  compressionMode?: 'sync' | 'async';
  /** 触发压缩的阈值百分比 (0-100) */
  thresholdPercent?: number;
}

/** 记忆系统配置 */
export interface MemoryConfig {

  // --- Auto Memory Engine ---
  /** 是否启用自动记忆提取（默认 true）。只在开了 Jev 时生效: 先判这一轮有没有值得记的, 有才用当前会话模型提炼 */
  autoMemoryEnabled?: boolean;
  /** 自动记忆提取的最低置信度（0-1，默认 0.7） */
  autoMemoryMinConfidence?: number;
  /** 每次对话最多提取条数（默认 5） */
  autoMemoryMaxItemsPerSession?: number;
  /** 去重相似度阈值（0-1，默认 0.75） */
  autoMemoryDedupThreshold?: number;
}

/** 监督 Agent 配置 */
export interface SupervisorConfig {
  /** 是否启用监督 Agent */
  enabled?: boolean;
  /** 是否启用协作模式（用户输入发送给 Supervisor 调度） */
  collaborationMode?: boolean;
  /** 监督输出语言 */
  language?: UserLanguage;
  /** 监督 Agent 使用的模型 (默认: claude-haiku-4-5-20251001) */
  model?: string;
  /** 监督 Agent 使用的 Provider ID (默认: 当前活跃 Provider) */
  providerId?: string;
}

/** 完成提示配置 */
export interface CompletionAlertConfig {
  /** 是否启用完成提示声音 */
  soundEnabled?: boolean;
  /** 铃声文件名或绝对路径 */
  soundFile?: string;
  /** 是否启用桌面通知 */
  notifyEnabled?: boolean;
}

export interface TTSConfig {
  /** 是否启用 TTS */
  enabled?: boolean;
  /** TTS 提供商:
   *   edge (免费, 微软 WSS) | neoxcloud (订阅网关) | openai (HTTP) | custom (OpenAI 兼容 HTTP)
   *   local (Mac 本地) | dashscope (阿里云百炼 CosyVoice WSS 真流式 BYOK)
   *   volc (火山 WSS BYOK) | xfyun (讯飞 WSS BYOK) — 火山/讯飞下一批实现 */
  provider?: 'edge' | 'neoxcloud' | 'openai' | 'custom' | 'local' | 'dashscope' | 'volc' | 'xfyun';
  /** dashscope: 自定义 API Host — 空 = 公有云 dashscope.aliyuncs.com; 私有部署填 llm-xxx.cn-beijing.maas.aliyuncs.com */
  dashscopeApiHost?: string;
  /** 本地合成引擎指定 (tts-melo-zh-en / tts-kokoro-multi); 空=自动(优先音质) */
  localModel?: string;
  /** 自定义 TTS API URL (provider='custom' 时使用，OpenAI 兼容格式) */
  apiUrl?: string;
  /** API Key (provider='openai' 或 'custom' 时使用) */
  apiKey?: string;
  /** 云端 TTS 模型 ID (provider='neoxcloud' 时, 对应网关里配置的 TTS 渠道 modelId, 默认 'doubao-tts') */
  model?: string;
  /** 语音 ID，如 'zh-CN-XiaoxiaoNeural' (Edge) / 'BV001_streaming' (豆包) / 'alloy' (OpenAI) */
  voice?: string;
  /** 语速 0.5-2.0，默认 1.0 */
  speed?: number;
  /** 音频格式: 'mp3' | 'opus' | 'pcm'，默认 'mp3' */
  format?: 'mp3' | 'opus' | 'pcm' | 'wav';
  /** 是否对长回复自动摘要（用 Haiku），默认 true */
  autoSummarize?: boolean;
  /** 摘要最大字符数，默认 200 */
  maxSummaryChars?: number;
  /** 摘要使用的模型，默认 'claude-haiku-4-5-20251001' */
  summaryModel?: string;
}

export type STTProfile =
  | { id: string; name: string; provider: 'dashscope'; apiKey: string; model?: string; language?: string; apiHost?: string; connMode?: 'ws' | 'http' }
  | { id: string; name: string; provider: 'volc'; appId: string; accessToken: string; resourceId?: string }
  | { id: string; name: string; provider: 'xfyun'; appId: string; apiKey: string; apiSecret: string }
  | { id: string; name: string; provider: 'custom'; apiUrl: string; apiKey: string; model?: string; language?: string }
  | { id: string; name: string; provider: 'local' }
  | { id: string; name: string; provider: 'official' };

/** 语音识别 (STT) 配置 —— 输入框语音按钮走 NeoxCloud 网关 ASR. */
export interface STTConfig {
  enabled?: boolean;
  /** 网关里配置的 STT 渠道 modelId，默认 'doubao-asr' */
  model?: string;
  /** 识别语种，如 'zh'（可选） */
  language?: string;
  provider?: 'official' | 'custom' | 'xfyun' | 'dashscope' | 'volc' | 'local';
  /** custom: API 基地址或完整 transcriptions URL (e.g. https://api.openai.com/v1) */
  apiUrl?: string;
  /** custom: Bearer key / xfyun: APIKey / dashscope: 百炼 API Key */
  apiKey?: string;
  /** custom: 模型名, 默认 whisper-1 / dashscope: 默认 paraformer-realtime-v2 */
  customModel?: string;
  /** xfyun: 应用 APPID (console.xfyun.cn) / volc: X-Api-App-Key */
  appId?: string;
  /** xfyun: APISecret */
  apiSecret?: string;
  /** volc: X-Api-Access-Key (访问令牌) — 从火山"语音识别大模型-流式"开通页获取 */
  volcAccessToken?: string;
  /** volc: X-Api-Resource-Id, 默认 volc.bigasr.sauc.duration (按包月); volc.bigasr.sauc.concurrent (按并发) */
  volcResourceId?: string;
  /** dashscope: 自定义 API Host (私有部署百炼 Enterprise), 默认 dashscope.aliyuncs.com — 只填域名不带 https:// */
  dashscopeApiHost?: string;
  profiles?: STTProfile[];
  /** 当前生效 profile id (指向 profiles[] 中的一档); 空 = 用兼容字段 provider/apiKey 那套 */
  activeProfileId?: string;
  /** 本地识别引擎指定 (asr-sensevoice / asr-paraformer-zh); 空=自动(优先更准) */
  localModel?: string;
  voiceLockEnabled?: boolean;
  /** 声纹比对阈值 (cosine), 默认 0.38 — 越高越严 */
  voiceLockThreshold?: number;
}

/** 模型定价配置 (每百万 tokens 的价格) */
export interface ModelPricingConfig {
  /** 模型 ID 或模式 (支持通配符如 "gpt-4*") */
  pattern: string;
  /** 输入价格 ($/1M tokens) */
  inputPrice: number;
  /** 输出价格 ($/1M tokens) */
  outputPrice: number;
  /** 缓存输入价格 ($/1M tokens)，可选 */
  cachedInputPrice?: number;
  /** 货币单位 (默认 USD) */
  currency?: string;
}

// ==================== MCP 配置 ====================

export type MCPTransport = 'stdio' | 'sse' | 'http';

export interface MCPServerConfig {
  /** 唯一标识 */
  id: string;
  /** 显示名称 */
  name?: string;
  /** 传输协议 */
  transport: MCPTransport;
  /** stdio: 可执行命令 */
  command?: string;
  /** stdio: 命令参数 */
  args?: string[];
  /** stdio: 环境变量 */
  env?: Record<string, string>;
  /** sse: 连接 URL */
  url?: string;
  /** 是否启用 */
  enabled?: boolean;
  /** 是否自动连接并加载工具 */
  autoConnect?: boolean;
  /** 工具允许列表 */
  allowlist?: string[];
  /** 工具禁止列表 */
  denylist?: string[];
  /** 最近一次缓存的工具列表（用于懒连接） */
  toolCache?: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, any>;
  }>;
  /** 最近一次缓存时间 */
  toolCacheUpdatedAt?: string;
}

export interface MCPConfig {
  servers?: MCPServerConfig[];
  /** 是否启用 MCP（全局开关） */
  enabled?: boolean;
}

function getConfigDir(): string {
  return path.join(os.homedir(), NEOX_HOME_DIRNAME);
}

const CONFIG_DIR = getConfigDir();
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const SOUNDS_DIR = path.join(CONFIG_DIR, 'sounds');

export { CONFIG_DIR, CONFIG_FILE, SOUNDS_DIR };

/* ============================================================
 * 当前登录用户标记
 *
 *   BYOK providers / 主配置已经全局化, loadConfig/saveConfig 永远读写 CONFIG_FILE.
 *   _currentUserId 仍保留给登录态私有资源和缓存失效使用:
 *     - MCP OAuth token、临时用户态文件等仍可走 getActiveUserDir()
 *     - auth 变化时通过 onUserIdChange 通知 web 搜索、resolver 等缓存刷新
 * ============================================================ */
let _currentUserId: string | null = null;

/** user id 切换的订阅者 — 模块级缓存 (web 搜索 / pending questions / cron / shells 等)
 *  在这里注册 clear 回调, setCurrentUserId 改变时统一触发. 避免每个模块自己监听 routing.json,
 *  也避免漏点导致跨用户污染. */
type UserIdChangeHandler = (next: string | null, prev: string | null) => void;
const _userIdChangeHandlers: UserIdChangeHandler[] = [];

export function onUserIdChange(handler: UserIdChangeHandler): () => void {
  _userIdChangeHandlers.push(handler);
  return () => {
    const i = _userIdChangeHandlers.indexOf(handler);
    if (i >= 0) _userIdChangeHandlers.splice(i, 1);
  };
}

/** 设置当前 user — 不再影响 loadConfig/saveConfig 路径, 只负责登录态私有资源和缓存失效事件. */
export function setCurrentUserId(userId: string | null): void {
  const prev = _currentUserId;
  const next = userId && typeof userId === 'string' ? userId : null;
  if (prev === next) return;
  _currentUserId = next;
  for (const handler of _userIdChangeHandlers) {
    try { handler(next, prev); } catch (err) {
      /* 单个 handler 抛错被吞, 不影响其他 */
      console.error('[config:onUserIdChange] handler threw:', err);
    }
  }
}

/** 拿当前 user (调试 / 校验用). */
export function getCurrentUserId(): string | null {
  return _currentUserId;
}

export function getActiveConfigFile(): string {
  return CONFIG_FILE;
}

export function getActiveConfigDir(): string {
  return CONFIG_DIR;
}

/** MCP / 其它 per-user 私有资源用.
 *  BYOK providers 已全局化, 但 OAuth token / 临时用户态数据仍必须按登录用户隔离. */
export function getActiveUserDir(): string {
  const uid = getCurrentUserId();
  if (!uid) return CONFIG_DIR;
  return path.join(CONFIG_DIR, 'users', sanitizeUserIdForPath(uid));
}

export function migratePerUserBucketsToGlobal(): { migratedProviders: number; scannedBuckets: number } {
  const markerFile = path.join(CONFIG_DIR, '.migrated_to_global_v2');
  try {
    if (fs.existsSync(markerFile)) return { migratedProviders: 0, scannedBuckets: 0 };
  } catch { /* ignore */ }

  let migratedProviders = 0;
  let scannedBuckets = 0;
  try {
    const usersDir = path.join(CONFIG_DIR, 'users');
    if (!fs.existsSync(usersDir)) {
      /* 从未有 per-user 桶, 直接打 marker */
      try { fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 }); fs.writeFileSync(markerFile, new Date().toISOString(), { mode: 0o600 }); } catch { /* ignore */ }
      return { migratedProviders: 0, scannedBuckets: 0 };
    }

    /* 读全局 config (可能是空对象) */
    let globalRaw = '{}';
    try { globalRaw = fs.readFileSync(CONFIG_FILE, 'utf-8'); } catch { /* 全局 config 不存在, 起始视为空 */ }
    let globalCfg: any = {};
    try { globalCfg = JSON.parse(globalRaw); } catch { globalCfg = {}; }
    const globalProviders: Record<string, any> = globalCfg.providers && typeof globalCfg.providers === 'object' ? { ...globalCfg.providers } : {};

    const bucketDirs = fs.readdirSync(usersDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const bucket of bucketDirs) {
      const bucketConfig = path.join(usersDir, bucket.name, 'config.json');
      if (!fs.existsSync(bucketConfig)) continue;
      scannedBuckets++;
      try {
        const bucketRaw = fs.readFileSync(bucketConfig, 'utf-8');
        const bucketCfg = JSON.parse(bucketRaw);
        const bucketProviders: Record<string, any> = bucketCfg?.providers && typeof bucketCfg.providers === 'object' ? bucketCfg.providers : {};
        for (const [id, entry] of Object.entries(bucketProviders)) {
          if (id === 'neox-cloud') continue; /* sentinel 不迁 (全局根据登录态动态确保) */
          if (globalProviders[id]) continue; /* 全局已有 — 优先保留 */
          globalProviders[id] = entry;
          migratedProviders++;
        }
        if (!globalCfg.lastSelectedProvider && bucketCfg.lastSelectedProvider) globalCfg.lastSelectedProvider = bucketCfg.lastSelectedProvider;
        if (!globalCfg.defaultProvider && bucketCfg.defaultProvider) globalCfg.defaultProvider = bucketCfg.defaultProvider;
      } catch { /* 单个 bucket 解析失败 skip, 别阻塞其他 */ }
    }

    if (migratedProviders > 0) {
      const nextCfg = { ...globalCfg, providers: globalProviders };
      try {
        fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(nextCfg, null, 2), { mode: 0o600 });
      } catch { /* 写失败, marker 也别打 (下次再试) */
        return { migratedProviders: 0, scannedBuckets };
      }
    }

    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(markerFile, new Date().toISOString(), { mode: 0o600 });
    } catch { /* marker 写失败下次会重试, 无害 */ }
  } catch {
    /* 兜底 — migrate 失败不影响正常启动 */
  }
  return { migratedProviders, scannedBuckets };
}

/** userId 进文件路径前清洗 — 避免 path traversal / 非法字符. 限制 [a-zA-Z0-9_-], 截 64. */
function sanitizeUserIdForPath(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return cleaned || 'unknown';
}

function stripSupervisorConfig(config: NeoxConfig): { config: NeoxConfig; changed: boolean } {
  let next = config;
  let changed = false;

  if (typeof next.supervisor !== 'undefined') {
    next = { ...next };
    delete next.supervisor;
    changed = true;
  }

  if (next.assistant?.supervisorAgent) {
    if (next === config) {
      next = { ...next };
    }
    const nextAssistant = { ...next.assistant };
    delete nextAssistant.supervisorAgent;
    if (Object.keys(nextAssistant).length === 0) {
      delete next.assistant;
    } else {
      next.assistant = {
        ...nextAssistant,
        workerPool: nextAssistant.workerPool ?? [],
      };
    }
    changed = true;
  }

  const modeConfigs = next.runConfig?.modes;
  if (modeConfigs) {
    const normalizedModes = { ...modeConfigs };
    let modeChanged = false;

    (['agentic'] as const).forEach((mode) => {
      const modeConfig = normalizedModes[mode];
      if (modeConfig && !Array.isArray(modeConfig.workerPool)) {
        normalizedModes[mode] = {
          ...modeConfig,
          workerPool: [],
        };
        modeChanged = true;
      }
    });

    if (modeChanged) {
      if (next === config) {
        next = { ...next };
      }
      next.runConfig = {
        ...next.runConfig,
        modes: normalizedModes,
      };
      changed = true;
    }
  }

  return { config: next, changed };
}

// ==================== Config Validation ====================

export interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
  config: NeoxConfig;
}

/**
 * Lightweight manual validation for NeoxConfig.
 * Returns the config even if partially invalid (best-effort).
 */
export function validateConfig(raw: any): ConfigValidationResult {
  const errors: string[] = [];

  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: ['Config must be a JSON object'], config: {} };
  }

  const config = raw as NeoxConfig;

  // --- providers ---
  if (config.providers !== undefined) {
    if (typeof config.providers !== 'object' || Array.isArray(config.providers) || config.providers === null) {
      errors.push('providers must be a Record<string, ProviderConfigEntry>');
    } else {
      for (const [key, entry] of Object.entries(config.providers)) {
        const prefix = `providers["${key}"]`;
        if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
          errors.push(`${prefix} must be an object`);
          continue;
        }
        if (typeof entry.id !== 'string' || entry.id.length === 0) {
          errors.push(`${prefix}.id must be a non-empty string`);
        }
        if (typeof entry.protocol !== 'string' || entry.protocol.length === 0) {
          errors.push(`${prefix}.protocol must be a non-empty string`);
        }
        if (typeof entry.name !== 'string' || entry.name.length === 0) {
          errors.push(`${prefix}.name must be a non-empty string`);
        }
      }
    }
  }

  // --- defaultProviderId ---
  if (config.defaultProviderId !== undefined && typeof config.defaultProviderId !== 'string') {
    errors.push('defaultProviderId must be a string');
  }

  // --- approvalMode / agentApprovalMode ---
  const VALID_APPROVAL_MODES = ['auto', 'manual', 'dangerous'];
  for (const key of ['approvalMode', 'agentApprovalMode'] as const) {
    const val = (config as Record<string, unknown>)[key];
    if (val === undefined) continue;
    if (typeof val !== 'string' || !VALID_APPROVAL_MODES.includes(val)) {
      errors.push(`${key} must be one of: ${VALID_APPROVAL_MODES.join(', ')}`);
    }
  }

  // --- language ---
  if (config.language !== undefined) {
    const validLangs = ['zh', 'en'];
    if (typeof config.language !== 'string' || !validLangs.includes(config.language)) {
      errors.push(`language must be one of: ${validLangs.join(', ')}`);
    }
  }

  // --- runMode ---
  if (config.runMode !== undefined) {
    const validRunModes = ['agentic', 'single', 'basic'];
    if (typeof config.runMode !== 'string' || !validRunModes.includes(config.runMode)) {
      errors.push(`runMode must be one of: ${validRunModes.join(', ')}`);
    }
  }

  // --- defaultAgentMode (用途模式) ---
  if (config.defaultAgentMode !== undefined) {
    /* 'assistant' (Life, 已删除) 仍算合法: loadConfig 紧接着把它改成 work, 不该先报一条错 */
    const validAgentModes = ['assistant', 'work', 'code'];
    if (typeof config.defaultAgentMode !== 'string' || !validAgentModes.includes(config.defaultAgentMode)) {
      errors.push(`defaultAgentMode must be one of: ${validAgentModes.join(', ')}`);
    }
  }

  // --- boolean fields ---
  const booleanFields: (keyof NeoxConfig)[] = [
    'piiFilterEnabled', 'hasSeenOnboarding', 'cliDebug',
    'agentSandboxEnabled', 'autoHealthCheckEnabled',
  ];
  for (const field of booleanFields) {
    if ((config as any)[field] !== undefined && typeof (config as any)[field] !== 'boolean') {
      errors.push(`${field} must be a boolean`);
    }
  }

  // --- recentWorkspaces ---
  if (config.recentWorkspaces !== undefined) {
    if (!Array.isArray(config.recentWorkspaces)) {
      errors.push('recentWorkspaces must be an array of strings');
    }
  }

  return { valid: errors.length === 0, errors, config };
}

/**
 * Validate the config file on disk and return a human-readable result.
 * Useful for CLI commands like `neox config validate`.
 */
export function validateConfigFile(): ConfigValidationResult {
  const activeFile = getActiveConfigFile();
  try {
    const data = fs.readFileSync(activeFile, 'utf-8');
    const parsed = JSON.parse(data);
    return validateConfig(parsed);
  } catch (err) {
    const message = err instanceof SyntaxError
      ? `Invalid JSON: ${err.message}`
      : `Cannot read config file: ${(err as Error).message}`;
    return { valid: false, errors: [message], config: {} };
  }
}

function applyConfigDefaults(config: NeoxConfig): NeoxConfig {
  if (config.experimental?.enableCheckpoint === undefined) {
    return { ...config, experimental: { ...config.experimental, enableCheckpoint: true } };
  }
  return config;
}

export function loadConfig(): NeoxConfig {
  const activeFile = getActiveConfigFile();
  try {
    const data = fs.readFileSync(activeFile, 'utf-8');
    const parsed = JSON.parse(data);
    const validation = validateConfig(parsed);
    if (!validation.valid) {
      for (const err of validation.errors) {
        cliLogger.warn('Config', err);
      }
    }
    const { config, changed: supervisorStripped } = stripSupervisorConfig(applyConfigDefaults(validation.config));
    const legacy = config as NeoxConfig & { lifeTakeover?: unknown; lifeProactive?: unknown };
    const lifeRetired = (legacy.defaultAgentMode as string | undefined) === 'assistant'
      || legacy.lifeTakeover !== undefined || legacy.lifeProactive !== undefined;
    if ((legacy.defaultAgentMode as string | undefined) === 'assistant') legacy.defaultAgentMode = 'work';
    delete legacy.lifeTakeover;
    delete legacy.lifeProactive;
    const changed = supervisorStripped || lifeRetired;
    if (changed) {
      try {
        saveConfig(config);
      } catch {
        // Best-effort migration; keep runtime config even if write fails.
      }
    }
    /* 记下本进程"刚从磁盘 load 到"的快照, 作为下次 saveConfig 三方合并的 baseline.
     * 这样并发的另一进程 (CLI↔桌面) 的改动能在 save 时被保留, 不被整体覆盖. */
    _configBaseline = structuredClone(config);
    _baselineByObject.set(config, structuredClone(config));
    return config;
  } catch (e) {
    /* 读盘/解析失败 —— 不只是"文件损坏", EMFILE / EACCES / 瞬时锁竞争都会走到这里.
     * 必须留痕: 静默返回 {} 会让整个应用以"零配置"启动, 用户只看到"我的 provider 全没了".
     * _configBaseline 保持 null → saveConfig 侧禁用删除, 保证这里的空配置不会被写回磁盘覆盖真数据. */
    if (fs.existsSync(activeFile)) {
      cliLogger.error('Config', `读取配置失败, 本次以空配置启动 (磁盘文件保持原样): ${(e as Error)?.message ?? e}`);
      if (!_corruptBackupDone) {
        _corruptBackupDone = true;
        try {
          const bak = `${activeFile}.corrupt.${Date.now()}`;
          fs.copyFileSync(activeFile, bak);
          cliLogger.error('Config', `已备份问题文件到 ${bak}`);
        } catch { /* best-effort, 不能因为备份失败再抛 */ }
      }
    }
    return {};
  }
}

/** 损坏配置只备份一次, 防反复读失败刷出一堆 .corrupt 文件. */
let _corruptBackupDone = false;

/**
 * 读取子 Agent 并发策略 ('auto' | 'low').
 * 不传 config 时通过 loadConfig() 读盘. 未设置时回退 DEFAULT_CONCURRENCY_PROFILE ('auto').
 */
export function getConcurrencyProfile(config?: NeoxConfig): 'auto' | 'low' {
  const cfg = config ?? loadConfig();
  return cfg?.concurrencyProfile ?? DEFAULT_CONCURRENCY_PROFILE;
}


let _configBaseline: NeoxConfig | null = null;

const _baselineByObject = new WeakMap<object, NeoxConfig>();

function _isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function _deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => _deepEqual(x, b[i]));
  }
  if (_isPlainObject(a) && _isPlainObject(b)) {
    const ak = Object.keys(a), bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => Object.prototype.hasOwnProperty.call(b, k) && _deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * 三方合并: 在 theirs (磁盘当前) 之上, 套用"本进程相对 base 的改动 (mine)".
 *   · mine 改了某 key (mine[k] != base[k]) → 用 mine 的值 (本进程的意图);
 *     - mine 删了 key (base 有 mine 没) → 从结果删掉;
 *     - mine/base/theirs 该 key 都是普通对象 → 递归合并 (例如 providers / mcpServers map,
 *       这样 CLI 加 provider P、桌面加 provider Q 能同时保留);
 *     - 否则 (基本类型 / 数组 / 新对象) → mine 整体覆盖.
 *   · mine 没改某 key → 保留 theirs (对方进程可能改了它).
 */
function merge3Way(
  base: Record<string, unknown>,
  mine: Record<string, unknown>,
  theirs: Record<string, unknown>,
  allowDeletions = true,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...theirs };
  const keys = new Set([...Object.keys(mine), ...Object.keys(base)]);
  for (const k of keys) {
    const mineV = mine[k], baseV = base[k], theirV = theirs[k];
    if (_deepEqual(mineV, baseV)) continue; // 本进程没动这个 key → 保留 theirs
    if (mineV === undefined) {
      /* base 有 mine 没 —— 只有在 base 可信 (确实是本进程 load 到的快照) 时才能断定"用户删了它".
       * base 不可信时 (见 saveConfig: _configBaseline 为 null → 拿 onDisk 顶替), 缺键只说明
       * 调用方没带上这个键, 不代表要删 —— 此时删除会把磁盘上的 providers/apiKey 全清空. */
      if (allowDeletions) delete result[k];
      continue;
    }
    if (_isPlainObject(mineV) && _isPlainObject(theirV) && _isPlainObject(baseV ?? {})) {
      result[k] = merge3Way((baseV as Record<string, unknown>) ?? {}, mineV, theirV, allowDeletions);
    } else {
      result[k] = mineV; // 基本类型 / 数组 / 类型变化 → mine 胜
    }
  }
  return result;
}

/** 同步睡眠 (锁等待用). Atomics.wait 不阻塞 CPU; 拿不到 SharedArrayBuffer 时退化忙等. */
function _syncSleep(ms: number): void {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const end = Date.now() + ms; while (Date.now() < end) { /* spin */ } }
}

/** 跨进程文件锁 (O_EXCL 原子建锁文件). 持锁仅 ~ms (重读+合并+写). 锁陈旧 (>STALE) 判持有者
 *  崩溃 → 抢占. 总等待封顶, 绝不永久阻塞 (config 写是同步热路径). */
function withConfigLock<T>(lockPath: string, fn: () => T): T {
  const STALE_MS = 5000;     // 锁文件超过 5s = 持有者崩了, 抢
  const MAX_WAIT_MS = 8000;  // 兜底: 等超过 8s 强抢, 防永久卡
  const SPIN_MS = 25;
  const NON_EEXIST_RETRIES = 3;
  const NON_EEXIST_RETRY_DELAY_MS = 10;
  const start = Date.now();
  let fd = -1;
  let nonExistFailures = 0;
  for (;;) {
    try { fd = fs.openSync(lockPath, 'wx'); break; }
    catch (e: any) {
      if (e?.code !== 'EEXIST') {
        if (++nonExistFailures <= NON_EEXIST_RETRIES) { _syncSleep(NON_EEXIST_RETRY_DELAY_MS); continue; }
        // 重试仍失败才降级无锁写 (不让 saveConfig 失败), 但要留下痕迹, 不再静默
        cliLogger.warn('Config',
          `config lock unavailable after ${NON_EEXIST_RETRIES} retries (${e?.code ?? e?.message ?? e}) — falling back to lockless write`);
        fd = -1;
        break;
      }
      let stale = false;
      try { stale = (Date.now() - fs.statSync(lockPath).mtimeMs) > STALE_MS; } catch { stale = true; }
      if (stale || (Date.now() - start) > MAX_WAIT_MS) { try { fs.unlinkSync(lockPath); } catch { /* race */ } continue; }
      _syncSleep(SPIN_MS);
    }
  }
  try { if (fd >= 0) fs.writeSync(fd, String(process.pid)); } catch { /* best-effort */ }
  try { return fn(); }
  finally {
    if (fd >= 0) { try { fs.closeSync(fd); } catch { /* ignore */ } try { fs.unlinkSync(lockPath); } catch { /* ignore */ } }
  }
}

export function saveConfig(config: NeoxConfig): void {
  const activeFile = getActiveConfigFile();
  const activeDir = getActiveConfigDir();
  try {
    const { config: sanitized } = stripSupervisorConfig(config);
    if (!fs.existsSync(activeDir)) {
      fs.mkdirSync(activeDir, { recursive: true, mode: 0o700 });
    }
    /* 跨进程锁内三方合并 + 原子写 (.tmp.<pid> → rename). 锁防 CLI/桌面并发互覆盖;
     * rename 防 crash 中撕裂; 合并防丢对方改动. 见上方 merge3Way / withConfigLock 注释. */
    withConfigLock(`${activeFile}.lock`, () => {
      let onDisk: Record<string, unknown> = {};
      try {
        if (fs.existsSync(activeFile)) onDisk = JSON.parse(fs.readFileSync(activeFile, 'utf-8')) ?? {};
      } catch { onDisk = {}; }
      /* baseline 可信 ⇔ 本进程真的成功 loadConfig 过 (_configBaseline 非 null).
       * 不可信时拿 onDisk 顶替只是为了让"改了什么"仍能算出来, 但**不能**据此推断删除:
       * loadConfig 读盘/解析失败会静默返回 {}, 调用方基于空配置存一次, 就会把磁盘上
       * 所有 provider / apiKey 判成"被用户删了"而清空。见 merge3Way 的 allowDeletions. */
      /* 优先用这个对象自己 load 时的快照 (见 _baselineByObject); 派生出来的新对象 ({...config}) 没有, 退回进程级 */
      const ownBaseline = _baselineByObject.get(config as object);
      const baselineTrusted = ownBaseline !== undefined || _configBaseline !== null;
      const baseline = (ownBaseline ?? _configBaseline ?? onDisk) as Record<string, unknown>;
      const merged = merge3Way(
        baseline,
        sanitized as Record<string, unknown>,
        onDisk,
        baselineTrusted,
      ) as NeoxConfig;
      const serialized = JSON.stringify(merged, null, 2);
      const tmpPath = `${activeFile}.tmp.${process.pid}`;
      // (config 含 BYOK provider apiKey 字段, 短暂 0644 期内同机其他进程可读 → 走 OS keychain 是
      // 更彻底方案, 但 0600 是商用版的最低线, 跟 auth.enc 一致)
      const fd = fs.openSync(tmpPath, 'w', 0o600);
      try {
        fs.writeSync(fd, serialized, null, 'utf-8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmpPath, activeFile);
      _configBaseline = structuredClone(merged); // 更新 baseline = 刚落盘的真实态
      _baselineByObject.set(config as object, structuredClone(sanitized));
    });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      console.error(`\n❌ Permission denied: Cannot write to config file`);
      console.error(`   Location: ${activeFile}`);
      console.error(`\n   Please check directory permissions or try:`);
      console.error(`   sudo chown -R $USER "${activeDir}"\n`);
    } else {
      console.error('[Config] Failed to save configuration:', err.message);
    }
    throw error; // Re-throw to stop execution on critical config save failures
  }
}

const CLAUDE_CODE_USER_ID_REGEX =
  /^user_([0-9a-f]{64})_account__session_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const CLAUDE_CODE_CLIENT_ID_REGEX = /^[0-9a-f]{64}$/;
const SESSION_UUID_REGEX = /session_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

function formatUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function generateUUID(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuid(bytes);
}

function extractClientIdFromUserId(userId: string): string | null {
  const match = userId.match(CLAUDE_CODE_USER_ID_REGEX);
  return match?.[1] ?? null;
}

function deriveSessionUuid(seed: string): string {
  const hash = createHash('sha256').update(seed).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuid(bytes);
}

export function getOrCreateAnthropicClientId(): string {
  const config = loadConfig();
  const existing = typeof config.anthropicClientId === 'string'
    ? config.anthropicClientId.trim().toLowerCase()
    : '';

  if (existing && CLAUDE_CODE_CLIENT_ID_REGEX.test(existing)) {
    return existing;
  }

  const legacyProxy = typeof config.anthropicProxyUserId === 'string'
    ? config.anthropicProxyUserId.trim().toLowerCase()
    : '';
  const migrated = legacyProxy ? extractClientIdFromUserId(legacyProxy) : null;

  const clientId = migrated || randomBytes(32).toString('hex');
  config.anthropicClientId = clientId;
  saveConfig(config);
  return clientId;
}

export function buildClaudeCodeUserId(sessionId?: string, seed?: string): string {
  const clientId = getOrCreateAnthropicClientId();
  const sessionMatch = sessionId ? sessionId.match(SESSION_UUID_REGEX) : null;
  const sessionUuid = sessionMatch?.[1]?.toLowerCase()
    || deriveSessionUuid(sessionId || seed || generateUUID());
  return `user_${clientId}_account__session_${sessionUuid}`;
}

setKernelConfigProvider(() => loadConfig());
