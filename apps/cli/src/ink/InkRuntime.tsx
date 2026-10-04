import React, { useState, useEffect, useLayoutEffect } from 'react';
import { render } from '../../vendor/ink/src/index.js';
import ansiEscapes from 'ansi-escapes';
import { getLanguage } from '../i18n/index.js';
import { openFullTranscript } from './transcriptViewer.js';
import { TurnPromptTracker } from './turnPromptTracker.js';
import { App } from './App.js';
import type { Message } from '@neoxlabs/kernel/types/index.js';
import type { AgentContextStats } from '@neoxlabs/kernel/types/agent.js';
import type { ResearchProgress } from './components/StatusLine.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { isWSL, isWindows } from '@neoxlabs/platform/platform/platformDetect.js';
import { loadTimelineDensity, persistTimelineDensity } from './utils/timelineDensityStore.js';
import { uiTrace, clipForUiTrace, callerOf } from './uiTrace.js';
import { finishTtyTypeahead } from '../bootstrap/earlyInputCapture.js';
import { DENSITY_ORDER, type TimelineDensity, type SelectMenuOptions, type TextPromptOptions } from './inkRuntimeOptions.js';

export interface AttachedImage {
  path?: string;
  name?: string;
  mediaType?: string;
  data?: string;
}

export interface InkRuntimeCallbacks {
  onSubmit: (message: string, images?: AttachedImage[]) => void;
  onInterrupt: () => void;
  onExit: () => void;
}

export interface TimelineEntry {
  id: number;
  type:
  | 'user'
  | 'supervisor'
  | 'assistant'
  | 'tool_call'
  | 'tool_result'
  | 'tool_error'
  | 'info'
  | 'warning'
  | 'error'
  | 'thinking'
  | 'reasoning'
  | 'file_update'
  | 'command_exec'
  | 'command_running'
  | 'code_exec'
  | 'web_search'
  | 'web_fetch'
  | 'readfile'
  | 'search'
  | 'search_files'
  | 'show_tree'
  | 'mcp_tool'
  | 'compacting'
  | 'plan'
  | 'queued_message'
  | 'agent_spawn'
  | 'agent_progress'
  | 'agent_complete'
  | 'agent_error'
  | 'network_decompose'
  | 'network_task'
  | 'network_route'
  | 'network_progress'
  | 'network_analysis'      // 任务分析
  | 'network_mode_select'   // 模式选择
  | 'network_agent_bid'
  | 'network_bidding'       // 竞标阶段
  | 'network_negotiation'   // 协商阶段
  | 'network_negotiation_message'
  | 'network_dag'           // DAG 创建
  | 'network_node_start'    // 节点开始执行
  | 'network_node_complete' // 节点执行完成
  | 'network_node_fail'     // 节点执行失败
  | 'network_replan'        // 重规划
  | 'network_peer_review'   // 互评
  | 'assistant_spawn'     // spawn_agent / spawn_process 调用
  | 'assistant_delegate'  // delegate_task 调用
  | 'assistant_query'     // query_agent / list_processes / read_process_output 调用
  | 'assistant_message'   // send_message / send_to_process 调用
  | 'assistant_wait'      // wait_result / wait_all / wait_process 调用
  | 'assistant_terminate' // terminate_agent / kill_process 调用
  | 'pipeline_analysis'     // 任务分析结果
  | 'pipeline_routing'      // 路由决策
  | 'pipeline_ccb'          // CCB 评审结果
  | 'pipeline_dag'          // DAG 规划结果
  | 'pipeline_node_start'   // 节点开始执行
  | 'pipeline_node_complete'// 节点执行完成
  | 'pipeline_node_fail'    // 节点执行失败
  | 'pipeline_node_retry'
  | 'pipeline_progress'     // 整体执行进度
  | 'ccb_review'           // CCB Agent 评审结果
  | 'ccb_agent_review'
  | 'ccb_retry'
  | 'ccb_failed'
  // Git 工具事件类型
  | 'git_status'
  | 'git_diff'
  | 'git_log'
  | 'git_commit'
  | 'git_running'
  | 'ptc_running'
  | 'ptc_complete'
  | 'ptc_error'
  | 'memory_read'
  | 'memory_write'
  | 'memory_running'
  | 'task_agent_progress'
  | 'ask_user'
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
  // aggregateToolCalls transform 合成,不进入 staticEntries 原始数组。
  | 'tool_group'
  | 'header_reemit';
  message?: Message;
  text?: string;
  details?: string;
  /** header_reemit 专用: 重吐时的 header 字段快照 (渲染端用 Header 组件画) */
  headerSnapshot?: {
    version: string;
    provider: string;
    model: string;
    reasoningEffort?: string;
    workDir: string;
    account?: string;
    accountTone?: 'cyan' | 'green' | 'gray';
    forceColumns?: number;
    /** resize 重吐: 只画一行紧凑 header (不吐大 logo) */
    slim?: boolean;
  };
  timestamp: Date;
  isStreaming?: boolean;
  isComplete?: boolean;
  entryKey?: string;
  sourceLabel?: string;
  sourceType?: 'supervisor' | 'agent';  // 消息来源类型
  // Memory 工具 action 类型
  memoryAction?: string;  // read | write | search | update_project
  memorySearchQuery?: string;  // search 时的搜索关键词
  planExplanation?: string;  // Plan说明文字
  planSteps?: Array<{
    step: string;            // 步骤描述 (5-7个词)
    status: 'pending' | 'in_progress' | 'completed';
  }>;
  agentId?: string;
  agentIndex?: number;
  agentStatus?: 'idle' | 'running' | 'waiting' | 'completed' | 'error';
  agentProgress?: number;
  agentTask?: string;
  agentError?: string;
  agentModel?: string;
  agentRoleId?: string;
  networkTaskId?: string;
  networkRoleId?: string;
  networkCompleted?: number;
  networkTotal?: number;
  networkRunning?: number;
  networkFailed?: number;
  networkPending?: number;
  networkAnalysis?: {
    description: string;
    complexity: number;
    requiredCapabilities: string[];
    estimatedAgents: number;
  };
  networkModeSelect?: {
    mode: 'collaborative' | 'competitive' | 'hierarchical';
    reason: string;
    rawAnalysis?: string;
  };
  networkAgentBid?: {
    agentId: string;
    agentName: string;
    participate: boolean;
    reason: string;
    capabilityScore?: number;
    confidence?: number;
  };
  networkBidding?: {
    taskId: string;
    totalBids: number;
    selectedAgents: string[];
    topBid?: { agentId: string; confidence: number };
  };
  networkNegotiation?: {
    sessionId: string;
    participants: string[];
    status: 'started' | 'voting' | 'consensus' | 'failed';
    rounds?: number;
  };
  networkNegotiationMessage?: {
    sessionId: string;
    agentId: string;
    type: string;
    content: string;
    round: number;
  };
  networkDAG?: {
    id: string;
    nodeCount: number;
    levelCount: number;
    maxParallelism: number;
    criticalPath: string[];
    estimatedTime: number;
    nodes?: Array<{
      id: string;
      description: string;
      agentId: string;
      level: number;
      dependencies: string[];
    }>;
  };
  networkNode?: {
    nodeId: string;
    agentId: string;
    description: string;
    output?: string;
    error?: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    duration?: number;
  };
  networkReplan?: {
    dagId: string;
    trigger: string;
    reason: string;
    affectedNodes: string[];
  };
  networkPeerReview?: {
    reviewers: string[];
    averageScore: number;
    summary: string;
  };
  assistantToolName?: string;  // 工具名称 (spawn_process / legacy spawn_agent / list_processes 等)
  assistantTargetAgentId?: string;  // 目标 Agent ID
  assistantTaskId?: string;  // 任务 ID
  assistantResult?: 'success' | 'error' | 'pending';  // 结果状态
  pipelineAnalysis?: {
    intent: { summary: string; domain: string[]; actionType: string };
    complexity: { score: number; reason: string; dimensions: { scopeSize: number; technicalDepth: number; interdependency: number; ambiguity: number } };
    routing: { path: string; needsCCB: boolean; reason: string };
  };
  pipelineRouting?: { path: string; reason: string };
  pipelineCCB?: {
    id: string;
    approved: boolean;
    confidence: number;
    reviews: Array<{
      agentId: string;
      perspective: string;
      verdict: 'approve' | 'concern' | 'reject';
      analysis: string;
      risks: string[];
      suggestions: string[];
    }>;
    summary: {
      risks: Array<{ level: string; description: string }>;
      suggestions: string[];
      recommendedApproach: string;
    };
  };
  pipelineDAG?: {
    id: string;
    nodeCount: number;
    levelCount: number;
    maxParallelism: number;
    criticalPath: string[];
    estimatedTime: number;
  };
  pipelineNode?: {
    nodeId: string;
    role: string;
    description?: string;
    output?: string;
    error?: string;
    status: 'pending' | 'ready' | 'running' | 'completed' | 'failed';
    model?: string;
  };
  pipelineProgress?: {
    completed: number;
    total: number;
    running: number;
    failed: number;
    pending: number;
    currentLevel: number;
    totalLevels: number;
  };
  pipelineNodeRetry?: {
    nodeId: string;
    role: string;
    retryCount: number;
    maxRetries: number;
    error: string;
    model?: string;
  };
  ccbReview?: {
    agentId: string;
    agentName: string;
    perspective: string;
    model?: string;
    verdict: 'approve' | 'concern' | 'reject';
    analysis?: string;
    risks?: string[];
    suggestions?: string[];
  };
  ccbAgentReview?: {
    agentId: string;
    agentName: string;
    perspective: string;
    model?: string;
    verdict: 'approve' | 'concern' | 'reject';
    analysis?: string;
    risks?: string[];
    suggestions?: string[];
  };
  ccbRetry?: {
    agentId: string;
    agentName: string;
    perspective: string;
    model?: string;
    retryCount: number;
    maxRetries: number;
    error: string;
  };
  ccbFailed?: {
    agentId: string;
    agentName: string;
    perspective: string;
    model?: string;
    retryCount: number;
    maxRetries: number;
    error: string;
  };
  toolCall?: {
    name: string;
    input: Record<string, unknown>;
  };
  toolResult?: {
    name: string;
    output: string;
    isError?: boolean;
  };
  taskAgentId?: string;
  taskAgentRole?: string;  // 'Explore' | 'Task'
  taskAgentTask?: string;  // 任务描述
  taskAgentStatus?: 'running' | 'completed' | 'error';
  taskAgentToolCount?: number;
  taskAgentTokens?: number;
  taskAgentElapsed?: number;  // seconds
  taskAgentToolRecords?: Array<{
    name: string;
    args?: string;
    status: 'running' | 'done' | 'error';
    duration?: number;  // seconds
    resultHint?: string;
  }>;
  /** 并行分组成员（explore prompts 并行模式） */
  taskAgentGroupMembers?: Array<{
    agentId: string;
    task: string;
    status: 'running' | 'completed' | 'error';
    toolCount: number;
    tokens: number;
    elapsed: number;
    toolRecords?: Array<{
      name: string;
      args?: string;
      status: 'running' | 'done' | 'error';
      duration?: number;
      resultHint?: string;
    }>;
  }>;
  askUserQuestions?: Array<{
    question: string;
    options: Array<{ label: string; description?: string }>;
  }>;
  toolGroup?: {
    groups: Array<{
      verb: string;        // 'Read' / 'Grep' / 'Glob' / 'Tree' / 'Edit' / 'Shell' / ...
      color: string;       // TOOL_STYLES 中的 color
      items: Array<{
        target: string;         // 显示短名 (basename / pattern preview)
        rawText: string;        // 原 entry.text(展开时用)
        details?: string;       // 原 entry.details
        count: number;          // 同 target 合并次数
        originalType: string;   // 原始 entry.type(展开回 ToolCard 用)
        originalEntryId: number;
      }>;
    }>;
    originalIds: number[];  // 合并的原始 entry id 列表
    totalCount: number;     // 合并的 entry 总数
  };
}

