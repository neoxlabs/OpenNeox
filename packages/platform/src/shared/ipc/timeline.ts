import type { Attachment } from './coreTypes.js';

export type TimelineEntryType =
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'tool_error'
  | 'file_stream'
  | 'edit_file'
  | 'log'
  | 'user_message'
  | 'assistant_message'
  | 'assistant_prefix'
  | 'plan'
  | 'context_compaction'
  | 'target_continuation'
  | 'runner_error'
  // 协作模式卡片类型
  | 'worker_status'
  | 'dag_execution'
  // Network 模式卡片类型
  | 'network_bidding'
  | 'network_agent_bid'
  | 'network_negotiation'
  | 'network_negotiation_message'
  | 'network_dag_topology'
  | 'network_replan'
  | 'network_task_analysis'
  | 'network_agent_execution'
  | 'network_mode_select'
  | 'agent_message'
  | 'plan_update'
  | 'explore_status'
  | 'ask_user'
  | 'agent_delegation'
  // P0: Cron / Task / Plan / Worktree
  | 'cron_create'
  | 'cron_delete'
  | 'cron_list'
  | 'task_create'
  | 'task_update'
  | 'task_list'
  | 'task_get'
  | 'task_stop'
  | 'plan_enter'
  | 'plan_exit'
  | 'worktree_enter'
  | 'worktree_exit'
  | 'model_switch'
  /* 本轮改动汇总 — run_result 时 append, 列出所有 edit/write/delete/rename 的文件
   * + addCount/delCount + changedLines. 点击 path 进 code surface 高亮 diff 行. */
  | 'turn_summary';

