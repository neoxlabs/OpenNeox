/**
 * Streamed runner for real-time agent execution
 * 流式运行器 - 用于实时 Agent 执行
 */

import type { LLMProvider } from '../types/index.js';
import { type PauseGate, waitForResumeOrAbort } from './pauseGate.js';
import { isSameUserMessage } from './runnerUserMessageDedup.js';
import { withRetryDiscard } from './streamRetryDiscard.js';
import { normalizeFinishReason, rejectMissingRequiredArgs, rejectTruncatedToolCall } from './toolArgsGuard.js';
import { createHash } from 'crypto';
import { appendToolTrace, clipForToolTrace } from '../runtime/agent/toolTraceLog.js';
import type { ShortTermMemory } from '../memory/shortterm.js';
import type {
  Tool,
  ToolCall,
  AgentConfig,
  StreamEvent,
  Message,
  MessageContent,
  MessageContentPart,
  RawResponseStreamEvent,
  AgentUpdatedStreamEvent,
  TokenUsageStreamEvent,
  Instructions,
  RunContext,
  InputGuardrail,
  OutputGuardrail,
  StructuredOutputDefinition,
} from '../types/index.js';
import { DEFAULT_MAX_ITERATIONS, DEFAULT_MAX_TOOL_CALLS, DEFAULT_MAX_RUNTIME_MS } from '../types/index.js';
import type { ToolInputGuardrail, ToolOutputGuardrail } from '../types/guardrails.js';
import { GuardrailsExecutor } from './guardrails.js';
import { trackWorkState, trackToolFailure, trackFileAccess, trackSkillInvocation, peekWorkState } from './postCompactReinject.js';
import { agentMessageBus } from './agentMessageBus.js';
import { logger } from '../utils/logger.js';
import {
  beginRun,
  endRun,
  runWithRunTrace,
  type RunTrace,
} from '../utils/runTrace.js';
import { tryFixToolArgsJson, closeFencedBlocks } from './runnerOutputSelfHeal.js';
import { parseDsmlToolCalls } from '../utils/dsmlToolCalls.js';

export enum RunPhase {
  Init = 'init',
  LlmStream = 'llm',
  ToolExec = 'tool',
  AutoCompact = 'autocompact',
  Recover = 'recover',
  Finished = 'finished',
}
import { stripStaleImages } from '../utils/imageHistoryGuard.js';
import { prepareMessagesForWire } from '../utils/wireText.js';
import { enforceToolPairs } from './toolPairGuard.js';
import { ToolCallSlotTracker } from './streamToolCallSlots.js';
import { MAX_IMAGE_BASE64_BYTES, oversizedImagePlaceholder } from '../utils/imageToolResult.js';
import { StructuredOutputValidator } from './structuredOutput.js';
import {
  ErrorCategory,
} from '../types/errors.js';
import { DEFAULT_RETRY_CONFIG } from '../types/retryConfig.js';
import { getKernelConfig } from './kernelConfigBridge.js';
import { interruptibleSleep, formatDelay } from '../utils/backoff.js';
import type { StreamRetryStreamEvent, StreamRecoveredStreamEvent } from '../types/index.js';
import { UnifiedCompressor, type BatchCompressionResult } from '../utils/compression/index.js';
import { isCompactionSummaryMessage } from '../utils/compression/llmSummarizer.js';
// readfile 动态策略提示
import { estimateTokensFromMessages } from '../compat/memoryPressure.js';
import { estimateTokens } from '../utils/tokenEstimate.js';
import { buildContextBreakdown } from '../utils/contextBreakdown.js';
import type { ToolCall as ParallelToolCall, ToolResult } from './parallelExecutor.js';
import { getSummaryModel } from './toolSummaryGenerator.js';
import { buildEditFailureHint } from './promptHints.js';
import { ErrorPatternMemory } from './reasoning/errorPatternMemory.js';
import { ToolCallDeduplicator } from './reasoning/toolCallDeduplicator.js';
import { FileHotspotDetector, isMutationTool } from './reasoning/fileHotspotDetector.js';
import { ReasoningLoopDetector } from './reasoning/reasoningLoopDetector.js';
import {
  StreamPartialTracker,
  shouldUsePrefillContinuation,
  providerSupportsPrefill,
  type InterruptReason,
} from './streamPartialTracker.js';
import { ToolUsageAdvisor } from './reasoning/toolUsageAdvisor.js';
import { AutoVerifyPipeline } from './reasoning/autoVerifyPipeline.js';
import { detectProjectContext, formatProjectContextPrompt } from './reasoning/projectContextDetector.js';
import { cliLogger } from '../platform/cliLogger.js';
import type { ResolvedModelProfile } from '../profiles/index.js';
import { LoopDetector, createLoopDetector } from './loopDetector.js';
import { isReadTool } from './toolClassification.js';
import { RepairTracker } from './toolCallRepair.js';
import { ExecutionPolicyOrchestrator } from './executionPolicyOrchestrator.js';
import {
  computeMaxInputTokens,
  normalizeLimit,
  sanitizeToolArguments,
  withStreamWatchdog as applyStreamWatchdog,
} from './runnerUtils.js';
import {
  maybeApplyPlannerAutoFollowup,
} from './runnerPlanUtils.js';
import {
  inferTaskRequirements,
} from './runnerTaskUtils.js';
import { isLeakedToolEnvelopeText } from './runnerEnvelopeUtils.js';
import {
  createRunContext,
  resolveContextInjection,
  resolveInstructions,
  shouldIncludeLastRun,
} from './runnerContextUtils.js';
import {
  applyToolsetFilter,
  getCompletionProfile,
} from './runnerProfileUtils.js';
import { compressContextWindow, findEvictedReadPaths } from './runnerCompressionUtils.js';
import { resolveAutoCompactTriggerTokens, calibrateEstimatedTokens, resolveTokenScale, resolveCompactionPlan } from './autoCompactGuard.js';
import { normalizeUsageTokens } from '../utils/usageNormalize.js';
import { NEOX_HOME_DIRNAME } from '../platform/neoxHome.js';
import {
  buildFriendlyRunnerError,
  buildStreamErrorDiagnostic,
  classifyRunnerError,
  handleInterruptedPartialContent,
  logClassifiedErrorToConsole,
  reclassifyFalseCancel,
} from './runnerErrorUtils.js';
import {
  logRunCompletion,
  logRunEntry,
} from './runnerLoggingUtils.js';
import {
  buildParallelExecutionStatsEvent,
  buildPlanUpdateEvent,
  buildLoopWasteSummaryEvent,
  buildTargetContinuationEvent,
  buildToolOutputEvents,
} from './runnerEventBuilders.js';
import { injectIterationAdvisories } from './runnerAdvisoryUtils.js';
import {
  createIterationStats,
} from './runnerIterationStatsUtils.js';
import { RecoveryTracker, ProgressTracker, RunAccumulator } from './runTrackers.js';
import { extractPlanUpdatePayload } from './runnerPlanUpdateUtils.js';
import { prepareToolResultForMemory } from './runnerToolResultPreparationUtils.js';
import { handleNoToolGuardAndRepair, type NoToolContinuationReason } from './runnerNoToolContinuationUtils.js';
import { handleEmptyFinalOutputRecovery } from './runnerEmptyFinalOutputUtils.js';
import { recordToolMetric } from './runnerToolMetricsUtils.js';
import { buildParallelToolCalls } from './runnerParallelToolCallUtils.js';
import {
  runOrchestratedBatch,
  runGateStage,
  type ToolUseContext,
} from './toolOrchestration/index.js';
import {
  createPermissionAdapter,
  createGuardrailsAdapter,
  createLoopAdapter,
  createErrorPatternSuccessHook,
  createErrorPatternFailureHook,
} from './toolOrchestration/adapters/index.js';
import { DEFAULT_TOOL_INPUT_GUARDRAILS } from './defaultGuardrails.js';
import { evaluateToolRisk } from './toolRiskEvaluator.js';
import { repairToolName } from './toolCallRepair.js';
import { runWithWorkspaceRoot } from '../tools/workspaceContext.js';
import { runWithSessionScope } from './sessionScope.js';
import { resolveApprovalPosture } from './runnerApprovalModeUtils.js';
import { createSkillScopeBox, runWithSkillScopeBox, resetSkillScopeBox, getSkillScope, type SkillScopeBox } from '../skills/skillScope.js';
import { logToolExecutionResult } from './runnerToolExecutionCallbackUtils.js';
import { applyModeFilterWithEvents } from './runnerModeFilterFlowUtils.js';
import { finalizeToolResultAndTracking } from './runnerToolResultFinalizeUtils.js';
import { applyIterationProgressGate } from './runnerProgressGateUtils.js';
import { finalizeNoToolResponse } from './runnerNoToolFinalizeUtils.js';
import {
  buildParsedArgsByToolId,
  buildToolCallLifecycleBatch,
  logParallelToolCallSummary,
} from './runnerToolCallPreludeUtils.js';
import { PermissionManager } from './permissions/index.js';
import { getModeStrategy } from './modes/index.js';
import { AgentMode, ToolPermission } from '../types/permissions.js';
import type { ModeStrategy } from './modes/ModeStrategy.js';
import { readToolSelfReportedOutcome } from './toolOutcome.js';
import { beginWrapUp, dropWrapUpToolCalls, finishWrapUpTurn } from './runnerWrapUp.js';

import {
  DEFAULT_TAIL_TOKEN_BUDGET,
  type ToolCallDeltaLike,
  isStreamRetryChunk,
  isStreamRecoveredChunk,
  isWebSearchProviderEvent,
  AUTO_COMPACT_MAX_TURN_AGE,
  COMPACT_RETRY_GROWTH_TOKENS,
  COMPACT_GATE_LOG_FRACTION,
  COMPACT_GATE_MSG_FLOOR,
  type ToolOutcomeSnapshot,
} from './runnerHeadDefs.js';

export interface ToolApprovalRequest {
  id: string;
  name: string;
  args: Record<string, any>;
}

export type ToolApprovalHandler = (request: ToolApprovalRequest) => Promise<boolean>;

/** loopContinuationGate 的判决。允许异步: 收尾判定闸要问一次外部分类模型。 */
export interface LoopContinuationDecision {
  shouldContinue: boolean;
  message?: string;
  kind?: 'target' | 'verify' | 'team_spec' | 'unfinished';
}

export { PermissionManager } from './permissions/index.js';
export { AgentMode } from '../types/permissions.js';
export type { ApprovalRequest, ApprovalResult } from './permissions/index.js';

export class StreamedRunner {
  private llmProvider: LLMProvider;
  private providerName?: string;
  private model: string;
  private tools: Tool[];
  private memory: ShortTermMemory;
  private config: AgentConfig;
  private agentName: string;
  /** sessionId — agenticRuntime/assistantRuntime 构造时传入, 用于 per-session approval mode scopeKey */
  private sessionId?: string;
  private pauseGate?: PauseGate;
  private agentDescription: string;
  private instructions: Instructions;  // 支持动态 instructions
  private contextInjection?: Instructions;  // Optional context injection summary
  private userData?: Record<string, any>;  // 用户自定义数据
  private plannerMode: boolean;

  /** 当前 run 的可观测 trace(runTrace.ts)。run() 入口 beginRun,收尾 endRun。
   *  invokeTool 用它 + runWithRunTrace 给工具/锁子树做卡死归属。 */
  private runTrace: RunTrace | null = null;

  // Guardrails 防护栏
  private inputGuardrails: InputGuardrail[] = [];    // 输入防护
  private outputGuardrails: OutputGuardrail[] = [];  // 输出防护
  private toolInputGuardrails: ToolInputGuardrail[] = [];   // 工具输入防护
  private toolOutputGuardrails: ToolOutputGuardrail[] = []; // 工具输出防护
  private structuredOutput?: StructuredOutputDefinition;
  private structuredValidator?: StructuredOutputValidator;
  private maxInputTokensOverride?: number;
  private maxInputTokens?: number;
  private minHistoryMessages: number;
  private unifiedCompressor: UnifiedCompressor;
  private compressionMode: 'sync' | 'async';
  private compressionThreshold?: number;
  private lastCompactionNoopTokens = 0;
  private lastLightCompactTokens = 0;
  private sessionMinFixedOverhead = 0;

  private measuredPromptTokens = 0;
  private estimateAtMeasurement = 0;
  private autoCompressEnabled: boolean;
  public onHistoryCompacted?: (info?: { evictedReadPaths?: string[] }) => void | Promise<void>;
  /** 原始 contextWindow (未扣 tail budget), 供 autoCompactGuard 熔断/递归保护用 */
  private contextWindowSize?: number;
  private toolMetricsHistory: Array<{ name: string; duration: number; success: boolean }> = [];
  private workspacePath?: string;
  private workspaceRoots?: string[];
  /** K2: 当前 active skill 的 scope (有时空有时有, useSkillTool 调用时由它写,
   *  invokeTool / permission check 包在 runWithSkillScopeBox(this.skillScopeBox, ...) 里读).
   *  Runner 整个生命周期共享一个 box, run() 入口处 reset, 跨 turn 持续. */
  private skillScopeBox: SkillScopeBox = createSkillScopeBox();
  private disableSystemPrompt: boolean;
  /** 初始值 — 运行时会从 config 实时读取，用户在设置页面切换后立即生效 */
  private enableFGTSInitial: boolean;
  private modelProfile?: ResolvedModelProfile;
  private providerModelNames?: string[];

  private runContext!: RunContext;

  private permissionManager: PermissionManager;
  private modeStrategy: ModeStrategy;
  private currentMode: AgentMode;
  private loopDetector: LoopDetector;
  private executionPolicyOrchestrator: ExecutionPolicyOrchestrator;
  private errorPatternMemory: ErrorPatternMemory;
  private toolCallDedup: ToolCallDeduplicator;
  private fileHotspot: FileHotspotDetector;
  private reasoningLoopDetector: ReasoningLoopDetector;
  private streamPartialTracker: StreamPartialTracker;
  private activeStreamAbort: AbortController | null = null;
  private activeToolSteeringAbort: AbortController | null = null;
  private detachOuterAbortListener: (() => void) | null = null;
  private steeringInterruptRequested = false;
  private steeringGeneration = 0;
  private toolUsageAdvisor: ToolUsageAdvisor;
  private autoVerifyPipeline: AutoVerifyPipeline;
  private enablePlanMode: boolean;
  private smartReadHintProvider?: (workspacePath: string) => Promise<string>;
  //   在主循环准备"无 tool_use 退出"时被询问一次: 是否要阻止退出并继续下一轮?
  //   返回 shouldContinue=true 时, 可以附一条 message 由 runner 注入 system role 给下一轮 LLM 看到.
  //   core 层通过它挂 target-mission 的 check_target_done 闸门(未完成不允许 no-tool 退出).
  //   kernel 保持 target-agnostic; 语义完全由 core 决定.
  private loopContinuationGate?: (ctx: {
    reason: 'no_tool_exit';
    iteration: number;
    /** 连续被本 gate 阻止过的次数, 用于 core 层做兜底判断避免死循环. */
    consecutiveBlocks: number;
    runMutationCount: number;
    /** 本 run 内是否成功跑过验证类工具 (run_tests / run_lint)。 */
    ranVerifyTool: boolean;
    /** 本 run 的用户任务 */
    task: string;
    finalText: string;
    /** 本 run 内工具调用总数 */
    totalToolCalls: number;
  }) => LoopContinuationDecision | Promise<LoopContinuationDecision>;
  private consecutiveContinuationBlocks = 0;
  /** 本 run 内成功的 mutation 工具次数 — run() 入口清零, 见 loopContinuationGate. */
  private runMutationCount = 0;
  /** 本 run 内是否成功跑过 run_tests / run_lint. */
  private ranVerifyTool = false;
  private idleNoToolStreak = 0;

  private lastRunAccumulator?: RunAccumulator;
  private lastRunStartedAt?: number;

  //   每次 iteration >=2 (即除了首轮之外的每一轮) 开始 assemble prompt 前调用,
  //   返回 message 会以 user role 注入 memory, LLM 下一轮请求时看到.
  //   core 层用这个挂 target-mission 的 continuation prompt: 每 turn pin 一次 objective +
  //   已完成 sub-mission + 待办, 强制 model 反复对齐目标, 防止 8 step 就 done=true.
  private perTurnInjector?: (ctx: { iteration: number }) => { message?: string } | undefined;

  //   首轮拼装 system prompt 时被调, 返回 string 追加到 systemParts.
  //   后续轮次(hasSystemPrompt 分支)时, 用 memory.upsertSystemTagged('dynamic_section', ...) 更新.
  //   core 层通过它挂 target-mission active 时的约束段落.
  private dynamicSystemPromptProvider?: () => string | undefined;
  /** kernel 切口: 模型点名一个当前不在工具集里的工具时, 宿主可以**当场解锁**它。
   *  返回 true = 已解锁 (this.tools 原地更新), runner 会重新算白名单并照常执行。 */
  private resolveDeferredTool?: (name: string) => boolean;

  private skillActivation?: {
    readonly conditionalCount: number;
    activateForPaths(paths: string[], workspacePath: string): string[] | void;
    getAutoInjectBody?(skillName: string): string | undefined;
  };
  private userToolHooks?: {
    pre?: { name: string; run(toolName: string, args: Record<string, unknown>): Promise<{ allow: boolean; reason?: string }> };
    postSuccess?: { name: string; run(toolName: string, args: Record<string, unknown>, output: string): Promise<void> };
  };

  /** 实时读取 FGTS 开关 — 设置页面切换后下一次 LLM 调用即生效 */
  private getEnableFGTS(): boolean {
    try {
      const live = getKernelConfig().experimental?.enableFGTS;
      if (typeof live === 'boolean') return live;
    } catch { /* config 读取失败时降级到初始值 */ }
    return this.enableFGTSInitial;
  }