export { DENSITY_ORDER, type TimelineDensity, type SelectMenuOptions, type TextPromptOptions } from './inkRuntimeOptions.js';

export class InkRuntime {
  private appInstance: any = null;
  private messages: Message[] = [];
  private staticEntries: TimelineEntry[] = [];
  private nextEntryId = 1;
  /** 刚发的用户消息先扣在动态区, 模型开口才写进滚动区; esc 早中断时撤回 (见 turnPromptTracker) */
  private readonly turnPrompt = new TurnPromptTracker({
    staticEntries: () => this.staticEntries,
    pendingEntries: () => this.pendingEntries,
    setPendingEntries: list => { this.pendingEntries = list; this.forceUpdateDynamic?.(); },
    commitPendingEntry: id => this.commitPendingEntry(id),
  });
  takeUnansweredPrompt(): { text: string; removed: boolean } | null {
    return this.turnPrompt.take();
  }
  private isRunning = false;
  private statusText = '';
  private tokenStats: {
    input: number;
    output: number;
    total: number;
    contextWindow?: number;
    tokensUsedForContext?: number;
    pressure?: number;
    systemTokens?: number;
    userTokens?: number;
    assistantTokens?: number;
    toolCallTokens?: number;
    toolResultTokens?: number;
    // Legacy fields
    toolTokens?: number;
    messageTokens?: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
  } = {
      input: 0,
      output: 0,
      total: 0,
      contextWindow: undefined,
      tokensUsedForContext: 0,
      pressure: 0,
    };
  private version = '';
  private provider = '';
  private model = '';
  private reasoningEffort = '';
  private workDir = '';
  private showHeader = true;
  private lastEmittedHeaderWidth = 80;
  private headerResizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private headerResizeHandler: (() => void) | null = null;
  private account: string | undefined = undefined;
  private accountTone: 'cyan' | 'green' | 'gray' | undefined = undefined;
  private thinkingEnabled = true;
  private thinkingCollapsed = true;
  private callbacks: InkRuntimeCallbacks;
  // Each only triggers reconciliation in its own React container
  private forceUpdateStatic: (() => void) | null = null;   // Static zone (Header + committed entries)
  private forceUpdateDynamic: (() => void) | null = null;   // Dynamic zone (pending/streaming entries)
  private forceUpdateBottom: (() => void) | null = null;    // Bottom zone (StatusLine + InputLine)
  private inkOutputPaused = false;                          // ctrl+o 完整记录打开期间暂停 Ink 落屏

  // Batches multiple forceUpdate calls into one per 16ms frame (~60 FPS)
  private _dynamicThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  private _bottomThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly FRAME_INTERVAL = 16; // ~60 FPS

  // TTY 断开标记：write EIO 后停止所有 stdout 写入，避免死循环
  private _ttyBroken = false;

  /**
   * Throttled forceUpdateDynamic — batches per-token calls into one render per frame.
   * Use this for streaming-hot paths (updatePendingEntry, updatePendingEntryByKey).
   * Non-streaming paths (addPendingEntry, commitPendingEntry) should still call forceUpdateDynamic directly.
   */
  private throttledUpdateDynamic(): void {
    if (!this.forceUpdateDynamic) return;
    if (this._dynamicThrottleTimer !== null) return; // already scheduled
    this._dynamicThrottleTimer = setTimeout(() => {
      this._dynamicThrottleTimer = null;
      this.forceUpdateDynamic?.();
    }, InkRuntime.FRAME_INTERVAL);
  }

  /**
   * Throttled forceUpdateBottom — batches per-token StatusLine updates.
   */
  private throttledUpdateBottom(): void {
    if (!this.forceUpdateBottom) return;
    if (this._bottomThrottleTimer !== null) return; // already scheduled
    this._bottomThrottleTimer = setTimeout(() => {
      this._bottomThrottleTimer = null;
      this.forceUpdateBottom?.();
    }, InkRuntime.FRAME_INTERVAL);
  }

  // Legacy alias — routes to all zones for backward compatibility
  private get forceUpdate(): (() => void) | null {
    if (!this.forceUpdateStatic && !this.forceUpdateDynamic && !this.forceUpdateBottom) return null;
    return () => {
      this.forceUpdateStatic?.();
      this.forceUpdateDynamic?.();
      this.forceUpdateBottom?.();
    };
  }
  private selectMenuOptions: SelectMenuOptions | null = null;
  private textPromptOptions: TextPromptOptions | null = null;
  private contextMenuActive = false;
  private agentContextScreenActive = false;
  private commandOutput: string[] = [];
  private getCompletions?: (value: string) => string[];
  private memoryLogTimer: NodeJS.Timeout | null = null;
  private ttyWriteGuardActive = false;
  private allowTTYWriteDepth = 0;
  private suppressedHandlerActive = false;
  private originalStdoutWrite: ((chunk: any, encoding?: any, cb?: any) => boolean) | null = null;
  private originalStderrWrite: ((chunk: any, encoding?: any, cb?: any) => boolean) | null = null;
  private inkStdout: NodeJS.WriteStream | null = null;
  private altScreenEnabled = false;

  private attachedImages: AttachedImage[] = [];
  /** 单调编号: 给每张图分配稳定 seq, 输入框插 [图片 #seq] token; 每条消息提交后归零。 */
  private imageSeqCounter = 0;

  private pendingEntries: TimelineEntry[] = [];

  // 通过 getPendingMessages 回调从 RuntimeHost 获取待显示的消息
  private getPendingMessages: (() => Array<{ text: string; timestamp: Date }>) | null = null;
  /* 本地排队消息副本 — runtimeHost 在 server, CLI 进程内拿不到队列, 改由 server 的
   * queued_message_added / _processed / _removed 事件驱动本地副本。QueuedMessagesBar 读它。 */
  private localQueuedMessages: Array<{ text: string; timestamp: Date }> = [];
  private interruptInputActive = false; // 是否正在输入插队消息

  private runMode: 'agentic' = 'agentic';

  // streamingTokens stores the estimated OUTPUT token count during streaming
  private streamingTokens = 0;
  private streamingStartTime: number | null = null;

  // This tracks actual "AI working" time, not wall-clock time since session start
  private accumulatedRunTime = 0; // in seconds
  private runningStartTime: number | null = null; // when isRunning became true

  private compressionMode: 'sync' | 'async' = 'sync';
  private compactionThreshold: number = 0.85; // Default 85%

  private agentContextStats: Map<string, AgentContextStats> = new Map();
  /** 深度调研的聚合进度 —— 一次只会有一轮在跑, 所以是单个值不是 Map */
  private researchProgress: ResearchProgress | null = null;
  // 已清除的 agent — clearAgentContext 后永不复活,直到 unsealAgentContext 显式重置
  private sealedAgentContexts: Set<string> = new Set();
  // 避免多个并行 task_agent_progress 拿到同一 id
  private taskAgentIdFractionCounter = 0;

  private timelineDensity: TimelineDensity = loadTimelineDensity();
  // tool_group 被局部展开为原始 tool_call 行样式的 entry id 集合
  private expandedToolGroupIds: Set<number> = new Set();

  private currentPlanSteps: Array<{
    step: string;
    status: 'pending' | 'in_progress' | 'completed';
  }> = [];

  private backgroundTasks: Array<{
    id: number;
    command: string;
    pid: number;
    status: 'running' | 'done' | 'error' | 'killed';
    startTime: number;
    exitCode?: number;
    output: string[];
    expanded?: boolean;
  }> = [];
  private bgNextId = 1;
  private bgSelectedIndex = -1;

  private sidebarAgents: Array<{
    id: string;
    role: string;
    task: string;
    status: 'running' | 'completed' | 'error';
    toolCount: number;
    tokens: number;
    elapsed: number;
    startTime: number;
    /** 工具调用记录 — 供后台 agent 详情浮层 (Enter) 显示它逐个调了啥 */
    toolRecords?: Array<{ name: string; args?: string; status: 'running' | 'done' | 'error' }>;
  }> = [];

  private static readonly MAX_QUEUED_STATIC = 50; // Don't let queue grow too large

  constructor(callbacks: InkRuntimeCallbacks) {
    this.callbacks = callbacks;
  }

  // ── Background Tasks API (agentic mode) ──────────────────────

  addBackgroundTask(command: string, pid: number): number {
    const id = this.bgNextId++;
    this.backgroundTasks = [...this.backgroundTasks, {
      id, command, pid,
      status: 'running',
      startTime: Date.now(),
      output: [],
    }];
    // Auto-select first task
    if (this.bgSelectedIndex < 0) this.bgSelectedIndex = 0;
    this.forceUpdate?.();
    uiTrace({ ev: 'bg_task', action: 'add', id, status: 'running', count: this.backgroundTasks.length });
    cliLogger.info('BG_TASK', `Added background task #${id}: ${command} (pid=${pid})`);
    return id;
  }

  /* 已排程自动移除的 task id — 防重复 setTimeout */
  private bgRemovalScheduled = new Set<number>();

  updateBackgroundTask(id: number, updates: {
    status?: 'running' | 'done' | 'error' | 'killed';
    exitCode?: number;
    outputLine?: string;
  }): void {
    this.backgroundTasks = this.backgroundTasks.map(t => {
      if (t.id !== id) return t;
      const updated = { ...t };
      if (updates.status) updated.status = updates.status;
      if (updates.exitCode !== undefined) updated.exitCode = updates.exitCode;
      if (updates.outputLine) {
        updated.output = [...t.output.slice(-19), updates.outputLine]; // keep last 20 lines
      }
      return updated;
    });
    this.forceUpdate?.();
    if (updates.status) {
      uiTrace({
        ev: 'bg_task', action: 'update', id, status: updates.status,
        count: this.backgroundTasks.filter(t => t.status === 'running').length,
      });
    }

    const terminal = updates.status && updates.status !== 'running';
    if (terminal && !this.bgRemovalScheduled.has(id)) {
      this.bgRemovalScheduled.add(id);
      const delay = updates.status === 'error' ? 4000 : 1500;
      setTimeout(() => {
        this.bgRemovalScheduled.delete(id);
        this.removeBackgroundTask(id);
      }, delay);
    }
  }

