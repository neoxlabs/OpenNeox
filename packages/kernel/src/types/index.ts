/**
 * Core type definitions for Neox CLI
 */

import type { ContextTokenBreakdown } from '../utils/contextBreakdown.js';

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

/** Content part for multimodal messages */
export type MessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }
  | { type: 'tool_use'; id: string; name: string; input: any }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: 'thinking'; thinking?: string; signature?: string }
  | { type: 'redacted_thinking'; data?: string };

/** Image attachment for user messages */
export interface ImageAttachment {
  mediaType: string;
  data: string;
}

/** Message content can be string or array of content parts (for multimodal) */
export type MessageContent = string | MessageContentPart[] | null;

export interface Message {
  role: MessageRole;
  content: MessageContent;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  /** Reasoning/thinking content from extended thinking models (text only, for display) */
  reasoning_content?: string;
  /** Complete thinking blocks from Anthropic (including signature) for API pass-through */
  thinking_blocks?: Array<{
    type: 'thinking' | 'redacted_thinking';
    thinking?: string;
    signature?: string;
    data?: string; // for redacted_thinking
  }>;
  /** OpenAI Responses API reasoning items — 推理模型 (gpt-5/o-series) 上一轮回的
   *  encrypted_content blob 必须原样在下一轮 input 里回传, 否则 OpenAI 直接 400
   *  invalid_prompt (推理链断了, 模型无法连贯继续 tool_call 后的判断). 此字段
   *  仅 openai.ts 在 Responses API 路径下读写, 其它 provider 忽略. */
  openai_reasoning_items?: Array<{
    id?: string;
    summary?: Array<{ type?: string; text?: string }>;
    encrypted_content?: string;
  }>;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
  /** Gemini thinking 模式的签名，需要在历史消息中保留 */
  thoughtSignature?: string;
  /** Kimi 内置工具标记（如 $web_search） */
  __kimi_builtin?: boolean;
  __kimi_original_name?: string;
  /** 流式状态：已流式推送的 arguments 长度（agentLoop 内部使用） */
  _lastStreamedLen?: number;
  /** 流式状态：file_path 是否已发送给 UI（agentLoop 内部使用） */
  _filePathSent?: boolean;
  /** 流式状态：open_surface 的 kind 是否已发给 UI(让右栏立刻显示 streaming surface tab) */
  _surfaceKindSent?: boolean;
  /** 流式状态：第一次 content_delta 是否已发 — 让 UI 立刻看到内容(不等 500 字 throttle) */
  _firstContentSent?: boolean;
}

/** 详细的 Token 使用统计 - 支持缓存信息 */
export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** OpenAI: cached_tokens from prompt_tokens_details */
  cached_tokens?: number;
  /** OpenAI/Proxy: prompt cache hit tokens */
  prompt_cache_hit_tokens?: number;
  /** OpenAI/Proxy: prompt cache miss (cache write) tokens */
  prompt_cache_miss_tokens?: number;
  /** Anthropic: cache_read_input_tokens (10% cost) */
  cache_read_input_tokens?: number;
  /** Anthropic: cache_creation_input_tokens (125% cost for 5m) */
  cache_creation_input_tokens?: number;
  /** OpenAI-compatible proxy: cache write tokens */
  cache_write_input_tokens?: number;
  /** Anthropic: 5-minute cache creation */
  cache_creation_5m_tokens?: number;
  /** Anthropic: 1-hour cache creation */
  cache_creation_1h_tokens?: number;
  /** OpenAI: prompt_tokens_details */
  prompt_tokens_details?: {
    cached_tokens?: number;
    text_tokens?: number;
    audio_tokens?: number;
    image_tokens?: number;
  };
  /** OpenAI: completion_tokens_details */
  completion_tokens_details?: {
    text_tokens?: number;
    audio_tokens?: number;
    reasoning_tokens?: number;
  };
}

export interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: ToolCall[];
      reasoning_content?: string;
    };
    finish_reason: string;
  }>;
  usage: TokenUsage;
}

export type ToolCapability = 'terminal' | 'editor' | 'debug' | 'trace' | 'gui';

export type ToolCapabilitySet = Partial<Record<ToolCapability, boolean>>;

