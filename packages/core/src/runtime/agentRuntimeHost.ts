import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';
import { readFile as fsReadFile } from 'fs/promises';
import path from 'path';
import type { StreamedRunner, ToolApprovalHandler } from '@neoxlabs/kernel/core/runner.js';
import { SessionContext, type PersistedMessage } from '@neoxlabs/platform/platform/sessionContext.js';
import { AgentMode } from '@neoxlabs/kernel/types/permissions.js';
import type { ShortTermMemory } from '@neoxlabs/kernel/memory/shortterm.js';
import type {
  DefaultSessionManager,
} from '../memory/index.js';
import type { Session } from '@neoxlabs/kernel/types/session.js';
import { stripToolFailureTag } from '@neoxlabs/kernel/core/types/toolResult.js';
import { invalidateReads } from '../tools/smart-read/readLedger.js';
import { rebuildReadLedgerFromHistory } from '../tools/smart-read/ledgerRebuild.js';
import { readLedgerFileCount } from '../tools/smart-read/readLedger.js';
import { normalizeUsageTokens } from '@neoxlabs/kernel/utils/usageNormalize.js';
import { SessionSyncManager } from '../memory/session-sync.js';
import { dumpCompactionQualityIfEnabled } from '../compat/compactor.js';
import type {
  MemoryPressureMonitor,
  MemoryPressureSnapshot,
  MemoryPressureState,
} from '@neoxlabs/kernel/compat/memoryPressure.js';
import { calculateTokenBreakdown } from '@neoxlabs/kernel/compat/memoryPressure.js';
import { logger } from '@neoxlabs/kernel/utils/logger.js';
import type { Message, MessageContentPart, LLMProvider, StreamEvent } from '@neoxlabs/kernel/types/index.js';
import type { CheckpointItem, FileEditSnapshotItem, FileSnapshotItem } from '@neoxlabs/kernel/types/session.js';
import type { UndoResult, RollbackResult } from '../memory/session-sync.js';
import type { CompatProfile } from '@neoxlabs/kernel/types/compat.js';
import { extractTargetPath, inferToolDescription, ToolDescriptionExtractor, CommandGenerator } from './toolHelpers.js';
import { ToolBatchDetector, BatchDecision } from './toolBatchDetector.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { notifyHook, notifyTurnEnd, applyUserPromptSubmit, preCompactGate, notifyPostCompact } from './runtimeHooks.js';
import { compressImageDataUrlIfNeeded } from '../tools/image/imageProcessor.js';
import { writeStallFile } from '@neoxlabs/kernel/utils/stallGuard.js';
import { getActiveRunDiagnostics } from '@neoxlabs/kernel/utils/runTrace.js';
import { getBrowserSession } from './browser/browserSession.js';
import {
  shouldKeepWaitingInToolPhase, describeToolPhaseWait, toolPhaseMaxWaitMs,
} from './resilience/toolPhaseWait.js';
import { isCompactionSummaryMessage } from '@neoxlabs/kernel/utils/compression/llmSummarizer.js';
import { agentRegistry } from '@neoxlabs/kernel';
import { resolveCompatProfile } from '@neoxlabs/platform/compat/profile.js';
import { neoxLogger } from '@neoxlabs/kernel/platform/neoxLogger.js';
import { ErrorCategory } from '@neoxlabs/kernel/types/errors.js';
import { buildClaudeCodeUserId } from '@neoxlabs/platform/utils/config.js';
import { getDefaultThinkingStatus } from '@neoxlabs/platform/shared/defaultThinkingStatus.js';
import { normalizeContextBreakdown, type ContextTokenBreakdown } from '@neoxlabs/kernel/utils/contextBreakdown.js';

// Import from extracted modules
import {
  type ToolErrorResult,
  type RuntimeStatusType,
  type HostAttachment,
  type RuntimeMetadata,
  type RunTaskOptions,
  type AgentRuntimeHostOptions,
  type AgentRuntimeEvent,
  type RuntimeEventListener,
  type RunTaskResult,
} from './runtimeTypes.js';
import { attemptJsonRepair, detectTruncation, isSyntacticallyComplete } from './utils/jsonRepair.js';
import { reportToolArgsFailure } from './toolArgsFailureReport.js';
import { createToolErrorResult } from './utils/toolErrors.js';
import { recordCacheSnapshot } from './cacheHealthMonitor.js';
import { getGlobalCostTracker } from '@neoxlabs/platform/platform/costTracker.js';
/* 代理连不上时让代理配置被现实纠正 —— 见 systemProxy.reportProxyUnreachable 的说明。
 * 挂在这里是因为 LLM 请求是撞到死代理最频繁、也最早的一条路。 */
import { reportProxyUnreachableFromErrorText } from '@neoxlabs/platform/platform/systemProxy.js';
import { parseToolArguments } from '@neoxlabs/kernel/core/toolArgsParser.js';
import { HostStateMachine } from './events/hostStateMachine.js';
import { TurnMetricsCollector } from './agentMetricsCollector.js';
import { syncSandboxModeFromConfig } from '../tools/shell/osSandbox.js';
import { activateSessionScratch, cleanupSessionScratch } from './shell/sessionScratch.js';
import type { SessionTitleMeta, SideAgentAdapter } from './sideAgentAdapter.js';
import {
  shouldReaggregateTitle,
  TITLE_MATERIAL_CHARS_PER_MESSAGE,
  TITLE_MATERIAL_RECENT_MESSAGES,
} from './sessionTitlePolicy.js';
import { appendDiagLog as appendDiagLogHost } from './agent/diagLogFile.js';
import type { ToolCallSummaryInput } from './claude/sideAgentPrompts.js';
import { INTERRUPT_STATUS_LABEL } from './agent/taskAgentRunFailure.js';

// Re-export types for backwards compatibility
export type {
  RuntimeStatusType,
  HostAttachment,
  RuntimeMetadata,
  RunTaskOptions,
  AgentRuntimeHostOptions,
  AgentRuntimeEvent,
  RunTaskResult,
};

// NOTE: Types and utility functions have been moved to:
// - ./runtimeTypes.ts (type definitions)
// - ./utils/jsonRepair.ts (attemptJsonRepair, detectTruncation)
// - ./utils/toolErrors.ts (createToolErrorResult)

import { MAX_TOOL_OUTPUT_PREVIEW, estimatePostCompactContext, buildInjectedUserMessage, prepareTaskInputText, getLastUserTask, runnerStreamRetryToUi, dropDiscardedTail, isControlPrompt, realUserMessages } from './agentRuntimeHostHelpers.js';
export { buildInjectedUserMessage } from './agentRuntimeHostHelpers.js';

export class AgentRuntimeHost {
  private runner: StreamedRunner;
  private memory: ShortTermMemory;
  private sessionManager: DefaultSessionManager;
  private runtimeSessionId?: string;
  private agentName?: string;
  private agentDescription?: string;
  private configuredToolCount?: number;
  private registeredToolNames?: Set<string>;
  private sessionSync?: SessionSyncManager;
  private session?: Session;
  private sessionEnabled: boolean;
  private memoryPressure?: MemoryPressureMonitor;
  private compatProfile?: CompatProfile | null;
  private workDir: string;
  private model: string;
  private systemPrompt?: string;
  private sandboxSetter?: (enabled: boolean) => void;
  private llmProvider?: LLMProvider;

  /** R2 wire: 暴露 llmProvider 供 W4 SessionMemory 提取等外部业务方用 */
  public getLlmProvider(): LLMProvider | undefined {
    return this.llmProvider;
  }

  private sessionSeed: string;
  /** Cumulative input tokens across all tasks in this session */
  private sessionTotalInputTokens: number = 0;
  /** Cumulative output tokens across all tasks in this session */
  private sessionTotalOutputTokens: number = 0;

  private lastMemoryPressureState: MemoryPressureState = 'unknown';
  private autoCompactionInProgress = false;
  /** 固定底座 (工具定义等) 的会话内滚动下界 — 见 handleMemorySnapshot 里的赋值注释 */
  private sessionMinFixedOverhead: number | null = null;
  private isRunning = false;
  private shouldInterrupt = false;
  /** 是什么把这一轮掐了 (来自 abortSignal.reason): 超时 / 父级停止 / 预算熔断 / 用户手停。
   *  没有它, 收尾就只能一律说 "Task interrupted", 四种情况在下游长成一个样。 */
  private interruptReason: string | null = null;
  private abortController: AbortController | null = null;
  private interruptResolver: (() => void) | null = null;
  private interruptPromise: Promise<{ interrupted: true }> | null = null;
  private compressionMode: 'sync' | 'async' = 'sync';
  private _sessionInitPromise: Promise<void> | null = null;

  private eventEmitter = new EventEmitter();
  private eventSequence = 0;
  private readonly hostStateMachine = new HostStateMachine();

  // Phase 2: 描述提取器和命令生成器
  private descriptionExtractor = new ToolDescriptionExtractor();
  private commandGenerator = new CommandGenerator();
  private lastAssistantMessage = '';

  // Phase 3: 批量检测器
  private batchDetector = new ToolBatchDetector();
  private toolCallIdCounter = 0;
  // 映射工具名称到最近的工具调用信息（用于在 tool_output 时关联批量信息）
  private recentToolCalls = new Map<string, { toolId: string; batchId?: string; targetPath?: string; args?: Record<string, any>; toolName?: string }>();

  private currentTaskMetadata: RuntimeMetadata | undefined; // 当前任务的 metadata

  private pendingInjectedMessages: Array<{
    text: string;
    timestamp: Date;
    images?: Array<{ mediaType: string; data: string; name?: string }>;
  }> = [];

  //   - persistScheduledTimer: 当前排队的 debounce 定时器
  //   - persistInFlight: 正在执行的 flush promise,串行以避免 race
  //   - persistMemoryHookOff: 取消订阅 memory.onMessageAdded 的函数
  //   - persistSuspended: loadHistory 等批量写 memory 的场景临时禁用,防止从 SQLite 读出来又写回去
  private persistScheduledTimer: NodeJS.Timeout | null = null;
  private persistInFlight: Promise<void> | null = null;
  private persistMemoryHookOff: (() => void) | null = null;
  private persistSuspended = false;
  private lastPersistedMemoryLen: number | null = null;
  /** 本轮入口 user 消息已由 server 单源落库 → flushPersist 要跳过 memory 里的同一条。
   *  存的是**注入版**原文 (server 存的是未注入版, 内容对不上, 只能靠这个字段认)。
   *  一轮只跳一条: 命中即清空, 后续排队插话的 user 消息照常落库。
   *  子 agent / CLI 等不走 server chat() 入口的路径不会设它 → 行为不变。 */
  private entryUserPromptPersistedElsewhere: string | null = null;
  private static readonly PERSIST_DEBOUNCE_MS = 250;
  /** P0-6: dispose 时 fire 的 flush promise — caller (app before-quit) 可 await 它,
   *   保证 process 退出前最后一批消息已落盘. dispose 同步返回不阻塞 (老调用方兼容). */
  public lastFlushPromise: Promise<void> | null = null;

  private sideAgentAdapter?: SideAgentAdapter;
  private sessionTitleScheduled = false;
  private pendingToolBatches = new Map<string, {
    tools: ToolCallSummaryInput[];
    timer: NodeJS.Timeout | null;
  }>();
  private static readonly TOOL_BATCH_DEBOUNCE_MS = 250;
  private static readonly TOOL_OUTPUT_PREVIEW_LIMIT = 600;
  private static readonly TOOL_BATCH_SUMMARY_ENABLED = false;

  constructor(options: AgentRuntimeHostOptions) {
    this.runner = options.runner;
    this.runner.onHistoryCompacted = (info) => this.onRunnerHistoryCompacted(info);
    this.memory = options.memory;
    this.sessionManager = options.sessionManager;
    this.runtimeSessionId = options.runtimeSessionId;
    this.agentName = options.agentName;
    this.agentDescription = options.agentDescription;
    this.configuredToolCount = options.configuredToolCount;
    this.registeredToolNames = options.registeredToolNames;
    this.sessionSync = options.sessionSync;
    this.session = options.session;
    this.sessionEnabled = options.sessionEnabled ?? true;
    this.workDir = path.resolve(options.workDir);
    this.model = options.model;
    this.systemPrompt = options.systemPrompt;
    this.memoryPressure = options.memoryPressure;
    this.compatProfile = options.compatProfile;
    this.sandboxSetter = options.setSandboxMode;
    this.llmProvider = options.llmProvider;
    this.sideAgentAdapter = options.sideAgentAdapter;
    this.sessionSeed = randomBytes(16).toString('hex');
    this._sessionInitPromise = null;
    //   让「OS 内核强制」与「工具类别门禁(toolRiskEvaluator)」用同一个档。
    try { syncSandboxModeFromConfig(); } catch { /* 非致命 */ }
    this.syncWorkspaceEnv();
    this.applyAnthropicSessionUserId();
    //   避免只在 turn 完成时才保存 → ui:dev rebuild / 进程崩溃时丢整轮对话。
    this.persistMemoryHookOff = this.memory.onMessageAdded(() => {
      this.schedulePersist();
    });
    //   这里把 memory 当前长度认作"已持久化",下次 add 才视为新增。
    //   不这么做的话, flushPersist 第一次进来会拿 null, 用户**第一条**新消息被当历史而吞掉.
    this.lastPersistedMemoryLen = this.memory.getAll().length;

    /* P0-2: agentRegistry register — 让 list_agents tool 看到所有 active agent.
     *   parentSessionId 从 options.parentSessionId 拿 (sub-agent 启动时设), main agent 为 undefined.
     *   销毁时 unregister 见 dispose(). runtimeSessionId 可能 undefined (无诊断 id 的 host),
     *   这种 host 不进 registry (没办法被引用 / 互通). */
    if (this.runtimeSessionId) {
      agentRegistry.register({
        sessionId: this.runtimeSessionId,
        agentName: this.agentName ?? 'main',
        role: options.parentSessionId ? 'subagent' : 'main',
        parentSessionId: options.parentSessionId,
        startedAt: Date.now(),
        taskDescription: this.agentDescription,
      });
    }
  }

  /** LLM 编出来的 tool name 不在注册集合 → 视为幻觉, 跳过所有 UI emit.
   *  registeredToolNames 未注入时返回 false (保持老 caller 行为, 不做校验).
   *  caller 已经 caller 用此判定守住 tool_call_start / _delta / "Calling" status /
   *  tool_call_done 四处 UI 入口. dispatch 走 runner.this.tools 真过滤, 这里只挡 UI 噪音. */
  private isHallucinatedToolName(name?: string | null): boolean {
    if (!this.registeredToolNames) return false;
    const trimmed = (name || '').trim();
    if (!trimmed) return false;  // 空名走原 fallback 'unknown' 逻辑, 不当幻觉
    return !this.registeredToolNames.has(trimmed);
  }

  private schedulePersist(): void {
    if (!this.sessionEnabled) return;
    if (!this.session?.sessionId) return;             // 没 sessionId 没法走 SessionContext
    if (this.persistSuspended) return;                // loadHistory 期间不回写
    if (this.persistScheduledTimer) return;            // 已排队,等当前 debounce 触发
    this.persistScheduledTimer = setTimeout(() => {
      this.persistScheduledTimer = null;
      void this.flushPersist();
    }, AgentRuntimeHost.PERSIST_DEBOUNCE_MS);
    this.persistScheduledTimer.unref?.();
  }

  private async flushPersist(): Promise<void> {
    if (!this.sessionEnabled || this.persistSuspended) return;
    const sessionId = this.session?.sessionId;
    if (!sessionId) return;
    // 串行:等上一次 flush 完成再启动新的,避免 lastPersistedMemoryLen 被并发修改
    if (this.persistInFlight) {
      await this.persistInFlight.catch(() => {});
    }
    this.persistInFlight = (async () => {
      try {
        const baseline = this.lastPersistedMemoryLen ?? this.memory.getAll().length;
        const currentLen = this.memory.getAll().length;
        if (currentLen <= baseline) return;

        const ctx = SessionContext.get(sessionId);
        const newMessages = this.memory.getAll().slice(baseline);
        let persisted = 0;
        for (const msg of newMessages) {
          const role = msg.role as PersistedMessage['role'];
          if (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'tool') {
            cliLogger.warn('AGENT_HOST', `flushPersist skip unknown role=${role}`);
            continue;
          }
          if (role === 'user' && typeof msg.content === 'string'
              && msg.content.trimStart().startsWith('<system-reminder>')) {
            continue;
          }
          /* 本轮入口 prompt server 已单源落库 —— 跳过, 只跳一条 (命中即清空)。 */
          if (role === 'user' && this.entryUserPromptPersistedElsewhere !== null
              && typeof msg.content === 'string'
              && msg.content === this.entryUserPromptPersistedElsewhere) {
            this.entryUserPromptPersistedElsewhere = null;
            continue;
          }
          const summary = typeof msg.content === 'string'
            ? msg.content
            : (msg.content == null ? '' : JSON.stringify(msg.content));
          const seq = ctx.appendMessage(role, summary, '', Date.now(), msg);
          if (seq >= 0) persisted++;
        }
        cliLogger.debug('AGENT_HOST',
          `flushPersist ${sessionId}: baseline=${baseline} current=${currentLen} delta=${newMessages.length} persisted=${persisted}`,
        );
        this.lastPersistedMemoryLen = this.memory.getAll().length;
      } catch (err: any) {
        cliLogger.warn('AGENT_HOST', `Incremental persist failed: ${err?.message}`);
      }
    })();
    try {
      await this.persistInFlight;
    } finally {
      this.persistInFlight = null;
    }
  }

  /** 最后 flush 一次,用于 dispose / turn 结束兜底。*/
  private async flushPersistImmediate(): Promise<void> {
    if (this.persistScheduledTimer) {
      clearTimeout(this.persistScheduledTimer);
      this.persistScheduledTimer = null;
    }
    await this.flushPersist();
  }

  on(listener: RuntimeEventListener): () => void {
    this.eventEmitter.on('event', listener);
    return () => this.eventEmitter.off('event', listener);
  }

  /** 获取当前 event listener 数量 */
  listenerCount(): number {
    return this.eventEmitter.listenerCount('event');
  }

  /** 移除所有 event listeners（防止 listener 泄漏导致事件重复） */
  removeAllListeners(): void {
    this.eventEmitter.removeAllListeners('event');
  }

  setWorkDir(workDir: string): void {
    this.workDir = path.resolve(workDir);
    this.syncWorkspaceEnv();
    if (this.runner && typeof (this.runner as any).setWorkspacePath === 'function') {
      (this.runner as any).setWorkspacePath(this.workDir);
    }
  }

  /** 本 host 是否已做过一次账本恢复兜底 (见 runTask 里的说明)。 */
  private readLedgerRestored = false;

  private async ensureSessionSync(sessionId: string): Promise<void> {
    // 已经有了，直接返回
    if (this.sessionSync) return;
    // 没启用 session，不需要
    if (!this.sessionEnabled) return;

    // 使用 Promise 缓存，确保只初始化一次（并发安全）
    if (!this._sessionInitPromise) {
      this._sessionInitPromise = this._doSessionInit(sessionId);
    }
    await this._sessionInitPromise;
  }

  private restoreReadLedger(reason: string): void {
    void rebuildReadLedgerFromHistory(
      this.memory.getAll() as any[],
      (p) => (path.isAbsolute(p) ? p : path.resolve(this.workDir || process.cwd(), p)),
      reason,
    ).catch((err) => {
      cliLogger.debug('LEDGER', `读账本重建失败 (${reason}, 退化为旧行为): ${err?.message ?? err}`);
    });
  }

  private async _doSessionInit(sessionId: string): Promise<void> {
    try {
      // 获取或创建 SQLite session
      const session = await this.sessionManager.getOrCreateSession(sessionId);
      this.session = session;

      // 创建 SessionSyncManager
      const sync = new SessionSyncManager({
        session,
        memory: this.memory,
        systemPrompt: this.systemPrompt,
      });
      this.sessionSync = sync;

      //   load 期间禁用增量持久化,防止"从 SQLite 读出来又写回去"的回路。
      this.persistSuspended = true;
      let loadedCount = 0;
      try {
        loadedCount = await sync.loadHistory();
      } finally {
        this.persistSuspended = false;
        // loadHistory 完成后所有 memory 内容都已在 SQLite 里,lastPersistedMemoryLen 对齐当前长度。
        this.lastPersistedMemoryLen = this.memory.getAll().length;
      }
      /* 无条件落盘 —— 猜了三次都错, 直接把事实记下来: 这条路径到底跑不跑? loadedCount 是多少?
         (cliLogger 桌面端不落盘, 所以之前这行等于不存在) */
      void import('@neoxlabs/kernel/utils/stallGuard.js').then(({ writeStallFile }) => {
        writeStallFile('info', 'SESSION_RESTORE', `_doSessionInit loadHistory=${loadedCount}`, {
          path: '_doSessionInit', loadedCount, memoryLen: this.memory.getAll().length, sessionId,
        });
      }).catch(() => {});
      if (loadedCount > 0) {
        cliLogger.info('SESSION_INIT', `✅ Restored ${loadedCount} messages from session ${sessionId}`);
        this.restoreReadLedger('doSessionInit');
      } else {
        cliLogger.info('SESSION_INIT', `New session ${sessionId} (no history)`);
      }

      this.applyAnthropicSessionUserId();
    } catch (error: any) {
      cliLogger.error('SESSION_INIT', `Failed to init session ${sessionId}: ${error.message}`);
      // 不阻塞对话 — sessionSync 为空时 runTask 仍然可以工作（只是不持久化）
      this._sessionInitPromise = null; // 允许下次重试
    }
  }

  setSession(session: Session | undefined, sync?: SessionSyncManager): void {
    this.session = session || undefined;
    this.sessionSync = sync;
    this.applyAnthropicSessionUserId();
  }

  private applyAnthropicSessionUserId(): void {
    const adapter: any = this.llmProvider;
    const provider = adapter?.getProvider?.();
    if (!provider || typeof provider.setUserId !== 'function') {
      return;
    }
    const sessionId = this.session?.sessionId;
    const userId = buildClaudeCodeUserId(sessionId, this.sessionSeed);
    provider.setUserId(userId);
  }

  private sideAgentAbort: AbortController = new AbortController();

  private sideAgentSignal(): AbortSignal {
    if (this.sideAgentAbort.signal.aborted) this.sideAgentAbort = new AbortController();
    return this.sideAgentAbort.signal;
  }

  interrupt(): void {
    this.shouldInterrupt = true;
    getBrowserSession().stopForSession(this.runtimeSessionId || this.session?.sessionId);
    // Abort any pending API request immediately
    if (this.abortController) {
      this.abortController.abort();
    }
    /* 用户按停止 = 连侧路一起停 (他要的是"别再动了", 不区分主链侧链) */
    if (!this.sideAgentAbort.signal.aborted) this.sideAgentAbort.abort();
    if (this.interruptResolver) {
      this.interruptResolver();
    }
  }

