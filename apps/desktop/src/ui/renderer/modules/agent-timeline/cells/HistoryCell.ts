
import type { AskUserQuestion, MessageAttachment } from '../types';
import type { TimelineErrorActionKind } from '../../../utils/workspaceUtils';

export interface HistoryCellBase {
  id: string;
  sessionId: string;
  /** epoch ms — 排序 + 时间 chip */
  timestamp: number;
  /** server 端事件全局 sequence; 用于跨 transport 排序补强 timestamp */
  sequence?: number;
}

export type AskUserStatus =
  | 'waiting'
  | 'answered'
  | 'skipped'
  | 'expired'
  | 'dismissed';


/**
 * @see StepContent     — 无 (TimelineMessage role='user', 不走 StepContent 路径)
 * @see 已实现           — cells/UserCell.tsx
 * @see 接通入口         — mapTimeline.ts 'user_message' 分支 (~2755 行 message row 构造)
 */
export interface UserCell extends HistoryCellBase {
  kind: 'user';
  text: string;
  attachments?: MessageAttachment[];
  injectionPending?: boolean;
}

/**
 * @see StepContent     — 无 (TimelineMessage role='assistant', 不走 StepContent 路径)
 * @see 已实现           — cells/AssistantTextCell.tsx
 * @see 接通入口         — mapTimeline.ts 'assistant_message' / 'agent_message' 分支
 */
export interface AssistantTextCell extends HistoryCellBase {
  kind: 'assistant_text';
  text: string;
  /** narrative = 常规对话; final = turn 末尾的结论 (预留, Phase 5 模型可显式标) */
  phase: 'narrative' | 'final';
  streaming: boolean;
  turnTokens?: number;
  turnUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
  };
  model?: string;
  turnTps?: number;
}

/**
 * @see StepContent     — StepContent.type='thinking' (types.ts:158)
 * @see 已实现           — cells/TextStatusViews.ThinkingView
 * @see 接通入口         — mapTimeline.buildThinkingContent (~1065 行)
 * @see 当前过滤位       — mapTimeline.ts:2824 默认按 timelinePreferences.showReasoning 过滤
 */
export interface ReasoningCell extends HistoryCellBase {
  kind: 'reasoning';
  text: string;
  /** reasoning 第一行 **bold** 标题 — StatusBar 显示用 (StatusBar 已实现, 走 raw events 不依赖 cell) */
  headerBold?: string;
  /** 设计 §8.4: 默认 true, 由 timelinePreferences.showReasoning toggle 翻转 */
  transcriptOnly: boolean;
}

/**
 * @see StepContent     — StepContent.type='terminal' (types.ts:131)
 * @see 已实现           — cells/TerminalView.tsx
 * @see 接通入口         — mapTimeline.buildTerminalContent (~881 行)
 */
export interface ExecCell extends HistoryCellBase {
  kind: 'exec';
  command: string;
  output: string;
  /** 模型给的工具调用 id —— 实时输出 (terminalChunkBus) 按它推; 跟条目 id 不是一回事 */
  toolId?: string;
  pid?: number;
  backgrounded?: boolean;
  exitCode?: number;
  durationMs?: number;
  status: 'running' | 'done' | 'error';
}

export interface ExploreGroupOp {
  tool: 'read' | 'grep' | 'glob' | string;
  target: string;
  durationMs?: number;
  /** Phase D tail: 让 ExploreView 不再回看 legacyContent.toolRecords */
  status?: 'running' | 'done' | 'error';
  /** 并行 explore 用来分组 (agent id) */
  agentId?: string;
  /** 单个 op 的结果摘要 (e.g. "12 命中") */
  resultHint?: string;
}

/** ×N 并行 explore 子 agent 元数据 */
export interface ExploreGroupMember {
  agentId: string;
  task: string;
  model?: string;
  status: 'running' | 'completed' | 'error';
  toolCount: number;
  tokens: number;
  elapsed: number;
}

/**
 * @see StepContent     — StepContent.type='explore' (types.ts:259) + 'search' / 'readfile' 子合并
 * @see 已实现           — cells/ExploreView.tsx
 * @see 接通入口         — mapTimeline.buildExploreContent (~1310 行) + buildSearchContent (~977) +
 *                         buildReadFileContent (~1127) — 改写时合并到统一 explore_group
 */
export interface ExploreGroupCell extends HistoryCellBase {
  kind: 'explore_group';
  ops: ExploreGroupOp[];
  status: 'running' | 'done';
  /** Phase D tail 扩字段: ExploreView 完整数据自洽 */
  task?: string;
  role?: string;
  summary?: string;
  error?: string;
  currentStatus?: string;
  toolCount?: number;
  tokens?: number;
  elapsed?: number;
  groupMembers?: ExploreGroupMember[];
}