/**
 * Tool result group used for UI classification and context-retention policy.
 */
export type ToolGroup = 'read' | 'write' | 'execute' | 'search' | 'git' | 'test' | 'config' | 'agent' | 'memory';

export interface Tool {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
    additionalProperties?: boolean;
  };
  function: (
    args: any,
    context?: {
      signal?: AbortSignal;
      /** Read-only waits may yield when a newer steering message is queued. */
      shouldYieldToSteering?: () => boolean;
      /** LLM 给的 tool_use_id, 由 orchestrate → runner.invokeTool 透传过来.
       *  工具内部需要发流式事件 (例如 shell_output_stream) 时, 应优先用这个 id,
       *  让事件的 toolId 跟 timeline entry.toolCallId 对齐, UI 才能正确订阅. */
      toolCallId?: string;
      /** 当前 runner 所属 session — call_tool 派发 target_* 等 session-scoped 工具时
       *  用它包 ALS, 避免只靠模块级 _fallbackSessionId (子 agent buildRunner 会改写). */
      sessionId?: string;
      /** 安全: 动态派发型元工具 (call_tool) 在真正执行被包裹工具前, 必须回过同一套
       *  安全闸 (PermissionManager 审批 + risk 评估). 由 runner.invokeTool 注入并闭包到当前
       *  ToolUseContext; 元工具拿到后对 wrapped tool 调它, 拒绝则不执行. 缺省 (非 runner 路径 /
       *  普通工具) 时元工具走原逻辑. 见 审计: 缺此钩子时 delete_file 等 deferred
       *  高危工具经 call_tool 直调 tool.function 会绕过审批. */
      checkNestedToolGate?: (
        tool: Tool,
        args: Record<string, unknown>,
      ) => Promise<{ allowed: boolean; reason?: string }>;
    },
  ) => Promise<string> | string;
  /** 工具权限元数据（可选） */
  permission?: import('./permissions.js').ToolPermissionMetadata;
  /** 工具能力标记（可选） */
  capabilities?: ToolCapability[];
  /** 并行执行安全等级：safe 可并行，unsafe 必须串行 */
  parallelSafety?: 'safe' | 'unsafe';

  /**
   * 动态并发安全判定(按参数决定)。优先级最高, 覆盖 parallelSafety/isReadOnly/全局白名单。
   *
   * 典型用法:
   *   · readfile: num_lines > 5000 → unsafe(避免并发读大文件 OOM)
   *   · execute_shell: command 是 ls/cat/pwd/git status 等只读 → safe(允许并发)
   *   · grep: 复杂 regex 或巨大 path → unsafe
   *
   * 返回 true 表示可以和其他 tool 并发;false 强制串行。未定义时 fallback 到
   * parallelSafety / isReadOnly / 全局白名单。
   */
  isConcurrencySafe?(args: Record<string, any>): boolean;

  // Tool behavior metadata is declared on the tool so dispatch and UI policies share one contract.

  /** 只读工具标记 — 替代 capabilityResolver 的硬编码列表 */
  isReadOnly?: boolean;
  /** 工具功能分组 — 用于 UI 分类和过滤 */
  group?: ToolGroup;
  /** 工具专属超时（毫秒） — 替代全局 120s 一刀切 */
  timeoutMs?: number;
  /**
   * 结果分类 — 决定输出是否进入长期上下文
   * - 'ephemeral': 执行确认型，不保留（write_file, edit）
   * - 'contextual': 信息供给型，完整保留（readfile, grep）
   * - 'summarized': 摘要型，压缩保留（execute_shell, test）
   *
   * 未设置时回退到 toolClassification.ts 的全局 Map（兼容现有工具）
   */
  resultType?: 'ephemeral' | 'contextual' | 'summarized';
  /** 工具名别名列表 — LLM 常用变体名自动映射 */
  aliases?: string[];

  /**
   * Custom affected-path extractor used by batch file-scoped locking.
   *
   * Implementations return every path touched by the invocation so the scheduler can
   * serialize conflicting tools, including arguments with nested or array-based paths.
   *
   * Return absolute or workspace-relative paths; an empty array means that the tool
   * touches no files. When absent, scheduling falls back to default extraction.
   */
  getAffectedResources?(args: Record<string, unknown>): string[];
}

