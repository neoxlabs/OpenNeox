import type { Attachment, SavedTimelineEntry, TimelineEntryType } from '../../shared/ipc';

export type TimelineErrorActionKind =
  | 'login' | 'register' | 'topup' | 'contact_admin' | 'retry'
  | 'wait' | 'rotate_anonymous' | 'open_providers' | 'switch_model' | 'none';


export type { TimelineEntryType };

const TOOL_NAME_ALIASES: Record<string, string> = {
  read: 'readfile',
  read_file: 'readfile',
  smart_read: 'readfile',
  read_multiple_files: 'readfile',
  write: 'write_file',
  edit: 'edit_file',
  glob: 'search_files',
  grep: 'search',
  tree: 'show_tree',
  bash: 'execute_bash',
  shell: 'execute_shell',
  execute: 'execute_shell',
  execute_command: 'execute_shell',
  run_command: 'execute_shell',
  command_exec: 'execute_shell',
  exec_command: 'execute_shell',
  websearch: 'web_search',
  webfetch: 'web_fetch',
};

const normalizeToolName = (toolName?: string): string | undefined => {
  if (!toolName) return toolName;
  if (toolName.startsWith('mcp__')) return toolName;
  const lower = toolName.toLowerCase();
  return TOOL_NAME_ALIASES[lower] || lower;
};

export interface MessageStatusLogEntry {
  id: string;
  text: string;
  level: 'info' | 'warning' | 'error';
  timestamp: number;
}

