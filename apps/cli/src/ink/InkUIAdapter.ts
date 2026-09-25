/**
 * InkUIAdapter - Adapter to make InkRuntime compatible with the legacy UI interface
 * This keeps compatibility with the legacy CLI interface without breaking existing code
 */

import { InkRuntime, type InkRuntimeCallbacks, type AttachedImage, type TimelineEntry } from './InkRuntime.js';
import type { Message, MessageContentPart } from '@neoxlabs/kernel/types/index.js';
import type { AgentContextStats } from '@neoxlabs/kernel/types/agent.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import type { ShortTermMemory } from '@neoxlabs/kernel/memory/shortterm.js';
import type { MemoryPressureState } from '@neoxlabs/kernel/compat/memoryPressure.js';
import { inferStatusFromTool, inferStatusFromText, getDefaultThinkingStatus } from './utils/statusInference.js';
import { generateDiffLines, renderDiffToTerminal, diffSummary, type DiffLine } from './utils/diffPreview.js';
import {
  buildCompactCardText,
  buildCompactStatusLine,
  isCompactTerminalMessage,
} from './utils/compactProgress.js';
import { safeDebugStringify } from './safeDebugStringify.js';
import { InterruptGate, type UnansweredPrompt } from './interruptGate.js';
import { parseErrorMessage } from './utils/parseErrorMessage.js';
import { clearContextUsage } from './contextUsageStore.js';

export interface InkUIAdapterConfig {
  version: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  workDir: string;
  commandHints?: string[];
  getCompletions?: (value: string) => string[];
  memory?: ShortTermMemory;
  getPendingMessages?: () => Array<{ text: string; timestamp: Date }>;
  account?: string;
  accountTone?: 'cyan' | 'green' | 'gray';
}

export interface ImagePathRef {
  path?: string;
  name?: string;
  mediaType?: string;
  data?: string;
}

export interface InkUIAdapterCallbacks {
  onSubmit: (input: string, images?: AttachedImage[]) => Promise<void>;
  onExit: () => void;
  onInterrupt: () => void;
  isTaskRunning?: () => boolean;
  onToggleThinking?: (enabled: boolean) => void;
}

/**
 * Adapter that implements the legacy UI interface using Ink
 */
export interface TokenStats {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextWindow?: number;
  autoCompactLimit?: number;
  tokensUsedForContext?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  pressure?: number;
  warningLevel?: MemoryPressureState;
  messageCount?: number;
  systemTokens?: number;        // System prompt tokens
  userTokens?: number;          // User message tokens
  assistantTokens?: number;     // Assistant message tokens (不含 tool_calls)
  toolCallTokens?: number;      // Tool call definition tokens
  toolResultTokens?: number;    // Tool result tokens
  // Legacy fields (for backward compatibility)
  toolTokens?: number;          // = toolCallTokens + toolResultTokens
  messageTokens?: number;       // = userTokens + assistantTokens
}

export class InkUIAdapter {
  private runtime: InkRuntime;
  private config: InkUIAdapterConfig;
  private callbacks?: InkUIAdapterCallbacks;
  private currentThinkingText = '';
  private lastMessageRole: string | null = null;
  private lastEntryId: number | null = null;
  private readonly interruptGate = new InterruptGate({
    takeUnansweredPrompt: () => this.runtime.takeUnansweredPrompt(),
    discardUnshownStreams: () => { this.agentBuffers.clear(); this.streamingReasoningChunks = []; this.streamingReasoningLength = 0; this.currentThinkingText = ''; },
    finalizeStreams: () => this.finalizeStreamingState(),
    addEntry: e => { this.runtime.addEntry(e); },
  });
  private tokenStats: TokenStats = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  private memory?: ShortTermMemory;

  private streamingTextPendingId: number | null = null;
  private streamingReasoningPendingId: number | null = null;
  private streamingTextBuffer = '';
  private streamingReasoningChunks: string[] = [];
  private streamingReasoningLength = 0; // cached length to avoid join() for length checks
  private streamingReasoningType: 'thinking' | 'reasoning' = 'thinking';
  private streamingReasoningSourceLabel: string | undefined = undefined;
  private streamingToolChars = 0;
  private hasInferredThinkingStatus = false;
  private toolLogIdByToolId = new Map<string, number>();
  private toolLogDetailsByToolId = new Map<string, string>();
  private toolLogNameByToolId = new Map<string, string>();
  private toolLogOutputByToolId = new Map<string, string>();
  private toolLogSourceLabelByToolId = new Map<string, string>();
  private backgroundedShellKeys = new Set<string>();
  private committedShellKeys = new Set<string>();
  private activeShellKey: string | null = null;  // 正在跑的 shell 卡 —— 流更新按它归位, 不按命令串
  /** /compact 在空闲时抢占的 isRunning; 结束后必须释放, 否则输入框卡在 interrupt */
  private compactionOwnsRunning = false;
  /** 进行中压缩卡走 pending(可原地更新); Static 写入后改不了会刷出多张卡 */
  private readonly compactingEntryKey = 'compacting:active';
  /** 用户中断后屏蔽迟到的 Explore upsert, 防止底部 "N agents" 死而复生 */
  private taskAgentsSuspended = false;

  private streamingSourceLabel: string | null = null;
  private streamingSourceType: 'supervisor' | 'agent' | null = null;

  // Key: agentId (如 "Main", "Worker-1", "Supervisor", "Executor")
  // Value: 流式文本增量数组（避免 O(n²) 字符串拼接）
  private agentBuffers = new Map<string, string[]>();
  private activeAgentId: string | null = null;

  constructor(config: InkUIAdapterConfig) {
    this.config = config;
    this.memory = config.memory;

    // Create runtime with callbacks and memory reference
    this.runtime = new InkRuntime({
      onSubmit: (message: string, images?: AttachedImage[]) => {
        if (this.callbacks?.onSubmit) {
          //    (crash handler 写日志但用户屏幕零反馈). catch 住记 cliLogger (直写 stderr).
          void Promise.resolve(this.callbacks.onSubmit(message, images)).catch((err) => {
            cliLogger.error('INK_ADAPTER', `onSubmit handler failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
          });
        }
      },
      onInterrupt: () => {
        if (this.callbacks?.onInterrupt) {
          this.callbacks.onInterrupt();
        }
      },
      onExit: () => {
        if (this.callbacks?.onExit) {
          this.callbacks.onExit();
        }
      },
    });

    if (config.getPendingMessages) {
      this.runtime.setGetPendingMessages(config.getPendingMessages);
    }
  }

  /**
   * Start the UI
   */
  start(callbacks: InkUIAdapterCallbacks): void {
    this.callbacks = callbacks;
    // Set all config info
    this.runtime.setVersion(this.config.version);
    this.runtime.setProvider(this.config.provider);
    this.runtime.setModel(this.config.model);
    this.runtime.setReasoningEffort(this.config.reasoningEffort);
    this.runtime.setWorkDir(this.config.workDir);
    if (this.config.account) {
      this.runtime.setAccount(this.config.account, this.config.accountTone);
    }

    // Set completion function if provided
    if (this.config.getCompletions) {
      this.runtime.setCompletionFunction(this.config.getCompletions);
    }

    this.runtime.start();
    cliLogger.info('INK_ADAPTER', 'Ink UI started');
  }

  setAccount(account: string | undefined, tone?: 'cyan' | 'green' | 'gray'): void {
    this.runtime.setAccount(account, tone);
  }

  /**
   * Stop the UI
   */
  stop(): void {
    this.runtime.stop();
    this.callbacks = undefined;
    cliLogger.info('INK_ADAPTER', 'Ink UI stopped');
  }

  /**
   * Add user message
   */
  addUserMessage(content: string, images?: ImagePathRef[], source?: 'local' | 'remote' | 'supervisor'): void {
    this.interruptGate.reset();
    const contentParts: MessageContentPart[] = [{ type: 'text', text: content }];

    // Actual base64 conversion happens in handleUserInput
    if (images && images.length > 0) {
      for (const img of images) {
        // Add placeholder for image display (actual data is processed elsewhere)
        contentParts.push({
          type: 'image_url',
          image_url: {
            url: `file://${img.path}`,
          },
        });
      }
    }

    const message: Message = {
      role: 'user',
      content: contentParts,
    };

    // Add as timeline entry with source label
    this.lastEntryId = this.runtime.addEntry({
      type: 'user',
      message,
      sourceLabel: source === 'remote' ? 'Android' : undefined,
    });
    this.lastMessageRole = 'user';
  }

  /**
   * Add assistant message (or start streaming)
   * If content is empty, we're about to stream - don't add to entries yet
   */
  addAssistantMessage(content: string = ''): void {
    // If content is empty, streaming will start - don't add entry yet
    // The streaming logic will create a pending entry instead
    if (content === '') {
      this.lastMessageRole = 'assistant';
      return;
    }

    // Non-streaming message: add directly to entries
    const message: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: content }],
    };