export interface LLMProvider {
  chat(
    messages: Message[],
    options: {
      model?: string;
      tools?: Tool[];
      temperature?: number;
      structuredOutput?: StructuredOutputDefinition;
      maxInputTokens?: number;
      maxTokens?: number;
      disableSystemPrompt?: boolean;
      signal?: AbortSignal;
    }
  ): Promise<ChatCompletionResponse>;

  chatStreamed(
    messages: Message[],
    options: {
      model?: string;
      tools?: Tool[];
      temperature?: number;
      structuredOutput?: StructuredOutputDefinition;
      maxInputTokens?: number;
      maxTokens?: number;
      disableSystemPrompt?: boolean;
      enableFGTS?: boolean;
      /** Predicted Outputs: 预填文件内容，加速 edit 类输出 */
      prediction?: { type: 'content'; content: string };
      signal?: AbortSignal;
    }
  ): AsyncGenerator<any>;
}

export interface AgentConfig {
  /**
   * Maximum iterations for agent execution.
   * Set to 0 or Infinity for unlimited iterations.
   * Default: 100
   */
  maxIterations?: number;
  /**
   * Maximum total tool calls for a run.
   * Set to 0 or Infinity for unlimited tool calls.
   * Default: 200
   */
  maxToolCalls?: number;
  /**
   * Maximum runtime for a run (ms).
   * Set to 0 or Infinity for unlimited runtime.
   * Default: 30 minutes
   */
  maxRuntimeMs?: number;
  temperature: number;
  /**
   * Agent mode - controls tool availability and permissions
   * - ask: Read-only mode (only read tools allowed)
   * - agent: Standard mode (all tools with approval)
   * - auto: Auto mode (all tools auto-approved)
   * Default: agent
   */
  mode?: import('./permissions.js').AgentMode;
  /**
   * 启用 Thinking 模式 (Gemini 3 Pro Preview 等模型)
   * 当开启时，模型会先"思考"然后再回答
   * Default: false
   */
  enableThinking?: boolean;
  /**
   * Thinking 模式的 token 预算
   * 限制模型思考的最大 token 数，防止 thinking 循环
   * Default: 8192
   */
  thinkingBudget?: number;
}

/**
 * Long-running work is unlimited by default. Progress guards stop stalled agents,
 * while callers can set explicit iteration or tool-call limits for bounded runs.
 */
export const DEFAULT_MAX_ITERATIONS = 0;   // 0 = 无限, 靠 turnStallGuard 按进展兜底
export const DEFAULT_MAX_TOOL_CALLS = 0;   // 0 = 无限, 同上
export const DEFAULT_MAX_RUNTIME_MS = 0;   // 0 = 无限, 主 agent 靠自动压缩续命

export interface StructuredOutputDefinition {
  name: string;
  schema: Record<string, any>;
  description?: string;
  strict?: boolean;
}

export interface StructuredOutputValidationResult {
  ok: boolean;
  normalized?: string;
  parsed?: any;
  reason?: 'empty_output' | 'parse_error' | 'schema_mismatch';
  message?: string;
  errors?: string[];
}

/**
 * 运行时上下文 - 传递给动态 instructions 函数
 * RunContext - passed to dynamic instructions function
 */
export interface RunContext {
  /** 当前任务/用户输入 */
  task: string;
  /** 当前时间戳 */
  timestamp: number;
  /** 当前日期时间 */
  currentTime: Date;
  /** 迭代次数 */
  iteration: number;
  /** 自定义用户数据（可选） */
  userData?: Record<string, any>;
  /** 系统状态（可选） */
  systemStatus?: {
    maintenance?: boolean;
    incident?: string;
  };
  /** Session ID — 用于 per-session approval mode 等 scope 隔离场景.
   * 由 agenticRuntime/assistantRuntime 构造 Runner 时传入, 流到 orchestrator
   * 后作为 PermissionManager.checkPermission 的 scopeKey, 实现"每个 session
   * 独立 approval mode". 缺失时 orchestrator 兜底用 agentName. */
  sessionId?: string;
}

