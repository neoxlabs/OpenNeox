/**
 * NeoxAppState 的中央定义。
 *
 * 所有运行时状态集中在一个类型中，按核心、执行、工具、权限、MCP、远程、
 * UI 和团队分层组织，并通过 DeepReadonly 约束只读访问。状态同时承载审批
 * 历史、团队协作、设备连接和时间序列审计信息。
 */

import type { DeepReadonly } from './store.js';

// ─── 子状态类型 ───

/** 权限模式 */
export type ApprovalMode = 'auto' | 'manual' | 'dangerous';

/** Agent 运行模式 */
export type RunMode = 'agentic';

/** MCP 连接状态 */
export type McpConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/** 远程连接状态 */
export type RemoteConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

/** 内存压力等级 */
export type MemoryPressureLevel = 'unknown' | 'healthy' | 'warning' | 'critical';

/** 工具类别 */
export type ToolCategoryType = 'READ' | 'WRITE' | 'EXECUTE' | 'NETWORK' | 'SYSTEM';

/** Agent 状态 */
export type AgentStatus = 'idle' | 'running' | 'waiting' | 'completed' | 'error' | 'interrupted' | 'paused';

/** 任务状态 */
export type TaskStatus = 'pending' | 'claimed' | 'running' | 'blocked' | 'review' | 'completed' | 'failed' | 'cancelled';

// ─── 审批历史记录 ───

export interface ApprovalHistoryEntry {
  /** 时间戳 */
  timestamp: number;
  /** 工具名 */
  toolName: string;
  /** 工具类别 */
  toolCategory: ToolCategoryType;
  /** 用户决策 */
  approved: boolean;
  /** 是否记住 */
  remembered: boolean;
  /** 作用域 */
  scopeKey?: string;
  /** 关联会话 */
  sessionId?: string;
  /** 工具参数摘要 */
  argsSummary?: string;
  /** 风险等级 */
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
}

// ─── MCP 子状态 ───

export interface McpServerState {
  id: string;
  status: McpConnectionStatus;
  toolCount: number;
  lastConnectedAt?: number;
  lastErrorAt?: number;
  lastError?: string;
  consecutiveErrors: number;
  epoch: number;
}

export interface McpState {
  servers: McpServerState[];
  totalTools: number;
  enabled: boolean;
  /** MCP 重连触发器 — 递增触发重新获取 */
  reconnectKey: number;
}

// ─── 远程控制子状态 ───

export interface RemoteState {
  enabled: boolean;
  connectionStatus: RemoteConnectionStatus;
  /** 当前连接的设备数 */
  connectedDevices: number;
  /** Bridge 会话 URL */
  sessionUrl?: string;
  /** WebSocket gateway 状态 */
  wsGatewayActive: boolean;
  /** 当前全局 seq-num */
  currentSeq: number;
  /** 投递统计 */
  deliveryStats: {
    totalReceived: number;
    totalProcessed: number;
    totalLost: number;
    droppedBatchCount: number;
  };
}

// ─── 会话子状态 ───

export interface ActiveSessionState {
  id: string;
  status: 'running' | 'idle' | 'paused';
  epoch: number;
  messageCount: number;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  startedAt: number;
  lastActiveAt: number;
  mode?: string;
}

// ─── 权限子状态 ───

export interface PermissionState {
  mode: ApprovalMode;
  /** 已记住的工具权限 */
  rememberedTools: Array<{
    toolName: string;
    allowed: boolean;
    scopeKey?: string;
    expiresAt?: number;
  }>;
  /** 审批历史（持久化） */
  history: ApprovalHistoryEntry[];
  /** 挂起的审批请求 */
  pendingApprovals: Array<{
    requestId: string;
    toolName: string;
    toolCategory: ToolCategoryType;
    args?: Record<string, unknown>;
    reason?: string;
    riskLevel?: string;
    createdAt: number;
  }>;
}

// ─── Agent 团队子状态 ───

export interface TeamState {
  /** 是否在团队模式 */
  active: boolean;
  /** 团队名称 */
  teamName?: string;
  /** Leader Agent ID */
  leaderId?: string;
  /** 自身 Agent ID（如果是 worker） */
  selfId?: string;
  /** 自身名称 */
  selfName?: string;
  /** 是否为 Leader */
  isLeader?: boolean;
  /** 队友状态 */
  teammates: Array<{
    id: string;
    name: string;
    agentType?: string;
    status: AgentStatus;
    currentTask?: string;
    cwd?: string;
    spawnedAt: number;
  }>;
  /** 正在查看的队友 */
  viewingTeammateId?: string;
}

// ─── 工具执行指标 ───

export interface ToolMetrics {
  /** 工具调用总数 */
  totalCalls: number;
  /** 按工具名统计 */
  byTool: Record<string, {
    count: number;
    successCount: number;
    failCount: number;
    avgDurationMs: number;
    lastCalledAt: number;
  }>;
  /** 按类别统计 */
  byCategory: Record<string, number>;
}