/**
 * @see StepContent     — 无独立 type (走 'terminal' 或 generic), MCP server 元数据在 entry.toolArgs
 * @see 已实现           — cells/TerminalView 退路 (没有 dedicated MCP view)
 * @see 接通入口         — mapTimeline tool_call 分支 (toolName 以 'mcp__' 前缀判断)
 */
export interface McpToolCell extends HistoryCellBase {
  kind: 'mcp_tool';
  server: string;
  tool: string;
  args: unknown;
  result?: unknown;
  status: 'calling' | 'done' | 'error';
}

/**
 * @see StepContent     — StepContent.type='web' (types.ts:199)
 * @see 已实现           — cells/WebView.tsx
 * @see 接通入口         — mapTimeline.buildWebContent (~1198 行)
 */
/** WebView 渲染需要的搜索结果一条 */
export interface WebSearchResult {
  title: string;
  url?: string;
  snippet?: string;
}

export interface WebSearchCell extends HistoryCellBase {
  kind: 'web_search';
  query: string;
  resultCount?: number;
  status: 'searching' | 'done';
  /** Phase D tail: web 也支持 fetch (单 url), variant 区分; WebView 走这条 */
  variant: 'search' | 'fetch';
  url?: string;
  results?: WebSearchResult[];
  bytes?: number;
  total?: number;
}

export interface PatchCellFile {
  path: string;
  additions: number;
  deletions: number;
}

/**
 * Phase D tail 扩字段: 让 PatchCell 数据自洽 (不再依赖 HistoryCellRow.legacyContent).
 *   diff: 单文件 diff (edit_file / file_stream / write_file). 渲染走 cells/EditDiffCard.
 *   code: 通用文本输出 (read_doc / get_settings 等), 退化为 lines list. 渲染走 cells/CodeView.
 */
export interface PatchDiffLine {
  kind: 'add' | 'del' | 'ctx' | 'hunk' | 'gap' | 'more';
  oldNo?: number;
  newNo?: number;
  text: string;
}

export interface PatchDiffHunk {
  oldString?: string;
  newString?: string;
  startLine?: number;
  oldLineCount?: number;
  newLineCount?: number;
  oldCharCount?: number;
  newCharCount?: number;
  previewTruncated?: boolean;
}

export interface PatchDiffPayload {
  file: string;
  addCount: number;
  delCount: number;
  lines: PatchDiffLine[];
  editHunks?: PatchDiffHunk[];
  /** Coalesce 合并的 entry 数量, > 1 时卡头显示 "N ops" 角标 */
  coalescedCount?: number;
  streaming?: boolean;
  previousSnapshotId?: string;
}

export interface PatchCodePayload {
  /** 字段对齐 StepContent.type='code'.CodeLine — text 是真正内容, kind 给语法提示 */
  lines: Array<{ kind?: 'prompt' | 'comment' | 'normal'; text: string }>;
  progress?: number;
  progressText?: string;
  surfaceRef?: { surfaceId: string; kind: string; title?: string };
}

/**
 * @see StepContent     — StepContent.type='diff' (types.ts:108) + 'code' (types.ts:99) +
 *                         'turn_summary' (types.ts:361)
 * @see 已实现           — cells/DiffView.tsx + CodeView.tsx + TurnSummaryView.tsx
 * @see 接通入口         — mapTimeline.buildDiffContent (~682) + buildCoalescedFileChangeContent (~793) +
 *                         buildRawHunkDiffContent (~716) + buildFileStreamRawContent (~761)
 */
export interface PatchCell extends HistoryCellBase {
  kind: 'patch';
  files: PatchCellFile[];
  status: 'applying' | 'done' | 'failed';
  /** 单文件 diff 详情, 由 buildPatchCell 从 StepContent='diff' 直接抽 */
  diff?: PatchDiffPayload;
  /** 通用文本输出 (StepContent='code' fallback), 没 file/addCount 结构, 退化 lines list */
  code?: PatchCodePayload;
}

export interface PlanCellStep {
  text: string;
  /** skipped = 用户点了「跳过这一步」(Q-06), 不是模型自己标的 */
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
  /** 标准阶段 (Q-09) / 预计耗时 (Q-07) */
  phase?: string;
  estimateSec?: number;
}

/**
 * @see StepContent     — StepContent.type='plan' (types.ts:148)
 * @see 已实现           — cells/PlanView.tsx (含 §8.3 frozen visual)
 * @see 接通入口         — mapTimeline.buildPlanContent (~1035 行, 已注入 frozen 字段)
 */
