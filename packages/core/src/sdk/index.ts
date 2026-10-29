export { RuntimeHostService, type RuntimeHostConfig, type RuntimeHostRunConfig } from '../runtime/runtimeHostService.js';
export {
  RuntimeOrchestrator,
  RuntimeOrchestratorError,
  type RuntimeOrchestratorRunOptions,
  type RuntimeOrchestratorResult,
  type ProviderResolution,
} from '../runtime/runtimeOrchestrator.js';
export { RuntimeCheckpointService } from '../runtime/checkpoint/runtimeCheckpointService.js';
export { createAgentRuntimeHost } from '../runtime/hostFactory.js';
export { buildInstructions } from '../runtime/systemPrompt.js';
export { applyThinkingMode, type ThinkingMode } from '../runtime/runtimeThinkingMode.js';
export { askJev, JEV_DEFAULT_MODEL, JevError, type JevResult } from '../runtime/jev/jevClient.js';
export { runProviderChatProbe, type ChatProbeRequest, type ChatProbeResult } from '../platform/providerChatProbe.js';
export { listOutputStyles, type OutputStyleInfo } from '../runtime/outputStyleManager.js';
export { readRequestLog, summarizeRequests, type RequestLogSummary } from '../runtime/diagnostics/requestLog.js';
export { readPrefixStabilityStats, formatPrefixStabilityLine, type PrefixStabilityStats } from '../runtime/prefixStabilityProbe.js';
/* VERIFY-08: edit 成功率周看板 —— EDIT_STAT 一直在 stall.log 里落, 但没人聚合得了 */
export {
  aggregateEditStatsByWeek,
  formatEditStatLine,
  parseEditStatLog,
  weekKeyOf,
  weekStartOf,
  EDIT_SUCCESS_TARGET_PCT,
  type EditStatRecord,
  type EditStatReport,
  type EditStatWeek,
} from '../observability/editStatWeekly.js';
export { testR2Share } from '../tools/share/r2Share.js';

export type {
  AgentRuntimeHost,
  AgentRuntimeEvent,
  RuntimeMetadata,
  RunTaskResult,
  RuntimeStatusType,
  HostAttachment,
} from '../runtime/agentRuntimeHost.js';

export { getTools, setToolServices, preloadShellEnv } from '../tools/runtimeTools.js';
/* PDF 文本层抽取 (pdftotext) —— 桌面主进程解析手机发来的 PDF 附件用, 跟 readfile 同一条通道 */
export { extractPdfText } from '../tools/image/imageProcessor.js';

export { setPhoneExecutor, type PhoneExecRequest, type PhoneExecResult } from '../tools/phoneTools.js';
export { COMPUTER_ACTIONS, type ComputerAction, type ComputerExecRequest, type ComputerExecResult } from '../tools/computerNodeTools.js';
/* 节点写动作的一次性批准令牌 (pilot:D-01): 容器 / 配对桌面签发, 手机与电脑节点验签。
 * 令牌绑定 tool + action + 参数摘要 + 10 分钟过期, 缺令牌的写动作在节点被拒。 */
export {
  signApproval, verifyApproval, withApproval, isWriteAction, argsDigest, canonicalJson,
  ApprovalNonceCache, APPROVAL_TTL_MS,
  type ApprovalToken, type PilotTool,
} from '../services/pilotApproval.js';
export { MACOS_BRIDGE_TOOLS } from '../tools/macosBridgeTools.js';
export {
  setReportExecutor, type ReportRequest, type ReportResult, type ReportStatus, type ReportUrgency,
} from '../tools/reportTools.js';
export { setCallUserExecutor, type CallUserRequest, type CallUserResult, type CallUrgency } from '../tools/callTools.js';
export {
  readPilotProfiles, getPilotProfile, savePilotProfile, removePilotProfile, type PilotProfile,
} from '../runtime/pilotProfiles.js';
export { spokenLeadOf } from '../services/spokenLead.js';

export type {
  Tool,
  AgentConfig,
  Instructions,
  Message,
  ToolCapability,
  ToolCapabilitySet,
} from '@neoxlabs/kernel/types/index.js';

export type { PlatformServices, PlatformLogger, ShellEnvService } from '@neoxlabs/platform/platform/services.js';
export { createNodeServices } from '@neoxlabs/platform/platform/nodeServices.js';
export { nodeToolCapabilities } from '@neoxlabs/platform/platform/toolCapabilities.js';
// 注: createElectronServices / electronToolCapabilities 故意不在此 re-export.
// Core SDK public API 保持 Node-only 依赖零 electron 污染.
// Desktop 包请直接从 '../platform/electronServices.js' 和 '../platform/toolCapabilities.js' 取.

// ============================================================================
// Client/Server SDK
// ============================================================================

export { setHostCapabilities } from './hostCapabilities.js';

export { NeoxClient, ApiError } from './client.js';
export type { NeoxClientOptions, ServerEventHandler } from './client.js';

export type {
  RuntimeAdapter,
  RuntimeEventCallback,
  AdapterChatRequest,
  AdapterStatus,
} from './runtimeAdapter.js';

export { RemoteRuntimeAdapter } from './remoteRuntimeAdapter.js';

export type { ServerEvent } from '../server/eventBus.js';
export type { ChatRequest, PermissionReply, RuntimeBridge, NeoxServerConfig } from '../server/index.js';
export type { ServerConnection } from '../server/processManager.js';
export { ensureServer, stopServer } from '../server/processManager.js';
export type { AgentRunMode } from '../runtime/modeFactory.js';

// ============================================================================
// Middleware (供外部集成使用)
// ============================================================================

export { authMiddleware, type AuthConfig } from '../server/middleware/auth.js';
export { rateLimitMiddleware, type RateLimitConfig } from '../server/middleware/rateLimit.js';
export { DeviceManager, type DeviceManagerConfig, type DeviceState } from '../server/middleware/device.js';
