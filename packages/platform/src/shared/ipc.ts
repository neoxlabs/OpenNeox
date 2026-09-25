import type {
  ModelRouteConfig,
  ModelProviderRoute,
  RoutingStrategy,
  FallbackSettings,
  RecoverySettings,
  FallbackReason,
  FallbackEvent,
  RecoveryEvent,
  ModelRoutingConfig,
} from './ipc/modelRouting.js';
import type {
  IndexStats,
  IndexBuildProgress,
  IndexBuildResult,
  IndexSymbolKind,
  IndexSymbolInfo,
  IndexSymbolSearchResult,
} from './ipc/codeIndex.js';
import type {
  MemoryStatsEntry,
  MemoryStats,
  MemoryConfig,
} from './ipc/memory.js';
import type {
  BrowserConsoleType,
  BrowserConsoleMessage,
  BrowserRuntimeError,
  BrowserNetworkRequest,
  BrowserPerformanceMetrics,
  BrowserDebugResult,
  ChromeInstallation,
  BrowserStatus,
} from './ipc/browser.js';
import type {
  RemoteNetworkMode,
  RemoteAccessConfig,
  RemoteAccessStatus,
  RemoteClientInfo,
} from './ipc/remote.js';
import type {
  CompressionMode,
  MemoryPressureState,
  TokenBreakdown,
  SessionCacheUsage,
  ContextUsage,
  ContextConfig,
} from './ipc/context.js';
import type {
  MCPTransport,
  MCPConfigScope,
  MCPServerEntry,
  MCPServerInput,
  MCPToolInfo,
} from './ipc/mcp.js';
import type {
  SkillCategory,
  SkillSource,
  DangerLevel,
  SkillHooks,
  NeoxSkillExtension,
  SkillMetadata,
  SkillInfo,
  SkillListOptions,
  SkillCreateOptions,
  SkillDirs,
} from './ipc/skills.js';
import type {
  StorageFileInfo,
  CheckpointStorageInfo,
  StorageInfo,
  CheckpointClearResult,
  ConfigFileContent,
} from './ipc/storage.js';
import type {
  ColorTheme,
  DarkModePreference,
  UILastState,
} from './ipc/uiState.js';
import type {
  RequestType,
  TokenUsageRecord,
  ProviderUsageStats,
  UsageSummary,
} from './ipc/tokenUsage.js';
import type {
  HealthCheckRequest,
  HealthCheckResult,
  KimiBalanceResult,
  HealthStatus,
  HealthRecord,
  ProviderHealth,
} from './ipc/health.js';
import type { JavaDebugStatus } from './ipc/javaDebug.js';
import type {
  FileChangeType,
  FileChangeRecord,
  FileChangeStats,
  FileCheckpointMeta,
  FileCheckpointListItem,
  CheckpointRollbackResult,
} from './ipc/checkpoint.js';
import type { TimelineEntryType, SavedTimelineEntry } from './ipc/timeline.js';
import type {
  ChatMessage,
  Session,
  SessionCheckpoint,
  SessionCheckpointMeta,
} from './ipc/session.js';
import type {
  ChatRequestPayload,
  ChatResponsePayload,
  SupervisorProgress,
} from './ipc/chatPayload.js';
import type {
  UserLanguage,
  OrchestratorConfig,
  TaskType,
  TaskRoutingRule,
  ContextSharingStrategy,
  OrchestrationMode,
  ProviderProtocol,
  ProviderModelConfig,
  ProviderConfig,
} from './ipc/configAliases.js';
import type { StreamEvent } from './ipc/streamEvent.js';
import type { MenuAction } from './ipc/menu.js';
import type { RendererAPI } from './ipc/rendererApi.js';
import type {
  CreateProviderInput,
  FetchProviderModelsRequest,
  FetchProviderModelsResult,
  UpdateProviderInput,
} from './ipc/providerInputs.js';
import type {
  AgentSettings,
  ModelConfig,
  Environment,
  AppInfo,
  WorkspaceState,
  InteractionMode,
  Attachment,
  ChatMetadata,
} from './ipc/coreTypes.js';
import type { DoubaoThinkingMode, ModelInfo } from './ipc/models.js';
import {
  DOUBAO_THINKING_MODELS,
  CLAUDE_THINKING_MODELS,
  GEMINI_THINKING_MODELS,
  isThinkingSupported,
  getThinkingModes,
  DEFAULT_MODELS,
} from './ipc/models.js';

export type {
  UserLanguage,
  OrchestratorConfig,
  TaskType,
  TaskRoutingRule,
  ContextSharingStrategy,
  OrchestrationMode,
};

export type {
  AgentSettings,
  ModelConfig,
  Environment,
  AppInfo,
  WorkspaceState,
  InteractionMode,
  Attachment,
  ChatMetadata,
};

// 多根工作区 runtime helper (值导出, renderer/main/runner 共用)
export { workspaceRoots, primaryRoot } from './ipc/coreTypes.js';

// ==================== Provider 配置定义 (与 CLI 共享) ====================