export interface PlanCell extends HistoryCellBase {
  kind: 'plan';
  explanation?: string;
  steps: PlanCellStep[];
  /** §8.3: 当 LLM 又调 update_plan 时旧 plan 标 frozen, UI dim 60% */
  frozen: boolean;
  /** Phase D tail: update_plan 落盘后的 .neox/plans/${sessionId}.md, FilePathChip 点开 */
  planPath?: string;
}

/**
 * BackgroundTaskCell — sub-agent 完成卡 (替代 announce 子 chat 的"汇报"独白).
 *   数据来源 (本 phase 用 user message XML 转译, Phase 5 改 BackgroundTaskCompleteEvent
 *   直接 publish):
 *   - <background-task-notification>: 后台 shell 进程退出
 *   - <agent-completion>: 子 agent 跑完 (explore / background agent)
 *
 * @see StepContent     — StepContent.type='delegation' (types.ts:238) + 'worker' (types.ts:228)
 *                         + user_message XML 兼容路径
 * @see 已实现           — cells/BackgroundTaskCell.tsx (XML 路径) + cells/AgentDelegationViews.tsx
 *                         (delegation/worker 路径)
 * @see 接通入口         — mapTimeline.buildDelegationContent (~1286) + buildWorkerContent (~1271) +
 *                         cells/systemMessageParsers.detectSystemMessage (XML)
 */
/** Phase D tail: BackgroundTaskCell 加 variant 区分 worker / delegation / shell.
 *   worker     — singleAgentRuntime 启动的子 agent (前台 explore / 临时辅助 agent)
 *   delegation — declared agent (long-running task), 含 toolRecords + isBackground 标记
 *   shell      — XML 兼容路径: <background-task-notification> 后台 shell 进程完成
 */
/** external = 派给本机其它 agent CLI (Codex / Claude Code), 跟 delegation 同类, 只是跑在别的进程 */
export type BackgroundTaskVariant = 'worker' | 'delegation' | 'shell' | 'external';

export interface BackgroundTaskToolRecord {
  name: string;
  args?: string;
  status: 'running' | 'done' | 'error';
  duration?: number;
}

export interface BackgroundTaskCell extends HistoryCellBase {
  kind: 'background_task';
  variant: BackgroundTaskVariant;
  taskId: string;
  /** 显示名 (agent name / shell command 前 32 字) */
  name: string;
  description: string;
  status: 'completed' | 'failed' | 'aborted' | 'killed' | 'running';
  elapsedSeconds: number;
  toolUseCount: number;
  /** 折叠展开的详情正文 (markdown 渲染) */
  summary: string;
  error?: string;
  /** delegation/worker 共用: 子 agent 模型 + role */
  agentId?: string;
  role?: string;
  roleName?: string;
  model?: string;
  /** delegation 专用: 状态详情 + 是否后台 + 内部 tool 调用清单 */
  currentStatus?: string;
  isBackground?: boolean;
  /** external 专用: worktree 分支与改动数 —— 改动不在当前工作区, 这是最容易找不到的地方 */
  branch?: string;
  changedFileCount?: number;
  toolRecords?: BackgroundTaskToolRecord[];
  /** 仅 shell 子任务有: pid / exitCode / terminatedBy */
  shellMeta?: {
    pid?: number;
    command?: string;
    exitCode?: number;
    terminatedBy?: 'user' | 'agent' | 'system' | string;
  };
}

/**
 * @see StepContent     — StepContent.type='askUser' (types.ts:186)
 * @see 已实现           — cells/AskUserView.tsx (含 §8.1 倒计时 + 30s 红脉冲 + dismiss)
 * @see 接通入口         — mapTimeline.buildAskUserContent (~1171 行, 已注入 createdAt+timeoutSec)
 */
export interface AskUserCell extends HistoryCellBase {
  kind: 'ask_user';
  toolCallId: string;
  questions: AskUserQuestion[];
  status: AskUserStatus;
  answers?: Record<string, string>;
  error?: string;
  /** epoch ms; 倒计时基准 */
  createdAt?: number;
  /** 秒; 跟 createdAt 一起算剩余 */
  timeoutSec?: number;
}