/**
 * Instructions 函数类型 - 支持同步或异步
 * InstructionsFunction type - supports sync or async
 */
export type InstructionsFunction = (
  context: RunContext,
  agent: { name: string; description: string }
) => string | Promise<string>;

/**
 * Instructions 类型 - 支持静态字符串或动态函数
 * Instructions type - supports static string or dynamic function
 */
export type Instructions = string | InstructionsFunction;

export interface AgentDefinition {
  name: string;
  description: string;  // 面向开发者的通用描述
  handoffDescription?: string;  // 面向其他 Agent 的描述，用于 handoff 决策
  instructions: Instructions;  // 支持动态 instructions
  tools?: Tool[];
}

export interface AgentStatusCallback {
  onThinking?: (iteration: number) => void;
  onToolCall?: (toolName: string, args: any) => void;
  onToolResult?: (toolName: string, result: string, success: boolean) => void;
  onComplete?: () => void;
}

export interface AgentResult {
  output: string;
  iterations: number;
  toolCalls: ToolCall[];
  usage: {
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
  };
  structuredOutput?: any;
  structuredOutputName?: string;
}

/**
 * Lifecycle Hooks - 在 Agent 执行的关键节点插入自定义逻辑
 * Lifecycle Hooks - Insert custom logic at key points in Agent execution
 */

/**
 * 工具调用决策
 * Tool call decision from beforeToolCall hook
 */
export interface ToolCallDecision {
  /** 是否允许执行工具 */
  allow: boolean;
  /** 拒绝原因（如果 allow = false）*/
  reason?: string;
  /** 修改后的参数（可选，用于参数转换）*/
  modifiedArgs?: any;
}

/**
 * 工具验证结果
 * Tool validation result from afterToolCall hook
 */
export interface ToolValidationResult {
  /** 验证是否通过 */
  valid: boolean;
  /** 验证失败原因 */
  reason?: string;
  /** 是否应该重试工具调用 */
  retry?: boolean;
  /** 备用结果（如果 retry = false 但希望使用其他结果）*/
  fallbackResult?: string;
}

/**
 * 迭代决策
 * Iteration decision from afterIteration hook
 */
export interface IterationDecision {
  /** 是否应该继续迭代 */
  shouldContinue: boolean;
  /** 决策原因 */
  reason?: string;
}

/**
 * 错误恢复策略
 * Error recovery strategy from onError hook
 */
export interface ErrorRecovery {
  /** 恢复策略 */
  strategy: 'retry' | 'fallback' | 'abort';
  /** 重试延迟（毫秒）*/
  retryDelay?: number;
  /** 备用模型（用于 fallback 策略）*/
  fallbackModel?: string;
  /** 最大重试次数 */
  maxRetries?: number;
}

/**
 * Agent Lifecycle Hooks 接口
 */
export interface AgentHooks {
  // ========= 运行生命周期 =========
  /**
   * 在 Agent 运行前调用
   * @param context 运行时上下文
   */
  beforeRun?: (context: RunContext) => Promise<void> | void;

  /**
   * 在 Agent 运行后调用
   * @param context 运行时上下文
   * @param result Agent 执行结果
   */
  afterRun?: (context: RunContext, result: AgentResult) => Promise<void> | void;

  /**
   * 在发生错误时调用
   * @param error 错误对象
   * @param context 运行时上下文
   * @returns 错误恢复策略（可选）
   */
  onError?: (error: Error, context: RunContext) => Promise<ErrorRecovery | void> | ErrorRecovery | void;

  // ========= LLM 调用 =========
  /**
   * 在调用 LLM 前调用
   * @param messages 消息列表
   * @returns 可修改的消息列表
   */
  beforeLLMCall?: (messages: Message[]) => Promise<Message[]> | Message[];

  /**
   * 在 LLM 调用后调用
   * @param response LLM 响应
   * @returns 可修改的响应
   */
  afterLLMCall?: (response: ChatCompletionResponse) => Promise<ChatCompletionResponse> | ChatCompletionResponse;