export interface SavedTimelineEntry {
  id: string;
  type: TimelineEntryType;
  title: string;
  checkpointId?: string;
  checkpointTitle?: string;
  checkpointAuto?: boolean;
  detail?: string;
  content?: string;
  timestamp: number;
  sequence?: number;
  level?: 'info' | 'warning' | 'error';
  iteration?: number;
  toolName?: string;
  success?: boolean;
  pending?: boolean;
  filePath?: string;
  codeContent?: string;
  language?: string;
  codeLines?: Array<{
    content: string;
    type: 'added' | 'removed' | 'context';
    lineNumber: number;
  }>;
  additions?: number;
  removals?: number;
  // edit_file 相关字段
  editFilePath?: string;
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
    review?: 'pending' | 'accepted' | 'rejected';
  }>;
  editReplaceAll?: boolean;
  editIsComplete?: boolean;
  // 消息关联
  messageId?: string;
  // Phase 3: 批量处理字段
  isBatch?: boolean;           // 是否批量操作
  batchId?: string;            // 批量操作 ID
  batchTotal?: number;         // 批量总数
  batchCompleted?: number;     // 已完成数量
  batchTargets?: string[];     // 批量目标列表
  totalChars?: number;         // 总字符数（批量结果用）
  duration?: number;           // 执行时长（毫秒）
  runIterations?: number;      // Run 结束统计：迭代次数
  runToolCalls?: number;       // Run 结束统计：工具调用数
  runDurationMs?: number;      // Run 结束统计：总耗时
  runTotalTokens?: number;     // Run 结束统计：总 tokens
  // execute_bash 命令展示字段
  toolCallId?: string;         // 工具调用主 ID (最新/规范 id, 用于结果回填)
  /** 工具调用历史 ID 集合 (身份集合).
   * 同一次 LLM tool call 可能在多个事件阶段拿到不同 id (Anthropic tool_call_start vs done /
   * 不同 forwarder 路径). 所有见过的 id 全部入集合, 后续匹配查找走 includes 而非 ===,
   * 避免"同一次 call 因为阶段间 id 漂移导致前后事件匹中不同 entry → 卡死运行中". */
  toolCallIdSet?: string[];
  /** 该 entry 对应的 tool call 是否正在等待用户审批 (PermissionManager ASK 阶段).
   * 跟 pending=true 一起出现, 但 UI 渲染要区分: 真的工具在跑 vs 在等用户点同意.
   * NeoxRuntimeBridge 接 approval_needed/cancelled 时按 toolCallId 维护. */
  awaitingApproval?: boolean;
  commandCode?: string;        // 执行的命令
  commandCwd?: string;         // 命令执行目录
  commandTimeout?: number;     // 超时时长（秒）
  commandStatus?: 'running' | 'completed' | 'error';
  commandResult?: string;      // 命令输出摘要
  /** Shell 命令的纯 stdout/stderr 累积字节流, 给 xterm 终端 UI 用.
   *  与 output 字段分流: output 字段是给 LLM 看的格式化壳(executeShellWorker formatForegroundOutput
   *  包了 ▸ 工作目录 / ✓ 退出码 / ◦ 标准输出 这些中文标题), 直接喂给 xterm 会让用户看到包装文本.
   *  这个字段保留 raw stdout, mount/refresh 回放时 xterm 显示真实终端输出. */
  commandRawOutput?: string;
  commandPid?: number;
  // Phase 4: 工具调用前 LLM 的解释文字
  prefixText?: string;
  // 工具输出（用于所有工具）
  output?: string;             // 工具输出预览
  outputTruncated?: boolean;   // 是否截断输出
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
  attachments?: Attachment[];
  // Explore / TaskAgent 多 Agent 探索卡片字段
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
    /** 并行模式下用来归组到对应的 groupMember; 单 agent 模式可空 */
    agentId?: string;
    args?: string;
    status: 'running' | 'done' | 'error';
    duration?: number;
    resultHint?: string;
    /** useStreamHandler 内部 dedupe 用; 渲染层不读 */
    toolId?: string;
    timestamp?: number;
  }>;
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
  /** 报告落盘路径 —— 第一条进度事件就带着, 中断时卡片靠它指路 */
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
    /* 下面三个来自子 agent 事件 (worker_start/worker_event/token_usage), 不是调度器给的 ——
     * 调度器不知道每一路烧了多少 token。agentId 是绑定键, 见 useStreamHandler 里的说明。 */
    agentId?: string;
    toolCount?: number;
    tokens?: number;
    currentTool?: string;
  }>;
  // Agent 委托任务卡片字段 (spawn_process)
  delegationAgentId?: string;
  delegationTask?: string;
  delegationRole?: string;
  delegationRoleName?: string;
  delegationModel?: string;
  delegationStatus?: 'running' | 'completed' | 'error';
  delegationSummary?: string;
  delegationError?: string;
  delegationToolCount?: number;
  /** turn_summary 字段 — 本轮所有文件改动聚合给 UI 渲染汇总卡 + 跳转 diff 高亮 */
  summaryTurnId?: string;
  /** 精确 +/- 已算完 — render 层看到这个就直接信任 summaryChanges 里的 addCount/delCount,
   *  不再从原始 hunks re-aggregate (那个是 cumulative 累加值, 跟 DiffEditor net diff 不一致). */
  summaryRefined?: boolean;
  summaryChanges?: Array<{
    path: string;
    /** edit / write / delete / rename — UI 显示不同 icon + 颜色 */
    op: 'edit' | 'write' | 'delete' | 'rename';
    addCount: number;
    delCount: number;
    /** 改动的行号区间, Monaco decoration 用. 含 lineNumber 1-based. */
    changedLines?: Array<{ start: number; end: number; kind: 'add' | 'del' | 'modify' }>;
    /** rename 操作的源路径 */
    from?: string;
    /** edit hunks 原始数据 — 给 CodeSurfaceViewer 切到 Monaco DiffEditor 模式用,
     *  反向应用重建 "本轮改动前" 文件内容, 老/新两栏双色 diff.
     *  previewTruncated=true 时 newString/oldString 被工具替换成 [omitted N lines] 占位,
     *  不能用来反向 apply — refine 必须跳过这条 hunk, fallback 到 aggregator 累加值. */
    editHunks?: Array<{
      oldString?: string;
      newString?: string;
      startLine?: number;
      oldLineCount?: number;
      newLineCount?: number;
      oldCharCount?: number;
      newCharCount?: number;
      previewTruncated?: boolean;
      review?: 'pending' | 'accepted' | 'rejected';
    }>;
    /** Monaco refine 算完后产出的可渲染 diff 行序列 — 给 timeline 的 coalesced file_change
     *  卡片直接当 DiffLine[] 用. 这样卡片 chip / 内容 / summary 三处 100% 一致 (同一份数据).
     *  每个 lineChange 展开成 (del 行 N 条 + add 行 M 条) + 不连续段之间一个 hunk 分隔标记.
     *  Cursor 风格: 卡片体不再是 LLM 的 hunk 原文, 而是 (本轮起点 vs 当前) 的真实净 diff. */
    refinedLines?: Array<
      | { kind: 'add'; newNo: number; text: string }
      | { kind: 'del'; oldNo: number; text: string }
      | { kind: 'ctx'; oldNo?: number; newNo?: number; text: string }
      | { kind: 'hunk'; text: string }
    >;
  }>;
}