  constructor(options: {
    llmProvider: LLMProvider;
    model: string;
    tools: Tool[];
    memory: ShortTermMemory;
    config: AgentConfig;
    agentName?: string;
    /** sessionId — per-session approval mode scopeKey, 推荐 agenticRuntime 传入 */
    sessionId?: string;
    agentDescription?: string;
    instructions: Instructions;  // 支持字符串或函数
    contextInjection?: Instructions;  // Optional context injection (summary)
    userData?: Record<string, any>;  // 可选的用户数据
    inputGuardrails?: InputGuardrail[];   // 可选的输入防护栏
    outputGuardrails?: OutputGuardrail[]; // 可选的输出防护栏
    toolInputGuardrails?: ToolInputGuardrail[];   // 可选的工具输入防护栏
    toolOutputGuardrails?: ToolOutputGuardrail[]; // 可选的工具输出防护栏
    approvalHandler?: ToolApprovalHandler;
    /** 暂停闸 (语义和安全点的说明见 pauseGate.ts)。不传 = 没有暂停能力。 */
    pauseGate?: PauseGate;
    plannerMode?: boolean;
    structuredOutput?: StructuredOutputDefinition;
    providerName?: string;
    contextWindow?: number;
    tailTokenBudget?: number;
    minHistoryMessages?: number;
    maxInputTokensOverride?: number;
    compressionMode?: 'sync' | 'async';  // 压缩模式：sync=同步裁剪, async=异步LLM压缩
    compressionThreshold?: number;  // 用户设置的触发阈值 (0-1, 如 0.7 = 70%)
    autoCompressEnabled?: boolean;  // 用户是否开启自动压缩
    workspacePath?: string;  // 工作区主路径（用于索引等功能）
    workspaceRoots?: string[];  // 多根工作区所有项目路径
    permissionManager?: PermissionManager;
    enablePlanMode?: boolean;
    disableSystemPrompt?: boolean;
    enableFGTS?: boolean;
    modelProfile?: ResolvedModelProfile;
    providerModelNames?: string[];
    smartReadHintProvider?: (workspacePath: string) => Promise<string>;
    loopContinuationGate?: (ctx: {
      reason: 'no_tool_exit';
      iteration: number;
      consecutiveBlocks: number;
      runMutationCount: number;
      /** 本 run 内是否成功跑过 run_tests / run_lint */
      ranVerifyTool: boolean;
      /** 本 run 的用户任务 (收尾判定闸看用户是不是只要计划 / 让它先停) */
      task: string;
      finalText: string;
      /** 本 run 内工具调用总数 —— 0 = 纯问答, 收尾判定闸不管 */
      totalToolCalls: number;
      /** 哪个闸拦的 — 只影响 UI 文案, 缺省 'target' (见 buildTargetContinuationEvent) */
    }) => LoopContinuationDecision | Promise<LoopContinuationDecision>;
    dynamicSystemPromptProvider?: () => string | undefined;
    /** 见字段注释 —— 宿主 (core) 接 ToolTreeEngine.promote。 */
    resolveDeferredTool?: (name: string) => boolean;
    perTurnInjector?: (ctx: { iteration: number }) => { message?: string } | undefined;
    skillActivation?: {
    readonly conditionalCount: number;
    activateForPaths(paths: string[], workspacePath: string): string[] | void;
    getAutoInjectBody?(skillName: string): string | undefined;
  };
    userToolHooks?: {
      pre?: { name: string; run(toolName: string, args: Record<string, unknown>): Promise<{ allow: boolean; reason?: string }> };
      postSuccess?: { name: string; run(toolName: string, args: Record<string, unknown>, output: string): Promise<void> };
    };
    onHistoryCompacted?: (info?: { evictedReadPaths?: string[] }) => void | Promise<void>;
  }) {
    this.llmProvider = options.llmProvider;
    this.providerName = options.providerName;
    this.model = options.model;
    this.tools = options.tools;
    this.memory = options.memory;
    this.config = options.config;
    this.agentName = options.agentName || 'DefaultAgent';
    this.sessionId = options.sessionId;
    this.pauseGate = options.pauseGate;
    this.agentDescription = options.agentDescription || '';
    this.instructions = options.instructions;
    this.contextInjection = options.contextInjection;
    this.userData = options.userData;
    this.plannerMode = options.plannerMode ?? false;
    this.structuredOutput = options.structuredOutput;
    this.maxInputTokensOverride = options.maxInputTokensOverride;
    this.maxInputTokens = computeMaxInputTokens(
      options.contextWindow,
      options.tailTokenBudget,
      this.maxInputTokensOverride,
      DEFAULT_TAIL_TOKEN_BUDGET,
    );
    this.minHistoryMessages = Math.max(1, options.minHistoryMessages ?? 6);

    if (options.structuredOutput) {
      this.structuredValidator = new StructuredOutputValidator(options.structuredOutput);
    }

    // 设置 Guardrails
    this.inputGuardrails = options.inputGuardrails || [];
    this.outputGuardrails = options.outputGuardrails || [];
    this.toolInputGuardrails = options.toolInputGuardrails || [];
    this.toolOutputGuardrails = options.toolOutputGuardrails || [];

    this.compressionMode = options.compressionMode ?? 'sync';
    this.compressionThreshold = options.compressionThreshold;
    this.autoCompressEnabled = options.autoCompressEnabled ?? true;
    this.onHistoryCompacted = options.onHistoryCompacted;
    this.contextWindowSize = options.contextWindow;
    this.workspacePath = options.workspacePath;
    this.workspaceRoots = options.workspaceRoots;
    this.perTurnInjector = options.perTurnInjector;
    this.unifiedCompressor = new UnifiedCompressor({
      debug: process.env.CLI_DEBUG === '1',
      minRecentMessages: this.minHistoryMessages,
      enableLLMCompression: true,
    });
    this.disableSystemPrompt = options.disableSystemPrompt ?? false;
    this.enableFGTSInitial = options.enableFGTS ?? true;
    this.modelProfile = options.modelProfile;
    this.providerModelNames = options.providerModelNames;
    this.smartReadHintProvider = options.smartReadHintProvider;
    this.loopContinuationGate = options.loopContinuationGate;
    this.dynamicSystemPromptProvider = options.dynamicSystemPromptProvider;
    this.resolveDeferredTool = options.resolveDeferredTool;
    this.skillActivation = options.skillActivation;
    this.userToolHooks = options.userToolHooks;

    // 设置 LLM Provider 用于智能压缩
    this.unifiedCompressor.setLLMProvider(this.llmProvider, this.model);
    if (options.contextWindow) {
      this.unifiedCompressor.setContextWindow(options.contextWindow);
    }

    this.currentMode = options.config.mode ?? AgentMode.AGENT;
    this.modeStrategy = getModeStrategy(this.currentMode);
    this.permissionManager = options.permissionManager ?? new PermissionManager({
      defaultPermission: ToolPermission.ASK,
    });
    this.loopDetector = createLoopDetector();
    this.executionPolicyOrchestrator = new ExecutionPolicyOrchestrator({
      tools: this.tools,
      permissionManager: this.permissionManager,
      memory: this.memory,
      runContext: createRunContext('', this.userData, 0, this.sessionId),
      agentName: this.agentName,
      toolInputGuardrails: this.toolInputGuardrails,
      toolOutputGuardrails: this.toolOutputGuardrails,
    });
    this.errorPatternMemory = new ErrorPatternMemory();
    this.toolCallDedup = new ToolCallDeduplicator();
    this.fileHotspot = new FileHotspotDetector();
    this.reasoningLoopDetector = new ReasoningLoopDetector();
    this.streamPartialTracker = new StreamPartialTracker();
    this.toolUsageAdvisor = new ToolUsageAdvisor();
    this.autoVerifyPipeline = new AutoVerifyPipeline(options.workspacePath || process.cwd());

    this.enablePlanMode = options.enablePlanMode ?? true;  // 默认启用，让 LLM 自己判断

    if (options.approvalHandler) {
      const oldHandler = options.approvalHandler;
      this.permissionManager.setApprovalHandler(async (request) => {
        const approved = await oldHandler({
          id: '',
          name: request.toolName,
          args: request.args,
        });
        return { approved, remember: false };
      });
    }
  }

  /**
   * 设置工具审批处理器
   * 当工具需要用户确认时调用此处理器
   * @deprecated 使用 permissionManager.setApprovalHandler 替代
   */
  setApprovalHandler(handler?: ToolApprovalHandler): void {
    if (!handler) {
      this.permissionManager.setApprovalHandler(undefined);
      return;
    }

    this.permissionManager.setApprovalHandler(async (request) => {
      const approved = await handler({
        id: '',
        name: request.toolName,
        args: request.args,
      });
      return { approved, remember: false };
    });
  }

  setMode(mode: AgentMode): void {
    this.currentMode = mode;
    this.modeStrategy = getModeStrategy(mode);
    cliLogger.info('Runner', `Mode switched to: ${mode}`);
  }

  getMode(): AgentMode {
    return this.currentMode;
  }

  getPermissionManager(): PermissionManager {
    return this.permissionManager;
  }

  /**
   * 设置压缩模式
   */
  setCompressionMode(mode: 'sync' | 'async'): void {
    this.compressionMode = mode;
    cliLogger.info('Context', `Compression mode set to: ${mode}`);
  }

  setCompressionThreshold(ratio?: number): void {
    this.compressionThreshold = (ratio && ratio > 0 && ratio <= 1) ? ratio : undefined;
    cliLogger.info('Context', `Compression threshold set to: ${this.compressionThreshold ?? 'default'}`);
  }