  removeBackgroundTask(id: number): void {
    const idx = this.backgroundTasks.findIndex(t => t.id === id);
    if (idx < 0) return;
    this.backgroundTasks = this.backgroundTasks.filter(t => t.id !== id);
    // Fix selection
    if (this.backgroundTasks.length === 0) {
      this.bgSelectedIndex = -1;
    } else if (this.bgSelectedIndex >= this.backgroundTasks.length) {
      this.bgSelectedIndex = this.backgroundTasks.length - 1;
    }
    this.forceUpdate?.();
  }

  private killBgTaskHandler: ((pid: number, force?: boolean) => void) | null = null;
  setKillBackgroundTaskHandler(fn: (pid: number, force?: boolean) => void): void {
    this.killBgTaskHandler = fn;
  }

  killBackgroundTask(id: number): void {
    const task = this.backgroundTasks.find(t => t.id === id);
    if (!task || task.status !== 'running') return;
    if (this.killBgTaskHandler) {
      // 走 daemon: 整组 SIGTERM + 标记 terminatedBy='user' → 不会被误判成崩溃而自动续命
      try {
        this.killBgTaskHandler(task.pid, false);
        cliLogger.info('BG_TASK', `Requested daemon kill of background task #${id} (pid=${task.pid}, by=user)`);
      } catch (e) {
        cliLogger.warn('BG_TASK', `daemon kill request failed for pid ${task.pid}: ${e}`);
      }
    } else {
      // 兜底 (未注入): 本地直接杀 —— 注意这样 daemon 会当 self-exit, 可能误触自动续命
      try {
        process.kill(task.pid, 'SIGTERM');
        cliLogger.info('BG_TASK', `Killed background task #${id} (pid=${task.pid}) [local fallback]`);
      } catch (e) {
        cliLogger.warn('BG_TASK', `Failed to kill pid ${task.pid}: ${e}`);
      }
    }
    this.updateBackgroundTask(id, { status: 'killed' });
  }

  bgMoveSelection(direction: 'up' | 'down'): void {
    if (this.backgroundTasks.length === 0) return;
    if (direction === 'up') {
      this.bgSelectedIndex = Math.max(0, this.bgSelectedIndex - 1);
    } else {
      this.bgSelectedIndex = Math.min(this.backgroundTasks.length - 1, this.bgSelectedIndex + 1);
    }
    this.forceUpdate?.();
  }

  bgToggleExpand(): void {
    if (this.bgSelectedIndex < 0 || this.bgSelectedIndex >= this.backgroundTasks.length) return;
    const task = this.backgroundTasks[this.bgSelectedIndex];
    this.backgroundTasks = this.backgroundTasks.map(t =>
      t.id === task.id ? { ...t, expanded: !t.expanded } : t
    );
    this.forceUpdate?.();
  }

  getBackgroundTasks() {
    return this.backgroundTasks;
  }

  getBgSelectedIndex() {
    return this.bgSelectedIndex;
  }

  hasActiveBackgroundTasks(): boolean {
    return this.backgroundTasks.length > 0;
  }

  updateBackgroundTaskByPid(pid: number, updates: {
    status?: 'running' | 'done' | 'error' | 'killed';
    exitCode?: number;
  }): void {
    const task = this.backgroundTasks.find(t => t.pid === pid);
    if (!task) return;
    this.updateBackgroundTask(task.id, updates);
  }

  /**
   * Set completion function for tab completion
   */
  setCompletionFunction(getCompletions: (value: string) => string[]): void {
    this.getCompletions = getCompletions;
  }

  private staticEpoch = 0;
  private setupHeaderResizeReemit(): void {
    const stdout = process.stdout;
    if (!stdout || typeof stdout.on !== 'function') return;
    this.lastEmittedHeaderWidth = stdout.columns || 80;
    this.headerResizeHandler = () => {
      //   它们的 useStdout context 可能不随 resize 更新, 主动 force 一下 (输入框/状态行才跟着变宽)。
      this.forceUpdateBottom?.();
      this.forceUpdateDynamic?.();
      if (this.headerResizeDebounceTimer) clearTimeout(this.headerResizeDebounceTimer);
      this.headerResizeDebounceTimer = setTimeout(() => {
        this.headerResizeDebounceTimer = null;
        const cols = stdout.columns || 80;
        if (cols === this.lastEmittedHeaderWidth) return;
        this.lastEmittedHeaderWidth = cols;
        this.redrawAll();
      }, 180);
    };
    stdout.on('resize', this.headerResizeHandler);
  }

  /** 清屏后按当前宽度把 hero + 全部已提交记录重写一遍 (resize / 换配色共用) */
  private redrawAll(): void {
    if (!this.appInstance?.resetForFullRedraw) return;
    /* 老版本 resize / 换配色时追加的 header 副本: 重画后顶上就是新 hero, 副本多余 */
    this.staticEntries = this.staticEntries.filter(e => e.type !== 'header_reemit');
    this.appInstance.resetForFullRedraw();
    this.staticEpoch += 1;
    this.forceUpdateStatic?.();
    this.forceUpdateBottom?.();
  }

  /** /theme 运行时切配色后: 重吐一份当前 header (新主题色) + 刷新所有 live 区 */
  refreshAfterThemeChange(): void {
    this.redrawAll();
    this.forceUpdateDynamic?.();
  }

