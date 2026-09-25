import type { ContextTokenBreakdown } from '@neoxlabs/kernel/utils/contextBreakdown.js';
import type { FallbackEvent, RecoveryEvent } from './modelRouting.js';
import type { SupervisorProgress } from './chatPayload.js';
import type { SessionCacheUsage } from './context.js';

type StreamEventMeta = {
  taskAgentId?: string;
  sourceLabel?: string;
};

export type ApprovalRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface ApprovalRiskSignal {
  code: string;
  domain: 'shell' | 'sql' | 'path' | 'tool';
  level: ApprovalRiskLevel;
  message: string;
  evidence?: string;
}

export interface ApprovalRisk {
  level: ApprovalRiskLevel;
  signals: ApprovalRiskSignal[];
  summary: string;
}

export type StreamEvent = StreamEventMeta & (
  | {
    type: 'token';
    sessionId: string;
    content: string;
    timestamp?: number;
    sequence?: number;
  }
  | {
    type: 'reasoning';
    sessionId: string;
    content: string;
    timestamp?: number;
  }
  | {
    type: 'status';
    sessionId: string;
    level: 'info' | 'error' | 'warning';
    message: string;
    timestamp?: number;
    sequence?: number;
  }
  | {
    type: 'metrics';
    model?: string;
    sessionId: string;
    tokens: number;
    contextUsed: number;
    inputTokens?: number;
    billableInputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    breakdown?: ContextTokenBreakdown;
    /** 本会话累积用量(含子 agent), forwarder 内存累加 + DB 种子 */
    sessionUsage?: SessionCacheUsage;
    /** true = 子 agent 请求触发的累积刷新, 只更新 sessionUsage, 不碰本轮表盘 */
    sessionUsageOnly?: boolean;
    usageEstimated?: boolean;
    generationMs?: number;
    /** TTFT ms: 回合起点 → 首个可见输出 */
    firstTokenMs?: number;
    timestamp?: number;
  }
  | {
    type: 'thinking';
    sessionId: string;
    iteration: number;
    timestamp?: number;
  }
  | {
    type: 'tool_call';
    sessionId: string;
    toolName: string;
    args: Record<string, any>;
    timestamp?: number;
    sequence?: number;
    // Phase 1: 新增可选字段
    targetPath?: string;      // 目标文件/路径
    description?: string;     // 工具调用原因/描述
    equivalentCommand?: string; // 等效的 shell 命令
    // Phase 3: 批量处理字段
    toolId?: string;          // 工具调用唯一 ID（用于批量检测）
    isBatch?: boolean;        // 是否批量操作
    batchId?: string;         // 批量操作 ID
    // Phase 4: 工具调用前的解释文字
    prefixText?: string;      // 工具调用前 LLM 的解释文字
    // Phase 5: 终端集成
    terminalSessionId?: string; // 终端会话 ID（用于流式输出）
  }
  | {
    /* 第一个 args delta 到达时由 forwarder 发, 让 renderer 立即建占位卡 (转圈圈 + tool 名).
     * 真正的 tool_call 后到时会按 toolId 找到这张卡升级. forwarder 只在每个 tool 的首个
     * delta 发一次, 后续 delta 仍走 'status' 文本进度. */
    type: 'tool_call_delta';
    sessionId: string;
    /** 工具名 — search / grep / write_file / bash / mcp__xxx 等 */
    name: string;
    /** 兼容字段, 跟 name 同值 */
    toolName?: string;
    /** call_tool 包装时探测到的内层真实工具名 (web_search 等), 让流式卡直接显示真名 */
    innerToolName?: string;
    toolId?: string;
    timestamp?: number;
    sequence?: number;
  }
  | {
    type: 'tool_result';
    sessionId: string;
    toolName: string;
    success: boolean;
    resultLength: number;
    timestamp?: number;
    sequence?: number;
    // Phase 1: 新增可选字段
    targetPath?: string;      // 目标文件/路径
    summary?: string;         // 结果摘要
    duration?: number;        // 执行耗时（毫秒）
    output?: string;          // 工具输出预览
    outputTruncated?: boolean;// 是否截断输出
    // Phase 3: 批量处理字段
    toolId?: string;          // 工具调用唯一 ID（用于批量检测）
    batchId?: string;         // 批量操作 ID
    // 原始工具调用参数（用于 UI 展示 grep pattern 等）
    args?: Record<string, any>;
    // 双轨道分离 —— 工具自声明的 UI meta (ToolResult.type/status/error/metadata).
    // 渲染器可以直接消费,不再需要 JSON.parse(event.output) 去猜结构.
    toolStatus?: 'success' | 'already_done' | 'error';
    toolKind?: 'ephemeral' | 'contextual' | 'summarized';
    toolError?: string;
    metadata?: Record<string, any>;
    blockedBy?: string;
    /** 拦下时给用户看的一句人话; 给模型的指令留在 output 里 */
    userNotice?: string;
  }
  | {
    type: 'tool_error';
    sessionId: string;
    toolName: string;
    error: string;
    /**
     * 结构化错误原因 —— renderer 用它做精确判断（例如"已拒绝" 状态），
     * 不再需要在 error 字符串里匹配 "User denied approval" 这种文案。
     */
    errorReason?: 'denied_by_user' | 'denied_by_config' | 'denied_by_mode' | 'denied_by_hook' | 'tool_failure' | 'error';
    toolId?: string;
    timestamp?: number;
    sequence?: number;
  }
  | {
    // Runner 错误事件（无限循环、占位符检测等）
    type: 'error';
    sessionId: string;
    error: string;
    code?: string;
    timestamp?: number;
    sequence?: number;
  }
  | {
    type: 'file_stream';
    sessionId: string;
    filePath: string;
    content: string;
    isComplete?: boolean;
    language?: string;
    additions?: number;
    removals?: number;
    description?: string;
    sequence?: number;
    timestamp?: number;
  }
  | {
    type: 'edit_file_stream';
    sessionId: string;
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
    sequence?: number;
    timestamp?: number;
  }
  | {
    type: 'edit_file_stream_preview';
    sessionId: string;
    toolId: string;
    filePath: string;
    phase: 'init' | 'delta';
    startLine?: number;
    endLine?: number;
    oldContent?: string;
    newStringPartial?: string;
    language?: string;
    sequence?: number;
    timestamp?: number;
  }
  | {
    type: 'write_file_stream';
    sessionId: string;
    filePath: string;
    content: string;
    isComplete?: boolean;
    language?: string;
    description?: string;
    sequence?: number;
    timestamp?: number;
  }
  | {
    // Shell 命令执行期间的实时 output 流. executeShellWorker 每 ~500ms 发一次,
    // Electron forwarder 转发到渲染器, handleShellOutputStream 更新 entry.output.
    // 弥补 CLI/Electron 之间 "shell 实时输出" 的渲染 gap.
    type: 'shell_output_stream';
    sessionId: string;
    toolId: string;
    command: string;
    output: string;            // 当前累积的完整 output
    outputDelta?: string;      // 本次新增部分
    elapsed: number;           // 已执行时长(秒)
    isComplete?: boolean;      // 命令是否已完成
    exitCode?: number;         // 命令退出码(完成时)
    pid?: number;              // PTY 子进程 pid — xterm 双向 stdin/resize 需要
    sequence?: number;
    timestamp?: number;
  }
  | {
    type: 'memory';
    sessionId: string;
    tokensUsed: number;
    contextWindow?: number;
    state?: string;
    pressure?: number;
    byType?: Record<string, { count: number; tokens: number }>;
    breakdown?: ContextTokenBreakdown;
    timestamp?: number;
  }
  | {
    type: 'plan_update';
    sessionId: string;
    explanation?: string;
    plan: Array<{
      step: string;
      status: 'pending' | 'in_progress' | 'completed';
    }>;
    timestamp?: number;
    sequence?: number;
  }
  | {
    type: 'text_complete';
    sessionId: string;
    timestamp?: number;
    sequence?: number;
  }
  | {
    type: 'reasoning_complete';
    sessionId: string;
    timestamp?: number;
    sequence?: number;
  }
  | {
    type: 'log';
    sessionId: string;
    level: 'info' | 'warn' | 'error';
    message: string;
    detail?: string;
    timestamp?: number;
    sequence?: number;
  }
  | {
    type: 'checkpoint';
    sessionId: string;
    checkpointId: string;
    auto?: boolean;
    timestamp?: number;
  }
  | {
    type: 'stream_retry';
    sessionId: string;
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
    sequence?: number;
  }
  | {
    type: 'stream_recovered';
    sessionId: string;
    attempt: number;
    maxRetries: number;
    timestamp?: number;
    sequence?: number;
  }
  | {
    /** server 进程重启信号. Electron 主进程的 AgentBridge 通过 authToken 变化检测,
     *  emit 这个 event 让 renderer settle 所有 in-flight session. sessionId='*'
     *  表示通配所有活跃 session. reason='server_restart' 现阶段唯一来源, 留字段以备扩展. */
    type: 'session_interrupted';
    sessionId: string;
    reason: 'server_restart' | 'connection_lost';
    timestamp?: number;
    sequence?: number;
  }
  | {
    /** server bootstrap 时从 interrupted_runs 扫到 stale turn 并自动 resume 成功,
     *  通知 renderer 衔接上 streaming, timeline 插一行"已自动续接". */
    type: 'session_resumed';
    sessionId: string;
    repairedToolCalls: number;          // 补了几个 fake INTERRUPTED tool_result
    droppedPartialMessages: number;     // 丢弃了几条 partial assistant message
    timestamp?: number;
    sequence?: number;
  }
  | {
    /** resume 启动失败 (schema 异常 / messages 历史不合法 / 等), 通知 renderer 弹 toast
     *  让用户手动重发. */
    type: 'session_resume_failed';
    sessionId: string;
    reason: string;
    timestamp?: number;
    sequence?: number;
  }
  | {
    type: 'run_result';
    sessionId: string;
    iterations: number;
    toolCalls: number;
    durationMs: number;
    totalTokens: number;
    contextUsed?: number;
    failed?: boolean;
    interrupted?: boolean;
    interruptReason?: string;
    timestamp?: number;
    sequence?: number;
  }
  | {
    type: 'error_classified';
    sessionId: string;
    category: string;
    code: string;
    message: string;
    suggestion?: string;
    retryable: boolean;
    timestamp?: number;
    sequence?: number;
  }
  | {
    type: 'fallback';
    sessionId: string;
    event: FallbackEvent;
    timestamp?: number;
    sequence?: number;
  }
  | {
    type: 'recovery';
    sessionId: string;
    event: RecoveryEvent;
    timestamp?: number;
    sequence?: number;
  }
  | {
    type: 'provider_status';
    sessionId: string;
    providerId: string;
    status: 'healthy' | 'degraded' | 'unhealthy' | 'recovering';
    reason?: string;
    timestamp?: number;
    sequence?: number;
  }
  | {
    type: 'supervisor_status';
    sessionId: string;
    message: string;
    progress?: SupervisorProgress;
    timestamp?: number;
  }
  | {
    type: 'supervisor_progress';
    sessionId: string;
    progress: SupervisorProgress;
    timestamp?: number;
  }
  | {
    type: 'supervisor_message';
    sessionId: string;
    summary: string;
    detail?: string;
    timestamp?: number;
  }
  // ==================== Terminal Output Streaming ====================
  | {
    type: 'terminal_open';
    sessionId: string;
    terminalSessionId: string;
    toolId?: string;          // 关联到特定的工具调用
    command: string;          // 要执行的命令
    cwd: string;              // 工作目录
    timestamp?: number;
  }
  | {
    type: 'terminal_output';
    sessionId: string;
    terminalSessionId: string;
    toolId?: string;          // 关联到特定的工具调用
    data: string;             // 终端输出数据（ANSI 格式）
    timestamp?: number;
  }
  | {
    type: 'terminal_exit';
    sessionId: string;
    terminalSessionId: string;
    toolId?: string;
    exitCode: number;
    signal?: string;
    timestamp?: number;
  }
  // ==================== 协作模式事件 (Assistant/Cooperate/Network) ====================
  | {
    type: 'team_created';
    sessionId: string;
    teamId: string;
    strategy: string;
    mode: string;
    summary: string;
    status: string;
    workerIds?: string[];
    timestamp?: number;
  }
  | {
    type: 'team_updated';
    sessionId: string;
    teamId: string;
    strategy: string;
    mode: string;
    summary: string;
    status: string;
    workerIds?: string[];
    timestamp?: number;
  }
  | {
    type: 'assistant_state_snapshot';
    sessionId: string;
    snapshot: any;
    timestamp?: number;
  }
  | {
    type: 'assistant_projection';
    sessionId: string;
    projection: any;
    timestamp?: number;
  }
  | {
    type: 'research_progress';
    sessionId: string;
    phase: 'start' | 'tick' | 'done';
    topic: string;
    scale: string;
    concurrency: number;
    maxWorkers: number;
    sources: number;
    domains: number;
    claims: number;
    disputed: number;
    singleSource: number;
    /* 每一路角度各自的状态 —— 用户要的「看得见几个 agent 在干活」就靠这个 */
    workers: Array<{
      id: string;
      question: string;
      status: 'queued' | 'running' | 'done' | 'failed';
      summary?: string;
    }>;
    dispatched: number;
    completed: number;
    failed: number;
    inFlight: number;
    queued: number;
    seeds?: number;
    questions?: string[];
    lastSummary?: string;
    lastOk?: boolean;
    stopReason?: string;
    reportPath?: string;
    timestamp?: number;
  }
  | {
    type: 'worker_start';
    sessionId: string;
    agentId: string;
    task: string;
    model: string;
    role?: string;
    roleName?: string;
    workerRole?: string;
    isBackground?: boolean;
    isAgentTool?: boolean;
    modelInherited?: boolean;
    groupMembers?: Array<{
      agentId: string;
      task: string;
      /** 这个子 Agent 实际用的模型 */
      model?: string;
      status: 'running' | 'completed' | 'error';
      toolCount: number;
      tokens: number;
      elapsed: number;
    }>;
    timestamp?: number;
    sequence?: number;
  }
  | {
    type: 'worker_event';
    sessionId: string;
    agentId: string;
    eventType: string;
    data?: any;
    workerRole?: string;
    toolName?: string;
    toolArgs?: any;
    timestamp?: number;
    sequence?: number;
  }
  | {
    type: 'worker_complete';
    sessionId: string;
    agentId: string;
    success: boolean;
    summary?: string;
    error?: string;
    duration?: number;
    timestamp?: number;
    sequence?: number;
  }
  | {
    type: 'worker_result';
    sessionId: string;
    agentId: string;
    success: boolean;
    output: string;
    direct?: boolean;
    timestamp?: number;
    sequence?: number;
  }
  | {
    type: 'queued_message_added';
    sessionId: string;
    position: number;
    text: string;
    timestamp?: number;
    sequence?: number;
  }
  | {
    type: 'user_message_injected';
    sessionId: string;
    text: string;
    timestamp?: number;
    sequence?: number;
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
    sequence?: number;
  }
  | {
    type: 'queued_message_removed';
    sessionId: string;
    remaining: number;
    text: string;
    reason?: 'cancelled' | 'interrupted';
    images?: Array<{ mediaType: string; data: string; name?: string }>;
    timestamp?: number;
    sequence?: number;
  }
  | {
    type: 'queued_messages_processed';
    sessionId: string;
    count: number;
    timestamp?: number;
    sequence?: number;
  }
  | {
    type: 'dag_created';
    sessionId: string;
    dagId: string;
    nodeCount: number;
    description?: string;
    timestamp?: number;
    sequence?: number;
  }
  | {
    type: 'dag_node_started';
    sessionId: string;
    dagId: string;
    nodeId: string;
    nodeName: string;
    agentId?: string;
    timestamp?: number;
    sequence?: number;
  }
  | {
    type: 'dag_node_completed';
    sessionId: string;
    dagId: string;
    nodeId: string;
    nodeName: string;
    success: boolean;
    output?: string;
    duration?: number;
    timestamp?: number;
    sequence?: number;
  }
  | {
    type: 'dag_completed';
    sessionId: string;
    dagId: string;
    success: boolean;
    totalNodes: number;
    completedNodes: number;
    failedNodes: number;
    duration?: number;
    timestamp?: number;
    sequence?: number;
  }
  | {
    type: 'raw_response_event';
    sessionId: string;
    data: any;
    event_type?: string;
    timestamp?: number;
    sequence?: number;
  }
  | {
    type: 'network_bidding';
    sessionId: string;
    taskId: string;
    totalBids: number;
    selectedAgents: string[];
    topBid?: { agentId: string; confidence: number };
    timestamp?: number;
  }
  | {
    type: 'network_agent_bid';
    sessionId: string;
    agentId: string;
    agentName: string;
    participate: boolean;
    reason: string;
    capabilityScore?: number;
    confidence?: number;
    timestamp?: number;
  }
  | {
    type: 'network_negotiation';
    sessionId: string;
    negotiationId: string;
    participants: string[];
    status: 'started' | 'voting' | 'consensus' | 'failed';
    rounds?: number;
    timestamp?: number;
  }
  | {
    type: 'network_negotiation_message';
    sessionId: string;
    agentId: string;
    messageType: 'proposal' | 'counter' | 'support' | 'concern' | 'vote' | 'comment';
    content: string;
    round: number;
    timestamp?: number;
  }
  | {
    type: 'network_dag_topology';
    sessionId: string;
    dagId: string;
    nodes: Array<{
      id: string;
      name: string;
      agentId?: string;
      level: number;
      dependencies: string[];
      isCritical?: boolean;
    }>;
    levelCount: number;
    criticalPath: string[];
    timestamp?: number;
  }
  | {
    type: 'network_replan';
    sessionId: string;
    reason: string;
    newNodeCount: number;
    timestamp?: number;
  }
  | {
    type: 'network_task_analysis';
    sessionId: string;
    taskDescription: string;
    complexity?: 'simple' | 'moderate' | 'complex';
    estimatedAgents?: number;
    suggestedMode?: string;
    timestamp?: number;
  }
  | {
    type: 'network_agent_execution';
    sessionId: string;
    agentId: string;
    agentName: string;
    nodeId: string;
    nodeName: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    output?: string;
    error?: string;
    duration?: number;
    timestamp?: number;
  }
  | {
    type: 'network_mode_select';
    sessionId: string;
    selectedMode: 'direct' | 'bidding' | 'negotiation' | 'dag';
    reason: string;
    agentCount?: number;
    timestamp?: number;
  }
  | {
    type: 'agent_message';
    sessionId: string;
    agentId: string;
    agentIndex: number;
    status: 'idle' | 'running' | 'waiting' | 'completed' | 'error';
    task?: string;
    progress?: number;
    message?: string;
    error?: string;
    model?: string;
    roleId?: string;
    roleName?: string;
    roleColor?: string;
    timestamp?: number;
  }
  | {
    type: 'plan_update';
    sessionId: string;
    steps: Array<{
      step: string;
      status: 'pending' | 'in_progress' | 'completed';
    }>;
    explanation?: string;
    timestamp?: number;
  }
  | {
    type: 'ask_user_needed';
    sessionId: string;
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
    sessionId: string;
    requestId: string;
    timeoutSec: number;
    timestamp?: number;
  }
  | {
    type: 'approval_needed';
    sessionId: string;
    requestId: string;
    toolName: string;
    args?: Record<string, any>;
    reason?: string;
    allowRemember?: boolean;
    scopeKey?: string;
    risk?: ApprovalRisk;
    timestamp?: number;
  }
  | {
    type: 'approval_cancelled';
    sessionId: string;
    requestId: string;
    reason: 'resolved' | 'timeout' | 'manual_cancel' | 'session_aborted' | 'stale';
    approved?: boolean;
    timestamp?: number;
  }
  | {
    type: 'tts_audio';
    sessionId: string;
    audio: string;          // base64 音频数据
    audioFormat: string;    // 'mp3' | 'opus' | 'pcm'
    voiceSummary: string;   // 实际朗读的文本(可能是摘要)
    durationMs?: number;
    timestamp?: number;
    sequence?: number;
  }
  | {
    type: 'tts_audio_chunk';
    sessionId: string;
    clipId: string;
    seq: number;            // 分片序号 (0-based)
    audio?: string;         // base64 音频分片 (final/error 帧可为空)
    audioFormat: string;    // 'pcm' | 'mp3'
    sampleRate?: number;    // pcm 采样率 (dashscope CosyVoice 22050)
    voiceSummary?: string;  // 首帧携带该句文本 (滚动字幕)
    final?: boolean;        // 该句最后一帧
    error?: boolean;        // 半途失败 — 丢弃该 clip
    timestamp?: number;
  }
);