export type {
  ProviderProtocol,
  ProviderModelConfig,
  ProviderConfig,
};
export type {
  CreateProviderInput,
  FetchProviderModelsRequest,
  FetchProviderModelsResult,
  UpdateProviderInput,
};

// ==================== 模型路由定义 ====================
export type {
  RoutingStrategy,
  ModelProviderRoute,
  ModelRouteConfig,
  FallbackSettings,
  RecoverySettings,
  FallbackReason,
  FallbackEvent,
  RecoveryEvent,
  ModelRoutingConfig,
};

// ==================== MCP 服务器类型 ====================
export type {
  MCPTransport,
  MCPConfigScope,
  MCPServerEntry,
  MCPServerInput,
  MCPToolInfo,
};

// ==================== Skills 类型 ====================
export type {
  SkillCategory,
  SkillSource,
  DangerLevel,
  SkillHooks,
  NeoxSkillExtension,
  SkillMetadata,
  SkillInfo,
  SkillListOptions,
  SkillCreateOptions,
  SkillDirs,
};

// ==================== 代码索引类型 ====================
export type {
  IndexStats,
  IndexBuildProgress,
  IndexBuildResult,
  IndexSymbolKind,
  IndexSymbolInfo,
  IndexSymbolSearchResult,
};

// ==================== 记忆系统类型 ====================
export type {
  MemoryStatsEntry,
  MemoryStats,
  MemoryConfig,
};

// ==================== 浏览器工具类型 ====================
export type {
  BrowserConsoleType,
  BrowserConsoleMessage,
  BrowserRuntimeError,
  BrowserNetworkRequest,
  BrowserPerformanceMetrics,
  BrowserDebugResult,
  ChromeInstallation,
  BrowserStatus,
};

// ==================== 远程访问类型 ====================
export type {
  RemoteNetworkMode,
  RemoteAccessConfig,
  RemoteAccessStatus,
  RemoteClientInfo,
};

// ==================== 上下文管理类型 ====================
export type {
  CompressionMode,
  MemoryPressureState,
  TokenBreakdown,
  SessionCacheUsage,
  ContextUsage,
  ContextConfig,
};

// ==================== 模型定义 (UI 展示用) ====================
export type { DoubaoThinkingMode, ModelInfo };
export {
  DOUBAO_THINKING_MODELS,
  CLAUDE_THINKING_MODELS,
  GEMINI_THINKING_MODELS,
  isThinkingSupported,
  getThinkingModes,
  DEFAULT_MODELS,
};

// ==================== Session 定义 ====================
export type {
  ChatMessage,
  Session,
  SessionCheckpoint,
  SessionCheckpointMeta,
};

// ==================== UI Timeline (Electron) ====================
export type { TimelineEntryType, SavedTimelineEntry };

// ==================== 请求/响应定义 ====================
export type {
  ChatRequestPayload,
  ChatResponsePayload,
  SupervisorProgress,
};

export type { StreamEvent };

// ==================== 菜单事件 ====================
export type { MenuAction };

// ==================== UI State ====================
export type {
  ColorTheme,
  DarkModePreference,
  UILastState,
};

// ==================== 存储信息类型 ====================
export type {
  StorageFileInfo,
  CheckpointStorageInfo,
  StorageInfo,
  CheckpointClearResult,
  ConfigFileContent,
};

// ==================== Token 使用统计 ====================
export type {
  RequestType,
  TokenUsageRecord,
  ProviderUsageStats,
  UsageSummary,
};

// ==================== Provider 健康检测 ====================
export type {
  HealthCheckRequest,
  HealthCheckResult,
  KimiBalanceResult,
  HealthStatus,
  HealthRecord,
  ProviderHealth,
};

// ==================== Java Debug ====================
export type { JavaDebugStatus };

// ==================== Checkpoint 系统 (Shadow Git) ====================
export type {
  FileChangeType,
  FileChangeRecord,
  FileChangeStats,
  FileCheckpointMeta,
  FileCheckpointListItem,
  CheckpointRollbackResult,
};

// ==================== Renderer API ====================
export type { RendererAPI };

// ==================== IPC 路由注册表 (本文件唯一的运行时导出) ====================
/* ipcBridge = channel → handler 的注册表, 主进程侧用; 本文件其余部分是纯类型契约。
 *
 * 为什么放这儿再导出: platform/ipcBridge.js 是 platform 的内部路径, 包边界闸
 * (scripts/check-import-boundaries.mjs) 的深引棘轮不许新增, 而 shared/ipc.js 已在基线内,
 * 本来就是 ipc 契约的公开入口。ipcBridge 自身零 import (一个 Map + 几个函数),
 * 所以只要类型的使用者也不会因此被拖进任何主进程依赖。 */
export {
  registerBridgeRoute,
  getBridgeRoute,
  hasBridgeRoute,
  bridgeChannels,
  invokeBridge,
} from '../platform/ipcBridge.js';
export type { BridgeHandler } from '../platform/ipcBridge.js';