/**
 * SystemNoticeCell — wakeup / error / compact / memory_saved 统一系统提示.
 *   subtype 决定 icon + 文案; payload 留给各 subtype 自定义结构.
 *
 * @see StepContent     — subtype 映射:
 *                         · 'wakeup'       → StepContent.type='wakeup' (types.ts:333)
 *                         · 'error'        → StepContent.type='error' (types.ts:162)
 *                         · 'compact'      → StepContent.type='compaction' (types.ts:206)
 *                         · 'memory_saved' → StepContent.type='log' (types.ts:315) 或新 type
 * @see 已实现           — cells/SystemNoticeCell.tsx (wakeup) + WakeupView/ErrorView/CompactionView/
 *                         TextStatusViews.LogView (现 view 系统)
 * @see 接通入口         — mapTimeline.buildWakeupContent (~1570) + buildErrorContent (~1073) +
 *                         buildCompactionContent (~1252) + buildLogContent (~1392)
 *                         + cells/systemMessageParsers (XML 路径)
 */
export type SystemNoticeSubtype =
  | 'wakeup'
  | 'error'
  | 'compact'
  | 'target_continue'
  | 'memory_saved'
  | 'log';

/** Phase D tail: 按 subtype 类型化 payload (取代旧 Record<string, unknown>) */
export interface WakeupPayload {
  status: 'scheduled' | 'skipped' | 'invalid';
  reason?: string;
  prompt?: string;
  delaySeconds?: number;
  dueAtMs?: number;
  dueAtIso?: string;
  clamped?: boolean;
  message?: string;
}

export interface ErrorPayload {
  code?: string;
  message: string;
  suggestion?: string;
  action?: {
    kind: TimelineErrorActionKind;
    label: string;
    url?: string;
  };
  /** 网关 request id (= request_logs.request_id), 有才渲染那一行. */
  requestId?: string;
  /** 同一轮里这个错误发生了几次 (>1 才显示). */
  repeatCount?: number;
  /** 最近一次发生的时刻 (HH:MM). 原地更新时卡片位置不动, 靠它体现"又失败了一次". */
  lastAt?: string;
}

export interface CompactionPayload {
  status?: 'started' | 'compressing' | 'completed' | 'failed' | 'skipped';
  originalTokens?: number;
  finalTokens?: number;
  budgetTokens?: number;
  originalMsgs?: number;
  keptMsgs?: number;
  droppedMsgs?: number;
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
  /** 失败原因原文 (status=failed 时) */
  errorDetail?: string;
}

export interface TargetContinuePayload {
  iteration?: number;
  consecutiveBlocks?: number;
}

export interface LogPayload {
  level?: 'info' | 'warning' | 'error';
  message: string;
}

export interface MemorySavedPayload {
  message?: string;
  count?: number;
}

/** SystemNoticeCell discriminated 按 subtype, 渲染层走 switch (cell.subtype) 类型收紧.
 *  如果未来要加新 subtype, 同步扩 SystemNoticeSubtype + 新 payload interface + 加 union 分支. */
export type SystemNoticeCell = HistoryCellBase & (
  | { kind: 'system_notice'; subtype: 'wakeup'; payload: WakeupPayload }
  | { kind: 'system_notice'; subtype: 'error'; payload: ErrorPayload }
  | { kind: 'system_notice'; subtype: 'compact'; payload: CompactionPayload }
  | { kind: 'system_notice'; subtype: 'target_continue'; payload: TargetContinuePayload }
  | { kind: 'system_notice'; subtype: 'log'; payload: LogPayload }
  | { kind: 'system_notice'; subtype: 'memory_saved'; payload: MemorySavedPayload }
);

/* ------------------------------------------------------------
 * 未被 HistoryCell 覆盖的 StepContent.type (设计精简, 不补)
 *
 *   - 'op_chip'        — Phase 3 决策: 不补独立 cell, 合到 system_notice 或单独 inline chip
 *   - 'context_status' — agent 自查预算卡, 跟 message 流并行, 留作 SystemNoticeCell 候选
 *   - 'dag'            — network 模式专用, 极少出现, 留 NetworkView 老路径
 *   - 'network' (9 variant) — network 模式专用, 同上
 *   - 'filelist'       — list_directory tool, 留 FileListView 老路径
 *   - 'readdoc'        — read_doc tool, 留 ReadDocView 老路径
 *   - 'turn_summary'   — 已计入 patch cell (file 改动汇总)
 *
 *   如果未来用户要把这些也搬进 HistoryCell, 优先扩展现有 system_notice subtype 而不是开新 kind.
 * ------------------------------------------------------------ */

export type HistoryCell =
  | UserCell
  | AssistantTextCell
  | ReasoningCell
  | ExecCell
  | ExploreGroupCell
  | McpToolCell
  | WebSearchCell
  | PatchCell
  | PlanCell
  | BackgroundTaskCell
  | AskUserCell
  | SystemNoticeCell;

export type HistoryCellKind = HistoryCell['kind'];
