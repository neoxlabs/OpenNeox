/**
 * @openneox/kernel — 公共入口
 *
 * provider-agnostic agent 引擎。StreamedRunner(流式执行循环)+ 工具派发协议 +
 * context 压缩 + 权限钩子 + 模型 profile + 核心类型。零 Neox 假设。
 * (Phase 3 整批搬家已落地; 见 docs/NEOX_KERNEL_EXTRACTION_DESIGN.md)
 *
 * 也可深 import: `@openneox/kernel/core/runner.js` 等(package.json exports 通配)。
 */

// ── 执行引擎 ──
export { StreamedRunner } from './core/runner.js';
export type { ToolApprovalRequest, ToolApprovalHandler } from './core/runner.js';

// ── 模式 / 权限 ──
export { AgentMode } from './types/permissions.js';
export { PermissionManager } from './core/permissions/index.js';
export { applyDefaultToolPermissions } from './core/permissions/defaultPermissions.js';
export type { ApprovalRequest, ApprovalResult } from './core/permissions/index.js';

// ── 核心类型 ──
export type {
  LLMProvider,
  Message,
  Tool,
  ToolCall,
  AgentConfig,
  Instructions,
  StructuredOutputDefinition,
  StreamEvent,
} from './types/index.js';

// ── Provider(HTTP 调模型; 第三方 new OpenAIProvider({baseUrl, apiKey}) 直连)──
export { OpenAIProvider } from './models/openai.js';
export { OpenAICompatibleClient } from './models/openaiCompatibleClient.js';
export { AnthropicProvider } from './models/anthropic.js';
export { setExternalHmacSigner, type AutoHmacSigner } from './models/openai.js';
export { setNeoxSessionProvider, type NeoxSessionProvider } from './models/neoxSessionHeader.js';
export { setInstructionsBuilder, buildKernelInstructions, type KernelInstructionsOpts } from './core/instructionsBridge.js';

// ── 短期记忆(纯内存对话窗口)──
export { ShortTermMemory } from './memory/shortterm.js';

// ── 模型 profile ──
export { resolveBuiltinModelProfile } from './profiles/index.js';
export type { ResolvedModelProfile } from './profiles/index.js';

// ── Sandbox mode (权限范围三档)──
// READ_ONLY / WORKSPACE_WRITE / DANGER_FULL_ACCESS. 跟 AgentMode 正交.
// 接入: evaluateToolRisk 读 sandboxMode 后, READ_ONLY 下非 READ 类工具被 critical signal 拦.
// 调用方: setCurrentSandboxMode(mode) → CLI/UI 切换; getCurrentSandboxMode() → prompt 注入.
export {
  SandboxMode,
  DEFAULT_SANDBOX_MODE,
  getCurrentSandboxMode,
  setCurrentSandboxMode,
  resetSandboxMode,
  onSandboxModeChange,
  isCategoryBlockedBySandbox,
} from './core/sandboxMode.js';

// ── Session scope (会话隔离的唯一入口) ──
// 服务端只有一个 runtime, 所有会话复用它 —— "当前是哪个会话"必须由上下文携带。
// 宿主职责只有两件: 每轮包一层 runWithSessionScope; 会话淘汰时 disposeSessionScope。
// 需要按会话隔离的新状态一律用 createSessionScopedStore, 别再写 module-level let。
export {
  runWithSessionScope,
  getSessionScope,
  currentSessionScopeId,
  currentSessionWorkspaceRoot,
  createSessionScopedStore,
  disposeSessionScope,
  SessionScopedStore,
  DEFAULT_SESSION_SCOPE,
  type SessionScope,
  type SessionScopedStoreOptions,
} from './core/sessionScope.js';

// ── 宿主能力开关 (插件 manifest 的 capabilities → 工具装配) ──
// 写的人是 desktop 的插件管理器, 读的人是 core 的工具装配。目前唯一消费者是 computer-use:
// OS 级操作默认不进 toolMap, 装了插件才点亮。
export {
  enableHostCapability,
  disableHostCapability,
  isHostCapabilityEnabled,
  listHostCapabilities,
  HOST_CAPABILITY_COMPUTER_USE,
} from './core/hostCapabilities.js';

// ── WriteLedger (本轮改动记录 SSOT) ──
// 成功写工具 / shell declaredPaths / shell_proc → WriteDeclaration;
// 「本轮改动」只折叠账本, 不以 FS 时间窗猜状态.
export {
  recordWriteDeclaration,
  getWriteDeclarations,
  clearWriteLedger,
  getAllWriteDeclarations,
  isBulkWorkspaceMutationCommand,
  extractWriteDeclarationsFromToolComplete,
  foldWriteDeclarations,
} from './core/writeLedger.js';
export type {
  WriteDeclaration,
  WriteOp,
  WriteEvidence,
  ExtractToolWriteArgs,
} from './core/writeLedger.js';