  private createInterruptPromise(): Promise<{ interrupted: true }> {
    if (this.interruptPromise) {
      return this.interruptPromise;
    }
    this.interruptPromise = new Promise((resolve) => {
      this.interruptResolver = () => resolve({ interrupted: true });
    });
    return this.interruptPromise;
  }

  private clearInterruptPromise(): void {
    this.interruptResolver = null;
    this.interruptPromise = null;
  }

  private buildToolOutputSummary(
    toolName: string,
    args: any,
    output: string,
    resultLength: number,
    targetPath: string | undefined,
    success: boolean,
  ): string | undefined {
    if (!success) return undefined;

    let parsedContent = output;
    let parsedSummary = '';
    let parsedMessage = '';
    const outputTrimmed = output.trim();
    if (outputTrimmed.startsWith('{') && outputTrimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(outputTrimmed);
        if (parsed && typeof parsed === 'object') {
          if (typeof parsed.message === 'string') {
            parsedMessage = parsed.message;
          }

          if (typeof parsed.summary === 'string') {
            parsedSummary = parsed.summary;
          }

          if (typeof parsed.type === 'string') {
            if (typeof parsed.content === 'string') {
              parsedContent = parsed.content;
            }
          }
        }
      } catch (err: any) {
        cliLogger.debug('AGENT_HOST', `Non-critical: ${err?.message}`);
        // keep raw output
      }
    }

    const p = targetPath || args?.path || args?.file_path || args?.filePath || '';
    const short = (s: string, max = 60) => s.length > max ? s.slice(0, max - 1) + '…' : s;
    const normalizedToolName = (() => {
      const raw = String(toolName || '').trim().toLowerCase();
      if (['show_tree', 'smart_tree', 'list_directory', 'ls'].includes(raw)) return 'tree';
      if (['readfile', 'read', 'read_file', 'smart_read'].includes(raw)) return 'read';
      if (['search', 'grep'].includes(raw)) return 'search';
      if (['search_files', 'glob', 'find_files'].includes(raw)) return 'file_search';
      if (['write_file', 'write', 'edit_file', 'edit', 'file_update'].includes(raw)) return 'write';
      if (['execute_shell', 'execute_command', 'command_exec', 'bash', 'shell'].includes(raw)) return 'command';
      if (['execute_python', 'execute_javascript', 'code_exec'].includes(raw)) return 'code_exec';
      if (['web_search', 'websearch'].includes(raw)) return 'web_search';
      if (['web_fetch', 'webfetch'].includes(raw)) return 'web_fetch';
      if (['run_tests', 'run_lint', 'run_format'].includes(raw)) return 'run_tool';
      if (['update_plan', 'verify_step'].includes(raw)) return raw;
      return raw;
    })();

    // 尝试从 output 提取行数
    const lineCount = parsedContent ? parsedContent.split('\n').length : 0;

    switch (normalizedToolName) {
      // 目录树
      case 'tree': {
        const dir = args?.directory || p || '.';
        const dirs = (output.match(/\//g) || []).length;
        const files = lineCount > 1 ? lineCount - 1 : 0;
        return `${short(dir)} — ${files} entries${dirs ? `, ${dirs} dirs` : ''}`;
      }

      // Git
      case 'git_status': {
        const modified = (parsedContent.match(/^\s*M /gm) || []).length;
        const added = (parsedContent.match(/^\s*A /gm) || []).length;
        const deleted = (parsedContent.match(/^\s*D /gm) || []).length;
        const untracked = (parsedContent.match(/^\?\? /gm) || []).length;
        const parts: string[] = [];
        if (modified) parts.push(`${modified} modified`);
        if (added) parts.push(`${added} added`);
        if (deleted) parts.push(`${deleted} deleted`);
        if (untracked) parts.push(`${untracked} untracked`);
        return parts.length ? parts.join(', ') : (parsedSummary || 'clean');
      }
      case 'git_log': {
        const commits = (parsedContent.match(/^commit /gm) || []).length || Math.min(lineCount, 10);
        return parsedSummary || `${commits} commits`;
      }
      case 'git_diff': {
        const additions = (parsedContent.match(/^\+[^+]/gm) || []).length;
        const deletions = (parsedContent.match(/^-[^-]/gm) || []).length;
        return parsedSummary || `+${additions} -${deletions} lines`;
      }
      case 'git_commit':
        return short(parsedSummary || parsedContent.trim().split('\n')[0] || 'committed');
      case 'git_blame':
        return parsedSummary || `${lineCount} lines`;
      case 'git_branch':
      case 'git_branch_list': {
        const firstLine = parsedContent
          .split('\n')
          .map((line: string) => line.trim())
          .find((line: string) => line.length > 0);
        if (firstLine) {
          return short(firstLine.replace(/^\*\s*/, ''));
        }
        return short(parsedSummary || 'branch info');
      }

      // 文件读取
      case 'read':
        return `${short(p)} — ${lineCount} lines read`;

      // 搜索
      case 'search': {
        const pattern = args?.pattern || args?.query || '';
        const reported = /\((\d+)\s*matches?/i.exec(parsedSummary || '');
        if (reported) return `"${short(pattern, 30)}" — ${reported[1]} matches`;
        if (/\(no matches\)/i.test(parsedSummary || '')) {
          return `"${short(pattern, 30)}" — 0 matches`;
        }
        const matches = parsedContent ? (parsedContent.match(/\n/g) || []).length : 0;
        return `"${short(pattern, 30)}" — ${matches} matches`;
      }

      // 文件搜索
      case 'file_search': {
        const pat = args?.pattern || args?.glob || '';
        const found = lineCount;
        return `"${short(pat, 30)}" — ${found} files`;
      }

      // 文件写入/编辑
      case 'write':
        return `${short(p)} ✓`;
      case 'delete_file':
        return `deleted ${short(p)}`;
      case 'rename_file':
        return `renamed → ${short(args?.destination_path || args?.new_path || args?.destination || '')}`;
      case 'create_directory':
        return `created ${short(p || args?.directory || '')}`;

      // 命令执行
      case 'command': {
        const cmd = args?.command || '';
        const firstLine = output.trim().split('\n')[0] || '';
        return `$ ${short(cmd, 40)}${firstLine ? ' → ' + short(firstLine, 40) : ''}`;
      }

      // 代码执行
      case 'code_exec': {
        const firstLine = output.trim().split('\n')[0] || '';
        return firstLine ? short(firstLine, 80) : `executed (${resultLength} chars)`;
      }

      // 网络
      case 'web_search': {
        const query = args?.query || '';
        return parsedSummary || `"${short(query, 40)}" — ${resultLength} chars`;
      }
      case 'web_fetch': {
        const url = args?.url || '';
        return parsedSummary || `${short(url, 50)} (${resultLength} chars)`;
      }

      // 索引/分析
      case 'build_index':
      case 'search_symbol':
      case 'get_definitions':
      case 'get_references':
      case 'analyze_code':
      case 'index_stats':
        return `${resultLength} chars`;

      // 测试/lint
      case 'run_tool': {
        const firstLine = output.trim().split('\n')[0] || '';
        return firstLine ? short(firstLine, 80) : (success ? 'passed' : 'failed');
      }

      // 计划工具
      case 'update_plan':
        return short(parsedMessage || parsedSummary || 'Plan updated', 80);
      case 'verify_step':
        return short(parsedMessage || parsedSummary || 'Step verified', 80);

      case 'select_tools':
      case 'tool_search': {
        const toolCount = (parsedContent.match(/^[a-zA-Z0-9_][\w-]*:\s+/gm) || []).length;
        if (toolCount > 0) {
          return `${toolCount} tools found`;
        }
        return short(parsedMessage || parsedSummary || 'Tools searched', 80);
      }

      default:
        if (parsedSummary) {
          return short(parsedSummary, 80);
        }
        if (parsedMessage) {
          return short(parsedMessage, 80);
        }
        // 通用 fallback：显示输出首行
        if (resultLength > 0) {
          const firstLine = output.trim().split('\n')[0] || '';
          return firstLine ? short(firstLine, 80) : `${resultLength} chars`;
        }
        return undefined;
    }
  }

  private emitEvent(event: AgentRuntimeEvent): void {
    const eventWithMeta = event as AgentRuntimeEvent & { sequence?: number; eventId?: string };
    if (!eventWithMeta.timestamp) {
      eventWithMeta.timestamp = Date.now();
    }
    eventWithMeta.sequence = ++this.eventSequence;
    eventWithMeta.eventId = `${this.session?.sessionId || 'runtime'}:${eventWithMeta.sequence}:${event.type}`;

    if (!this.hostStateMachine.shouldEmit(eventWithMeta)) {
      return;
    }

    if (event.type === 'plan_update') {
      cliLogger.info('EMIT_EVENT', '🔥 Emitting plan_update via eventEmitter', {
        listenerCount: this.eventEmitter.listenerCount('event'),
        hasExplanation: !!event.explanation,
        planSteps: event.plan?.length,
      });
    }
    if (event.type === 'text' && process.env.CLI_DEBUG === '1') {
      const delta = event.delta || '';
      cliLogger.debug('EMIT_EVENT', `Emitting text event: "${delta.substring(0, 20)}...", listeners=${this.eventEmitter.listenerCount('event')}`);
    }
    if (event.type === 'tool_call_start') {
      cliLogger.info('EMIT_EVENT', `🚀 tool_call_start BEFORE emit: listeners=${this.eventEmitter.listenerCount('event')} seq=${eventWithMeta.sequence} name=${event.name} toolId=${event.toolId} batchId=${event.batchId || '-'}`);
    }
    if (event.type === 'file_stream') {
      cliLogger.info('EMIT_EVENT', `📝 file_stream BEFORE emit: listeners=${this.eventEmitter.listenerCount('event')} seq=${eventWithMeta.sequence} filePath=${event.filePath} contentLen=${event.content?.length || 0} isComplete=${event.isComplete}`);
    }
    if (event.type === 'write_file_stream') {
      cliLogger.info('EMIT_EVENT', `💾 write_file_stream BEFORE emit: listeners=${this.eventEmitter.listenerCount('event')} seq=${eventWithMeta.sequence} filePath=${event.filePath} contentLen=${event.content?.length || 0} isComplete=${event.isComplete}`);
    }
    if (event.type === 'tool_call_end') {
      cliLogger.info('EMIT_EVENT', `🔥 tool_call_end BEFORE emit: listeners=${this.eventEmitter.listenerCount('event')} seq=${eventWithMeta.sequence} name=${event.name}`);
      this.trackToolCallForSideAgent(event);
    }
    this.eventEmitter.emit('event', eventWithMeta);
    if (event.type === 'tool_call_end') {
      cliLogger.info('EMIT_EVENT', `✅ tool_call_end AFTER emit: seq=${eventWithMeta.sequence}`);
    }
    if (event.type === 'plan_update') {
      cliLogger.info('EMIT_EVENT', '✅ plan_update emitted');
    }
  }

  private emitLog(level: 'info' | 'warn' | 'error', message: string, detail?: string): void {
    if (process.env.CLI_DEBUG) {
      cliLogger.debug('EMIT', `emitLog: level=${level}, message="${message.substring(0, 50)}..."`);
      cliLogger.debug('EMIT', `  eventEmitter.listenerCount: ${this.eventEmitter.listenerCount('event')}`);
    }
    this.emitEvent({ type: 'log', level, message, detail });
  }

  /* INV-1: write_file streaming 内部 trace 是 infra 诊断, 不能走 emitLog (会变成 stream
   * 事件被 UI 当 timeline 条目渲, 用户看到一堆 [WRITE_CARD] tool_call_start {...} 原 JSON).
   * 改: 默认走 cliLogger.debug 落文件; 只当显式 CLI_DEBUG_WRITE_CARD=1 才进 stream
   * (开发期单独排查 write card 渲染才会开). */
  private emitWriteCardDebug(stage: string, payload: Record<string, any>): void {
    if (process.env.CLI_DEBUG !== '1') {
      return;
    }
    cliLogger.debug('WRITE_CARD', stage, payload);
    if (process.env.CLI_DEBUG_WRITE_CARD === '1') {
      let detail = '';
      try {
        detail = JSON.stringify(payload);
      } catch {
        detail = '[unserializable]';
      }
      this.emitLog('info', `[WRITE_CARD] ${stage}`, detail);
    }
  }

  private trackToolCallForSideAgent(
    event: AgentRuntimeEvent & { type: 'tool_call_end' },
  ): void {
    if (!AgentRuntimeHost.TOOL_BATCH_SUMMARY_ENABLED) return;
    if (!this.sideAgentAdapter?.scheduleToolBatchSummary) return;
    const batchId = event.batchId || event.toolId;
    if (!batchId) return;

    let preview = '';
    if (typeof event.output === 'string') {
      preview = event.output.slice(0, AgentRuntimeHost.TOOL_OUTPUT_PREVIEW_LIMIT);
    } else if (typeof event.summary === 'string') {
      preview = event.summary;
    }

    const call: ToolCallSummaryInput = {
      name: event.name,
      success: event.success,
      args: event.args,
      outputPreview: preview,
      durationMs: event.duration,
    };

    let entry = this.pendingToolBatches.get(batchId);
    if (!entry) {
      entry = { tools: [], timer: null };
      this.pendingToolBatches.set(batchId, entry);
    }
    entry.tools.push(call);

    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.flushToolBatchSummary(batchId), AgentRuntimeHost.TOOL_BATCH_DEBOUNCE_MS);
    entry.timer.unref?.();
  }

  private flushToolBatchSummary(batchId: string): void {
    const entry = this.pendingToolBatches.get(batchId);
    if (!entry) return;
    this.pendingToolBatches.delete(batchId);
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.tools.length === 0) return;

    const adapter = this.sideAgentAdapter;
    if (!adapter?.scheduleToolBatchSummary) return;

    try {
      adapter.scheduleToolBatchSummary({
        batchId,
        sessionId: this.session?.sessionId,
        toolCalls: entry.tools,
        abortSignal: this.sideAgentSignal(),
        emit: (summary) => {
          if (!summary || !summary.trim()) return;
          this.emitEvent({
            type: 'tool_batch_summary',
            sessionId: this.session?.sessionId,
            batchId,
            summary: summary.trim(),
          });
        },
      });
    } catch (err: any) {
      cliLogger.warn('SIDE_AGENT', `scheduleToolBatchSummary threw: ${err?.message}`);
    }
  }

  private flushAllPendingBatches(): void {
    const ids = Array.from(this.pendingToolBatches.keys());
    for (const id of ids) this.flushToolBatchSummary(id);
  }

  private maybeScheduleSessionTitle(userInput: string): void {
    void this.maybeScheduleSessionTitleAsync(userInput);
  }

  private async maybeScheduleSessionTitleAsync(userInput: string): Promise<void> {
    const adapter = this.sideAgentAdapter;
    if (!adapter?.scheduleSessionTitle) return;
    const sessionId = this.session?.sessionId;
    if (!sessionId) return;
    const trimmed = (userInput || '').trim();
    if (!trimmed || isControlPrompt(trimmed)) return;  /* [NEOX_RESUME] 等控制消息不是用户的话 */

    const userMessages = realUserMessages(this.memory.getAll());
    const userCount = userMessages.length;

    /* 首条 —— 老路径 (同步判定, 不读盘: 新会话本来就没有账本) */
    if (userCount <= 1) {
      this.scheduleFirstSessionTitle(trimmed);
      return;
    }
    this.sessionTitleScheduled = true; // 已经不是首条, 首条那条路彻底关掉

    let meta: SessionTitleMeta | null = null;
    try {
      const store = await import('../platform/sessionTitleStore.js');
      meta = await store.readSessionTitleMeta(sessionId);
    } catch { /* 读不到账本按"没聚合过"走 */ }

    /* 用户手改过名 —— 这个会话归他管了 */
    if (meta?.manual) return;

    const aggregatedFrom = meta?.aggregatedFromUserMessages ?? 0;
    if (!shouldReaggregateTitle(userCount, aggregatedFrom)) return;

    /* 素材: 首条 + 最近几条 (中间那些不看 —— 小模型给多了只会抄一句原文) */
    const textOf = (m: { content: unknown }): string =>
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? (m.content as any[]).map((p) => (typeof p?.text === 'string' ? p.text : '')).join(' ')
          : '';
    const first = textOf(userMessages[0] as any).trim() || trimmed;
    const recent = userMessages
      .slice(1)
      .slice(-TITLE_MATERIAL_RECENT_MESSAGES)
      .map((m) => textOf(m as any).replace(/\s+/g, ' ').trim().slice(0, TITLE_MATERIAL_CHARS_PER_MESSAGE))
      .filter(Boolean);
    if (!recent.length) return;

    appendDiagLogHost('SIDE_AGENT_TITLE_REAGGREGATE', {
      sessionId, userCount, aggregatedFrom, material: recent.length + 1,
    });

    try {
      adapter.scheduleSessionTitle({
        sessionId,
        firstUserMessage: first,
        recentUserMessages: recent,
        aggregatedFromUserMessages: userCount,
        expectedCurrentTitle: meta?.title,
        abortSignal: this.sideAgentSignal(),
        emit: (title) => {
          if (!title || !title.trim()) return;
          this.emitEvent({ type: 'session_title_generated', sessionId, title: title.trim() });
        },
      });
    } catch (err: any) {
      cliLogger.warn('SIDE_AGENT', `scheduleSessionTitle(reaggregate) threw: ${err?.message}`);
    }
  }

  private scheduleFirstSessionTitle(userInput: string): void {
    const existingUserCountForDiag = this.memory.getAll().filter((m) => m.role === 'user').length;
    appendDiagLogHost('SIDE_AGENT_TITLE_GUARD', {
      alreadyScheduled: this.sessionTitleScheduled,
      hasAdapter: !!this.sideAgentAdapter?.scheduleSessionTitle,
      sessionId: this.session?.sessionId ?? null,
      inputLen: (userInput || '').trim().length,
      existingUserCount: existingUserCountForDiag,
    });
    if (this.sessionTitleScheduled) return;
    const adapter = this.sideAgentAdapter;
    if (!adapter?.scheduleSessionTitle) return;
    const sessionId = this.session?.sessionId;
    if (!sessionId) return;
    const trimmed = (userInput || '').trim();
    if (!trimmed) return;

    const existingUserCount = this.memory.getAll().filter((m) => m.role === 'user').length;
    if (existingUserCount > 1) {
      this.sessionTitleScheduled = true; // 已经不是首条,不会再触发
      return;
    }

    this.sessionTitleScheduled = true;
    try {
      adapter.scheduleSessionTitle({
        sessionId,
        firstUserMessage: trimmed,
        aggregatedFromUserMessages: 1,
        abortSignal: this.sideAgentSignal(),
        emit: (title) => {
          if (!title || !title.trim()) return;
          this.emitEvent({
            type: 'session_title_generated',
            sessionId,
            title: title.trim(),
          });
        },
      });
    } catch (err: any) {
      cliLogger.warn('SIDE_AGENT', `scheduleSessionTitle threw: ${err?.message}`);
    }
  }

  private emitCompacting(message: string, detail?: string): void {
    if (process.env.CLI_DEBUG) {
      cliLogger.debug('EMIT', `emitCompacting: message="${message.substring(0, 50)}..."`);
    }
    this.emitEvent({ type: 'compacting', message, detail });
  }

  injectUserMessage(
    text: string,
    images?: Array<{ mediaType: string; data: string; name?: string }>
  ): number {
    if (!this.isRunning || this.shouldInterrupt || this.abortController?.signal.aborted) {
      cliLogger.warn('INJECT', `拒绝注入: 当前没有任务在跑, 消息未入队 (${text.slice(0, 40)})`);
      return 0;
    }

    this.pendingInjectedMessages.push({
      text,
      timestamp: new Date(),
      images,
    });

    const position = this.pendingInjectedMessages.length;

    cliLogger.info('INJECT', `📨 Message queued at position ${position}: "${text.substring(0, 50)}..."`);

    this.emitEvent({ type: 'queued_message_added', position, text });


    return position;
  }

  requestSteeringInterrupt(): boolean {
    if (!this.isRunning) return false;
    return this.runner?.requestSteeringInterrupt?.() ?? false;
  }

  /** run() 是否在进行中 —— 排查"排队插话没排上"用, 只读不改状态 */
  isTaskRunning(): boolean {
    return this.isRunning;
  }

  hasPendingInjectedMessages(): boolean {
    return this.pendingInjectedMessages.length > 0;
  }

  getPendingMessagesForDisplay(): Array<{
    text: string;
    timestamp: Date;
    images?: Array<{ mediaType: string; data: string; name?: string }>;
  }> {
    return [...this.pendingInjectedMessages];
  }

  getAndClearPendingMessages(): Array<{
    text: string;
    timestamp: Date;
    images?: Array<{ mediaType: string; data: string; name?: string }>;
  }> {
    const messages = [...this.pendingInjectedMessages];
    this.pendingInjectedMessages = [];
    return messages;
  }

  /**
   * 弹出最后一条排队消息 (用户按 ↑ 把它拉回输入框编辑/撤回)。
   *   返回被弹出消息的文本 (队列为空返回 null)。发 queued_message_removed 事件让各端同步队列条。
   */
  removeLastPendingMessage(): string | null {
    if (this.pendingInjectedMessages.length === 0) return null;
    const last = this.pendingInjectedMessages.pop()!;
    cliLogger.info('INJECT', `↩ 撤回排队消息 (剩 ${this.pendingInjectedMessages.length}): "${last.text.substring(0, 40)}"`);
    this.emitEvent({
      type: 'queued_message_removed', remaining: this.pendingInjectedMessages.length,
      text: last.text, images: last.images, reason: 'cancelled',
    });
    return last.text;
  }

  private processPendingInjectedMessages(): number {
    if (this.pendingInjectedMessages.length === 0) {
      return 0;
    }

    const messages = [...this.pendingInjectedMessages];
    this.pendingInjectedMessages = [];

    if (process.env.CLI_DEBUG) {
      cliLogger.debug('INJECT', `Processing ${messages.length} injected messages`);
    }

    for (const msg of messages) {
      this.memory.add(buildInjectedUserMessage(msg.text, msg.images));

      // 排队消息此刻才真正进对话 → 通知 UI 此时把它渲染进 timeline (入队时只在队列条 pending)。
      if (msg.text) {
        this.emitEvent({ type: 'user_message_injected', text: msg.text });
      }
    }

    return messages.length;
  }


  updateRuntime(options: {
    runner: StreamedRunner;
    memory: ShortTermMemory;
    model: string;
    systemPrompt?: string;
  }): void {
    this.runner = options.runner;
    this.runner.onHistoryCompacted = (info) => this.onRunnerHistoryCompacted(info);
    this.memory = options.memory;
    this.model = options.model;
    if (options.systemPrompt) {
      this.systemPrompt = options.systemPrompt;
    }
  }

  private onRunnerHistoryCompacted(info?: { evictedReadPaths?: string[] }): void {
    const paths = info?.evictedReadPaths;
    if (paths && paths.length > 0) {
      for (const p of paths) {
        try {
          invalidateReads(path.isAbsolute(p) ? p : path.resolve(this.workDir || process.cwd(), p));
        } catch { /* 单个路径失败不该阻断同步 */ }
      }
      cliLogger.debug('COMPACT', `作废 ${paths.length} 个文件的读证据 (内容已被压缩挤出上下文)`);
    }
    this.syncCompactedMemoryToSessionContext();
  }