    this.lastEntryId = this.runtime.addEntry({
      type: 'assistant',
      message,
      isStreaming: false,
    });
    this.lastMessageRole = 'assistant';
  }

  addSupervisorMessage(content: string): void {
    const message: Message = {
      role: 'user',  // Supervisor 的消息在逻辑上是 user role
      content: [{ type: 'text', text: content }],
    };

    this.lastEntryId = this.runtime.addEntry({
      type: 'supervisor',
      message,
    });
    this.lastMessageRole = 'user';
  }

  getStreamingSourceType(): 'supervisor' | 'agent' | null {
    return this.streamingSourceType;
  }

  startAgentStreaming(agentId: string): void {
    if (!this.agentBuffers.has(agentId)) {
      this.agentBuffers.set(agentId, []);
    }
    this.activeAgentId = agentId;
    this.lastMessageRole = 'assistant';
    cliLogger.debug('INK_ADAPTER', `Started agent streaming for ${agentId}`);
  }

  addWorkerInfo(workerId: string, text: string, details?: string, msgType: 'info' | 'warning' | 'success' | 'error' = 'info'): void {
    const prefix = `[${workerId}]`;
    const fullText = `${prefix} ${text}`;
    // 将 'error' 映射为 'warning' 因为 addInfo 不支持 'error'
    const mappedType = msgType === 'error' ? 'warning' : msgType;
    this.addInfo(fullText, details, mappedType);
  }

  streamText(token: string, agentId?: string): void {
    if (this.interruptGate.closed) return; // esc 之后在途的 delta 不要 (见 interruptGate)
    const startTime = Date.now();

    // 确定目标 agentId
    const targetId = agentId || this.activeAgentId || 'default';

    cliLogger.debug('INK_ADAPTER', `streamText: ${token.length} chars to ${targetId}`, {
      snippet: token.substring(0, 30),
      bufferExists: this.agentBuffers.has(targetId),
    });

    const elapsed = Date.now() - startTime;
    if (elapsed > 10) {
      cliLogger.warn('INK_ADAPTER', `⚠️ streamText slow: ${elapsed}ms for ${token.length} chars`);
    }

    // 累积到对应 Agent 的缓冲区（O(1) push 替代 O(n) 字符串拼接）
    const chunks = this.agentBuffers.get(targetId);
    if (chunks) {
      chunks.push(token);
    } else {
      this.agentBuffers.set(targetId, [token]);
    }

    // Token counting is handled by runtimeEvents.ts → updateTaskTokens()
    // Using buffer.length here would overwrite the accurate token estimation

    // Note: We don't create/update pending entry here anymore
    // The text will be added to static entries when complete
  }

  /**
   * Add text delta (incremental text streaming)
   * @param delta - 文本增量
   * @param agentId - Agent 标识
   */
  addTextDelta(delta: string, agentId?: string): void {
    cliLogger.debug('INK_ADAPTER', `addTextDelta called: ${delta.length} chars, agentId=${agentId || 'default'}`, { delta: delta.substring(0, 50) });
    this.streamText(delta, agentId);
  }

  addAgentTextDelta(delta: string, agentId: string, displayLabel?: string): void {
    if (this.interruptGate.closed) return;
    cliLogger.debug('INK_ADAPTER', `addAgentTextDelta: ${delta.length} chars, agentId=${agentId}`, { delta: delta.substring(0, 50) });

    if (!this.agentBuffers.has(agentId)) {
      this.agentBuffers.set(agentId, []);
    }

    // 1. 累积到缓冲区（O(1) push）
    this.agentBuffers.get(agentId)!.push(delta);

    // 2. 实时更新 pending entry 显示流式文本
    const bufferText = this.agentBuffers.get(agentId)!.join('');
    const message: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: bufferText }],
    };

    // 使用 agentId 作为 key，displayLabel 作为 sourceLabel
    this.runtime.updatePendingEntryByKey(agentId, {
      type: 'assistant',
      message,
      isStreaming: true,
      isComplete: false,
      sourceLabel: displayLabel || agentId,
    });
  }

  bufferAgentTextOnly(delta: string, agentId: string): void {
    // 确保缓冲区存在
    if (!this.agentBuffers.has(agentId)) {
      this.agentBuffers.set(agentId, []);
    }

    // 只累积到缓冲区，不更新 UI（O(1) push）
    this.agentBuffers.get(agentId)!.push(delta);
  }

  flushAgentBuffer(agentId: string): string {
    const chunks = this.agentBuffers.get(agentId);
    this.agentBuffers.delete(agentId);
    return chunks ? chunks.join('') : '';
  }

  commitPendingEntryByKey(key: string): boolean {
    // 先清理对应的缓冲区
    if (this.agentBuffers.has(key)) {
      this.agentBuffers.delete(key);
    }
    return this.runtime.commitPendingEntryByKey(key);
  }

  /**
   * Add tool call message
   */
  addToolCall(toolName: string, input: any): void {
    const message: Message = {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: `tool_${Math.floor(Date.now())}`,
          name: toolName,
          input,
        },
      ],
    };
    this.runtime.addMessage(message);
    this.lastMessageRole = 'tool_call';
  }

  addToolCallEntry(toolName: string, args: Record<string, any>, options?: { sourceLabel?: string }): void {
    cliLogger.debug('INK_ADAPTER', 'Add tool call entry', { toolName, sourceLabel: options?.sourceLabel });
    // 复用 startToolCallWithId 的完整映射和 summary 逻辑
    const toolId = `entry_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    this.startToolCallWithId(toolId, toolName, args, options);
  }

  /**
   * Add tool result message
   */
  addToolResult(result: string, isError: boolean = false): void {
    const message: Message = {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: `tool_${Math.floor(Date.now())}`,
          content: result,
          is_error: isError,
        },
      ],
    };
    this.runtime.addMessage(message);
    this.lastMessageRole = 'tool_result';
  }


  addEntry(entry: Omit<TimelineEntry, 'id' | 'timestamp'>): number {
    cliLogger.debug('INK_ADAPTER', `AddEntry: ${entry.type}`, { text: entry.text });
    return this.runtime.addEntry(entry);
  }

  /** /theme 切配色/背景后刷新整个 UI (重吐 header + 刷新 live 区) */
  refreshTheme(): void {
    this.runtime.refreshAfterThemeChange();
  }

  /**
   * Add info message (displayed as system message)
   * @param text - Main message text
   * @param details - Optional details (can be multiline)
   * @param msgType - Message type: 'info' | 'warning' | 'success' (default: 'info')
   */
  addInfo(text: string, details?: string, msgType: 'info' | 'warning' | 'success' = 'info', sourceLabel?: string): void {
    cliLogger.info('INK_ADAPTER', `Info: ${text}`, details ? { details } : undefined);

    const isWarning = msgType === 'warning' || text.includes('⚠') || text.includes('⏳') || text.includes('⏱️') || text.includes('🔄');

    this.runtime.addEntry({
      type: isWarning ? 'warning' as any : 'info',
      text,
      details,
      sourceLabel,
    });
  }

  /** esc 中断收尾, 两步 (见 interruptGate): 先 take (收尾提交 pending 之前), 再 addInterrupted */
  takeUnansweredPrompt(): UnansweredPrompt { return this.interruptGate.begin(); }
  addInterrupted(unanswered: UnansweredPrompt): void { this.interruptGate.finish(unanswered); }

  /**
   * Add error message
   * @param message - Error message text
   * @param detailsOrOptions - Optional details string or options object with sourceLabel
   */
  private lastErrorKey = '';
  private lastErrorAt = 0;
  addError(message: string, detailsOrOptions?: string | { sourceLabel?: string; details?: string }): void {
    const details = typeof detailsOrOptions === 'string' ? detailsOrOptions : detailsOrOptions?.details;
    const sourceLabel = typeof detailsOrOptions === 'object' ? detailsOrOptions?.sourceLabel : undefined;

    cliLogger.error('INK_ADAPTER', message, details ? { details } : undefined);

    const key = message.replace(/^Error:\s*/, '').trim();
    const now = Date.now();
    if (key && key === this.lastErrorKey && now - this.lastErrorAt < 5000) return;
    this.lastErrorKey = key;
    this.lastErrorAt = now;

    // Add as timeline entry
    this.runtime.addEntry({
      type: 'error',
      text: message,
      details,
      sourceLabel,
    });

    // Direct stderr writes bypass Ink's rendering and cause display artifacts
  }

  addWarning(message: string, details?: string, options?: { sourceLabel?: string }): void {
    cliLogger.warn('INK_ADAPTER', message, details ? { details } : undefined);

    // Add as timeline entry
    this.runtime.addEntry({
      type: 'warning',
      text: message,
      details,
      sourceLabel: options?.sourceLabel,
    });
  }

  addCompacting(text: string, details?: string): void {
    cliLogger.info('INK_ADAPTER', `Compacting: ${text}`, details ? { details } : undefined);

    const terminal = isCompactTerminalMessage(text);
    const statusLine = buildCompactStatusLine(text, details);
    const cardText = buildCompactCardText(text, details);

    if (terminal) {
      // 终态立刻释放 compact 占用的 busy — 不能等 session.ts, 否则状态栏仍显示进行中
      this.updateStatus(
        cardText,
        /fail|失败/i.test(text) ? 'error' : 'compaction_complete',
      );
      this.endCompaction();
      this.runtime.updatePendingEntryByKey(this.compactingEntryKey, {
        type: 'compacting',
        text: cardText,
        details,
        isStreaming: false,
        isComplete: true,
      });
      this.runtime.commitPendingEntryByKey(this.compactingEntryKey);
      return;
    }

    this.beginCompaction();
    this.updateStatus(statusLine, 'compacting');
    this.runtime.updatePendingEntryByKey(this.compactingEntryKey, {
      type: 'compacting',
      text: cardText,
      details,
      isStreaming: true,
      isComplete: false,
    });
  }

  /**
   * Update status text only.
   * Turn busy (`isRunning`) is owned by beginTurn/endTurn/beginCompaction/endCompaction —
   * status types must NEVER call setRunning (late shell heartbeats / explore_complete used to
   * re-light or prematurely clear the turn via this side effect).
   */
  updateStatus(
    text: string,
    type?: 'thinking' | 'tool_call' | 'tool_result' | 'complete' | 'error' | 'compacting' | 'info' | 'warning' | 'compaction_complete' | 'explore_complete'
  ): void {
    // Track tool-call argument chars for diagnostics only.
    // Do NOT map chars into streaming token stats (that inflates "↓ token").
    if (type === 'tool_call' && text.includes('Streaming:')) {
      const match = text.match(/\((\d+) chars\)/);
      if (match) {
        const chars = parseInt(match[1], 10);
        this.streamingToolChars = chars;
      }
    } else if (type !== 'tool_call') {
      this.streamingToolChars = 0;
    }

    const isTerminal = type === 'complete' || type === 'error';
    if (this.terminalStatusLocked && !isTerminal && !text.trim()) {
      return;
    }
    if (this.terminalStatusLocked && this.terminalStatusText === 'Interrupted' && type !== 'error') {
      return;
    }
    if (isTerminal) {
      this.terminalStatusLocked = true;
      this.terminalStatusText = text;
    }

    const statusText =
      type === 'compacting' && !isCompactTerminalMessage(text)
        ? buildCompactStatusLine(text)
        : text;
    this.runtime.setStatusText(statusText);
  }

  /** 见 updateStatus: 终态状态锁, beginTurn 解锁 */
  private terminalStatusLocked = false;
  private terminalStatusText = '';

  /**
   * Begin an agent turn (user submit → runTask). Only lifecycle API may set running true for turns.
   */
  beginTurn(): void {
    this.compactionOwnsRunning = false;
    this.taskAgentsSuspended = false;
    this.terminalStatusLocked = false; // 新一轮开始 — 解开上一轮的终态锁
    this.runtime.setRunning(true);
  }

  /**
   * End an agent turn (run_result / watchdog / finally). Clears compact ownership too.
   */
  endTurn(): void {
    this.flushDeferredReasoning();
    this.compactionOwnsRunning = false;
    this.runtime.setRunning(false);
  }

  /**
   * Idle `/compact` (or equivalent) needs a busy UI without an agent turn.
   * Mid-turn auto-compact: agent already running → do not take ownership (endCompaction no-ops).
   */
  beginCompaction(): void {
    if (!this.runtime.getIsRunning()) {
      this.compactionOwnsRunning = true;
      this.runtime.setRunning(true);
    }
  }

  /**
   * Release busy only if this compact session owned it (idle compact).
   */
  endCompaction(): void {
    if (this.compactionOwnsRunning) {
      this.compactionOwnsRunning = false;
      this.runtime.setRunning(false);
    }
  }

  /**
   * Set running state (low-level). Prefer beginTurn/endTurn/beginCompaction/endCompaction.
   */
  setRunning(running: boolean): void {
    if (!running) this.compactionOwnsRunning = false;
    if (running) this.taskAgentsSuspended = false;
    this.runtime.setRunning(running);
  }

  /**
   * Start session timer - DEPRECATED: Now tracking is automatic via setRunning()
   * Kept for backward compatibility but does nothing
   */
  startSessionTimer(): void {
    // This method is kept for backward compatibility but does nothing
  }

  getAccumulatedRunTime(): number {
    return this.runtime.getAccumulatedRunTime();
  }

  resetAccumulatedRunTime(): void {
    this.runtime.resetAccumulatedRunTime();
  }

  setCompressionMode(mode: 'sync' | 'async'): void {
    this.runtime.setCompressionMode(mode);
  }

  setCompactionThreshold(thresholdPercent: number): void {
    // Convert percentage to 0-1 ratio
    this.runtime.setCompactionThreshold(thresholdPercent / 100);
  }

  /**
   * Update token stats (legacy method for compatibility)
   */
  updateTokenStats(input: number, output: number): void {
    this.tokenStats.inputTokens = input;
    this.tokenStats.outputTokens = output;
    this.tokenStats.totalTokens = input + output;
    this.runtime.setTokenStats({
      input,
      output,
      total: input + output,
    });
  }

  // ==================== 多Agent上下文管理 ====================

  setResearchProgress(p: any): void {
    (this.runtime as any).setResearchProgress?.(p);
  }

  updateAgentContext(agentId: string, stats: AgentContextStats): void {
    this.runtime.updateAgentContext(agentId, stats);
  }

  clearAgentContext(agentId: string): void {
    this.runtime.clearAgentContext(agentId);
  }

  clearAllAgentContexts(): void {
    this.runtime.clearAllAgentContexts();
  }

  /**
   * Get token stats
   */
  getTokenStats(): TokenStats {
    return { ...this.tokenStats };
  }

  /**
   * Set token stats with extras
   */
  setTokenStats(
    inputTokens: number,
    outputTokens: number,
    extras?: Partial<TokenStats>
  ): void {
    this.tokenStats = {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      ...extras,
    };

    // 源头已归一化：inputTokens=非缓存, cacheReadTokens=缓存读, cacheWriteTokens=缓存写
    // ctx = contextTokens 或 tokensUsedForContext（= in + c-r + c-w）
    const cacheReadTokens = (extras as any)?.cacheReadTokens;
    const cacheCreationTokens = (extras as any)?.cacheWriteTokens;

    const contextWindow = extras?.contextWindow || 0;
    const tokensUsedForContext = extras?.tokensUsedForContext || (inputTokens + outputTokens);
    const pressure = contextWindow > 0 ? tokensUsedForContext / contextWindow : 0;

    this.runtime.setTokenStats({
      input: inputTokens,
      output: outputTokens,
      total: inputTokens + outputTokens,
      contextWindow: extras?.contextWindow,
      tokensUsedForContext,
      pressure,
      systemTokens: extras?.systemTokens,
      userTokens: extras?.userTokens,
      assistantTokens: extras?.assistantTokens,
      toolCallTokens: extras?.toolCallTokens,
      toolResultTokens: extras?.toolResultTokens,
      toolTokens: extras?.toolTokens,
      messageTokens: extras?.messageTokens,
      cacheCreationTokens,
      cacheReadTokens,
    });
  }

  startThinking(): void {
    this.streamingReasoningChunks = [];
    this.streamingReasoningLength = 0;
    this.streamingReasoningType = 'thinking';
    this.hasInferredThinkingStatus = false;
    this.updateStatus(getDefaultThinkingStatus(), 'thinking');
  }

  streamThinking(text: string, type: 'thinking' | 'reasoning' = 'thinking', sourceLabel?: string): void {
    if (this.interruptGate.closed) return;
    this.streamingReasoningChunks.push(text);
    this.streamingReasoningLength += text.length;
    if (sourceLabel) this.streamingReasoningSourceLabel = sourceLabel;

    if (!this.hasInferredThinkingStatus && this.streamingReasoningLength > 30) {
      const reasoningText = this.streamingReasoningChunks.join('');
      const inferredStatus = inferStatusFromText(reasoningText);
      if (inferredStatus) {
        this.updateStatus(inferredStatus, 'thinking');
        this.hasInferredThinkingStatus = true;
      }
    }

    // Create or update pending entry
    const reasoningText = this.streamingReasoningChunks.join('');
    if (!this.streamingReasoningPendingId) {
      this.streamingReasoningType = type;
      this.streamingReasoningPendingId = this.runtime.addPendingEntry({
        type: type,
        text: reasoningText,
        isStreaming: true,
      });
    } else {
      this.runtime.updatePendingEntry(this.streamingReasoningPendingId, {
        text: reasoningText,
      });
    }

    // Token counting is handled by runtimeEvents.ts → updateTaskTokens()
    // Using buffer.length here would overwrite the accurate token estimation
  }

  endThinking(): void {
    if (!this.streamingReasoningPendingId) {
      // No pending reasoning - nothing to complete
      this.updateStatus('', 'info');
      return;
    }

    try {
      // Only commit if there's actual content
      // Empty or whitespace-only content can be safely discarded
      const reasoningText = this.streamingReasoningChunks.join('');
      const hasContent = reasoningText.length > 0 && reasoningText.trim().length > 0;

      if (hasContent) {
        this.runtime.updatePendingEntry(this.streamingReasoningPendingId, {
          isStreaming: false,
          isComplete: true,
          sourceLabel: this.streamingReasoningSourceLabel,
        });
        this.runtime.commitPendingEntry(this.streamingReasoningPendingId);
        cliLogger.debug('INK_ADAPTER', `Committed reasoning entry (${reasoningText.length} chars)`);
      } else {
        // No meaningful content - just discard the pending entry
        // This happens when stream is interrupted immediately after starting
        cliLogger.debug('INK_ADAPTER', 'Discarding empty reasoning entry (no content)');
      }
    } catch (err) {
      // If commit fails (e.g., entry already removed), log but don't crash
      cliLogger.warn('INK_ADAPTER', 'Failed to commit reasoning entry', { error: err });
    } finally {
      // Always reset state regardless of success/failure
      // This ensures we don't leave dangling references
      this.streamingReasoningPendingId = null;
      this.streamingReasoningChunks = [];
      this.streamingReasoningLength = 0;
      this.streamingReasoningSourceLabel = undefined;
      this.runtime.resetStreamingStats();
      this.updateStatus('', 'info');
    }
  }

  /**
   * Start task timer — alias for beginTurn (userInputLifecycle / chat adapters).
   */
  startTaskTimer(): void {
    this.beginTurn();
  }

  /**
   * Stop task timer — alias for endTurn.
   */
  stopTaskTimer(): void {
    this.endTurn();
  }

  setStreamingTokens(tokens: number): void {
    this.runtime.updateStreamingStats(tokens);
  }

  /**
   * Clear all messages
   */
  clear(): void {
    this.runtime.clearMessages();
    this.lastMessageRole = null;
  }

  resetStreamingState(): void {
    this.agentBuffers.clear();
    this.activeAgentId = null;

    // Clear text streaming state (legacy)
    this.streamingTextBuffer = '';
    this.streamingTextPendingId = null;

    // Clear reasoning streaming state
    // Note: We don't call endThinking() here because that would try to commit
    // Instead, we directly clean up the state
    this.streamingReasoningChunks = [];
    this.streamingReasoningLength = 0;
    this.streamingReasoningPendingId = null;
    this.reasoningEndDeferred = false;

    // Clear current thinking text (legacy)
    this.currentThinkingText = '';

    this.streamingToolChars = 0;

    // Clear pending entries (保留运行中的后台 agent 卡片)
    this.runtime.clearPendingEntries();

    this.runtime.removeCompletedSidebarAgents();

    // Reset streaming stats (token counters, timers)
    this.runtime.resetStreamingStats();

    if (!this.terminalStatusLocked) {
      this.runtime.setStatusText('');
    }

    cliLogger.debug('INK_ADAPTER', 'Reset streaming state (cleared all pending entries and buffers)');
  }

  finalizeStreamingState(): void {
    // Commit all agent buffers first (multi-agent support)
    const agentIds = Array.from(this.agentBuffers.keys());
    if (agentIds.length > 0) {
      for (const agentId of agentIds) {
        this.completeTextStreaming(agentId);
      }
    } else {
      this.completeTextStreaming();
    }

    // Commit reasoning if any (中断收尾: 不再推迟, 直接收)
    this.reasoningEndDeferred = false;
    this.endThinking();
  }

  /**
   * Start reasoning/thinking streaming
   */
  startReasoningStreaming(): void {
    this.startThinking();
  }

  /**
   * Stream reasoning/thinking text
   */
  streamReasoningText(text: string): void {
    this.streamThinking(text);
  }

  addReasoningDelta(delta: string, sourceLabel?: string): void {
    this.streamThinking(delta, 'reasoning', sourceLabel);
  }

  /**
   * Complete reasoning/thinking streaming
   */
  completeReasoningStreaming(sourceLabel?: string): void {
    if (sourceLabel) this.streamingReasoningSourceLabel = sourceLabel;
    if (this.streamingReasoningPendingId) this.reasoningEndDeferred = true;
  }

  /** 真正收掉推理卡片: 被推迟的那一次 (正文收尾 / 工具开始 / 本轮结束时调用) */
  private flushDeferredReasoning(): void {
    if (!this.reasoningEndDeferred) return;
    this.reasoningEndDeferred = false;
    this.endThinking();
  }
  private reasoningEndDeferred = false;

  /**
   * Add thinking iteration indicator
   * Don't show in status - thinking block is in Timeline (static area)
   */
  addThinking(iteration: number): void {
    // Status line should only show dynamic info (tokens, speed, etc.)
    // Thinking content is already visible in Timeline
  }

  completeTextStreaming(agentId?: string): void {
    /* 推理卡片先落 (它在正文上方) —— 见 completeReasoningStreaming */
    this.flushDeferredReasoning();
    // 确定目标 agentId
    const targetId = agentId || this.activeAgentId || 'default';

    // 获取缓冲区文本（join chunks → single string）
    const chunks = this.agentBuffers.get(targetId);
    const bufferText = chunks ? chunks.join('') : '';

    // Check if there's any text to commit
    const hasText = bufferText.length > 0 && bufferText.trim().length > 0;

    if (!hasText) {
      cliLogger.debug('INK_ADAPTER', `Complete text streaming (${targetId}) - no text to commit`);
      // Reset state even if no text
      this.agentBuffers.delete(targetId);
      this.runtime.commitPendingEntryByKey(targetId);
      if (targetId === 'default' || targetId === this.activeAgentId) {
        this.streamingTextPendingId = null;
        this.streamingSourceLabel = null;
        this.streamingSourceType = null;
        this.runtime.resetStreamingStats();
      }
      return;
    }

    try {
      // 这解决了 network 模式下 streamText 不创建 pending entry 的问题
      const committed = this.runtime.commitPendingEntryByKey(targetId);

      if (!committed) {
        // 没有 pending entry，直接从缓冲区创建 static entry
        const message: Message = {
          role: 'assistant',
          content: [{ type: 'text', text: bufferText }],
        };

        this.runtime.addEntry({
          type: 'assistant',
          message,
          isStreaming: false,
          isComplete: true,
          sourceLabel: targetId === 'default' ? undefined : targetId,
        });

        cliLogger.info('SUBAGENT_ORDER', `🟠 completeTextStreaming → addEntry APPEND (no pending) agentId=${targetId} chars=${bufferText.length}`);
      } else {
        cliLogger.info('SUBAGENT_ORDER', `🟢 completeTextStreaming → commitPendingEntryByKey (has pending) agentId=${targetId} chars=${bufferText.length}`);
      }
    } catch (err) {
      // If committing fails, log but don't crash
      cliLogger.warn('INK_ADAPTER', 'Failed to commit text entry', { error: err });
    } finally {
      // Always reset state regardless of success/failure
      this.agentBuffers.delete(targetId);
      if (targetId === 'default' || targetId === this.activeAgentId) {
        this.streamingTextPendingId = null;
        this.streamingSourceLabel = null;
        this.streamingSourceType = null;
        this.lastMessageRole = 'assistant';
        this.runtime.resetStreamingStats();
      }
      if (this.activeAgentId === targetId) {
        this.activeAgentId = null;
      }
    }
  }

  /**
   * Print command output
   */
  printCommandOutput(line: string): void {
    cliLogger.debug('INK_ADAPTER', `Command output: ${line}`);
    // Don't add to timeline anymore, we'll collect lines and show them in bottom bar
    // This is handled by setCommandOutputLines now
  }

  /**
   * Set command output lines (displayed above input)
   */
  setCommandOutputLines(lines: string[]): void {
    cliLogger.debug('INK_ADAPTER', `Set command output lines: ${lines.length}`);
    this.runtime.setCommandOutput(lines);
  }

  /**
   * Clear command output lines
   */
  clearCommandOutputLines(): void {
    cliLogger.debug('INK_ADAPTER', 'Clear command output lines');
    this.runtime.clearCommandOutput();
  }

  /**
   * Start tool call with ID (advanced tool tracking)
   * @param sourceLabel - Optional source label for multi-agent identification
   */
  startToolCallWithId(toolId: string, toolName: string, args: any, options?: any): void {
    cliLogger.debug('INK_ADAPTER', `Start tool call: ${toolName}`, { toolId, args });
    this.flushDeferredReasoning();
    const sourceLabel = options?.sourceLabel;

    let realToolName = toolName;
    let realArgs = args;
    if (toolName === 'call_tool' && args?.name) {
      realToolName = args.name;
      realArgs = args.args || {};
    }

    const details = this.buildToolCallDetails(realArgs, options);

    const TOOL_NAME_TO_TYPE: Record<string, string> = {
      // 文件读取
      'readfile': 'readfile', 'Read': 'readfile', 'read_file': 'readfile',
      'smart_read': 'readfile', 'read': 'readfile',
      // 搜索
      'search': 'search', 'Grep': 'search', 'grep': 'search',
      // 文件搜索
      'search_files': 'search_files', 'Glob': 'search_files',
      'glob': 'search_files', 'find_files': 'search_files',
      // 目录树
      'show_tree': 'show_tree', 'smart_tree': 'show_tree',
      'list_directory': 'show_tree', 'ls': 'show_tree',
      // 文件操作
      'file_update': 'file_update', 'Edit': 'file_update',
      'edit_file': 'file_update', 'Write': 'file_update',
      'write_file': 'file_update', 'delete_file': 'file_update',
      'rename_file': 'file_update',
      'create_directory': 'file_update',
      // 命令执行
      'command_exec': 'command_exec', 'Bash': 'command_exec',
      'bash': 'command_exec', 'shell': 'command_exec',
      'execute_command': 'command_exec', 'execute_shell': 'command_exec',
      // 代码执行
      'code_exec': 'code_exec', 'execute_python': 'code_exec',
      'execute_javascript': 'code_exec',
      // 网络
      'web_search': 'web_search', 'WebSearch': 'web_search',
      /* 深度调研借 web_search 的样式 (图标/配色本来就是"联网找东西")。
       * CLI 这一层不做结构化渲染 —— 它只有 icon + 前缀 + 一行摘要, 详细回执在工具返回的正文里。 */
      'deep_research': 'web_search',
      'web_fetch': 'web_fetch', 'WebFetch': 'web_fetch',
      // Git
      'git_status': 'git_status', 'git_diff': 'git_diff',
      'git_log': 'git_log', 'git_commit': 'git_commit',
      'git_blame': 'git_diff', 'git_branch': 'git_running',
      'git_branch_list': 'git_running',
      // Todo / Task
      'TodoWrite': 'todo', 'TodoRead': 'todo',
      'Task': 'task',
      // Ask user
      'AskUserQuestion': 'ask_user', 'ask_user': 'ask_user',
      // 测试/lint/格式化
      'run_tests': 'command_exec', 'run_lint': 'command_exec',
      'run_format': 'command_exec',
      // 索引
      'build_index': 'search', 'search_symbol': 'search',
      'get_definitions': 'search', 'get_references': 'search',
      'index_stats': 'search',
      // 分析
      'analyze_code': 'search',
      'bash_output': 'bash_output', 'BashOutput': 'bash_output', 'TaskOutput': 'bash_output',
      'bash_kill': 'bash_kill', 'KillShell': 'bash_kill', 'TaskStop': 'bash_kill',
      'schedule_wakeup': 'schedule_wakeup', 'ScheduleWakeup': 'schedule_wakeup', 'wakeup_self': 'schedule_wakeup',
      'context_status': 'context_status', 'ContextStatus': 'context_status', 'session_status': 'context_status', 'budget_status': 'context_status',
    };

    //    TaskAgentCard 统一渲染（事件系统有实时 toolRecords 更新）
    if (realToolName === 'agent' || realToolName === 'Agent') {
      // 不创建 entry — runtimeEvents 的 ensureWorkerEntry 会在第一个 tool_call_start 时创建
      // 只记录 toolId 映射，以便 completeToolCall 时清理
      this.toolLogNameByToolId.set(toolId, realToolName);
      if (sourceLabel) {
        this.toolLogSourceLabelByToolId.set(toolId, sourceLabel);
      }

      const dynamicStatus = inferStatusFromTool(realToolName, realArgs);
      this.updateStatus(dynamicStatus, 'tool_call');
      return;
    }

    const mappedType = TOOL_NAME_TO_TYPE[realToolName];
    const entryType = mappedType || 'tool_call';

    const text = this.buildToolSummaryText(entryType, realToolName, realArgs);

    const entryId = this.runtime.addPendingEntry({
      type: entryType as any,
      text,
      details,
      entryKey: toolId,
      isStreaming: true,
      sourceLabel,
    });
    this.toolLogIdByToolId.set(toolId, entryId);
    this.toolLogDetailsByToolId.set(toolId, details || '');
    this.toolLogNameByToolId.set(toolId, realToolName);
    if (sourceLabel) {
      this.toolLogSourceLabelByToolId.set(toolId, sourceLabel);
    }

    const dynamicStatus = inferStatusFromTool(realToolName, realArgs);
    this.updateStatus(dynamicStatus, 'tool_call');
  }

  /**
   * Update tool call output (for progressive tool output)
   */
  updateToolCallOutput(toolId: string, output: string, options?: any): void {
    cliLogger.debug('INK_ADAPTER', `Update tool output: ${toolId}`, { output });
    const entryId = this.toolLogIdByToolId.get(toolId);
    if (!entryId) {
      return;
    }
    const baseDetails = this.toolLogDetailsByToolId.get(toolId) || '';
    const outputText = this.formatToolOutput(output, options?.truncated);
    if (outputText) {
      this.toolLogOutputByToolId.set(toolId, outputText);
    }
    const mergedDetails = this.mergeToolDetails(baseDetails, outputText);
    this.runtime.updateEntry(entryId, {
      details: mergedDetails,
      isStreaming: true,
    });
  }

  /**
   * Complete tool call
   */
  completeToolCall(toolId: string, options: any): void {
    cliLogger.debug('INK_ADAPTER', `Complete tool call: ${toolId}`);
    const entryId = this.toolLogIdByToolId.get(toolId);
    if (!entryId) {
      if (options?.result) {
        this.addToolResult(options.result, options.isError || false);
      }
      return;
    }

    const sourceLabel = this.toolLogSourceLabelByToolId.get(toolId);
    const toolName = this.toolLogNameByToolId.get(toolId) || '';

    //    这里只清理 toolId 映射
    if (toolName === 'agent' || toolName === 'Agent') {
      this.toolLogIdByToolId.delete(toolId);
      this.toolLogDetailsByToolId.delete(toolId);
      this.toolLogNameByToolId.delete(toolId);
      this.toolLogOutputByToolId.delete(toolId);
      this.toolLogSourceLabelByToolId.delete(toolId);
      return;
    }

    const isGitTool = this.isGitResultTool(toolName);
    const isShellTool = toolName === 'execute_shell' || toolName === 'execute_bash'
      || toolName === 'bash' || toolName === 'Bash' || toolName === 'shell';
    const summaryText = options?.summary || options?.error || '';
    const outputText = this.toolLogOutputByToolId.get(toolId) || '';

    const resultLine = (summaryText || outputText || '').replace(/\r\n?/g, '\n').trim();
    const firstLine = resultLine.split('\n').find((line: string) => line.trim()) || '';
    const truncated = firstLine.length > 200 ? firstLine.slice(0, 197) + '…' : firstLine;

    const updates: any = {
      isStreaming: false,
      isComplete: true,
      sourceLabel,
    };

    if (isShellTool) {
      const existingEntry = this.runtime.getEntry(entryId);
      const existingText = existingEntry?.text || '';
      // 从已有 text 中提取命令（格式：`$ command`）
      const cmdMatch = existingText.match(/^\$\s*(.+)/);
      const command = cmdMatch ? cmdMatch[1].trim() : existingText;
      const exitCode = options?.success === false ? 1 : 0;
      const exitInfo = exitCode !== 0 ? ` (exit=${exitCode})` : '';
      updates.text = `$ ${command}${exitInfo}`;
      updates.type = 'command_exec';
      if (resultLine) {
        updates.details = resultLine;
      }
    } else {
      if (truncated) {
        updates.text = truncated;
      }
      const completionDetails = this.formatToolCompletionDetails(resultLine, toolName);
      if (completionDetails) {
        updates.details = completionDetails;
      }
      /* BashOutput 的结果是 JSON, summary 是服务端截过的半截 —— 卡片要解析字段, 给它完整原文 */
      if (/^(bash_output|BashOutput|TaskOutput)$/.test(toolName) && resultLine.startsWith('{')) {
        updates.details = resultLine;
      }
    }

    if (isGitTool) {
      const gitDetails = this.formatGitToolDetails(summaryText, outputText);
      if (gitDetails) {
        updates.details = gitDetails;
      }
    }

    // 错误时改类型为 tool_error — 但 shell 命令保持 command_exec
    // ToolCard 的 shell 渲染路径已经处理 exitCode（红色 + stderr 输出）
    if (!options?.success && !isShellTool) {
      updates.type = 'tool_error';
    }

    this.runtime.updateEntry(entryId, updates);
    this.runtime.commitPendingEntry(entryId);

    this.toolLogIdByToolId.delete(toolId);
    this.toolLogDetailsByToolId.delete(toolId);
    this.toolLogNameByToolId.delete(toolId);
    this.toolLogOutputByToolId.delete(toolId);
    this.toolLogSourceLabelByToolId.delete(toolId);
  }

  updateTaskTokens(tokens: number, isActual: boolean = false): void {
    cliLogger.debug('INK_ADAPTER', `Update task tokens: ${tokens}`, { isActual });

    if (isActual) {
      // When we get actual tokens from API response, don't update streaming display
      // The final token count will be shown in the right-side stats
      return;
    }

    // StatusLine will display these as token counts (not chars)
    // The tokens value is already estimated in runtimeEvents.ts using estimateOutputTokens()
    this.runtime.updateStreamingStats(tokens);
  }

  /**
   * Add tool error
   */
  addToolError(toolName: string, error: string): void {
    cliLogger.error('INK_ADAPTER', `Tool error: ${toolName}`, { error });
    this.addToolResult(error, true);
  }

  /**
   * Print command output lines
   */
  printCommandOutputLines(lines: string[]): void {
    lines.forEach(line => this.printCommandOutput(line));
  }

  /**
   * Reset token stats
   */
  resetTokenStats(): void {
    this.tokenStats = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    this.runtime.setTokenStats({ input: 0, output: 0, total: 0 });
    clearContextUsage();
  }

  /**
   * Pause UI updates
   */
  pause(): void {
    cliLogger.debug('INK_ADAPTER', 'Pause UI');
    // Ink doesn't need explicit pause
  }

  /**
   * Resume UI updates
   */
  resume(): void {
    cliLogger.debug('INK_ADAPTER', 'Resume UI');
    // Ink doesn't need explicit resume
  }

  /**
   * Refresh UI
   */
  refreshUI(): void {
    cliLogger.debug('INK_ADAPTER', 'Refresh UI');
    // Force update if available
    // No need to do anything for Ink - React handles this
  }

  forceUpdate(): void {
    cliLogger.debug('INK_ADAPTER', 'Force UI update');
    this.runtime.triggerForceUpdate();
  }

  /** 排队消息本地副本 — 由 server 的 queued_message_* 事件驱动 (见 runtimeEvents) */
  addQueuedMessage(text: string): void {
    this.runtime.addQueuedMessageLocal(text);
  }
  clearQueuedMessages(): void {
    this.runtime.clearQueuedMessagesLocal();
  }
  /** 弹出最后一条排队消息文本 (↑ 拉回输入框编辑), 空则 null */
  popQueuedMessage(): string | null {
    return this.runtime.popQueuedMessageLocal();
  }
  hasQueuedMessages(): boolean {
    return this.runtime.hasQueuedMessages();
  }
  /** main 注入 ↑ 撤回排队消息的回调 (调 sdkClient.removeLastPendingMessage) */
  setPullbackQueued(fn: (() => Promise<string | null>) | null): void {
    this.runtime.setPullbackQueued(fn);
  }

  setPlanSteps(steps: Array<{ step: string; status: 'pending' | 'in_progress' | 'completed' }>): void {
    cliLogger.debug('INK_ADAPTER', `Set plan steps: ${steps.length} items`);
    this.runtime.setPlanSteps(steps);
  }

  getPlanSteps(): Array<{ step: string; status: 'pending' | 'in_progress' | 'completed' }> {
    return this.runtime.getPlanSteps();
  }

  clearPlanSteps(): void {
    cliLogger.debug('INK_ADAPTER', 'Clear plan steps');
    this.runtime.clearPlanSteps();
  }

  commitAllPendingEntries(): void {
    cliLogger.debug('INK_ADAPTER', 'Commit all pending entries');
    this.runtime.commitAllPendingEntries();
  }

  /**
   * Update provider info
   */
  updateProvider(provider: string, model: string, reasoningEffort?: string): void {
    // Update config and runtime
    this.config.provider = provider;
    this.config.model = model;
    this.config.reasoningEffort = reasoningEffort;
    this.runtime.setProvider(provider);
    this.runtime.setModel(model);
    this.runtime.setReasoningEffort(reasoningEffort);
  }

  /**
   * Update work directory info
   */
  updateWorkDir(workDir: string): void {
    this.config.workDir = workDir;
    this.runtime.setWorkDir(workDir);
  }

  /**
   * Set thinking enabled state (for hint line display)
   */
  setThinkingEnabled(enabled: boolean): void {
    this.runtime.setThinkingEnabled(enabled);
  }

  setRunMode(mode: 'agentic'): void {
    this.runtime.setRunMode(mode);
  }

  // ── Background Tasks (agentic mode) ──────────────────────

  addBackgroundTask(command: string, pid: number): number {
    return this.runtime.addBackgroundTask(command, pid);
  }

  updateBackgroundTask(id: number, updates: {
    status?: 'running' | 'done' | 'error' | 'killed';
    exitCode?: number;
    outputLine?: string;
  }): void {
    this.runtime.updateBackgroundTask(id, updates);
  }

  removeBackgroundTask(id: number): void {
    this.runtime.removeBackgroundTask(id);
  }

  /** 注入"走 daemon kill 后台任务"的处理器 (main.ts → sdkClient.killBackgroundTask)。
   *  不注入则 InkRuntime 回退本地 process.kill (会被 daemon 误判 self-exit)。 */
  setKillBackgroundTaskHandler(fn: (pid: number, force?: boolean) => void): void {
    this.runtime.setKillBackgroundTaskHandler(fn);
  }

  updateBackgroundTaskByPid(pid: number, updates: {
    status?: 'running' | 'done' | 'error' | 'killed';
    exitCode?: number;
  }): void {
    this.runtime.updateBackgroundTaskByPid(pid, updates);
  }

  showContextMenu(): Promise<void> {
    return new Promise((resolve) => {
      this.runtime.showContextMenu();

      // Wait for menu to be closed (poll for state change)
      const checkInterval = setInterval(() => {
        if (!this.runtime.getContextMenuActive()) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
    });
  }

  /**
   * Prompt for text input
   */
  async promptText(options: {
    message: string;
    initial?: string;
    defaultValue?: string;
    hint?: string;
    allowEmpty?: boolean;
    password?: boolean;
  }): Promise<string | null> {
    return new Promise((resolve) => {
      // Show text prompt via runtime
      this.runtime.showTextPrompt({
        message: options.message,
        defaultValue: options.defaultValue ?? options.initial,
        hint: options.hint,
        allowEmpty: options.allowEmpty ?? false,
        password: options.password ?? false,
        onSubmit: (value: string) => {
          this.runtime.hideTextPrompt();
          resolve(value);
        },
        onCancel: () => {
          this.runtime.hideTextPrompt();
          resolve(null);
        },
      });
    });
  }

  /**
   * Prompt for select menu
   */
  async promptSelect(options: {
    message: string;
    choices: Array<{ title: string; value: string; description?: string; isCurrent?: boolean }>;
    initial?: number;
    initialValue?: string;
    hint?: string;
    header?: string;
    allowTextInput?: boolean;
  }): Promise<string | null> {
    return new Promise((resolve) => {
      this.runtime.hideSelectMenu();

      // Convert choices to SelectMenu format
      const menuChoices = options.choices.map(c => ({
        label: c.title,
        value: c.value,
        description: c.description,
        isCurrent: c.isCurrent,
      }));

      let initialIndex = options.initial || 0;
      if (options.initialValue) {
        const foundIndex = options.choices.findIndex(c => c.value === options.initialValue);
        if (foundIndex >= 0) {
          initialIndex = foundIndex;
        }
      }

      // This prevents ghosting/残影 issues when rapidly switching between menus
      setTimeout(() => {
        // Show select menu via runtime
        this.runtime.showSelectMenu({
          message: options.message,
          choices: menuChoices,
          initialIndex,
          hint: options.hint,
          header: options.header,
          allowTextInput: options.allowTextInput,
          onSelect: (value: string) => {
            this.runtime.hideSelectMenu();
            setTimeout(() => resolve(value), 100);
          },
          onCancel: () => {
            this.runtime.hideSelectMenu();
            setTimeout(() => resolve(null), 100);
          },
        });
      }, 100); // Increased delay from 50ms to 100ms to allow render cycle to complete fully
    });
  }

  /**
   * Handle select back (navigation in select menu)
   */
  handleSelectBack(): boolean {
    cliLogger.debug('INK_ADAPTER', 'Handle select back');
    if (this.runtime.isSelectMenuActive()) {
      this.runtime.hideSelectMenu();
      return true;
    }
    return false;
  }

  // === Tool Result Display Methods (using proper tool card types) ===
  // (start status like 'searching', 'loading' are ignored)

  addWebSearchResult(options: any): void {
    // Skip 'searching' status - only show completed results
    if (options.status === 'searching') {
      cliLogger.debug('INK_ADAPTER', 'Skip web search start (waiting for completion)');
      return;
    }
    cliLogger.debug('INK_ADAPTER', 'Add web search result', { options });
    const text = options.query || 'query';
    const details = options.results ? `Found ${options.results.length} results` : undefined;
    this.runtime.addEntry({ type: 'web_search', text, details, sourceLabel: options.sourceLabel });
  }

  addWebFetchResult(options: any): void {
    // Skip 'fetching' status - only show completed results
    if (options.status === 'fetching') {
      cliLogger.debug('INK_ADAPTER', 'Skip web fetch start (waiting for completion)');
      return;
    }
    cliLogger.debug('INK_ADAPTER', 'Add web fetch result', { options });
    const text = options.url || 'URL';
    const details = options.contentLength
      ? `${(options.contentLength / 1024).toFixed(1)}KB`
      : options.contentPreview ? `${options.contentPreview.length} chars` : undefined;
    this.runtime.addEntry({ type: 'web_fetch', text, details, sourceLabel: options.sourceLabel });
  }

  addReadFileResult(options: any): void {
    // Skip 'reading' status - only show completed results
    if (options.status === 'reading') {
      cliLogger.debug('INK_ADAPTER', 'Skip read file start (waiting for completion)');
      return;
    }
    cliLogger.debug('INK_ADAPTER', 'Add read file result', { options });
    const multi: string[] = Array.isArray(options.filePaths) ? options.filePaths.filter(Boolean) : [];
    const filePath = options.filePath
      ? InkUIAdapter.toWorkspaceRelative(options.filePath)
      : multi.length > 0
        ? multi.map((p: string) => InkUIAdapter.toWorkspaceRelative(p)).join(', ')
        : 'file';
    /* 多文件读取的行数是合并后的总数, 分不到每个文件头上, 就不报了 */
    const text = options.totalLines && multi.length <= 1
      ? `${filePath} — ${options.totalLines} lines read`
      : filePath;
    if (options.status === 'error') {
      this.runtime.addEntry({ type: 'readfile', text: `${filePath}, ✗ ERROR`, details: options.error, sourceLabel: options.sourceLabel });
      return;
    }
    const detailParts: string[] = [];
    if (options.totalLines) {
      detailParts.push(`${options.totalLines} lines`);
    }
    if (options.fileSize) {
      detailParts.push(options.fileSize);
    }
    const details = detailParts.length > 0 ? detailParts.join(', ') : undefined;
    this.runtime.addEntry({ type: 'readfile', text, details, sourceLabel: options.sourceLabel });
  }

  addSearchResult(options: any): void {
    // Skip 'searching' status
    if (options.status === 'searching') {
      cliLogger.debug('INK_ADAPTER', 'Skip search start (waiting for completion)');
      return;
    }
    cliLogger.debug('INK_ADAPTER', 'Add search result', { options });

    const parts: string[] = [];

    // 1. Pattern (必需)
    if (options.pattern) {
      parts.push(`pattern="${options.pattern}"`);
    }

    if (options.filePath) {
      const rel = InkUIAdapter.toWorkspaceRelative(options.filePath);
      parts.push(`path="${rel === '' ? '.' : rel}"`);
    }

    // 3. Mode
    if (options.mode) {
      parts.push(`mode="${options.mode}"`);
    }

    /* 4. Strategy —— rg / fallback / index 是**内部实现细节**, 用户不需要知道
     *   我们底下用的哪个搜索引擎, 出错时也不是他能处理的。只在调试时露出。 */
    if (options.strategy && process.env.CLI_DEBUG === '1') {
      parts.push(`engine="${options.strategy}"`);
    }

    // 5. 结果统计
    if (options.status === 'completed') {
      if (options.matchCount !== undefined) {
        parts.push(`matches=${options.matchCount}`);
      }
    } else if (options.status === 'error') {
      parts.push('✗ ERROR');
    }

    const text = parts.join(', ');

    const detailLines: string[] = [];

    // 显示简化的命令（去掉过长的路径和重复的 -g 参数）
    if (options.command) {
      const simplifiedCommand = this.simplifyRipgrepCommand(options.command);
      detailLines.push(`$ ${simplifiedCommand}`);
      detailLines.push(''); // 空行分隔
    }

    // 显示错误或结果详情
    if (options.status === 'error' && options.error) {
      // 尝试解析 JSON 错误信息
      detailLines.push(parseErrorMessage(options.error));
    } else if (options.details) {
      detailLines.push(options.details);
    }

    const details = detailLines.length > 0 ? detailLines.join('\n') : undefined;

    this.runtime.addEntry({ type: 'search', text, details, sourceLabel: options.sourceLabel });
  }

  addSearchFilesResult(options: any): void {
    // Skip 'searching' status
    if (options.status === 'searching') {
      cliLogger.debug('INK_ADAPTER', 'Skip search files start (waiting for completion)');
      return;
    }
    cliLogger.debug('INK_ADAPTER', 'Add search files result', { options });
    const parts: string[] = [];
    if (options.pattern) {
      parts.push(`pattern="${options.pattern}"`);
    }
    if (options.path) {
      /* 同 Grep: 绝对路径会把卡头撑爆并中间硬折行, 走相对路径 */
      const rel = InkUIAdapter.toWorkspaceRelative(options.path);
      parts.push(`path="${rel === '' ? '.' : rel}"`);
    }
    if (options.fileCount !== undefined) {
      parts.push(`files=${options.fileCount}`);
    }
    const text = parts.length > 0 ? parts.join(', ') : 'Glob';
    this.runtime.addEntry({ type: 'search_files', text, sourceLabel: options.sourceLabel });
  }

  addShowTreeResult(options: any): void {
    // Skip 'loading' status - only show completed results
    if (options.status === 'loading') {
      cliLogger.debug('INK_ADAPTER', 'Skip show tree start (waiting for completion)');
      return;
    }
    cliLogger.debug('INK_ADAPTER', 'Add show tree result', { options });

    /* 同 Grep/Glob: 相对路径, 别把绝对路径全文贴进卡头 */
    const relTreePath = options.path ? InkUIAdapter.toWorkspaceRelative(options.path) : '';
    const pathDisplay = relTreePath === '' ? '.' : relTreePath;
    const paramParts: string[] = [`path="${pathDisplay}"`];

    // 添加 mode 参数
    if (options.mode) {
      paramParts.push(`mode="${options.mode}"`);
    }

    // 添加 maxDepth 参数（如果有）
    if (options.maxDepth !== undefined && options.maxDepth !== null) {
      paramParts.push(`depth=${options.maxDepth}`);
    }

    // 添加结果大小（如果有）
    if (options.status === 'completed' && options.totalChars) {
      const sizeKB = (options.totalChars / 1024).toFixed(1);
      paramParts.push(`${sizeKB}KB`);
    } else if (options.status === 'error') {
      paramParts.push('✗ ERROR');
    }

    let text = paramParts.join(', ');

    // 解析 smart_tree JSON 输出
    const formattedDetails = this.formatSmartTreeDetails(options.content);

    // 构建 details（显示解析后的信息或错误）
    let details: string | undefined;

    if (options.status === 'error' && options.error) {
      details = `Error: ${options.error}`;
    } else if (formattedDetails) {
      details = formattedDetails;
    } else if (options.content) {
      const lines = options.content
        .replace(/\r\n?/g, '\n')
        .split('\n');
      const maxLines = 6;
      const previewLines = lines.slice(0, maxLines);
      if (lines.length > maxLines) {
        previewLines.push(`... (${lines.length - maxLines} more lines)`);
      }
      details = previewLines.join('\n');
    }

    this.runtime.addEntry({ type: 'show_tree', text, details, sourceLabel: options.sourceLabel });
  }

  commitBackgroundShellLaunch(command: string): void {
    if (!command) return;
    const entryKey = `shell_${command.substring(0, 50)}`;
    const committed = this.runtime.finalizeBackgroundShellEntry(entryKey);
    if (committed) {
      this.backgroundedShellKeys.add(entryKey);
      this.committedShellKeys.add(entryKey);
      if (this.activeShellKey) this.committedShellKeys.add(this.activeShellKey);
      this.activeShellKey = null;
    }
  }

  addCommandExecResult(options: any): void {
    const command = options.command || 'command';
    const entryKey = `shell_${command.substring(0, 50)}`;

    if (options.status === 'running') {
      cliLogger.debug('INK_ADAPTER', 'Add command exec running', { command });
      this.committedShellKeys.delete(entryKey); // 新的一次执行
      this.activeShellKey = entryKey;

      // 构建详细的状态信息
      const metaParts: string[] = [];
      if (options.timeout) {
        metaParts.push(`timeout=${Math.round(options.timeout / 1000)}s`);
      }
      if (options.background) {
        metaParts.push('bg');
      }
      const metaStr = metaParts.length > 0 ? ` (${metaParts.join(', ')})` : '';
      this.runtime.updatePendingEntryByKey(entryKey, {
        type: 'command_running',
        text: `$ ${command}${metaStr}`,
        details: options.cwd ? `cwd: ${options.cwd}` : undefined,
        isStreaming: true,
        sourceLabel: options.sourceLabel,
      });
      return;
    }

    //   找不到 pending 会新建一条 → 重复)。清掉标记直接返回。
    if (this.backgroundedShellKeys.has(entryKey)) {
      this.backgroundedShellKeys.delete(entryKey);
      return;
    }
    if (this.committedShellKeys.has(entryKey)) return;

    cliLogger.debug('INK_ADAPTER', 'Add command exec result', { options });
    const isError = options.status === 'error';

    let details: string | undefined;
    const output = options.output || options.error || '';
    if (output) {
      const lines = output.split('\n');
      const maxLines = 10;
      if (lines.length > maxLines) {
        details = lines.slice(0, maxLines).join('\n') + `\n... (+${lines.length - maxLines} lines)`;
      } else {
        details = output.slice(0, 800);
      }
    }

    const exitInfo = options.exitCode !== undefined && options.exitCode !== 0
      ? ` (exit=${options.exitCode})`
      : '';

    this.runtime.updatePendingEntryByKey(entryKey, {
      type: 'command_exec',
      text: `$ ${command}${exitInfo}`,
      details,
      isStreaming: false,
      sourceLabel: options.sourceLabel,
    });
    this.runtime.commitPendingEntryByKey(entryKey);
    this.committedShellKeys.add(entryKey);
  }

  updateShellOutputStream(options: {
    command: string;
    output: string;
    elapsed: number;
    isComplete?: boolean;
    exitCode?: number;
  }): void {
    const entryKey = this.activeShellKey ?? `shell_${options.command.substring(0, 50)}`;
    if (this.committedShellKeys.has(entryKey)) return;

    /* 运行中: 只给尾巴 8 行 (进度在尾巴上); 完成: 给全部, 由卡片取头几行 + "… +N lines"。
     * 原来前面拼一行 "... (+276 lines)" —— 卡片把它当成输出第一行画出来, 读起来像输出本身。 */
    const outputLines = options.output.split('\n').filter(l => l.trim());
    const truncatedOutput = (options.isComplete ? outputLines : outputLines.slice(-8)).join('\n');

    // 格式化时间
    const formatElapsed = (seconds: number): string => {
      if (seconds < 60) return `${seconds}s`;
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      return `${mins}m ${secs}s`;
    };

    if (options.isComplete) {
      // 命令完成 - 提交到 static
      const exitInfo = options.exitCode !== undefined && options.exitCode !== 0
        ? ` (exit=${options.exitCode})`
        : '';
      this.runtime.updatePendingEntryByKey(entryKey, {
        type: 'command_exec',
        text: `$ ${options.command}${exitInfo}`,
        details: truncatedOutput,
        isStreaming: false,
      });
      this.runtime.commitPendingEntryByKey(entryKey);
      this.committedShellKeys.add(entryKey);
    } else {
      // 命令执行中 - 更新 pending entry
      this.runtime.updatePendingEntryByKey(entryKey, {
        type: 'command_running',
        text: `$ ${options.command}`,
        details: truncatedOutput || `Running... ${formatElapsed(options.elapsed)}`,
        isStreaming: true,
      });
    }
  }

  addCodeExecResult(options: any): void {
    cliLogger.debug('INK_ADAPTER', 'Add code exec result', { options });

    const toolName = options.toolName || 'execute';

    if (options.status === 'running') {
      // 显示正在执行的状态，包含代码预览
      const codePreview = options.code ? this.formatCodePreview(options.code, 15) : '';
      const text = `Running ${toolName}`;
      this.runtime.addEntry({
        type: 'code_exec',
        text,
        details: codePreview,
        sourceLabel: options.sourceLabel
      });
      return;
    }

    // 完成状态：显示执行结果
    const isSuccess = options.status === 'completed' || options.exitCode === 0;
    const text = `Code: ${toolName}`;

    // 构建详情信息
    const detailParts: string[] = [];

    // 状态行
    if (isSuccess) {
      detailParts.push('✓ Code executed successfully');
    } else {
      detailParts.push('✗ Code execution failed');
    }

    // 执行时间（如果有）
    if (options.execTime !== undefined) {
      detailParts.push(`Execution time: ${options.execTime}ms`);
    }

    // 退出码
    if (options.exitCode !== undefined) {
      detailParts.push(`Exit code: ${options.exitCode}`);
    }

    // 输出预览（限制行数）
    const output = options.output || options.error || '';
    if (output) {
      const outputLines = output.split('\n').slice(0, 8);
      if (outputLines.length > 0) {
        detailParts.push('');
        detailParts.push('Output:');
        detailParts.push(...outputLines.map((line: string) => `  ${line.slice(0, 100)}`));
        if (output.split('\n').length > 8) {
          detailParts.push(`  ... (${output.split('\n').length - 8} more lines)`);
        }
      }
    }

    const details = detailParts.join('\n');
    this.runtime.addEntry({ type: 'code_exec', text, details, sourceLabel: options.sourceLabel });
  }

  private formatCodePreview(code: string, maxLines: number): string {
    const lines = code.split('\n');
    const preview = lines.slice(0, maxLines);
    const lineNumWidth = String(Math.min(lines.length, maxLines)).length;

    const formatted = preview.map((line, i) => {
      const lineNum = String(i + 1).padStart(lineNumWidth, ' ');
      return `${lineNum} │ ${line}`;
    });

    if (lines.length > maxLines) {
      formatted.push(`   ... (${lines.length - maxLines} more lines)`);
    }

    return formatted.join('\n');
  }

  /**
   * Git 工具结果渲染
   */
  addGitResult(data: any): void {
    const sub = data.subcommand || 'git';
    const entryKey = `git_${sub}_${Date.now()}`;

    // 构建显示命令
    const cmdParts = [`git ${sub}`];
    if (data.args) {
      if (data.args.path && data.args.path !== '.') cmdParts.push(data.args.path);
      if (data.args.staged) cmdParts.push('--staged');
      if (data.args.file_path) cmdParts.push(data.args.file_path);
      if (data.args.message) cmdParts.push(`-m "${data.args.message}"`);
      if (data.args.n) cmdParts.push(`-n ${data.args.n}`);
    }
    const cmdStr = cmdParts.join(' ');

    // 映射 subcommand → entry type
    const typeMap: Record<string, string> = {
      status: 'git_status',
      diff: 'git_diff',
      log: 'git_log',
      commit: 'git_commit',
    };
    const entryType = (typeMap[sub] || 'git_running') as TimelineEntry['type'];

    if (data.status === 'running') {
      this.runtime.updatePendingEntryByKey(entryKey, {
        type: entryType,
        text: cmdStr,
        isStreaming: true,
        sourceLabel: data.sourceLabel,
      });
      return;
    }

    // 构建输出摘要
    let details: string | undefined;
    if (data.error) {
      details = String(data.error).slice(0, 500);
    } else if (data.output) {
      const raw = String(data.output);
      const lines = raw.split('\n');
      if (lines.length > 12) {
        details = lines.slice(0, 12).join('\n') + `\n... (+${lines.length - 12} lines)`;
      } else {
        details = raw.slice(0, 800);
      }
    } else if (data.summary) {
      details = data.summary;
    }

    const isError = data.status === 'error';
    this.runtime.addEntry({
      type: isError ? 'tool_error' as const : entryType,
      text: cmdStr,
      details,
      sourceLabel: data.sourceLabel,
    });
  }

  addPTCResult(data: any): void {
    const entryKey = data.entryKey || `ptc_${Date.now()}`;
    const desc = data.description || 'PTC script';

    if (data.status === 'running') {
      this.runtime.updatePendingEntryByKey(entryKey, {
        type: 'ptc_running' as TimelineEntry['type'],
        text: desc,
        isStreaming: true,
        sourceLabel: data.sourceLabel,
      });
      return;
    }

    // 解析 meta: [PTC: N tool calls, Xms]
    const raw = data.output || data.error || '';
    const metaMatch = raw.match(/^\[PTC:\s*(\d+)\s*tool calls?,\s*(\d+)ms\]/);
    const meta = metaMatch ? `[PTC: ${metaMatch[1]} tool calls, ${metaMatch[2]}ms]` : '';
    const body = raw.replace(/^\[PTC:.*?\]\n?/, '').trim();

    // 截取输出摘要
    let details: string | undefined;
    if (body) {
      const lines = body.split('\n');
      if (lines.length > 10) {
        details = lines.slice(0, 10).join('\n') + `\n... (+${lines.length - 10} lines)`;
      } else {
        details = body.slice(0, 800);
      }
    }

    const isError = data.status === 'error';
    const message = meta ? `${meta}\n${desc}` : desc;

    this.runtime.updatePendingEntryByKey(entryKey, {
      type: (isError ? 'ptc_error' : 'ptc_complete') as TimelineEntry['type'],
      text: message,
      details,
      sourceLabel: data.sourceLabel,
      isStreaming: false,
      isComplete: true,
    });
    this.runtime.commitPendingEntryByKey(entryKey);
  }

  /**
   * Memory 工具 — adapter 只传原始数据，格式化交给 ToolCard
   */
  addMemoryResult(data: any): void {
    const operation = typeof data.operation === 'string' ? data.operation.toLowerCase() : '';
    const action = typeof data.action === 'string' ? data.action.toLowerCase() : '';
    // 稳定 key，running 和 completed 共享同一个 pending entry
    const entryKey = `memory_${operation}_${action}`;
    const text = data.text || data.operation || 'Memory';

    if (data.status === 'running') {
      this.runtime.updatePendingEntryByKey(entryKey, {
        type: 'memory_running' as TimelineEntry['type'],
        text,
        isStreaming: true,
        sourceLabel: data.sourceLabel,
      });
      return;
    }

    // 完成：更新同一个 pending entry 的内容，然后 commit 到 static
    const isError = data.status === 'error';
    const isReadLike = operation === 'read_memory' || action === 'read' || action === 'search';
    const entryType = isError ? 'tool_error' : (isReadLike ? 'memory_read' : 'memory_write');

    let details: string | undefined;
    if (data.error) {
      details = String(data.error).slice(0, 300);
    } else if (data.output) {
      details = String(data.output);
    }

    // 更新 pending entry 内容
    this.runtime.updatePendingEntryByKey(entryKey, {
      type: entryType as TimelineEntry['type'],
      text,
      details,
      memoryAction: action || (isReadLike ? 'read' : 'write'),
      memorySearchQuery: data.searchQuery,
      isStreaming: false,
      sourceLabel: data.sourceLabel,
    });
    // 提交到 static（自动标记 isComplete: true）
    this.runtime.commitPendingEntryByKey(entryKey);
  }

  showPlanUpdate(explanation: string | undefined, plan: Array<{ step: string; status: 'pending' | 'in_progress' | 'completed' }>, sourceLabel?: string) {
    this.runtime.addEntry({
      type: 'plan',
      planExplanation: explanation,
      planSteps: plan,
      sourceLabel,
    });
  }

  private formatSmartTreeDetails(raw?: string): string | undefined {
    if (!raw) {
      return undefined;
    }

    const trimmed = raw.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
      return undefined;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return undefined;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }

    // Check for smart_tree keys
    const hasSmartTreeKeys = [
      'path',
      'project_types',
      'root_dirs',
      'modules',
      'config_files',
      'tip',
      'error',
    ].some((key) => Object.prototype.hasOwnProperty.call(parsed, key));

    if (!hasSmartTreeKeys) {
      return undefined;
    }

    if (typeof parsed.error === 'string' && parsed.error.trim()) {
      return `error: ${parsed.error.trim()}`;
    }

    const lines: string[] = [];

    const pathValue = typeof parsed.path === 'string' ? parsed.path.trim() : '';
    if (pathValue) {
      lines.push(`Path: ${pathValue}`);
    }

    const projectTypes = this.formatSmartTreeList(parsed.project_types, 6);
    if (projectTypes !== undefined) {
      lines.push(`Project Type: ${projectTypes}`);
    }

    const rootDirs = this.formatSmartTreeList(parsed.root_dirs, 12);
    if (rootDirs !== undefined) {
      lines.push(`Root Directories: ${rootDirs}`);
    }

    const modules = this.formatSmartTreeList(parsed.modules, 12);
    if (modules !== undefined) {
      lines.push(`Modules: ${modules}`);
    }

    const configFiles = this.formatSmartTreeList(parsed.config_files, 8);
    if (configFiles !== undefined) {
      lines.push(`Config Files: ${configFiles}`);
    }

    const tipValue = typeof parsed.tip === 'string' ? parsed.tip.trim() : '';
    if (tipValue) {
      lines.push(`Tip: ${tipValue}`);
    }

    if (lines.length === 0) {
      return undefined;
    }

    return lines.join('\n');
  }

  private formatSmartTreeList(value: unknown, limit: number): string | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }

    const items = value
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);

    if (items.length === 0) {
      return '(none)';
    }

    const shown = items.slice(0, limit);
    const extra = items.length - shown.length;
    const suffix = extra > 0 ? ` ...(+${extra} more)` : '';

    return `${shown.join(', ')}${suffix}`;
  }

  addWriteFileCall(filePath: string, content: string, sourceLabel?: string): void {
    cliLogger.debug('INK_ADAPTER', 'Add write file call', { filePath, sourceLabel });

    const contentLines = content.split('\n');
    const totalLines = contentLines.length;
    const previewLines = contentLines.slice(0, 15); // Show first 15 lines
    const lineNumWidth = String(Math.min(totalLines, 15)).length;

    // Build preview with line numbers (similar to legacy output but without colors)
    const preview: string[] = [];
    preview.push(`+++ new: ${totalLines} lines`);
    preview.push('');

    for (let i = 0; i < previewLines.length; i++) {
      const lineNum = String(i + 1).padStart(lineNumWidth, ' ');
      preview.push(`${lineNum} + ${previewLines[i]}`);
    }

    if (totalLines > 15) {
      preview.push(`   ... (${totalLines - 15} more lines)`);
    }

    const text = `Writing ${filePath} (${totalLines} lines)`;
    const details = preview.join('\n');
    this.runtime.addEntry({ type: 'file_update', text, details, sourceLabel });
  }

  addEditFileCall(filePath: string, oldString: string, newString: string, startLine?: number, sourceLabel?: string): void {
    cliLogger.debug('INK_ADAPTER', 'Add edit file call', { filePath, sourceLabel });

    const oldLinesArr = oldString ? oldString.split('\n') : [];
    const newLinesArr = newString ? newString.split('\n') : [];
    const baseLineNum = startLine || 1;

    // Generate unified diff format (similar to legacy output but without colors)
    const diffLines: string[] = [];
    diffLines.push(`─── old: ${oldLinesArr.length} lines`);
    diffLines.push(`+++ new: ${newLinesArr.length} lines`);
    diffLines.push('');

    // Calculate line number width for formatting
    const maxLineNum = baseLineNum + Math.max(oldLinesArr.length, newLinesArr.length);
    const lineNumWidth = String(maxLineNum).length;

    // Show diffs side-by-side
    const maxLen = Math.max(oldLinesArr.length, newLinesArr.length);
    for (let i = 0; i < maxLen; i++) {
      const lineNum = baseLineNum + i;
      const lineNumStr = String(lineNum).padStart(lineNumWidth, ' ');
      const oldLine = oldLinesArr[i];
      const newLine = newLinesArr[i];

      // Show old line (if exists) with "-"
      if (oldLine !== undefined) {
        diffLines.push(`${lineNumStr} - ${oldLine}`);
      }

      // Show new line (if exists) with "+"
      if (newLine !== undefined) {
        diffLines.push(`${lineNumStr} + ${newLine}`);
      }
    }

    const text = `Editing ${filePath}${startLine ? ` @${startLine}` : ''}`;
    const details = diffLines.join('\n');
    this.runtime.addEntry({ type: 'file_update', text, details, sourceLabel });
  }

  addEditFileResult(options: any): void {
    cliLogger.debug('INK_ADAPTER', 'Add edit file result', { options });

    // The second entry is redundant and confusing
    // Just log it for debugging
    if (process.env.CLI_DEBUG === '1') {
      cliLogger.debug('INK_ADAPTER', 'Edit file result (already shown)', {
        filePath: options.filePath,
        status: options.status,
        summary: options.summary,
      });
    }

    // Skip adding another timeline entry - diff was already displayed
    // by the edit_file_stream event handler
  }

  private static toWorkspaceRelative(filePath: string): string {
    if (!filePath || !filePath.startsWith('/')) return filePath;
    const cwd = process.cwd();
    if (filePath === cwd) return '.';
    if (filePath.startsWith(cwd + '/')) return filePath.slice(cwd.length + 1);
    /* 工作区外的文件: 保尾两段, 够认人又不撑爆卡头 */
    const parts = filePath.split('/').filter(Boolean);
    return parts.length <= 2 ? filePath : '…/' + parts.slice(-2).join('/');
  }

  addFileUpdate(filePath: string, codeLines: any[], description: string, language?: string): void {
    cliLogger.debug('INK_ADAPTER', 'Add file update', { filePath, description });
    const text = filePath;
    const details = `${description} (${codeLines.length} lines)`;
    this.runtime.addEntry({ type: 'file_update', text, details });
  }

  startEditFile(
    filePath: string,
    language: string,
    oldString: string,
    newString: string,
    startLine?: number,
    description?: string,
    hunks?: Array<{ oldString: string; newString: string; startLine: number }>
  ): void {
    cliLogger.debug('INK_ADAPTER', 'Start edit file', { filePath, startLine, description });

    const diffSegments: Array<{ lines: DiffLine[]; base: number }> = [];

    if (hunks && hunks.length > 0) {
      for (const hunk of hunks) {
        diffSegments.push({
          lines: generateDiffLines(hunk.oldString || '', hunk.newString || '', filePath, { maxLines: 30 }),
          base: hunk.startLine > 0 ? hunk.startLine : (startLine || 1),
        });
      }
    } else {
      diffSegments.push({
        lines: generateDiffLines(oldString || '', newString || '', filePath, { maxLines: 40 }),
        base: startLine && startLine > 0 ? startLine : 1,
      });
    }

    const allDiffLines: DiffLine[] = diffSegments.flatMap(seg => seg.lines);

    // 统计 +/- 行数
    const summary = diffSummary(allDiffLines);

    // 将 DiffLine[] 序列化为纯文本，由 ToolCard 解析着色
    // 格式：type:lineNum:content  (lineNum 从 @@ hunk header 推算)
    const detailLines: string[] = [];
    detailLines.push(`H:0:--- a/${filePath}`);
    detailLines.push(`H:0:+++ b/${filePath}`);

    for (const seg of diffSegments) {
      /* 每段以它在**真实文件**里的起始行为基准。@@ 头里的数字是片段内的相对行号
       * (恒为 1), 只用来算段内偏移, 不再直接当行号用。 */
      let oldLineNum = seg.base;
      let newLineNum = seg.base;

      for (const dl of seg.lines) {
        switch (dl.type) {
          case 'header': {
            if (dl.content.startsWith('--- ') || dl.content.startsWith('+++ ')) continue;
            const hhMatch = dl.content.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/);
            if (hhMatch) {
              /* 片段内 @@ 从 1 起算 → 减 1 得偏移, 再叠到真实基准上 */
              oldLineNum = seg.base + (parseInt(hhMatch[1], 10) - 1);
              newLineNum = seg.base + (parseInt(hhMatch[2], 10) - 1);
            }
            detailLines.push(`H:0:${dl.content}`);
            break;
          }
          case 'add':
            detailLines.push(`+:${newLineNum}:${dl.content}`);
            newLineNum++;
            break;
          case 'remove':
            detailLines.push(`-:${oldLineNum}:${dl.content}`);
            oldLineNum++;
            break;
          case 'context':
            detailLines.push(`C:${newLineNum}:${dl.content}`);
            oldLineNum++;
            newLineNum++;
            break;
        }
      }
    }

    const text = `Edited ${InkUIAdapter.toWorkspaceRelative(filePath)}${startLine ? ` @${startLine}` : ''} ${summary}`;
    const details = detailLines.join('\n');
    this.runtime.addEntry({ type: 'file_update', text, details });
  }

  startWriteFile(
    filePath: string,
    language: string,
    content: string,
    description?: string
  ): void {
    cliLogger.debug('INK_ADAPTER', 'Start write file', { filePath, description });

    const contentLines = content.split('\n');
    const detailLines: string[] = [];

    detailLines.push(`H:0:+++ b/${filePath} (new file)`);

    const maxLinesToShow = 15;
    const linesToShow = Math.min(contentLines.length, maxLinesToShow);
    const totalLines = contentLines.length;

    detailLines.push(`H:0:@@ +1,${totalLines} @@`);

    for (let i = 0; i < linesToShow; i++) {
      detailLines.push(`+:${i + 1}:${contentLines[i]}`);
    }

    if (contentLines.length > maxLinesToShow) {
      detailLines.push(`H:0:... (${contentLines.length - maxLinesToShow} more lines)`);
    }

    const text = `Edited ${InkUIAdapter.toWorkspaceRelative(filePath)} (new file) +${totalLines} -0`;
    const details = detailLines.join('\n');
    this.runtime.addEntry({ type: 'file_update', text, details });
  }

  updateCodeGenerationPreview(filePath: string, content: string, language: string, description?: string): void {
    cliLogger.debug('INK_ADAPTER', 'Update code generation preview', { filePath });
    const text = filePath;
    const details = description || `${language} (${content.length} bytes)`;
    this.runtime.addEntry({ type: 'file_update', text, details });
  }

  completeCodeGenerationPreview(filePath: string, content?: string): void {
    cliLogger.debug('INK_ADAPTER', 'Complete code generation preview', { filePath });
    const text = filePath;
    this.runtime.addEntry({ type: 'file_update', text });
  }

  parseCodeToDiff(code: string, isNewFile: boolean = true): any[] {
    cliLogger.debug('INK_ADAPTER', 'Parse code to diff');
    const lines = code.split('\n');
    const maxLines = 2000;
    const limited = lines.slice(0, maxLines);
    return limited.map((line, index) => ({
      lineNumber: index + 1,
      marker: isNewFile ? '+' : ' ',
      content: line,
    }));
  }

  updateSelectList(selectedIndex: number): void {
    cliLogger.debug('INK_ADAPTER', 'Update select list', { selectedIndex });
    this.runtime.updateSelectMenuIndex(selectedIndex);
  }

  getRunningToolLogId(toolId: string): number | undefined {
    return this.toolLogIdByToolId.get(toolId);
  }

  resolveRunningToolIdByName(toolName: string, sourceLabel?: string): string | undefined {
    const normalizedName = (toolName || '').toLowerCase();
    const entries = Array.from(this.toolLogNameByToolId.entries());
    for (let i = entries.length - 1; i >= 0; i--) {
      const [toolId, name] = entries[i];
      if ((name || '').toLowerCase() !== normalizedName) {
        continue;
      }
      if (!this.toolLogIdByToolId.has(toolId)) {
        continue;
      }
      if (sourceLabel) {
        const matchedSource = this.toolLogSourceLabelByToolId.get(toolId);
        if (matchedSource && matchedSource !== sourceLabel) {
          continue;
        }
      }
      return toolId;
    }
    return undefined;
  }

  attachImage(path: string): void {
    cliLogger.debug('INK_ADAPTER', 'Attach image', { path });
    this.runtime.attachImage(path);
  }


  /**
   * 添加助理工具事件条目
   */
  addAssistantToolEntry(
    toolName: string,
    text: string,
    options?: {
      details?: string;
      targetAgentId?: string;
      taskId?: string;
      result?: 'success' | 'error' | 'pending';
      sourceLabel?: string;
    }
  ): number {
    const toolTypeMap: Record<string, TimelineEntry['type']> = {
      // Legacy tools (cooperate mode)
      spawn_agent: 'assistant_spawn',
      delegate_task: 'assistant_delegate',
      query_agent: 'assistant_query',
      send_message: 'assistant_message',
      wait_result: 'assistant_wait',
      wait_all: 'assistant_wait',
      terminate_agent: 'assistant_terminate',
      // New Agent OS tools
      spawn_process: 'assistant_spawn',
      list_processes: 'assistant_query',
      read_process_output: 'assistant_query',
      kill_process: 'assistant_terminate',
      pause_process: 'assistant_message',
      resume_process: 'assistant_message',
      wait_process: 'assistant_wait',
      send_to_process: 'assistant_message',
      // Team orchestration
      create_team: 'assistant_spawn',
    };

    const type = toolTypeMap[toolName] || 'assistant_spawn';

    cliLogger.debug('INK_ADAPTER', `Add assistant tool entry: ${toolName}`, {
      type,
      text: text.substring(0, 50),
      targetAgentId: options?.targetAgentId,
    });

    return this.runtime.addEntry({
      type,
      text,
      details: options?.details,
      assistantToolName: toolName,
      assistantTargetAgentId: options?.targetAgentId,
      assistantTaskId: options?.taskId,
      assistantResult: options?.result,
      sourceLabel: options?.sourceLabel,
    });
  }

  updateAssistantToolEntry(entryId: number, updates: {
    details?: string;
    result?: 'success' | 'error' | 'pending';
    text?: string;
  }): void {
    const entryUpdates: Partial<TimelineEntry> = {};
    if (updates.details !== undefined) {
      entryUpdates.details = updates.details;
    }
    if (updates.result !== undefined) {
      entryUpdates.assistantResult = updates.result;
    }
    if (updates.text !== undefined) {
      entryUpdates.text = updates.text;
    }
    this.runtime.updateEntry(entryId, entryUpdates);
  }

  /**
   * 更新助理进度流式卡片
   */
  updateAssistantProgressStream(options: {
    entryKey: string;
    text: string;
    details?: string;
    result?: 'success' | 'error' | 'pending';
    sourceLabel?: string;
  }): void {
    this.runtime.updatePendingEntryByKey(options.entryKey, {
      type: 'assistant_wait',
      text: options.text,
      details: options.details,
      assistantToolName: 'wait_all',
      assistantResult: options.result || 'pending',
      isStreaming: true,
      sourceLabel: options.sourceLabel,
    });
  }

  /**
   * 完成助理进度流式卡片
   */
  completeAssistantProgressStream(options: {
    entryKey: string;
    text: string;
    details?: string;
    result?: 'success' | 'error';
    sourceLabel?: string;
  }): void {
    this.runtime.updatePendingEntryByKey(options.entryKey, {
      type: 'assistant_wait',
      text: options.text,
      details: options.details,
      assistantToolName: 'wait_all',
      assistantResult: options.result || 'success',
      isStreaming: false,
      sourceLabel: options.sourceLabel,
    });
    this.runtime.commitPendingEntryByKey(options.entryKey);
  }

  // 使用 pendingEntry（动态区域）实现实时更新，完成后提交到 static

  /**
   * 创建任务 Agent 进度条目（在动态区域，支持实时更新）
   */
  /** 标记后台 agent — 它的卡片从主时间线整个滤掉 (只底部计数) */
  markBackgroundAgent(agentId: string): void {
    this.runtime.markBackgroundAgent(agentId);
  }

  /** 后台 agent 完成/中止 → 从底部 "N agents" 计数移除 (sub_agent done/aborted 事件触发) */
  removeSidebarAgentById(agentId: string): void {
    this.runtime.removeSidebarAgent(agentId);
  }

  /** ESC / Enter 中断时清空底部 Explore/agent 计数 */
  clearSidebarAgents(): void {
    this.runtime.clearSidebarAgents();
  }

  /** 中断时强制收掉 Explore 卡片 + 清计数; 并屏蔽迟到 upsert */
  abortRunningTaskAgents(): void {
    this.taskAgentsSuspended = true;
    this.runtime.abortRunningTaskAgents();
    this.clearAllAgentContexts();
  }

  addTaskAgentEntry(options: {
    agentId: string;
    role: string;
    task: string;
    sourceLabel?: string;
    kind?: 'background';
  }): number {
    // 中断后迟到的 Explore 建卡 → 直接丢弃, 否则底部又冒出来
    if (this.taskAgentsSuspended) {
      return -1;
    }
    this.runtime.upsertSidebarAgent({
      id: options.agentId,
      role: options.role,
      task: options.task,
      status: 'running',
    });

    return this.runtime.addPendingEntry({
      type: 'task_agent_progress' as any,
      text: `${options.role} (${options.task})`,
      taskAgentId: options.agentId,
      taskAgentRole: options.role,
      taskAgentTask: options.task,
      taskAgentStatus: 'running',
      taskAgentKind: options.kind,
      taskAgentToolCount: 0,
      taskAgentTokens: 0,
      taskAgentElapsed: 0,
      taskAgentToolRecords: [],
      sourceLabel: options.sourceLabel || 'Main',
    } as any);
  }

  reserveTaskAgentEntry(options: { role: string; task?: string }): number {
    return this.runtime.addPendingEntry({
      type: 'task_agent_progress' as any,
      text: `${options.role} (${options.task || 'preparing...'})`,
      taskAgentId: `__reserved__${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      taskAgentRole: options.role,
      taskAgentTask: options.task || 'preparing...',
      taskAgentStatus: 'running',
      taskAgentToolCount: 0,
      taskAgentTokens: 0,
      taskAgentElapsed: 0,
      taskAgentToolRecords: [],
      sourceLabel: 'Main',
    });
  }

  fillReservedTaskAgentEntry(entryId: number, options: {
    agentId: string;
    role: string;
    task: string;
    kind?: 'background';
  }): void {
    this.runtime.upsertSidebarAgent({
      id: options.agentId,
      role: options.role,
      task: options.task,
      status: 'running',
    });
    this.runtime.updatePendingEntry(entryId, {
      text: `${options.role} (${options.task})`,
      taskAgentId: options.agentId,
      taskAgentRole: options.role,
      taskAgentTask: options.task,
      taskAgentKind: options.kind,
    } as any);
  }

  releaseReservedTaskAgentEntry(entryId: number): void {
    this.runtime.removePendingEntry(entryId);
  }

  /**
   * 更新任务 Agent 进度条目（动态区域实时刷新）
   */
  updateTaskAgentEntry(entryId: number, updates: {
    status?: 'running' | 'completed' | 'error';
    toolCount?: number;
    tokens?: number;
    elapsed?: number;
    toolRecords?: Array<{
      name: string;
      args?: string;
      status: 'running' | 'done' | 'error';
      duration?: number;
      resultHint?: string;
    }>;
    text?: string;
    groupMembers?: Array<{
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
  }): void {
    // 用户中断后迟到的 Explore 进度更新全部忽略 (卡片已收掉)
    if (this.taskAgentsSuspended && (updates.status === 'running' || updates.status === undefined)) {
      return;
    }
    const entryUpdates: Partial<any> = {};
    if (updates.status !== undefined) entryUpdates.taskAgentStatus = updates.status;
    if (updates.toolCount !== undefined) entryUpdates.taskAgentToolCount = updates.toolCount;
    if (updates.tokens !== undefined) entryUpdates.taskAgentTokens = updates.tokens;
    if (updates.elapsed !== undefined) entryUpdates.taskAgentElapsed = updates.elapsed;
    if (updates.toolRecords !== undefined) entryUpdates.taskAgentToolRecords = updates.toolRecords;
    if (updates.text !== undefined) entryUpdates.text = updates.text;
    if (updates.groupMembers !== undefined) entryUpdates.taskAgentGroupMembers = updates.groupMembers;
    this.runtime.updatePendingEntry(entryId, entryUpdates);

    // 用户中断后迟到的 Explore 事件不得把 "N agents" 刷回来
    if (this.taskAgentsSuspended && (updates.status === 'running' || !updates.status)) {
      return;
    }
    const entry = this.runtime.getEntry(entryId);
    const members = updates.groupMembers ?? (entry as any)?.taskAgentGroupMembers as typeof updates.groupMembers;
    if (entry?.taskAgentId && members && members.length > 0) {
      if (!members.some(m => m.agentId === entry.taskAgentId)) this.runtime.removeSidebarAgent(entry.taskAgentId);
      for (const m of members) {
        this.runtime.upsertSidebarAgent({
          id: m.agentId,
          role: entry.taskAgentRole || 'Task',
          task: m.task || entry.taskAgentTask || '',
          status: m.status,
          toolCount: m.toolCount,
          tokens: m.tokens,
          toolRecords: m.toolRecords?.map(r => ({ name: r.name, args: r.args, status: r.status })),
        });
      }
    } else if (entry?.taskAgentId) {
      this.runtime.upsertSidebarAgent({
        id: entry.taskAgentId,
        role: entry.taskAgentRole || 'Task',
        task: entry.taskAgentTask || '',
        status: updates.status || 'running',
        toolCount: updates.toolCount,
        tokens: updates.tokens,
        // 工具记录带给 sidebar — 后台 agent 详情浮层 (Enter) 用它显示逐条调用
        toolRecords: updates.toolRecords?.map(r => ({ name: r.name, args: r.args, status: r.status })),
      });
    }
  }

  /**
   * 完成任务 Agent 进度条目（从动态区域提交到 static）
   */
  commitTaskAgentEntry(entryId: number): void {
    const entry = this.runtime.getEntry(entryId);
    const isBackground = (entry as any)?.taskAgentKind === 'background'
      || this.runtime.isBackgroundAgent((entry as any)?.taskAgentId);
    if (entry?.taskAgentId) {
      const agentId = entry.taskAgentId;
      const status = (entry as any).taskAgentStatus || 'completed';
      this.runtime.upsertSidebarAgent({
        id: agentId,
        role: entry.taskAgentRole || 'Task',
        task: entry.taskAgentTask || '',
        status: status === 'error' ? 'error' : 'completed',
      });
      /* 分组卡的成员各自登记过 (updateTaskAgentEntry), 收尾时一起标完成, 别留 "running" 挂在底栏 */
      for (const m of ((entry as any).taskAgentGroupMembers ?? []) as Array<{ agentId: string; task?: string; status?: string }>) {
        this.runtime.upsertSidebarAgent({
          id: m.agentId,
          role: entry.taskAgentRole || 'Task',
          task: m.task || '',
          status: m.status === 'error' ? 'error' : 'completed',
        });
      }
    }
    if (isBackground) {
      this.runtime.removePendingEntry(entryId);
      return;
    }
    // 同步 agent: 提交到 static — append 顺序 (= 完成顺序)
    this.runtime.commitPendingEntry(entryId);
  }


  addCCBAgentReview(review: {
    agentId: string;
    agentName: string;
    perspective: string;
    model?: string;
    verdict: 'approve' | 'concern' | 'reject';
    analysis: string;
    risks: string[];
    suggestions: string[];
  }): void {
    cliLogger.debug('INK_ADAPTER', 'Add CCB agent review', {
      agentId: review.agentId,
      agentName: review.agentName,
      verdict: review.verdict,
      model: review.model,
    });

    // 构建评审内容
    const verdictIcon = review.verdict === 'approve' ? '✓' : review.verdict === 'concern' ? '⚠' : '✗';
    const verdictText = review.verdict === 'approve' ? '同意' : review.verdict === 'concern' ? '有顾虑' : '拒绝';

    // 构建详细内容
    const detailLines: string[] = [];

    // 分析内容
    if (review.analysis) {
      detailLines.push(review.analysis);
    }

    // 风险列表
    if (review.risks && review.risks.length > 0) {
      detailLines.push('');
      detailLines.push('**风险:**');
      review.risks.forEach((risk, i) => {
        detailLines.push(`${i + 1}. ${risk}`);
      });
    }

    // 建议列表
    if (review.suggestions && review.suggestions.length > 0) {
      detailLines.push('');
      detailLines.push('**建议:**');
      review.suggestions.forEach((suggestion, i) => {
        detailLines.push(`${i + 1}. ${suggestion}`);
      });
    }

    // 构建显示标签：模型名称 + 角色名称
    const modelDisplay = review.model || 'default';
    const sourceLabel = `${modelDisplay} (${review.agentName})`;

    // 添加为 assistant 类型的条目，带有 CCB 评审标识
    const message: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: detailLines.join('\n') }],
    };

    this.runtime.addEntry({
      type: 'ccb_review',
      text: `${verdictIcon} ${review.agentName}: ${verdictText}`,
      details: detailLines.join('\n'),
      message,
      sourceLabel,
      ccbReview: {
        agentId: review.agentId,
        agentName: review.agentName,
        perspective: review.perspective,
        model: review.model,
        verdict: review.verdict,
        analysis: review.analysis,
        risks: review.risks,
        suggestions: review.suggestions,
      },
    });
  }

  addCCBAgentRetry(data: {
    agentId: string;
    agentName: string;
    perspective: string;
    model?: string;
    retryCount: number;
    maxRetries: number;
    error: string;
  }): void {
    cliLogger.debug('INK_ADAPTER', 'Add CCB agent retry', {
      agentId: data.agentId,
      agentName: data.agentName,
      model: data.model,
      retryCount: data.retryCount,
    });

    // 构建显示标签：模型名称 + 角色名称
    const modelDisplay = data.model || 'default';
    const sourceLabel = `${modelDisplay} (${data.agentName})`;

    this.runtime.addEntry({
      type: 'ccb_retry',
      text: `~ ${data.agentName}: 重试中 (${data.retryCount}/${data.maxRetries})`,
      details: `错误: ${data.error}`,
      sourceLabel,
      ccbRetry: {
        agentId: data.agentId,
        agentName: data.agentName,
        perspective: data.perspective,
        model: data.model,
        retryCount: data.retryCount,
        maxRetries: data.maxRetries,
        error: data.error,
      },
    });
  }

  addCCBAgentFailed(data: {
    agentId: string;
    agentName: string;
    perspective: string;
    model?: string;
    retryCount: number;
    maxRetries: number;
    error: string;
  }): void {
    cliLogger.error('INK_ADAPTER', 'Add CCB agent failed', {
      agentId: data.agentId,
      agentName: data.agentName,
      model: data.model,
      error: data.error,
    });

    // 构建显示标签：模型名称 + 角色名称
    const modelDisplay = data.model || 'default';
    const sourceLabel = `${modelDisplay} (${data.agentName})`;

    this.runtime.addEntry({
      type: 'ccb_failed',
      text: `✗ ${data.agentName}: 评审失败`,
      details: `模型 ${modelDisplay} 评审失败，已重试 ${data.retryCount} 次\n错误: ${data.error}\n该模型暂时下线，不参与本次评审`,
      sourceLabel,
      ccbFailed: {
        agentId: data.agentId,
        agentName: data.agentName,
        perspective: data.perspective,
        model: data.model,
        retryCount: data.retryCount,
        maxRetries: data.maxRetries,
        error: data.error,
      },
    });
  }

  addCCBToolCall(agentId: string, agentName: string, toolName: string, toolArgs: Record<string, unknown>): void {
    cliLogger.debug('INK_ADAPTER', 'Add CCB tool call', {
      agentId,
      agentName,
      toolName,
      toolArgsKeys: Object.keys(toolArgs),
    });

    const toolType = this.mapToolNameToType(toolName) as 'show_tree' | 'search_files' | 'search' | 'readfile' | 'command_exec' | 'mcp_tool' | 'tool_call';
    /* INV-1: Ink 已 mount, console.error 会被 alt-screen 吞 / 被 captureStdout 偷, 走 cliLogger 落文件. */
    if (process.env.CLI_DEBUG === '1') {
      cliLogger.debug('INK_ADAPTER', `addCCBToolCall: toolName="${toolName}", args=${safeDebugStringify(toolArgs)}`);
      cliLogger.debug('INK_ADAPTER', `addCCBToolCall: mapped toolType="${toolType}"`);
    }

    // ToolCard 的 getParamLines() 会解析 JSON 格式的 details，但我们需要确保格式正确
    const formattedDetails = this.formatToolArgsForDisplay(toolName, toolArgs);

    this.runtime.addEntry({
      type: toolType,
      text: `${agentName}`,
      details: formattedDetails,
      sourceLabel: agentName,
    });
  }

  private formatToolArgsForDisplay(toolName: string, toolArgs: Record<string, unknown>): string {
    const lowerName = toolName.toLowerCase();

    if (lowerName === 'show_tree' || lowerName === 'list_directory' || lowerName === 'smart_tree' || lowerName === 'tree') {
      const path = (toolArgs.directory || toolArgs.path || '.') as string;
      const parts: string[] = [`Path: ${path}`];

      if (toolArgs.max_depth !== undefined) {
        parts.push(`Max Depth: ${toolArgs.max_depth}`);
      }
      if (toolArgs.mode) {
        parts.push(`Mode: ${toolArgs.mode}`);
      }

      return parts.join('\n');
    }

    if (lowerName === 'search_files' || lowerName === 'glob') {
      const pattern = (toolArgs.pattern || toolArgs.glob || '*') as string;
      const path = (toolArgs.path || toolArgs.directory || '.') as string;
      return `Pattern: ${pattern}\nPath: ${path}`;
    }

    if (lowerName === 'search' || lowerName === 'grep') {
      const pattern = (toolArgs.pattern || toolArgs.query || '') as string;
      const path = (toolArgs.path || toolArgs.directory || '.') as string;
      const parts: string[] = [`Pattern: ${pattern}`, `Path: ${path}`];

      if (toolArgs.type) {
        parts.push(`Type: ${toolArgs.type}`);
      }

      return parts.join('\n');
    }

    if (lowerName === 'smart_read' || lowerName === 'read' || lowerName === 'readfile') {
      const filePath = (toolArgs.file_path || toolArgs.path || '') as string;
      return `File: ${filePath}`;
    }

    const lines: string[] = [];
    for (const [key, value] of Object.entries(toolArgs)) {
      const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
      const truncated = valueStr.length > 80 ? valueStr.substring(0, 77) + '...' : valueStr;
      lines.push(`${key}: ${truncated}`);
    }
    return lines.join('\n') || '(no args)';
  }

  addCCBToolResult(agentId: string, agentName: string, toolName: string, output: string, isError?: boolean): void {
    cliLogger.debug('INK_ADAPTER', 'Add CCB tool result', {
      agentId,
      agentName,
      toolName,
      isError,
      outputLength: output?.length,
    });

    // 如果需要显示结果，可以取消下面的注释
    // this.runtime.addEntry({
    //   type: isError ? 'tool_error' : 'tool_result',
    //   text: `${agentName}: ${toolName} 结果`,
    //   details: output?.substring(0, 500) || '(empty)',
    //   sourceLabel: agentName,
    // });
  }

  private mapToolNameToType(toolName: string): string {
    if (toolName.startsWith('mcp__')) {
      return 'mcp_tool';
    }
    const mapping: Record<string, string> = {
      // Grep / Search
      'search_files': 'search_files',
      'search': 'search',
      'Grep': 'search',
      'grep': 'search',
      // Glob
      'Glob': 'search_files',
      'glob': 'search_files',
      // Tree / Directory
      'list_directory': 'show_tree',
      'show_tree': 'show_tree',
      'smart_tree': 'show_tree',
      'Tree': 'show_tree',
      'tree': 'show_tree',
      // Read
      'smart_read': 'readfile',
      'Read': 'readfile',
      'read': 'readfile',
      'readfile': 'readfile',
      // Git commands
      'git_status': 'command_exec',
      'git_diff': 'command_exec',
      // Shell
      'Bash': 'command_exec',
      'bash': 'command_exec',
      'execute_shell': 'command_exec',
      // Skills
      'use_skill': 'use_skill',
    };
    return mapping[toolName] || 'tool_call';
  }


  /**
   * 添加 Network 任务分解条目
   */
  addNetworkDecompose(taskCount: number, routingType: string): void {
    cliLogger.debug('INK_ADAPTER', 'Add network decompose', { taskCount, routingType });
    this.runtime.addEntry({
      type: 'network_decompose',
      text: `任务分解完成: ${taskCount} 个子任务`,
      details: `路由策略: ${routingType}`,
    });
  }

  /**
   * 添加 Network 进度条目
   */
  addNetworkProgress(summary: {
    completed: number;
    running: number;
    pending: number;
    failed: number;
    total: number;
  }): void {
    cliLogger.debug('INK_ADAPTER', 'Add network progress', summary);
    this.runtime.addEntry({
      type: 'network_progress',
      text: `执行进度: ${summary.completed}/${summary.total}`,
      networkCompleted: summary.completed,
      networkTotal: summary.total,
      networkRunning: summary.running,
      networkFailed: summary.failed,
      networkPending: summary.pending,
    });
  }

  /**
   * 添加 Network 子任务完成条目
   */
  addNetworkTaskComplete(taskId: string, roleId: string, result: any): void {
    cliLogger.debug('INK_ADAPTER', 'Add network task complete', { taskId, roleId });
    const resultText = typeof result === 'string' ? result : JSON.stringify(result);
    this.runtime.addEntry({
      type: 'network_task',
      text: `${roleId}: ${taskId} 完成`,
      details: this.truncateText(resultText, 500),
      networkTaskId: taskId,
      networkRoleId: roleId,
      isComplete: true,
      sourceLabel: roleId,
    });
  }

  /**
   * 添加 Network 子任务失败条目
   */
  addNetworkTaskFail(taskId: string, roleId: string, error: string): void {
    cliLogger.debug('INK_ADAPTER', 'Add network task fail', { taskId, roleId, error });
    this.runtime.addEntry({
      type: 'network_task',
      text: `${roleId}: ${taskId} 失败`,
      details: error,
      networkTaskId: taskId,
      networkRoleId: roleId,
      isComplete: false,
      sourceLabel: roleId,
    });
  }

  /**
   * 添加 Network 路由决策条目
   */
  addNetworkRoute(fromTask: string, toTask: string, routeType: string): void {
    cliLogger.debug('INK_ADAPTER', 'Add network route', { fromTask, toTask, routeType });
    this.runtime.addEntry({
      type: 'network_route',
      text: `${fromTask} → ${toTask}`,
      details: `路由类型: ${routeType}`,
    });
  }


  /**
   * 添加 Network 任务分析条目
   */
  addNetworkAnalysis(analysis: {
    description: string;
    complexity: number;
    requiredCapabilities: string[];
    estimatedAgents: number;
    ambiguity?: number;
    optionalCapabilities?: string[];
    priority?: 'low' | 'medium' | 'high' | 'critical';
    estimatedTokens?: number;
  }): void {
    cliLogger.debug('INK_ADAPTER', 'Add network analysis', analysis);
    this.runtime.addEntry({
      type: 'network_analysis',
      text: analysis.description,
      networkAnalysis: analysis,
    });
  }

  /**
   * 添加 Network 模式选择条目
   */
  addNetworkModeSelect(mode: 'collaborative' | 'competitive' | 'hierarchical', reason: string, rawAnalysis?: string): void {
    cliLogger.debug('INK_ADAPTER', 'Add network mode select', { mode, reason });
    const modeLabels = {
      collaborative: '协作模式',
      competitive: '竞争模式',
      hierarchical: '层级模式',
    };
    this.runtime.addEntry({
      type: 'network_mode_select',
      text: `选择执行模式: ${modeLabels[mode]}`,
      networkModeSelect: { mode, reason, rawAnalysis },
    });
  }

  addNetworkAgentBidDecision(decision: {
    agentId: string;
    agentName: string;
    participate: boolean;
    reason: string;
    capabilityScore?: number;
    confidence?: number;
  }): void {
    cliLogger.debug('INK_ADAPTER', 'Add network agent bid decision', decision);

    const scoreText = decision.capabilityScore !== undefined
      ? ` (匹配度: ${(decision.capabilityScore * 100).toFixed(0)}%)`
      : '';
    const confidenceText = decision.confidence !== undefined
      ? ` [置信度: ${(decision.confidence * 100).toFixed(0)}%]`
      : '';
    const statusIcon = decision.participate ? '✓' : '✗';
    const statusText = decision.participate ? '参与竞标' : '放弃竞标';

    this.runtime.addEntry({
      type: 'network_agent_bid',
      text: `${statusIcon} ${decision.agentName}${scoreText}: ${statusText}${confidenceText}`,
      details: decision.reason,
      networkAgentBid: decision,
    });
  }

  /**
   * 添加 Network 竞标条目
   */
  addNetworkBidding(bidding: {
    taskId: string;
    totalBids: number;
    selectedAgents: string[];
    topBid?: { agentId: string; confidence: number };
  }): void {
    cliLogger.debug('INK_ADAPTER', 'Add network bidding', bidding);
    this.runtime.addEntry({
      type: 'network_bidding',
      text: `竞标完成: ${bidding.taskId}`,
      networkBidding: bidding,
    });
  }

  /**
   * 添加 Network 协商条目
   */
  addNetworkNegotiation(negotiation: {
    sessionId: string;
    participants: string[];
    status: 'started' | 'voting' | 'consensus' | 'failed';
    rounds?: number;
  }): void {
    cliLogger.debug('INK_ADAPTER', 'Add network negotiation', negotiation);
    const statusLabels = {
      started: '协商开始',
      voting: '投票进行中',
      consensus: '达成共识',
      failed: '协商失败',
    };
    this.runtime.addEntry({
      type: 'network_negotiation',
      text: statusLabels[negotiation.status],
      networkNegotiation: negotiation,
    });
  }

  addNetworkNegotiationMessage(message: {
    sessionId: string;
    agentId: string;
    type: string;
    content: string;
    round: number;
  }): void {
    cliLogger.debug('INK_ADAPTER', 'Add network negotiation message', message);
    const typeLabels: Record<string, string> = {
      'support': '支持',
      'concern': '担忧',
      'counter': '反对',
      'question': '提问',
    };
    // 提取 Agent 名称（去掉 agent- 前缀和后缀 ID）
    const agentName = message.agentId.replace(/^agent-/, '').replace(/-[a-z0-9]+$/, '');
    this.runtime.addEntry({
      type: 'network_negotiation_message',
      text: `${agentName}: ${typeLabels[message.type] || message.type}`,
      networkNegotiationMessage: message,
    });
  }

  /**
   * 添加 Network DAG 创建条目
   */
  addNetworkDAG(dag: {
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
  }): void {
    cliLogger.debug('INK_ADAPTER', 'Add network DAG', dag);
    this.runtime.addEntry({
      type: 'network_dag',
      text: `执行计划生成: ${dag.nodeCount} 个节点`,
      networkDAG: dag,
    });
  }

  /**
   * 添加 Network 节点开始执行条目
   */
  addNetworkNodeStart(node: {
    nodeId: string;
    agentId: string;
    description: string;
  }): void {
    cliLogger.debug('INK_ADAPTER', 'Add network node start', node);
    this.runtime.addEntry({
      type: 'network_node_start',
      text: `${node.nodeId} 开始执行`,
      sourceLabel: node.agentId,
      networkNode: {
        ...node,
        status: 'running',
      },
    });
  }

  /**
   * 添加 Network 节点完成条目
   */
  addNetworkNodeComplete(node: {
    nodeId: string;
    agentId: string;
    description: string;
    output: string;
    duration: number;
  }): void {
    cliLogger.debug('INK_ADAPTER', 'Add network node complete', node);
    this.runtime.addEntry({
      type: 'network_node_complete',
      text: `${node.nodeId} 执行完成`,
      sourceLabel: node.agentId,
      networkNode: {
        ...node,
        status: 'completed',
      },
    });
  }

  /**
   * 添加 Network 节点失败条目
   */
  addNetworkNodeFail(node: {
    nodeId: string;
    agentId: string;
    description: string;
    error: string;
  }): void {
    cliLogger.debug('INK_ADAPTER', 'Add network node fail', node);
    this.runtime.addEntry({
      type: 'network_node_fail',
      text: `${node.nodeId} 执行失败`,
      sourceLabel: node.agentId,
      networkNode: {
        ...node,
        status: 'failed',
      },
    });
  }

  // ==================== Pipeline 节点事件方法 ====================

  /**
   * 添加 Pipeline 节点开始执行条目
   */
  addPipelineNodeStart(node: {
    nodeId: string;
    role: string;
    description: string;
  }): void {
    cliLogger.debug('INK_ADAPTER', 'Add pipeline node start', node);
    this.runtime.addEntry({
      type: 'pipeline_node_start',
      text: `${node.role} 开始执行: ${node.description}`,
      sourceLabel: node.role,
      pipelineNode: {
        nodeId: node.nodeId,
        role: node.role,
        description: node.description,
        status: 'running',
      },
    });
  }

  /**
   * 添加 Pipeline 节点完成条目
   */
  addPipelineNodeComplete(node: {
    nodeId: string;
    role: string;
    description?: string;
    output: string;
  }): void {
    cliLogger.debug('INK_ADAPTER', 'Add pipeline node complete', node);
    this.runtime.addEntry({
      type: 'pipeline_node_complete',
      text: `${node.role} 执行完成`,
      sourceLabel: node.role,
      pipelineNode: {
        nodeId: node.nodeId,
        role: node.role,
        description: node.description,
        output: node.output,
        status: 'completed',
      },
    });
  }

  /**
   * 添加 Pipeline 节点失败条目
   */
  addPipelineNodeFail(node: {
    nodeId: string;
    role: string;
    description?: string;
    error: string;
  }): void {
    cliLogger.debug('INK_ADAPTER', 'Add pipeline node fail', node);
    this.runtime.addEntry({
      type: 'pipeline_node_fail',
      text: `${node.role} 执行失败: ${node.error}`,
      sourceLabel: node.role,
      pipelineNode: {
        nodeId: node.nodeId,
        role: node.role,
        description: node.description,
        error: node.error,
        status: 'failed',
      },
    });
  }

  /**
   * 添加 Network 重规划条目
   */
  addNetworkReplan(replan: {
    dagId: string;
    trigger: string;
    reason: string;
    affectedNodes: string[];
  }): void {
    cliLogger.debug('INK_ADAPTER', 'Add network replan', replan);
    this.runtime.addEntry({
      type: 'network_replan',
      text: `触发重规划: ${replan.trigger}`,
      networkReplan: replan,
    });
  }

  /**
   * 添加 Network 互评条目
   */
  addNetworkPeerReview(review: {
    reviewers: string[];
    averageScore: number;
    summary: string;
  }): void {
    cliLogger.debug('INK_ADAPTER', 'Add network peer review', review);
    this.runtime.addEntry({
      type: 'network_peer_review',
      text: `互评完成: 平均评分 ${review.averageScore.toFixed(1)}/5`,
      networkPeerReview: review,
    });
  }

  private buildToolCallDetails(_args: any, options?: any): string | undefined {
    const args = _args && typeof _args === 'object' ? _args : {};
    const lines: string[] = [];
    if (options?.description) {
      lines.push(String(options.description));
    }
    if (options?.targetPath) {
      lines.push(`path: ${options.targetPath}`);
    }

    const importantKeys = [
      'path', 'file_path', 'directory', 'url',
      'query', 'pattern', 'categories', 'branch',
      'all', 'short', 'staged', 'mode',
    ];
    for (const key of importantKeys) {
      if (!(key in args)) continue;
      if ((key === 'path' || key === 'file_path') && options?.targetPath) continue;
      const value = args[key];
      if (value === undefined || value === null || value === '') continue;

      let display: string;
      if (Array.isArray(value)) {
        display = value.map(v => String(v)).join(', ');
      } else if (typeof value === 'object') {
        try {
          display = JSON.stringify(value);
        } catch {
          display = String(value);
        }
      } else {
        display = String(value);
      }

      if (display.length > 220) {
        display = `${display.slice(0, 219)}…`;
      }
      lines.push(`${key}: ${display}`);
      if (lines.length >= 8) break;
    }

    return lines.length > 0 ? lines.join('\n') : undefined;
  }

  /**
   * 根据工具类型和参数生成人类可读的 summary text
   */
  private buildToolSummaryText(entryType: string, toolName: string, args: any): string {
    if (!args || typeof args !== 'object') return toolName;

    const trunc = (s: string, max = 80) => s.length > max ? s.slice(0, max - 1) + '…' : s;

    // 文件读取
    if (entryType === 'readfile') {
      const p = args.file_path || args.path || '';
      const parts: string[] = [];
      if (args.offset) parts.push(`L${args.offset}`);
      if (args.limit) parts.push(`${args.limit} lines`);
      if (args.symbol) parts.push(`symbol="${args.symbol}"`);
      return parts.length ? `${p} (${parts.join(', ')})` : p || toolName;
    }
    // Grep / search_symbol / get_definitions / get_references / index_stats
    if (entryType === 'search') {
      // search_symbol: query + kind
      if (toolName === 'search_symbol') {
        const q = args.query || args.name || '';
        const parts: string[] = [q ? `"${q}"` : toolName];
        if (args.kind) parts.push(`kind=${args.kind}`);
        if (args.limit) parts.push(`limit=${args.limit}`);
        if (args.path) parts.push(`in ${args.path}`);
        return parts.join(' ');
      }
      if (toolName === 'get_definitions' || toolName === 'get_references') {
        const sym = args.symbol || args.name || args.query || '';
        const p = args.path || args.file_path || '';
        return p ? `"${sym}" in ${p}` : `"${sym}"`;
      }
      if (toolName === 'index_stats') return 'index stats';
      if (toolName === 'build_index') return args.path || 'build index';
      if (toolName === 'analyze_code') return args.path || args.file_path || 'analyze';
      // 普通 grep
      const pat = args.pattern || '';
      const path = args.path || '';
      const parts: string[] = [path ? `"${pat}" in ${path}` : `"${pat}"`];
      if (args.type) parts.push(`type=${args.type}`);
      if (args.glob) parts.push(`glob=${args.glob}`);
      return parts.join(' ');
    }
    // Glob
    if (entryType === 'search_files') {
      const pat = args.pattern || args.glob || '';
      const path = args.path || '';
      return path ? `${pat} in ${path}` : pat || toolName;
    }
    // 目录树
    if (entryType === 'show_tree') {
      const p = args.path || args.directory || '.';
      const parts: string[] = [p];
      if (args.max_depth !== undefined) parts.push(`depth=${args.max_depth}`);
      if (args.mode) parts.push(`mode=${args.mode}`);
      return parts.join(' ');
    }
    // 文件编辑
    if (entryType === 'file_update') {
      const p = args.file_path || args.path || args.directory || '';
      if (toolName === 'create_directory') return `mkdir ${p}`;
      if (toolName === 'delete_file') return `rm ${p}`;
      if (toolName === 'rename_file') return `${args.old_path || p} → ${args.new_path || ''}`;
      return p || toolName;
    }
    // Shell
    if (entryType === 'command_exec') {
      return args.command ? `$ ${trunc(args.command)}` : toolName;
    }
    // 代码执行
    if (entryType === 'code_exec') {
      const code = args.code || '';
      return trunc(code) || toolName;
    }
    // Web
    if (entryType === 'web_fetch') {
      const method = args.method && args.method !== 'GET' ? `${args.method} ` : '';
      return `${method}${args.url || toolName}`;
    }
    if (entryType === 'web_search') {
      return args.query || args.q || toolName;
    }
    // Git
    if (entryType === 'git_status') {
      const flags: string[] = ['status'];
      if (args.short) flags.push('--short');
      if (args.branch) flags.push('--branch');
      return flags.join(' ');
    }
    if (entryType === 'git_diff') {
      const target = args.file || args.path || 'working tree';
      if (args.staged || args.cached) return `${target} --staged`;
      return target;
    }
    if (entryType === 'git_log') {
      const target = args.file || '';
      const count = args.count || args.n || 10;
      return target ? `${target} (${count} commits)` : `${count} commits`;
    }
    if (entryType === 'git_commit') return trunc(args.message || 'commit');
    if (entryType === 'git_running') return args.branch || toolName;
    // MCP — 解析 mcp__serverId__toolName 并展示
    if (entryType === 'mcp_tool') {
      const mcpParts = toolName.split('__');
      const serverName = mcpParts.length >= 2 ? mcpParts[1] : '';
      const mcpToolName = mcpParts.length >= 3 ? mcpParts.slice(2).join('__') : toolName;
      const parts: string[] = [serverName ? `${serverName}/${mcpToolName}` : mcpToolName];
      for (const k of ['path', 'query', 'url', 'command', 'name']) {
        if (args[k] && typeof args[k] === 'string') {
          parts.push(trunc(args[k], 60));
          break;
        }
      }
      return parts.join(' ');
    }
    // Skill — 展示 skill_name
    if (entryType === 'use_skill') {
      return args.skill_name || args.skill_id || args.name || toolName;
    }
    // 通用：尝试提取主要参数
    const primaryKeys = ['path', 'file_path', 'directory', 'file', 'name', 'command', 'query', 'url', 'pattern'];
    for (const k of primaryKeys) {
      if (args[k] && typeof args[k] === 'string') {
        return trunc(args[k]);
      }
    }
    return toolName;
  }

  private formatToolArgs(args: any): string | undefined {
    if (!args || (typeof args === 'object' && Object.keys(args).length === 0)) {
      return undefined;
    }
    try {
      const json = JSON.stringify(args, null, 2);
      return this.truncateText(json, 2000);
    } catch {
      return this.truncateText(String(args), 2000);
    }
  }

  private formatToolOutput(output: string, truncated?: boolean): string {
    if (!output) {
      return '';
    }
    const text = output.trim();
    if (!text) {
      return '';
    }
    if (truncated || text.length > 2000) {
      return this.truncateText(text, 2000);
    }
    return text;
  }

  private formatToolCompletionDetails(rawText: string, toolName?: string): string {
    const text = rawText.trim();
    if (!text) {
      return '';
    }

    const normalizedToolName = (toolName || '').toLowerCase();
    if (normalizedToolName === 'select_tools') {
      return this.formatSelectToolsSummary(text);
    }

    const isSelectTools = normalizedToolName === 'select_tools';
    const maxLines = isSelectTools ? 140 : 40;
    const maxCharsPerLine = isSelectTools ? 320 : 240;

    const lines = text
      .split('\n')
      .map(line => line.length > maxCharsPerLine ? `${line.slice(0, maxCharsPerLine - 1)}…` : line);
    const visible = lines.slice(0, maxLines);
    if (lines.length > maxLines) {
      visible.push(`... (${lines.length - maxLines} more lines)`);
    }
    return visible.join('\n');
  }

  private formatSelectToolsSummary(rawText: string): string {
    const raw = rawText.replace(/\r\n?/g, '\n').trim();
    if (!raw) return '';

    type CategoryNode = { label: string; id: string; tools: string[] };
    const categories: CategoryNode[] = [];
    const directTools: string[] = [];
    let activeCategory: CategoryNode | null = null;

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === '---' || trimmed === '参数:') continue;

      const categoryMatch = trimmed.match(/^##\s+(.+?)\s+\(([^)]+)\)$/);
      if (categoryMatch) {
        activeCategory = {
          label: categoryMatch[1],
          id: categoryMatch[2],
          tools: [],
        };
        categories.push(activeCategory);
        continue;
      }

      const toolMatch = trimmed.match(/^([a-zA-Z0-9_][\w-]*):\s*(.+)$/);
      if (toolMatch && !line.startsWith(' ')) {
        const toolName = toolMatch[1];
        if (activeCategory) {
          if (!activeCategory.tools.includes(toolName)) {
            activeCategory.tools.push(toolName);
          }
        } else if (!directTools.includes(toolName)) {
          directTools.push(toolName);
        }
      }
    }

    const categoryCount = categories.length;
    const toolCount = categories.reduce((sum, c) => sum + c.tools.length, 0) + directTools.length;
    const lines: string[] = [`${categoryCount} categories, ${toolCount} tools`];

    const visibleCategories = categories.slice(0, 5);
    const hasMoreCategories = categories.length > visibleCategories.length;

    visibleCategories.forEach((cat, idx) => {
      const isLastVisible = idx === visibleCategories.length - 1 && !hasMoreCategories && directTools.length === 0;
      const branch = isLastVisible ? '└─' : '├─';
      const toolPreview = cat.tools.slice(0, 4).join(', ');
      const extraTools = cat.tools.length > 4 ? ` +${cat.tools.length - 4}` : '';
      lines.push(`${branch} ${cat.label} [${cat.id}] · ${cat.tools.length}${toolPreview ? ` · ${toolPreview}${extraTools}` : ''}`);
    });

    if (hasMoreCategories) {
      const branch = directTools.length > 0 ? '├─' : '└─';
      lines.push(`${branch} … +${categories.length - visibleCategories.length} more categories`);
    }

    if (directTools.length > 0) {
      const preview = directTools.slice(0, 6).join(', ');
      const suffix = directTools.length > 6 ? ` +${directTools.length - 6}` : '';
      lines.push(`└─ tools · ${preview}${suffix}`);
    }

    return lines.join('\n');
  }

  private isGitResultTool(toolName: string): boolean {
    const normalized = toolName.toLowerCase();
    return normalized === 'git_status'
      || normalized === 'git_diff'
      || normalized === 'git_log'
      || normalized === 'git_commit'
      || normalized === 'git_blame'
      || normalized === 'git_branch'
      || normalized === 'git_branch_list';
  }

  private formatGitToolDetails(summaryText: string, outputText: string): string {
    const raw = (outputText || summaryText || '').replace(/\r\n?/g, '\n').trim();
    if (!raw) {
      return '';
    }
    const maxLines = 20;
    const lines = raw.split('\n').map(line => line.length > 180 ? `${line.slice(0, 179)}…` : line);
    const visible = lines.slice(0, maxLines);
    if (lines.length > maxLines) {
      visible.push(`... (${lines.length - maxLines} more lines)`);
    }
    return visible.join('\n');
  }

  private mergeToolDetails(baseDetails: string, outputText: string): string {
    const parts: string[] = [];
    if (baseDetails) {
      parts.push(baseDetails);
    }
    if (outputText) {
      if (parts.length > 0) {
        parts.push('---');
      }
      parts.push(outputText);
    }
    return parts.join('\n');
  }

  private truncateText(text: string, maxLen: number): string {
    if (text.length <= maxLen) {
      return text;
    }
    return `${text.slice(0, maxLen)}\n... (truncated)`;
  }

  private formatDuration(durationMs: number): string {
    if (durationMs < 1000) {
      return `${durationMs}ms`;
    }
    const seconds = durationMs / 1000;
    if (seconds < 60) {
      return `${seconds.toFixed(2)}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const rem = seconds - minutes * 60;
    return `${minutes}m ${rem.toFixed(1)}s`;
  }

  stopHealthMonitoring(): void {
    cliLogger.debug('INK_ADAPTER', 'Stop health monitoring');
    // Not needed for Ink
  }

  /**
   * Force flush the render scheduler (compatibility method for legacy UI)
   * Ink uses React's rendering system, so this is a no-op
   */
  flushRenderScheduler(): void {
    cliLogger.debug('INK_ADAPTER', 'Flush render scheduler (no-op for Ink)');
    // Ink uses React's rendering system - no manual flush needed
  }

  /**
   * Helper: Get text from last message
   */
  private getLastMessageText(): string {
    if (!this.lastEntryId) return '';

    const entry = this.runtime.getEntry(this.lastEntryId);
    if (!entry || !entry.message) return '';

    const message = entry.message;
    if (typeof message.content === 'string') {
      return message.content;
    } else if (Array.isArray(message.content)) {
      const textContent = message.content.find(c => c.type === 'text');
      if (textContent && 'text' in textContent) {
        return textContent.text || '';
      }
    }
    return '';
  }

  private simplifyRipgrepCommand(command: string): string {
    // Split command into parts
    const parts = command.split(/\s+/);
    const simplified: string[] = [];
    let skipNext = false;
    let gCount = 0;

    for (let i = 0; i < parts.length; i++) {
      if (skipNext) {
        skipNext = false;
        continue;
      }

      const part = parts[i];

      // This prevents leaking username and installation paths
      if (part.includes('/rg') || part.includes('\\rg')) {
        simplified.push('rg');
        continue;
      }

      // Skip the last argument (search path) if it's an absolute path
      if (i === parts.length - 1 && part.startsWith('/')) {
        // Replace absolute path with "." or relative path
        const cwd = process.cwd();
        if (part === cwd) {
          simplified.push('.');
        } else if (part.startsWith(cwd + '/')) {
          // Show relative path
          const relative = part.substring(cwd.length + 1);
          simplified.push(relative || '.');
        } else {
          // Completely different path - show basename only
          const basename = part.split('/').pop() || '.';
          simplified.push(basename);
        }
        continue;
      }

      // Count and consolidate -g arguments
      if (part === '-g') {
        gCount++;
        // Only show first 2 -g arguments
        if (gCount <= 2) {
          simplified.push(part);
          if (i + 1 < parts.length) {
            simplified.push(parts[i + 1]);
            skipNext = true;
          }
        } else if (gCount === 3) {
          // After 2, show "... (N more -g)"
          const remaining = parts.slice(i).filter(p => p === '-g').length;
          simplified.push(`... (+${remaining} more -g)`);
          // Skip all remaining -g arguments
          while (i < parts.length && (parts[i] === '-g' || (i > 0 && parts[i - 1] === '-g'))) {
            if (parts[i] === '-g' && i + 1 < parts.length) {
              i++; // Skip -g and its argument
            }
            i++;
          }
          i--; // Back up one since loop will increment
        }
        continue;
      }

      // Keep all other arguments (flags and options)
      simplified.push(part);
    }

    return simplified.join(' ');
  }
}