  // ========= 工具调用（核心验证点）=========
  /**
   * 在工具调用前调用
   * @param toolName 工具名称
   * @param args 工具参数
   * @returns 工具调用决策
   */
  beforeToolCall?: (toolName: string, args: any) => Promise<ToolCallDecision> | ToolCallDecision;

  /**
   * 在工具调用后调用（核心验证点）
   * @param toolName 工具名称
   * @param result 工具返回结果
   * @param success 工具是否执行成功
   * @returns 验证结果
   */
  afterToolCall?: (
    toolName: string,
    result: string,
    success: boolean
  ) => Promise<ToolValidationResult> | ToolValidationResult;

  /**
   * Dedicated hook for failed tool calls; when absent, afterToolCall is used.
   * @param toolName 工具名称
   * @param error 错误信息
   * @param success 始终为 false
   */
  afterToolCallFailure?: (
    toolName: string,
    error: string,
    success: false
  ) => Promise<ToolValidationResult> | ToolValidationResult;

  // ========= 迭代控制 =========
  /**
   * 在每次迭代前调用
   * @param iteration 迭代次数
   */
  beforeIteration?: (iteration: number) => Promise<void> | void;

  /**
   * 在每次迭代后调用
   * @param iteration 迭代次数
   * @param hasToolCalls 本次迭代是否有工具调用
   * @returns 迭代决策
   */
  afterIteration?: (
    iteration: number,
    hasToolCalls: boolean
  ) => Promise<IterationDecision | void> | IterationDecision | void;
}

// RunItem types - represent high-level events during agent execution
export type RunItemType =
  | 'message_output_item'
  | 'tool_call_item'
  | 'tool_call_output_item'
  | 'reasoning_item'
  | 'handoff_call_item'
  | 'handoff_occurred_item';

export interface BaseRunItem {
  type: RunItemType;
  timestamp?: number;
}

export interface MessageOutputItem extends BaseRunItem {
  type: 'message_output_item';
  content: string;
  role: 'assistant';
}

export interface ToolCallItem extends BaseRunItem {
  type: 'tool_call_item';
  id: string;
  name: string;
  arguments: string;
}

export interface ToolCallOutputItem extends BaseRunItem {
  type: 'tool_call_output_item';
  id: string;
  name: string;
  output: string;
  success: boolean;
  /**
   * 被守卫拦下 (loop / permission / risk / guardrail / validate) —— **不是**工具跑失败。
   * 这个区分 orchestrate 一直有, 但到事件层就丢了, 界面上全是红色「失败」。
   */
  blockedBy?: string;
  /** 拦下时给用户看的一句人话; output 里那份是给模型的指令, 不该直接摆给用户 */
  userNotice?: string;
}

export interface ReasoningItem extends BaseRunItem {
  type: 'reasoning_item';
  summary: string;
}

export interface HandoffCallItem extends BaseRunItem {
  type: 'handoff_call_item';
  target_agent: string;
}

export interface HandoffOccurredItem extends BaseRunItem {
  type: 'handoff_occurred_item';
  from_agent: string;
  to_agent: string;
}

export type RunItem =
  | MessageOutputItem
  | ToolCallItem
  | ToolCallOutputItem
  | ReasoningItem
  | HandoffCallItem
  | HandoffOccurredItem;

// Stream event types
export type RunItemStreamEventName =
  | 'message_output_created'
  | 'handoff_requested'
  | 'handoff_occured' // Note: matches OpenAI Agents spelling
  | 'tool_called'
  | 'tool_output'
  | 'reasoning_item_created';

export interface RunItemStreamEvent {
  type: 'run_item_stream_event';
  name: RunItemStreamEventName;
  item: RunItem;
}

export interface RawResponseStreamEvent {
  type: 'raw_response_event';
  data: any; // Raw LLM response event
  event_type?: string; // e.g., 'response.text.delta', 'response.created', etc.
}

export interface AgentUpdatedStreamEvent {
  type: 'agent_updated_stream_event';
  new_agent: {
    name: string;
    instructions?: string;
  };
  previous_agent?: {
    name: string;
  };
}

// Token usage tracking event
export interface TokenUsageStreamEvent {
  type: 'token_usage';
  usage: TokenUsage;
  is_final: boolean; // true = final total, false = incremental update
  requestBreakdown?: ContextTokenBreakdown;
}