// ── Tool call 重复检测(防死循环)──
// 已 wire 到 runner: 同 (toolName, args) 跨 step 连续重复 ≥3 触发 r1, ≥12 强停 turn.
// 注入点: runnerToolResultPreparationUtils.prepareToolResultForMemory.
export { ToolCallDeduplicator } from './core/reasoning/toolCallDeduplicator.js';

// ── Multi-agent registry + message bus (P0-2) ──
// 让 sub-agent 之间能双向通信, 不再只能"主→子单向".
// AgentRegistry: 全局 sessionId → metadata, listSiblings 拿同 task 其他 agent.
// AgentMessageBus: 每个 agent 一个 inbox, send/receive (一次性消费) / peek / hasMessages.
export {
  agentRegistry,
  createAgentRegistry,
} from './core/agentRegistry.js';
export type {
  AgentMetadata,
  AgentRegistry,
  AgentRole,
} from './core/agentRegistry.js';
export {
  agentMessageBus,
  createAgentMessageBus,
} from './core/agentMessageBus.js';
export type {
  AgentMessage,
  AgentMessageBus,
  MessageType,
} from './core/agentMessageBus.js';

// ── Stream partial 跟踪 (Q3) ──
// LLM stream 中途断 (watchdog timeout / 网络断) 时累积保留 partial output, 供续接.
// 调用方: stream 开始 start(), 每 chunk append, 完成 markComplete, 中断 markInterrupted.
// retry 路径调 wasInterrupted + getPartial 决定是否走 prefill 续接 (Anthropic/DeepSeek
// 支持) 或 fallback 重发.
export {
  StreamPartialTracker,
  shouldUsePrefillContinuation,
  providerSupportsPrefill,
} from './core/streamPartialTracker.js';
export type { InterruptReason, PartialSnapshot } from './core/streamPartialTracker.js';

// ── Reasoning loop 检测 (Q2) ──
// 检测 LLM 连续多轮纯文本回复无 tool_call 且 reasoning 文本相似 → 触发 reminder + 强停.
// 跟 ToolCallDeduplicator 互补: 一个抓"反复调同 tool" 另一个抓"反复空思考不行动".
// 已 wire 到 runner: 流结束后按 tool_calls 有无决定 recordToolCall / checkAndRecord;
// forceStop 触发 run.terminate('reasoning_loop_force_stop').
export {
  ReasoningLoopDetector,
  REASONING_REMINDER_1_START,
  REASONING_REMINDER_2_START,
  REASONING_REMINDER_3_START,
  REASONING_FORCE_STOP_STREAK,
} from './core/reasoning/reasoningLoopDetector.js';
export type { ReasoningCheckResult } from './core/reasoning/reasoningLoopDetector.js';

// ── Tool 资源访问声明 + 冲突调度 (W2) ──
// 比 parallelSafeTools 静态白名单更精准: 工具运行期声明 read/write/exclusive 某资源,
// scheduleByAccess 算冲突图分批 (无冲突并行 / 有冲突串行).
// 待接入 toolOrchestration/batch.ts 让 tool 实现 getAccessSet(args).
export {
  accessesConflict,
  setsConflict,
  scheduleByAccess,
  read,
  write,
  exclusive,
  accessSet,
  EMPTY_ACCESS_SET,
} from './core/toolAccesses.js';
export type {
  AccessKind,
  ResourceAccess,
  ToolAccessSet,
} from './core/toolAccesses.js';
export type { DedupCheckResult } from './core/reasoning/toolCallDeduplicator.js';
export {
  REPEAT_REMINDER_1_START,
  REPEAT_REMINDER_2_START,
  REPEAT_REMINDER_3_START,
  REPEAT_FORCE_STOP_STREAK,
} from './core/reasoning/toolCallDeduplicator.js';

// ── 编辑失败提示 / kernel 配置桥(宿主注入)──
export { parseDsmlToolCalls } from './utils/dsmlToolCalls.js';
/* token 估算 —— core 的 smart-read 要用; 走 barrel 而不是深引 utils/ (深引面只减不增,) */
export { estimateTokens } from './utils/tokenEstimate.js';
export type { ParsedDsmlToolCall, DsmlParseResult } from './utils/dsmlToolCalls.js';

export { buildEditFailureHint } from './core/promptHints.js';
export {
  getKernelConfig,
  setKernelConfigProvider,
  type KernelConfigView,
} from './core/kernelConfigBridge.js';
