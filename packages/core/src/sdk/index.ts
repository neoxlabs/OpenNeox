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

export type {
  AgentRuntimeHost,
  AgentRuntimeEvent,
  RuntimeMetadata,
  RunTaskResult,
  RuntimeStatusType,
  HostAttachment,
} from '../runtime/agentRuntimeHost.js';

export { getTools, setToolServices, preloadShellEnv } from '../tools/runtimeTools.js';

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