  /** 设置是否启用自动压缩 (设置页的「自动压缩」开关)。 */
  setAutoCompressEnabled(enabled: boolean): void {
    this.autoCompressEnabled = enabled;
    cliLogger.info('Context', `Auto compress ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * 获取当前压缩模式
   */
  getCompressionMode(): 'sync' | 'async' {
    return this.compressionMode;
  }

  updateInstructions(instructions: Instructions): void {
    this.instructions = instructions;
  }

  /**
   * 更新 workspacePath — Host 端切换 workspace (setWorkspace/setWorkDir) 时同步给 kernel,
   * 保证 runWithWorkspaceRoot(this.workspacePath, ...) 在下一次 tool 调用时用新目录.
   * 不改 activate 状态 / 不清 memory — 单纯换 cwd 语义.
   */
  setWorkspacePath(workspacePath: string): void {
    this.workspacePath = workspacePath;
  }

  /** 获取当前 workspacePath (供 host 侧调试/审计). */
  getWorkspacePath(): string | undefined {
    return this.workspacePath;
  }

  /**
   * 设置用户数据
   * Set user data for dynamic instructions
   */
  setUserData(data: Record<string, any>): void {
    this.userData = { ...this.userData, ...data };
  }

  requestSteeringInterrupt(): boolean {
    this.steeringGeneration++;
    const stream = this.activeStreamAbort;
    if (stream && !stream.signal.aborted) {
      this.steeringInterruptRequested = true;
      stream.abort();
      return true;
    }
    const tool = this.activeToolSteeringAbort;
    if (tool && !tool.signal.aborted) {
      this.steeringInterruptRequested = true;
      const grace = setTimeout(() => {
        try { tool.abort(); } catch { /* ignore */ }
      }, 5000);
      grace.unref?.();
      return true;
    }
    return false;
  }

  private clearActiveStreamAbort(): void {
    this.detachOuterAbortListener?.();
    this.detachOuterAbortListener = null;
    this.activeStreamAbort = null;
  }

  /** 拿到供应商实报的输入 token 时, 连同当时的估算值一起记下, 形成一组校准配对。
   *  (见 measuredPromptTokens 字段上方的长注释) */
  private recordMeasuredPromptTokens(promptTokens?: number): void {
    if (!promptTokens || promptTokens <= 0) return;
    const estimateNow = estimateTokensFromMessages(this.memory.getMessagesForLLM());
    if (estimateNow <= 0) return;
    this.measuredPromptTokens = promptTokens;
    this.estimateAtMeasurement = estimateNow;
    /* 固定前缀采样: 取会话内最小差值 (见字段注释) */
    const overhead = promptTokens - estimateNow;
    if (overhead > 0) {
      this.sessionMinFixedOverhead = this.sessionMinFixedOverhead > 0
        ? Math.min(this.sessionMinFixedOverhead, overhead)
        : overhead;
    }
  }

  private calibrateContextTokens(rawEstimate: number): number {
    return calibrateEstimatedTokens(rawEstimate, this.measuredPromptTokens, this.estimateAtMeasurement);
  }

  private async notifyHistoryCompacted(info?: { evictedReadPaths?: string[] }): Promise<void> {
    if (!this.onHistoryCompacted) return;
    try {
      await this.onHistoryCompacted(info);
    } catch (err: any) {
      cliLogger.warn('RUNNER', `onHistoryCompacted sync failed: ${err?.message ?? err}`);
    }
  }

  /**
   * Agent 主执行入口 - 流式处理用户任务
   *
   * 执行流程: 任务分类 → 输入防护 → LLM调用 → 工具执行 → 输出防护
   *
   * @param task - 用户输入的任务文本
   * @param images - 可选的图片附件（base64 data URL）
   * @param signal - 可选的取消信号（用于 Ctrl+C 中断）
   */
  public async compactNow(
    trigger: 'auto' | 'recovery' = 'auto',
    onProgress?: (p: import('../utils/compression/llmSummarizer.js').CompressionProgress) => void,
  ): Promise<BatchCompressionResult | null> {
    const budget = this.maxInputTokens
      || (this.contextWindowSize ? Math.floor(this.contextWindowSize * 0.6) : 0);
    if (!budget) {
      cliLogger.warn('RUNNER', '[compactNow] no token budget available (maxInputTokens/contextWindow both unset) — skip');
      return null;
    }
    const beforeMessages = this.memory.getMessagesForLLM();
    const result = await compressContextWindow({
      maxInputTokens: budget,
      contextWindow: this.contextWindowSize,
      iteration: 0,
      memory: this.memory,
      unifiedCompressor: this.unifiedCompressor,
      compressionMode: 'sync',
      model: this.model,
      sessionId: this.sessionId,
      trigger,
      overrideRatio: this.compressionThreshold,
      maxTurnAge: AUTO_COMPACT_MAX_TURN_AGE,
      logInfo: (message) => cliLogger.info('Context', message),
      logDebug: (message) => cliLogger.debug('Context', message),
      onCompressionProgress: onProgress,
      tokenCalibration: { measured: this.measuredPromptTokens, estimateAtMeasurement: this.estimateAtMeasurement },
    });
    if (result) {
      const evictedReadPaths = findEvictedReadPaths(beforeMessages, this.memory.getMessagesForLLM());
      try { await this.onHistoryCompacted?.({ evictedReadPaths }); }
      catch (err: any) { cliLogger.warn('RUNNER', `[compactNow] onHistoryCompacted failed: ${err?.message}`); }
    }
    return result;
  }

  async *run(
    task: string,
    images?: string[],
    signal?: AbortSignal,
    runOpts?: { effortLevel?: string; resumeAfterStall?: boolean; continuation?: boolean },
  ): AsyncGenerator<StreamEvent> {
    /* 两个标记同义 —— 下面一律读这个 */
    const isSameTurnResume = runOpts?.resumeAfterStall === true || runOpts?.continuation === true;
    const resuming = isSameTurnResume && !!this.runContext;
    if (!resuming) {
      this.runContext = createRunContext(task, this.userData, 0, this.sessionId);
      this.executionPolicyOrchestrator.setRunContext(this.runContext);
      this.loopDetector.reset();
      /* K2: 新一轮用户输入 → 清掉旧 skill scope. 防止 turn A 装的 skill 沾染 turn B. */
      resetSkillScopeBox(this.skillScopeBox);
      /* 收尾验证闸的判据按 run 计, 新 run 清零 (见 loopContinuationGate 的 ctx 注释) */
      this.runMutationCount = 0;
      this.ranVerifyTool = false;
      this.idleNoToolStreak = 0;
    } else {
      cliLogger.info('RUNNER',
        '[RESUME] stall 续跑 —— 保留 skill scope / loopDetector / 验证闸 / runContext, 不当新一轮');
    }

    logRunEntry(task, images, signal);

    /** 记录 agent 启动日志（用于性能分析） **/
    logger.agentStart(task);
    const registeredToolNames = this.tools.map(t => t.name);

    /** 显示当前的agent的name 名称 **/
    yield {
      type: 'agent_updated_stream_event',
      new_agent: {
        name: this.agentName,
      },
    } as AgentUpdatedStreamEvent;

    /** 创建运行时上下文：封装任务、迭代次数、用户数据等
     * 上下文会传递给工具和防护栏使用 **/
    const context = createRunContext(task, this.userData, 0, this.sessionId);
    const hasConversation = this.memory.hasConversationMessages?.()
      ?? this.memory.getMessagesForLLM().some(msg => msg.role === 'user' || msg.role === 'assistant');
    const includeLastRun = !hasConversation || shouldIncludeLastRun(task);
    context.userData = {
      ...(context.userData ?? {}),
      hasConversation,
      includeLastRun,
    };

    /** ======================================================================== **/
    /** 输入防护栏检查：在 LLM 调用前拦截恶意/不合规输入
     * 所有防护栏并行执行，任一触发则抛出异常阻止执行**/
    /** ======================================================================== **/
    if (this.inputGuardrails.length > 0) {
      /** 通知 UI 层：输入检查开始 **/
      yield {
        type: 'raw_response_event',
        data: {
          type: 'input_guardrails.check_start',
          count: this.inputGuardrails.length,
        },
        event_type: 'input_guardrails.check_start',
      } as RawResponseStreamEvent;

      /** 真正的执行方法！ 输入的过滤器执行！
       * 执行所有输入防护栏（并行），失败则抛出 TripwireTriggered 异常 **/
      await GuardrailsExecutor.runInputGuardrails(
        this.inputGuardrails,
        context,
        this.agentName,
        task
      );

      /** 通知 UI 层：输入检查通过 **/
      yield {
        type: 'raw_response_event',
        data: {
          type: 'input_guardrails.check_passed',
        },
        event_type: 'input_guardrails.check_passed',
      } as RawResponseStreamEvent;
    }

    /**  动态的优化约束规则 claude模型支持 有些模型可能不支持
     * 动态生成 instructions：可基于 context 生成个性化提示词 **/
    const dynamicInstructions = await resolveInstructions(
      this.instructions,
      context,
      { name: this.agentName, description: this.agentDescription },
    );
    const contextInjection = await resolveContextInjection(
      this.contextInjection,
      context,
      { name: this.agentName, description: this.agentDescription },
    );
    let modePrompt = '';
    let structuredOutputPrompt = '';
    let smartReadHint = '';
    let projectContextPrompt = '';

    if (process.env.CLI_DEBUG === '1') {
      console.log('[RUNNER] dynamicInstructions length:', dynamicInstructions?.length || 0);
      console.log('[RUNNER] dynamicInstructions START:', dynamicInstructions?.substring(0, 200));
      console.log('[RUNNER] dynamicInstructions END:', dynamicInstructions?.substring(dynamicInstructions.length - 500));
      console.log('[RUNNER] contains 协作模式:', dynamicInstructions?.includes('协作模式'));
      console.log('[RUNNER] contains delegate_task:', dynamicInstructions?.includes('delegate_task'));
    }

    /** 检查是否已有 system prompt（恢复会话时可能已存在）
     * 通过这个来判断是否首次对话。。然后来增加约束和结构化输出 **/
    const existingMessages = this.memory.getMessagesForLLM();
    const hasSystemPrompt = existingMessages.some(
      m => m.role === 'system' && !isCompactionSummaryMessage(m),
    );

    if (process.env.CLI_DEBUG === '1') {
      console.log('[RUNNER] hasSystemPrompt:', hasSystemPrompt, 'existingMessages count:', existingMessages.length);
      console.log('[RUNNER] disableSystemPrompt:', this.disableSystemPrompt);
    }

    if (this.disableSystemPrompt) {
      // 清空 memory 中的所有 system 消息，确保只使用我们传入的 instructions
      if (hasSystemPrompt && !isSameTurnResume) {
        this.memory.clear();
      }
      if (dynamicInstructions && (!hasSystemPrompt || !isSameTurnResume)) {
        // 只添加用户传入的 instructions，不添加 modePrompt 和其他默认提示
        this.memory.add({
          role: 'system',
          content: dynamicInstructions,
        });
      }
    } else if (!hasSystemPrompt) {
      const systemParts: string[] = [];

      // 1. 模式 prompt
      modePrompt = this.modeStrategy.getSystemPrompt();
      if (modePrompt) {
        systemParts.push(modePrompt);
      }

      // 2. 动态 instructions（核心 prompt，含 persistence 指令）
      if (dynamicInstructions) {
        systemParts.push(dynamicInstructions);
      }

      // 3. 结构化输出约束（可选）
      if (this.structuredValidator) {
        structuredOutputPrompt = this.structuredValidator.buildSystemPrompt();
        systemParts.push(structuredOutputPrompt);
      }

      // 4. readfile 动态策略提示（可选）
      try {
        smartReadHint = this.smartReadHintProvider
          ? (await this.smartReadHintProvider(this.workspacePath ?? '')) || ''
          : '';
        if (smartReadHint) {
          systemParts.push(smartReadHint);
        }
      } catch (err: any) {
        cliLogger.debug('RUNNER', `Smart read hint failed: ${err?.message}`);
      }

      // 5. Context injection（可选）
      if (contextInjection) {
        systemParts.push(contextInjection);
      }

      if (this.workspacePath) {
        try {
          const projectCtx = detectProjectContext(this.workspacePath);
          if (projectCtx) {
            // 只在现有 system prompt 中没有“项目”相关内容时才注入
            // 避免与 projectMemory (.neox/project.md) 重复
            const existing = systemParts.join('');
            if (!existing.includes('项目上下文') && !existing.includes('Project Context') && !existing.includes('project.md')) {
              projectContextPrompt = formatProjectContextPrompt(projectCtx);
              systemParts.push(projectContextPrompt);
              if (process.env.CLI_DEBUG === '1') {
                cliLogger.debug('PROJECT_CTX', 'Auto-detected project context injected', projectCtx);
              }
            }
          }
        } catch (error) {
          if (process.env.CLI_DEBUG === '1') {
            cliLogger.debug('PROJECT_CTX', 'Auto-detected project context failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      // 多根工作区上下文注入 — 简短摘要 + 前 5 个项目，不浪费 token
      if (this.workspaceRoots && this.workspaceRoots.length > 1) {
        const primary = this.workspacePath || this.workspaceRoots[0];
        const primaryName = primary.split(/[/\\]/).pop() || primary;
        const MAX_INLINE = 5;
        const shown = this.workspaceRoots.slice(0, MAX_INLINE);
        const rootsList = shown.map(r => {
          const name = r.split(/[/\\]/).pop() || r;
          return r === primary ? `  - ${name} (${r}) [主项目]` : `  - ${name} (${r})`;
        }).join('\n');
        const overflow = this.workspaceRoots.length > MAX_INLINE
          ? `\n  ... 及另外 ${this.workspaceRoots.length - MAX_INLINE} 个项目（用 smart_tree 或 ls 查看完整列表）`
          : '';
        systemParts.push(
          `<workspace>\n当前工作区「${primaryName}」包含 ${this.workspaceRoots.length} 个项目:\n${rootsList}${overflow}\n主项目是你的工作目录(cwd)。其他项目用绝对路径访问。\n</workspace>`
        );
      }

      if (this.dynamicSystemPromptProvider) {
        try {
          const dynamicSection = this.dynamicSystemPromptProvider();
          if (dynamicSection) {
            systemParts.push(dynamicSection);
          }
        } catch (err: any) {
          cliLogger.debug('RUNNER', `dynamicSystemPromptProvider failed: ${err?.message}`);
        }
      }

      this.memory.add({
        role: 'system',
        content: systemParts.join('\n\n'),
      });
    }

    if (hasSystemPrompt && contextInjection) {
      if (this.memory.upsertSystemTagged) {
        this.memory.upsertSystemTagged('context_injection', contextInjection);
      }
    } else if (hasSystemPrompt) {
      this.memory.removeSystemTagged?.('context_injection');
    }

    if (hasSystemPrompt && this.dynamicSystemPromptProvider && this.memory.upsertSystemTagged) {
      try {
        const dynamicSection = this.dynamicSystemPromptProvider();
        if (dynamicSection) {
          this.memory.upsertSystemTagged('dynamic_section', dynamicSection);
        } else {
          this.memory.removeSystemTagged?.('dynamic_section');
        }
      } catch (err: any) {
        cliLogger.debug('RUNNER', `dynamicSystemPromptProvider update failed: ${err?.message}`);
      }
    }

    /** 添加用户任务到内存（支持多模态：文本 + 图片） **/
    if (runOpts?.continuation === true) {
      // Explicit recovery never creates or rewrites a user message, including images.
      if (!this.memory.getAll().some(message => message.role !== 'system')) {
        throw new Error('Cannot recover: no conversation history for this session');
      }
    } else if (images && images.length > 0) {
      /** 多模态消息：构建 content parts 数组 **/
      const contentParts: MessageContentPart[] = [
        { type: 'text', text: task },
        /* 兜底闸门: 单图 base64 超硬上限(2MB)不进历史(kernel 无 sharp 压不了),
         * 换占位文本 — 正常路径上游 (core 入口漏斗) 都该压好, 这是最后防线。 */
        ...images.map(imageUrl => (
          imageUrl.startsWith('data:image') && imageUrl.length > MAX_IMAGE_BASE64_BYTES
            ? { type: 'text' as const, text: oversizedImagePlaceholder(undefined, imageUrl.length) }
            : {
              type: 'image_url' as const,
              image_url: { url: imageUrl, detail: 'auto' as const },
            }
        )),
      ];
      this.memory.add({
        role: 'user',
        content: contentParts,
      });
    } else {
      const allMsgs = this.memory.getAll();
      let lastIdx = allMsgs.length - 1;
      while (lastIdx >= 0 && allMsgs[lastIdx]?.role === 'system') lastIdx--;
      const cand = lastIdx >= 0 ? allMsgs[lastIdx] : undefined;
      const candContent = cand && cand.role === 'user' && typeof cand.content === 'string'
        ? cand.content : null;
      const isRestoredDuplicate = !!candContent
        && (task === candContent
          || (task.startsWith(candContent) && task.length - candContent.length < 600));

      /* stall 重来: 只看最后一条是不够的 —— 流是中途断的, 最后一条通常是助手半截回复
       * 或工具结果, 用户那句话被压在下面几条。全量倒着找一遍, 找到就当已经在了。
       *
       * 为什么不干脆"重来就无条件跳过 add": 极端情况下 stall 可能发生在 memory.add
       * **之前** (比如某条 input guardrail 卡住), 那样跳过就把用户的话整个弄丢了 ——
       * 比重复一份更糟。所以是"找到才跳过"。 */
      const alreadyInHistory = !isRestoredDuplicate && isSameTurnResume
        && allMsgs.some((m) => m.role === 'user'
          && typeof m.content === 'string'
          && isSameUserMessage(m.content, task));

      if (alreadyInHistory) {
        cliLogger.info('RUNNER',
          '[DEDUP] stall 重来 —— 用户消息已在历史里, 不再追加 (再 append 一次等于用户被复读)');
      } else if (isRestoredDuplicate) {
        const next = [...allMsgs];
        next[lastIdx] = { ...cand!, content: task };
        this.memory.setMessages(next);
        cliLogger.info('RUNNER',
          `[DEDUP] restored user message upgraded in place (injected +${task.length - candContent!.length} chars), not appended`);
      } else {
        this.memory.add({
          role: 'user',
          content: task,
        });
      }
    }

    /** ======================================================================== **/
    /** 主循环状态变量初始化 **/
    /** ======================================================================== **/
    /* 续跑沿用本轮最初的起点 —— 否则 maxRuntimeMs 每断一次流就重新开始计时 */
    const runStartTime = (resuming && this.lastRunStartedAt) ? this.lastRunStartedAt : Date.now();
    this.lastRunStartedAt = runStartTime;
    const modelAtRunStart = this.model;
    const runTrace = beginRun({ sessionId: this.sessionId, agentName: this.agentName });
    this.runTrace = runTrace;

    /* Team P1 (§3.4): 注册本会话的 AgentMessageBus inbox — 幂等。
     *   子 agent 用 report_to_conductor 上报前, 接收方 inbox 必须已存在 (send 无 inbox 会抛错)。
     *   turn 结束不注销: 后台 agent 在父 turn 间隙上报也要能入队, 下一轮循环顶部统一消费。 */
    if (this.sessionId) {
      agentMessageBus.registerInbox(this.sessionId);
    }


    try {
    /** ---- 三大决策单元(runTrackers.ts) ---- */
    const run = new RunAccumulator();
    const carried = resuming ? this.lastRunAccumulator : undefined;
    if (carried) {
      run.iteration = carried.iteration;
      run.addToolCalls(carried.totalToolCalls);
    }
    this.lastRunAccumulator = run;
    const recovery = new RecoveryTracker();
    const progress = new ProgressTracker({
      maxNoToolContinue: Math.min(Math.max(Number(process.env.NEOX_MAX_NO_TOOL_CONTINUE) || 8, 1), 50),
      maxStructuredRetry: Math.min(Math.max(Number(process.env.NEOX_MAX_STRUCTURED_RETRY) || 5, 1), 20),
    });

    this.errorPatternMemory.reset();
    this.toolCallDedup.reset();
    this.fileHotspot.reset();
    this.reasoningLoopDetector.reset();
    this.streamPartialTracker.reset();
    this.toolUsageAdvisor.reset();
    this.autoVerifyPipeline.reset();
    const recentToolOutcomes: ToolOutcomeSnapshot[] = [];
    const repairTracker = new RepairTracker();
    const taskRequirements = inferTaskRequirements(task, getCompletionProfile(this.modelProfile).unknownTaskFallback);
    let lastPartialContent = '';

    const loopProfile = this.modelProfile?.loop ?? {};
    const fastConverge = loopProfile.strategy === 'fast_converge';
    const enableProgressGate = !fastConverge && loopProfile.disableProgressGate !== true;
    const enablePlannerAutoFollowup = !fastConverge && loopProfile.disablePlannerAutoFollowup !== true;

    const loopWasteStats = {
      toolResultFollowups: 0,
      plannerAutoFollowups: 0,
      noToolGuardFollowups: 0,
      noToolFinalizeContinues: 0,
      progressGateTriggers: 0,
      noToolReasons: {
        empty_final_output: 0,
        tool_call_text_leak: 0,
        intermediate_progress_text: 0,
        continuation_intent_detected: 0,
        xml_fragment_repair: 0,
      },
    };
    const bumpNoToolReason = (reason: NoToolContinuationReason): void => {
      if (reason === 'none') return;
      loopWasteStats.noToolReasons[reason]++;
    };

    const maxStreamRetries = DEFAULT_RETRY_CONFIG.streamMaxRetries;

    /** 最大迭代次数：0 或 Infinity 表示无限制 **/
    const maxIter = (Number.isFinite(this.config.maxIterations)
      ? this.config.maxIterations
      : DEFAULT_MAX_ITERATIONS) as number;
    const isUnlimited = maxIter === 0 || maxIter === Infinity;

    /** 最大工具调用次数 / 运行时间 **/
    const maxToolCalls = normalizeLimit(this.config.maxToolCalls, DEFAULT_MAX_TOOL_CALLS);
    const maxRuntimeMs = normalizeLimit(this.config.maxRuntimeMs, DEFAULT_MAX_RUNTIME_MS);

    /** ======================================================================== **/
    /** 主执行循环：LLM 调用 → 工具执行 → 循环直到完成 核心住要循环！**/
    /** ======================================================================== **/
    let wrapUpTurn = false;  /* 工具被硬拦后的收尾轮 (见 runnerWrapUp.ts) */
    while (isUnlimited || run.iteration < maxIter) {
      // 人工中断或硬性限制检查
      if (signal?.aborted) {
        if (lastPartialContent.length > 0) {
          this.memory.add({
            role: 'assistant',
            content: lastPartialContent + '\n\n[task interrupted by user]',
          });
          lastPartialContent = '';
        }
        run.terminate('interrupted');
        yield { type: 'error', error: 'Task interrupted by user.' };
        break;
      }

      if (maxRuntimeMs !== null) {
        const elapsedMs = Date.now() - runStartTime;
        if (elapsedMs >= maxRuntimeMs) {
          run.terminate('runtime_limit');
          yield {
            type: 'error',
            error: `Reached max runtime (${formatDelay(maxRuntimeMs)}). Please summarize progress and ask whether to continue.`,
          };
          break;
        }
      }

      if (maxToolCalls !== null && run.totalToolCalls >= maxToolCalls) {
        run.terminate('tool_call_limit');
        yield {
          type: 'error',
          error: `Reached max tool calls (${maxToolCalls}). Please summarize progress and ask whether to continue.`,
        };
        break;
      }

      /* 暂停的安全点 —— 只能在这里 (为什么见 pauseGate.ts)。不 yield 事件: StreamEvent
       * 没有"暂停"这一类, 加一类要在四跳上手写四遍; 状态由 host 在 onSnapshotReady 里发。 */
      if (this.pauseGate?.isPaused()) {
        /* 跟停止信号竞速 —— 只等 resume 的话, 暂停着按停止这一轮永远不结束 (见 waitForResumeOrAbort) */
        const outcome = await waitForResumeOrAbort(this.pauseGate, {
          sessionId: this.sessionId ?? '',
          iteration: run.iteration,
          toolCalls: run.totalToolCalls,
        }, signal);
        /* 恢复后也要重查中断: 暂停期间用户完全可能改主意直接停掉 */
        if (outcome === 'aborted' || signal?.aborted) { run.terminate('interrupted'); break; }
      }

      run.iteration++;
      runTrace.setIteration(run.iteration);

      if (this.sessionId && agentMessageBus.hasMessages(this.sessionId)) {
        const busMessages = agentMessageBus.receive(this.sessionId);
        if (busMessages.length > 0) {
          const rendered = busMessages
            .map(m => `<agent-message from="${m.fromAgentName}" role="${m.messageType}">${m.payload}</agent-message>`)
            .join('\n');
          this.memory.appendReminder(rendered);
          cliLogger.info('RUNNER',
            `[BUS] injected ${busMessages.length} agent message(s) as reminder`, {
              sessionId: this.sessionId,
              from: busMessages.map(m => `${m.fromAgentName}(${m.messageType})`).join(', '),
            });
        }
      }

      if (this.perTurnInjector && run.iteration >= 2) {
        try {
          const inj = this.perTurnInjector({ iteration: run.iteration });
          if (inj?.message) {
            this.memory.add({ role: 'user', content: inj.message });
          }
        } catch (err: any) {
          cliLogger.debug('RUNNER', `perTurnInjector failed: ${err?.message}`);
        }
      }

      /** 智能上下文管理：只有接近上限时才触发压缩 **/
      let compactionResult: BatchCompressionResult | null = null;
      let compactionStarted = false;
      let messagesBeforeCompaction: Message[] | null = null;
      if (this.maxInputTokens && this.autoCompressEnabled) {
        const rawEstimate = estimateTokensFromMessages(this.memory.getMessagesForLLM());
        const scale = resolveTokenScale(
          this.measuredPromptTokens,
          this.estimateAtMeasurement,
          this.sessionMinFixedOverhead,
        );
        const plan = resolveCompactionPlan({
          contextWindow: this.contextWindowSize,
          maxInputTokens: this.maxInputTokens,
          overrideRatio: this.compressionThreshold,
          scale,
        });
        const currentTokens = scale.toReal(rawEstimate);
        const threshold = plan.triggerLine;

        if (currentTokens > plan.lightLine && currentTokens <= threshold
            && currentTokens > this.lastLightCompactTokens + COMPACT_RETRY_GROWTH_TOKENS) {
          try {
            const lightBefore = this.memory.getMessagesForLLM();
            const light = await compressContextWindow({
              mode: 'light',
              maxInputTokens: this.maxInputTokens,
              contextWindow: this.contextWindowSize,
              iteration: run.iteration,
              memory: this.memory,
              unifiedCompressor: this.unifiedCompressor,
              compressionMode: this.compressionMode,
              model: this.model,
              sessionId: this.sessionId,
              trigger: 'auto',
              maxTurnAge: AUTO_COMPACT_MAX_TURN_AGE,
              overrideRatio: this.compressionThreshold,
              tokenCalibration: { measured: this.measuredPromptTokens, estimateAtMeasurement: this.estimateAtMeasurement },
              fixedOverheadSample: this.sessionMinFixedOverhead,
              logInfo: (m) => cliLogger.info('Context', m),
              logDebug: (m) => cliLogger.debug('Context', m),
            });
            this.lastLightCompactTokens = currentTokens;
            if (light) {
              await this.notifyHistoryCompacted({
                evictedReadPaths: findEvictedReadPaths(lightBefore, this.memory.getMessagesForLLM()),
              });
            }
          } catch (err: any) {
            cliLogger.warn('RUNNER', `[lightCompact] failed, ignored: ${err?.message ?? err}`);
          }
        }

        const noopGrowthGate = this.lastCompactionNoopTokens > 0
          && currentTokens < this.lastCompactionNoopTokens + COMPACT_RETRY_GROWTH_TOKENS;

        const gateWorthLogging = threshold > 0
          ? currentTokens > threshold * COMPACT_GATE_LOG_FRACTION
          : true;   /* 算不出阈值本身就是要查的问题, 无条件记 */
        if (gateWorthLogging
            && !(threshold > 0 && currentTokens > threshold && !noopGrowthGate)) {
          void import('../utils/stallGuard.js').then(({ writeStallFile }) => {
            writeStallFile('info', 'COMPACT_GATE', 'auto-compact 未触发', {
              why: threshold <= 0 ? 'threshold<=0 (contextWindow/maxInputTokens 都没有可用口径)'
                : noopGrowthGate ? 'noopGrowthGate (上次空转后还没长够)'
                : 'below threshold',
              calibratedTokens: currentTokens,
              rawEstimate,
              calibrationRatio: this.estimateAtMeasurement > 0
                ? +(this.measuredPromptTokens / this.estimateAtMeasurement).toFixed(3)
                : null,
              threshold,
              contextWindowSize: this.contextWindowSize ?? null,
              maxInputTokens: this.maxInputTokens ?? null,
              compressionThreshold: this.compressionThreshold ?? null,
              lastNoopTokens: this.lastCompactionNoopTokens,
            });
          }).catch(() => { /* 诊断不能拖垮主流程 */ });
        }

        if (threshold > 0 && currentTokens > threshold && !noopGrowthGate) {
          compactionStarted = true;
          /* 压缩前留一份 message 快照 —— 压缩后跟它比, 算出"读内容被挤掉的文件",
             报给宿主作废读账本 (账本必须镜像上下文, 见 findEvictedReadPaths)。 */
          messagesBeforeCompaction = this.memory.getMessagesForLLM();
          const budgetTokens = this.maxInputTokens || 0;
          // 收集压缩进度事件（onProgress 在 await 期间同步回调，存到队列）
          const progressQueue: Array<import('../utils/compression/llmSummarizer.js').CompressionProgress> = [];

          yield {
            type: 'context_compaction',
            status: 'started',
            originalTokens: currentTokens,
            budgetTokens,
            useLLM: true,
            timestamp: Date.now(),
          } as any;

          const compactPhaseId = runTrace.pushPhase(RunPhase.AutoCompact, 'autocompact', { currentTokens, threshold });
          try {
            compactionResult = await compressContextWindow({
              maxInputTokens: this.maxInputTokens,
              // 传原始 contextWindow 才能启用 autoCompactGuard 熔断/递归保护
              // (此前漏传 → 该保护整段被跳过, 与 host 路径行为不一致)
              contextWindow: this.contextWindowSize,
              iteration: run.iteration,
              memory: this.memory,
              unifiedCompressor: this.unifiedCompressor,
              compressionMode: this.compressionMode,
              model: this.model,
              sessionId: this.sessionId,
              trigger: 'auto',
              /* 跟预门禁同口径, 否则 override 调低后这里仍会拦 → 死区复活 */
              overrideRatio: this.compressionThreshold,
              maxTurnAge: AUTO_COMPACT_MAX_TURN_AGE,
              logInfo: (message) => cliLogger.info('Context', message),
              logDebug: (message) => cliLogger.debug('Context', message),
              onCompressionProgress: (p) => progressQueue.push(p),
              tokenCalibration: { measured: this.measuredPromptTokens, estimateAtMeasurement: this.estimateAtMeasurement },
              fixedOverheadSample: this.sessionMinFixedOverhead,
            });
          } catch (err: any) {
            compactionResult = null;   /* → 下面按 'skipped' 收尾, pending 卡片照样有终态 */
            cliLogger.warn('RUNNER', `[autoCompact] failed, continuing turn: ${err?.message ?? err}`);
            void import('../utils/stallGuard.js').then(({ writeStallFile }) => {
              writeStallFile('warn', 'COMPACT_GATE', 'auto-compact 抛错 (已吞, 不打断本轮)', {
                error: String(err?.message ?? err),
                calibratedTokens: currentTokens,
                threshold,
              });
            }).catch(() => { /* 诊断不能拖垮主流程 */ });
          } finally {
            runTrace.popPhase(compactPhaseId);
          }

          // yield 积攒的进度事件（每完成一个桶一条 compressing 事件）
          for (const p of progressQueue) {
            yield {
              type: 'context_compaction',
              status: 'compressing',
              /* 同口径: 进行中卡片显示的 tokens 也过校准 (裸估算 vs 真 token, 见 completed 注释) */
              originalTokens: this.calibrateContextTokens(p.originalTokens),
              budgetTokens,
              useLLM: true,
              timestamp: Date.now(),
              compression: {
                phase: p.phase,
                totalBuckets: p.totalBuckets,
                completedBuckets: p.completedBuckets,
                buckets: p.buckets,
                summaryModel: p.summaryModel,
              },
            } as any;
          }
        }
      } else if (this.memory.getMessagesForLLM().length > COMPACT_GATE_MSG_FLOOR) {
        /* 外层门禁把整段跳过 —— 这是最危险的一条: 连阈值都不算, 长任务治理**整体失效**且一声不响。
         * 这里才是它真正的 else (见上方"挂错 if"那条教训)。只在历史已经很长时才记。 */
        void import('../utils/stallGuard.js').then(({ writeStallFile }) => {
          writeStallFile('warn', 'COMPACT_GATE', 'auto-compact 整段跳过 (外层门禁)', {
            why: !this.maxInputTokens
              ? 'maxInputTokens 为空 — 上游没给 contextWindow'
              : 'autoCompressEnabled=false',
            maxInputTokens: this.maxInputTokens ?? null,
            contextWindowSize: this.contextWindowSize ?? null,
            autoCompressEnabled: this.autoCompressEnabled,
            messageCount: this.memory.getMessagesForLLM().length,
          });
        }).catch(() => { /* 诊断不能拖垮主流程 */ });
      }

      if (compactionStarted) {
        if (compactionResult) {
          /* 真压过了 → 清空转退避水位, 否则下一次该压时会被 noopGrowthGate 误挡 */
          this.lastCompactionNoopTokens = 0;
          yield {
            type: 'context_compaction',
            status: 'completed',
            originalMessages: compactionResult.originalCount,
            keptMessages: compactionResult.messages.length,
            droppedMessages: compactionResult.stats.droppedMessages,
            compressedMessages: compactionResult.stats.llmCompressedMessages,
            /* 轻量层就地瘦身的条数 —— 不报它, 一次真实压缩看起来就像"什么都没干" */
            truncatedMessages: compactionResult.stats.truncatedMessages,
            originalTokens: this.calibrateContextTokens(compactionResult.originalTokens),
            finalTokens: this.calibrateContextTokens(compactionResult.compressedTokens),
            budgetTokens: this.maxInputTokens || 0,
            useLLM: compactionResult.stats.llmCompressedMessages > 0,
            timestamp: Date.now(),
          };
        } else {
          /* 压缩没能进行 (熔断 / 锁被占 / 无可压内容) — 如实收尾, 不假装压过了。
             finalTokens = originalTokens 让上下文表盘保持原值不误降。 */
          const keptTokens = estimateTokensFromMessages(this.memory.getMessagesForLLM());
          this.lastCompactionNoopTokens = this.calibrateContextTokens(keptTokens);
          yield {
            type: 'context_compaction',
            status: 'skipped',
            originalMessages: this.memory.getMessagesForLLM().length,
            keptMessages: this.memory.getMessagesForLLM().length,
            droppedMessages: 0,
            compressedMessages: 0,
            /* 跟 completed 同口径: 报校准值 (lastCompactionNoopTokens 正是校准过的 keptTokens) */
            originalTokens: this.lastCompactionNoopTokens,
            finalTokens: this.lastCompactionNoopTokens,
            budgetTokens: this.maxInputTokens || 0,
            useLLM: false,
            timestamp: Date.now(),
          } as any;
        }

        /* 见上方 COMPACT_STAT 注释 —— 此处两个分支都已跑完, 取值确定 */
        const compactStat = compactionResult
          ? {
              status: 'completed',
              originalMessages: compactionResult.originalCount,
              keptMessages: compactionResult.messages.length,
              droppedMessages: compactionResult.stats.droppedMessages,
              compressedMessages: compactionResult.stats.llmCompressedMessages,
              truncatedMessages: compactionResult.stats.truncatedMessages,
              originalTokens: compactionResult.originalTokens,
              finalTokens: compactionResult.compressedTokens,
              savedTokens: compactionResult.originalTokens - compactionResult.compressedTokens,
              /* UI 事件报的是校准值 (见 yield 处), 这里裸值+校准值都落 —— 排"卡片数字对不上"时用 */
              calibratedOriginalTokens: this.calibrateContextTokens(compactionResult.originalTokens),
              calibratedFinalTokens: this.calibrateContextTokens(compactionResult.compressedTokens),
              useLLM: compactionResult.stats.llmCompressedMessages > 0,
              /* 哪一层干的活 —— 只看三个计数就能定性, 不用再去翻源码猜 */
              layer: compactionResult.stats.llmCompressedMessages > 0 ? 'llm'
                : compactionResult.stats.droppedMessages > 0 ? 'drop'
                  : compactionResult.stats.truncatedMessages > 0 ? 'truncate' : 'none',
            }
          : { status: 'skipped', noopTokens: this.lastCompactionNoopTokens };
        void import('../utils/stallGuard.js')
          .then(({ writeStallFile }) => {
            writeStallFile('info', 'COMPACT_STAT', `compaction ${compactStat.status}`, compactStat);
          })
          .catch(() => { /* 埋点绝不能拖垮压缩本身 */ });
      }

      // 等轻量层, 它们不发 completed 事件但同样改了 memory)。同步进单源 SessionContext,
      // 否则 loadHistory/重启把全量历史读回来 → 压缩白做。
      if (compactionResult) {
        const evictedReadPaths = messagesBeforeCompaction
          ? findEvictedReadPaths(messagesBeforeCompaction, this.memory.getMessagesForLLM())
          : undefined;
        await this.notifyHistoryCompacted(evictedReadPaths ? { evictedReadPaths } : undefined);
      }

      const contextHealth = this.memory.checkContextHealth();

      if (contextHealth.warnings.length > 0 || contextHealth.shouldCleanup) {
        /** 发射健康状态事件：UI 可显示警告提示 **/
        yield {
          type: 'raw_response_event',
          data: {
            type: 'context_health',
            totalTokens: contextHealth.totalTokens,
            toolResultTokens: contextHealth.toolResultTokens,
            toolResultRatio: contextHealth.toolResultRatio,
            messageCount: contextHealth.messageCount,
            toolMessageCount: contextHealth.toolMessageCount,
            warnings: contextHealth.warnings,
            shouldCompress: contextHealth.shouldCompress,
            shouldCleanup: contextHealth.shouldCleanup,
            byType: contextHealth.byType,
          },
          event_type: 'context_health',
        } as RawResponseStreamEvent;

        // 自动清理过期的 ephemeral 消息（执行确认型）
        if (contextHealth.shouldCleanup && contextHealth.byType.ephemeral.count > 5) {
          const cleanedCount = this.memory.cleanupEphemeral();
          if (cleanedCount > 0) {
            cliLogger.info('Runner', `Cleaned ${cleanedCount} ephemeral messages`);
          }
        }
      }

      // Token 统计日志
      cliLogger.debug('Runner', this.memory.getTokenSummary());

      let pendingPrediction: { type: 'content'; content: string } | undefined;

      // 记录迭代日志
      logger.agentIteration(run.iteration, 'thinking');

      // 发射迭代开始事件（向后兼容）
      yield {
        type: 'iteration_start',
        iteration: run.iteration,
      };
      const iterationSteeringGeneration = this.steeringGeneration;

      try {
        // 发射 LLM 请求开始事件：通知 UI 开始等待响应
        yield {
          type: 'raw_response_event',
          data: {
            type: 'response.created',
            response: {
              id: `resp_${Date.now()}`,
              model: this.model,
            },
          },
          event_type: 'response.created',
        } as RawResponseStreamEvent;

        /** 记录 LLM 请求日志（用于调试和性能分析）
         *  注: spread 拷贝数组防止下方 messages[lastUserIdx] = ... 变异污染 memory */
        const messages = [...this.memory.getMessagesForLLM()];
        cliLogger.info('LLM', `Request: model=${this.model}, messages=${messages.length}, tools=${this.tools.length}`);
        cliLogger.debug('LLM', 'Request messages', {
          messageCount: messages.length,
          lastMessage: messages[messages.length - 1]?.content?.toString().substring(0, 200),
        });

        if (process.env.CLI_DEBUG === '1') {
          const systemMessages = messages.filter(m => m.role === 'system');
          console.log('[RUNNER] System messages count:', systemMessages.length);
          for (let i = 0; i < systemMessages.length; i++) {
            const rawContent = systemMessages[i].content;
            const content = typeof rawContent === 'string'
              ? rawContent
              : JSON.stringify(rawContent);
            console.log(`[RUNNER] System[${i}] length:`, content?.length || 0);
            console.log(`[RUNNER] System[${i}] contains 协作模式:`, content?.includes('协作模式') || false);
            console.log(`[RUNNER] System[${i}] contains delegate_task:`, content?.includes('delegate_task') || false);
            console.log(`[RUNNER] System[${i}] preview:`, content?.substring(0, 300) || '');
          }
        }


        /**  调用 LLM 流式 API：真正的 SSE 流式响应 **/
        const modeFilteredTools = this.modeStrategy.filterTools(this.tools);
        const availableTools = applyToolsetFilter(modeFilteredTools, this.modelProfile, { modelName: this.model });

        if (process.env.CLI_DEBUG === '1') {
          cliLogger.debug('RUNNER', `Mode: ${this.currentMode}, Available tools: ${availableTools.length}/${this.tools.length}`);
        }

        const _rawRequestMessages = this.memory.getMessagesForLLM();
        const _imgGuard = stripStaleImages(_rawRequestMessages);
        const _visionGuard = _imgGuard;
        const _pairGuard = enforceToolPairs(_visionGuard.messages as any[]);
        const requestMessages = prepareMessagesForWire(_pairGuard.messages) as typeof _visionGuard.messages;
        if (_imgGuard.strippedImages > 0) {
          cliLogger.info('RUNNER',
            `[IMG_GUARD] stripped ${_imgGuard.strippedImages} stale image(s), freed ~${(_imgGuard.bytesFreed / 1024 / 1024).toFixed(2)}MB from request`);
        }

        /* trace: 发给 LLM 之前看 tool_call ↔ tool_result 配对.
           Anthropic 严格要求 1:1, 任一不齐 Claude 都会判定 "失败 / 没收到".
           这是定位 "工具明明成功 LLM 却说失败" 最直接的一刀. */
        try {
          const callIds: string[] = [];
          const resultIds: string[] = [];
          const roleCounts: Record<string, number> = {};
          for (const m of requestMessages as any[]) {
            const role = m?.role || 'unknown';
            roleCounts[role] = (roleCounts[role] || 0) + 1;
            if (role === 'assistant' && Array.isArray(m.tool_calls)) {
              for (const tc of m.tool_calls) if (tc?.id) callIds.push(tc.id);
            } else if (role === 'tool' && typeof m.tool_call_id === 'string') {
              resultIds.push(m.tool_call_id);
            }
          }
          const resultSet = new Set(resultIds);
          const callSet = new Set(callIds);
          /* 拿最后 3 条 assistant 消息的 tool_calls.arguments — 验证 sanitization
             是否生效, LLM 实际看到的 args 是否还有 EMPTY_INPUT 串 */
          const recentToolCallArgs: Array<{ name: string; argsPreview: string; pollutedByEmptyInput: boolean }> = [];
          const assistantMsgs = (requestMessages as any[]).filter((m) => m?.role === 'assistant' && Array.isArray(m.tool_calls));
          for (const m of assistantMsgs.slice(-3)) {
            for (const tc of m.tool_calls || []) {
              const argStr = String(tc?.function?.arguments ?? '');
              recentToolCallArgs.push({
                name: tc?.function?.name || '',
                argsPreview: argStr.length > 200 ? argStr.slice(0, 200) + '…' : argStr,
                pollutedByEmptyInput: argStr.includes('"_error":"EMPTY_INPUT"') || argStr.includes('_error":"EMPTY_INPUT'),
              });
            }
          }

          /* 最后一组 (最末 assistant 带 tool_calls + 紧跟其后的 tool 响应) 实际内容 dump.
             这就是 LLM 这一轮真正看到的"上一轮工具状况", 直接看是 success 还是 error 就到底. */
          let lastTurnDump: any = undefined;
          const msgs = requestMessages as any[];
          let lastAssistIdx = -1;
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i]?.role === 'assistant' && Array.isArray(msgs[i].tool_calls) && msgs[i].tool_calls.length > 0) {
              lastAssistIdx = i; break;
            }
          }
          if (lastAssistIdx >= 0) {
            const lastAssist = msgs[lastAssistIdx];
            const lastAssistantToolCalls = (lastAssist.tool_calls || []).map((tc: any) => {
              const a = String(tc?.function?.arguments ?? '');
              return {
                id: tc?.id || '',
                name: tc?.function?.name || '',
                argsPreview: a.length > 300 ? a.slice(0, 300) + '…' : a,
              };
            });
            const followingToolResults: any[] = [];
            for (let j = lastAssistIdx + 1; j < msgs.length; j++) {
              const m = msgs[j];
              if (m?.role !== 'tool') break;
              const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
              const cstr = String(c ?? '');
              const lower = cstr.toLowerCase();
              followingToolResults.push({
                toolCallId: m.tool_call_id || '',
                name: m.name || '',
                contentPreview: cstr.length > 400 ? cstr.slice(0, 400) + '…' : cstr,
                contentLength: cstr.length,
                isErrorLooking: lower.includes('"status":"error"')
                  || lower.includes('empty_input')
                  || lower.includes('"error":')
                  || lower.includes('failed')
                  || lower.includes('失败'),
              });
            }
            lastTurnDump = { lastAssistantToolCalls, followingToolResults };
          }

          appendToolTrace({
            phase: 'llm_request',
            iteration: run.iteration,
            modelName: this.model,
            agentName: this.agentName,
            totalMessages: requestMessages.length,
            toolCallIds: callIds,
            toolResultIds: resultIds,
            missingToolResultIds: callIds.filter((id) => !resultSet.has(id)),
            orphanToolResultIds: resultIds.filter((id) => !callSet.has(id)),
            roleCounts,
            recentToolCallArgs,
            lastTurnDump,
          });

          if (process.env.NEOX_DUMP_LLM_PAYLOAD === '1') {
            try {
              const fsp = await import('node:fs/promises');
              const os = await import('node:os');
              const path = await import('node:path');
              const dumpDir = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'logs', 'llm-requests');
              await fsp.mkdir(dumpDir, { recursive: true }).catch(() => { /* exists */ });
              const dumpPath = path.join(dumpDir, `iter${run.iteration}-${Date.now()}.json`);
              await fsp.writeFile(dumpPath, JSON.stringify(requestMessages, null, 2), 'utf8');
              cliLogger.info('RUNNER', `[LLM_REQ_DUMP] wrote ${requestMessages.length} msgs to ${dumpPath}`);
            } catch (err: any) {
              cliLogger.warn('RUNNER', `[LLM_REQ_DUMP] failed: ${err?.message || err}`);
            }
          }
        } catch (err: any) {
          /* trace 不能拖累 hot path — 但完全吞掉, 出问题查不到。
             调到 debug, NEOX_DEBUG=1 时 stderr 可见, 默认不污染。 */
          cliLogger.debug('RUNNER', `[TRACE] llm_request trace collection failed: ${err?.message || err}`);
        }
        const requestBreakdown = buildContextBreakdown(
          !hasSystemPrompt || this.disableSystemPrompt
            ? {
              messages: requestMessages,
              tools: availableTools,
              systemPromptText: dynamicInstructions || '',
              hiddenInstructionTexts: [
                structuredOutputPrompt,
                smartReadHint,
                contextInjection,
                projectContextPrompt,
              ],
              agentPrefixText: this.disableSystemPrompt ? '' : (modePrompt || ''),
            }
            : {
              messages: requestMessages,
              tools: availableTools,
            }
        );

        let _cacheDiag: any = null;
        if (process.env.NEOX_CACHE_PROBE === '1') try {
          const systemText = requestMessages
            .filter((m: any) => m?.role === 'system')
            .map((m: any) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''))
            .join('\n\n');
          const prefixMessages = requestMessages.slice(0, Math.min(6, requestMessages.length)).map((m: any) => ({
            role: m.role,
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
            toolCalls: Array.isArray(m.tool_calls) ? m.tool_calls.map((tc: any) => tc?.function?.name || tc?.name || '') : undefined,
            toolCallId: m.tool_call_id,
          }));
          const digest = (value: unknown) => createHash('sha256')
            .update(typeof value === 'string' ? value : JSON.stringify(value))
            .digest('hex')
            .slice(0, 12);
          const systemHash = digest(systemText);
          const toolsHash = digest(availableTools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })));
          cliLogger.info('CACHE_PREFIX', 'LLM request prefix fingerprint', {
            sessionId: this.sessionId,
            model: this.model,
            iteration: run.iteration,
            messageCount: requestMessages.length,
            systemHash,
            systemChars: systemText.length,
            toolsHash,
            toolNames: availableTools.map(t => t.name),
            prefixMessagesHash: digest(prefixMessages),
            prefixRoles: requestMessages.slice(0, 8).map((m: any) => m.role),
          });
          const msgHashes = (requestMessages as any[]).map((m) => digest({
            role: m.role,
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
            tc: Array.isArray(m.tool_calls) ? m.tool_calls.map((t: any) => `${t?.id}:${t?.function?.name}:${t?.function?.arguments}`) : undefined,
            tcid: m.tool_call_id,
          }));
          const prev = (this as any)._prevCacheFp as { systemHash: string; toolsHash: string; msgHashes: string[]; systemText: string } | undefined;
          let firstDivergentMsgIdx = -1;
          if (prev) {
            const minLen = Math.min(prev.msgHashes.length, msgHashes.length);
            for (let i = 0; i < minLen; i++) {
              if (prev.msgHashes[i] !== msgHashes[i]) { firstDivergentMsgIdx = i; break; }
            }
          }
          const systemChanged = prev ? prev.systemHash !== systemHash : false;
          let sysDiff: any = undefined;
          if (systemChanged && prev) {
            const a = prev.systemText, b = systemText;
            let d = 0; const min = Math.min(a.length, b.length);
            while (d < min && a[d] === b[d]) d++;
            sysDiff = {
              at: d, prevLen: a.length, curLen: b.length,
              prevSnip: a.slice(Math.max(0, d - 20), d + 60).replace(/\n/g, '\\n'),
              curSnip: b.slice(Math.max(0, d - 20), d + 60).replace(/\n/g, '\\n'),
            };
          }
          _cacheDiag = {
            systemHash, toolsHash, msgCount: msgHashes.length,
            systemChanged,
            toolsChanged: prev ? prev.toolsHash !== toolsHash : false,
            firstDivergentMsgIdx, prevMsgCount: prev?.msgHashes.length ?? -1,
            divergentRole: firstDivergentMsgIdx >= 0 ? (requestMessages as any[])[firstDivergentMsgIdx]?.role : undefined,
            sysDiff,
          };
          (this as any)._prevCacheFp = { systemHash, toolsHash, msgHashes, systemText };
          cliLogger.info('CACHE_BREAK', 'prefix divergence check', {
            sessionId: this.sessionId,
            iteration: run.iteration,
            systemChanged: _cacheDiag.systemChanged,
            toolsChanged: _cacheDiag.toolsChanged,
            firstDivergentMsgIdx: _cacheDiag.firstDivergentMsgIdx,
            divergentRole: _cacheDiag.divergentRole,
            msgCount: _cacheDiag.msgCount,
            prevMsgCount: _cacheDiag.prevMsgCount,
            ...(_cacheDiag.sysDiff ? { sysDiff: _cacheDiag.sysDiff } : {}),
          });
        } catch (err: any) {
          cliLogger.debug('CACHE_PREFIX', `Failed to fingerprint request prefix: ${err?.message || err}`);
        }

        if (process.env.CLI_DEBUG === '1') {
          const fingerprint = requestMessages.map((m, i) => {
            const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
            const hash = c.length > 0 ? c.substring(0, 30).replace(/\n/g, '\\n') : '(empty)';
            const tag = (m as any)._tag ? ` [${(m as any)._tag}]` : '';
            return `  [${i}] ${m.role}${tag} len=${c.length} "${hash}..."`;
          }).join('\n');
          cliLogger.debug('PREFIX_FINGERPRINT', `Messages (${requestMessages.length}):\n${fingerprint}`);
        }

        const streamAbort = new AbortController();
        if (signal?.aborted) {
          streamAbort.abort();
        } else if (signal) {
          const onOuterAbort = () => streamAbort.abort();
          signal.addEventListener('abort', onOuterAbort, { once: true });
          this.detachOuterAbortListener = () => signal.removeEventListener('abort', onOuterAbort);
        }
        this.activeStreamAbort = streamAbort;

        const stream = this.llmProvider.chatStreamed(requestMessages, {
          model: this.model,
          tools: availableTools,
          temperature: this.config.temperature,
          structuredOutput: this.structuredOutput,
          maxInputTokens: this.maxInputTokens,
          disableSystemPrompt: this.disableSystemPrompt,
          enableFGTS: this.getEnableFGTS(),
          prediction: pendingPrediction,
          signal: streamAbort.signal,  // 支持用户取消 + 流中转向
          effortLevel: runOpts?.effortLevel,
        } as any);
        // 用完即清，避免对非 edit 轮次产生副作用
        pendingPrediction = undefined;

        // ========================================================================
        // 流式响应累积变量
        // ========================================================================
        let fullContent = '';               // 累积的文本内容
        let envelopeLeakSuppressed = false; // 检测到 tool envelope 泄漏后抑制文本输出
        let fullReasoningContent = '';      // 累积的思维链内容（如 o1/doubao-seed）
        //   OpenAI Responses / Anthropic 的 model client 会显式 emit delta.reasoning_complete,
        //   但 chat-completions 协议(Kimi K2.5+ / DeepSeek-R1 走的是这条)的 reasoning_content
        //   是非标扩展, openaiCompatibleClient 只透传 SSE chunk 不感知 reasoning 阶段切换 →
        //   UI 收不到 reasoning_complete, "思考中" 卡片永不关闭(用户视角:卡 12s 不结束).
        //   这里在 runner 兜底: 一旦 reasoning 流结束(收到 content / finish_reason),
        //   补发一次 reasoning_complete 给 UI 关闭面板. 避免跟显式 emit 重复用 yielded flag.
        let reasoningStreamed = false;
        let reasoningCompleteYielded = false;
        let thinkingBlocks: Array<{ type: 'thinking' | 'redacted_thinking'; thinking?: string; signature?: string; data?: string }> = [];
        /** OpenAI Responses API encrypted reasoning items —
         *  GPT-5/o-series 上一轮回的 encrypted_content blob, 下一轮 input 必须原样回传,
         *  否则 OpenAI 直接 400 invalid_prompt. openai.ts 在 stream 里通过
         *  delta._openai_reasoning_item 把它喂出来, 这里累到 assistant message 上. */
        let openaiReasoningItems: Array<{ id?: string; summary?: Array<{ type?: string; text?: string }>; encrypted_content?: string }> = [];
        let toolCalls: ToolCall[] = [];          // 累积的工具调用
        /* 槽位归属不再直接信 delta.index —— 同 index 新 id 是新调用, 见 streamToolCallSlots.ts */
        const toolCallSlots = new ToolCallSlotTracker();
        let finishReason = '';              // 结束原因（stop/tool_calls/length）


        let cumulativeUsage: {              // Token 使用统计
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
          cached_tokens?: number;
          prompt_cache_hit_tokens?: number;
          prompt_cache_miss_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_write_input_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
        } = {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        };

        //    与 applyStreamWatchdog(它打 [watchdog] 日志)互补: 这里进统一 run 快照。
        const llmPhaseId = runTrace.pushPhase(RunPhase.LlmStream, 'llm:stream', { model: this.model });
        /* Q3: stream partial 跟踪 — chunk 累积 / 中断 / 完成 三态可见, retry 路径决定 prefill 续接 */
        this.streamPartialTracker.start();
        for await (const chunk of applyStreamWatchdog(
          stream,
          streamAbort.signal,
          (message) => cliLogger.warn('RUNNER', `[watchdog] ${message}`),
        )) {
          // 处理重连事件（网络不稳定时 LLM 提供者发出的重试信号）
          if (isStreamRetryChunk(chunk)) {
            recovery.providerManagedRetryObserved = true;
            yield chunk;
            continue;
          }

          if (isStreamRecoveredChunk(chunk)) {
            yield {
              type: 'stream_recovered',
              attempt: chunk.attempt,
              maxRetries: chunk.maxRetries,
            } as StreamRecoveredStreamEvent;
            continue;
          }

          // 不走 toolCalls 数组（避免 runner 重复执行本地 web_search）
          // 直接转换为 tool_call + tool_result 事件，复用 WebSearchCard 渲染
          if (isWebSearchProviderEvent(chunk)) {
            const wsEvent = chunk;
            const wsId = wsEvent.webSearchId || `native_web_search_${Date.now()}`;

            if (wsEvent.webSearchStatus === 'searching') {
              // 搜索开始 → 发送 tool_call 事件
              yield {
                type: 'tool_call_start',
                name: 'web_search',
                id: wsId,
                arguments: JSON.stringify({ query: wsEvent.webSearchQuery || '' }),
                description: `Searching: ${wsEvent.webSearchQuery || ''}`,
                timestamp: Date.now(),
              };
            } else if (wsEvent.webSearchStatus === 'completed') {
              // 搜索完成 → 发送 tool_result 事件
              const results = wsEvent.webSearchResults || [];
              yield {
                type: 'tool_output',
                name: 'web_search',
                id: wsId,
                success: true,
                output: JSON.stringify({
                  query: wsEvent.webSearchQuery || '',
                  results,
                  totalResults: results.length,
                }),
                timestamp: Date.now(),
              };
            }
            continue;
          }

          // 转发原始响应事件给 UI 层
          yield {
            type: 'raw_response_event',
            data: chunk,
            event_type: chunk.choices?.[0]?.delta ? 'response.delta' : 'response.chunk',
          } as RawResponseStreamEvent;

          const delta = chunk.choices?.[0]?.delta;

          // 处理 Token 使用统计（实时或最终）
          if (chunk.usage) {
            cumulativeUsage = {
              prompt_tokens: chunk.usage.prompt_tokens || cumulativeUsage.prompt_tokens,
              completion_tokens: chunk.usage.completion_tokens || cumulativeUsage.completion_tokens,
              total_tokens: chunk.usage.total_tokens || cumulativeUsage.total_tokens,
              // 缓存相关字段（Anthropic prompt caching）
              cached_tokens: chunk.usage.cached_tokens,
              prompt_cache_hit_tokens: chunk.usage.prompt_cache_hit_tokens,
              prompt_cache_miss_tokens: chunk.usage.prompt_cache_miss_tokens,
              cache_read_input_tokens: chunk.usage.cache_read_input_tokens,
              cache_creation_input_tokens: chunk.usage.cache_creation_input_tokens,
              cache_write_input_tokens: chunk.usage.cache_write_input_tokens,
              prompt_tokens_details: chunk.usage.prompt_tokens_details,
            };
            run.addUsage({
              prompt_tokens: cumulativeUsage.prompt_tokens,
              completion_tokens: cumulativeUsage.completion_tokens,
              total_tokens: cumulativeUsage.total_tokens,
            });
            this.recordMeasuredPromptTokens(normalizeUsageTokens(cumulativeUsage).contextTokens);

            // 判断是否为最终统计（有 finish_reason）
            const isFinal = !!chunk.choices?.[0]?.finish_reason;

            yield {
              type: 'token_usage',
              usage: cumulativeUsage,
              is_final: isFinal,
              requestBreakdown,
              cacheDiag: _cacheDiag,
            } as TokenUsageStreamEvent;
          }

          if (!delta) continue;

          // 处理思维链增量（如 o1/doubao-seed 的 reasoning_content）
          if (delta.reasoning_content) {
            fullReasoningContent += delta.reasoning_content;
            reasoningStreamed = true;
            yield {
              type: 'reasoning_delta',
              delta: delta.reasoning_content,
            };
          }

          // OpenAI Responses API encrypted reasoning blob — 下一轮必须回传, 见上方注释
          if ((delta as any)._openai_reasoning_item) {
            openaiReasoningItems.push((delta as any)._openai_reasoning_item);
          }

          // 当 thinking content_block_stop 时，立即渲染 Reasoning 块，不等整个响应完成
          if (delta.reasoning_complete) {
            reasoningCompleteYielded = true;
            yield {
              type: 'reasoning_complete',
            };
          }

          // 时反推 reasoning 已结束, 补发 reasoning_complete 给 UI 关闭"思考中"卡片.
          if (delta.content && reasoningStreamed && !reasoningCompleteYielded) {
            reasoningCompleteYielded = true;
            yield {
              type: 'reasoning_complete',
            };
          }

          // 处理文本内容增量
          if (delta.content) {
            fullContent += delta.content;
            lastPartialContent = fullContent;
            this.streamPartialTracker.append(delta.content);

            if (!envelopeLeakSuppressed && isLeakedToolEnvelopeText(
              fullContent,
              getCompletionProfile(this.modelProfile),
              registeredToolNames,
            )) {
              envelopeLeakSuppressed = true;
              if (process.env.CLI_DEBUG === '1') {
                cliLogger.debug('ENVELOPE_LEAK', 'Streaming text suppressed — envelope leak detected', {
                  preview: fullContent.slice(0, 200),
                });
              }
            }

            if (!envelopeLeakSuppressed) {
              run.finalOutput = fullContent;
              yield {
                type: 'text_delta',
                delta: delta.content,
              };
            }
          }

          // Handle tool calls delta
          if (delta.tool_calls) {
            for (const toolCallDelta of delta.tool_calls as ToolCallDeltaLike[]) {
              const index = toolCallSlots.resolve(toolCallDelta);

              // Initialize tool call if needed
              if (!toolCalls[index]) {
                toolCalls[index] = {
                  id: toolCallDelta.id || `call_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 8)}`,
                  type: 'function',
                  function: {
                    name: '',
                    arguments: '',
                  },
                };
              }

              // Update tool call
              if (toolCallDelta.id) {
                toolCalls[index].id = toolCallDelta.id;
              }
              if (toolCallDelta.function?.name) {
                toolCalls[index].function.name = toolCallDelta.function.name;
              }
              if (toolCallDelta.function?.arguments) {
                toolCalls[index].function.arguments += toolCallDelta.function.arguments;

                // Legacy tool_call_delta event
                yield {
                  type: 'tool_call_delta',
                  id: toolCalls[index].id,
                  name: toolCalls[index].function.name,
                  arguments_delta: toolCallDelta.function.arguments,
                };
              }
              if (toolCallDelta.thoughtSignature) {
                toolCalls[index].thoughtSignature = toolCallDelta.thoughtSignature;
              }
              if (toolCallDelta.__kimi_builtin) {
                toolCalls[index].__kimi_builtin = true;
                toolCalls[index].__kimi_original_name = toolCallDelta.__kimi_original_name;
              }
            }
          }

          // Handle finish reason
          if (chunk.choices?.[0]?.finish_reason) {
            finishReason = normalizeFinishReason(chunk.choices[0].finish_reason);
            /* 极端兜底: 流到 finish_reason 仍未发过 reasoning_complete (例如只有 reasoning 没正文,
             * 或 reasoning 之后直接 finish 没 content), 这里补发避免 UI "思考中" 残留. */
            if (reasoningStreamed && !reasoningCompleteYielded) {
              reasoningCompleteYielded = true;
              yield {
                type: 'reasoning_complete',
              };
            }
          }

          // Handle thinking_blocks (完整 thinking blocks from Anthropic，包含 signature)
          // 不能过滤或修改任何字段，否则会报错 "cannot be modified"
          // 直接存储原始数据，让 API 层处理验证
          if (chunk.thinking_blocks && Array.isArray(chunk.thinking_blocks)) {
            thinkingBlocks = chunk.thinking_blocks.map((block: any) => ({
              type: block.type as 'thinking' | 'redacted_thinking',
              thinking: block.thinking,
              signature: block.signature,
              data: block.data,
            }));
          }
        }
        runTrace.popPhase(llmPhaseId);
        this.clearActiveStreamAbort();

        if (this.steeringInterruptRequested && !signal?.aborted) {
          this.steeringInterruptRequested = false;
          this.streamPartialTracker.markInterrupted('abort_signal');
          if (fullContent.trim().length > 0) {
            this.memory.add({
              role: 'assistant',
              content: closeFencedBlocks(fullContent).trimEnd() + '\n\n[response interrupted: user sent a new message]',
            });
          }
          lastPartialContent = '';
          yield {
            type: 'raw_response_event',
            data: { type: 'steering_interrupt' },
            event_type: 'steering_interrupt',
          } as RawResponseStreamEvent;
          continue;
        }

        // Stream is complete, emit completion events
        if (fullContent) {

          yield {
            type: 'text_done',
          };
        }

        {
          const beforeLen = toolCalls.length;
          // filter 跳 hole; 同时丢掉 function 缺失的脏槽 (极端 gateway 只发了 index/id)
          const dense = toolCalls.filter((tc): tc is ToolCall =>
            !!tc && typeof tc === 'object' && !!tc.function && typeof (tc as any).function === 'object',
          );
          if (dense.length !== beforeLen) {
            cliLogger.warn('RUNNER',
              `[SPARSE_TOOLCALLS] densified toolCalls ${beforeLen} → ${dense.length} (dropped ${beforeLen - dense.length} hole/invalid slot(s); provider emitted non-contiguous index or incomplete delta)`);
            toolCalls = dense;
          }
        }

        // 注意：不要在每轮 LLM 回复后发 response.completed（会被 UI 误判为整轮完成）

        // Add assistant response to memory
        // IMPORTANT: 存入 memory 的必须是原始完整内容，不能截断！
        // 截断后的 "[omitted content: X lines, Y chars]" 会被 AI 误解为真实内容
        // 导致 AI 把这个占位符字符串写入文件，造成无限循环
        // "final assistant content cannot end with trailing whitespace"
        let fullContentForMessage = fullContent || '';
        if (toolCalls.length === 0) {
          const dsml = parseDsmlToolCalls(fullContentForMessage);
          if (dsml.calls.length > 0) {
            cliLogger.warn('RUNNER',
              `[DSML] provider 退化成文本形态工具调用, 已解析回 ${dsml.calls.length} 个: `
              + dsml.calls.map((c) => c.name).join(', '));
            for (const [i, c] of dsml.calls.entries()) {
              toolCalls[i] = {
                id: `call_dsml_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}`,
                type: 'function',
                function: { name: c.name, arguments: c.arguments },
              };
            }
            finishReason = 'tool_calls';
            fullContentForMessage = dsml.text;
          } else if (dsml.sawIncomplete) {
            /* 认出是 DSML 但拼不成完整调用 (多半被截断)。不执行, 也不能把残骸当回答
             * 留在气泡里 —— 清空正文, 让上层的"这轮没产出"逻辑照常接管去重试。 */
            cliLogger.warn('RUNNER', '[DSML] 文本形态工具调用不完整 (截断?), 丢弃残骸不执行');
            fullContentForMessage = dsml.text;
          }
        }
        dropWrapUpToolCalls(wrapUpTurn, toolCalls);

        const assistantMessage: Message = {
          role: 'assistant',
          content: closeFencedBlocks(fullContentForMessage).trimEnd(),
        };

        // 添加 reasoning_content（用于 UI 显示 extended thinking）
        if (fullReasoningContent) {
          assistantMessage.reasoning_content = fullReasoningContent;
        }

        // 添加完整的 thinking_blocks（用于 API 传递，包含 signature）
        // 这是修复 "signature: Field required" 错误的关键
        if (thinkingBlocks.length > 0) {
          assistantMessage.thinking_blocks = thinkingBlocks;
        }

        // OpenAI Responses API encrypted reasoning items — 同样必须回传, 见上方注释.
        // convertMessageToResponsesItems 在重建 input 时会先 emit 这些, 再 emit message + tool_calls.
        if (openaiReasoningItems.length > 0) {
          assistantMessage.openai_reasoning_items = openaiReasoningItems;
        }

        if (toolCalls.length > 0) {
          // 保留原始 arguments，不要 sanitize！
          // sanitizeToolArguments 只应该用于 UI 显示和日志，不能用于存储
          assistantMessage.tool_calls = toolCalls.map(toolCall => {
            let argsStr = toolCall.function.arguments;
            /* 上游 Claude 反代 (AccountHub kiro 等) 把空对象 input 误判成异常,
               塞 {_error:"EMPTY_INPUT",...} 占位. 在写进 memory 之前清掉 —
               否则下一轮 LLM 看自己的历史 args 是这串 _error JSON,
               会自行判定"工具失败"写进叙事(用户报的"4 并发只 1 成功"). */
            try {
              const parsed = argsStr ? JSON.parse(argsStr) : null;
              if (parsed && typeof parsed === 'object' && parsed._error === 'EMPTY_INPUT') {
                cliLogger.warn('RUNNER',
                  `[KIRO_GUARD] Sanitized polluted EMPTY_INPUT args in assistant message for tool=${toolCall.function.name}`);
                argsStr = '{}';
              }
            } catch (err: any) {
              const fixed = tryFixToolArgsJson(argsStr);
              if (fixed) {
                cliLogger.warn('RUNNER',
                  `[SELF_HEAL] auto-repaired malformed tool args for tool=${toolCall.function.name} (len ${argsStr.length} → ${fixed.length})`);
                argsStr = fixed;
              } else {
                cliLogger.debug('RUNNER',
                  `[KIRO_GUARD] non-JSON args for tool=${toolCall.function.name}: ${err?.message || err}`);
                cliLogger.warn('RUNNER',
                  `[P0-Z] dropping unrecoverable malformed tool args for ${toolCall.function.name}, replacing with {} to prevent next-turn self-infection`);
                argsStr = '{}';
              }
            }
            return {
              ...toolCall,
              function: {
                ...toolCall.function,
                arguments: argsStr,
              },
            };
          });
        }

        this.memory.add(assistantMessage);
        lastPartialContent = '';
        this.streamPartialTracker.markComplete(); // Q3: stream 正常结束

        recovery.streamRetries = 0;
        recovery.providerManagedRetryObserved = false;

        if (process.env.CLI_DEBUG === '1') {
          cliLogger.debug('RUNNER', `🔥 Stream ended. toolCalls.length=${toolCalls.length}, fullContent.length=${fullContent.length}`);
        }

        // ================================================================
        // BehaviorProfile 驱动的异常回复检测
        // ================================================================
        const behaviorProfile = this.modelProfile?.behavior ?? {};

        // 异常短回复检测：估算 token 数，低于阈值时视为截断
        // 关键：如果有 finish_reason（模型主动停止），说明是正常短回复，不重试
        if (behaviorProfile.minResponseTokens && behaviorProfile.minResponseTokens > 0
          && toolCalls.length === 0 && fullContent.length > 0 && !finishReason) {
          const approxTokens = estimateTokens(fullContent);
          if (approxTokens < behaviorProfile.minResponseTokens && recovery.streamRetries < 2) {
            cliLogger.warn('RUNNER', 'Suspiciously short response detected (no finish_reason)', {
              contentLength: fullContent.length,
              approxTokens,
              threshold: behaviorProfile.minResponseTokens,
              streamRetries: recovery.streamRetries,
            });

            yield {
              type: 'raw_response_event',
              data: {
                type: 'behavior.short_response_retry',
                approxTokens,
                threshold: behaviorProfile.minResponseTokens,
              },
              event_type: 'behavior.short_response_retry',
            } as RawResponseStreamEvent;

            recovery.streamRetries++;
            continue;
          }
        }

        // 可疑截断检测：finish_reason=stop 但没有 tool_calls（前几轮才检测）
        if (behaviorProfile.suspectTruncationOnStopWithoutTools
          && finishReason === 'stop'
          && toolCalls.length === 0
          && run.iteration <= 3
          && fullContent.length > 0) {
          if (process.env.CLI_DEBUG === '1') {
            cliLogger.warn('RUNNER', 'Suspected truncation: stop without tools', {
              iteration: run.iteration,
              finishReason,
              contentPreview: fullContent.slice(0, 200),
            });
          }
          // 不在此处重试流，交给后续的 grace 机制和 completion gate 处理
        }

        // ================================================================
        // max_output_tokens 恢复机制
        // Stage 1: 注入 meta nudge 让模型从断点继续（最多 3 次）
        // ================================================================
        if (finishReason === 'length' && toolCalls.length === 0) {
          // RecoveryTracker 封装递减检测 + 续跑计数 + 压缩许可重置
          const recoveryResult = recovery.onFinishLength(fullContent.length);

          if (recoveryResult.exhausted) {
            // 递减回报或次数耗尽 — 发事件，让正常完成流程处理
            const snap = recovery.snapshot();
            if (snap.diminishingReturnStreak >= 2) {
              yield {
                type: 'raw_response_event',
                data: {
                  type: 'max_output_diminishing_returns',
                  attempts: recoveryResult.attempt,
                  lastDelta: 0,
                  streak: snap.diminishingReturnStreak,
                },
                event_type: 'max_output_diminishing_returns',
              } as RawResponseStreamEvent;
            } else {
              cliLogger.warn('RUNNER', `Output recovery exhausted after ${recoveryResult.maxAttempts} attempts`);
              run.stopReason = 'max_output_recovery_exhausted';
              run.encounteredError = true;
              yield {
                type: 'error',
                error: `模型输出被截断且续跑重试用尽 (${recoveryResult.maxAttempts} 次). 建议在 服务商设置 → 该模型 增大 max_tokens 上限, 或改用非推理型模型.`,
              };
              yield {
                type: 'raw_response_event',
                data: {
                  type: 'max_output_recovery_exhausted',
                  attempts: recoveryResult.attempt,
                },
                event_type: 'max_output_recovery_exhausted',
              } as RawResponseStreamEvent;
            }
          } else {
            if (!recovery.tryRetry('max_output')) {
              run.encounteredError = true;
              yield { type: 'error', error: 'Total retry budget exhausted across all categories.' };
              break;
            }
            cliLogger.warn('RUNNER', `Output truncated (finish_reason=length), recovery attempt ${recoveryResult.attempt}/${recoveryResult.maxAttempts}`);

            const anchor = fullContent.slice(-300);
            this.memory.add({
              role: 'user',
              content: `[System: Your previous response was cut off due to max output tokens. Resume **directly** continuing from this exact anchor (last 300 chars of your previous output):

<<<ANCHOR>>>
${anchor}
<<<END ANCHOR>>>

Your next token must continue the sentence/section that ended at <<<END ANCHOR>>>. DO NOT:
- Repeat any content already shown
- Start with "I'll continue" / "我继续" / 任何 meta 开场
- Add a summary or wrap-up of what you already wrote
- Restart from a section header (e.g. "## Summary" / "总结")

Just write the next characters as if your stream wasn't interrupted.]`,
            });

            yield {
              type: 'raw_response_event',
              data: {
                type: 'max_output_recovery',
                attempt: recoveryResult.attempt,
                maxAttempts: recoveryResult.maxAttempts,
              },
              event_type: 'max_output_recovery',
            } as RawResponseStreamEvent;

            run.undoIteration();
            continue;
          }
        } else if (finishReason !== 'length') {
          recovery.onFinishNormal();
        }

        if (finishReason === 'content_filter') {
          cliLogger.warn('RUNNER', `[FINISH] content_filter — 上游过滤/拒答, 正文 ${fullContent.length} 字`);
          yield {
            type: 'error',
            error: '这次回复被上游的内容安全策略截断了 (content_filter / refusal), 后面的内容没有生成。可以换个说法重试, 或换一个模型。',
          };
        }

        if (toolCalls.length > 0) {
          this.reasoningLoopDetector.recordToolCall();
        } else {
          const trimmed = (fullContent || '').trim();
          if (trimmed.length >= 10) {
            const reasoningResult = this.reasoningLoopDetector.checkAndRecord(trimmed);
            if (reasoningResult.forceStop) {
              cliLogger.warn('RUNNER',
                `[Q2] reasoning loop force stop: streak=${reasoningResult.streak} — halting run`);
              run.terminate('reasoning_loop_force_stop');
              yield {
                type: 'error',
                error: `Reasoning loop detected — ${reasoningResult.streak} consecutive turns of pure thinking without any tool action. Halting run.`,
              };
              break;
            } else if (reasoningResult.level !== 'none' && reasoningResult.reminder) {
              cliLogger.info('RUNNER',
                `[Q2] reasoning loop ${reasoningResult.level}: streak=${reasoningResult.streak} → inject reminder to memory`);
              // 顺序追加到对话尾部, 不进 system 块 (appendReminder 自动识别已包裹的 <system-reminder>)
              this.memory.appendReminder(reasoningResult.reminder);
            }
          }
        }

        // Check for tool calls
        if (toolCalls.length > 0) {
          // 有工具调用，重置纯文本连续计数
          progress.onToolBatch();
          this.idleNoToolStreak = 0;

          // ====================================================================
          // Loop detection: use LoopDetector for intelligent detection and guidance
          // ====================================================================

          // 检测占位符字符串（这通常是模型误解数据的信号）
          // Detect placeholder strings (usually indicates model misunderstanding)
          const PLACEHOLDER_PATTERN = /\[omitted\s+\w+:\s*\d+\s*lines?,\s*\d+\s*chars?\]/i;

          for (const tc of toolCalls) {
            const argsStr = tc.function.arguments || '';
            if (PLACEHOLDER_PATTERN.test(argsStr)) {
              cliLogger.warn('Runner', 'Placeholder string detected in tool arguments', {
                tool: tc.function.name,
                argsPreview: argsStr.substring(0, 500),
              });

              // 发出错误事件
              yield {
                type: 'raw_response_event',
                data: {
                  type: 'error.placeholder_detected',
                  message: 'Model generated placeholder string instead of actual content. This usually happens when the model sees truncated data in conversation history.',
                  tool: tc.function.name,
                },
                event_type: 'error.placeholder_detected',
              } as RawResponseStreamEvent;

              yield {
                type: 'error',
                error: 'Error: Model attempted to write placeholder text ("[omitted ...]") instead of actual content. This happens when conversation history contains truncated data. Please start a new conversation.',
              };

              run.encounteredError = true;
              break;
            }
          }

          if (run.encounteredError) {
            break; // 退出主循环
          }

          if (maxToolCalls !== null && run.totalToolCalls + toolCalls.length > maxToolCalls) {
            run.terminate('tool_call_limit');
            yield {
              type: 'error',
              error: `Tool call budget exceeded (max ${maxToolCalls}, requested ${toolCalls.length}). Please summarize progress and ask whether to continue.`,
            };
            break;
          }

          // ====================================================================
          // ====================================================================

          logParallelToolCallSummary(toolCalls);

          /* trace: LLM 这一轮发了几个 tool_call, 哪些 — 后面如果 invoke
             trace 比这少, 就是 mode filter / 参数解析 干掉了一些.
             rawToolCalls 保留完整 args 原文(不截断), 看"LLM 实际发了什么". */
          appendToolTrace({
            phase: 'batch_received',
            callCount: toolCalls.length,
            callIds: toolCalls.map((tc) => tc.id),
            callNames: toolCalls.map((tc) => tc.function?.name || ''),
            rawToolCalls: toolCalls.map((tc) => ({
              id: tc.id,
              type: (tc as any).type,
              name: tc.function?.name || '',
              arguments: tc.function?.arguments || '',
            })),
            assistantTextPreview: clipForToolTrace(fullContent, 800),
            iteration: run.iteration,
            modelName: this.model,
          });

          const parsedArgsByToolId = buildParsedArgsByToolId(toolCalls);
          const toolLifecycleBatch = buildToolCallLifecycleBatch({
            toolCalls,
            parsedArgsByToolId,
          });
          run.addToolCalls(toolLifecycleBatch.toolCallCount);
          for (const event of toolLifecycleBatch.events) {
            yield event;
          }

          // ====================================================================
          //
          // 原先 processLoopDetectionAndInvalidArgs(invalid args + loop)、
          // evaluatePreExecutionPolicy(permission + guardrails + risk)、
          // parallelExecutor.execute(真执行)三段散落检查全部收敛到 orchestrateToolUse。
          // 这里只保留 runner 层独有的 "跨迭代状态机" 能力:
          //   · mode filter(modeStrategy)    — tools 白名单
          // ====================================================================

          let modeAllowedToolNames = new Set(
            applyToolsetFilter(this.modeStrategy.filterTools(this.tools), this.modelProfile, { modelName: this.model }).map(tool => tool.name)
          );
          {
            const registered = this.tools.map(t => t.name);
            for (const tc of toolCalls) {
              const name = tc?.function?.name;
              if (!name || modeAllowedToolNames.has(name)) continue;
              const repair = repairToolName(name, registered);
              if (repair.repaired && repair.name !== name) {
                tc.function.name = repair.name;
              }
            }
          }
          if (this.resolveDeferredTool) {
            const unknown = new Set<string>();
            for (const tc of toolCalls) {
              const name = tc?.function?.name;
              if (name && !modeAllowedToolNames.has(name)) unknown.add(name);
            }
            let unlockedAny = false;
            for (const name of unknown) {
              try {
                if (this.resolveDeferredTool(name)) {
                  unlockedAny = true;
                  cliLogger.info('TOOL_TREE', `auto-unlocked deferred tool on direct call: ${name}`);
                }
              } catch (err: any) {
                cliLogger.debug('TOOL_TREE', `resolveDeferredTool(${name}) threw: ${err?.message}`);
              }
            }
            if (unlockedAny) {
              modeAllowedToolNames = new Set(
                applyToolsetFilter(this.modeStrategy.filterTools(this.tools), this.modelProfile, { modelName: this.model }).map(tool => tool.name)
              );
            }
          }
          const modeFilterResult = applyModeFilterWithEvents({
            toolCalls,
            allowedToolNames: modeAllowedToolNames,
            currentMode: this.currentMode,
            memory: this.memory,
          });
          let executableToolCalls = modeFilterResult.executableToolCalls;
          for (const event of modeFilterResult.events) {
            yield event;
          }

          /* trace: mode filter 把哪些 tool_call 拦下来了. 被拦的 tool 不进
             invokeTool/onOutcome, denialOutput 直接写进 memory 喂给 LLM —
             这就是"工具凭空消失"和"LLM 说失败"的真凶之一 */
          if (modeFilterResult.executableToolCalls.length < toolCalls.length) {
            const executableSet = new Set(modeFilterResult.executableToolCalls.map((tc: any) => tc.id));
            for (const tc of toolCalls) {
              if (executableSet.has(tc.id)) continue;
              appendToolTrace({
                phase: 'filtered',
                toolCallId: tc.id,
                toolName: tc.function?.name || '',
                reason: `mode_blocked (current=${this.currentMode})`,
                denialOutput: `Tool "${tc.function?.name}" is not allowed in ${this.currentMode} mode`,
              });
            }
          }

          {
            const malformedCalls = executableToolCalls.filter(
              (tc) => parsedArgsByToolId.get(tc.id)?.ok === false,
            );
            if (malformedCalls.length > 0) {
              executableToolCalls = executableToolCalls.filter(
                (tc) => parsedArgsByToolId.get(tc.id)?.ok !== false,
              );
              for (const tc of malformedCalls) {
                const parseReason = parsedArgsByToolId.get(tc.id)?.reason || 'parse failed';
                const toolName = tc.function?.name || '';
                const errorOutput =
                  `Tool error: tool call arguments were malformed JSON and could not be repaired`
                  + ` (${parseReason}). The tool was NOT executed. Retry the call with complete, valid JSON arguments.`;
                cliLogger.warn('RUNNER',
                  `[MALFORMED_ARGS] Skipping execution of ${toolName} (${tc.id}) — args JSON unrepairable: ${parseReason}`);
                const [toolOutputEvent, legacyToolOutputEvent] = buildToolOutputEvents({
                  id: tc.id,
                  name: toolName,
                  output: errorOutput,
                  success: false,
                });
                yield toolOutputEvent;
                yield legacyToolOutputEvent;
                this.memory.addToolResult(tc.id, toolName, errorOutput);
                appendToolTrace({
                  phase: 'filtered',
                  toolCallId: tc.id,
                  toolName,
                  reason: `malformed_args (${parseReason})`,
                  denialOutput: errorOutput,
                });
              }
            }
          }

          if (executableToolCalls.length === 0) {
            continue;
          }

          // ── Step 3: 构造并行调用列表(与原 parallelExecutor 协议一致, 保留 ParallelToolCall 结构) ──
          const parallelToolCalls: ParallelToolCall[] = buildParallelToolCalls({
            executableToolCalls,
            parsedArgsByToolId,
          });

          // ── Step 4: 构造统一 ToolUseContext(runner 侧组件挂载) ──
          // runner 路径挂:PermissionManager(含内置 risk) + Guardrails + Loop + ErrorPattern hooks
          // 有人值守 (shouldAutoApprove=false) 不挂 RiskEvaluator —— PermissionManager.checkPermission
          // 内部已调 evaluateToolRisk, high/critical 走 ASK 用户裁决。
          const iterationSnapshot = run.iteration;
          const scopeMode = this.permissionManager.getScopeMode({
            scopeKey: this.sessionId || this.agentName,
          });
          const { autoApprove, attachUnattendedRiskGate } = resolveApprovalPosture({
            scopeMode,
            strategyAutoApprove: this.modeStrategy.shouldAutoApprove(),
          });
          /* 本批次工具共用的转向控制器 (见 activeToolSteeringAbort): 每次工具批次新建一个,
           * 批次结束撤掉 —— 免得下一轮流阶段的转向请求碰到上一批的过期控制器。 */
          this.activeToolSteeringAbort = new AbortController();
          const toolUseCtx: ToolUseContext = {
            tools: this.tools,
            resolveAlias: (name: string) => {
              if (this.tools.some(t => t.name === name)) return name;
              const repair = repairToolName(name, this.tools.map(t => t.name));
              return repair.repaired ? repair.name : null;
            },
            signal: signal ?? new AbortController().signal,
            /* 转向信号: 用户插话时掐工具 (与硬超时同路), 不取消本轮 */
            steeringSignal: this.activeToolSteeringAbort.signal,
            iteration: iterationSnapshot,
            workspacePath: this.workspacePath,
            shouldAutoApprove: autoApprove,

            risk: attachUnattendedRiskGate
              ? {
                  evaluate: (toolName: string, args: Record<string, unknown>) => {
                    const tool = this.tools.find(t => t.name === toolName);
                    const r = evaluateToolRisk({
                      toolName,
                      args: args as Record<string, any>,
                      category: tool?.permission?.category,
                      workspaceRoot: this.workspacePath,
                    });
                    return {
                      level: r.level === 'critical' ? 'critical' : 'low',
                      summary: r.summary,
                    };
                  },
                }
              : undefined,

            /* per-session approval mode: scopeKey 必须给 — orchestrate 路径上
             *   permissionAdapter 是唯一 checkPermission 入口 (executionPolicyOrchestrator.checkPermission
             *   现已是死代码). 不传 scopeKey → PermissionManager.resolveScopeMode(undefined)
             *   永远只命中 globalMode='auto', 用户 setApprovalMode(sessionId, 'dangerous')
             *   存进 ApprovalModeResolver.scopedModes[sessionId] 永远查不到 → "Y 设了仍弹审批". */
            permission: createPermissionAdapter({
              permissionManager: this.permissionManager,
              scopeKey: this.sessionId || this.agentName,
              agentName: this.agentName,
            }),
            inputGuardrails: createGuardrailsAdapter({
              guardrails: DEFAULT_TOOL_INPUT_GUARDRAILS,
              getTool: (toolName) => this.tools.find(t => t.name === toolName),
              agentName: 'main',
            }),
            loopDetector: createLoopAdapter(this.loopDetector),

            /* P2-6: 用户 hooks (settings.json PreToolUse matcher / .neox/hooks/ 脚本) —
             *   pre 可 block, reason 经 preHook stage 回注模型; postSuccess 通知式。 */
            preHooks: this.userToolHooks?.pre ? [this.userToolHooks.pre] : [],
            postSuccessHooks: [
              ...(this.userToolHooks?.postSuccess ? [this.userToolHooks.postSuccess] : []),
              createErrorPatternSuccessHook(this.errorPatternMemory),
              {
                name: 'skillActivation',
                run: async (toolName, args) => {
                  cliLogger.debug('RUNNER', `skillActivation hook: tool=${toolName} conditional=${this.skillActivation?.conditionalCount ?? 'n/a'} ws=${this.workspacePath ?? '-'}`);
                  if (!this.skillActivation || this.skillActivation.conditionalCount === 0) return;
                  const fileTools = new Set(['write_file', 'edit_file', 'readfile', 'read_file', 'glob', 'grep']);
                  if (!fileTools.has(toolName)) return;
                  const a = args as Record<string, any>;
                  const filePath = a.file_path || a.path;
                  if (typeof filePath === 'string' && this.workspacePath) {
                    try {
                      const activated = this.skillActivation.activateForPaths([filePath], this.workspacePath);
                      if (Array.isArray(activated) && activated.length && this.skillActivation.getAutoInjectBody && this.memory.upsertSystemTagged) {
                        for (const name of activated) {
                          const body = this.skillActivation.getAutoInjectBody(name);
                          if (!body) continue;
                          this.memory.upsertSystemTagged(
                            `skill_auto:${name}`,
                            `[Skill "${name}" auto-activated because you touched ${filePath}. Follow these instructions from now on:]\n\n${body}`,
                          );
                          cliLogger.info('RUNNER', `Skill "${name}" auto-injected (${body.length} chars) for ${filePath}`);
                        }
                      }
                    } catch (err: any) {
                      cliLogger.debug('RUNNER', `Skill activation failed: ${err?.message}`);
                    }
                  }
                },
              },
            ],
            postFailureHooks: [
              createErrorPatternFailureHook({
                memory: this.errorPatternMemory,
                getIteration: () => iterationSnapshot,
              }),
            ],

            invokeTool: async (tool, args, invokeSignal, toolCallId) => {
              const invokeStartedAt = Date.now();
              const traceCommon = {
                phase: 'invoke' as const,
                toolName: tool.name,
                toolCallId,
                argsPreview: clipForToolTrace(args, 800),
                hasUiMeta: false,
              };

              /* 上游 Claude 反代 (AccountHub kiro 等) 把"空对象 {} input" 误判成
                 异常, 塞 {_error:"EMPTY_INPUT",_message:"..."} 占位 args 给 Neox.
                 但 Anthropic 协议里 {} 是合法的 (全 optional 参数的工具, 比如
                 git_status / list_directory, 模型可以不传任何参数).
                 这里识别污染后剥掉, 当 {} 跑 — 工具的默认参数会生效:
                   · git_status 默认走 workspace root → 正常返结果
                   · search 等真需要 pattern 的, 工具自己会报"缺参数"清晰错误
                 比"返回 error 让 LLM 重试"更省一轮. */
              if (args && typeof args === 'object' && (args as any)._error === 'EMPTY_INPUT') {
                cliLogger.warn('RUNNER',
                  `[KIRO_GUARD] Stripped upstream EMPTY_INPUT placeholder for tool=${tool.name} — running with {} defaults`);
                args = {};
                traceCommon.argsPreview = clipForToolTrace({ __stripped_empty_input: true }, 800);
              }
              if (invokeSignal.aborted) {
                appendToolTrace({
                  ...traceCommon,
                  rawOutputPreview: '',
                  success: false,
                  durationMs: Date.now() - invokeStartedAt,
                  errorName: 'AbortBeforeStart',
                  errorMsg: 'aborted before invokeTool ran',
                });
                return { output: 'Error: Operation cancelled', success: false };
              }
              try {
                /* K2: 直接读 skillScopeBox.current (跳过 ALS, 我们持有 box 引用).
                 *   limited 模式 + tool 不在 allowedTools → 立即返回 deny, 不真跑 tool.function.
                 *   trusted 模式 / 无 scope → 跳过, 走正常路径. */
                const skillScope = this.skillScopeBox.current;
                if (skillScope && skillScope.trustLevel === 'limited' && !skillScope.allowedTools.includes(tool.name)) {
                  const denyMsg = `Tool "${tool.name}" denied: skill "${skillScope.skillId}" only permits [${skillScope.allowedTools.join(', ') || '<empty>'}]`;
                  cliLogger.warn('RUNNER', `[K2][SKILL_SCOPE] ${denyMsg}`);
                  return { output: `Error: ${denyMsg}`, success: false };
                }

                /* 参数守卫 (缺必填 / 输出撞上限被截断) —— 判据/回执/日志/trace 全在 toolArgsGuard */
                const argsGuardHit = rejectTruncatedToolCall(tool.name, toolCallId, finishReason, toolCalls) ?? rejectMissingRequiredArgs(tool, args, { common: traceCommon, startedAt: invokeStartedAt });
                if (argsGuardHit) return argsGuardHit;

                const trace = this.runTrace;
                const phaseId = trace?.pushPhase('tool', `tool:${tool.name}`, { toolCallId });
                trace?.incToolCalls();
                let output;
                try {
                  /* 包 skillScope ALS — useSkillTool 在内部 setSkillScope() 时写 box.current,
                   *   下次 invokeTool 直接读 this.skillScopeBox.current 拿到刚写的 scope. */
                  output = await runWithRunTrace(trace, () =>
                    runWithSkillScopeBox(this.skillScopeBox, () =>
                      runWithWorkspaceRoot(this.workspacePath, () =>
                        // toolCallId 透传给 tool.function 的 context, 让 tool 的流式事件
                        // (例如 shell_output_stream) 能用 LLM 的真实 ID, 跟 timeline 对齐.
                        tool.function(args, {
                          signal: invokeSignal,
                          shouldYieldToSteering: () => this.steeringGeneration !== iterationSteeringGeneration,
                          toolCallId,
                          sessionId: this.sessionId,
                          checkNestedToolGate: async (wrappedTool, wrappedArgs) => {
                            const g = await runGateStage(wrappedTool, wrappedArgs, toolUseCtx);
                            return g.kind === 'block'
                              ? { allowed: false, reason: g.reason }
                              : { allowed: true };
                          },
                        }),
                      ),
                    ),
                  );
                } finally {
                  if (phaseId !== undefined) trace?.popPhase(phaseId);
                }
                if (invokeSignal.aborted) {
                  appendToolTrace({
                    ...traceCommon,
                    rawOutputPreview: clipForToolTrace(output, 1500),
                    success: false,
                    durationMs: Date.now() - invokeStartedAt,
                    errorName: 'AbortAfterToolReturn',
                    errorMsg: 'signal aborted after tool returned',
                  });
                  return { output: 'Error: Operation cancelled', success: false };
                }
                const selfReported = readToolSelfReportedOutcome(output);
                const succeeded = selfReported ?? true;
                appendToolTrace({
                  ...traceCommon,
                  rawOutputPreview: clipForToolTrace(output, 1500),
                  success: succeeded,
                  durationMs: Date.now() - invokeStartedAt,
                  ...(succeeded ? null : { errorName: 'ToolReportedFailure', errorMsg: 'tool returned a failure outcome without throwing' }),
                });
                return {
                  output: typeof output === 'string' ? output : JSON.stringify(output),
                  success: succeeded,
                };
              } catch (err: any) {
                if (err?.name === 'AbortError' || invokeSignal.aborted) {
                  appendToolTrace({
                    ...traceCommon,
                    rawOutputPreview: '',
                    success: false,
                    durationMs: Date.now() - invokeStartedAt,
                    errorName: err?.name || 'AbortError',
                    errorMsg: err?.message || 'abort',
                  });
                  return { output: 'Error: Operation cancelled', success: false };
                }
                appendToolTrace({
                  ...traceCommon,
                  rawOutputPreview: '',
                  success: false,
                  durationMs: Date.now() - invokeStartedAt,
                  errorName: err?.name || 'Error',
                  errorMsg: err?.message || String(err),
                });
                return { output: `Error: ${err?.message ?? String(err)}`, success: false };
              }
            },
          };

          // ── Step 5: 批次执行 —— runOrchestratedBatch 统一并行分组 / 文件级锁 / 并发限流 ──
          //
          // 本版本相比上一版(pur map+limit 全并发)修复了一个行为退化:当 LLM 一次返回
          // 多个 write_file / edit_file 调用, 现在能正确做"同文件串行、不同文件并发",
          // 与原 ParallelToolExecutor.execute 的 FILE_SCOPED_WRITE_TOOLS 语义对齐。
          //
          // Kimi builtin(__kimi_builtin)不走 orchestrate —— 它的 arguments 本身就是
          // provider 填好的搜索结果, 无需 permission/risk/loop 检查, 直接 pass-through。
          const kimiBuiltinCalls = parallelToolCalls.filter((pc) => (pc as any).__kimi_builtin);
          const orchestrateCalls = parallelToolCalls.filter((pc) => !(pc as any).__kimi_builtin);

          const resultMap = new Map<string, ToolResult>();

          // Kimi builtin 先装入(不跑 orchestrate)
          for (const pc of kimiBuiltinCalls) {
            const kResult: ToolResult = {
              id: pc.id,
              name: pc.function.name,
              output: pc.function.arguments,
              success: true,
              executionTime: 0,
            };
            resultMap.set(pc.id, kResult);
            logToolExecutionResult(kResult);
          }

          const batchResult = await runWithSessionScope(
            { sessionId: this.sessionId, workspaceRoot: this.workspacePath },
            () => runOrchestratedBatch(orchestrateCalls as any, {
            ctx: toolUseCtx,
            workspacePath: this.workspacePath,
            signal: signal,
            logger: {
              debug: (m) => cliLogger.debug('RUNNER', m),
              warn: (m) => cliLogger.warn('RUNNER', m),
            },
            onOutcome(outcome) {
              const finalOutput = outcome.loopAdvisoryMessage
                ? `${outcome.output}\n\n${outcome.loopAdvisoryMessage}`
                : outcome.output;
              const result: ToolResult = {
                id: outcome.toolCallId,
                name: outcome.resolvedToolName ?? outcome.toolName,
                output: finalOutput,
                success: outcome.success,
                executionTime: outcome.totalDurationMs,
                blockedBy: outcome.blockedBy,
                userNotice: outcome.userNotice,
              };
              resultMap.set(outcome.toolCallId, result);
              logToolExecutionResult(result);
              appendToolTrace({
                phase: 'outcome',
                toolName: outcome.resolvedToolName ?? outcome.toolName,
                toolCallId: outcome.toolCallId,
                success: outcome.success,
                blockedBy: outcome.blockedBy as any,
                finalOutputPreview: clipForToolTrace(finalOutput, 2000),
                hasEscalationHint: !!outcome.loopAdvisoryMessage,
                totalDurationMs: outcome.totalDurationMs,
                stageTimings: outcome.stageTimings as any,
              });
            },
          }),
          );

          /* 工具批次结束 → 撤掉转向控制器 (见 activeToolSteeringAbort) */
          this.activeToolSteeringAbort = null;

          /* 安全网: 每个 parallelToolCall 都必须有对应 result. orchestrateToolUse 理论上
           * 永远 return outcome (即便 execute 抛 / abort 也走 block 路径返回结果), 但跨进程
           * 边界、生成器异常、worker 提前退场等极端情况仍可能让 resultMap 缺项 → 之前
           * .filter(Boolean) 直接吞掉, tool_call_start 已发但 tool_call_end 没发, UI 永卡运行中.
           *
           * 现在: 缺项时合成一个 success=false 的占位结果, 保证 yield 一次 tool_output,
           * 让 UI 收敛 (识别为 tool_error 卡, 而不是默默运行 5min). */
          const synthesizeMissingResult = (pc: typeof parallelToolCalls[number]): ToolResult => ({
            id: pc.id,
            name: pc.function?.name ?? 'unknown',
            output: 'Tool execution did not produce a result (orchestrate aborted or crashed before output emission)',
            success: false,
            executionTime: 0,
          });
          const executionResult = {
            results: parallelToolCalls.map((pc) => {
              const r = resultMap.get(pc.id);
              if (r) return r;
              const synthetic = synthesizeMissingResult(pc);
              cliLogger.warn('RUNNER', `[SAFETY_NET] No outcome for toolCall ${pc.id} (${synthetic.name}) — emitting synthetic failure`);
              return synthetic;
            }),
            stats: {
              parallelTime: 0,
              sequentialTime: 0,
              totalTime: batchResult.durationMs,
              timeSaved: 0,
              speedup: 1,
            },
          };

          // HARD loop / critical risk 把 terminate 信号带出来 → 本 iter 完成后 break
          const forceTerminateOuterLoop = batchResult.hasForceTerminate;

          let iterationStats = createIterationStats();

          // Step 3: Emit all tool outputs (保持原始顺序)
          const perIterTokenCap = (this.maxInputTokens ?? 128_000) * 0.6;
          const perIterCharCap = Math.max(8_000, Math.floor(perIterTokenCap * 4)); // 1 token ≈ 4 chars
          let cumulativeOutputChars = 0;

          for (const result of executionResult.results) {
            recordToolMetric(this.toolMetricsHistory, result);

            /* 累加前先看是否需要砍这一条. 砍只发生在 cumulative 已超 cap 且本条 > 2KB
               (太短的 result 直接放过, 砍了反而看不出原 result 是啥). */
            if (cumulativeOutputChars > perIterCharCap
                && typeof result.output === 'string'
                && result.output.length > 2000) {
              const originalLen = result.output.length;
              const headBudget = 1000;
              const tailBudget = 1000;
              result.output = result.output.slice(0, headBudget)
                + `\n\n[... per-iteration tool_results budget exhausted — middle of this result truncated. Original ${originalLen} chars, kept first ${headBudget} + last ${tailBudget}. Re-call the tool with a narrower scope if you need the full output. ...]\n\n`
                + result.output.slice(-tailBudget);
              cliLogger.warn('RUNNER',
                `[PER_ITER_BUDGET] truncated tool=${result.name} from ${originalLen} → ${result.output.length} chars (cumulative ${cumulativeOutputChars} > cap ${perIterCharCap})`);
            }
            cumulativeOutputChars += (result.output || '').length;

            const [toolOutputEvent, legacyToolOutputEvent] = buildToolOutputEvents({
              id: result.id,
              name: result.name,
              output: result.output,
              success: result.success,
              blockedBy: result.blockedBy,
              userNotice: result.userNotice,
            });
            yield toolOutputEvent;
            yield legacyToolOutputEvent;

            const planUpdatePayload = extractPlanUpdatePayload(result, toolCalls);
            if (planUpdatePayload) {
              cliLogger.info('PLAN_UPDATE', '✅ Emitted plan_update event', {
                resultId: result.id,
                toolName: result.name,
                hasExplanation: !!planUpdatePayload.explanation,
                planSteps: planUpdatePayload.plan.length,
              });
              yield buildPlanUpdateEvent(planUpdatePayload);
            }

            /* ---- Post-compact 回灌的三类数据源, 统一在这一个收口点喂 ----
             * 放这里而不是去改 N 个工具: tool-result 只有这一条路, 加工具不会漏,
             * 也不需要 core→kernel 的反向依赖。整段 try 包起来 —— 埋点绝不能影响主流程。 */
            try {
              const parsed = parsedArgsByToolId?.get?.(result.id);
              const rawArgs: Record<string, any> = (parsed?.args ?? {}) as Record<string, any>;

              const realName = result.name === 'call_tool'
                ? String(rawArgs.tool ?? rawArgs.name ?? rawArgs.tool_name ?? result.name)
                : result.name;
              const realArgs: Record<string, any> = result.name === 'call_tool'
                ? ((rawArgs.args ?? rawArgs.arguments ?? rawArgs.input ?? {}) as Record<string, any>)
                : rawArgs;

              /* ① 计划 —— update_plan 走上面已算好的 payload, 白拿 */
              if (planUpdatePayload) {
                trackWorkState('plan', planUpdatePayload.plan.map((s) => ({
                  content: s.step, status: s.status,
                })));
              } else if (realName === 'update_todos' && Array.isArray(realArgs.items)) {
                /* ② 清单 —— extractPlanUpdatePayload 不认 update_todos, 单独从入参取。
                 *    全量替换语义, 跟工具本身一致。 */
                trackWorkState('todo', (realArgs.items as any[]).map((it) => ({
                  content: String(it?.text ?? it?.content ?? ''), status: it?.status,
                })));
              }

              const outText = typeof result.output === 'string' ? result.output : '';
              const softFailed = /^\s*(❌|✗)|\b(error|failed|not found|no such file|exit code [1-9]|ENOENT|EACCES)\b|不存在|失败|错误/i
                .test(outText.slice(0, 400));
              if (!result.success || softFailed) {
                trackToolFailure(realName, outText);
              }

              /* ④ 文件内容 —— 压缩后模型最先失忆的就是它。
               *    路径从入参取(path / file_path 两种别名都有), 内容用 tool output。 */
              if (!softFailed && result.success && /read|edit|write/i.test(realName)) {
                const p = realArgs.path ?? realArgs.file_path ?? realArgs.filePath;
                if (p && outText) trackFileAccess(String(p), outText);
              }

              if (!softFailed && result.success && /^use_skill$/i.test(realName)) {
                const skillName = String(realArgs.skill ?? realArgs.name ?? realArgs.skillId ?? '').trim();
                if (skillName && outText) trackSkillInvocation(skillName, outText);
              }

              cliLogger.debug('RUNNER',
                `[post-compact tracking] tool=${result.name}→${realName} ok=${result.success} soft=${softFailed} state=${JSON.stringify(peekWorkState())}`);
            } catch (err: any) {
              /* 不静默 —— 这三个 tracker 上一次"静默失效"就沉默了几个月(见
               * postCompactReinject 文件头)。埋点仍然不阻断主流程, 但必须留声。 */
              cliLogger.warn('RUNNER',
                `[post-compact tracking] failed for tool=${result.name}: ${err?.message ?? err}`);
            }

            let outputPolicy: Awaited<ReturnType<typeof prepareToolResultForMemory>>;
            try {
              outputPolicy = await prepareToolResultForMemory({
                result,
                toolCalls,
                executableToolCalls,
                parsedArgsByToolId,
                autoVerifyPipeline: this.autoVerifyPipeline,
                extractVerifyFilePath: AutoVerifyPipeline.extractFilePath,
                executionPolicyOrchestrator: this.executionPolicyOrchestrator,
                errorPatternMemory: this.errorPatternMemory,
                toolCallDedup: this.toolCallDedup,
                fileHotspot: this.fileHotspot, // E6: 单文件短窗口高频编辑软提示
                modelMaxInputTokens: this.maxInputTokens, // R3: 动态截断按模型 context window
              });
            } catch (err: any) {
              cliLogger.error('RUNNER',
                `[P0-B fallback] prepareToolResultForMemory threw for tool=${result.name} id=${result.id}: ${err?.message ?? err}. Writing minimal tool result to memory to prevent phantom retry.`);
              try {
                this.memory.addToolResult(
                  result.id,
                  result.name,
                  typeof result.output === 'string' ? result.output : String(result.output ?? ''),
                );
              } catch (memErr: any) {
                cliLogger.error('RUNNER',
                  `[P0-B fallback] minimal memory.addToolResult also threw: ${memErr?.message ?? memErr}. Tool result truly lost.`);
              }
              outputPolicy = { shouldBreak: false, encounteredError: false } as any;
            }

            if (outputPolicy.shouldBreak) {
              if (process.env.CLI_DEBUG_CONSOLE === '1') {
                console.log('[Runner] Detected cancellation in tool output, breaking loop');
              }
              run.encounteredError = run.encounteredError || outputPolicy.encounteredError;
              break;
            }

            if (outputPolicy.dedupForceStop) {
              cliLogger.warn('RUNNER',
                `[F1] Tool call dedup force stop triggered for ${result.name} — halting run`);
              run.terminate('tool_dedup_force_stop');
              break;
            }

            try {
              iterationStats = finalizeToolResultAndTracking({
                result,
                outputPolicy,
                runContext: this.runContext,
                memory: this.memory,
                iteration: run.iteration,
                recentToolOutcomes,
                iterationStats,
                executableToolCalls,
                parsedArgsByToolId,
                toolUsageAdvisor: this.toolUsageAdvisor,
              });
            } catch (err: any) {
              cliLogger.error('RUNNER',
                `[P0-B fallback] finalizeToolResultAndTracking threw for tool=${result.name}: ${err?.message ?? err}. Skipping tracking update.`);
            }

            if (result.success) {
              if (isMutationTool(result.name)) this.runMutationCount++;
              else if (result.name === 'run_tests' || result.name === 'run_lint') this.ranVerifyTool = true;
            }

            if (result.name === 'readfile' && result.success && result.output) {
              // 只保留最后一个 readfile 的内容（多个 readfile 只用最后一个）
              pendingPrediction = { type: 'content', content: result.output };
              if (process.env.CLI_DEBUG === '1') {
                cliLogger.debug('PREDICTION', `Captured readfile output for prediction: ${result.output.length} chars`);
              }
            }
          }

          if (forceTerminateOuterLoop) { wrapUpTurn = beginWrapUp(this.memory); continue; }


          recovery.lastTransitionReason = 'next_turn';

          // 原因：
          // 1. 生成了摘要但从未替换到 messages — 纯浪费 API 调用
          // 2. 即使替换，也会破坏 prompt 前缀缓存（每次替换都导致 cache miss）
          // 3. mini 模型可能不可用（503 重试 14 次 × 30s = 7 分钟阻塞）
          //
          // 正确做法：摘要在 autocompact 触发时统一生成（context 压力达阈值时），
          // 不在每次工具调用后 fire-and-forget。
          // autocompact 路径已在 compactor.ts / microCompact.ts 中处理。
          //
          // 如果未来要恢复，需要：
          // (a) 实际替换 messages 里的 tool result
          // (b) 确保替换不破坏缓存（只在 compaction 时批量替换）
          // (c) summary 请求计入 tokenUsageService 统计

          // 定义以来就没有任何工具实际设置 contextModifier 字段, 是死代码。如果未来
          // 需要"cwd_change / env_change"广播, 改为从 orchestrate 的 TelemetrySink
          // 收集 outcome 里的 metadata 后统一 yield, 不再走 ToolResult 内嵌字段这条
          // 幽灵路径。

          injectIterationAdvisories({
            iteration: run.iteration,
            toolMetricsHistory: this.toolMetricsHistory,
            memory: this.memory,
            toolUsageAdvisor: this.toolUsageAdvisor,
          });

          if (enableProgressGate) {
            const progressGateResult = applyIterationProgressGate({
              iteration: run.iteration,
              taskIntent: taskRequirements.intent,
              requireMutation: taskRequirements.requireMutation,
              requireToolEvidence: taskRequirements.requireToolEvidence,
              iterationStats,
              lowProgressStreak: progress.lowProgressStreak,
              completionEvidenceNudges: progress.completionEvidenceNudges,
              recentToolOutcomes,
              memory: this.memory,
            });
            progress.applyProgressGate(progressGateResult);
            if (progressGateResult.event) {
              loopWasteStats.progressGateTriggers++;
              yield progressGateResult.event;
            }
          } else {
            progress.resetProgressGate();
          }

          // Step 4: Emit performance stats (optional, for debugging)
          if (process.env.CLI_DEBUG_CONSOLE === '1' && executionResult.stats) {
            yield buildParallelExecutionStatsEvent(executionResult.stats);
          }

          if (signal?.aborted) {
            run.terminate('interrupted');
            yield { type: 'error', error: 'Task interrupted by user.' };
            break;
          }

          // Continue loop to let LLM process tool results
          loopWasteStats.toolResultFollowups++;
          continue;
        } else {
          if (wrapUpTurn) { const ev = finishWrapUpTurn(run, fullContent); if (ev) yield ev; break; }
          const emptyFinalOutputRecovery = handleEmptyFinalOutputRecovery({
            fullContent,
            finishReason,
            textOnlyStreakCount: progress.textOnlyStreakCount,
            totalToolCalls: run.totalToolCalls,
            modelProfileId: this.modelProfile?.id,
            memory: this.memory,
          });
          progress.textOnlyStreakCount = emptyFinalOutputRecovery.textOnlyStreakCount;
          if (emptyFinalOutputRecovery.event) {
            yield emptyFinalOutputRecovery.event;
          }
          if (emptyFinalOutputRecovery.shouldContinue) {
            loopWasteStats.noToolGuardFollowups++;
            loopWasteStats.noToolReasons.empty_final_output++;
            recovery.lastTransitionReason = 'empty_final_output_recovery';
            if (progress.consumeNoToolBudget('empty_final_output')) {
              run.finalOutput = fullContent || run.finalOutput;
              break;
            }
            continue;
          }

          if (enablePlannerAutoFollowup) {
            const plannerFollowup = maybeApplyPlannerAutoFollowup({
              plannerMode: this.plannerMode,
              fullContent,
              planAutoFollowups: run.planAutoFollowups,
              memory: this.memory,
            });
            run.planAutoFollowups = plannerFollowup.planAutoFollowups;
            if (plannerFollowup.event) {
              yield plannerFollowup.event;
            }
            if (plannerFollowup.shouldContinue) {
              loopWasteStats.plannerAutoFollowups++;
              if (progress.consumeNoToolBudget('planner_auto_followup')) {
                run.finalOutput = fullContent || run.finalOutput;
                break;
              }
              continue;
            }
          }

          this.idleNoToolStreak++;
          const idleHardStopAt = Number(process.env.NEOX_IDLE_NO_TOOL_HARD_STOP) || 5;
          if (this.runMutationCount > 0 && this.idleNoToolStreak >= idleHardStopAt) {
            const zh = `连续 ${this.idleNoToolStreak} 轮没有任何工具调用 —— 已停止本轮，避免继续空转。`
              + `本轮共改动 ${this.runMutationCount} 次文件；如果任务没做完，请直接告诉我下一步。`;
            cliLogger.warn('RUNNER',
              `[idle-hard-stop] ${this.idleNoToolStreak} consecutive no-tool iterations after ${this.runMutationCount} mutation(s) — terminating run`);
            try {
              const { writeStallFile } = await import('../utils/stallGuard.js');
              writeStallFile('warn', 'RUNNER', 'idle no-tool hard stop', {
                reason: 'idle_no_tool_hard_stop',
                idleStreak: this.idleNoToolStreak,
                runMutationCount: this.runMutationCount,
                iteration: run.iteration,
                sessionId: this.sessionId ?? null,
              });
            } catch { /* 诊断写盘失败不影响主流程 */ }
            run.finalOutput = fullContent;
            run.terminate('idle_no_tool_hard_stop');
            yield { type: 'error', error: zh };
            break;
          }

          const completionProfile = getCompletionProfile(this.modelProfile);
          const noToolFollowup = handleNoToolGuardAndRepair({
            fullContent,
            completionProfile,
            registeredToolNames,
            finishReason,
            textOnlyStreakCount: progress.textOnlyStreakCount,
            totalToolCalls: run.totalToolCalls,
            modelProfileId: this.modelProfile?.id,
            repairTracker,
            iteration: run.iteration,
            memory: this.memory,
          });
          progress.textOnlyStreakCount = noToolFollowup.textOnlyStreakCount;
          if (noToolFollowup.event) {
            yield noToolFollowup.event;
          }
          if (noToolFollowup.shouldContinue) {
            loopWasteStats.noToolGuardFollowups++;
            bumpNoToolReason(noToolFollowup.reason);
            if (progress.consumeNoToolBudget(`noToolGuard(${noToolFollowup.reason})`)) {
              run.finalOutput = fullContent || run.finalOutput;
              break;
            }
            continue;
          }

          const noToolFinalizeResult = await finalizeNoToolResponse({
            fullContent,
            finishReason,
            toolCallCount: toolCalls.length,
            totalToolCalls: run.totalToolCalls,
            iteration: run.iteration,
            textOnlyStreakCount: progress.textOnlyStreakCount,
            structuredValidator: this.structuredValidator,
            structuredOutputName: this.structuredOutput?.name,
            outputGuardrails: this.outputGuardrails,
            context,
            agentName: this.agentName,
            memory: this.memory,
          });
          for (const event of noToolFinalizeResult.events) {
            yield event;
          }
          if (noToolFinalizeResult.shouldContinue) {
            loopWasteStats.noToolFinalizeContinues++;
            run.finalOutput = noToolFinalizeResult.finalOutput;
            if (progress.consumeStructuredRetryBudget()) {
              break;
            }
            continue;
          }
          run.finalOutput = noToolFinalizeResult.finalOutput;


          //   target 激活且未确认完成时, gate 会返回 shouldContinue=true, 并给出一条 system 提醒消息.
          //   我们注入 memory + continue, 让 model 下一轮继续动手或调 check_target_done.
          //   consecutiveContinuationBlocks 传给 gate 让 core 层做 3 次兜底放行 (避免死循环).
          if (this.loopContinuationGate) {
            try {
              const decision = await this.loopContinuationGate({
                reason: 'no_tool_exit',
                iteration: run.iteration,
                consecutiveBlocks: this.consecutiveContinuationBlocks,
                runMutationCount: this.runMutationCount,
                ranVerifyTool: this.ranVerifyTool,
                task: this.runContext?.task ?? '',
                finalText: typeof run.finalOutput === 'string' ? run.finalOutput : '',
                totalToolCalls: run.totalToolCalls,
              });
              if (decision.shouldContinue) {
                this.consecutiveContinuationBlocks++;
                if (decision.message) {
                  this.memory.appendReminder(decision.message);
                }
                loopWasteStats.noToolGuardFollowups++;
                /* 桌面 timeline 分隔线 + stall 可观测: Target 闸门拦住了本该交给用户的 no-tool 退出. */
                yield buildTargetContinuationEvent({
                  iteration: run.iteration,
                  consecutiveBlocks: this.consecutiveContinuationBlocks,
                  kind: decision.kind ?? 'target',
                });
                try {
                  const { writeStallFile } = await import('../utils/stallGuard.js');
                  writeStallFile('info', 'TARGET', 'loopContinuationGate blocked no-tool exit', {
                    reason: 'target_gate_continue',
                    consecutiveBlocks: this.consecutiveContinuationBlocks,
                    iteration: run.iteration,
                  });
                } catch { /* 诊断写盘失败不影响主流程 */ }
                cliLogger.debug(
                  'RUNNER',
                  `loopContinuationGate blocked no-tool exit (consecutive=${this.consecutiveContinuationBlocks})`,
                );
                continue;
              }
            } catch (err: any) {
              cliLogger.debug('RUNNER', `loopContinuationGate failed: ${err?.message}`);
            }
          }
          // gate 未阻止 → 正常退出, 重置计数
          this.consecutiveContinuationBlocks = 0;
          break;
        }
      } catch (error: any) {
        this.clearActiveStreamAbort();

        // Handle stream_retry events from LLM provider
        if (error?.type === 'stream_retry') {
          // This is a retry event from the provider, yield it and continue
          recovery.providerManagedRetryObserved = true;
          yield error as StreamRetryStreamEvent;
          continue;
        }

        /* CANCELED 要有取消的证据 —— 没人按停就不许说成"用户中断"。见 reclassifyFalseCancel。 */
        const classifiedError = reclassifyFalseCancel(classifyRunnerError(error), {
          aborted: signal?.aborted === true,
          steering: this.steeringInterruptRequested,
        });
        logClassifiedErrorToConsole(classifiedError);
        cliLogger.warn(
          'RUNNER',
          'Stream Error Diagnostic',
          buildStreamErrorDiagnostic(
            classifiedError,
            recovery.streamRetries,
            maxStreamRetries,
            recovery.providerManagedRetryObserved,
            run.iteration,
          ),
        );
        try {
          const { writeStallFile } = await import('../utils/stallGuard.js');
          writeStallFile('warn', 'RUNNER', 'stream error / interrupt', {
            reason: 'stream_error',
            category: String(classifiedError?.category ?? 'unknown'),
            message: String(classifiedError?.message ?? '').slice(0, 200),
            iteration: run.iteration,
            streamRetries: recovery.streamRetries,
          });
        } catch { /* 诊断写盘失败不影响主流程 */ }

        /* Q3: stream 中断 → tracker.markInterrupted, partial 保留供 retry path 用 prefill 续接.
         *   reason 根据 classifiedError 分类, 后续诊断用. */
        let q3Reason: InterruptReason = 'unknown';
        if (classifiedError.category === ErrorCategory.CANCELED) q3Reason = 'abort_signal';
        else if (classifiedError.category === ErrorCategory.RETRYABLE_STREAM) q3Reason = 'watchdog_timeout';
        else if (classifiedError.category === ErrorCategory.RETRYABLE_NETWORK) q3Reason = 'network_error';
        this.streamPartialTracker.markInterrupted(q3Reason);

        // ================================================================
        // 检测 context 溢出，先压缩再重试，而不是直接 halt
        // ================================================================
        const isPromptTooLong = classifiedError.category === ErrorCategory.FATAL_CONTEXT
          || classifiedError.message?.toLowerCase().includes('prompt is too long')
          || classifiedError.message?.toLowerCase().includes('context length exceeded')
          || classifiedError.message?.toLowerCase().includes('maximum context length');

        if (isPromptTooLong && this.maxInputTokens && recovery.tryRecoveryCompact() && recovery.tryRetry('recovery_compact')) {
          cliLogger.warn('RUNNER',
            `Prompt too long detected, attempting recovery compression (attempt ${recovery.getRecoveryCompactAttempts()})`);

          /* D6 phase: 看门狗能识别"卡在 recover phase >20s" 了 */
          const recoveryAttempt = recovery.getRecoveryCompactAttempts();
          const recoverPhaseId = runTrace.pushPhase(RunPhase.Recover, 'recover:prompt_too_long', {
            attempt: recoveryAttempt,
          });
          const targetRatio = Math.max(0.25, 0.55 - (recoveryAttempt - 1) * 0.15);
          const compressionTarget = Math.floor(this.maxInputTokens * targetRatio);
          const recoveryBefore = this.memory.getMessagesForLLM();
          let recoveryResult;
          try {
            // 强制压缩（不受 threshold 限制）
            recoveryResult = await compressContextWindow({
              maxInputTokens: compressionTarget,
              iteration: run.iteration,
              memory: this.memory,
              unifiedCompressor: this.unifiedCompressor,
              compressionMode: this.compressionMode,
              model: this.model,
              sessionId: this.sessionId,
              trigger: 'recovery',
              /* prompt_too_long 恢复路径 — 清掉陈旧 tool result 正是这里最该做的事 */
              maxTurnAge: AUTO_COMPACT_MAX_TURN_AGE,
              logInfo: (message) => cliLogger.info('Context', message),
              logDebug: (message) => cliLogger.debug('Context', message),
              tokenCalibration: { measured: this.measuredPromptTokens, estimateAtMeasurement: this.estimateAtMeasurement },
              fixedOverheadSample: this.sessionMinFixedOverhead,
            });
          } finally {
            runTrace.popPhase(recoverPhaseId);
          }

          if (recoveryResult) {
            await this.notifyHistoryCompacted({
              evictedReadPaths: findEvictedReadPaths(recoveryBefore, this.memory.getMessagesForLLM()),
            });
          }

          const compressedToTarget = recoveryResult
            && recoveryResult.compressedTokens > 0
            && recoveryResult.compressedTokens < compressionTarget;
          const hadCompactAction = recoveryResult
            && (recoveryResult.stats.droppedMessages > 0 || recoveryResult.stats.llmCompressedMessages > 0);
          if (compressedToTarget && hadCompactAction && recoveryResult) {
            recovery.lastTransitionReason = 'prompt_too_long_recovery';
            const rr = recoveryResult; // TS narrow
            cliLogger.info('RUNNER', `Recovery compression succeeded: ${rr.originalTokens} → ${rr.compressedTokens} tokens`);
            yield {
              type: 'raw_response_event',
              data: {
                type: 'prompt_too_long_recovery',
                originalTokens: rr.originalTokens,
                compressedTokens: rr.compressedTokens,
                savedTokens: rr.savedTokens,
              },
              event_type: 'prompt_too_long_recovery',
            } as RawResponseStreamEvent;

            yield {
              type: 'context_compaction',
              status: 'completed',
              originalMessages: rr.originalCount,
              keptMessages: rr.messages.length,
              droppedMessages: rr.stats.droppedMessages,
              compressedMessages: rr.stats.llmCompressedMessages,
              /* UI 数字过校准, 见 auto-compact completed 处的注释 (裸估算 vs 真 token 口径) */
              originalTokens: this.calibrateContextTokens(rr.originalTokens),
              finalTokens: this.calibrateContextTokens(rr.compressedTokens),
              budgetTokens: this.maxInputTokens || 0,
              useLLM: rr.stats.llmCompressedMessages > 0,
              timestamp: Date.now(),
            };

            run.undoIteration();
            continue;  // 压缩后重试
          }
          cliLogger.warn('RUNNER', 'Recovery compression failed to free enough tokens');
        }

        if (classifiedError.category === ErrorCategory.CANCELED) {
          if (this.steeringInterruptRequested && !signal?.aborted) {
            this.steeringInterruptRequested = false;
            if (lastPartialContent.trim().length > 0) {
              this.memory.add({
                role: 'assistant',
                content: closeFencedBlocks(lastPartialContent).trimEnd() + '\n\n[response interrupted: user sent a new message]',
              });
            }
            lastPartialContent = '';
            recovery.lastTransitionReason = 'steering_interrupt';
            yield {
              type: 'raw_response_event',
              data: { type: 'steering_interrupt' },
              event_type: 'steering_interrupt',
            } as RawResponseStreamEvent;
            continue;
          }

          lastPartialContent = handleInterruptedPartialContent({
            lastPartialContent,
            persistAssistantContent: (content) => {
              this.memory.add({ role: 'assistant', content });
            },
            logInfo: (message) => cliLogger.info('RUNNER', message),
          });
          run.terminate('interrupted');
          yield { type: 'error', error: 'Task interrupted by user.' };
          break;
        }

        const retryDecision = this.executionPolicyOrchestrator.decideRetry({
          classifiedError,
          streamRetries: recovery.streamRetries,
          maxStreamRetries,
          providerManagedRetryObserved: recovery.providerManagedRetryObserved,
        });
        if (retryDecision) {
          const isRateLimitRetry = classifiedError.category === ErrorCategory.RETRYABLE_RATE_LIMIT;
          if (isRateLimitRetry ? !recovery.tryRateLimitRetry() : !recovery.tryRetry('stream')) {
            run.encounteredError = true;
            yield {
              type: 'error',
              error: isRateLimitRetry
                ? 'Rate-limit retry budget exhausted.'
                : 'Total retry budget exhausted across all categories.',
            };
            break;
          }
          recovery.streamRetries = retryDecision.nextStreamRetries;
          cliLogger.warn('RUNNER', retryDecision.logMessage);
          const partialBeforeRetry = lastPartialContent; // 界面要作废哪些, 见 streamRetryDiscard.ts
          /* Q3 prefill 续接: 决定重试且 provider 支持 prefill 时, 把已收到的 partial 作为
           *   assistant message append 到 memory. 下次 chatStreamed 看到 messages 末尾的
           *   assistant 内容 → LLM 自动从这里 continue, 不重新生成已收 token.
           *   仅在 Anthropic / DeepSeek 启用 (这些 provider 协议明确支持 messages 末尾
           *   assistant prefill 续写). 其他 provider 会把它当历史回复重发新内容,
           *   浪费 token 但不破坏 — 安全 fallback. */
          const prefillProviderKey = this.modelProfile?.sourceProfileIds?.find(
            (id) => id === 'anthropic' || id === 'deepseek',
          );
          if (
            this.streamPartialTracker.wasInterrupted() &&
            providerSupportsPrefill(prefillProviderKey, this.modelProfile?.id ?? this.model)
          ) {
            const partial = this.streamPartialTracker.getPartial();
            if (shouldUsePrefillContinuation(partial)) {
              cliLogger.info('RUNNER',
                `[Q3] prefill continuation: model=${this.modelProfile?.id ?? this.model}, partial=${partial.length} chars, reason=${this.streamPartialTracker.snapshot().interruptReason}`);
              this.memory.add({ role: 'assistant', content: partial });
              lastPartialContent = ''; // 已经写进 memory 作 prefill, 清避免重复
              this.streamPartialTracker.reset();
            }
          }
          yield withRetryDiscard(retryDecision.event as RawResponseStreamEvent, partialBeforeRetry, partialBeforeRetry.length > 0 && lastPartialContent === '');
          lastPartialContent = '';

          /* 等待后重试 — 用可中断 sleep: 限流退避最长 60s, 用户此间点停止不该
           * 干等到底。abort 时提前 resolve → continue → 循环顶部 signal 检查
           * 走正常 interrupted 收尾 (保存 partial + yield error + break)。 */
          await interruptibleSleep(retryDecision.delayMs, signal);

          // 避免因为重试而消耗迭代次数
          run.undoIteration();
          continue;
        }

        // ================================================================
        // 当重试用尽且错误是流相关时，尝试用 summary model 降级执行
        // ================================================================
        const isStreamError = classifiedError.category === ErrorCategory.RETRYABLE_STREAM
          || classifiedError.category === ErrorCategory.RETRYABLE_NETWORK;
        /* Why: 没 model 时不该走 fallback (上层会有 default-model 兜底), 显式 guard 避免
         * 旧实现里 getSummaryModel(undefined) 抛 TypeError 让 runner 整体崩溃. */
        const fallbackModel = this.model ? getSummaryModel(this.model) : undefined;
        const fallbackIsHosted = !this.providerModelNames?.length
          || !!fallbackModel && this.providerModelNames.includes(fallbackModel);
        if (isStreamError && fallbackModel && fallbackModel !== this.model && !fallbackIsHosted) {
          cliLogger.warn('RUNNER',
            `[fallback-skip] ${this.model} 流失败, 但降级目标 ${fallbackModel} 不在该服务商托管的模型里 `
            + `(${this.providerModelNames?.length ?? 0} 个), 不降级 — 降过去只会连环 404`);
        }
        const canFallback = isStreamError
          && !!this.model
          && !!fallbackModel
          && fallbackModel !== this.model
          && fallbackIsHosted
          && recovery.canFallback();

        if (canFallback) {
          if (!recovery.tryRetry('model_fallback')) {
            run.encounteredError = true;
            yield { type: 'error', error: 'Total retry budget exhausted across all categories.' };
            break;
          }
          const originalModel = this.model;
          this.model = fallbackModel!;
          this.unifiedCompressor.setLLMProvider(this.llmProvider, this.model);
          recovery.lastTransitionReason = 'streaming_fallback';
          cliLogger.warn('RUNNER', `Stream error with ${originalModel}, falling back to ${fallbackModel}`);

          yield {
            type: 'raw_response_event',
            data: {
              type: 'model_fallback',
              originalModel,
              fallbackModel,
              reason: classifiedError.message,
            },
            event_type: 'model_fallback',
          } as RawResponseStreamEvent;

          // 清理部分内容
          if (lastPartialContent.length > 0) {
            this.memory.add({ role: 'assistant', content: lastPartialContent.trimEnd() });
            lastPartialContent = '';
          }

          run.undoIteration();  // 不消耗迭代，但不允许下溢
          continue;
        }

        run.encounteredError = true;

        const terminalPartial = closeFencedBlocks(lastPartialContent).trimEnd();
        const resumableFromPartial = shouldUsePrefillContinuation(terminalPartial);
        if (resumableFromPartial) {
          this.memory.add({ role: 'assistant', content: terminalPartial });
          lastPartialContent = '';
          this.streamPartialTracker.reset();
          cliLogger.info('RUNNER',
            `[continue] 终态错误前保住 partial ${terminalPartial.length} 字符 — 续跑可从断点接着写`);
        }

        const { suggestion, friendlyMessage } = buildFriendlyRunnerError(
          classifiedError,
          this.providerName,
        );
        logger.agentError(friendlyMessage);

        // Emit detailed error event
        yield {
          type: 'raw_response_event',
          data: {
            type: 'error.classified',
            category: classifiedError.category,
            code: classifiedError.code,
            message: classifiedError.message,
            retryable: classifiedError.retryable,
            suggestion,
            context: classifiedError.context,
            /* UI 据此把主按钮从"重试"换成"继续" —— 有断点才谈得上续写 */
            resumable: resumableFromPartial,
            partialChars: resumableFromPartial ? terminalPartial.length : 0,
          },
          event_type: 'error.classified',
        } as RawResponseStreamEvent;

        yield {
          type: 'error',
          error: friendlyMessage,
          /* code 必须跟着走 —— 上面那条 error.classified 里明明有它, 而 UI 真正
           * 用来选文案的是 type:'error' 这一条。不带的话渲染层只能显示通用
           * RUNTIME_ERROR, 那张按 code 写的错误文案表整张作废。 */
          code: classifiedError.code,
        };
        break;
      }
    }

    if (!run.encounteredError && !isUnlimited && run.iteration >= maxIter && !run.finalOutput) {
      run.stopReason = run.stopReason || 'iteration_limit';
      run.encounteredError = true;
      yield {
        type: 'error',
        error: `Reached max iterations (${maxIter}). Please summarize progress and ask whether to continue.`,
      };
    }

    if (!run.encounteredError) {
      logger.agentComplete(run.iteration, run.totalToolCalls, run.finalUsageStats);
      cliLogger.info('LLM', `Complete: iterations=${run.iteration}, toolCalls=${run.totalToolCalls}, tokens=${run.finalUsageStats.totalTokens} (prompt=${run.finalUsageStats.promptTokens}, completion=${run.finalUsageStats.completionTokens})`);
    }

    const recoverySnap = recovery.snapshot();
    logRunCompletion({
      iteration: run.iteration,
      totalToolCalls: run.totalToolCalls,
      encounteredError: run.encounteredError,
      textOnlyStreakCount: progress.textOnlyStreakCount,
      completionEvidenceNudges: progress.completionEvidenceNudges,
      taskIntent: taskRequirements.intent,
      streamRetries: recoverySnap.streamRetries,
      stopReason: run.stopReason,
    });

    const candidateWasteLoops =
      loopWasteStats.plannerAutoFollowups +
      loopWasteStats.noToolGuardFollowups +
      loopWasteStats.noToolFinalizeContinues +
      loopWasteStats.progressGateTriggers;
    const candidateWasteRatio = run.iteration > 0
      ? Number((candidateWasteLoops / run.iteration).toFixed(3))
      : 0;
    const wasteLevel = candidateWasteRatio >= 0.5
      ? 'high'
      : candidateWasteRatio >= 0.25
        ? 'medium'
        : 'low';
    const loopWasteSummary = {
      modelProfile: this.modelProfile?.id ?? 'unknown',
      loopStrategy: loopProfile.strategy ?? 'balanced',
      iterations: run.iteration,
      totalToolCalls: run.totalToolCalls,
      toolResultFollowups: loopWasteStats.toolResultFollowups,
      candidateWasteLoops,
      candidateWasteRatio,
      wasteLevel,
      breakdown: {
        plannerAutoFollowups: loopWasteStats.plannerAutoFollowups,
        noToolGuardFollowups: loopWasteStats.noToolGuardFollowups,
        noToolFinalizeContinues: loopWasteStats.noToolFinalizeContinues,
        progressGateTriggers: loopWasteStats.progressGateTriggers,
        noToolReasons: loopWasteStats.noToolReasons,
      },
      streamRetries: recoverySnap.streamRetries,
      stopReason: run.stopReason,
      encounteredError: run.encounteredError,
      lastTransitionReason: recoverySnap.lastTransitionReason,
      maxOutputRecoveryCount: recoverySnap.maxOutputRecoveryCount,
      diminishingReturnStreak: recoverySnap.diminishingReturnStreak,
    };
    if (process.env.CLI_DEBUG === '1') {
      cliLogger.info('LOOP_WASTE', 'Summary', loopWasteSummary);
    }
    yield buildLoopWasteSummaryEvent(loopWasteSummary);

    endRun(runTrace, run.stopReason);
    this.runTrace = null;

    yield {
      type: 'run_done',
    };

    if (process.env.CLI_DEBUG === '1') {
      cliLogger.debug('RUNNER', '=== runner.run END (run_done yielded) ===');
    }
    } finally {
      try { endRun(runTrace); } catch { /* dead */ }
      this.runTrace = null;
      try { if (this.pauseGate?.isPaused()) this.pauseGate.cancel?.(); } catch { /* 清理失败不影响收尾 */ }
      /* streaming fallback 只救本轮 — 还原入口模型, 防止降级跨 turn 永久生效 (见 run 入口注释) */
      if (this.model !== modelAtRunStart) {
        cliLogger.info('RUNNER',
          `[FALLBACK_RESTORE] model restored ${this.model} → ${modelAtRunStart} at run end (fallback was run-scoped)`);
        this.model = modelAtRunStart;
        /* 还原时同样要同步, 否则压缩器停在降级模型上 */
        this.unifiedCompressor.setLLMProvider(this.llmProvider, this.model);
      }
    }
  }

}