// ─── UI 状态（CLI / Electron 共用） ───

export interface UIState {
  /** 详细模式 */
  verbose: boolean;
  /** 展开的视图面板 */
  expandedView: 'none' | 'tasks' | 'teammates' | 'mcp';
  /** spinner 提示文本 */
  spinnerTip?: string;
  /** 状态栏文本 */
  statusLineText?: string;
  /** 快速模式（同模型但更快输出） */
  fastMode: boolean;
  /** thinking 开关 */
  thinkingEnabled: boolean;
  /** 当前语言 */
  language: 'zh' | 'en';
}

// ─── 文件追踪状态 ───

export interface FileTrackingState {
  /** 已写入的文件 */
  writtenFiles: Record<string, { checksum: string; lines: number; timestamp: number }>;
  /** 已编辑的文件计数 */
  editedFiles: Record<string, number>;
  /** 最近读取的文件 */
  recentReads: string[];
}

// ─── 设置快照 ───

export interface SettingsSnapshot {
  /** 当前模型 */
  model?: string;
  /** Provider */
  providerId?: string;
  /** 沙盒是否启用 */
  sandboxEnabled: boolean;
  /** 上下文压缩模式 */
  compressionMode: 'sync' | 'async';
  /** reasoning effort */
  reasoningEffort?: string;
  /** 自动压缩阈值 */
  autoCompactLimit?: number;
}

// ═══════════════════════════════════════════════════════════
// NeoxAppState — 中央状态定义
// ═══════════════════════════════════════════════════════════

export interface NeoxAppState {
  // ─── 核心 ───

  /** 全局初始化完成 */
  initialized: boolean;
  /** Neox 版本 */
  version: string;
  /** 工作目录 */
  workDir: string;
  /** 当前运行模式 */
  runMode: RunMode;
  /** 状态变更计数器（用于强制刷新） */
  stateVersion: number;

  // ─── 执行 ───

  /** 当前是否有任务在运行 */
  isRunning: boolean;
  /** 活跃会话列表 */
  activeSessions: ActiveSessionState[];
  /** 内存压力等级 */
  memoryPressure: MemoryPressureLevel;
  /** 自动压缩是否正在进行 */
  autoCompactionInProgress: boolean;

  // ─── 权限 & 审批 ───

  permissions: PermissionState;

  // ─── 工具 ───

  /** 已加载的工具数量 */
  toolCount: number;
  /** 工具执行指标 */
  toolMetrics: ToolMetrics;

  // ─── MCP ───

  mcp: McpState;

  // ─── 远程控制 ───

  remote: RemoteState;

  // ─── Agent 团队 ───

  team: TeamState;

  // ─── 文件追踪 ───

  files: FileTrackingState;

  // ─── 设置 ───

  settings: SettingsSnapshot;

  // ─── UI ───

  ui: UIState;

  // ─── 审计 ───

  /** 状态变更日志（最近 N 条） */
  auditLog: Array<{
    timestamp: number;
    field: string;
    action: string;
    detail?: string;
  }>;

  // ─── Auth ───

  /** 认证版本号 — 登录/登出时递增，触发缓存清除 */
  authVersion: number;
}

// ═══════════════════════════════════════════════════════════
// 默认状态工厂
// ═══════════════════════════════════════════════════════════

export function getDefaultAppState(options?: {
  workDir?: string;
  version?: string;
  runMode?: RunMode;
}): NeoxAppState {
  return {
    initialized: false,
    version: options?.version ?? '0.0.0',
    workDir: options?.workDir ?? process.cwd(),
    runMode: options?.runMode ?? 'agentic',
    stateVersion: 0,

    isRunning: false,
    activeSessions: [],
    memoryPressure: 'unknown',
    autoCompactionInProgress: false,

    permissions: {
      mode: 'manual',
      rememberedTools: [],
      history: [],
      pendingApprovals: [],
    },

    toolCount: 0,
    toolMetrics: {
      totalCalls: 0,
      byTool: {},
      byCategory: {},
    },

    mcp: {
      servers: [],
      totalTools: 0,
      enabled: true,
      reconnectKey: 0,
    },

    remote: {
      enabled: false,
      connectionStatus: 'disconnected',
      connectedDevices: 0,
      wsGatewayActive: false,
      currentSeq: 0,
      deliveryStats: {
        totalReceived: 0,
        totalProcessed: 0,
        totalLost: 0,
        droppedBatchCount: 0,
      },
    },

    team: {
      active: false,
      teammates: [],
    },

    files: {
      writtenFiles: {},
      editedFiles: {},
      recentReads: [],
    },

    settings: {
      sandboxEnabled: true,
      compressionMode: 'sync',
    },

    ui: {
      verbose: false,
      expandedView: 'none',
      fastMode: false,
      thinkingEnabled: true,
      language: 'zh',
    },

    auditLog: [],
    authVersion: 0,
  };
}

/** 只读版 NeoxAppState — 外部消费时使用 */
export type ReadonlyNeoxAppState = DeepReadonly<NeoxAppState>;