export type TimelineEntry = SavedTimelineEntry & {
  type: TimelineEntryType;
  messageId?: string;
  statusLogs?: MessageStatusLogEntry[];
  editFilePath?: string;
  /** write_file 覆盖前的原内容快照 id (fileSnapshotStore). 整文件覆盖 Undo 的唯一依据. */
  previousSnapshotId?: string;
  /** write_file 改写的是已有文件 (回执 "File updated") —— 「本轮改动」不标「新建」 */
  overwroteExisting?: boolean;
  editOldString?: string;
  editNewString?: string;
  editStartLine?: number;
  editHunks?: Array<{
    oldString?: string;
    newString?: string;
    startLine?: number;
    oldLineCount?: number;
    newLineCount?: number;
    oldCharCount?: number;
    newCharCount?: number;
    previewTruncated?: boolean;
  }>;
  editReplaceAll?: boolean;
  editIsComplete?: boolean;
  // edit_file_stream 权威事件到达时会清除. 前端据此显示 "Streaming preview" chip
  // 和闪烁 cursor, 以及避免在 diff 未完整时跑 Myers 对齐.
  editStreaming?: boolean;
  toolName?: string;
  targetPath?: string;
  description?: string;
  equivalentCommand?: string;
  isBatch?: boolean;
  batchId?: string;
  batchTotal?: number;
  batchCompleted?: number;
  batchTargets?: string[];
  totalChars?: number;
  duration?: number;
  // 原始工具调用参数（用于 grep pattern 等展示）
  toolArgs?: Record<string, any>;
  /** 参数流式期间累积的 raw JSON 字符串 (tool_call_delta.argumentsDelta 拼接).
   *  用于工具真正跑之前给用户"看到 agent 要干啥"的预览: query / path / command 等
   *  主参数一露头就能显示, 比"N 字符 / N tokens"专业得多.
   *  tool_call 事件到达时 toolArgs 会覆盖此字段的显示. */
  streamedArgsRaw?: string;
  /** 从 streamedArgsRaw 提取的主参数预览文本 (query / path / command 等), 用于卡片副标显示. */
  streamedArgPreview?: string;
  output?: string;
  resultLength?: number;
  /** Shell 命令的 raw stdout/stderr 累积字节流, 给 xterm 终端 UI 用.
   *  与 output 字段分流: output 字段是 LLM 看的格式化壳(▸ 工作目录 / ✓ 退出码 / ◦ stdout: ...
   *  由 executeShellWorker.formatForegroundOutput 包装), commandRawOutput 保留 raw stdout.
   *  TODO: core 端 SavedTimelineEntry 已加同名字段, 等 neox-core build 后这里可以删掉重新落到 base type. */
  commandRawOutput?: string;
  /** PTY 子进程 pid — xterm onData/onResize 反向调 IPC (shellStdin/shellResize) 时需要.
   *  由 shell_output_stream 事件携带过来, 同 toolId 多次到达取最新 (一般不会变, 第一次 message
   *  之后就稳定了). */
  commandPid?: number;
  // Phase 4: 工具调用前 LLM 的解释文字
  prefixText?: string;
  sequence?: number;
  messageSource?: string;
  agentId?: string;
  agentIndex?: number;
  agentStatus?: 'idle' | 'running' | 'waiting' | 'completed' | 'error';
  roleId?: string;
  roleName?: string;
  roleColor?: string;
  agentModel?: string;
  agentProgress?: number;
  /** 工具回执自己声明"不是故障" (guidance / precondition), 入账时从原始载荷认出 —— 见 turnAnomaly.isToolGuidanceEntry */
  toolGuidance?: boolean;
  // Reconnect 卡片属性
  reconnectAttempt?: number;
  reconnectMaxRetries?: number;
  reconnectDelayMs?: number;
  reconnectErrorCode?: string;
  reconnectError?: string;
  reconnectIsNetworkInterrupt?: boolean;
  reconnectIsRateLimit?: boolean;
  // Error 卡片属性
  errorCode?: string;
  errorMessage?: string;
  errorSuggestion?: string;
  errorCategory?: string;
  errorRetryable?: boolean;
  /** 同一轮里同一个错误发生了几次 —— 点重试再失败是原地更新这张卡, 不堆新卡 (>1 才显示). */
  errorRepeatCount?: number;
  /** 最近一次发生的时刻。原地更新时 timestamp 要保住第一次的值 (否则卡片跳到队尾),
   *  所以"又失败了一次"这件事只能靠这个字段体现 —— 界面据此显示「最近 HH:MM」,
   *  turn 审计据此判断本次尝试是否真的收到过东西。 */
  errorLastAt?: number;
  errorRequestId?: string;
  /** NeoxError catalogue.action — runner_error 类型时给 UI 渲染 CTA 按钮 (登录/充值/联系管理员/重试).
   *   autoTrigger=true 的 action 已经被 handleErrorClassified 静默执行, 不会落到 entry 上. */
  errorAction?: {
    kind: TimelineErrorActionKind;
    label: string;
    url?: string;
  };
  /**
   * 结构化错误原因 —— 由后端 PermissionManager / runtimeEventForwarder
   * 在拒绝/失败时填充。renderer 用它做精确判断"是不是用户拒绝"，避免
   * 字符串匹配 "User denied approval" 这种脆弱方式。
   */
  errorReason?: 'denied_by_user' | 'denied_by_config' | 'denied_by_mode' | 'denied_by_hook' | 'tool_failure' | 'error' | 'interrupted';
  blockedBy?: string;
  /** 拦下时给用户看的一句人话 (给模型的指令留在 output 里, 不进界面) */
  blockedNotice?: string;
  /** 同一句提示重复了几次 —— 第 2 次起只累加, 不再多占一行 */
  blockedRepeat?: number;
  // Fallback 卡片属性
  fallbackFrom?: string;
  fallbackTo?: string;
  fallbackReason?: string;
  fallbackModelAlias?: string;
  // Recovery 卡片属性
  recoveryProviderId?: string;
  recoveryPreviousStatus?: string;
  // Provider Status 卡片属性
  providerStatusId?: string;
  providerStatusValue?: string;
  providerStatusReason?: string;
  // Plan 卡片属性
  planId?: string;
  planTitle?: string;
  planGoal?: string;
  planSteps?: Array<{
    id: string;
    content: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped' | 'blocked' | 'verifying';
    priority?: string;
    /* work:Q-09 / Q-07 —— 标准阶段与预计耗时, 老事件没有就缺省 */
    phase?: string;
    estimateSec?: number;
  }>;
  planStatus?: 'pending_approval' | 'approved' | 'executing' | 'completed' | 'failed' | 'paused' | 'cancelled' | 'draft';
  // Context Compaction 卡片属性
  compactionStatus?: 'started' | 'compressing' | 'completed' | 'failed' | 'skipped';
  compactionOriginalMessages?: number;
  compactionKeptMessages?: number;
  compactionDroppedMessages?: number;
  compactionCompressedMessages?: number;
  compactionOriginalTokens?: number;
  compactionFinalTokens?: number;
  compactionBudgetTokens?: number;
  compactionUseLLM?: boolean;
  compactionError?: string;
  /** LLM 摘要压缩分桶进度 */
  compressionBuckets?: Array<{
    bucket: string;
    label: string;
    messageCount: number;
    estimatedTokens: number;
    status: string;
    compressedTokens?: number;
    items?: string[];
  }>;
  compressionTotalBuckets?: number;
  compressionCompletedBuckets?: number;
  compressionSummaryModel?: string;
  // Target Mission 续跑 / 收尾验证闸 分隔线
  targetContinueIteration?: number;
  targetContinueConsecutiveBlocks?: number;
  targetContinueKind?: 'target' | 'verify' | 'team_spec' | 'unfinished' | 'plan';
  // 协作模式字段 (worker_status / dag_execution)
  workerAgentId?: string;
  workerTask?: string;
  workerModel?: string;
  workerStatus?: 'running' | 'completed' | 'failed';
  workerSummary?: string;
  workerError?: string;
  // DAG 执行字段
  dagId?: string;
  dagNodeCount?: number;
  dagDescription?: string;
  dagNodes?: Array<{
    id: string;
    name: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    agentId?: string;
    output?: string;
    duration?: number;
  }>;
  dagCompletedNodes?: number;
  dagFailedNodes?: number;
  // Network 模式字段
  networkTaskId?: string;
  networkTotalBids?: number;
  networkSelectedAgents?: string[];
  networkTopBid?: { agentId: string; confidence: number };
  networkAgentId?: string;
  networkAgentName?: string;
  networkParticipate?: boolean;
  networkReason?: string;
  networkCapabilityScore?: number;
  networkConfidence?: number;
  networkNegotiationId?: string;
  networkParticipants?: string[];
  networkNegotiationStatus?: 'started' | 'voting' | 'consensus' | 'failed';
  networkRounds?: number;
  networkMessageType?: 'proposal' | 'counter' | 'support' | 'concern' | 'vote' | 'comment';
  networkContent?: string;
  networkRound?: number;
  networkDagId?: string;
  networkDagNodes?: Array<{
    id: string;
    name: string;
    agentId?: string;
    level: number;
    dependencies: string[];
    isCritical?: boolean;
  }>;
  networkLevelCount?: number;
  networkCriticalPath?: string[];
  networkReplanReason?: string;
  networkNewNodeCount?: number;
  // Plan Update 字段
  planExplanation?: string;
  planFrozen?: boolean;
  // Task Analysis 字段
  taskAnalysisDescription?: string;
  taskAnalysisComplexity?: 'simple' | 'moderate' | 'complex';
  taskAnalysisEstimatedAgents?: number;
  taskAnalysisSuggestedMode?: string;
  // Agent Execution 字段
  agentExecutionAgentId?: string;
  agentExecutionAgentName?: string;
  agentExecutionNodeId?: string;
  agentExecutionNodeName?: string;
  agentExecutionStatus?: 'pending' | 'running' | 'completed' | 'failed';
  agentExecutionOutput?: string;
  agentExecutionError?: string;
  // Mode Select 字段
  modeSelectMode?: 'direct' | 'bidding' | 'negotiation' | 'dag';
  modeSelectReason?: string;
  modeSelectAgentCount?: number;
  // Explore / TaskAgent 多 Agent 卡片字段
  exploreRole?: string;
  exploreTask?: string;
  exploreStatus?: 'running' | 'completed' | 'error';
  exploreSummary?: string;
  exploreError?: string;
  exploreToolCount?: number;
  exploreTokens?: number;
  exploreElapsed?: number;
  exploreToolRecords?: Array<{
    name: string;
    args?: string;
    status: 'running' | 'done' | 'error';
    duration?: number;
    resultHint?: string;
  }>;
  exploreCurrentStatus?: string;
  exploreGroupMembers?: Array<{
    agentId: string;
    task: string;
    model?: string;
    status: 'running' | 'completed' | 'error';
    toolCount: number;
    tokens: number;
    iterations?: number;
    tokensEstimated?: boolean;
    startedAt?: number;
    elapsed: number;
  }>;
  deepResearchTopic?: string;
  deepResearchScale?: string;
  deepResearchPhase?: 'running' | 'done';
  deepResearchStartedAt?: number;
  deepResearchReportPath?: string;
  deepResearchStats?: {
    sources: number;
    domains: number;
    claims: number;
    disputed: number;
    singleSource: number;
    dispatched: number;
    completed: number;
    failed: number;
    inFlight: number;
    queued: number;
    concurrency: number;
    maxWorkers: number;
  };
  deepResearchWorkers?: Array<{
    id: string;
    question: string;
    status: 'queued' | 'running' | 'done' | 'failed';
    summary?: string;
    agentId?: string;
    toolCount?: number;
    tokens?: number;
    currentTool?: string;
  }>;
  // ask_user 卡片字段
  askUserRequestId?: string;
  askUserQuestions?: Array<{
    question: string;
    options: Array<{ label: string; description?: string }>;
  }>;
  askUserAnswers?: Record<string, string>;
  askUserStatus?: 'waiting' | 'answered' | 'timeout';
  askUserCreatedAt?: number;
  askUserTimeoutSec?: number;
  /** 答复失败时的原因 (服务重启 + 磁盘也没记录, answer 丢失). 有值时 UI 渲染红条 + retry 按钮. */
  askUserError?: string;
  /** orphan 场景保留用户已选答案, 让 UI "改作消息发送" 一键回填. */
  askUserAttemptedAnswers?: Record<string, string>;
  // Agent 委托任务卡片字段 (spawn_process)
  delegationAgentId?: string;
  delegationTask?: string;
  delegationRole?: string;
  delegationRoleName?: string;
  delegationModel?: string;
  /** false = 换了模型 (指挥模式派给干活模型 / 角色钉的模型), 标题写「交给 xx」 */
  delegationModelInherited?: boolean;
  delegationStatus?: 'running' | 'completed' | 'error';
  delegationSummary?: string;
  delegationError?: string;
  delegationToolCount?: number;
  delegationCurrentStatus?: string;
  /** true = agent 在后台跑, mainAgent 已经收尾, UI 用它显示 "后台运行" 提示 */
  delegationIsBackground?: boolean;
  /** task-agent 跑过的工具列表 — useStreamHandler 在收到 worker_event/tool_progress 时累入,
   *  DelegationView 在卡片体里渲染成"运行轨迹"那段, 让用户看到 agent 内部的步骤. */
  delegationToolRecords?: Array<{
    name: string;
    args?: string;
    status: 'running' | 'done' | 'error';
    duration?: number;
    timestamp?: number;
  }>;
  streaming?: boolean;
};

