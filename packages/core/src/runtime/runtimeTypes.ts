/**
 * Runtime Types
 * Type definitions for the Agent Runtime Host
 */

import type { StreamedRunner } from '@neoxlabs/kernel/core/runner.js';
import type { ShortTermMemory } from '@neoxlabs/kernel/memory/shortterm.js';
import type {
  DefaultSessionManager,
  SessionSyncManager,
} from '../memory/index.js';
import type { Session as PersistedSession } from '@neoxlabs/kernel/types/session.js';
import type {
  MemoryPressureMonitor,
  MemoryPressureSnapshot,
} from '@neoxlabs/kernel/compat/memoryPressure.js';
import type { LLMProvider } from '@neoxlabs/kernel/types/index.js';
import type { CompatProfile } from '@neoxlabs/kernel/types/compat.js';
import type { ErrorCategory } from '@neoxlabs/kernel/types/errors.js';
import type { ContextTokenBreakdown } from '@neoxlabs/kernel/utils/contextBreakdown.js';
import type { ModelRouteConfig } from '@neoxlabs/platform/utils/config.js';
import type { ToolRiskAssessment } from '@neoxlabs/kernel/core/toolRiskEvaluator.js';
import type { SideAgentAdapter } from './sideAgentAdapter.js';

/**
 * Tool error result with recovery information
 */
export interface ToolErrorResult {
  success: false;
  error: string;
  code: string;
  category: ErrorCategory;
  message: string;
  suggestion?: string;
  retryable: boolean;
  receivedArgs?: string;
}

export type RuntimeStatusType =
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'complete'
  | 'error'
  | 'compacting'
  | 'info'
  | 'warning'
  | 'compaction_complete'
  | 'explore_complete';

export interface HostAttachment {
  type: 'image' | 'url' | 'file';
  data: string;
  name?: string;
  path?: string;
  mediaType?: string;
}

export interface RuntimeMetadata {
  /** Resume existing history without submitting another user message. */
  continuation?: boolean;
  /** The server already persisted the ordinary user entry for this turn. */
  entryUserMessagePersisted?: boolean;
  mode?: 'agent' | 'ask';
  attachments?: HostAttachment[];
  providerId?: string;
  modelName?: string;
  isAutoRouted?: boolean;
  routeConfig?: ModelRouteConfig;
  effortLevel?: string;
}

export interface RunTaskOptions {
  metadata?: RuntimeMetadata;
  abortSignal?: AbortSignal;
}

export interface AgentRuntimeHostOptions {
  runner: StreamedRunner;
  memory: ShortTermMemory;
  sessionManager: DefaultSessionManager;
  /** Runtime diagnostic id. Different from persisted session when sessionEnabled=false (e.g. sub-agent). */
  runtimeSessionId?: string;
  /** Human readable runtime owner for token/cache diagnostics. */
  agentName?: string;
  agentDescription?: string;
  configuredToolCount?: number;
  /** 注册工具名集合 — 挡 LLM 幻觉的 tool_call. emit tool_call_start / _delta /
   *   "Calling: xxx" status 前校验 name 在不在集合, 不在直接 drop. 防 explore
   *   sub-agent 显示 hallucinated write_file/execute_shell. undefined = 不校验
   *   (向后兼容老 caller). */
  registeredToolNames?: Set<string>;
  sessionSync?: SessionSyncManager;
  session?: PersistedSession;
  sessionEnabled?: boolean;
  workDir: string;
  model: string;
  memoryPressure?: MemoryPressureMonitor;
  compatProfile?: CompatProfile | null;
  systemPrompt?: string;
  setSandboxMode?: (enabled: boolean) => void;
  llmProvider?: LLMProvider; // 用于智能压缩
  /** 可选 side-agent 适配器 — 由 runtimeBuilder 注入,实现 toolUseSummary / sessionTitle 等次要 LLM 调用 */
  sideAgentAdapter?: SideAgentAdapter;
  /**
   * P0-2 Multi-agent: 父 agent sessionId. sub-agent / background agent 启动时设此字段,
   *   agentRegistry 据此推断 sibling 关系. main agent 不设 (undefined).
   *   见 内部设计文档 P0-2.
   */
  parentSessionId?: string;
}

/**
 * Agent Runtime Event Types
 * Events emitted by the runtime host during task execution
 */
type AgentRuntimeEventMeta = {
  sequence?: number;
  eventId?: string;
  sourceLabel?: string;
  taskAgentId?: string;
  workerRole?: string;
  workerTask?: string;
};