  /**
   * Start the Ink app
   */
  start(): void {
    cliLogger.info('INK', 'Starting Ink runtime (multi-container)');
    this.startMemorySampler();
    this.setupHeaderResizeReemit();

    // setState in one zone NEVER triggers reconciliation in another zone

    // === Zone 1: Static (Header + committed timeline entries) ===
    const StaticZone = () => {
      const [, setCounter] = useState(0);
      useLayoutEffect(() => {
        this.forceUpdateStatic = () => { this.forceUpdateDynamic?.(); setCounter(c => c + 1); };
        return () => { this.forceUpdateStatic = null; };
      }, []);

      return (
        <App
          zone="static"
          staticEntries={this.staticEntries}
          staticEpoch={this.staticEpoch}
          pendingEntries={[]}
          isRunning={false}
          version={this.version}
          provider={this.provider}
          model={this.model}
          reasoningEffort={this.reasoningEffort}
          workDir={this.workDir}
          showHeader={this.showHeader}
          thinkingEnabled={this.thinkingEnabled}
          thinkingCollapsedProp={this.thinkingCollapsed}
          timelineDensity={this.timelineDensity}
          expandedToolGroupIds={this.expandedToolGroupIds}
          onToggleToolGroupExpanded={(id) => this.toggleToolGroupExpanded(id)}
          onStaticRendered={undefined}
          onSubmit={() => { }}
          onInterrupt={() => { }}
          onExit={() => { }}
          {...({ account: this.account, accountTone: this.accountTone } as any)}
        />
      );
    };

    // === Zone 2: Dynamic (pending/streaming entries + thinking + agent bar) ===
    const DynamicZone = () => {
      const [, setCounter] = useState(0);
      useLayoutEffect(() => {
        this.forceUpdateDynamic = () => setCounter(c => c + 1);
        return () => { this.forceUpdateDynamic = null; };
      }, []);

      return (
        <App
          zone="dynamic"
          staticEntries={[]}
          pendingEntries={this.pendingEntries}
          isRunning={this.isRunning}
          showHeader={false}
          thinkingEnabled={this.thinkingEnabled}
          runMode={this.runMode}
          sidebarAgents={this.getSidebarAgents()}
          agentContextScreenActive={this.agentContextScreenActive}
          agentContextStats={this.getAgentContextStats()}
          timelineDensity={this.timelineDensity}
          expandedToolGroupIds={this.expandedToolGroupIds}
          onToggleToolGroupExpanded={(id) => this.toggleToolGroupExpanded(id)}
          onAgentContextScreenToggle={() => {
            this.agentContextScreenActive = !this.agentContextScreenActive;
            this.forceUpdateDynamic?.();
          }}
          onSubmit={() => { }}
          onInterrupt={() => { }}
          onExit={() => { }}
          onScrollUp={() => this.appInstance?.scrollUp?.()}
          onScrollDown={() => this.appInstance?.scrollDown?.()}
          onPageUp={() => this.appInstance?.pageUp?.()}
          onPageDown={() => this.appInstance?.pageDown?.()}
          onScrollToTop={() => this.appInstance?.scrollToTop?.()}
          onScrollToBottom={() => this.appInstance?.scrollToBottom?.()}
        />
      );
    };

    // === Zone 3: Bottom (StatusLine + InputLine + HintLine + menus) ===
    const BottomZone = () => {
      const [, setCounter] = useState(0);
      useLayoutEffect(() => {
        this.forceUpdateBottom = () => setCounter(c => c + 1);
        return () => { this.forceUpdateBottom = null; };
      }, []);

      return (
        <App
          zone="bottom"
          staticEntries={[]}
          pendingEntries={[]}
          isRunning={this.isRunning}
          statusText={this.statusText}
          tokenStats={this.tokenStats}
          streamingTokens={this.streamingTokens}
          streamingStartTime={this.streamingStartTime}
          accumulatedRunTime={this.accumulatedRunTime}
          compressionMode={this.compressionMode}
          compactionThreshold={this.compactionThreshold}
          agentContextStats={this.getAgentContextStats()}
          researchProgress={this.researchProgress}
          runMode={this.runMode}
          currentPlanSteps={this.currentPlanSteps}
          provider={this.provider}
          model={this.model}
          reasoningEffort={this.reasoningEffort}
          showHeader={false}
          thinkingEnabled={this.thinkingEnabled}
          timelineDensity={this.timelineDensity}
          onCycleDensity={() => this.cycleTimelineDensity()}
          selectMenuOptions={this.selectMenuOptions}
          textPromptOptions={this.textPromptOptions}
          contextMenuActive={this.contextMenuActive}
          commandOutput={this.commandOutput}
          attachedImages={this.attachedImages}
          interruptInputActive={this.interruptInputActive}
          queuedMessages={this.getQueuedMessagesForDisplay()}
          sidebarAgents={this.getSidebarAgents()}
          backgroundTasks={this.backgroundTasks}
          bgSelectedIndex={this.bgSelectedIndex}
          onBgKill={(id: number) => this.killBackgroundTask(id)}
          onBgRemove={(id: number) => this.removeBackgroundTask(id)}
          onBgNavigate={(dir: 'up' | 'down') => this.bgMoveSelection(dir)}
          onBgToggleExpand={() => this.bgToggleExpand()}
          getCompletions={this.getCompletions}
          onSubmit={(text) => {
            /* 按文本里 [图片 #N] token 的出现顺序挑图 (token 被删的图不发); 提交后清空 + 编号归零。 */
            const imagesToSend = this.resolveImagesFromText(text);
            this.attachedImages = [];
            this.imageSeqCounter = 0;
            this.callbacks.onSubmit(text, imagesToSend);
          }}
          onInterrupt={this.callbacks.onInterrupt}
          onPullbackQueued={this.pullbackQueuedFn ? () => this.pullbackQueuedFn!() : undefined}
          onExit={this.callbacks.onExit}
          onContextMenuToggle={() => {
            this.contextMenuActive = !this.contextMenuActive;
            this.forceUpdateBottom?.();
          }}
          onAgentContextScreenToggle={() => {
            this.agentContextScreenActive = !this.agentContextScreenActive;
            this.forceUpdateDynamic?.();
          }}
          onClearCommandOutput={() => {
            this.clearCommandOutput();
          }}
          onAttachImage={(imageData: string | AttachedImage) => this.attachImage(imageData)}
          onClearImages={() => {
            this.clearAttachedImages();
          }}
          onInterruptInputSubmit={(text: string) => {
            this.handleInterruptInputSubmit(text);
          }}
          onInterruptInputCancel={() => {
            this.hideInterruptInput();
          }}
          onShowInterruptInput={() => {
            this.showInterruptInput();
          }}
          onToggleThinking={() => openFullTranscript({
            entries: [...this.staticEntries, ...this.pendingEntries],
            /* process.stdout.write 被 TTY 守卫接管 (非 Ink 写入一律吞掉), 必须走原始 write */
            write: s => { const w = this.originalStdoutWrite; if (w) this.withDirectTTYWrite(() => w(s)); },
            setInkPaused: p => { this.inkOutputPaused = p; },
            onClosed: () => { this.forceUpdateStatic?.(); this.forceUpdateDynamic?.(); this.forceUpdateBottom?.(); },
          })}
        />
      );
    };

    const wslMode = isWSL();
    const windowsMode = isWindows();
    const disableIncrementalRendering = wslMode || windowsMode;
    if (wslMode) {
      cliLogger.info('INK', 'WSL detected, disabling incremental rendering for compatibility');
    }
    if (windowsMode) {
      cliLogger.info('INK', 'Windows detected, disabling incremental rendering for compatibility');
    }

    const altScreenEnv = process.env.NEOX_ALT_SCREEN;
    // Alt screen only when explicitly requested — Windows terminals lack SGR mouse support for scrolling
    this.altScreenEnabled = altScreenEnv === '1' || altScreenEnv === 'true';

    const inkStdout = this.installTTYWriteGuard();

    /* 启动期间收着的按键先交出来 (App 拿去当输入框初值), 再让 Ink 接管 stdin */
    finishTtyTypeahead();

    this.appInstance = render(<StaticZone />, {
      stdout: inkStdout,
      stdin: process.stdin,
      exitOnCtrlC: false, // We handle Ctrl+C ourselves
      patchConsole: false, // Don't patch console
      incrementalRendering: !disableIncrementalRendering,
      useAltScreen: this.altScreenEnabled,
    });

    this.appInstance.rerenderDynamic(<DynamicZone />);
    this.appInstance.rerenderBottom(<BottomZone />);

    cliLogger.info('INK', `Renderer mode: ${this.altScreenEnabled ? 'alt-screen' : 'inline'}`);

    // TTY 断开保护：监听 stdout error 事件，EIO 时停止所有写入
    process.stdout.on('error', (err) => {
      const code = (err as any)?.code;
      if (code === 'EIO' || err.message?.includes('EIO')) {
        this._ttyBroken = true;
        cliLogger.warn('INK', 'TTY broken (stdout EIO), writes disabled');
      }
    });

    if (wslMode) {
      setTimeout(() => {
        if (this.forceUpdateStatic || this.forceUpdateDynamic || this.forceUpdateBottom) {
          cliLogger.debug('INK', 'WSL startup render nudge');
          this.forceUpdateStatic?.();
          this.forceUpdateDynamic?.();
          this.forceUpdateBottom?.();
        }
      }, 0);
    }

    // This makes the terminal wrap pasted content with special markers:
    // - Paste start: \x1b[200~
    // - Paste end: \x1b[201~
    // When user pastes an image, we get an empty bracketed paste sequence
    try {
      if (process.stdout.isTTY && !process.stdout.destroyed) {
        this.writeDirectStdout('\x1b[?2004h');
        cliLogger.info('INK', 'Bracketed paste mode enabled for image paste detection');
      }
    } catch (err) {
      cliLogger.warn('INK', 'Failed to enable bracketed paste mode', { error: err });
    }

    if (this.altScreenEnabled) {
      try {
        if (process.stdout.isTTY && !process.stdout.destroyed) {
          this.writeDirectStdout('\x1b[?1000h');
          this.writeDirectStdout('\x1b[?1002h');
          this.writeDirectStdout('\x1b[?1006h');
          cliLogger.info('INK', 'Mouse SGR mode enabled for wheel scrolling');
        }
      } catch (err) {
        cliLogger.warn('INK', 'Failed to enable mouse mode', { error: err });
      }
    }

    // Ink's raw mode setup might reset signal handlers
    // SIGTSTP (Ctrl+Z) must be ignored to prevent accidental suspension
    try {
      cliLogger.debug('TTY_STATE', '🛡️  [INK] Re-registering SIGTSTP ignore handler after Ink starts');
      process.removeAllListeners('SIGTSTP');
      process.on('SIGTSTP', 'ignore' as any);
      cliLogger.debug('TTY_STATE', '✅ [INK] SIGTSTP handler re-registered (Ctrl+Z ignored)');
      if (process.env.CLI_DEBUG === '1') {
        cliLogger.debug('INK', 'SIGTSTP handler registered (Ctrl+Z ignored)');
      }
    } catch (err) {
      // Windows doesn't support SIGTSTP
      cliLogger.debug('TTY_STATE', '⚠️  [INK] SIGTSTP not supported on this platform');
      if (process.env.CLI_DEBUG === '1') {
        cliLogger.debug('INK', 'SIGTSTP not supported on this platform');
      }
    }

    cliLogger.info('INK', 'Ink runtime started');
  }

  /**
   * Stop the Ink app
   */
  stop(): void {
    try {
      if (process.stdout.isTTY && !process.stdout.destroyed) {
        this.writeDirectStdout('\x1b[?2004l');
        cliLogger.debug('INK', 'Bracketed paste mode disabled');
      }
    } catch (err) {
      // Ignore errors during cleanup
      cliLogger.debug('INK', 'Failed to disable bracketed paste mode (ignored)', { error: err });
    }

    if (this.altScreenEnabled) {
      try {
        if (process.stdout.isTTY && !process.stdout.destroyed) {
          this.writeDirectStdout('\x1b[?1006l');
          this.writeDirectStdout('\x1b[?1002l');
          this.writeDirectStdout('\x1b[?1000l');
          cliLogger.debug('INK', 'Mouse mode disabled');
        }
      } catch (err) {
        cliLogger.debug('INK', 'Failed to disable mouse mode (ignored)', { error: err });
      }
    }

    if (this.appInstance) {
      this.appInstance.unmount();
      this.appInstance = null;
      cliLogger.info('INK', 'Ink runtime stopped');
    }
    this.restoreTTYWriteGuard();
    this.stopMemorySampler();
    if (this.headerResizeDebounceTimer) {
      clearTimeout(this.headerResizeDebounceTimer);
      this.headerResizeDebounceTimer = null;
    }
    if (this.headerResizeHandler) {
      try { process.stdout.removeListener('resize', this.headerResizeHandler); } catch { /* ignore */ }
      this.headerResizeHandler = null;
    }
    this.altScreenEnabled = false;
  }

  private installTTYWriteGuard(): NodeJS.WriteStream {
    if (this.ttyWriteGuardActive) {
      return this.inkStdout ?? process.stdout;
    }

    this.originalStdoutWrite = process.stdout.write.bind(process.stdout);
    this.originalStderrWrite = process.stderr.write.bind(process.stderr);

    const guardWrite = (stream: 'stdout' | 'stderr') => {
      return (chunk: any, encoding?: any, cb?: any): boolean => {
        if (typeof encoding === 'function') {
          cb = encoding;
          encoding = undefined;
        }

        if (this.allowTTYWriteDepth > 0) {
          const original = stream === 'stdout' ? this.originalStdoutWrite : this.originalStderrWrite;
          if (original) {
            return original(chunk, encoding, cb);
          }
        }

        this.handleSuppressedWrite(stream, chunk);
        if (typeof cb === 'function') {
          cb();
        }
        return true;
      };
    };

    process.stdout.write = guardWrite('stdout') as any;
    process.stderr.write = guardWrite('stderr') as any;

    this.inkStdout = this.createInkStdoutProxy();
    this.ttyWriteGuardActive = true;
    cliLogger.info('INK', 'TTY output guard enabled');
    return this.inkStdout;
  }

  private restoreTTYWriteGuard(): void {
    if (!this.ttyWriteGuardActive) {
      return;
    }

    if (this.originalStdoutWrite) {
      process.stdout.write = this.originalStdoutWrite as any;
    }
    if (this.originalStderrWrite) {
      process.stderr.write = this.originalStderrWrite as any;
    }

    this.ttyWriteGuardActive = false;
    this.inkStdout = null;
    cliLogger.info('INK', 'TTY output guard disabled');
  }

  private createInkStdoutProxy(): NodeJS.WriteStream {
    const target = process.stdout;
    const originalWrite = this.originalStdoutWrite || target.write.bind(target);

    return new Proxy(target, {
      get: (obj, prop, receiver) => {
        if (prop === 'write') {
          return (chunk: any, encoding?: any, cb?: any): boolean => {
            /* ctrl+o 完整记录打开期间 Ink 的重绘一律不落屏 (否则 spinner 会画进备用屏) */
            if (this.inkOutputPaused) {
              if (typeof encoding === 'function') encoding();
              else if (typeof cb === 'function') cb();
              return true;
            }
            return this.withDirectTTYWrite(() => originalWrite(chunk, encoding, cb));
          };
        }
        const value = Reflect.get(obj, prop, receiver);
        return typeof value === 'function' ? value.bind(obj) : value;
      },
    }) as NodeJS.WriteStream;
  }

  private withDirectTTYWrite<T>(fn: () => T): T {
    if (this._ttyBroken) {
      return undefined as T;
    }
    this.allowTTYWriteDepth += 1;
    try {
      return fn();
    } catch (err: any) {
      if (err?.code === 'EIO' || err?.message?.includes('EIO')) {
        this._ttyBroken = true;
        return undefined as T;
      }
      throw err;
    } finally {
      this.allowTTYWriteDepth = Math.max(0, this.allowTTYWriteDepth - 1);
    }
  }