export const normalizeTimelineEntry = (entry: SavedTimelineEntry): TimelineEntry => {
  const normalized = { ...entry } as TimelineEntry;
  if (normalized.toolName) {
    normalized.toolName = normalizeToolName(normalized.toolName) || normalized.toolName;
  }

  if (
    entry.type === 'tool_call' &&
    entry.title &&
    (entry.title.includes('edit_file') || entry.title.includes(': Edit'))
  ) {
    if (entry.detail && entry.detail !== '{}') {
      try {
        const args = JSON.parse(entry.detail);
        if (args.file_path || args.path || args.filename) {
          normalized.type = 'edit_file';
          normalized.editFilePath = args.file_path || args.path || args.filename || '';
          normalized.editOldString = args.old_string || args.old_str || '';
          normalized.editNewString = args.new_string || args.new_str || '';
          normalized.editReplaceAll = args.replace_all || false;
          normalized.editIsComplete = true;

          const fileName = normalized.editFilePath?.split(/[/\\]/).pop() || normalized.editFilePath || 'unknown';
          normalized.title = `✏️ Editing: ${fileName}`;
        }
      } catch {
        // ignore parse error
      }
    }
  }

  const validTypes: TimelineEntryType[] = [
    'thinking',
    'tool_call',
    'tool_result',
    'tool_error',
    'file_stream',
    'edit_file',
    'log',
    'user_message',
    'assistant_message',
    'assistant_prefix',  // 工具调用前的 LLM 解释文字
    'plan',  // update_plan 计划卡片
    'context_compaction',  // 智能上下文压缩卡片
    'target_continuation', // Target 闸门续跑分隔线
    'runner_error',  // Runner 错误卡片
    'worker_status',  // 协作模式 Worker 状态卡片
    'dag_execution',  // DAG 执行可视化卡片
    // Network 模式事件类型
    'network_bidding',
    'network_agent_bid',
    'network_negotiation',
    'network_negotiation_message',
    'network_dag_topology',
    'network_replan',
    'network_task_analysis',
    'network_agent_execution',
    'network_mode_select',
    'agent_message',  // 多 Agent 模式消息
    'plan_update',
    'explore_status',  // Explore / TaskAgent 多 Agent 卡片
    'ask_user',  // ask_user 交互卡片
    'agent_delegation',  // Agent 委托任务卡片
    // P0: Cron / Task / Plan / Worktree
    'cron_create',
    'cron_delete',
    'cron_list',
    'task_create',
    'task_update',
    'task_list',
    'task_get',
    'task_stop',
    'plan_enter',
    'plan_exit',
    'worktree_enter',
    'worktree_exit',
    'turn_summary',  // 本轮改动汇总卡片
  ];
  if (!validTypes.includes(normalized.type as TimelineEntryType)) {
    normalized.type = 'log';
  }

  return normalized;
};