export type AgentRuntimeEvent = AgentRuntimeEventMeta & (
  | { type: 'status'; status: RuntimeStatusType; message: string; timestamp?: number }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string; detail?: string; timestamp?: number }
  | { type: 'compacting'; message: string; detail?: string; timestamp?: number }
  | { type: 'text'; delta: string; timestamp?: number }
  | { type: 'reasoning'; delta: string; timestamp?: number }
  | { type: 'text_complete'; timestamp?: number }
  | { type: 'thinking'; iteration: number; timestamp?: number }
  | {
    type: 'tool_call_start';
    name: string;
    args?: Record<string, unknown>;
    timestamp?: number;
    targetPath?: string;
    description?: string;
    equivalentCommand?: string;
    toolId?: string;
    isBatch?: boolean;
    batchId?: string;
    viaCallTool?: boolean;
  }
  | { type: 'tool_call_delta'; name: string; innerToolName?: string; argumentsDelta: string; toolId?: string; timestamp?: number }
  | {
    type: 'tool_call_end';
    name: string;
    success: boolean;
    resultLength?: number;
    timestamp?: number;
    toolId?: string;
    batchId?: string;
    targetPath?: string;
    summary?: string;
    duration?: number;
    output?: string;
    outputTruncated?: boolean;
    args?: Record<string, unknown>;
    /** 双轨道 —— 工具自声明的 UI meta (summary 已独立字段,这里是 status/kind/metadata/error) */
    toolStatus?: 'success' | 'already_done' | 'error';
    toolKind?: 'ephemeral' | 'contextual' | 'summarized';
    toolError?: string;
    metadata?: Record<string, unknown>;
    /** 被守卫拦下 (loop/permission/risk/guardrail) —— 不是工具跑失败, UI 据此中性渲染 */
    blockedBy?: string;
    /** 拦下时给用户看的一句人话 (给模型的指令在 output 里) */
    userNotice?: string;
  }
  | {
    type: 'tool_output';
    name: string;
    output: string;
    success: boolean;
    toolId?: string;
    timestamp?: number;
    id?: string;
    duration?: number;
    targetPath?: string;
    args?: Record<string, unknown>;
    /** 双轨道 —— 来自 NeoxEventNormalizer,由 agentLoop outcome.uiMeta 透传 */
    summary?: string;
    toolStatus?: 'success' | 'already_done' | 'error';
    toolKind?: 'ephemeral' | 'contextual' | 'summarized';
    toolError?: string;
    metadata?: Record<string, unknown>;
  }
  | {
    type: 'file_stream';
    filePath: string;
    content: string;
    isComplete?: boolean;
    language?: string;
    additions?: number;
    removals?: number;
    description?: string;
    timestamp?: number;
  }
  | {
    type: 'edit_file_stream';
    filePath: string;
    oldString: string;
    newString: string;
    startLine: number;
    toolId?: string;
    previewTruncated?: boolean;
    hunksOmitted?: number;
    hunks?: Array<{
      oldString: string;
      newString: string;
      startLine: number;
      oldLineCount?: number;
      newLineCount?: number;
      oldCharCount?: number;
      newCharCount?: number;
      previewTruncated?: boolean;
    }>;
    isComplete?: boolean;
    success?: boolean;
    errorMessage?: string;
    language?: string;
    description?: string;
    timestamp?: number;
  }
  | {
    // 抽出 file_path/start_line/end_line/new_string, 即时发给 UI 做逐行渲染.
    // phase='init' 携带 oldContent (从磁盘读的 [startLine..endLine] 行段) + 元信息,
    // phase='delta' 携带 newStringPartial (当前已收到的 new_string 内容, 覆盖式更新).
    // tool 真正执行完毕会发 edit_file_stream 作为权威数据, 前端收敛为最终 diff.
    type: 'edit_file_stream_preview';
    toolId: string;
    filePath: string;
    phase: 'init' | 'delta';
    startLine?: number;
    endLine?: number;
    oldContent?: string;
    newStringPartial?: string;
    language?: string;
    timestamp?: number;
  }
  | {
    type: 'write_file_stream';
    filePath: string;
    content: string;
    isComplete?: boolean;
    language?: string;
    description?: string;
    timestamp?: number;
  }
  | {
    type: 'token_usage';
    model?: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens?: number;
    openaiCachedTokens?: number;
    anthropicCacheReadTokens?: number;
    anthropicCacheCreationTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    cacheHitRate?: number;
    cacheScenario?: string;
    runtimeSessionId?: string;
    agentName?: string;
    agentDescription?: string;
    configuredToolCount?: number;
    contextTokens?: number;
    duration?: number;
    breakdown?: ContextTokenBreakdown;
    sessionPromptTokens: number;
    sessionCompletionTokens: number;
    usageEstimated?: boolean;
    timestamp?: number;
  }
  | { type: 'memory_snapshot'; snapshot: MemoryPressureSnapshot; breakdown?: ContextTokenBreakdown; timestamp?: number }
  | { type: 'checkpoint'; id: string; auto?: boolean; timestamp?: number }
  | {
    type: 'run_result';
    output: string;
    currentTurnText?: string;
    totalTokens: number;
    iterations: number;
    toolCalls: number;
    durationMs: number;
    failed?: boolean;
    interrupted?: boolean;
    interruptReason?: string;
    sourceLabel?: string;
    timestamp?: number;
    /** 逐请求指标: 耗时 / 首字延迟 (正文、思考、工具调用谁先到算谁) / 工具耗时 */
    iterationPerf?: Array<{ iteration: number; durationMs: number; ttftMs: number | null; firstKind: string | null; toolMs: number; toolCalls: number; textChars: number }>;
  }
  | { type: 'error'; message: string; code?: string; timestamp?: number }
  | {
    type: 'stream_retry';
    error: string;
    errorCode: string;
    attempt: number;
    maxRetries: number;
    delayMs: number;
    isRateLimit?: boolean;
    isStreamTimeout?: boolean;
    isNetworkError?: boolean;
    discardedText?: string;
    /** 上一次尝试里没生成完的工具调用一律作废 */
    discardPartialToolCalls?: boolean;
    timestamp?: number;
  }
  | {
    type: 'stream_recovered';
    attempt: number;
    maxRetries: number;
    timestamp?: number;
  }
  | {
    /** crash-resume: server bootstrap 扫到 stale turn 并修补 messages 后, agent 重新启动 */
    type: 'session_resumed';
    repairedToolCalls: number;
    droppedPartialMessages: number;
    timestamp?: number;
  }
  | {
    /** crash-resume: 启动失败 (repair 异常 / unsupported mode 等), UI 提示用户重发 */
    type: 'session_resume_failed';
    reason: string;
    timestamp?: number;
  }
  | {
    type: 'error_classified';
    category: string;
    code: string;
    message: string;
    suggestion?: string;
    retryable: boolean;
    timestamp?: number;
  }
  | {
    type: 'plan_update';
    explanation?: string;
    plan: Array<{
      step: string;
      status: 'pending' | 'in_progress' | 'completed';
    }>;
    timestamp: number;
  }
  | {
    type: 'context_compaction';
    status: 'started' | 'compressing' | 'completed';
    originalMessages?: number;
    keptMessages?: number;
    droppedMessages?: number;
    compressedMessages?: number;
    originalTokens: number;
    finalTokens?: number;
    budgetTokens: number;
    useLLM: boolean;
    timestamp?: number;
    /** 数字是否已含压不掉的底座 (工具定义/系统提示词) — 见 kernel ContextCompactionStreamEvent 同名字段 */
    tokensIncludeOverhead?: boolean;
    compression?: {
      phase: 'categorizing' | 'compressing' | 'done';
      totalBuckets: number;
      completedBuckets: number;
      buckets: Array<{
        bucket: string;
        label: string;
        messageCount: number;
        estimatedTokens: number;
        status: string;
        compressedTokens?: number;
        items?: string[];
      }>;
      summaryModel: string;
    };
  }
  | { type: 'reasoning_complete'; timestamp?: number }
  | {
    type: 'raw_response_event';
    data: unknown;
    event_type?: string;
    timestamp?: number;
  }
  | {
    type: 'queued_message_added';
    position: number;
    text: string;
    timestamp?: number;
  }
  | {
    type: 'queued_messages_processed';
    count: number;
    timestamp?: number;
  }
  | {
    // 用户撤回 (↑) 最后一条排队消息 → 拉回输入框编辑
    type: 'queued_message_removed';
    remaining: number;
    text: string;
    reason?: 'cancelled' | 'interrupted';
    images?: Array<{ mediaType: string; data: string; name?: string }>;
    timestamp?: number;
  }
  | {
    // 排队消息被真正处理 (注入对话) 的那一刻 → UI 此时才把它渲染进 timeline
    type: 'user_message_injected';
    text: string;
    timestamp?: number;
  }
  | {
    type: 'agent_wrote_path';
    sessionId: string;
    toolCallId: string;
    toolName: string;
    op: 'write' | 'edit' | 'delete' | 'rename';
    paths: string[];
    /** rename 场景的旧路径 */
    from?: string;
    evidence: 'tool_ui_meta' | 'tool_result_path' | 'shell_declared' | 'shell_proc';
    timestamp?: number;
  }
  | {
    type: 'approval_needed';
    requestId: string;
    toolName: string;
    args?: Record<string, unknown>;
    reason?: string;
    allowRemember?: boolean;
    scopeKey?: string;
    risk?: ToolRiskAssessment;
    timestamp?: number;
  }
  | {
    type: 'approval_cancelled';
    requestId: string;
    reason: 'resolved' | 'timeout' | 'manual_cancel' | 'session_aborted' | 'stale';
    approved?: boolean;
    timestamp?: number;
  }
  | {
    type: 'ask_user_needed';
    requestId: string;
    questions: Array<{
      question: string;
      options?: Array<{ label: string; description?: string }>;
    }>;
    timeoutSec?: number;
    timestamp?: number;
  }
  | {
    type: 'ask_user_expired';
    requestId: string;
    timeoutSec: number;
    reason?: 'timeout' | 'aborted';
    timestamp?: number;
  }
  | {
    type: 'tts_audio';
    audio: string;
    audioFormat: string;
    voiceSummary: string;
    durationMs?: number;
    timestamp?: number;
  }
  | {
    type: 'tts_audio_chunk';
    clipId: string;
    seq: number;
    audio?: string;
    audioFormat: string;
    sampleRate?: number;
    voiceSummary?: string;
    final?: boolean;
    error?: boolean;
    timestamp?: number;
  }
  | {
    type: 'shell_output_stream';
    toolId: string;
    command: string;
    output: string;           // Current accumulated output
    outputDelta?: string;     // New output since last update
    elapsed: number;          // Elapsed time in seconds
    isComplete?: boolean;     // True when command finishes
    exitCode?: number;        // Exit code when complete
    pid?: number;             // PTY child pid — renderer xterm 用它做 stdin/resize 反向调
    timestamp?: number;
  }
  | {
    type: 'background_task';
    action: 'snapshot' | 'add' | 'update' | 'update_by_pid';
    /** action='snapshot': 快照产出时刻, UI 据此判断服务端是否失联 */
    generatedAt?: number;
    /** action='snapshot': 全量进程事实 (serviceSnapshot.ProcessFact[]) */
    processes?: Array<Record<string, unknown>>;
    taskId?: number;
    pid?: number;
    command?: string;
    updates?: {
      status?: 'running' | 'done' | 'error' | 'killed';
      exitCode?: number;
      outputLine?: string;
    };
    timestamp?: number;
  }
  // ==================== 协作模式事件 (Assistant/Cooperate/Network) ====================
  | {
    type: 'worker_start';
    agentId: string;
    task: string;
    model: string;
    role?: string;
    roleName?: string;
    workerRole?: string;
    isBackground?: boolean;
    isAgentTool?: boolean;
    modelInherited?: boolean;
    timestamp?: number;
  }
  | {
    type: 'worker_event';
    agentId: string;
    eventType: string;
    data?: unknown;
    workerRole?: string;
    toolName?: string;
    toolArgs?: unknown;
    timestamp?: number;
  }
  | {
    type: 'worker_complete';
    agentId: string;
    success: boolean;
    summary?: string;
    error?: string;
    duration?: number;
    timestamp?: number;
  }
  | {
    type: 'dag_created';
    dagId: string;
    nodeCount: number;
    description?: string;
    timestamp?: number;
  }
  | {
    type: 'dag_node_started';
    dagId: string;
    nodeId: string;
    nodeName: string;
    agentId?: string;
    timestamp?: number;
  }
  | {
    type: 'dag_node_completed';
    dagId: string;
    nodeId: string;
    nodeName: string;
    success: boolean;
    output?: string;
    duration?: number;
    timestamp?: number;
  }
  | {
    type: 'dag_completed';
    dagId: string;
    success: boolean;
    totalNodes: number;
    completedNodes: number;
    failedNodes: number;
    duration?: number;
    timestamp?: number;
  }
  | {
    type: 'worker_result';
    agentId: string;
    success: boolean;
    output: string;
    direct?: boolean;
    timestamp?: number;
  }
  | {
    /** Side-query Haiku/TaskAgent 生成的工具批一行摘要,挂到 batchId 对应的 UI 卡片上 */
    type: 'tool_batch_summary';
    /** 必带 —— 桌面 bridge 会丢弃不带 sessionId 的事件 (防并发串味, 故意无回落)。
     *  这个字段此前缺失, 导致摘要真的生成了却永远到不了界面。 */
    sessionId?: string;
    batchId: string;
    summary: string;
    model?: string;
    timestamp?: number;
  }
  | {
    /** Side-query 生成的会话标题,UI 写回 session 标题栏 */
    type: 'session_title_generated';
    sessionId: string;
    title: string;
    model?: string;
    timestamp?: number;
  }
);

export type RuntimeEventListener = (event: AgentRuntimeEvent) => void;

export interface RunTaskResult {
  output: string;
  totalTokens: number;
  durationMs: number;
  iterations: number;
  toolCalls: number;
  interrupted: boolean;
  failed?: boolean;
}