  private writeDirectStdout(data: string): void {
    if (this._ttyBroken) {
      return;
    }
    const write = this.originalStdoutWrite || process.stdout.write.bind(process.stdout);
    this.withDirectTTYWrite(() => {
      write(data);
    });
  }

  private handleSuppressedWrite(stream: 'stdout' | 'stderr', chunk: any): void {
    /* Reentrancy guard: 任何在 cliLogger.warn(...) 调用栈内再次写到被 patch 的 stderr/stdout
     * 都会重入这里. 直接 drop 防止死循环. 见 suppressedHandlerActive 字段注释. */
    if (this.suppressedHandlerActive) {
      return;
    }

    if (chunk === null || chunk === undefined) {
      return;
    }

    let text = '';
    if (typeof chunk === 'string') {
      text = chunk;
    } else if (Buffer.isBuffer(chunk)) {
      text = chunk.toString('utf8');
    } else {
      try {
        text = String(chunk);
      } catch {
        return;
      }
    }

    if (!text || text.trim().length === 0) {
      return;
    }

    const truncated = text.length > 2000 ? `${text.slice(0, 2000)}...` : text;
    this.suppressedHandlerActive = true;
    try {
      cliLogger.warn('TTY_SUPPRESS', `[${stream}] ${truncated}`);
    } finally {
      this.suppressedHandlerActive = false;
    }
  }

  /**
   * Add a message to the timeline (legacy method)
   */
  addMessage(message: Message): void {
    const maxMessages = 5;
    this.messages = [...this.messages.slice(-(maxMessages - 1)), message];
    this.forceUpdate?.();
  }

  addEntry(entry: Omit<TimelineEntry, 'id' | 'timestamp'>): number {
    this.turnPrompt.release();
    if ((entry.type as string) === 'user') return this.turnPrompt.hold(this.addPendingEntry(entry));
    this.turnPrompt.track(entry as any);
    const fullEntry: TimelineEntry = {
      ...entry,
      id: this.nextEntryId++,
      timestamp: new Date(),
    };

    /* 常开取证: 每张卡片的诞生都记一笔 (type + 文本头 + 是谁加的)。
     * "一次 edit 渲了两张卡" 这类问题, 看这里两条 entry_add 的 via 就知道是哪两条通道重了。 */
    uiTrace({
      ev: 'entry_add',
      entryType: String(entry.type),
      id: fullEntry.id,
      key: (entry as any).entryKey,
      preview: clipForUiTrace((entry as any).text ?? (entry as any).details, 80),
      via: callerOf('addEntry'),
    });

    if (entry.type === 'user') {
      const hasMessage = !!(entry as any).message;
      const msgContent = (entry as any).message?.content;
      cliLogger.debug('INK_RUNTIME', `[addEntry] user entry id=${fullEntry.id}, hasMessage=${hasMessage}, contentType=${typeof msgContent}, isArray=${Array.isArray(msgContent)}`);
    }

    if (this.staticEntries.length >= InkRuntime.MAX_QUEUED_STATIC) {
      cliLogger.warn(
        'INK_RUNTIME',
        `Static queue reached limit (${this.staticEntries.length}). Forcing immediate render to prevent OOM.`
      );

      // Force an immediate render to write static content to terminal
      this.forceUpdateStatic?.();

      // Wait a tick for render to complete, then clear
      // Using setImmediate to ensure render cycle completes
      setImmediate(() => {
        this.clearStaticEntries();
      });
    }

    // Create new array reference so React detects the change
    this.staticEntries = [...this.staticEntries, fullEntry];
    cliLogger.debug('INK_RUNTIME', `Queued static entry ${fullEntry.id}. Pending static: ${this.staticEntries.length}, type: ${entry.type}, forceUpdate: ${!!this.forceUpdate}`);
    if (entry.type === 'assistant' || entry.type === 'task_agent_progress' || entry.type === 'assistant_message' || entry.type === 'tool_call') {
      cliLogger.info('SUBAGENT_ORDER', `📥 addEntry APPEND id=${fullEntry.id} type=${entry.type} staticLen=${this.staticEntries.length} ids=[${this.staticEntries.map(e => e.id).join(',')}]`);
    }

    if (this.forceUpdate) {
      this.forceUpdate();
    } else {
      // 组件还没挂载，延迟到下一个事件循环再尝试
      setImmediate(() => {
        this.forceUpdate?.();
      });
    }

    return fullEntry.id;
  }

  /**
   * Update an existing timeline entry
   */
  updateEntry(id: number, updates: Partial<TimelineEntry>): void {
    const index = this.staticEntries.findIndex(e => e.id === id);
    if (index >= 0) {
      // Create new array reference with updated entry
      this.staticEntries = this.staticEntries.map((e, i) =>
        i === index ? { ...e, ...updates } : e
      );
      this.forceUpdate?.();
      return;
    }

    const pendingIndex = this.pendingEntries.findIndex(e => e.id === id);
    if (pendingIndex >= 0) {
      this.pendingEntries = this.pendingEntries.map((e, i) =>
        i === pendingIndex ? { ...e, ...updates } : e
      );
      this.forceUpdate?.();
    }
  }

  /**
   * Get an entry by ID
   */
  getEntry(id: number): TimelineEntry | undefined {
    return (
      this.staticEntries.find(e => e.id === id) ||
      this.pendingEntries.find(e => e.id === id)
    );
  }



  addPendingEntry(entry: Omit<TimelineEntry, 'id' | 'timestamp'>): number {
    this.turnPrompt.beforePendingAdd(entry as any);
    // 按普通 nextEntryId 分配会让 card id > 已开始的 iter N text id,commit 排序后卡片
    // 被插到末尾(用户看到 Explore 卡片跑到最底下)。
    // 分配一个刚好小于 earliest streaming assistant/thinking pending 的浮点 id,
    // commit 时能被插回到"逻辑时序应在的位置"(在 tool_call 发起之后、下一轮 text 之前)。
    let id: number;
    if (entry.type === 'task_agent_progress') {
      let earliest = Number.POSITIVE_INFINITY;
      for (const e of this.pendingEntries) {
        if (!e.isStreaming) continue;
        const t = e.type;
        if (t === 'assistant' || t === 'assistant_message' || t === 'thinking' || t === 'reasoning') {
          if (e.id < earliest) earliest = e.id;
        }
      }
      if (Number.isFinite(earliest)) {
        this.taskAgentIdFractionCounter += 1;
        id = earliest - 0.001 * this.taskAgentIdFractionCounter;
      } else {
        id = this.nextEntryId++;
      }
    } else {
      id = this.nextEntryId++;
    }

    const fullEntry: TimelineEntry = {
      ...entry,
      id,
      timestamp: new Date(),
    };

    // Pending entries are temporary and should be committed or cleared
    const MAX_PENDING = 10;
    if (this.pendingEntries.length >= MAX_PENDING) {
      cliLogger.warn(
        'INK_RUNTIME',
        `Too many pending entries (${this.pendingEntries.length}). Auto-committing oldest.`
      );
      // Auto-commit the oldest pending entry to make room
      const oldest = this.pendingEntries[0];
      this.turnPrompt.onAutoCommit(oldest.id);
      this.staticEntries = [...this.staticEntries, oldest];
      this.pendingEntries = this.pendingEntries.slice(1);
    }

    // Create new array reference so React detects the change
    this.pendingEntries = [...this.pendingEntries, fullEntry];
    uiTrace({
      ev: 'entry_add',
      entryType: `pending:${String(fullEntry.type)}`,
      id: fullEntry.id,
      key: (fullEntry as any).entryKey,
      preview: clipForUiTrace((fullEntry as any).text, 80),
      via: callerOf('addPendingEntry'),
    });
    cliLogger.debug('INK_RUNTIME', `Added pending entry ${fullEntry.id}. Pending: ${this.pendingEntries.length}`);
    this.forceUpdateDynamic?.();
    return fullEntry.id;
  }

  /**
   * Update a pending entry
   */
  updatePendingEntry(id: number, updates: Partial<TimelineEntry>): void {
    const index = this.pendingEntries.findIndex(e => e.id === id);
    if (index >= 0) {
      // Create new array reference with updated entry
      this.pendingEntries = this.pendingEntries.map((e, i) =>
        i === index ? { ...e, ...updates } : e
      );
      this.throttledUpdateDynamic();
    }
  }

  removePendingEntry(id: number): boolean {
    const index = this.pendingEntries.findIndex(e => e.id === id);
    if (index < 0) return false;
    this.pendingEntries = this.pendingEntries.filter((_, i) => i !== index);
    this.forceUpdateDynamic?.();
    return true;
  }

  updatePendingEntryByKey(key: string, entry: Omit<TimelineEntry, 'id' | 'timestamp'>): void {
    const index = this.pendingEntries.findIndex(e => e.entryKey === key);

    if (index >= 0) {
      // 更新已有 entry
      this.pendingEntries = this.pendingEntries.map((e, i) =>
        i === index ? { ...e, ...entry, entryKey: key, timestamp: new Date() } : e
      );
    } else {
      this.turnPrompt.release();
      // 创建新 entry，设置 entryKey
      const fullEntry: TimelineEntry = {
        ...entry,
        entryKey: key,
        id: this.nextEntryId++,
        timestamp: new Date(),
      };
      this.pendingEntries = [...this.pendingEntries, fullEntry];
    }

    this.throttledUpdateDynamic();
  }

  commitPendingEntryByKey(key: string): boolean {
    this.turnPrompt.release();
    const index = this.pendingEntries.findIndex(e => e.entryKey === key);
    if (index >= 0) {
      const entry = { ...this.pendingEntries[index], isStreaming: false, isComplete: true };
      this.pendingEntries = this.pendingEntries.filter((_, i) => i !== index);
      // Append-only — same contract as commitPendingEntry (Ink <Static> is count-based).
      this.staticEntries = [...this.staticEntries, entry];
      cliLogger.debug('INK_RUNTIME', `Committed entry by key ${key} (append). Static: ${this.staticEntries.length}, Pending: ${this.pendingEntries.length}`);
      this.forceUpdateStatic?.();
      this.forceUpdateDynamic?.();
      return true;
    }
    return false;
  }

  finalizeBackgroundShellEntry(key: string): boolean {
    this.turnPrompt.release();
    let index = this.pendingEntries.findIndex(e => e.entryKey === key);
    if (index < 0) {
      for (let i = this.pendingEntries.length - 1; i >= 0; i--) {
        const t = this.pendingEntries[i].type;
        if (t === 'command_running' || (t === 'command_exec' && this.pendingEntries[i].isStreaming)) {
          index = i;
          break;
        }
      }
    }
    if (index < 0) return false;
    const entry = { ...this.pendingEntries[index], type: 'command_exec' as any, isStreaming: false, isComplete: true };
    this.pendingEntries = this.pendingEntries.filter((_, i) => i !== index);
    this.staticEntries = [...this.staticEntries, entry];
    cliLogger.debug('INK_RUNTIME', `Finalized background shell entry (key=${key}, id=${entry.id}) → append. Static: ${this.staticEntries.length}, Pending: ${this.pendingEntries.length}`);
    this.forceUpdateStatic?.();
    this.forceUpdateDynamic?.();
    return true;
  }