/** timeline 稳定序: sequence → timestamp → id.
 *  混有缺 sequence 的新条目时, 绝不能把"无 sequence"一律排到最前 —
 *  网络中断/暂停后 reload 时 runner_error 若缺 sequence 会被提到 user_message 前面. */
export function compareTimelineEntries(
  a: { sequence?: number; timestamp?: number; id?: string },
  b: { sequence?: number; timestamp?: number; id?: string },
): number {
  if (a.sequence !== undefined && b.sequence !== undefined && a.sequence !== b.sequence) {
    return a.sequence - b.sequence;
  }
  const timeDiff = (a.timestamp || 0) - (b.timestamp || 0);
  if (timeDiff !== 0) return timeDiff;
  if (a.sequence !== undefined && b.sequence === undefined) return 1;
  if (a.sequence === undefined && b.sequence !== undefined) return -1;
  return (a.id || '').localeCompare(b.id || '');
}

export const normalizeTimeline = (entries: SavedTimelineEntry[]): TimelineEntry[] => {
  // 1. 先转换所有条目
  const normalized = entries.map(normalizeTimelineEntry);

  // 2. 排序确保加载后顺序与运行时一致
  return normalized.sort(compareTimelineEntries);
};

export const MAX_CODE_LINES_PREVIEW = 400;
export const MAX_CODE_CONTENT_PREVIEW = 20000;