/**
 * Stream retry event - emitted when stream reconnects
 */
export interface StreamRetryStreamEvent {
  type: 'stream_retry';
  error: string;
  errorCode: string;
  attempt: number;
  maxRetries: number;
  delayMs: number;
}

/**
 * Stream recovered event - emitted after retry delay when reconnecting
 */
export interface StreamRecoveredStreamEvent {
  type: 'stream_recovered';
  attempt: number;
  maxRetries: number;
}

// Context compaction event
export interface CompressionBucketInfo {
  bucket: 'files' | 'commands' | 'search' | 'conversation';
  label: string;
  messageCount: number;
  estimatedTokens: number;
  status: 'pending' | 'compressing' | 'done' | 'empty';
  compressedTokens?: number;
  /** UI 展示用：涉及的文件/命令/搜索词列表 */
  items?: string[];
}

export interface ContextCompactionStreamEvent {
  type: 'context_compaction';
  status: 'started' | 'compressing' | 'completed';
  originalMessages?: number;
  keptMessages?: number;
  droppedMessages?: number;
  compressedMessages?: number;
  /**
   * Number of messages reduced in place by lightweight compaction or snipping.
   */
  truncatedMessages?: number;
  originalTokens: number;
  finalTokens?: number;
  budgetTokens: number;
  useLLM: boolean;
  timestamp?: number;
  /**
   * Whether token counts include persistent overhead such as tool definitions and system
   * prompts. Consumers use this flag to avoid adding the overhead twice.
   */
  tokensIncludeOverhead?: boolean;
  /** LLM 摘要压缩进度 */
  compression?: {
    phase: 'categorizing' | 'compressing' | 'done';
    totalBuckets: number;
    completedBuckets: number;
    buckets: CompressionBucketInfo[];
    summaryModel: string;
  };
}

/**
 * Plan 事件 - 用于计划模式的流式事件
 */
export interface PlanStreamEvent {
  type: 'plan_update';
  explanation?: string;  // 可选的说明文字
  plan: Array<{
    step: string;        // 步骤描述 (5-7个词)
    status: 'pending' | 'in_progress' | 'completed';
  }>;
  timestamp: number;
}

export type StreamEvent =
  | RunItemStreamEvent
  | RawResponseStreamEvent
  | AgentUpdatedStreamEvent
  | TokenUsageStreamEvent
  | StreamRetryStreamEvent
  | StreamRecoveredStreamEvent
  | ContextCompactionStreamEvent
  | PlanStreamEvent
  // Legacy events for backward compatibility
  | LegacyStreamEvent;

// Legacy stream events for backward compatibility
export interface LegacyStreamEvent {
  type: 'iteration_start' | 'text_delta' | 'reasoning_delta' | 'reasoning_complete' | 'text_done' | 'tool_call_start' | 'tool_call_delta' | 'tool_call_done' | 'tool_output' | 'run_done' | 'error';
  iteration?: number;
  delta?: string;
  name?: string;
  id?: string;
  arguments?: string;
  arguments_delta?: string;
  description?: string;
  output?: string;
  success?: boolean;
  error?: string;
  /**
   * 结构化的错误原因 —— success=false 时由发起方填，让下游 UI 能精确判断
   * "为什么失败"，不需要解析 output / error 字符串。
   * 可选值跟 PermissionDecision.denyKind 一致，加上 'tool_failure' 表示工具
   * 自身执行失败。
   */
  errorReason?: 'denied_by_user' | 'denied_by_config' | 'denied_by_mode' | 'denied_by_hook' | 'tool_failure' | 'error';
  /**
   * Structured upstream error code (for example UNAUTHORIZED, MODEL_NOT_SUPPORTED, or
   * HTTP_500) used by downstream rendering and retry classification.
   */
  code?: string;
  timestamp?: number;
}

// Export Guardrails types (after all dependent types are defined)
export * from './guardrails.js';

// Export Session types
export * from './session.js';

// Export Error types
export * from './errors.js';

// Export Retry Config types
export * from './retryConfig.js';

// Export Agent types (Multi-Agent system)
export * from './agent.js';