  /**
   * Commit pending entry to history (move from pending to entries)
   */
  commitPendingEntry(id: number): void {
    this.turnPrompt.beforeCommit(id);
    const index = this.pendingEntries.findIndex(e => e.id === id);
    if (index >= 0) {
      const entry = this.pendingEntries[index];
      // Create new array references so React detects the change
      this.pendingEntries = this.pendingEntries.filter((_, i) => i !== index);
      //   Ink <Static> 是 append-only: 它记住已渲染条数, 每次只渲新追加的尾部。往中间 splice
      //   时间线顺序由"commit 时机"保证 (完成顺序), 不靠事后按 id 重排。
      this.staticEntries = [...this.staticEntries, entry];
      cliLogger.debug('INK_RUNTIME', `Committed entry ${id} (append). Static: ${this.staticEntries.length}, Pending: ${this.pendingEntries.length}`);
      this.forceUpdateStatic?.();
      this.forceUpdateDynamic?.();
    } else {
      cliLogger.warn('INK_RUNTIME', `Cannot commit entry ${id} - not found in pending entries`);
    }
  }

  /**
   * Clear pending entries (保留还在运行中的后台 agent 卡片)
   */
  clearPendingEntries(): void {
    if (this.pendingEntries.length > 0) {
      const kept = this.pendingEntries.filter(e =>
        (e.type === 'task_agent_progress' && (e as any).taskAgentStatus === 'running') || this.turnPrompt.isHeld(e.id),
      );
      this.pendingEntries = kept;
      this.forceUpdateDynamic?.();
    }
  }

  commitAllPendingEntries(): void {
    this.turnPrompt.release();
    if (this.pendingEntries.length > 0) {
      const stillRunning: typeof this.pendingEntries = [];
      const toCommit: typeof this.pendingEntries = [];

      for (const e of this.pendingEntries) {
        // 后台 agent 永不进 static (双重判定: 条目 kind 或运行时已知的 id, 防时序竞态)。
        // 它们从渲染里被滤掉, 这里 drop 掉即可 (结果由主 agent 汇总承载)。
        const isBackgroundAgent = e.type === 'task_agent_progress'
          && (((e as any).taskAgentKind === 'background')
            || (!!(e as any).taskAgentId && this.backgroundAgentIds.has((e as any).taskAgentId)));
        if (isBackgroundAgent) {
          continue; // 不 commit 进 static, 也不留 pending — 直接丢弃 (渲染层已滤掉)
        }
        if (e.type === 'task_agent_progress' && (e as any).taskAgentStatus === 'running') {
          toCommit.push({ ...e, isStreaming: false, isComplete: true, taskAgentStatus: 'completed' } as any);
        } else {
          toCommit.push({ ...e, isStreaming: false, isComplete: true });
        }
      }

      if (toCommit.length > 0) {
        //   绝不重排已在 static 里的旧条目 —— Ink <Static> append-only, 整体重排会让它渲染错位/重复
        toCommit.sort((a, b) => a.id - b.id);
        this.staticEntries = [...this.staticEntries, ...toCommit];
      }
      this.pendingEntries = stillRunning;
      cliLogger.debug('INK_RUNTIME', `Committed ${toCommit.length} pending entries, kept ${stillRunning.length} background agents`);
      if (toCommit.length > 0) {
        cliLogger.info('SUBAGENT_ORDER', `🔷 commitAllPendingEntries merged ${toCommit.length} entries. staticIds=[${this.staticEntries.map(e => e.id).join(',')}] types=[${this.staticEntries.map(e => e.type).join(',')}]`);
      }
      this.forceUpdateStatic?.();
      this.forceUpdateDynamic?.();
    }
  }

  /**
   * Update streaming stats (for StatusBar display)
   * @param tokens - Estimated OUTPUT token count (from estimateOutputTokens)
   */
  updateStreamingStats(tokens: number): void {
    this.streamingTokens = tokens;
    if (!this.streamingStartTime) {
      this.streamingStartTime = Date.now();
    }
    this.throttledUpdateBottom();
  }

  /**
   * Reset streaming stats
   */
  resetStreamingStats(): void {
    this.streamingTokens = 0;
    this.streamingStartTime = null;
  }

  getAccumulatedRunTime(): number {
    // If currently running, include the current session's elapsed time
    if (this.isRunning && this.runningStartTime !== null) {
      const currentElapsed = Math.floor((Date.now() - this.runningStartTime) / 1000);
      return this.accumulatedRunTime + currentElapsed;
    }
    return this.accumulatedRunTime;
  }

  resetAccumulatedRunTime(): void {
    this.accumulatedRunTime = 0;
    this.runningStartTime = null;
    this.forceUpdate?.();
  }

  setCompressionMode(mode: 'sync' | 'async'): void {
    if (this.compressionMode !== mode) {
      this.compressionMode = mode;
      this.forceUpdate?.();
    }
  }

  setCompactionThreshold(threshold: number): void {
    if (this.compactionThreshold !== threshold) {
      this.compactionThreshold = threshold;
      this.forceUpdate?.();
    }
  }

  // ==================== 多Agent上下文管理 ====================

  updateAgentContext(agentId: string, stats: AgentContextStats): void {
    if (this.sealedAgentContexts.has(agentId)) return;
    this.agentContextStats.set(agentId, stats);
    this.forceUpdate?.();
  }

  setResearchProgress(p: ResearchProgress | null): void {
    this.researchProgress = p;
    this.forceUpdateBottom?.();
  }

  clearAgentContext(agentId: string): void {
    this.sealedAgentContexts.add(agentId);
    if (this.agentContextStats.has(agentId)) {
      this.agentContextStats.delete(agentId);
      this.forceUpdate?.();
    }
  }

  unsealAgentContext(agentId: string): void {
    this.sealedAgentContexts.delete(agentId);
  }


  getTimelineDensity(): TimelineDensity {
    return this.timelineDensity;
  }

  setTimelineDensity(density: TimelineDensity): void {
    if (this.timelineDensity === density) return;
    this.timelineDensity = density;
    // 切换密度时丢弃局部展开状态(避免切回 full 再切回 medium 时残留)
    this.expandedToolGroupIds.clear();
    this.forceUpdateStatic?.();
    this.forceUpdateDynamic?.();
    // 持久化(fire-and-forget, 失败不影响当前使用)
    persistTimelineDensity(density);
  }

  cycleTimelineDensity(): TimelineDensity {
    const idx = DENSITY_ORDER.indexOf(this.timelineDensity);
    const next = DENSITY_ORDER[(idx + 1) % DENSITY_ORDER.length];
    this.setTimelineDensity(next);
    return next;
  }

  isToolGroupExpanded(id: number): boolean {
    return this.expandedToolGroupIds.has(id);
  }

  toggleToolGroupExpanded(id: number): boolean {
    if (this.expandedToolGroupIds.has(id)) {
      this.expandedToolGroupIds.delete(id);
    } else {
      this.expandedToolGroupIds.add(id);
    }
    this.forceUpdateStatic?.();
    return this.expandedToolGroupIds.has(id);
  }

  getExpandedToolGroupIds(): Set<number> {
    return this.expandedToolGroupIds;
  }

  clearAllAgentContexts(): void {
    this.sealedAgentContexts.clear();
    if (this.agentContextStats.size > 0) {
      this.agentContextStats.clear();
      this.forceUpdate?.();
    }
  }

  getAgentContextStats(): AgentContextStats[] {
    const stats = Array.from(this.agentContextStats.values());
    // 按角色排序：Supervisor 优先，然后按 agentId 排序
    return stats.sort((a, b) => {
      if (a.agentId === 'supervisor') return -1;
      if (b.agentId === 'supervisor') return 1;
      return a.agentId.localeCompare(b.agentId);
    });
  }

  /**
   * Update the last message (for streaming)
   */
  updateLastMessage(content: string): void {
    if (this.messages.length === 0) return;
    const lastMessage = this.messages[this.messages.length - 1];
    if (typeof lastMessage.content === 'string') {
      lastMessage.content = content;
    } else if (Array.isArray(lastMessage.content)) {
      // Update text content in array
      const textContent = lastMessage.content.find(c => c.type === 'text');
      if (textContent && 'text' in textContent) {
        textContent.text = content;
      }
    }
    this.forceUpdate?.();
  }

  /**
   * Get the last message text (for adapter)
   */
  getLastMessageText(): string {
    if (this.messages.length === 0) return '';
    const lastMessage = this.messages[this.messages.length - 1];
    if (typeof lastMessage.content === 'string') {
      return lastMessage.content;
    } else if (Array.isArray(lastMessage.content)) {
      const textContent = lastMessage.content.find(c => c.type === 'text');
      if (textContent && 'text' in textContent) {
        return textContent.text || '';
      }
    }
    return '';
  }

  setRunning(running: boolean): void {
    if (this.isRunning !== running) {
      /* 常开取证: 记下"谁"改的运行态。"turn 结束了状态栏还在转"这类问题, 唯一要回答的就是
       * "最后一次 setRunning(true) 是谁打的" —— 调用栈比任何猜测都快。只取栈里第一帧非本文件的。 */
      uiTrace({
        ev: 'running',
        value: running,
        who: callerOf('setRunning'),
        status: clipForUiTrace(this.statusText, 60),
      });
      if (running) {
        // Starting to run - record start time
        this.runningStartTime = Date.now();
      } else {
        // Stopping - accumulate the elapsed time
        if (this.runningStartTime !== null) {
          const elapsed = Math.floor((Date.now() - this.runningStartTime) / 1000);
          this.accumulatedRunTime += elapsed;
          this.runningStartTime = null;
        }
      }
      this.isRunning = running;
      this.forceUpdateDynamic?.();
      this.forceUpdateBottom?.();
    }
  }

  /** Read current busy flag (compact ownership / interrupt UI). */
  getIsRunning(): boolean {
    return this.isRunning;
  }

  triggerForceUpdate(): void {
    this.forceUpdate?.();
  }

  setStatusText(text: string): void {
    this.statusText = text;
    this.forceUpdateBottom?.();
  }