export class StreamAccumulator {
  private buffer = '';
  private callbacks: Set<(text: string) => void> = new Set();
  private flushScheduled = false;

  append(text: string) {
    this.buffer += text;
    this.scheduleFlush();
  }

  getBuffer() {
    return this.buffer;
  }

  reset() {
    this.buffer = '';
    this.flushScheduled = false;
  }

  subscribe(callback: (text: string) => void) {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  private scheduleFlush() {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    // 使用 queueMicrotask 实现近乎即时的刷新，比 requestAnimationFrame 快得多
    // microtask 在当前事件循环结束时执行，而不是等待下一帧
    queueMicrotask(() => {
      this.flushScheduled = false;
      const text = this.buffer;
      this.callbacks.forEach((cb) => cb(text));
    });
  }
}

export const formatAttachmentSummary = (attachments: Attachment[]): string => {
  if (!attachments || attachments.length === 0) {
    return '';
  }
  const lines = attachments.map((att, index) => {
    if (att.type === 'image') {
      return `Attachment ${index + 1}: [Image${att.name ? `: ${att.name}` : ''}]`;
    }
    if (att.type === 'file') {
      const label = att.name || att.path || att.data;
      return `Attachment ${index + 1}: [File: ${label}]`;
    }
    return `Attachment ${index + 1}: [URL: ${att.data}]`;
  });
  return `Attachments:\n${lines.join('\n')}`;
};

export const formatMessageWithAttachments = (text: string, attachments: Attachment[]): string => {
  const summary = formatAttachmentSummary(attachments);
  if (!summary) {
    return text;
  }
  return `${summary}\n\n${text}`.trim();
};