  private syncCompactedMemoryToSessionContext(): void {
    const sid = this.session?.sessionId;
    if (!sid || !this.sessionEnabled) return;
    const sourceCount = SessionContext.get(sid).size;
    const compacted = this.memory.getAll()
      .filter((m) => m.role !== 'system' || isCompactionSummaryMessage(m))
      .map((m) => ({
        role: m.role as PersistedMessage['role'],
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
        raw: m,
      }));
    SessionContext.get(sid).appendCompaction(compacted, { sourceCount });
    /* 游标必须下调到压缩后的长度 —— flushPersist 是 `currentLen <= baseline 就 return` 的纯增量,
     * 不重置的话新消息要等 memory 长回压缩前的长度才落库 (append 化不改变这一点)。 */
    this.lastPersistedMemoryLen = this.memory.getAll().length;
  }

  refreshInstructions(
    systemPrompt: string,
    options?: { forceMemorySystemPrompt?: boolean },
  ): void {
    if (!systemPrompt) return;

    // 更新 Host 自身的 systemPrompt
    this.systemPrompt = systemPrompt;

    // 更新 Runner 的 instructions（下次 hasSystemPrompt=false 时会用最新值注入）
    this.runner.updateInstructions(systemPrompt);

    if (options?.forceMemorySystemPrompt) {
      this.replaceMemorySystemPrompt(systemPrompt);
      this.sessionSync?.updateSystemPrompt(systemPrompt);
      return;
    }

    // 防御性检查：如果 memory 中完全没有 system message，说明被 compact/clear 清掉了
    // 此时需要立即补回，否则 LLM 完全没有身份/指令上下文
    const messages = this.memory.getMessagesForLLM();
    // 摘要虽是 system role 但不是身份 prompt — 只剩摘要时仍要补注入真正的 system prompt
    const hasSystemMsg = messages.some(m => m.role === 'system' && !isCompactionSummaryMessage(m));
    if (!hasSystemMsg && messages.length > 0) {
      // memory 有对话历史但没有 system message → 用 add 补回（add 会在 trim 时保留 system 消息）
      cliLogger.warn('REFRESH', '⚠️ System prompt missing from memory (lost after compact/clear), re-injecting');
      this.memory.add({
        role: 'system',
        content: systemPrompt,
      });
    }
  }

  private replaceMemorySystemPrompt(systemPrompt: string): void {
    const messages = this.memory.getAll();
    const previousSystemCount = messages.filter(m => m.role === 'system').length;
    // 压缩摘要虽是 system role, 但它是被压掉历史的唯一载体, 换 prompt 时必须留下 (原位)
    const nonSystemMessages = messages.filter(m => m.role !== 'system' || isCompactionSummaryMessage(m));

    this.memory.setMessages([
      { role: 'system', content: systemPrompt },
      ...nonSystemMessages,
    ]);

    // setMessages 不触发 onMessageAdded；这里手动对齐增量持久化游标，避免下轮把历史重复落库。
    this.lastPersistedMemoryLen = this.memory.getAll().length;

    cliLogger.warn('REFRESH', 'System prompt force-refreshed in memory', {
      model: this.model,
      previousSystemCount,
      nonSystemMessages: nonSystemMessages.length,
      systemPromptChars: systemPrompt.length,
    });
  }

  setCompressionMode(mode: 'sync' | 'async'): void {
    this.compressionMode = mode;
    this.runner?.setCompressionMode?.(mode);
    cliLogger.info('RUNTIME', `Compression mode set to: ${mode}`);
  }

  /** 设置压缩触发阈值 (0..1)。传 undefined 恢复默认公式。 */
  setCompressionThreshold(ratio?: number): void {
    this.runner?.setCompressionThreshold?.(ratio);
    cliLogger.info('RUNTIME', `Compression threshold set to: ${ratio ?? 'default'}`);
  }

  /** 设置是否启用自动压缩。 */
  setAutoCompressEnabled(enabled: boolean): void {
    this.runner?.setAutoCompressEnabled?.(enabled);
    cliLogger.info('RUNTIME', `Auto compress ${enabled ? 'enabled' : 'disabled'}`);
  }

  getCompressionMode(): 'sync' | 'async' {
    return this.compressionMode;
  }

  /**
   * 为用户的输入加上prompt 的限定mode 提示词（不包含图片 - 图片单独作为多模态内容处理）
   *
   * 主要功能：
   * 1. 处理 URL 类型的附件：将其格式化后添加到输入文本前面
   * 2. 根据交互模式添加相应的指令提示
   */
  private prepareTaskInput(userInput: string, metadata?: RuntimeMetadata): string {
    return prepareTaskInputText(userInput, metadata);
  }

  private async extractImageUrls(metadata?: RuntimeMetadata): Promise<string[]> {
    if (!metadata?.attachments?.length) {
      return [];
    }
    const raw = metadata.attachments
      .filter(att => att.type === 'image' && att.data)
      .map(att => att.data as string);
    if (raw.length === 0) return [];

    let savedBytes = 0;
    let compressedCount = 0;
    const out = await Promise.all(raw.map(async (url) => {
      const r = await compressImageDataUrlIfNeeded(url);
      if (r.compressed) {
        compressedCount += 1;
        savedBytes += r.originalBytes - r.compressedBytes;
      }
      return r.url;
    }));
    if (compressedCount > 0) {
      cliLogger.info('RUNTIME_HOST',
        `[IMG_COMPRESS] compressed ${compressedCount}/${raw.length} attachment image(s), saved ~${(savedBytes / 1024 / 1024).toFixed(2)}MB on input`);
    }
    writeStallFile('info', 'IMG', 'attachment images processed', {
      sessionId: this.session?.sessionId,
      total: raw.length, compressed: compressedCount, savedMB: +(savedBytes / 1024 / 1024).toFixed(2),
    });
    return out;
  }

  /**
   * Extract document texts from attachments (PDF/Word/Excel/CSV/PPT → markdown).
   *
   * 客户端通过 NeoxCloud /api/v1/document/parse 把文档解析成 markdown,
   * 然后 type='file' + data 非空的 attachment 就是文档内容. 这里把它们拼成
   * user message 的 text 后缀, 让 LLM 能看到文档. 跟 extractImageUrls (走
   * image_url multimodal block) 不同, 文档走 text 通道, 任何 LLM 都能吃.
   *
   * 拼接格式: 加 markdown fence + 文件名 header, 让 LLM 清晰区分"用户问题"
   * vs "附件内容". 同 Claude/OpenAI 的 attachment 渲染惯例.
   */
  private extractDocumentTexts(metadata?: RuntimeMetadata): Array<{ name: string; text: string }> {
    if (!metadata?.attachments?.length) {
      return [];
    }
    return metadata.attachments
      .filter(att => att.type === 'file' && typeof att.data === 'string' && att.data.length > 0)
      .map(att => ({
        name: att.name || 'document',
        text: att.data,
      }));
  }

  private async handleMemorySnapshot(snapshot?: MemoryPressureSnapshot | null, skipCompaction = false): Promise<void> {
    if (!snapshot) {
      return;
    }

    //
    // 设计原则：
    //   1. promptTokens（API 实际返回）= 唯一权威来源
    //   2. system + messages + tools MUST === promptTokens（严格对齐，零误差）
    //   3. calculateTokenBreakdown(messages) 只用于计算各类别的**比例**
    //   4. API prompt_tokens 包含 messages + tool definitions（tools API parameter）
    //   5. messages 中的 tool_calls + role:'tool' 属于 toolTokens
    //
    // 计算方法：
    //   - 估算各类别的粗略 token 数 → 计算比例
    //   - 用 promptTokens 乘以比例 → 严格对齐
    //   - tool definitions 开销（tools API parameter）归入 toolTokens
    let breakdown: ContextTokenBreakdown | undefined;
    try {
      const messages = this.memory.getMessagesForLLM();
      if (messages.length > 0) {
        const bd = calculateTokenBreakdown(messages);
        const rawSystem = bd.systemTokens;
        const rawMessages = bd.userTokens + bd.assistantTokens;
        const rawTools = bd.toolCallTokens + bd.toolResultTokens;
        const rawTotal = rawSystem + rawMessages + rawTools;

        // promptTokens = API 实际 prompt_tokens（包含 messages + tool definitions）
        // 如果没有 API 实际值，promptTokens 是估算值
        const authoritative = snapshot.promptTokens || snapshot.tokensUsed;

        const createBreakdown = (toolDefinitionTokens = 0): ContextTokenBreakdown => ({
          systemTokens: rawSystem,
          messageTokens: rawMessages,
          toolTokens: rawTools + toolDefinitionTokens,
          details: {
            systemPromptTokens: rawSystem,
            hiddenInstructionsTokens: 0,
            agentPrefixTokens: 0,
            userTextTokens: bd.userTokens,
            assistantTextTokens: bd.assistantTokens,
            attachmentTextTokens: 0,
            imageDescriptionTokens: 0,
            fileDescriptionTokens: 0,
            toolDefinitionsTokens: toolDefinitionTokens,
            toolCallTokens: bd.toolCallTokens,
            toolResultTokens: bd.toolResultTokens,
          },
        });

        if (authoritative > 0 && rawTotal > 0) {
          // 情况 1: authoritative > rawTotal → 差值 = tool definitions（API tools parameter 开销）
          // 情况 2: authoritative < rawTotal → 估算偏高，按比例缩放
          // 情况 3: authoritative === rawTotal → 1:1 对齐

          if (authoritative >= rawTotal) {
            // Tool definitions 开销 = authoritative - rawTotal
            // messages 部分用估算值（已经是准确的比例）
            const toolDefinitionOverhead = authoritative - rawTotal;
            if (snapshot.promptTokensIsActual) {
              this.sessionMinFixedOverhead = Math.min(
                this.sessionMinFixedOverhead ?? Number.POSITIVE_INFINITY,
                toolDefinitionOverhead,
              );
            }
            // 验证: systemTokens + messageTokens + toolTokens === authoritative ✓
            breakdown = createBreakdown(toolDefinitionOverhead);
          } else {
            // 估算偏高 → 按比例缩放到 authoritative
            breakdown = normalizeContextBreakdown(createBreakdown(), authoritative);
          }
        } else if (rawTotal > 0) {
          // 无 API 数据，纯估算（标记为非权威）
          breakdown = createBreakdown();
        }
      }
    } catch (err: any) { cliLogger.debug('AGENT_HOST', `Non-critical breakdown: ${err?.message}`); }

    this.emitEvent({ type: 'memory_snapshot', snapshot, breakdown });
    await this.maybeAnnounceMemoryPressure(snapshot, skipCompaction);
  }

  private async maybeAnnounceMemoryPressure(snapshot: MemoryPressureSnapshot, skipCompaction = false): Promise<void> {
    if (!snapshot.profile.contextWindow) {
      this.lastMemoryPressureState = snapshot.state;
      return;
    }

    const severityRank: Record<MemoryPressureState, number> = {
      unknown: 0,
      normal: 1,
      warn: 2,
      soft_limit: 3,
      limit: 4,
    };

    const previousRank = severityRank[this.lastMemoryPressureState] ?? 0;
    const nextRank = severityRank[snapshot.state] ?? 0;
    const percent = snapshot.pressure !== undefined ? Math.round(snapshot.pressure * 100) : undefined;
    const summary = `${snapshot.tokensUsed.toLocaleString()} / ${snapshot.profile.contextWindow.toLocaleString()} tokens`;

    const autoCompactionWillHandleIt = !skipCompaction && this.shouldScheduleAutoCompaction(snapshot.state);
    if (nextRank > previousRank && snapshot.state !== 'normal' && snapshot.state !== 'unknown') {
      cliLogger.warn('CONTEXT', `memory pressure → ${snapshot.state} (${percent ?? '?'}%, ${summary})`);
      if (snapshot.state === 'limit' && !autoCompactionWillHandleIt) {
        /* 自动压缩这条路真的不通(会话未接入/被显式跳过)才提示人工介入 —— 能自动压的时候
         * 说"必须执行 /compact 才能继续"是假话: 下一拍压缩就跑了, 用户什么都不用做。 */
        this.emitLog(
          'warn',
          percent !== undefined ? `上下文已满 ${percent}% (${summary})` : `上下文已满 (${summary})`,
          '自动压缩在本会话不可用，请执行 /compact 或 /new 继续。',
        );
      }
    }

    this.lastMemoryPressureState = snapshot.state;

    if (skipCompaction) {
      return;
    }

    // This makes compaction part of the task flow, not a separate cleanup step
    if (this.shouldScheduleAutoCompaction(snapshot.state)) {
      await this.runPendingAutoCompactionIfIdle();
    }
  }

  private shouldScheduleAutoCompaction(state: MemoryPressureState): boolean {
    if (!this.sessionEnabled) {
      return false;
    }
    // This allows earlier compaction based on user-configured thresholds
    return state === 'warn' || state === 'soft_limit' || state === 'limit';
  }


  private async runPendingAutoCompactionIfIdle(): Promise<void> {
    if (
      !this.sessionSync ||
      !this.compatProfile ||
      !this.memoryPressure ||
      this.autoCompactionInProgress
      // This enables mid-task compaction to prevent context overflow
    ) {
      return;
    }

    const currentMessages = this.sessionSync.getMemory().getMessagesForLLM();
    const snapshot = this.memoryPressure.setPromptEstimateFromMessages(currentMessages);
    const preTimeline = await this.sessionSync.getSession().getTimeline();
    const preMessageCount = preTimeline.filter((entry) => entry.item.type === 'message').length;
    const preBreakdown = calculateTokenBreakdown(this.sessionSync.getMemory().getAll());
    const preAuthoritativeTokens = Math.max(
      preBreakdown.totalTokens,
      snapshot.promptTokens || snapshot.tokensUsed || 0,
    );
    const preIncompressibleOverhead = Math.max(0, preAuthoritativeTokens - preBreakdown.totalTokens);

    this.autoCompactionInProgress = true;

    try {
      const session = this.sessionSync.getSession();

      let beforeContextInfo = '';
      if (snapshot.profile.contextWindow) {
        const usedPercent = Math.round((snapshot.tokensUsed / snapshot.profile.contextWindow) * 100);
        const usedK = Math.round(snapshot.tokensUsed / 1000);
        const totalK = Math.round(snapshot.profile.contextWindow / 1000);
        beforeContextInfo = `${usedK}K / ${totalK}K tokens (${usedPercent}%)`;
      }

      // 如果有 LLM provider，使用智能压缩；否则回退到轻量级压缩
      if (this.llmProvider) {
        this.emitCompacting('⚡ 正在压缩历史', `当前上下文: ${beforeContextInfo}`);
        this.emitEvent({ type: 'status', status: 'compacting', message: '⚡ Auto-compacting history...' });

        const compactor = (this.runner as any)?.compactNow as
          | ((trigger: 'auto' | 'recovery', onProgress?: (p: any) => void) => Promise<any>)
          | undefined;
        if (!compactor) {
          cliLogger.warn('COMPACT', 'runner.compactNow unavailable — skip auto compaction');
          return;
        }
        const result = await compactor.call(this.runner, 'auto', (p: any) => {
          if (p?.phase === 'categorizing') {
            this.emitCompacting('◆ 分析中', '按类别分组对话历史…');
          } else if (p?.phase === 'compressing' && p.totalBuckets) {
            this.emitCompacting(
              `⚡ AI 摘要中 ${p.completedBuckets}/${p.totalBuckets} 组`,
              p.summaryModel ? `model ${p.summaryModel}` : undefined,
            );
            /* 同手动路径: 桶级进度实时进时间线卡片, 见 compactSession 处注释 */
            this.emitEvent({
              type: 'context_compaction',
              status: 'compressing',
              originalTokens: preAuthoritativeTokens,
              budgetTokens: snapshot.profile.contextWindow || 0,
              useLLM: true,
              timestamp: Date.now(),
              tokensIncludeOverhead: true,
              compression: {
                phase: p.phase,
                totalBuckets: p.totalBuckets,
                completedBuckets: p.completedBuckets ?? 0,
                buckets: p.buckets ?? [],
                summaryModel: p.summaryModel,
              },
            } as any);
          } else if (p?.phase === 'done') {
            this.emitCompacting('▸ 保存中', '');
          }
        });

        if (!result) {
          dumpCompactionQualityIfEnabled({
            kind: 'auto_session_compaction_noop',
            source: 'agentRuntimeHost',
            trigger: 'auto',
            strategy: 'kernel-unified',
            sessionId: this.session?.sessionId,
            model: this.model,
            contextWindow: snapshot.profile.contextWindow,
            before: {
              realTokens: preAuthoritativeTokens,
              memoryEstimatedTokens: preBreakdown.totalTokens,
              messageCount: preMessageCount,
            },
            reason: 'compactNow returned null (below threshold / breaker / lock)',
          });
          this.emitCompacting('ℹ️ 无需压缩', '当前上下文在预算内或压缩暂不可行');
          this.emitEvent({ type: 'status', status: 'info', message: 'No compaction needed' });
          return;
        }

        /* 结果数字虽同尺 (kernel 对同一份 messages 前后的估算), 但那是【裸估算】——
         * 不含 tool definitions / 未注入 system prompt, 对代码/中文低估 39~43%。
         * 卡片必须锚到实报口径 (跟表盘同源), 同手动压缩路径的 realBefore 手法:
         * before = max(估算, API 实报), 压不到的开销 = 差额, after = 压后估算 + 该开销。 */
        const useLLM = (result.stats?.llmCompressedMessages ?? 0) > 0;
        /* 同手动路径: 比例校准 + 真底座下界, 见 estimatePostCompactContext 注释 */
        const postCompactTokens = estimatePostCompactContext({
          postEstimate: calculateTokenBreakdown(this.memory.getAll()).totalTokens,
          preEstimate: preBreakdown.totalTokens,
          realBefore: preAuthoritativeTokens,
          additiveOverhead: preIncompressibleOverhead,
          fixedBase: this.sessionMinFixedOverhead,
        });
        const rolledBack = (result.savedTokens ?? 0) <= 0;
        const reportedFinal = rolledBack
          ? preAuthoritativeTokens
          : Math.min(postCompactTokens, preAuthoritativeTokens);

        this.emitEvent({
          type: 'context_compaction',
          status: 'completed',
          originalMessages: result.originalCount,
          keptMessages: result.compressedCount,
          droppedMessages: result.stats?.droppedMessages ?? 0,
          compressedMessages: result.stats?.llmCompressedMessages ?? 0,
          originalTokens: preAuthoritativeTokens,
          finalTokens: reportedFinal,
          tokensIncludeOverhead: true,
          budgetTokens: snapshot.profile.contextWindow || 0,
          useLLM,
          timestamp: Date.now(),
        });
        const savedK = (Math.max(0, preAuthoritativeTokens - reportedFinal) / 1000).toFixed(1);
        this.emitCompacting(
          rolledBack ? 'ℹ️ 压缩未获收益' : '✓ 压缩完成',
          rolledBack
            /* 回退时不报两个数 —— 报 "100K → 100K" 只会让人以为压了个空 */
            ? `已保留原上下文 (${(preAuthoritativeTokens / 1000).toFixed(1)}K tokens)`
            : `${(preAuthoritativeTokens / 1000).toFixed(1)}K → ${(reportedFinal / 1000).toFixed(1)}K tokens (释放 ${savedK}K)`,
        );

        if (this.memoryPressure) {
          this.memoryPressure.reset();
          const updatedSnapshot = this.memoryPressure.setPromptEstimateFromMessages(this.memory.getMessagesForLLM());
          void this.handleMemorySnapshot(updatedSnapshot, true); // skipCompaction: 防递归
        }

        dumpCompactionQualityIfEnabled({
          kind: 'auto_session_compaction_completed',
          source: 'agentRuntimeHost',
          trigger: 'auto',
          strategy: 'kernel-unified',
          sessionId: this.session?.sessionId,
          model: this.model,
          contextWindow: snapshot.profile.contextWindow,
          before: { memoryEstimatedTokens: result.originalTokens, messageCount: result.originalCount },
          after: { memoryEstimatedTokens: result.compressedTokens, messageCount: result.compressedCount, savedTokens: result.savedTokens },
        });
      } else {
        cliLogger.warn('COMPACT', '没有可用的摘要模型 — 跳过压缩 (不做机械压缩)');
        this.emitCompacting(
          'ℹ️ 无法压缩上下文',
          '没有可用的摘要模型。压缩需要一个能写摘要的模型 —— 在「API 服务商」里配一个, 或切到订阅模型。',
        );
        this.emitEvent({ type: 'status', status: 'info', message: 'No summary model — compaction skipped' });
      }
    } catch (error: any) {
      const errorMsg = error?.message || String(error);
      dumpCompactionQualityIfEnabled({
        kind: 'auto_session_compaction_failed',
        source: 'agentRuntimeHost',
        trigger: 'auto',
        sessionId: this.session?.sessionId,
        model: this.model,
        contextWindow: snapshot.profile.contextWindow,
        before: {
          realTokens: preAuthoritativeTokens,
          memoryEstimatedTokens: preBreakdown.totalTokens,
          incompressibleOverhead: preIncompressibleOverhead,
          snapshotPromptTokens: snapshot.promptTokens,
          snapshotTokensUsed: snapshot.tokensUsed,
          pressure: snapshot.pressure,
          state: snapshot.state,
          messageCount: preMessageCount,
          breakdown: preBreakdown,
        },
        error: errorMsg,
      });
      this.emitLog('error', '自动压缩失败', `错误详情: ${errorMsg}`);

      if (process.env.CLI_DEBUG === '1') {
        cliLogger.error('[COMPACTION] Failed:', error);
      }
    } finally {
      this.autoCompactionInProgress = false;
    }
  }