  /**
   * Update token stats
   */
  setTokenStats(stats: {
    input: number;
    output: number;
    total: number;
    contextWindow?: number;
    tokensUsedForContext?: number;
    pressure?: number;
    systemTokens?: number;
    userTokens?: number;
    assistantTokens?: number;
    toolCallTokens?: number;
    toolResultTokens?: number;
    // Legacy fields
    toolTokens?: number;
    messageTokens?: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
  }): void {
    cliLogger.info('DEBUG_CTX', `InkRuntime.setTokenStats: received contextWindow=${stats.contextWindow}, current=${this.tokenStats.contextWindow}`);

    // 这样切换模型时才能正确更新 context window 显示
    const newContextWindow = stats.contextWindow !== undefined ? stats.contextWindow : this.tokenStats.contextWindow;

    const changed =
      this.tokenStats.input !== stats.input ||
      this.tokenStats.output !== stats.output ||
      this.tokenStats.total !== stats.total ||
      this.tokenStats.contextWindow !== newContextWindow ||
      this.tokenStats.tokensUsedForContext !== stats.tokensUsedForContext ||
      this.tokenStats.pressure !== stats.pressure ||
      this.tokenStats.toolTokens !== stats.toolTokens ||
      this.tokenStats.messageTokens !== stats.messageTokens ||
      this.tokenStats.systemTokens !== stats.systemTokens ||
      this.tokenStats.userTokens !== stats.userTokens ||
      this.tokenStats.assistantTokens !== stats.assistantTokens ||
      this.tokenStats.toolCallTokens !== stats.toolCallTokens ||
      this.tokenStats.toolResultTokens !== stats.toolResultTokens ||
      this.tokenStats.cacheCreationTokens !== stats.cacheCreationTokens ||
      this.tokenStats.cacheReadTokens !== stats.cacheReadTokens;

    if (changed) {
      this.tokenStats = {
        ...stats,
        contextWindow: newContextWindow,
        tokensUsedForContext: stats.tokensUsedForContext ?? this.tokenStats.tokensUsedForContext,
        pressure: stats.pressure ?? this.tokenStats.pressure,
      };
      cliLogger.info('DEBUG_CTX', `InkRuntime.setTokenStats: after update contextWindow=${this.tokenStats.contextWindow}`);
      this.forceUpdateBottom?.();
    }
  }

  /**
   * Clear all messages
   */
  clearMessages(): void {
    cliLogger.debug('INK_RUNTIME', `clearMessages: clearing pending/static queues (messages=${this.messages.length})`);
    this.messages = [];
    this.staticEntries = [];
    this.pendingEntries = [];

    this.forceUpdate?.();
  }

  /**
   * Set command output
   */
  setCommandOutput(lines: string[]): void {
    cliLogger.debug('INK_RUNTIME', 'Set command output', { lineCount: lines.length });
    this.commandOutput = lines;
    this.forceUpdate?.();
  }

  /**
   * Clear command output
   */
  clearCommandOutput(): void {
    cliLogger.debug('INK_RUNTIME', 'Clear command output');
    this.commandOutput = [];
    this.forceUpdate?.();
  }

  /** 返回该图片的【编号 seq】(用于在输入框插入 [图片 #seq] token); 重复图复用旧 seq; 超上限/无效返 null。 */
  attachImage(imageData: string | AttachedImage): number | null {
    let image: AttachedImage;

    // Handle legacy string path format
    if (typeof imageData === 'string') {
      // Check if it's a file path or already a data URL
      if (imageData.startsWith('data:')) {
        // Already a data URL, extract parts
        const match = imageData.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          const name = `image_${Date.now()}.png`;
          image = {
            mediaType: match[1],
            data: match[2],
            name
          };
        } else {
          cliLogger.error('INK_RUNTIME', 'Invalid data URL format', { imageData });
          return null;
        }
      } else {
        // File path - for legacy support
        const name = imageData.split('/').pop() || imageData;
        image = { path: imageData, name };
      }
    } else {
      image = imageData;
    }

    // 重复图 (同 path/data) → 复用旧 seq, 不重复存 (插入的 token 指向已有图)。
    const dup = this.attachedImages.find(img =>
      (img.path && image.path && img.path === image.path) ||
      (img.data && image.data && img.data === image.data)
    );
    if (dup) {
      cliLogger.debug('INK_RUNTIME', 'Image already attached — reuse seq');
      return (dup as any).seq ?? null;
    }

    const MAX_IMAGES = 10;
    if (this.attachedImages.length >= MAX_IMAGES) {
      cliLogger.info('INK_RUNTIME', `图片已达上限 ${MAX_IMAGES} 张, 忽略本次粘贴`);
      this.setStatusText(`最多只能附加 ${MAX_IMAGES} 张图片`);
      this.forceUpdate?.();
      return null;
    }

    // 分配稳定编号 seq (跨删除不复用; 每条消息发送后归零)。token [图片 #seq] 插到输入框光标处。
    const seq = ++this.imageSeqCounter;
    (image as any).seq = seq;
    this.attachedImages.push(image);

    cliLogger.info('INK_RUNTIME', `📎 Attached image #${seq}: ${image.name || 'unnamed'}`);
    this.forceUpdate?.();
    return seq;
  }

  /** 提交时按【输入框文本里出现的 [图片 #N] token】顺序挑出对应图片 (token 被删的图不发)。 */
  private resolveImagesFromText(text: string): AttachedImage[] {
    const result: AttachedImage[] = [];
    const seen = new Set<number>();
    const re = /\[图片\s*#(\d+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const seq = parseInt(m[1], 10);
      if (seen.has(seq)) continue;
      const img = this.attachedImages.find(i => (i as any).seq === seq);
      if (img) { result.push(img); seen.add(seq); }
    }
    return result;
  }

  clearAttachedImages(): void {
    if (this.attachedImages.length > 0) {
      cliLogger.debug('INK_RUNTIME', `Cleared ${this.attachedImages.length} attached images`);
      this.attachedImages = [];
      this.imageSeqCounter = 0;
      this.forceUpdate?.();
    }
  }

  getAttachedImages(): AttachedImage[] {
    return [...this.attachedImages];
  }

  showInterruptInput(): void {
    cliLogger.debug('INK_RUNTIME', 'Show interrupt input');
    this.interruptInputActive = true;
    this.forceUpdate?.();
  }

  hideInterruptInput(): void {
    cliLogger.debug('INK_RUNTIME', 'Hide interrupt input');
    this.interruptInputActive = false;
    this.forceUpdate?.();
  }

  handleInterruptInputSubmit(text: string): void {
    cliLogger.debug('INK_RUNTIME', 'Handle interrupt input submit', { text: text.substring(0, 50) });
    // Hide the interrupt input box
    this.hideInterruptInput();
    // Submit the message via callbacks (will be handled by main.ts -> RuntimeHost)
    this.callbacks.onSubmit(text);
  }

  setGetPendingMessages(fn: () => Array<{ text: string; timestamp: Date }>): void {
    this.getPendingMessages = fn;
  }

  /** ↑ 撤回排队消息的回调 — main 注入 (调 sdkClient.removeLastPendingMessage), App 经 onPullbackQueued 调用 */
  private pullbackQueuedFn: (() => Promise<string | null>) | null = null;
  setPullbackQueued(fn: (() => Promise<string | null>) | null): void {
    this.pullbackQueuedFn = fn;
  }

  /**
   * Get queued messages for display — 读本地副本 (server 事件驱动)。
   */
  getQueuedMessagesForDisplay(): Array<{
    id: number;
    text: string;
    timestamp: Date;
  }> {
    return this.localQueuedMessages.map((msg, index) => ({
      id: index + 1,
      text: msg.text,
      timestamp: msg.timestamp,
    }));
  }

  hasQueuedMessages(): boolean {
    return this.localQueuedMessages.length > 0;
  }

  /** server 报 queued_message_added → 追加到本地副本 */
  addQueuedMessageLocal(text: string): void {
    if (!text) return;
    this.localQueuedMessages.push({ text, timestamp: new Date() });
    this.throttledUpdateBottom();
  }

  /** server 报 queued_messages_processed → 清空 (消息已进对话历史) */
  clearQueuedMessagesLocal(): void {
    if (this.localQueuedMessages.length === 0) return;
    this.localQueuedMessages = [];
    this.throttledUpdateBottom();
  }

  /** 用户按 ↑ 撤回最后一条排队消息 → 弹出并返回其文本 (拉回输入框编辑); 空则 null */
  popQueuedMessageLocal(): string | null {
    const last = this.localQueuedMessages.pop();
    if (!last) return null;
    this.throttledUpdateBottom();
    return last.text;
  }

  // ==================== Agent 事件处理 ====================

  addAgentSpawnEntry(agentId: string, agentIndex: number, task: string, agentModel?: string): number {
    return this.addEntry({
      type: 'agent_spawn',
      agentId,
      agentIndex,
      agentStatus: 'running',
      agentTask: task,
      agentModel,
      text: task,
    });
  }

  addAgentProgressEntry(
    agentId: string,
    agentIndex: number,
    progress: number,
    message: string
  ): number {
    return this.addEntry({
      type: 'agent_progress',
      agentId,
      agentIndex,
      agentStatus: 'running',
      agentProgress: progress,
      text: message,
    });
  }

  addAgentCompleteEntry(
    agentId: string,
    agentIndex: number,
    result: string
  ): number {
    return this.addEntry({
      type: 'agent_complete',
      agentId,
      agentIndex,
      agentStatus: 'completed',
      text: result,
    });
  }

  addAgentErrorEntry(
    agentId: string,
    agentIndex: number,
    error: string
  ): number {
    return this.addEntry({
      type: 'agent_error',
      agentId,
      agentIndex,
      agentStatus: 'error',
      agentError: error,
      text: error,
    });
  }

  /**
   * Set version info
   */
  setVersion(version: string): void {
    this.version = version;
    this.forceUpdate?.();
  }

  /**
   * Set provider info
   */
  setProvider(provider: string): void {
    this.provider = provider;
    this.forceUpdate?.();
  }

  setAccount(account: string | undefined, tone?: 'cyan' | 'green' | 'gray'): void {
    this.account = account;
    this.accountTone = tone;
    this.forceUpdate?.();
  }

  /**
   * Set model info
   */
  setModel(model: string): void {
    this.model = model;
    this.forceUpdate?.();
  }

  /**
   * Set model reasoning effort info for UI display
   */
  setReasoningEffort(reasoningEffort?: string): void {
    this.reasoningEffort = reasoningEffort || '';
    this.forceUpdate?.();
  }

  setRunMode(mode: 'agentic'): void {
    this.runMode = mode;
    this.forceUpdate?.();
  }

  // ── Sidebar Agents API (assistant mode) ──────────────────────

  /** 添加或更新侧边栏任务 Agent */
  /** 后台 (run_in_background) agent id 集合 — 它们的卡片整个从主时间线滤掉 (不渲不 commit),
   *  只在底部 N agents 计数显示。跟条目时序解耦, 防 reserve/commit 竞态。 */
  private backgroundAgentIds = new Set<string>();
  markBackgroundAgent(agentId: string): void {
    if (agentId) this.backgroundAgentIds.add(agentId);
  }
  isBackgroundAgent(agentId: string | undefined): boolean {
    return !!agentId && this.backgroundAgentIds.has(agentId);
  }

  upsertSidebarAgent(agent: {
    id: string;
    role: string;
    task: string;
    status: 'running' | 'completed' | 'error';
    toolCount?: number;
    tokens?: number;
    toolRecords?: Array<{ name: string; args?: string; status: 'running' | 'done' | 'error' }>;
  }): void {
    const existing = this.sidebarAgents.find(a => a.id === agent.id);
    if (existing) {
      existing.role = agent.role;
      existing.task = agent.task;
      existing.status = agent.status;
      if (agent.toolCount !== undefined) existing.toolCount = agent.toolCount;
      if (agent.tokens !== undefined) existing.tokens = agent.tokens;
      if (agent.toolRecords !== undefined) existing.toolRecords = agent.toolRecords;
      existing.elapsed = Math.round((Date.now() - existing.startTime) / 1000);
    } else {
      this.sidebarAgents.push({
        id: agent.id,
        role: agent.role,
        task: agent.task,
        status: agent.status,
        toolCount: agent.toolCount ?? 0,
        tokens: agent.tokens ?? 0,
        elapsed: 0,
        startTime: Date.now(),
        toolRecords: agent.toolRecords,
      });
    }
    this.forceUpdate?.();
    this.forceUpdateBottom?.();
  }

  /** 移除已完成的侧边栏 agent（延迟清理） */
  removeSidebarAgent(id: string): void {
    this.sidebarAgents = this.sidebarAgents.filter(a => a.id !== id);
    this.forceUpdate?.();
    this.forceUpdateBottom?.();
  }

  /** 清空所有侧边栏 agent */
  clearSidebarAgents(): void {
    this.sidebarAgents = [];
    this.forceUpdate?.();
    this.forceUpdateBottom?.();
  }

  /**
   * ESC/Enter 中断: 把卡住的 Explore/task 卡片从底部 pending 区强制收掉,
   * 并清空 sidebar 计数 (修 "Explore 一直在最底部 / N 个后台 agent")。
   */
  abortRunningTaskAgents(): void {
    if (this.pendingEntries.length === 0 && this.sidebarAgents.length === 0) {
      this.forceUpdateBottom?.();
      return;
    }

    const remaining: TimelineEntry[] = [];
    const toCommit: TimelineEntry[] = [];

    for (const e of this.pendingEntries) {
      if (e.type === 'task_agent_progress' && (e as any).taskAgentStatus === 'running') {
        toCommit.push({
          ...e,
          isStreaming: false,
          isComplete: true,
          taskAgentStatus: 'error',
          text: ((e as any).text || e.taskAgentTask || 'Explore') + ' (interrupted)',
        } as TimelineEntry);
      } else if (
        e.type === 'task_agent_progress'
        && ((e as any).taskAgentKind === 'background' || this.backgroundAgentIds.has((e as any).taskAgentId))
      ) {
        // 后台卡不进 static, 中断时直接丢掉
        continue;
      } else if (e.type === 'task_agent_progress') {
        toCommit.push({ ...e, isStreaming: false, isComplete: true } as TimelineEntry);
      } else {
        remaining.push(e);
      }
    }

    this.pendingEntries = remaining;
    if (toCommit.length > 0) {
      this.staticEntries = [...this.staticEntries, ...toCommit];
    }
    this.sidebarAgents = [];
    this.forceUpdate?.();
    this.forceUpdateDynamic?.();
    this.forceUpdateBottom?.();
  }

  removeCompletedSidebarAgents(): void {
    const before = this.sidebarAgents.length;
    this.sidebarAgents = this.sidebarAgents.filter(a => a.status === 'running');
    if (this.sidebarAgents.length !== before) {
      this.forceUpdate?.();
      this.forceUpdateBottom?.();
    }
  }

  /** 获取侧边栏 agent 列表（供 App 使用） */
  getSidebarAgents(): Array<{
    id: string;
    role: string;
    task: string;
    status: 'running' | 'completed' | 'error';
    toolCount: number;
    tokens: number;
    elapsed: number;
    toolRecords?: Array<{ name: string; args?: string; status: 'running' | 'done' | 'error' }>;
  }> {
    // 更新 elapsed
    const now = Date.now();
    for (const a of this.sidebarAgents) {
      if (a.status === 'running') {
        a.elapsed = Math.round((now - a.startTime) / 1000);
      }
    }
    return this.sidebarAgents;
  }

  setPlanSteps(steps: Array<{
    step: string;
    status: 'pending' | 'in_progress' | 'completed';
  }>): void {
    this.currentPlanSteps = steps;
    this.forceUpdate?.();
  }

  getPlanSteps(): typeof this.currentPlanSteps {
    return this.currentPlanSteps;
  }

  clearPlanSteps(): void {
    this.currentPlanSteps = [];
    this.forceUpdate?.();
  }

  /**
   * Set work directory
   */
  setWorkDir(workDir: string): void {
    this.workDir = workDir;
    this.forceUpdate?.();
  }

  /**
   * Set header visibility
   */
  setShowHeader(show: boolean): void {
    this.showHeader = show;
    this.forceUpdate?.();
  }

  /**
   * Set thinking enabled state
   */
  setThinkingEnabled(enabled: boolean): void {
    if (this.thinkingEnabled !== enabled) {
      this.thinkingEnabled = enabled;
      this.forceUpdate?.();
    }
  }

  /**
   * Show select menu
   */
  showSelectMenu(options: SelectMenuOptions): void {
    cliLogger.debug('INK_RUNTIME', 'Show select menu', { options });

    // Avoid unnecessary resume() calls that can cause event loop blocking
    if (process.stdin.isTTY && !process.stdin.destroyed) {
      const wasPaused = process.stdin.isPaused?.() || false;
      const wasRaw = (process.stdin as any).isRaw || false;

      // Only resume if paused (without changing raw mode state)
      if (wasPaused) {
        if (process.env.CLI_DEBUG === '1') {
          cliLogger.debug('INK_RUNTIME', `showSelectMenu: Resuming stdin (wasPaused=${wasPaused})`);
        }

        try {
          process.stdin.resume();
          cliLogger.info('INK_RUNTIME', '✓ Stdin resumed for SelectMenu');
        } catch (error) {
          cliLogger.error('INK_RUNTIME', 'Failed to resume stdin for SelectMenu', { error });
        }
      }
    }

    this.selectMenuOptions = options;
    this.forceUpdate?.();
  }

  hideSelectMenu(): void {
    cliLogger.debug('INK_RUNTIME', 'Hide select menu');

    // Apple Terminal doesn't handle ANSI escape sequences as well as iTerm2
    if (this.selectMenuOptions) {
      const menuLines = this.selectMenuOptions.choices.length + 5; // choices + header + hint + padding
      process.stdout.write(ansiEscapes.eraseLines(menuLines));
    }

    this.selectMenuOptions = null;

    // This helps prevent ghosting/残影 when rapidly switching menus
    this.forceUpdate?.();

    // Schedule second force update after microtask queue
    // This ensures any pending React updates from the previous menu are flushed
    process.nextTick(() => {
      this.forceUpdate?.();
    });
  }

  /**
   * Check if select menu is active
   */
  isSelectMenuActive(): boolean {
    return this.selectMenuOptions !== null;
  }

  /**
   * Update selected index for the active select menu
   */
  updateSelectMenuIndex(index: number): void {
    if (!this.selectMenuOptions) {
      return;
    }
    const maxIndex = Math.max(0, this.selectMenuOptions.choices.length - 1);
    const safeIndex = Math.max(0, Math.min(index, maxIndex));
    this.selectMenuOptions = {
      ...this.selectMenuOptions,
      initialIndex: safeIndex,
    };
    this.forceUpdate?.();
  }

  /**
   * Show text prompt
   */
  showTextPrompt(options: TextPromptOptions): void {
    cliLogger.debug('INK_RUNTIME', 'Show text prompt', { options });

    // Avoid unnecessary resume() calls that can cause event loop blocking
    if (process.stdin.isTTY && !process.stdin.destroyed) {
      const wasPaused = process.stdin.isPaused?.() || false;

      // Only resume if paused (without changing raw mode state)
      if (wasPaused) {
        if (process.env.CLI_DEBUG === '1') {
          cliLogger.debug('INK_RUNTIME', `showTextPrompt: Resuming stdin (wasPaused=${wasPaused})`);
        }

        try {
          process.stdin.resume();
          cliLogger.info('INK_RUNTIME', '✓ Stdin resumed for TextPrompt');
        } catch (error) {
          cliLogger.error('INK_RUNTIME', 'Failed to resume stdin for TextPrompt', { error });
        }
      }
    }

    this.textPromptOptions = options;
    this.forceUpdate?.();
  }

  /**
   * Hide text prompt
   */
  hideTextPrompt(): void {
    cliLogger.debug('INK_RUNTIME', 'Hide text prompt');
    this.textPromptOptions = null;
    this.forceUpdate?.();
  }

  /**
   * Show context menu
   */
  showContextMenu(): void {
    cliLogger.debug('INK_RUNTIME', 'Show context menu');
    this.contextMenuActive = true;
    this.forceUpdate?.();
  }

  /**
   * Hide context menu
   */
  hideContextMenu(): void {
    cliLogger.debug('INK_RUNTIME', 'Hide context menu');
    this.contextMenuActive = false;
    this.forceUpdate?.();
  }

  /**
   * Get context menu active state
   */
  getContextMenuActive(): boolean {
    return this.contextMenuActive;
  }

  private clearStaticEntries(): void {
    if (this.staticEntries.length === 0) {
      return;
    }

    const clearedCount = this.staticEntries.length;
    cliLogger.debug('INK_RUNTIME', `Clearing ${clearedCount} static entries from memory`);

    this.staticEntries = [];

    // which creates an infinite loop. Let React naturally re-render on next addEntry.
    // this.forceUpdate?.();  // REMOVED

    if (global.gc && clearedCount > 10) {
      cliLogger.debug('INK_RUNTIME', 'Triggering manual GC after clearing entries');
      setImmediate(() => {
        if (global.gc) {
          global.gc();
        }
      });
    }
  }

  private startMemorySampler(): void {
    if (this.memoryLogTimer || process.env.INK_MEM !== '1') {
      return;
    }

    this.memoryLogTimer = setInterval(() => {
      const usage = process.memoryUsage();
      const toMB = (value: number) => Math.round((value / 1024 / 1024) * 10) / 10;

      cliLogger.info('INK_MEM', 'usage', {
        rssMB: toMB(usage.rss),
        heapUsedMB: toMB(usage.heapUsed),
        heapTotalMB: toMB(usage.heapTotal),
        externalMB: toMB(usage.external),
        arrayBuffersMB: toMB(usage.arrayBuffers ?? 0),
        pendingEntries: this.pendingEntries.length,
        queuedStatic: this.staticEntries.length,
        isRunning: this.isRunning,
      });
    }, 10000);
  }

  private stopMemorySampler(): void {
    if (this.memoryLogTimer) {
      clearInterval(this.memoryLogTimer);
      this.memoryLogTimer = null;
    }
  }
}