  public async runTask(userInput: string, options?: RunTaskOptions): Promise<RunTaskResult> {
    const isContinuation = options?.metadata?.continuation === true;

    /** 定位日志 **/
    if (process.env.CLI_DEBUG === '1') {
      cliLogger.debug('TASK', '========================================');
      cliLogger.debug('TASK', '=== runTask ENTRY ===');
      cliLogger.debug('TASK', `  userInput: "${userInput?.substring(0, 50)}..."`);
      cliLogger.debug('TASK', `  isRunning: ${this.isRunning}`);
      cliLogger.debug('TASK', `  shouldInterrupt: ${this.shouldInterrupt}`);
      cliLogger.debug('TASK', `  stdin.isPaused: ${process.stdin.isPaused?.()}`);
      cliLogger.debug('TASK', `  stdin.destroyed: ${process.stdin.destroyed}`);
    }

    /** 同步工作空间 目录环境 URL**/
    this.syncWorkspaceEnv();

    /* UserPromptSubmit —— 模型还没看到这句话之前 (语义见 runtimeHooks.ts) */
    const submitted = isContinuation
      ? { blocked: false, prompt: userInput, reason: '' }
      : await applyUserPromptSubmit(userInput, this.session?.sessionId);
    if (submitted.blocked) {
      this.emitEvent({ type: 'status', status: 'error', message: submitted.reason });
      return { output: submitted.reason, totalTokens: 0, durationMs: 0,
               iterations: 0, toolCalls: 0, interrupted: false, failed: true };
    }
    userInput = submitted.prompt;

    /** 确保用户重新打开 session 时携带之前的对话上下文 */
    if (this.sessionEnabled && !this.sessionSync) {
      try {
        // 使用 sessionId（如果有）来关联 JSONL 文件
        // AgentRuntimeHost 通常通过 hostController 的 sessionId 来标识
        const hostSessionId = this.session?.sessionId || `auto_${Date.now()}`;
        await this.ensureSessionSync(hostSessionId);
      } catch (error: any) {
        cliLogger.warn('TASK', `Session init failed (non-blocking): ${error.message}`);
      }
    }

    if (this.sessionEnabled && this.sessionSync) {
      try {
        const memNonSystem = this.memory.getAll().filter((m) => m.role !== 'system').length;
        if (memNonSystem === 0) {
          const items = await this.sessionSync.getSession().getMessages();
          if (items.length > 0) {
            cliLogger.info('TASK', `🩹 Memory empty but session has ${items.length} messages — auto-reloading`);
            this.persistSuspended = true;
            try {
              await this.sessionSync.loadHistory();
            } finally {
              this.persistSuspended = false;
              this.lastPersistedMemoryLen = this.memory.getAll().length;
            }
            this.restoreReadLedger('selfHealReload');
          }
        }
      } catch (error: any) {
        cliLogger.warn('TASK', `Self-heal reload failed (non-blocking): ${error.message}`);
      }
    }

    if (!this.readLedgerRestored) {
      const memNonSystemNow = this.memory.getAll().filter((m: any) => m.role !== 'system').length;
      if (memNonSystemNow > 0 && readLedgerFileCount() === 0) {
        this.readLedgerRestored = true;
        this.restoreReadLedger('runTaskFallback');
      } else if (memNonSystemNow > 0) {
        /* 账本非空 = 本进程内已经读过东西, 不是恢复场景, 别白跑 */
        this.readLedgerRestored = true;
      }
    }

    /** 校验用户输入 非空 **/
    if (isContinuation) {
      const history = this.memory.getAll();
      if (!history.some(message => message.role !== 'system')) {
        throw new Error('Cannot recover: no conversation history for this session');
      }
      userInput = getLastUserTask(history) ?? '';
    }
    if (!userInput.trim() && !isContinuation) {
      throw new Error('Input is required');
    }

    /** 初始化变量 **/
    this.shouldInterrupt = false;
    /* 上一轮是被谁掐的跟这一轮无关 —— 不清会把旧原因贴到新一轮的收尾上 */
    this.interruptReason = null;
    this.isRunning = true;

    /** 创建中断信号接收 运行signal发出中断信号 开始中断cli的runner **/
    this.abortController = new AbortController();

    let offBudgetFuse: (() => void) | null = null;
    try {
      const costTracker = getGlobalCostTracker();
      if (costTracker.isBudgetExceeded() && costTracker.getBudgetAction() !== 'warn') {
        /* 上一轮已超预算 → 新 run 直接拒绝启动, 而不是烧完一轮才停 */
        this.emitLog('error', `Session cost budget exceeded — run blocked (action=${costTracker.getBudgetAction()}). Raise the budget in settings to continue.`);
        this.shouldInterrupt = true;
        this.abortController.abort();
      } else {
        offBudgetFuse = costTracker.onCostEvent((evt) => {
          if (evt.type !== 'budget_exceeded') return;
          if (costTracker.getBudgetAction() === 'warn') return;
          this.emitLog('error', evt.message
            ? `Budget fuse tripped: ${evt.message} — stopping agent run.`
            : 'Budget fuse tripped: session cost exceeded budget — stopping agent run.');
          this.shouldInterrupt = true;
          this.abortController?.abort();
          this.interruptResolver?.();
        });
      }
    } catch { /* costTracker 不可用 (纯 kernel 环境) → 保险丝静默不挂 */ }

    if (options?.abortSignal) {
      const externalSignal = options.abortSignal;
      const captureReason = () => {
        const reason = (externalSignal as { reason?: unknown }).reason;
        const msg = reason instanceof Error ? reason.message : (typeof reason === 'string' ? reason : '');
        if (msg) this.interruptReason = msg;
      };
      if (externalSignal.aborted) {
        // 已经被中断了
        captureReason();
        this.shouldInterrupt = true;
        this.abortController.abort();
      } else {
        // 监听外部中断信号
        const onExternalAbort = () => {
          captureReason();
          this.shouldInterrupt = true;
          this.abortController?.abort();
          // 事件循环用 Promise.race([iterator.next(), interruptPromise]) 检测中断
          // 如果不 resolve，只能等 iterator.next() 完成（可能正在执行耗时工具）
          if (this.interruptResolver) {
            this.interruptResolver();
          }
        };
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }

    // Mode override: ASK should be enforced per-request (read-only)
    const requestedMode = options?.metadata?.mode;
    const previousMode = this.runner.getMode();
    const shouldOverrideMode = requestedMode === 'ask' && previousMode !== AgentMode.ASK;
    if (shouldOverrideMode) {
      this.runner.setMode(AgentMode.ASK);
    }

    /** Side-query: 首条 user message 后异步生成会话标题 (fire-and-forget) */
    if (!isContinuation) this.maybeScheduleSessionTitle(userInput);

    /** 处理用户输入 增强提示词！ 和附带的附件等 **/
    /* run-end drain 续跑时会换成排队插话文本, 故用 let */
    let taskInput = isContinuation ? userInput : this.prepareTaskInput(userInput, options?.metadata);

    /* server chat() 入口已经把这条 user prompt 落过库了 (见 server/main.ts 的 CHAT_USER_MSG),
     * 记下注入版原文, flushPersist 遇到它就跳, 免得同一轮 prompt 在 messages 表里存两份。 */
    this.entryUserPromptPersistedElsewhere =
      !isContinuation && options?.metadata?.entryUserMessagePersisted === true ? taskInput : null;

    /** 特别处理图片输入(入口压缩超大截图) **/
    const imageUrls = isContinuation ? [] : await this.extractImageUrls(options?.metadata);

    /** 获取当前的meta数据 附件 图片等 **/
    this.currentTaskMetadata = options?.metadata;

    const SYSTEM_INJECTED_TURN = /^\s*<(agent-completion|background-task|background_task|scheduled-wakeup|wakeup|system-)/i;
    const isSystemInjectedTurn = typeof userInput === 'string' && SYSTEM_INJECTED_TURN.test(userInput);
    if (this.sessionSync && this.sessionEnabled && !isSystemInjectedTurn && !isContinuation) {
      /** 获取当前 会话顺序 +1 **/
      const turnNumber = this.sessionSync.getTurnCount() + 1;
      /** 创建checkpoint 用于回滚 — 后台跑, 不 await **/
      void this.sessionSync.createCheckpoint(`turn_${turnNumber}`)
        .then((checkpointId) => {
          this.emitEvent({ type: 'checkpoint', id: checkpointId, auto: true });
        })
        .catch((error) => {
          cliLogger.error('TASK', '检查点创建失败 (不阻塞 turn)', error);
          console.error('Failed to create auto checkpoint (non-blocking)', error);
        });
    }

    /** 发送事件 进行渲染UI的是status的bar 显示thinking！ **/
    this.emitEvent({ type: 'status', status: 'thinking', message: 'Starting...' });

    // 基于当前 memory 中所有消息估算 token 数，让 UI 立即显示准确的上下文使用量
    if (this.memoryPressure) {
      const currentMessages = this.memory.getMessagesForLLM();
      const snapshot = this.memoryPressure.setPromptEstimateFromMessages(currentMessages);
      void this.handleMemorySnapshot(snapshot, true); // skipCompaction: 还没开始执行
    }

    /** 各种的 单次loop 的指标 **/
    const startTime = Date.now();
    let fullResponse = '';
    let currentIteration = 0;
    let toolCallCount = 0;
    let totalTokens = 0;
    let lastAssistantMessage = '';
    let currentTurnText = '';
    let accumulatedArgs = '';
    let currentToolName = '';
    let currentToolId = '';
    let accumulatedArgsLength = 0;
    let lastWritePreviewEmitAt = 0;
    let lastWritePreviewArgChars = 0;
    // phase='init' 只发一次 (拿到 file_path+start_line+end_line 后从磁盘读 OLD);
    // phase='delta' 按 256 chars / 180ms 节流覆盖式更新 NEW 侧.
    let lastEditPreviewEmitAt = 0;
    let lastEditPreviewArgChars = 0;
    let editStreamState: {
      toolId: string | null;
      filePath: string | null;
      startLine: number | null;
      endLine: number | null;
      initEmitted: boolean;
      newStringStartPos: number | null;
      aborted: boolean;
    } = {
      toolId: null,
      filePath: null,
      startLine: null,
      endLine: null,
      initEmitted: false,
      newStringStartPos: null,
      aborted: false,
    };
    let currentIterationEstimatedTokens = 0;
    let sawProviderUsage = false;
    let runEstimatedOutputTokens = 0;
    let hadRunnerError = false;
    let stallRetryCount = 0;

    let _iterStartTime = startTime;       // 当前迭代开始时间
    let _toolStartTime = 0;               // 当前工具开始执行时间
    let _iterToolCount = 0;               // 当前迭代的工具调用数
    let _iterToolTotalMs = 0;             // 当前迭代工具总耗时
    let _iterTextChars = 0;               // 当前迭代的文本字符数
    let _firstTokenTime = 0;              // 首个 token 到达时间（TTFT）
    let _firstAnyTime = 0;
    let _firstAnyKind: 'text' | 'reasoning' | 'tool' | null = null;
    const _markFirst = (kind: 'text' | 'reasoning' | 'tool') => {
      if (_firstAnyTime === 0) { _firstAnyTime = Date.now(); _firstAnyKind = kind; }
    };
    const _iterPerf: Array<{ iteration: number; durationMs: number; ttftMs: number | null; firstKind: string | null; toolMs: number; toolCalls: number; textChars: number }> = [];
    const _pushIterPerf = () => {
      if (currentIteration <= 0) return;
      _iterPerf.push({
        iteration: currentIteration,
        durationMs: Date.now() - _iterStartTime,
        ttftMs: _firstAnyTime > 0 ? _firstAnyTime - _iterStartTime : null,
        firstKind: _firstAnyKind,
        toolMs: _iterToolTotalMs,
        toolCalls: _iterToolCount,
        textChars: _iterTextChars,
      });
    };

    const _turnMetrics = new TurnMetricsCollector();

    let pendingUsageEvent: any = null;
    const settlePendingUsage = async () => {
      const event: any = pendingUsageEvent;
      if (!event) return;
      pendingUsageEvent = null;
      if (event.usage) {
        sawProviderUsage = true;
        totalTokens = event.usage.total_tokens;
        const rawPromptTokens = event.usage.prompt_tokens || 0;
        _turnMetrics.onTokenUsage({
          inputTokens: rawPromptTokens,
          outputTokens: event.usage.completion_tokens || 0,
          cacheReadTokens: event.usage.cache_read_input_tokens
            || event.usage.prompt_tokens_details?.cached_tokens
            || event.usage.cached_tokens || 0,
        });

        if (neoxLogger.isEnabled()) {
          const _cd = (event as any).cacheDiag;
          neoxLogger.info('PERF', `  📊 Token usage iter #${currentIteration}`, {
            promptTokens: rawPromptTokens,
            completionTokens: event.usage.completion_tokens || 0,
            reasoningTokens: event.usage.completion_tokens_details?.reasoning_tokens || 0,
            totalTokens: event.usage.total_tokens,
            cacheRead: event.usage.cache_read_input_tokens || event.usage.prompt_tokens_details?.cached_tokens || 0,
            ...(_cd ? { cacheBreak: {
              sysChg: _cd.systemChanged, toolChg: _cd.toolsChanged,
              divIdx: _cd.firstDivergentMsgIdx, divRole: _cd.divergentRole,
              msgCount: _cd.msgCount, prevMsgCount: _cd.prevMsgCount,
              sysDiff: _cd.sysDiff,
            } } : {}),
          });
        }
        const actualOutputTokens = event.usage.completion_tokens || 0;

        const norm = normalizeUsageTokens(event.usage as any);
        const normalizedInput = norm.normalizedInput;
        const cacheRead = norm.cacheRead;
        const cacheWrite = norm.cacheWrite;
        const contextTokens = norm.contextTokens;
        const runtimeSessionId = this.runtimeSessionId || this.session?.sessionId || '_anonymous';
        const isSubAgentRequest = runtimeSessionId.startsWith('agent_');
        const currentMessages = this.memory.getMessagesForLLM();
        const lastRequestMessage = (currentMessages[currentMessages.length - 1] ?? {}) as any;
        const lastRole = typeof lastRequestMessage.role === 'string' ? lastRequestMessage.role : 'unknown';
        const lastToolName = typeof lastRequestMessage.name === 'string' ? lastRequestMessage.name : undefined;
        const cacheScenario = [
          isSubAgentRequest ? 'subagent' : 'main',
          lastRole === 'tool'
            ? `after_tool:${lastToolName || 'unknown'}`
            : `after_${lastRole}`,
        ].join('|');
        const cacheHitRate = contextTokens > 0 ? cacheRead / contextTokens : 0;

        cliLogger.debug('CACHE', `Token normalization: raw=${rawPromptTokens}, normalizedInput=${normalizedInput}, cacheRead=${cacheRead}, cacheWrite=${cacheWrite}, context=${contextTokens}`);

        /* Cache health monitor — 跟上一轮 cache_read 比, 跌幅过大就 warn 给我们.
         * 这样改 prompt / tool / system 谁把 cache 搞挂了能立刻看到. */
        recordCacheSnapshot({
          sessionId: runtimeSessionId,
          model: this.model,
          cacheRead,
          cacheCreation: cacheWrite,
          promptTokens: contextTokens,
          scenario: cacheScenario,
          agentName: this.agentName,
          configuredToolCount: this.configuredToolCount,
        });

        this.sessionTotalInputTokens += contextTokens;
        this.sessionTotalOutputTokens += actualOutputTokens;

        if (process.env.CLI_DEBUG) {
          cliLogger.debug('CONTEXT', `token_usage: normalizedInput=${normalizedInput}, cacheRead=${cacheRead}, cacheWrite=${cacheWrite}, context=${contextTokens}, output=${actualOutputTokens}`);
          cliLogger.debug('CONTEXT', `  sessionTotalInput=${this.sessionTotalInputTokens}, sessionTotalOutput=${this.sessionTotalOutputTokens}`);
        }
        if (this.memoryPressure) {
          const estimatedTokens = this.memoryPressure.estimateMessagesForDisplay(currentMessages);

          this.memoryPressure.recordCalibration(
            estimatedTokens,
            normalizedInput,
            cacheRead
          );

          const snapshot = this.memoryPressure.recordActualUsage(
            contextTokens,
            actualOutputTokens,
            currentMessages.length
          );

          if (process.env.CLI_DEBUG) {
            cliLogger.debug('CONTEXT', `recordActualUsage: tokensUsed=${snapshot.tokensUsed}, pressure=${snapshot.pressure}`);
          }
          await this.handleMemorySnapshot(snapshot);
        }
        currentIterationEstimatedTokens = 0;
        // 归一化后的 token_usage 事件：下游统一使用这些字段
        const normalizedBreakdown = normalizeContextBreakdown(event.requestBreakdown, contextTokens);
        this.emitEvent({
          type: 'token_usage',
          model: this.model,
          promptTokens: normalizedInput,       // 非缓存 input
          completionTokens: actualOutputTokens,
          totalTokens: contextTokens + actualOutputTokens,
          cacheReadTokens: cacheRead > 0 ? cacheRead : undefined,
          cacheWriteTokens: cacheWrite > 0 ? cacheWrite : undefined,
          cacheHitRate,
          cacheScenario,
          runtimeSessionId,
          agentName: this.agentName,
          agentDescription: this.agentDescription,
          configuredToolCount: this.configuredToolCount,
          contextTokens,                       // 总 context（= in + c-r + c-w）
          breakdown: normalizedBreakdown,
          sessionPromptTokens: this.sessionTotalInputTokens,
          sessionCompletionTokens: this.sessionTotalOutputTokens,
        });

        writeStallFile('info', 'METRICS', 'token_usage emitted', {
          sessionId: this.session?.sessionId,
          runtimeSessionId,
          agentName: this.agentName,
          agentDescription: this.agentDescription,
          configuredToolCount: this.configuredToolCount,
          cacheScenario,
          cacheHitRate,
          contextTokens,
          totalTokens: contextTokens + actualOutputTokens,
          normalizedInput,
          cacheRead,
          cacheWrite,
          output: actualOutputTokens,
          breakdown: normalizedBreakdown,
          sessionInput: this.sessionTotalInputTokens,
        });
      }
    };

    if (neoxLogger.isEnabled()) {
      neoxLogger.info('PERF', `━━━ Task START ━━━`, {
        sessionId: this.model,
        prompt: taskInput.substring(0, 120),
        memoryMessages: this.memory.getAll().length,
      });
    }

    //   现在走 schedulePersist / flushPersistImmediate 统一路径,按 lastPersistedMemoryLen 增量推送,
    //   ui:dev rebuild / 进程崩溃不会丢整轮对话。这里不再需要额外 snapshot。

    // 防止 session 恢复时使用过期的 system prompt（模型切换、ProjectMemory 更新等）
    if (this.sessionSync && this.systemPrompt) {
      this.sessionSync.updateSystemPrompt(this.systemPrompt);
    }

    try {
      /** 初始化 abort 的signal。**/
      const signal = this.abortController?.signal;

      if (process.env.CLI_DEBUG === '1') {
        cliLogger.debug('TASK', '=== 开始agent loop 循环 ===');
      }

      let eventCount = 0;
      // 等待阶段上下文：区分“等模型响应”与“等工具执行完成”
      let waitPhase: 'response' | 'tool' = 'response';
      const interruptPromise = this.createInterruptPromise();
      let iterator = this.runner.run(
        taskInput,
        imageUrls.length > 0 ? imageUrls : undefined,
        signal,
        {
          effortLevel: (options?.metadata as any)?.effortLevel,
          continuation: (options?.metadata as any)?.continuation === true,
        },
      )[Symbol.asyncIterator]();

      /** 这里做了异步的循环  无限的循环 等待不同的ai 事件 **/
      while (true) {
        const next = iterator.next();
        next.catch(err => cliLogger.debug('AGENT_HOST', `Iterator next failed: ${err?.message}`));

        // 防止 UI 看起来"卡住"（代理/网络延迟或模型推理中）
        let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
        let waitSeconds = 0;
        const startWait = Date.now();
        heartbeatTimer = setInterval(() => {
          waitSeconds += 5;
          const elapsed = Math.round((Date.now() - startWait) / 1000);
          const normalizedToolName = (currentToolName || '').toLowerCase();
          const isExploreViaCallTool =
            normalizedToolName === 'call_tool' &&
            /"name"\s*:\s*"explore"/i.test(accumulatedArgs || '');
          const isExploreToolWait =
            waitPhase === 'tool' &&
            (normalizedToolName === 'explore' || isExploreViaCallTool);

          if (isExploreToolWait) {
            const message = elapsed < 45
              ? `Explore agents running... ${elapsed}s`
              : `Explore agents still running... ${elapsed}s`;
            this.emitEvent({ type: 'status', status: 'thinking', message });
            return;
          }

          if (elapsed < 15) {
            const message = waitPhase === 'tool'
              ? `Tool is running... ${elapsed}s`
              : `Waiting for response... ${elapsed}s`;
            this.emitEvent({ type: 'status', status: 'thinking', message });
          } else if (elapsed < 45) {
            const message = waitPhase === 'tool'
              ? `Tool chain in progress... ${elapsed}s`
              : `API responding slowly... ${elapsed}s`;
            this.emitEvent({ type: 'status', status: 'thinking', message });
          } else {
            const message = waitPhase === 'tool'
              ? `Tool execution taking long (${elapsed}s)...`
              : `Long wait (${elapsed}s) — will retry if timeout...`;
            this.emitEvent({ type: 'status', status: 'thinking', message });
          }
        }, 5000);

        // 当超过阈值没有收到任何事件时，主动中断迭代器并抛出错误
        const STALL_TIMEOUT_RESPONSE_MS = 60_000;   // 等待 API 响应最多 60s (断连自动重试)
        const STALL_TIMEOUT_TOOL_MS = 180_000;      // 等待工具执行最多 180s (explore 等长工具)
        const stallTimeoutMs = waitPhase === 'tool' ? STALL_TIMEOUT_TOOL_MS : STALL_TIMEOUT_RESPONSE_MS;
        const makeStallPromise = () => new Promise<{ stalled: true }>((resolve) => {
          const timer = setTimeout(() => resolve({ stalled: true }), stallTimeoutMs);
          // 如果 next 先完成，取消超时
          next.then(() => clearTimeout(timer), () => clearTimeout(timer));
          interruptPromise.then(() => clearTimeout(timer));
        });

        const CHILD_ALIVE_IDLE_MS = Math.max(60_000, Number(process.env.NEOX_AGENT_NO_PROGRESS_MS ?? 5 * 60_000));
        const delegationStillAlive = (): boolean => {
          try {
            return getActiveRunDiagnostics().some((r) =>
              !r.ended
              && typeof r.sessionId === 'string'
              && r.sessionId.startsWith('agent_')
              && r.idleMs < CHILD_ALIVE_IDLE_MS);
          } catch {
            /* 探针坏了按"有活"处理 — 宁可晚杀不误杀 (与 turnStallGuard 同规矩) */
            return true;
          }
        };

        const waitInputOf = () => ({
          phase: waitPhase,
          pendingToolCalls: this.recentToolCalls.size,
          delegationAlive: delegationStillAlive(),
          waitedMs: Date.now() - startWait,
          maxWaitMs: toolPhaseMaxWaitMs(),
        });
        let result = await Promise.race([next, interruptPromise, makeStallPromise()]) as
          | IteratorResult<StreamEvent>
          | { interrupted: true }
          | { stalled: true };
        let waitInput = waitInputOf();
        while ('stalled' in result && shouldKeepWaitingInToolPhase(waitInput)) {
          cliLogger.warn('TASK', `⏳ tool-phase 静默 ${Math.round((Date.now() - startWait) / 1000)}s, 但${describeToolPhaseWait(waitInput)} — 继续等待, 不判死`);
          result = await Promise.race([next, interruptPromise, makeStallPromise()]) as
            | IteratorResult<StreamEvent>
            | { interrupted: true }
            | { stalled: true };
          /* 每圈都重新取一次 —— 工具可能刚返回、上限可能刚到; 只在进循环前算一次
           * 就等于把第一次的判断一直用下去, 那道上限形同虚设。 */
          waitInput = waitInputOf();
        }

        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }

        if ('stalled' in result) {
          const elapsedSec = Math.round((Date.now() - startWait) / 1000);
          stallRetryCount++;
          const MAX_STALL_RETRIES = 10;
          cliLogger.error('TASK', `🔥 Stream stall timeout after ${elapsedSec}s (phase=${waitPhase}), retry ${stallRetryCount}/${MAX_STALL_RETRIES}`);
          neoxLogger.error('PERF', `🔥 STALL TIMEOUT after ${elapsedSec}s`, {
            phase: waitPhase,
            iteration: currentIteration,
            eventCount,
            lastTool: currentToolName,
            retryAttempt: stallRetryCount,
          });

          // 清理迭代器
          if (iterator.return) {
            try { const c = iterator.return(undefined); c?.catch?.(() => {}); } catch { /* ignore */ }
          }

          if (stallRetryCount >= MAX_STALL_RETRIES) {
            this.emitEvent({
              type: 'status',
              status: 'error',
              message: `Stream stalled — ${MAX_STALL_RETRIES} retries exhausted`,
            });
            hadRunnerError = true;
            break;
          }

          // 通知 UI 重试
          this.emitEvent({
            type: 'stream_retry',
            error: `Stream stalled (${elapsedSec}s no data)`,
            errorCode: 'STREAM_STALL',
            attempt: stallRetryCount,
            maxRetries: MAX_STALL_RETRIES,
            delayMs: Math.min(stallRetryCount * 2000, 10000),
          } as any);

          // 延迟后重新创建 iterator 重试
          const retryDelay = Math.min(stallRetryCount * 2000, 10000);
          if (this.shouldInterrupt || signal?.aborted) {
            cliLogger.info('TASK', '⏹ stall 重试前发现已被中断 —— 不再重建 iterator');
            break;
          }
          await new Promise(r => setTimeout(r, retryDelay));
          if (this.shouldInterrupt || signal?.aborted) {
            cliLogger.info('TASK', '⏹ stall 退避期间被中断 —— 放弃这一轮重试');
            break;
          }

          this.emitEvent({
            type: 'stream_recovered',
            attempt: stallRetryCount,
            maxRetries: MAX_STALL_RETRIES,
          } as any);

          iterator = this.runner.run(
            taskInput,
            imageUrls.length > 0 ? imageUrls : undefined,
            signal,
            { effortLevel: (options?.metadata as any)?.effortLevel, resumeAfterStall: true },
          )[Symbol.asyncIterator]();
          continue;
        }

        if ('interrupted' in result) {
          this.shouldInterrupt = true;
          if (iterator.return) {
            try {
              const cleanup = iterator.return(undefined);
              cleanup?.catch?.(err => cliLogger.debug('AGENT_HOST', `Non-critical interrupt cleanup: ${err?.message}`));
            } catch (err: any) {
              cliLogger.debug('AGENT_HOST', `Non-critical interrupt cleanup: ${err?.message}`);
            }
          }
          break;
        }

        if (result.done) {
          if (!this.shouldInterrupt && this.pendingInjectedMessages.length > 0) {
            const drained = this.getAndClearPendingMessages();
            for (const msg of drained) {
              if (msg.text) this.emitEvent({ type: 'user_message_injected', text: msg.text });
            }
            this.emitEvent({ type: 'queued_messages_processed', count: drained.length });
            taskInput = drained.map((m) => m.text).filter(Boolean).join('\n');
            const drainedImages = drained.flatMap((m) =>
              (m.images ?? []).map((img) => `data:${img.mediaType};base64,${img.data}`));
            cliLogger.info('INJECT', `▶ Run-end drain: continuing turn with ${drained.length} queued message(s)`);
            iterator = this.runner.run(
              taskInput,
              drainedImages.length > 0 ? drainedImages : undefined,
              signal,
              { effortLevel: (options?.metadata as any)?.effortLevel },
            )[Symbol.asyncIterator]();
            continue;
          }
          break;
        }

        const event = result.value;
        eventCount++;

        if (eventCount % 32 === 0) {
          await new Promise<void>(r => setImmediate(r));
        }

        /**  调试模式：打印每个事件 全部打印！ **/
        if (process.env.CLI_DEBUG === '1') {
          cliLogger.debug('TASK', `  事件 #${eventCount}: ${event.type}`);
        }

        /** 中断检查 **/
        if (this.shouldInterrupt) {
          if (process.env.CLI_DEBUG === '1') {
            cliLogger.debug('TASK', '  shouldInterrupt=true, 退出loop');
          }
          break;
        }

        switch (event.type) {
          /** 迭代开始的 标志 tag **/
          case 'iteration_start': {
            /* 请求边界 ①: 上一次请求已经结束 —— 结算它攒下的最后一张 usage 快照。
             * 必须在 currentIteration 被改写之前, 否则日志里的 iter 编号会串一位。 */
            await settlePendingUsage();
            waitPhase = 'response';
            if (currentIteration > 0 && _iterTextChars > 0) {
              this.emitEvent({ type: 'text_complete' });
            }

            if (neoxLogger.isEnabled() && currentIteration > 0) {
              const iterDuration = Date.now() - _iterStartTime;
              neoxLogger.info('PERF', `◼ Iter #${currentIteration} END`, {
                durationMs: iterDuration,
                toolCalls: _iterToolCount,
                toolTotalMs: _iterToolTotalMs,
                textChars: _iterTextChars,
                ttftMs: _firstTokenTime > 0 ? _firstTokenTime - _iterStartTime : null,
              });
            }

            /* 上一次请求的逐请求指标 —— 必须在 currentIteration / 计时器被改写之前 */
            _pushIterPerf();

            /** 记录当前编号  **/
            currentIteration = event.iteration || 0;

            _turnMetrics.onInference(undefined, this.model);

            // 重置迭代计时器
            _iterStartTime = Date.now();
            _iterToolCount = 0;
            _iterToolTotalMs = 0;
            _iterTextChars = 0;
            _firstTokenTime = 0;
            _firstAnyTime = 0;
            _firstAnyKind = null;

            if (neoxLogger.isEnabled()) {
              neoxLogger.info('PERF', `▶ Iter #${currentIteration} START`, {
                elapsedSinceTaskStart: `${Date.now() - startTime}ms`,
              });
            }

            // Warm-up can also receive insertions before the first model request.
            {
              const injectedCount = this.processPendingInjectedMessages();
              if (injectedCount > 0) {
                cliLogger.info('INJECT', `✅ Processed ${injectedCount} injected messages at iteration ${currentIteration}`);
                this.emitEvent({ type: 'queued_messages_processed', count: injectedCount });
              }
            }

            /** 下一轮的思考中 发送渲染UI status **/
            this.emitEvent({ type: 'thinking', iteration: currentIteration, timestamp: Date.now() });
            this.emitEvent({
              type: 'status',
              status: 'thinking',
              message: getDefaultThinkingStatus(),
            });

            /** 重置当前迭代的 token 估算计数器 **/
            currentIterationEstimatedTokens = 0;
            /** 只有在API返回实际usage时才更新 基于API的 更准确 目前应该是authoropic的才有**/
            if (this.memoryPressure) {
              /** 这里是短期记忆的地方 **/
              const messages = this.memory.getMessagesForLLM();
              if (process.env.CLI_DEBUG) {
                cliLogger.debug('CONTEXT', `迭代开始: 短期记忆 有 ${messages.length} 消息`);
                messages.forEach((msg, idx) => {
                  const contentLen = typeof msg.content === 'string' ? msg.content.length : JSON.stringify(msg.content).length;
                  cliLogger.debug('CONTEXT', `  [${idx}] role=${msg.role}, content_len=${contentLen}`);
                });
              }
              // 此时 memory 已包含上一轮 tool 结果，所以估算值会更新
              // 让 UI 实时反映 tool 执行后的上下文增长
              // forceEstimate=true: 即使有上一轮 API 返回的实际值，也重新估算
              // 因为 memory 已经增长了（tool results 被加入）
              const snapshot = this.memoryPressure.setPromptEstimateFromMessages(messages, true);
              void this.handleMemorySnapshot(snapshot, true);
            }

            break;
          }

          case 'text_delta':
            waitPhase = 'response';
            /** stream的文本输出 事件 一般是SSE的返回 **/
            if (event.delta) {
              /** 累加stream的文本  **/
              fullResponse += event.delta;  // session的累加
              lastAssistantMessage += event.delta; // 当前对话的
              currentTurnText += event.delta;
              _iterTextChars += event.delta.length;
              if (_firstTokenTime === 0) _firstTokenTime = Date.now();
              _markFirst('text');
              _turnMetrics.markFirstAction();

              /** 估算token的 是字符数字/4 目前暂时是这样！ **/
              const deltaTokens = Math.ceil(event.delta.length / 4);
              currentIterationEstimatedTokens += deltaTokens;
              runEstimatedOutputTokens += deltaTokens;

              // 每累积约 500 tokens 估算值时，发送一次 memory_snapshot
              // 这样 UI 的 Context Window popup 会动态变化，而非等整轮结束
              if (this.memoryPressure && currentIterationEstimatedTokens % 500 < deltaTokens) {
                const snapshot = this.memoryPressure.addEstimatedOutputTokens(deltaTokens);
                void this.handleMemorySnapshot(snapshot, true);
              }

              if (event.delta.trim().length > 0 || event.delta.includes('\n')) {
                this.emitEvent({ type: 'status', status: 'thinking', message: 'Generating response...' });
              }
              this.emitEvent({ type: 'text', delta: event.delta });


            }
            break;

          case 'reasoning_delta':
            waitPhase = 'response';
            /** 处理思维链/思考内容 **/
            if (event.delta) {
              _markFirst('reasoning');
              /** 实时发送 reasoning delta 到 UI **/
              this.emitEvent({
                type: 'reasoning',
                delta: event.delta,
                timestamp: Date.now(),
              });


            }
            break;
          case 'reasoning_complete':
            this.emitEvent({ type: 'reasoning_complete', timestamp: Date.now() });
            break;

          case 'tool_call_start':
            waitPhase = 'tool';
            /** 对于工具事件 的event 要记录tool的次数和特殊处理 **/
            toolCallCount++;          /** 工具调用次数 ++ **/
            _iterToolCount++;         // neoxLogger 迭代内工具计数
            _toolStartTime = Date.now(); // neoxLogger 工具计时
            _turnMetrics.markFirstAction();
            _markFirst('tool');
            accumulatedArgs = '';        /** 重制tool的args 参数 ++ **/
            accumulatedArgsLength = 0;       /** 参数长度0 ++ **/
            currentToolName = event.name || '';      /** 记录当前的工具名称 ++ **/
            currentToolId = (event as any).id || '';
            lastWritePreviewEmitAt = 0;
            lastWritePreviewArgChars = 0;
            // edit_file 流式状态重置 —— toolId 绑定到 event.id/toolId (若有),
            // 后续 tool_call_delta 期间发 preview 事件要带这个 id 给前端找卡片.
            lastEditPreviewEmitAt = 0;
            lastEditPreviewArgChars = 0;
            const resolvedToolId = (event as any).id || (event as any).toolId || null;
            editStreamState = {
              toolId: resolvedToolId,
              filePath: null,
              startLine: null,
              endLine: null,
              initEmitted: false,
              newStringStartPos: null,
              aborted: false,
            };
            if (process.env.CLI_DEBUG === '1') console.log('[EDIT_STREAM][tool_call_start]', {
              toolName: event.name,
              toolId: resolvedToolId,
              hasToolId: Boolean(resolvedToolId),
            });
            // NOTE: 不在这里发 lightweight tool_call_start — tool_call_done 会发完整版
            // (带 args/targetPath/batchId). 之前这里也发一个导致 UI 收到重复事件,
            // write_file 卡片多渲染 (例如 2 个文件显示为 3 个). tool_call_delta 阶段
            // 的 file_stream 预览已经提供了即时反馈, 不需要空卡片.
            //
            //   sub-agent 里幻觉 write_file/execute_shell. 不在的话整个跳过 UI emit,
            //   dispatch 走 runner 自己挡掉, LLM 收到 "tool not found" 错误自纠.
            if (this.isHallucinatedToolName(event.name)) {
              cliLogger.warn('AGENT_HOST', `LLM hallucinated tool "${event.name}", suppressing UI events`, {
                model: this.model,
                agentName: this.agentName,
                toolId: resolvedToolId,
              });
              break;
            }
            this.emitEvent({
              type: 'status',
              status: 'tool_call',
              message: `Calling: ${event.name}`,
            });

            if (neoxLogger.isEnabled()) {
              const llmThinkMs = _firstTokenTime > 0 ? Date.now() - _firstTokenTime : Date.now() - _iterStartTime;
              neoxLogger.info('PERF', `  🔧 Tool #${toolCallCount} LLM→call`, {
                tool: event.name,
                llmThinkMs,
              });
            }
            break;

          case 'tool_call_delta':
            waitPhase = 'tool';
            /** 工具调用参数流式输出 就是SSE返回的时候 工具的stream 返回内容 **/
            if (event.arguments_delta) {
              // 必须重置 accumulatedArgs, 否则 regex 匹配到前一个 tool 的 file_path
              // 导致 write_file 卡片多渲染 (2 个文件显示为 3 个).
              const deltaToolId = (event as any).id || '';
              if (deltaToolId && deltaToolId !== currentToolId) {
                accumulatedArgs = '';
                accumulatedArgsLength = 0;
                currentToolName = (event as any).name || currentToolName;
                currentToolId = deltaToolId;
                lastWritePreviewEmitAt = 0;
                lastWritePreviewArgChars = 0;
              }
              /** 先累加 stream的 SSE的调用 **/
              accumulatedArgs += event.arguments_delta;
              accumulatedArgsLength += event.arguments_delta.length;

              /** 估算token1 字符/4的计算方法 **/
              const argDeltaTokens = Math.ceil(event.arguments_delta.length / 4);
              currentIterationEstimatedTokens += argDeltaTokens;
              runEstimatedOutputTokens += argDeltaTokens;

              const hallucinated = this.isHallucinatedToolName(currentToolName || event.name);
              if (!hallucinated) {
                /* call_tool 透明化: 内层工具名一旦在累积 args 里可探测, 就随 delta 带上,
                 * 让流式占位卡立刻显示真实工具名 (web_search 等) 而不是 "Call tool"。 */
                const outerName = (currentToolName || event.name || '').toLowerCase();
                let innerToolName: string | undefined;
                if (outerName === 'call_tool') {
                  const m = accumulatedArgs.match(/"(?:name|tool|tool_name)"\s*:\s*"([^"]+)"/i);
                  if (m && m[1]) innerToolName = m[1];
                }
                this.emitEvent({
                  type: 'tool_call_delta',
                  name: currentToolName || event.name || 'unknown',
                  innerToolName,
                  argumentsDelta: event.arguments_delta,
                  /* 带上 toolId — forwarder + renderer 用它在 args 全部解析完前
                   * 就建占位卡 (转圈圈 + 工具名), 等真正的 tool_call_start 到时
                   * handleToolCall 按 toolId 找到这张卡升级在原位. */
                  toolId: currentToolId || undefined,
                });
              }

              /** 3，存在部分情况 返回的都是空白 超过1000字符的情况下 丢弃**/
              if (accumulatedArgsLength > 1000) {
                const trimmedArgs = accumulatedArgs.trim();
                const whitespaceRatio = 1 - (trimmedArgs.length / accumulatedArgsLength);
                if (whitespaceRatio > 0.9) {
                  console.error(`[AgentHost] ⚠️ Abnormal tool call: ${currentToolName} - ${(whitespaceRatio * 100).toFixed(1)}% whitespace (${accumulatedArgsLength} bytes)`);
                  this.emitLog('warn', `Model output abnormal: ${currentToolName} generating mostly whitespace content`);
                }
              }

              /** write 的动态写入的工具。**/
              const normalizedCurrentToolName = (currentToolName || '').toLowerCase();
              const normalizedEventToolName = (event.name || '').toLowerCase();
              const isWriteFileDelta =
                normalizedCurrentToolName === 'write_file' ||
                normalizedCurrentToolName === 'write' ||
                normalizedEventToolName === 'write_file' ||
                normalizedEventToolName === 'write';
              if (isWriteFileDelta) {

                try {
                  /** 解析json 参数  1，filepath 路径 2，内容解析 分为两部分 **/
                  const filePathMatch = accumulatedArgs.match(/"file_path"\s*:\s*"([^"]+)"/);
                  const contentMatch = accumulatedArgs.match(/"content"\s*:\s*"/);

                  /** 确定匹配到关键字 才进行处理  **/
                  if (filePathMatch && contentMatch) {

                    const filePath = filePathMatch[1];
                    const contentStart = accumulatedArgs.indexOf('"', contentMatch.index! + '"content"'.length + 1) + 1;

                    if (contentStart > 0) {
                      /** 处理转义字符 **/
                      let rawContent = accumulatedArgs.substring(contentStart);

                      /** 查找结束引号（跳过转义的引号）**/
                      let endQuoteIndex = -1;
                      let escapeCount = 0;
                      for (let i = 0; i < rawContent.length; i++) {
                        if (rawContent[i] === '\\') {
                          escapeCount++;
                        } else {
                          if (rawContent[i] === '"' && escapeCount % 2 === 0) {
                            endQuoteIndex = i;
                            break;
                          }
                          escapeCount = 0;
                        }
                      }
                      if (endQuoteIndex > 0) {
                        rawContent = rawContent.substring(0, endQuoteIndex);
                      }
                      let partialContent = rawContent
                        .replace(/\\n/g, '\n')
                        .replace(/\\t/g, '\t')
                        .replace(/\\"/g, '"')
                        .replace(/\\\\/g, '\\');

                      /** 处理语言检测 **/
                      const ext = filePath.split('.').pop() || '';
                      const langMap: Record<string, string> = {
                        js: 'javascript',
                        ts: 'typescript',
                        tsx: 'typescript',
                        py: 'python',
                        html: 'html',
                        css: 'css',
                        json: 'json',
                        md: 'markdown',
                      };
                      const lines = partialContent.split('\n');

                      //   · 80ms 间隔(原 180ms 让小文件几乎没增量帧)
                      //   · 80 字符增量(原 256)
                      //   · 不再 slice(-2000) — 让 UI 看到完整累积过程, UI 端自己决定怎么显示
                      const now = Date.now();
                      const rawContentLength = rawContent.length;
                      const isFirstUpdate = lastWritePreviewEmitAt === 0;
                      const grewEnough = rawContentLength - lastWritePreviewArgChars >= 80;
                      const timedOut = now - lastWritePreviewEmitAt >= 80;
                      const shouldUpdate = isFirstUpdate || grewEnough || timedOut;

                      /** 如果监测到 是首次 就发送emit**/
                      if (shouldUpdate) {
                        this.emitEvent({
                          type: 'file_stream',
                          filePath,
                          content: partialContent,
                          language: langMap[ext] || ext,
                          description: lastAssistantMessage.trim() || '',
                          timestamp: Date.now(),
                        });
                        lastWritePreviewEmitAt = now;
                        lastWritePreviewArgChars = rawContentLength;
                      } else {
                        /* 节流间隙只刷状态栏行数 — 必须跟 file_stream 同格式(basename),
                         * 禁止全路径: 否则跟 "Writing foo.html · N lines" 交替 → 闪烁+换行. */
                        const base = filePath.split(/[\\/]/).pop() || filePath;
                        this.emitEvent({
                          type: 'status',
                          status: 'tool_call',
                          message: `Writing ${base} · ${lines.length} lines`,
                        });
                      }
                    }
                  }
                } catch {
                  cliLogger.error("MK", "不完整的json 处理")
                }
              }

              const isCallToolWrappingEdit =
                (normalizedCurrentToolName === 'call_tool' ||
                 normalizedEventToolName === 'call_tool') &&
                /"name"\s*:\s*"(edit_file|edit|str_replace_editor)"/i.test(accumulatedArgs);
              const isEditFileDelta =
                normalizedCurrentToolName === 'edit_file' ||
                normalizedCurrentToolName === 'edit' ||
                normalizedEventToolName === 'edit_file' ||
                normalizedEventToolName === 'edit' ||
                isCallToolWrappingEdit;
              // 诊断: 每 5 次 delta 打一次, 追踪 isEditFileDelta 为啥不命中
              if (accumulatedArgsLength > 0 && accumulatedArgsLength % 500 < event.arguments_delta.length) {
                if (process.env.CLI_DEBUG === '1') console.log('[EDIT_STREAM][delta-probe]', {
                  currentToolName: normalizedCurrentToolName,
                  eventToolName: normalizedEventToolName,
                  isEditFileDelta,
                  isCallToolWrappingEdit,
                  aborted: editStreamState.aborted,
                  argsLen: accumulatedArgsLength,
                  hasToolId: Boolean(editStreamState.toolId),
                  argsSnippet: accumulatedArgs.substring(0, 200),
                });
              }
              if (isEditFileDelta && !editStreamState.aborted) {
                try {
                  // 多 hunk 太难做 partial JSON 解析 (数组边界追踪成本高),
                  // 一旦检测到 "hunks" 字段就 abort, 降级到 pending→final.
                  if (/"hunks"\s*:\s*\[/.test(accumulatedArgs)) {
                    editStreamState.aborted = true;
                  }
                }
                catch {}
              }

              if (isEditFileDelta && !editStreamState.aborted) {
                try {
                  // 抽 file_path (首次出现,后续锁定)
                  if (!editStreamState.filePath) {
                    const m = accumulatedArgs.match(/"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
                    if (m) {
                      editStreamState.filePath = m[1]
                        .replace(/\\n/g, '\n')
                        .replace(/\\t/g, '\t')
                        .replace(/\\"/g, '"')
                        .replace(/\\\\/g, '\\');
                    }
                  }
                  // 抽 start_line / end_line (JSON number)
                  if (editStreamState.startLine == null) {
                    const m = accumulatedArgs.match(/"start_line"\s*:\s*(\d+)/);
                    if (m) editStreamState.startLine = parseInt(m[1], 10);
                  }
                  if (editStreamState.endLine == null) {
                    const m = accumulatedArgs.match(/"end_line"\s*:\s*(\d+)/);
                    if (m) editStreamState.endLine = parseInt(m[1], 10);
                  }
                  // 找 new_string 起始引号位置 (只做一次)
                  if (editStreamState.newStringStartPos == null) {
                    const m = accumulatedArgs.match(/"new_string"\s*:\s*"/);
                    if (m && typeof m.index === 'number') {
                      // 起始引号 = "new_string":" 中最后那个 " 之后
                      editStreamState.newStringStartPos = m.index + m[0].length;
                    }
                  }

                  // init phase: file_path + start_line + end_line 都齐了 → 读磁盘发 init
                  if (
                    !editStreamState.initEmitted &&
                    editStreamState.filePath &&
                    editStreamState.startLine != null &&
                    editStreamState.endLine != null &&
                    editStreamState.toolId
                  ) {
                    // 重新赋值 editStreamState (整个对象替换), promise 回调里如果直接
                    // 读 editStreamState.toolId 会拿到下一轮的值. 这里必须 capture.
                    const capturedToolId = editStreamState.toolId;
                    const capturedFilePath = editStreamState.filePath;
                    const absPath = path.resolve(capturedFilePath);
                    const startLine = editStreamState.startLine;
                    const endLine = editStreamState.endLine;
                    if (process.env.CLI_DEBUG === '1') console.log('[EDIT_STREAM][init-emit]', {
                      absPath,
                      startLine,
                      endLine,
                      toolId: capturedToolId,
                    });
                    fsReadFile(absPath, 'utf8').then((content) => {
                      const allLines = content.split('\n');
                      const slice = allLines.slice(Math.max(0, startLine - 1), endLine);
                      if (process.env.CLI_DEBUG === '1') console.log('[EDIT_STREAM][init-emit-ok]', {
                        toolId: capturedToolId,
                        oldLines: slice.length,
                      });
                      this.emitEvent({
                        type: 'edit_file_stream_preview',
                        toolId: capturedToolId,
                        filePath: capturedFilePath,
                        phase: 'init',
                        startLine,
                        endLine,
                        oldContent: slice.join('\n'),
                        timestamp: Date.now(),
                      });
                    }).catch((err) => {
                      // 读不到文件 (可能 LLM 用的相对路径不在 cwd), 仍然发 init 但 oldContent 为空,
                      // 前端照样能渲染 NEW 侧 pending 卡.
                      if (process.env.CLI_DEBUG === '1') console.log('[EDIT_STREAM][init-emit-no-old]', {
                        toolId: capturedToolId,
                        err: err?.message,
                      });
                      this.emitEvent({
                        type: 'edit_file_stream_preview',
                        toolId: capturedToolId,
                        filePath: capturedFilePath,
                        phase: 'init',
                        startLine,
                        endLine,
                        oldContent: '',
                        timestamp: Date.now(),
                      });
                    });
                    editStreamState.initEmitted = true;
                  }

                  // delta phase: new_string 起始位置已知 → 抽当前内容发 delta
                  if (
                    editStreamState.initEmitted &&
                    editStreamState.newStringStartPos != null &&
                    editStreamState.toolId
                  ) {
                    let rawContent = accumulatedArgs.substring(editStreamState.newStringStartPos);
                    // 找未转义的结束引号
                    let endQuoteIndex = -1;
                    let escapeCount = 0;
                    for (let i = 0; i < rawContent.length; i++) {
                      if (rawContent[i] === '\\') {
                        escapeCount++;
                      } else {
                        if (rawContent[i] === '"' && escapeCount % 2 === 0) {
                          endQuoteIndex = i;
                          break;
                        }
                        escapeCount = 0;
                      }
                    }
                    if (endQuoteIndex >= 0) {
                      rawContent = rawContent.substring(0, endQuoteIndex);
                    }
                    const partial = rawContent
                      .replace(/\\n/g, '\n')
                      .replace(/\\t/g, '\t')
                      .replace(/\\"/g, '"')
                      .replace(/\\\\/g, '\\');

                    // 既避免 React 重绘雪崩, 又能贴合浏览器 60fps 刷新让流式看起来连续.
                    // 为什么比 write_file 的 256/180 激进得多: diff 逐行渲染对时间敏感,
                    // 跨 100ms+ 的跳帧会让人觉得"抖一下". 实际 CPU 负担可控 — 前端有 rAF 合并.
                    const now = Date.now();
                    const rawLen = rawContent.length;
                    const isFirst = lastEditPreviewEmitAt === 0;
                    const grew = rawLen - lastEditPreviewArgChars >= 48;
                    const timed = now - lastEditPreviewEmitAt >= 50;
                    if (isFirst || grew || timed) {
                      if (process.env.CLI_DEBUG === '1') console.log('[EDIT_STREAM][delta-emit]', {
                        toolId: editStreamState.toolId,
                        partialLen: partial.length,
                      });
                      this.emitEvent({
                        type: 'edit_file_stream_preview',
                        toolId: editStreamState.toolId,
                        filePath: editStreamState.filePath || '',
                        phase: 'delta',
                        newStringPartial: partial,
                        timestamp: now,
                      });
                      lastEditPreviewEmitAt = now;
                      lastEditPreviewArgChars = rawLen;
                    }
                  }
                } catch (err: any) {
                  cliLogger.debug('EDIT_STREAM', `partial parse skip: ${err?.message}`);
                }
              }
            }
            break;

          case 'tool_call_done': {
            waitPhase = 'tool';
            /** 收到 call done的事件 此时 是llm返回给我们的结束 我们还没有执行工具 **/
            if (event.name && event.arguments) {
              try {
                let argsString = event.arguments.trim();
                const fallbackArgsString = accumulatedArgs.trim();
                const parseFallbackArgs = () => {
                  if (!fallbackArgsString || fallbackArgsString === argsString) return null;
                  const parsed = parseToolArguments(fallbackArgsString, event.name);
                  return parsed.ok ? parsed : null;
                };

                /** 参数判断是否被截断 **/
                const truncationCheck = detectTruncation(event.name, argsString);
                if (truncationCheck.isTruncated) {
                  if (process.env.CLI_DEBUG_CONSOLE === '1') {
                    cliLogger.log("MK", `[AgentHost] ⚠️ Truncation detected: ${truncationCheck.reason}`);
                  }

                  if (isSyntacticallyComplete(argsString)) {
                    throw new Error(
                      `Tool call is missing required arguments: ${truncationCheck.reason}. ` +
                      `The JSON parsed fine — you left a field out. Re-send the call with every required field.`,
                    );
                  }

                  /** 尝试修复json **/
                  const repaired = attemptJsonRepair(argsString);
                  if (repaired) {
                    if (process.env.CLI_DEBUG_CONSOLE === '1') {
                      console.log('[AgentHost] ✅ JSON repaired successfully');
                    }
                    argsString = repaired;
                  } else {
                    throw new Error(`Tool arguments truncated: ${truncationCheck.reason}`);
                  }
                }

                /** 开始解析tool的返回 的参数 — 使用 parseToolArguments 容错解析 **/
                let argsParsed = parseToolArguments(argsString, event.name);
                if (!argsParsed.ok) {
                  const fallbackParsed = parseFallbackArgs();
                  if (fallbackParsed) {
                    cliLogger.warn('TOOL', `⚠️ tool_call_done args parse failed, recovered from accumulated delta for ${event.name}`);
                    argsParsed = fallbackParsed;
                  }
                }
                if (!argsParsed.ok) {
                  /* 留痕 + 按工具给定向指引。都在 toolArgsFailureReport 里, 别再往这个文件堆。 */
                  const steer = reportToolArgsFailure(event.name, argsString, argsParsed.reason);
                  throw new Error(`Invalid JSON arguments: ${argsParsed.reason || 'parse failed'}${steer}`);
                }
                const rawArgs = argsParsed.args;
                if (argsParsed.repaired) {
                  cliLogger.info('TOOL', `✅ Tool args repaired for ${event.name}: ${argsParsed.reason}`);
                }

                let toolName = event.name;
                let args = rawArgs;
                if (event.name === 'call_tool' && rawArgs?.name) {
                  toolName = rawArgs.name;
                  args = rawArgs.args || {};
                  cliLogger.info('TOOL', `🔀 call_tool unwrap: ${event.name} → ${toolName}`);
                }

                const maybeRecoverArgsFromDelta = () => {
                  const fallbackParsed = parseFallbackArgs();
                  if (!fallbackParsed) return;
                  let recoveredToolName = event.name;
                  let recoveredArgs = fallbackParsed.args;
                  if (event.name === 'call_tool' && recoveredArgs?.name) {
                    recoveredToolName = recoveredArgs.name;
                    recoveredArgs = recoveredArgs.args || {};
                  }
                  if (recoveredToolName === toolName) {
                    const isEdit = toolName === 'edit_file' || toolName === 'edit' || toolName === 'str_replace_editor';
                    const isWrite = toolName === 'write_file' || toolName === 'write';
                    if (isEdit) {
                      const hasSinglePair = recoveredArgs?.old_string !== undefined && recoveredArgs?.new_string !== undefined;
                      const hasHunks = Array.isArray(recoveredArgs?.hunks) && recoveredArgs.hunks.some((h: any) =>
                        h && typeof h === 'object' && h.old_string !== undefined && h.new_string !== undefined
                      );
                      if (!hasSinglePair && !hasHunks) return;
                    }
                    if (isWrite && recoveredArgs?.content === undefined) return;
                    args = recoveredArgs;
                    cliLogger.warn('TOOL', `⚠️ Recovered missing ${toolName} args from accumulated delta`);
                  }
                };
                if (
                  (toolName === 'edit_file' || toolName === 'edit') &&
                  (args?.old_string === undefined || args?.new_string === undefined)
                ) {
                  maybeRecoverArgsFromDelta();
                }
                if (
                  (toolName === 'write_file' || toolName === 'write') &&
                  args?.content === undefined
                ) {
                  maybeRecoverArgsFromDelta();
                }

                /** Phase 1: 提取目标路径 用于UI的tool的card的展示 **/
                const targetPath = extractTargetPath(toolName, args);

                /** Phase 2: 尝试从 assistant 消息提取描述，否则推断 **/
                let description = this.descriptionExtractor.extractFromAssistantMessage(
                  lastAssistantMessage,
                  toolName
                );
                if (!description) {
                  description = inferToolDescription(toolName, args);
                }

                /** Phase 2: 生成等效命令 **/
                const equivalentCommand = this.commandGenerator.generateEquivalentCommand(toolName, args);

                /** Phase 3: 解析出来 tool的一些基本信息  **/
                // 不再自己生成，保证 tool_call_done 和 tool_output 的 id 一致
                const toolId = event.id || `tool-${++this.toolCallIdCounter}-${Math.floor(Date.now())}`;
                const timestamp = Date.now();
                const batchDecision = this.batchDetector.detectBatch(
                  toolId,
                  toolName,
                  targetPath || '',
                  args,
                  timestamp
                );

                /** 保存工具调用信息供 tool_output 使用，用 toolId 做 key 而非 event.name **/
                this.recentToolCalls.set(toolId, { toolId, batchId: batchDecision.batchId, targetPath, args, toolName });

                /** 这里发送 tool的开始执行的事件 event **/
                let logDetails: any = {
                  targetPath,
                  argsPreview: JSON.stringify(args).substring(0, 200),
                };
                if (toolName === 'search' && args.pattern) {
                  logDetails.pattern = (args.pattern as string).substring(0, 80);
                } else if ((toolName === 'readfile' || toolName === 'edit_file' || toolName === 'edit') && args.path) {
                  logDetails.file = args.path;
                }
                cliLogger.info('TOOL', `🤖 [AGENT] Call: ${toolName}`, logDetails);
                if (this.isHallucinatedToolName(toolName)) {
                  cliLogger.warn('AGENT_HOST', `LLM hallucinated tool "${toolName}" (post-parse), suppressing UI events`, {
                    model: this.model,
                    agentName: this.agentName,
                    toolId,
                  });
                } else {
                  this.emitEvent({
                    type: 'tool_call_start',
                    name: toolName,
                    args,
                    targetPath,
                    description,
                    equivalentCommand,
                    timestamp: timestamp + Math.random() * 0.1,
                    toolId,
                    isBatch: batchDecision.type === 'batch',
                    batchId: batchDecision.batchId,
                    viaCallTool: event.name === 'call_tool',
                  });
                }

                /** 这里是 stream的写入文件的时候。的处理 **/
                const normalizedToolName = (toolName || '').toLowerCase();
                const isWriteFileTool = normalizedToolName === 'write_file' || normalizedToolName === 'write';
                const writeFilePath = args.file_path || args.filePath || args.path;
                if (isWriteFileTool) {
                  this.emitWriteCardDebug('tool_call_start', {
                    toolId,
                    writeFilePath: writeFilePath || '',
                    hasContent: typeof args.content === 'string',
                    contentChars: typeof args.content === 'string' ? args.content.length : 0,
                    targetPath: targetPath || '',
                  });
                }
                if (isWriteFileTool && writeFilePath && args.content) {
                  // 不实际写入文件 - 等待权限检查和工具执行
                  await this.emitFileStreamEvent(
                    writeFilePath,
                    args.content,
                    lastAssistantMessage.trim() || undefined,
                    toolId
                  );
                  lastAssistantMessage = '';
                } else if (isWriteFileTool) {
                  this.emitWriteCardDebug('preview_stream_skipped', {
                    toolId,
                    hasFilePath: Boolean(writeFilePath),
                    hasContent: Boolean(args.content),
                  });
                }

                // edit_file 统一在工具真实执行结果返回后再发 edit_file_stream，避免预览与最终失败状态冲突
              } catch (error: any) {
                console.error('[AgentHost] ❌ Failed to parse tool arguments for:', event.name);
                console.error('[AgentHost] Error:', error.message);
                console.error('[AgentHost] Arguments length:', event.arguments?.length || 0);

                if (process.env.CLI_DEBUG_CONSOLE === '1') {
                  console.error('[AgentHost] First 200 chars:', event.arguments?.substring(0, 200) || '');
                  console.error('[AgentHost] Last 200 chars:', event.arguments?.substring(Math.max(0, (event.arguments?.length || 0) - 200)) || '');
                }

                /** 解析错误 **/
                const errorResult = createToolErrorResult(event.name, event.arguments || '', error);
                const statusMessage = errorResult.category === ErrorCategory.TOOL_TRUNCATED
                  ? `❌ Tool ${event.name}: content truncated during streaming`
                  : `❌ Tool ${event.name}: ${errorResult.code}`;

                if (this.isHallucinatedToolName(event.name)) {
                  cliLogger.warn('AGENT_HOST', `LLM hallucinated tool "${event.name}" with parse error, suppressing`, {
                    model: this.model,
                    agentName: this.agentName,
                    error: errorResult.code,
                  });
                  break;
                }

                this.emitEvent({
                  type: 'status',
                  status: 'error',
                  message: statusMessage,
                });

                this.emitEvent({
                  type: 'tool_call_start',
                  name: event.name, toolId: event.id || undefined,
                  args: {
                    _raw: event.arguments?.substring(0, 500) || '',
                    _error: errorResult.code,
                    _errorCategory: errorResult.category,
                    _errorMessage: errorResult.message,
                    _suggestion: errorResult.suggestion,
                    _retryable: errorResult.retryable,
                  },
                  timestamp: Date.now(),
                });

                /** 发送tool的执行报错 给llm **/
                const fallbackToolId = event.id;
                if (fallbackToolId) this.recentToolCalls.delete(fallbackToolId);
                this.emitEvent({
                  type: 'tool_output',
                  name: event.name,
                  output: JSON.stringify(errorResult),
                  success: false,
                  toolId: fallbackToolId,
                });
              }
            }
            /** 这里tool 结束后 为什么不发送 end ？ 因为等到ouput 输出后 才能进行返回 **/
            break;
          }

          case 'tool_output':
            waitPhase = 'response';
            /** 工具执行结束 开始 返回结果了 **/
            if (event.name && event.output !== undefined) {
              /** 关键的返回处理 ！**/
              const outputString = stripToolFailureTag(
                typeof event.output === 'string' ? event.output : JSON.stringify(event.output),
              );
              const resultLength = outputString.length;
              const baseSuccess = event.success ?? true;
              const _toolExecMs = _toolStartTime > 0 ? Date.now() - _toolStartTime : 0; // 工具执行墙钟 (Gap 埋点用)
              _turnMetrics.onToolOutput(event.name, baseSuccess, outputString, _toolExecMs, _toolStartTime);
              const outputPreview = outputString.slice(0, MAX_TOOL_OUTPUT_PREVIEW);
              const outputTruncated = outputString.length > MAX_TOOL_OUTPUT_PREVIEW;

              if (neoxLogger.isEnabled()) {
                const toolExecMs = _toolStartTime > 0 ? Date.now() - _toolStartTime : 0;
                _iterToolTotalMs += toolExecMs;
                neoxLogger.info('PERF', `  🔧 Tool #${toolCallCount} done`, {
                  tool: event.name,
                  success: baseSuccess,
                  execMs: toolExecMs,
                  outputLen: resultLength,
                });
              }

              /** 先输出 完整的返回 **/
              cliLogger.info('TOOL', `🤖 [AGENT] Result: ${event.name} ${baseSuccess ? '✓' : '✗'}`, {
                success: baseSuccess,
                resultLength,
                outputString: outputString,
              });

              /** Phase 3: 获取之前保存的工具调用信息 这里主要是 tool的配对 **/
              const toolId = event.id;
              const toolCallInfo = toolId ? this.recentToolCalls.get(toolId) : undefined;
              const { batchId, targetPath, args } = toolCallInfo || {};

              const realName = toolCallInfo?.toolName || event.name;
              const normalizedRealName = (realName || '').toLowerCase();
              const realArgs = args || {};

              let parsedOutput: any = null;
              try {
                parsedOutput = JSON.parse(outputString);
              } catch {
                parsedOutput = null;
              }
              /* 下面 diff 卡 / session 快照那两段是**真的**只对 edit 生效, 这个判断留着 */
              const isEditTool = normalizedRealName === 'edit_file' || normalizedRealName === 'edit';
              const effectiveSuccess = baseSuccess;

              const resolvedTargetPath =
                targetPath ||
                extractTargetPath(realName, realArgs) ||
                (realArgs && typeof realArgs.directory === 'string' ? realArgs.directory : undefined);

              // 双轨道:工具自声明的 summary (来自 ToolResult.summary,经 NeoxEventNormalizer
               // 透传到 tool_output event 的 summary 字段) 优先,fallback 才用启发式 builder.
              const declaredSummary = (event as any).summary as string | undefined;
              const toolSummary = declaredSummary
                || this.buildToolOutputSummary(realName, realArgs, outputString, resultLength, resolvedTargetPath, effectiveSuccess);

              cliLogger.info('TOOL', `🔥 tool_output → emitting tool_call_end: realName=${realName} toolId=${toolId} summary=${toolSummary?.substring(0, 60)}`);

              /** 记录工具完成（用于批量进度追踪） **/
              if (effectiveSuccess && resolvedTargetPath) {
                this.batchDetector.recordCompletion(realName, resolvedTargetPath);
              }

              /** 发送tool的output 到UI的card里面 **/
              this.emitEvent({
                type: 'tool_call_end',
                name: realName,
                success: effectiveSuccess,
                resultLength,
                timestamp: Date.now(),
                // Phase 3: 传递批量信息
                toolId,
                batchId,
                targetPath: resolvedTargetPath,
                summary: toolSummary,
                output: outputPreview,
                outputTruncated,
                // 传递真实工具参数（用于 UI 展示 grep pattern 等）
                args: realArgs,
                // 双轨道 —— 透传工具自声明的 UI meta 给下游 (Electron forwarder / CLI renderer)
                toolStatus: (event as any).toolStatus,
                toolKind: (event as any).toolKind,
                toolError: (event as any).toolError,
                metadata: (event as any).metadata,
                blockedBy: (event as any).blockedBy,
                userNotice: (event as any).userNotice,
              });

              /** 处理 write_file 的 tool_output - 记录 session 快照和发送完成事件 **/
              const resolvedWritePath = realArgs?.file_path || realArgs?.filePath || realArgs?.path;
              if (normalizedRealName === 'write_file' || normalizedRealName === 'write') {
                this.emitWriteCardDebug('tool_output_received', {
                  toolId,
                  success: event.success !== false,
                  resolvedWritePath: resolvedWritePath || '',
                  hasContent: typeof realArgs?.content === 'string',
                  contentChars: typeof realArgs?.content === 'string' ? realArgs.content.length : 0,
                  resultLength,
                });
              }
              if ((normalizedRealName === 'write_file' || normalizedRealName === 'write') && event.success && resolvedWritePath && realArgs?.content) {
                try {
                  const filePath = resolvedWritePath;
                  const content = realArgs.content;

                  // 推断文件语言
                  const ext = filePath.split('.').pop()?.toLowerCase() || '';
                  const langMap: Record<string, string> = {
                    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
                    py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
                    java: 'java', kt: 'kotlin', swift: 'swift',
                    c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
                    css: 'css', scss: 'scss', less: 'less',
                    html: 'html', vue: 'vue', svelte: 'svelte',
                    json: 'json', yaml: 'yaml', yml: 'yaml',
                    md: 'markdown', sql: 'sql', sh: 'bash',
                  };

                  this.emitEvent({
                    type: 'write_file_stream',
                    filePath,
                    content,
                    isComplete: true,
                    language: langMap[ext] || ext,
                    timestamp: Date.now(),
                  });
                  this.emitWriteCardDebug('write_file_stream_emitted', {
                    toolId,
                    filePath,
                    contentChars: content.length,
                    isComplete: true,
                  });
                } catch (err) {
                  cliLogger.error('TOOL', 'write_file_stream 发送失败', err);
                  this.emitWriteCardDebug('write_file_stream_emit_failed', {
                    toolId,
                    error: err instanceof Error ? err.message : String(err),
                  });
                }

                await this.handleWriteFile(
                  resolvedWritePath,
                  realArgs.content,
                  undefined
                );
              } else if (normalizedRealName === 'write_file' || normalizedRealName === 'write') {
                this.emitWriteCardDebug('write_finalize_skipped', {
                  toolId,
                  success: event.success !== false,
                  hasPath: Boolean(resolvedWritePath),
                  hasContent: Boolean(realArgs?.content),
                });
              }

              /** 开始处理 edit file的工具 调用 这里是存储session的  **/
              if (isEditTool && effectiveSuccess && this.sessionSync && this.sessionEnabled) {
                try {
                  const result = parsedOutput;
                  const hunks = Array.isArray(result.metadata?.hunks) ? result.metadata.hunks : [];

                  if (result.status === 'success' && result.file_path) {
                    const edits: FileEditSnapshotItem[] = [];
                    const argOld = realArgs?.old_string || realArgs?.old_str || '';
                    const argNew = realArgs?.new_string || realArgs?.new_str || '';
                    if (hunks.length > 0) {
                      for (const hunk of hunks) {
                        const oldPreview = typeof hunk?.old_preview === 'string' ? hunk.old_preview : argOld;
                        const newPreview = typeof hunk?.new_preview === 'string' ? hunk.new_preview : argNew;
                        edits.push({
                          type: 'file_edit_snapshot',
                          data: {
                            filePath: result.file_path,
                            oldString: oldPreview,
                            newString: newPreview,
                            startLine: hunk.start_line,
                            oldLineCount: hunk.old_line_count,
                            newLineCount: hunk.new_line_count,
                            replaceAll: false,
                            replacementCount: 1,
                          },
                        });
                      }
                    } else {
                      // Fallback: 直接用 tool args
                      edits.push({
                        type: 'file_edit_snapshot',
                        data: {
                          filePath: result.file_path,
                          oldString: argOld,
                          newString: argNew,
                          startLine: result.metadata?.start_line || 1,
                          oldLineCount: result.metadata?.old_lines || 0,
                          newLineCount: result.metadata?.new_lines || 0,
                          replaceAll: (result.metadata?.replacements || 1) > 1,
                          replacementCount: result.metadata?.replacements || 1,
                        },
                      });
                    }
                    await this.sessionSync.getSession().addItems(edits);
                  }
                } catch {
                  // ignore
                  cliLogger.error('TOOL', "session的edit file 保存失败 ");
                }
              }

              if (isEditTool) {
                try {
                  const result = parsedOutput;
                  if (!result || result.status !== 'success') {
                    // edit 失败/already_done 不发 diff 卡，交给 tool_result/tool_error 展示
                    this.emitEvent({
                      type: 'tool_output',
                      name: event.name,
                      output: outputString,
                      success: effectiveSuccess,
                      toolId,
                    });
                    if (toolId) {
                      this.recentToolCalls.delete(toolId);
                    }
                    break;
                  }
                  const filePath = result.file_path || realArgs?.file_path || realArgs?.path || realArgs?.target_file || '';
                  if (filePath) {
                    const argOldStr = realArgs?.old_string || realArgs?.old_str || realArgs?.oldString || '';
                    const argNewStr = realArgs?.new_string || realArgs?.new_str || realArgs?.newString || '';
                    const metadataHunks = Array.isArray(result.metadata?.hunks) ? result.metadata.hunks : [];
                    const hunksPayload = metadataHunks
                      .map((hunk: any) => ({
                        oldString: typeof hunk?.old_preview === 'string' ? hunk.old_preview : argOldStr,
                        newString: typeof hunk?.new_preview === 'string' ? hunk.new_preview : argNewStr,
                        startLine: typeof hunk?.start_line === 'number'
                          ? hunk.start_line
                          : (result.metadata?.start_line || realArgs?.start_line || realArgs?.startLine || 1),
                        oldLineCount: typeof hunk?.old_preview_lines === 'number'
                          ? hunk.old_preview_lines
                          : (typeof hunk?.old_line_count === 'number' ? hunk.old_line_count : undefined),
                        newLineCount: typeof hunk?.new_preview_lines === 'number'
                          ? hunk.new_preview_lines
                          : (typeof hunk?.new_line_count === 'number' ? hunk.new_line_count : undefined),
                        oldCharCount: typeof hunk?.old_preview_chars === 'number' ? hunk.old_preview_chars : undefined,
                        newCharCount: typeof hunk?.new_preview_chars === 'number' ? hunk.new_preview_chars : undefined,
                        previewTruncated: Boolean(hunk?.preview_truncated),
                      }))
                      .filter((hunk: any) => typeof hunk.startLine === 'number');
                    const firstHunk = hunksPayload[0];
                    const oldStr = firstHunk?.oldString ?? argOldStr;
                    const newStr = firstHunk?.newString ?? argNewStr;
                    const startLine = firstHunk?.startLine ?? result.metadata?.start_line ?? realArgs?.start_line ?? realArgs?.startLine ?? 1;
                    const previewTruncated = Boolean(
                      result.metadata?.preview_truncated
                      || hunksPayload.some((hunk: any) => Boolean(hunk?.previewTruncated))
                    );
                    const hunksOmitted = Number.isFinite(Number(result.metadata?.hunks_omitted))
                      ? Math.max(0, Number(result.metadata?.hunks_omitted))
                      : 0;

                    const ext = filePath.split('.').pop()?.toLowerCase() || '';
                    const langMap: Record<string, string> = {
                      ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
                      py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
                      java: 'java', kt: 'kotlin', swift: 'swift',
                      c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
                      css: 'css', scss: 'scss', less: 'less',
                      html: 'html', vue: 'vue', svelte: 'svelte',
                      json: 'json', yaml: 'yaml', yml: 'yaml',
                      md: 'markdown', sql: 'sql', sh: 'bash',
                    };
                    this.emitEvent({
                      type: 'edit_file_stream',
                      filePath,
                      oldString: oldStr,
                      newString: newStr,
                      startLine,
                      toolId,
                      previewTruncated,
                      hunksOmitted,
                      hunks: hunksPayload.length > 0 ? hunksPayload : undefined,
                      isComplete: true,
                      success: true,
                      language: langMap[ext] || ext,
                      timestamp: Date.now(),
                    });
                  }
                } catch {
                  cliLogger.error('TOOL', "edit file stream 发送失败 ");
                }
              }

              this.emitEvent({
                type: 'tool_output',
                name: event.name,
                /* 卡片正文走的是这一条 (不是上面的 outputPreview) —— 同样要摘掉失败尾标 */
                output: outputString,
                success: effectiveSuccess,
                toolId,
              });

              if (toolId) {
                this.recentToolCalls.delete(toolId);
              }


            }
            break;

          case 'token_usage':
            /* 只留最后一张快照, 结算推迟到请求边界 —— 见 settlePendingUsage 的长注释。
             * (runner 每个带 usage 的 chunk 都发一次, 且带的是累计值不是增量) */
            pendingUsageEvent = event;
            break;

          case 'context_compaction': {
            const compEvt = event as any;
            this.emitEvent({
              type: 'context_compaction',
              status: compEvt.status,
              originalMessages: compEvt.originalMessages,
              keptMessages: compEvt.keptMessages,
              droppedMessages: compEvt.droppedMessages,
              compressedMessages: compEvt.compressedMessages,
              originalTokens: compEvt.originalTokens,
              finalTokens: compEvt.finalTokens,
              budgetTokens: compEvt.budgetTokens,
              useLLM: compEvt.useLLM,
              timestamp: compEvt.timestamp ?? Date.now(),
              compression: compEvt.compression,
              tokensIncludeOverhead: compEvt.tokensIncludeOverhead,
            });

            // 桶级进度 → emitCompacting 给 CLI 显示
            if (compEvt.status === 'compressing' && compEvt.compression) {
              const c = compEvt.compression;
              const bucketLines = (c.buckets || [])
                .filter((b: any) => b.status !== 'empty')
                .map((b: any) => {
                  const icon = b.status === 'done' ? '✓' : b.status === 'compressing' ? '●' : '○';
                  const items = b.items?.slice(0, 3).join(', ') || '';
                  return `${icon} ${b.label} (${b.messageCount} msgs)${items ? ': ' + items : ''}`;
                })
                .join('\n');
              this.emitCompacting(
                `Compressing ${c.completedBuckets}/${c.totalBuckets} (${c.summaryModel})`,
                bucketLines,
              );
            } else if (compEvt.status === 'started') {
              this.emitCompacting(
                'Context compression started',
                `${compEvt.originalTokens?.toLocaleString()} tokens → target ${compEvt.budgetTokens?.toLocaleString()}`,
              );
            }
            break;
          }

          case 'raw_response_event':
            if (event.event_type === 'runner.stream_retry') {
              const r = runnerStreamRetryToUi(event.data, fullResponse); const gone = r.event.discardedText; fullResponse = r.fullResponse; lastAssistantMessage = dropDiscardedTail(lastAssistantMessage, gone); currentTurnText = dropDiscardedTail(currentTurnText, gone); reportProxyUnreachableFromErrorText(r.event.error); this.emitEvent(r.event);
            } else if (event.event_type === 'input_guardrails.check_start') {
              this.emitEvent({ type: 'status', status: 'thinking', message: 'Checking input guardrails...' });
            } else if (event.event_type === 'output_guardrails.check_start') {
              this.emitEvent({ type: 'status', status: 'thinking', message: 'Checking output guardrails...' });
            } else if (event.event_type === 'structured_output.retry') {
              this.emitEvent({ type: 'text_complete' });
              fullResponse = '';
              const info =
                Array.isArray(event.data?.errors) && event.data.errors.length > 0
                  ? event.data.errors.join('; ')
                  : event.data?.message;
              this.emitLog('warn', 'Structured output validation failed', info);
              this.emitEvent({ type: 'status', status: 'error', message: 'Structured output invalid, retrying...' });
            } else if (event.event_type === 'structured_output.accepted') {
              if (typeof event.data?.normalized_text === 'string') {
                fullResponse = event.data.normalized_text;
              }
              this.emitLog(
                'info',
                'Structured output ready',
                event.data?.schema ? `Schema: ${event.data.schema}` : undefined
              );
            } else if (event.event_type === 'error.classified') {
              // Forward classified error for UI to show detailed error info and retry button
              // NOTE: Don't call emitLog here - error_classified event handler in runtimeEvents.ts
              // will add to timeline. The subsequent 'error' event will also be emitted by runner,
              // which we handle separately.
              const errorData = event.data as {
                category?: string;
                code?: string;
                message?: string;
                suggestion?: string;
                retryable?: boolean;
                context?: Record<string, unknown>;
              };
              /* 终态也报一次: 有些路径 (非重试类错误) 不经过 stream_retry, 那这里是唯一的机会。 */
              reportProxyUnreachableFromErrorText(errorData.message);
              // Only emit error_classified event, let runtimeEvents.ts handle the timeline display
              this.emitEvent({
                type: 'error_classified',
                category: errorData.category || 'INTERNAL',
                code: errorData.code || 'UNKNOWN_ERROR',
                message: errorData.message || 'An unknown error occurred',
                suggestion: errorData.suggestion,
                retryable: errorData.retryable ?? false,
              });
            } else if (event.event_type === 'context_compaction') {
              const compactionData = event.data as {
                originalMessages?: number;
                keptMessages?: number;
                droppedMessages?: number;
                compressedMessages?: number;
                originalTokens?: number;
                finalTokens?: number;
                budgetTokens?: number;
                useLLM?: boolean;
              };

              // 更新内存压力监控
              if (this.memoryPressure && compactionData.finalTokens !== undefined) {
                // 重新基于压缩后的消息计算上下文
                const snapshot = this.memoryPressure.setPromptEstimateFromMessages(this.memory.getMessagesForLLM());
                void this.handleMemorySnapshot(snapshot, true); // skipCompaction=true
              }

              // 显示压缩日志
              const dropped = compactionData.droppedMessages || 0;
              const compressed = compactionData.compressedMessages || 0;
              if (dropped > 0 || compressed > 0) {
                const savedTokens = (compactionData.originalTokens || 0) - (compactionData.finalTokens || 0);
                const method = compactionData.useLLM ? '智能压缩' : '裁剪';
                this.emitLog(
                  'info',
                  `▸ 上下文${method}`,
                  `移除 ${dropped} 条消息${compressed > 0 ? `，压缩 ${compressed} 条` : ''}，节省约 ${savedTokens.toLocaleString()} tokens`
                );
                this.emitEvent({ type: 'status', status: 'compacting', message: `Context compacted: -${dropped} messages` });
              }
            } else if (event.event_type === 'response.completed') {
              if (process.env.CLI_DEBUG_CONSOLE === '1') {
                cliLogger.debug('EVENTS', '📤 Forwarding response.completed');
              }
              this.emitEvent({
                type: 'raw_response_event',
                data: event.data,
                event_type: event.event_type,
              });
            } else if (event.event_type === 'target.continuation') {
              /* Target 闸门拦住 no-tool 退出 → 转发给桌面画分隔线 (同 compaction 通道). */
              this.emitEvent({
                type: 'raw_response_event',
                data: event.data,
                event_type: event.event_type,
              });
            }
            break;

          case 'run_done':
            getBrowserSession().endTurn(this.runtimeSessionId || this.session?.sessionId);
            _turnMetrics.flush(this.runtimeSessionId || this.session?.sessionId || '_anonymous', undefined, this.model);
            break;

          case 'error':
            hadRunnerError = true;
            //   run_done 的 flush 会带上。补上"这轮因推理失败而空转"的可观测性盲区。
            _turnMetrics.onTurnError(event.error || 'unknown error');
            cliLogger.error('AGENT', `Error: ${event.error || 'Unknown error'}`);
            // Emit error event for Timeline rendering (this is the ONLY place that adds to timeline)
            this.emitEvent({ type: 'error', message: event.error || 'Unknown error', code: (event as { code?: string }).code });
            // Also emit status for status bar
            this.emitEvent({ type: 'status', status: 'error', message: `Error: ${event.error || 'Unknown error'}` });
            // NOTE: Don't call emitLog here - it would add a duplicate timeline entry
            break;

          // Handle stream retry events from LLM provider
          case 'stream_retry':
            /* 第一次重试就把"代理端口拒连"报给 systemProxy —— 越早纠正, 用户越少看到红卡。
             * 代理没变/不是代理地址时它是空操作 (判据见 reportProxyUnreachable)。 */
            reportProxyUnreachableFromErrorText(event.error);
            // Only emit stream_retry (emitLog here would duplicate the timeline entry the frontend creates)
            this.emitEvent({
              type: 'stream_retry',
              error: event.error,
              errorCode: event.errorCode || 'STREAM_ERROR',
              attempt: event.attempt,
              maxRetries: event.maxRetries,
              delayMs: event.delayMs,
            });
            break;

          case 'stream_recovered':
            this.emitEvent({
              type: 'stream_recovered',
              attempt: event.attempt,
              maxRetries: event.maxRetries,
            });
            break;

          case 'plan_update':
            cliLogger.info('RUNTIME_HOST', '🔥 Forwarding plan_update event', {
              hasExplanation: !!event.explanation,
              planSteps: event.plan?.length,
            });
            this.emitEvent({
              type: 'plan_update',
              explanation: event.explanation,
              plan: event.plan,
              timestamp: event.timestamp || Date.now(),
            });
            break;
        }
      }

      /* 请求边界 ②: 最后一次请求后面没有 iteration_start 了 —— 在这里收尾结算。
       * 漏了这一句, 每次 run 的最后一个请求用量就整个丢掉 (且 sawProviderUsage 仍为 false,
       * 会误触发下面那条"provider 没回 usage"的估算兜底, 用估算值顶掉真值)。 */
      await settlePendingUsage();

      if (process.env.CLI_DEBUG === '1') {
        cliLogger.debug('TASK', `=== runner.run loop COMPLETED ===`);
        cliLogger.debug('TASK', `  Total events: ${eventCount}`);
        cliLogger.debug('TASK', `  stdin.isPaused: ${process.stdin.isPaused?.()}`);
      }

      this.emitEvent({ type: 'text_complete' });
      const duration = Date.now() - startTime;

      // 返回给前端/持久化时使用的最终文本
      const outputForReturn = fullResponse;

      const runFailed = hadRunnerError && !this.shouldInterrupt;

      if (!sawProviderUsage && !runFailed && !this.shouldInterrupt && runEstimatedOutputTokens > 0) {
        try {
          const estimatedPromptTokens = this.memoryPressure
            ? this.memoryPressure.estimateMessagesForDisplay(this.memory.getMessagesForLLM())
            : 0;
          this.sessionTotalInputTokens += estimatedPromptTokens;
          this.sessionTotalOutputTokens += runEstimatedOutputTokens;
          totalTokens = estimatedPromptTokens + runEstimatedOutputTokens;
          this.emitEvent({
            type: 'token_usage',
            model: this.model,
            promptTokens: estimatedPromptTokens,
            completionTokens: runEstimatedOutputTokens,
            totalTokens,
            contextTokens: estimatedPromptTokens,
            runtimeSessionId: this.runtimeSessionId || this.session?.sessionId || '_anonymous',
            agentName: this.agentName,
            agentDescription: this.agentDescription,
            configuredToolCount: this.configuredToolCount,
            sessionPromptTokens: this.sessionTotalInputTokens,
            sessionCompletionTokens: this.sessionTotalOutputTokens,
            usageEstimated: true,
          });
          cliLogger.debug('AGENT_HOST',
            `provider returned no usage — emitted estimated token_usage (prompt≈${estimatedPromptTokens}, output≈${runEstimatedOutputTokens})`);
        } catch { /* 估算兜底失败不影响 run 收尾 */ }
      }

      if (this.shouldInterrupt) {
        /* 与 catch 中断路径对齐: 先 flush 文本槽, 再标 status, 最后 run_result.
         * 否则 pacer 里的半段文字可能丢失, UI 也收不到 interrupted 标志. */
        this.emitEvent({ type: 'text_complete' });
        /* 有 reason 就如实说 —— 光写 "Task interrupted" 会让超时/父级停止/预算熔断
         * 三种完全不同的事在下游长成一个样, 上层只能当"用户不想跑了"处理。 */
        this.emitEvent({
          type: 'status',
          status: 'error',
          message: this.interruptReason
            ? `${INTERRUPT_STATUS_LABEL}: ${this.interruptReason}`
            : INTERRUPT_STATUS_LABEL,
        });
      } else if (runFailed) {
        this.emitEvent({ type: 'status', status: 'error', message: 'Task failed' });
        notifyTurnEnd('StopFailure', this.session?.sessionId, currentIteration, toolCallCount, totalTokens, duration);
      } else {
        this.emitEvent({ type: 'status', status: 'complete', message: 'Complete!' });
        notifyTurnEnd('Stop', this.session?.sessionId, currentIteration, toolCallCount, totalTokens, duration);
        this.emitLog(
          'info',
          'Task complete',
          `${currentIteration} iterations, ${toolCallCount} tool calls, ${totalTokens} tokens, ${(duration / 1000).toFixed(2)}s`
        );
      }
      //    和增量 flush 共用 lastPersistedMemoryLen 指针,不会重复保存。
      //    增量 flush 平时 debounce 250ms,这里做最终确认。
      //    走 SessionContext 单源, 不再依赖 sessionSync 是否就绪.
      if (this.sessionEnabled && this.session?.sessionId) {
        try {
          await this.flushPersistImmediate();
        } catch (err: any) {
          cliLogger.debug('AGENT_HOST', `Non-critical final persist: ${err?.message}`);
        }
      }

      if (neoxLogger.isEnabled()) {
        if (currentIteration > 0) {
          const lastIterMs = Date.now() - _iterStartTime;
          neoxLogger.info('PERF', `◼ Iter #${currentIteration} END (final)`, {
            durationMs: lastIterMs,
            toolCalls: _iterToolCount,
            toolTotalMs: _iterToolTotalMs,
            textChars: _iterTextChars,
          });
        }
        neoxLogger.info('PERF', `━━━ Task END ━━━`, {
          totalDurationMs: duration,
          totalIterations: currentIteration,
          totalToolCalls: toolCallCount,
          totalTokens,
          avgIterMs: currentIteration > 0 ? Math.round(duration / currentIteration) : 0,
          avgToolMs: toolCallCount > 0 ? Math.round(_iterToolTotalMs / toolCallCount) : 0,
          failed: runFailed,
          interrupted: this.shouldInterrupt,
        });
      }

      /* 最后一次请求没有下一个 iteration_start 来结算, 在这里补上 */
      _pushIterPerf();

      const summary: RunTaskResult = {
        output: outputForReturn,
        totalTokens,
        durationMs: duration,
        iterations: currentIteration,
        toolCalls: toolCallCount,
        interrupted: this.shouldInterrupt,
        failed: runFailed,
      };
      this.emitEvent({
        type: 'run_result',
        output: outputForReturn,
        currentTurnText,
        iterationPerf: _iterPerf,
        totalTokens,
        iterations: currentIteration,
        toolCalls: toolCallCount,
        durationMs: duration,
        failed: runFailed,
        interrupted: this.shouldInterrupt,
        interruptReason: this.interruptReason ?? undefined,
      });

      return summary;
    } catch (error: any) {
      // Check if this is a cancellation error (user interrupt)
      const isCanceled = error?.code === 'ERR_CANCELED' ||
        error?.name === 'CanceledError' ||
        error?.name === 'AbortError' ||
        error?.category === 'canceled';

      if (isCanceled || this.shouldInterrupt) {
        // Treat cancellation as a normal interrupt, not an error
        this.emitEvent({ type: 'text_complete' });
        /* 跟上面 shouldInterrupt 那条收尾对齐: 有 reason 就如实带上。
         * 日志也不许写死 "by user" —— 这条路更常见的来客是取消/超时/看门狗, 不是用户。 */
        this.emitEvent({
          type: 'status',
          status: 'error',
          message: this.interruptReason
            ? `${INTERRUPT_STATUS_LABEL}: ${this.interruptReason}`
            : INTERRUPT_STATUS_LABEL,
        });
        this.emitLog('info', this.interruptReason
          ? `Task interrupted: ${this.interruptReason}`
          : 'Task interrupted (原因未记录)');

        const duration = Date.now() - startTime;

        // UI 的 handleRunResult 是唯一设置 streaming=false + status='Ready' 的地方
        // 不发此事件会导致 UI 永远卡在 "Interrupting... RUNNING" 状态
        this.emitEvent({
          type: 'run_result',
          output: fullResponse,
          currentTurnText,
          totalTokens,
          iterations: currentIteration,
          toolCalls: toolCallCount,
          durationMs: duration,
          failed: false,
          interrupted: true,
          /* 这条路更常见的来客是取消/超时/看门狗, 不是用户 —— 原样带上, 别让界面猜 */
          interruptReason: this.interruptReason ?? undefined,
        });

        return {
          output: fullResponse,
          totalTokens,
          durationMs: duration,
          iterations: currentIteration,
          toolCalls: toolCallCount,
          interrupted: true,
        };
      }

      const errorMsg = error?.message || String(error) || 'Unknown error';
      this.emitEvent({ type: 'text_complete' });
      this.emitEvent({ type: 'status', status: 'error', message: `Error: ${errorMsg}` });
      try {
        this.emitEvent({ type: 'error', message: errorMsg, code: typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : undefined });
      } catch { /* ignore */ }
      try {
        const finalDuration = Date.now() - startTime;
        this.emitEvent({
          type: 'run_result',
          output: '',
          totalTokens: 0,
          iterations: currentIteration,
          toolCalls: toolCallCount,
          durationMs: finalDuration,
          failed: true,
          interrupted: false,
        });
      } catch { /* ignore */ }
      this.emitLog('error', `Error: ${errorMsg}`);

      throw error;
    } finally {
      /* 请求边界 ③ (兜底): 异常 / abort 从事件循环里直接抛出来时, 上面那两处都够不着。
       * 用量少记等于费用少记, 所以崩了也要把最后一张快照结算掉。settle 自带幂等
       * (结算后置空), 正常路径走到这儿是 no-op。 */
      try { await settlePendingUsage(); } catch { /* 收尾结算失败不能盖住原始异常 */ }

      if (process.env.CLI_DEBUG) {
        cliLogger.debug('TASK', '=== runTask finally block START ===');
        cliLogger.debug('TASK', `  isRunning was: ${this.isRunning}`);
      }

      try {
        if (this.recentToolCalls.size > 0) {
          const orphanIds = Array.from(this.recentToolCalls.keys());
          cliLogger.warn('TASK', `[SAFETY_NET] Sweeping ${orphanIds.length} orphan tool calls in finally`);
          for (const toolId of orphanIds) {
            const info = this.recentToolCalls.get(toolId);
            if (!info) continue;
            this.emitEvent({
              type: 'tool_call_end',
              name: info.toolName || 'unknown',
              success: false,
              resultLength: 0,
              timestamp: Date.now(),
              toolId,
              batchId: info.batchId,
              targetPath: info.targetPath,
              summary: 'Tool execution terminated without producing a result',
              output: '[orphan tool call — runtime exited before tool_output arrived]',
              outputTruncated: false,
              args: info.args,
            });
          }
          this.recentToolCalls.clear();
        }
      } catch (sweepErr: any) {
        cliLogger.warn('TASK', `[SAFETY_NET] Orphan sweep failed: ${sweepErr?.message ?? sweepErr}`);
      }

      if (shouldOverrideMode) {
        this.runner.setMode(previousMode);
      }
      /* 费用保险丝订阅随 run 生命周期释放 (见 run 开头的 offBudgetFuse 挂载) */
      offBudgetFuse?.();
      offBudgetFuse = null;
      this.isRunning = false;
      /* 排队插话没被消费就走到了收尾 (中断/异常; 自然收束已被 run-end drain 接走) →
       * 丢弃引擎侧队列, 防滞留到下一轮开头被意外注入。渲染端会把残留排队条放回输入框。 */
      if (this.pendingInjectedMessages.length > 0) {
        cliLogger.info('INJECT', `Dropping ${this.pendingInjectedMessages.length} unconsumed queued message(s) at run end (interrupted/failed)`);
        const discarded = this.getAndClearPendingMessages();
        for (let i = 0; i < discarded.length; i++) {
          const message = discarded[i];
          this.emitEvent({
            type: 'queued_message_removed', text: message.text, images: message.images,
            reason: 'interrupted', remaining: discarded.length - i - 1,
          });
        }
      }
      // 如果不 abort，任何仍在等待的异步操作（如 anthropic.ts 的重试 sleep、
      // axios 请求、超时计时器等）不会收到取消信号，可能在 runTask 结束后
      // 发起幽灵请求（Ghost Retry），导致工具在 "Run completed" 后继续执行。
      if (this.abortController && !this.abortController.signal.aborted) {
        this.abortController.abort();
      }
      this.abortController = null;
      getBrowserSession().stopForSession(this.runtimeSessionId || this.session?.sessionId);
      this.clearInterruptPromise();

      // 中断时可能有 assistant(tool_calls) 但没有对应的 tool_result，
      // 这会导致下次 LLM 调用时 API 返回 400 错误
      if (this.shouldInterrupt) {
        try {
          const messages = this.memory.getAll();
          const lastMsg = messages[messages.length - 1];
          if (lastMsg?.role === 'assistant' && lastMsg.tool_calls && lastMsg.tool_calls.length > 0) {
            // 检查哪些 tool_call 没有对应的 tool_result
            const toolCallIds = new Set(lastMsg.tool_calls.map((tc: any) => tc.id));
            const existingResultIds = new Set(
              messages.filter(m => m.role === 'tool' && m.tool_call_id).map(m => m.tool_call_id)
            );
            for (const tc of lastMsg.tool_calls) {
              if (!existingResultIds.has(tc.id)) {
                this.memory.addToolResult(
                  tc.id,
                  tc.function?.name || 'unknown',
                  '[tool interrupted by user]'
                );
                cliLogger.info('TASK', `Filled dangling tool_call: ${tc.function?.name} (${tc.id})`);
              }
            }
          }
        } catch (e: any) {
          cliLogger.warn('TASK', 'Memory integrity repair failed', { error: e.message });
        }
      }

      // This makes compaction part of the task flow, not a cleanup step

      this.flushAllPendingBatches();

      if (process.env.CLI_DEBUG) {
        cliLogger.debug('TASK', '=== runTask finally block END ===');
      }
    }
  }

  private syncWorkspaceEnv(): void {
    if (this.workDir) {
      process.env.NEOX_WORKDIR = this.workDir;
    }
    //    shell env 据此设 TMPDIR, sandbox 用作可写 tmp。会话切换时随之更新。
    try {
      const sid = this.session?.sessionId ?? this.sessionSeed;
      if (sid) activateSessionScratch(sid);
    } catch {
      /* 非致命 */
    }
  }

  async listSessions(): Promise<Awaited<ReturnType<DefaultSessionManager['listSessions']>>> {
    return this.sessionManager.listSessions();
  }

  getCurrentSessionId(): string | undefined {
    return this.session?.sessionId;
  }

  async getSessionInfo(): Promise<{
    sessionId: string;
    turnCount: number;
    messageCount: number;
    checkpointCount: number;
    meta: any;
  }> {
    if (!this.sessionSync) {
      throw new Error('Session is not ready');
    }
    return this.sessionSync.getSessionInfo();
  }

  /**
   * 发送 file_stream 事件（仅用于 UI 显示预览）
   * 不实际写入文件 - 文件写入由工具执行时完成
   */
  private async emitFileStreamEvent(filePath: string, content: string, description?: string, toolId?: string): Promise<void> {
    const ext = filePath.split('.').pop() || '';
    const langMap: Record<string, string> = {
      js: 'javascript',
      ts: 'typescript',
      tsx: 'typescript',
      py: 'python',
      html: 'html',
      css: 'css',
      json: 'json',
      md: 'markdown',
    };
    const language = langMap[ext] || ext;
    const eventTimestamp = Date.now();

    // 不实际写入文件 - 等待权限检查和工具执行
    this.emitEvent({
      type: 'file_stream',
      filePath,
      content,
      isComplete: false,
      language,
      description,
      timestamp: eventTimestamp,
    });
    this.emitWriteCardDebug('file_stream_preview_emitted', {
      toolId: toolId || '',
      filePath,
      contentChars: content.length,
      isComplete: false,
    });
  }

  /**
   * 处理文件写入（由工具执行完成后调用，用于 session 快照）
   * 注意：实际的文件写入由 write_file 工具完成
   */

  /**
   * 处理文件写入后的 session 快照和完成事件
   * 注意：实际的文件写入已由 write_file 工具完成
   * 这个方法在 tool_output 事件中被调用，用于记录 session 快照
   */
  private async handleWriteFile(filePath: string, content: string, description?: string): Promise<void> {
    const ext = filePath.split('.').pop() || '';
    const langMap: Record<string, string> = {
      js: 'javascript',
      ts: 'typescript',
      tsx: 'typescript',
      py: 'python',
      html: 'html',
      css: 'css',
      json: 'json',
      md: 'markdown',
    };
    const language = langMap[ext] || ext;
    const eventTimestamp = Date.now();
    this.emitWriteCardDebug('handle_write_file_start', {
      filePath,
      contentChars: content.length,
    });

    try {
      const fs = await import('fs');
      const path = await import('path');
      const absolutePath = path.isAbsolute(filePath)
        ? path.resolve(filePath)
        : path.resolve(this.workDir, filePath);

      // 文件已经由 write_file 工具写入
      if (this.sessionSync && this.sessionEnabled) {
        try {
          let originalContent: string | null = null;
          let operation: 'create' | 'modify' = 'create';

          // 检查文件是否已存在（已被 write_file 工具写入）
          if (fs.existsSync(absolutePath)) {
            // 如果文件存在，我们无法获取原始内容（已被覆盖）
            // 所以标记为 modify
            operation = 'modify';
            originalContent = null; // 无法恢复原始内容
          }

          const snapshot: FileSnapshotItem = {
            type: 'file_snapshot',
            data: {
              filePath,
              originalContent,
              operation,
              newContent: content,
            },
          };

          await this.sessionSync.getSession().addItems([snapshot]);
        } catch (error) {
          console.debug('Failed to capture file snapshot', error);
        }
      }

      // 文件写入完成（已由工具完成），发出完成事件
      this.emitEvent({
        type: 'file_stream',
        filePath,
        content,
        isComplete: true,
        language,
        description,
        timestamp: eventTimestamp,
      });
      this.emitWriteCardDebug('file_stream_complete_emitted', {
        filePath,
        contentChars: content.length,
        isComplete: true,
      });
      // this.emitLog('info', `✓ Saved ${filePath}`, `${content.split('\n').length} lines written to disk`);
    } catch (error: any) {
      // 错误时也发出完成事件（带错误标记）
      this.emitEvent({
        type: 'file_stream',
        filePath,
        content,
        isComplete: true,
        language,
        description,
        timestamp: eventTimestamp,
      });
      this.emitWriteCardDebug('file_stream_complete_emitted_with_error', {
        filePath,
        contentChars: content.length,
        error: error?.message || String(error),
      });
      this.emitLog('error', `Error handling file write: ${error.message}`);
    }
  }

  async switchSession(sessionId: string): Promise<Session> {
    const session = await this.sessionManager.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    this.session = session;
    return this.session;
  }

  async createSession(model?: string): Promise<Session> {
    const session = await this.sessionManager.createSession({ model: model || this.model });
    this.session = session;
    notifyHook('SessionStart', { session_id: session.sessionId, model: model || this.model });
    return session;
  }

  async undoTurns(count: number = 1): Promise<UndoResult> {
    if (!this.sessionSync) {
      throw new Error('Session is not ready');
    }
    return this.sessionSync.undo(count);
  }

  async createCheckpoint(name?: string): Promise<string> {
    if (!this.sessionSync) {
      throw new Error('Session is not ready');
    }
    const checkpointId = await this.sessionSync.createCheckpoint(name);
    this.emitEvent({ type: 'checkpoint', id: checkpointId });
    return checkpointId;
  }

  async listCheckpoints(): Promise<CheckpointItem[]> {
    if (!this.sessionSync) {
      throw new Error('Session is not ready');
    }
    const checkpoints = await this.sessionSync.getSession().getCheckpoints();
    return checkpoints as unknown as CheckpointItem[];
  }

  async rollbackTo(checkpointId: string): Promise<RollbackResult> {
    if (!this.sessionSync) {
      throw new Error('Session is not ready');
    }
    return this.sessionSync.rollback(checkpointId);
  }

  async clearSession(): Promise<void> {
    if (this.sessionSync) {
      await this.sessionSync.clearSession();
    }
    this.memory.clear();
  }

  async compactSession(): Promise<void> {
    if (!this.sessionSync) {
      const sid = this.session?.sessionId;
      if (sid) {
        try { await this.ensureSessionSync(sid); } catch (e: any) {
          cliLogger.warn('COMPACT', `ensureSessionSync failed: ${e?.message || e}`);
        }
      }
    }
    if (!this.compatProfile && this.model) {
      this.compatProfile = resolveCompatProfile(this.model);
      cliLogger.info('COMPACT', `lazily resolved compatProfile for model=${this.model} (ctx=${this.compatProfile?.contextWindow})`);
    }
    if (!this.sessionSync || !this.compatProfile) {
      /* 懒初始化后仍不可用 → 给可操作的清晰消息(已透传到 toast) */
      throw new Error(
        '压缩暂不可用:会话尚未初始化。请先发送一条消息(运行一轮)后再压缩。',
      );
    }

    /* PreCompact —— 压缩**之前**, 唯一能在细节被丢掉前把东西捞出来的时机 */
    await preCompactGate(this.session?.sessionId, this.memory.getAll().length);

    const session = this.sessionSync.getSession();

    // 使用统一的 token 估算函数（与 memoryPressure 一致）
    const currentMessages = this.memory.getAll();

    const breakdown = calculateTokenBreakdown(currentMessages);

    const totalContextTokens = breakdown.totalTokens;
    const systemPromptTokens = breakdown.systemTokens;
    const dialogTokens = breakdown.userTokens + breakdown.assistantTokens + breakdown.toolCallTokens + breakdown.toolResultTokens;

    // 从 memoryPressure 获取 context window 信息
    const currentSnapshot = this.memoryPressure?.getSnapshot();
    const contextWindow = currentSnapshot?.profile?.contextWindow || 200000;

    const realBefore = Math.max(
      totalContextTokens,
      currentSnapshot?.promptTokens || currentSnapshot?.tokensUsed || 0,
    );
    const incompressibleOverhead = Math.max(0, realBefore - totalContextTokens);

    const pressure = realBefore / contextWindow;
    const percentageUsed = Math.round(pressure * 100);

    const timeline = await session.getTimeline();
    const messageEntries = timeline.filter((entry) => entry.item.type === 'message');

    if (process.env.CLI_DEBUG === '1') {
      cliLogger.debug('COMPACT', 'Compaction status', {
        llmProvider: !!this.llmProvider,
        totalContextTokens,
        systemPromptTokens,
        dialogTokens,
        breakdown,
        messageCount: messageEntries.length,
        memoryMessageCount: currentMessages.length,
        contextWindow,
        pressure,
      });
    }

    const detailText = `总 Context: ${realBefore.toLocaleString()} tokens (${percentageUsed}% 使用)\n系统提示词: ${systemPromptTokens.toLocaleString()} tokens\n对话历史: ${dialogTokens.toLocaleString()} tokens (Memory: ${currentMessages.length - 1} 条, Session: ${messageEntries.length} 条)\n方式: LLM 智能压缩`;

    this.emitCompacting('正在压缩上下文', detailText);

    let result: { originalTokens: number; compressedTokens: number; savedTokens: number;
      originalCount: number; compressedCount: number;
      stats?: { droppedMessages?: number; llmCompressedMessages?: number } } | null = null;

    if (!this.llmProvider) {
      const errorMsg = 'LLM Provider 未初始化，无法进行智能压缩。请确保已配置 provider。';
      this.emitLog('error', '❌ 压缩失败', errorMsg);
      throw new Error(errorMsg);
    }

    try {
      const compactor = (this.runner as any)?.compactNow as
        | ((trigger: 'auto' | 'recovery', onProgress?: (p: any) => void) => Promise<any>)
        | undefined;
      if (!compactor) throw new Error('runner.compactNow unavailable');
      result = await compactor.call(this.runner, 'recovery', (p: any) => {
        if (p?.phase === 'categorizing') this.emitCompacting('◆ 分析中', '按类别分组对话历史…');
        else if (p?.phase === 'compressing' && p.totalBuckets) {
          this.emitCompacting(
            `⚡ 生成摘要 ${p.completedBuckets}/${p.totalBuckets} 组`,
            p.summaryModel ? `model ${p.summaryModel}` : undefined,
          );
          this.emitEvent({
            type: 'context_compaction',
            status: 'compressing',
            originalTokens: realBefore,
            budgetTokens: contextWindow,
            useLLM: true,
            timestamp: Date.now(),
            tokensIncludeOverhead: true,
            compression: {
              phase: p.phase,
              totalBuckets: p.totalBuckets,
              completedBuckets: p.completedBuckets ?? 0,
              buckets: p.buckets ?? [],
              summaryModel: p.summaryModel,
            },
          } as any);
        } else if (p?.phase === 'done') this.emitCompacting('▸ 保存中', '');
      });

      if (result) {
        const useLLM = (result.stats?.llmCompressedMessages ?? 0) > 0;
        const finalBreakdown = calculateTokenBreakdown(this.memory.getAll());
        const finalTokensWithOverhead = estimatePostCompactContext({
          postEstimate: finalBreakdown.totalTokens,
          preEstimate: totalContextTokens,
          realBefore,
          additiveOverhead: incompressibleOverhead,
          fixedBase: this.sessionMinFixedOverhead,
        });

        dumpCompactionQualityIfEnabled({
          kind: 'manual_compaction_completed',
          source: 'agentRuntimeHost',
          trigger: 'manual',
          strategy: 'kernel-unified',
          sessionId: this.session?.sessionId,
          model: this.model,
          contextWindow,
          before: {
            realTokens: realBefore,
            memoryEstimatedTokens: totalContextTokens,
            systemPromptTokens,
            dialogTokens,
            incompressibleOverhead,
            pressure,
          },
          after: {
            memoryEstimatedTokens: finalBreakdown.totalTokens,
            finalTokensWithOverhead,
            savedTokens: result.savedTokens,
          },
        });

        // 重置内存压力监控
        if (this.memoryPressure) {
          this.memoryPressure.reset();
          const snapAfter = this.memoryPressure.setPromptEstimateFromMessages(this.memory.getMessagesForLLM());
          void this.handleMemorySnapshot(snapAfter, true);
        }

        this.emitEvent({
          type: 'context_compaction',
          status: 'completed',
          originalMessages: result.originalCount,
          keptMessages: result.compressedCount,
          droppedMessages: result.stats?.droppedMessages ?? 0,
          compressedMessages: result.stats?.llmCompressedMessages ?? 0,
          originalTokens: realBefore,
          finalTokens: finalTokensWithOverhead,
          tokensIncludeOverhead: true,
          budgetTokens: contextWindow,
          useLLM,
          timestamp: Date.now(),
        });
        const anchoredSaved = Math.max(0, realBefore - finalTokensWithOverhead);
        const savedK = (anchoredSaved / 1000).toFixed(1);
        notifyPostCompact(this.session?.sessionId, realBefore, finalTokensWithOverhead, anchoredSaved);
        const didLlm = (result.stats?.llmCompressedMessages ?? 0) > 0;
        if ((result.savedTokens ?? 0) > 0) {
          this.emitCompacting(
            '✓ 压缩完成',
            `${(realBefore / 1000).toFixed(1)}K → ${(finalTokensWithOverhead / 1000).toFixed(1)}K tokens (释放 ${savedK}K)`,
          );
        } else if (didLlm) {
          this.emitCompacting(
            'ℹ️ 压缩未获收益',
            `${(realBefore / 1000).toFixed(1)}K → ${(finalTokensWithOverhead / 1000).toFixed(1)}K — 摘要未缩小（已回退原文）`,
          );
        } else {
          this.emitCompacting(
            'ℹ️ 压缩未获收益',
            `${(result.originalTokens / 1000).toFixed(1)}K tokens — 可压区过小或仍在模型输入预算内`,
          );
        }
      } else {
        const estK = (dialogTokens / 1000).toFixed(1);
        const totalK = (realBefore / 1000).toFixed(1);
        this.emitCompacting(
          'ℹ 无需压缩',
          `对话历史约 ${estK}K tokens（总 context ~${totalK}K）。手动压缩需 memory ≥ 8K；状态栏 ctx 常含 cache，会比可压历史更大。`,
        );
        dumpCompactionQualityIfEnabled({
          kind: 'manual_compaction_noop',
          source: 'agentRuntimeHost',
          trigger: 'manual',
          strategy: 'smart',
          sessionId: this.session?.sessionId,
          model: this.model,
          contextWindow,
          before: {
            realTokens: realBefore,
            memoryEstimatedTokens: totalContextTokens,
            systemPromptTokens,
            dialogTokens,
            incompressibleOverhead,
            pressure,
            snapshotPromptTokens: currentSnapshot?.promptTokens,
            snapshotTokensUsed: currentSnapshot?.tokensUsed,
            breakdown,
          },
          reason: 'compactNow returned null (below threshold / breaker)',
        });
        const memoryLooksHydrated = currentMessages.length * 4 >= messageEntries.length;
        if (memoryLooksHydrated) {
          this.emitEvent({
            type: 'context_compaction',
            status: 'completed',
            originalMessages: messageEntries.length,
            keptMessages: messageEntries.length,
            droppedMessages: 0,
            compressedMessages: 0,
            /* no-op: 什么都没动, before/after 都是实报当前值 — 仍达成"强制校准 badge"的目的 */
            originalTokens: realBefore,
            finalTokens: realBefore,
            tokensIncludeOverhead: true,
            budgetTokens: contextWindow,
            useLLM: false,
            timestamp: Date.now(),
          });
        } else {
          cliLogger.warn('COMPACT', `no-op force-calibrate skipped: memory ${currentMessages.length} msgs `
            + `vs session ${messageEntries.length} entries — memory not hydrated, refusing to downgrade badge to ${realBefore}`);
        }
      }
    } catch (error: any) {
      // LLM 压缩失败
      dumpCompactionQualityIfEnabled({
        kind: 'manual_compaction_failed',
        source: 'agentRuntimeHost',
        trigger: 'manual',
        strategy: 'smart',
        sessionId: this.session?.sessionId,
        model: this.model,
        contextWindow,
        before: {
          realTokens: realBefore,
          memoryEstimatedTokens: totalContextTokens,
          systemPromptTokens,
          dialogTokens,
          incompressibleOverhead,
          pressure,
          snapshotPromptTokens: currentSnapshot?.promptTokens,
          snapshotTokensUsed: currentSnapshot?.tokensUsed,
          breakdown,
        },
        error: error?.message || String(error),
      });
      this.emitLog('error', '❌ LLM 压缩失败', error?.message || String(error));
      throw error;
    }
  }



  setSandboxMode(enabled: boolean): void {
    this.sandboxSetter?.(enabled);
  }

  setApprovalHandler(handler?: ToolApprovalHandler): void {
    this.runner.setApprovalHandler(handler);
  }

  setMode(mode: AgentMode): void {
    this.runner.setMode(mode);
  }

  setConversationHistory(messages: Message[]): void {
    this.memory.clear();
    if (this.systemPrompt) {
      this.memory.add({ role: 'system', content: this.systemPrompt });
    }
    for (const message of messages) {
      if (!message || !message.content) continue;
      this.memory.add({
        role: message.role,
        content: message.content,
        name: message.name,
        tool_call_id: message.tool_call_id,
        tool_calls: message.tool_calls,
        reasoning_content: message.reasoning_content,
        thinking_blocks: message.thinking_blocks,
      });
    }
  }

  /**
   * Dispose and clean up all resources
   * Should be called when the session is deleted or no longer needed
   */
  dispose(): void {
    getBrowserSession().stopForSession(this.runtimeSessionId || this.session?.sessionId);
    // Interrupt any running task
    if (this.isRunning) {
      this.interrupt();
    }

    /* P0-2: agentRegistry unregister — host 销毁 = agent 已不可用 */
    if (this.runtimeSessionId) {
      agentRegistry.unregister(this.runtimeSessionId);
    }

    try {
      cleanupSessionScratch(this.session?.sessionId ?? this.sessionSeed);
    } catch {
      /* 非致命 */
    }

    //   异常时最后 N 条消息丢失, 重启对话从中间截断, 用户感知"丢了消息"零线索. 改 console.error.
    //   Promise 通过 this.lastFlushPromise 暴露, caller (app.before-quit hook) 可 await 它保证
    //   process 退出前 flush 完成 — dispose 本身保持同步签名兼容老调用方.
    if (this.persistMemoryHookOff) {
      this.persistMemoryHookOff();
      this.persistMemoryHookOff = null;
    }
    this.lastFlushPromise = this.flushPersistImmediate().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[agentRuntimeHost.dispose] flushPersistImmediate failed — 最后 N 条消息可能未落盘:', msg);
    });

    // Abort any pending request
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    /* host 都要销毁了, 侧路那几发也没有落点了 —— 这里才是该杀它的地方 */
    if (!this.sideAgentAbort.signal.aborted) this.sideAgentAbort.abort();

    // Remove all event listeners
    this.eventEmitter.removeAllListeners();

    // Clear memory
    this.memory.clear();


    // Clear recent tool calls
    this.recentToolCalls.clear();

    // Clear batch detector state
    this.batchDetector.reset();

    console.log('[AgentRuntimeHost] Disposed');
  }

  getContextWindow(): number | undefined {
    return this.compatProfile?.contextWindow
      || this.memoryPressure?.getSnapshot()?.profile?.contextWindow;
  }
}
