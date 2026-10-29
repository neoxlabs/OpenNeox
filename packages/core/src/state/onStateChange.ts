
import type { NeoxAppState } from './appState.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

// ─── 外部钩子注册 ───

export interface StateChangeHooks {
  /** 权限模式变更时调用 */
  onPermissionModeChange?: (newMode: string, oldMode: string) => void;
  /** 设置变更时持久化 */
  onSettingsChange?: (settings: NeoxAppState['settings']) => void;
  /** MCP 重连触发 */
  onMcpReconnect?: () => void;
  /** Auth 变更时清除缓存 */
  onAuthChange?: () => void;
  /** 审批历史需要持久化 */
  onApprovalHistoryChange?: (history: NeoxAppState['permissions']['history']) => void;
  /** 远程状态变更通知 */
  onRemoteStateChange?: (remote: NeoxAppState['remote']) => void;
  /** 团队状态变更通知 */
  onTeamStateChange?: (team: NeoxAppState['team']) => void;
  /** 运行模式变更 */
  onRunModeChange?: (newMode: string, oldMode: string) => void;
}

let hooks: StateChangeHooks = {};

/**
 * 注册副作用钩子 — 在应用初始化时调用一次
 */
export function registerStateChangeHooks(h: StateChangeHooks): void {
  hooks = { ...hooks, ...h };
}

// ─── 审计日志容量 ───

const MAX_AUDIT_LOG_SIZE = 200;

/**
 * 统一副作用处理函数 — 作为 createStore 的 onChange 回调
 *
 * 规则：
 *  - 纯比较 + 精确触发，不做多余工作
 *  - 不修改 state（单向数据流）
 *  - 异步操作 fire-and-forget（不阻塞状态更新）
 */
export function onStateChange({
  newState,
  oldState,
}: {
  newState: NeoxAppState;
  oldState: NeoxAppState;
}): void {
  // ─── 1. 权限模式 ───

  if (newState.permissions.mode !== oldState.permissions.mode) {
    cliLogger.info('STATE', `Permission mode: ${oldState.permissions.mode} → ${newState.permissions.mode}`);
    hooks.onPermissionModeChange?.(newState.permissions.mode, oldState.permissions.mode);
  }

  // ─── 2. 设置变更 ───

  if (newState.settings !== oldState.settings) {
    hooks.onSettingsChange?.(newState.settings);

    // 模型变更日志
    if (newState.settings.model !== oldState.settings.model) {
      cliLogger.info('STATE', `Model: ${oldState.settings.model ?? 'default'} → ${newState.settings.model ?? 'default'}`);
    }

    // 沙盒状态变更
    if (newState.settings.sandboxEnabled !== oldState.settings.sandboxEnabled) {
      cliLogger.info('STATE', `Sandbox: ${newState.settings.sandboxEnabled ? 'enabled' : 'disabled'}`);
    }
  }

  // ─── 3. Auth 变更 ───

  if (newState.authVersion !== oldState.authVersion) {
    cliLogger.info('STATE', `Auth version bumped to ${newState.authVersion}`);
    hooks.onAuthChange?.();
  }

  // ─── 4. MCP 重连 ───

  if (newState.mcp.reconnectKey !== oldState.mcp.reconnectKey) {
    cliLogger.info('STATE', `MCP reconnect triggered (key=${newState.mcp.reconnectKey})`);
    hooks.onMcpReconnect?.();
  }

  // MCP 服务器状态变更
  if (newState.mcp.servers !== oldState.mcp.servers) {
    const connected = newState.mcp.servers.filter(s => s.status === 'connected').length;
    const total = newState.mcp.servers.length;
    if (connected !== oldState.mcp.servers.filter(s => s.status === 'connected').length) {
      cliLogger.info('STATE', `MCP servers: ${connected}/${total} connected`);
    }
  }

  // ─── 5. 审批历史持久化 ───

  if (newState.permissions.history !== oldState.permissions.history) {
    if (newState.permissions.history.length > oldState.permissions.history.length) {
      hooks.onApprovalHistoryChange?.(newState.permissions.history);
    }
  }

  // ─── 6. 远程状态 ───

  if (newState.remote !== oldState.remote) {
    // 连接状态变更
    if (newState.remote.connectionStatus !== oldState.remote.connectionStatus) {
      cliLogger.info('STATE', `Remote: ${newState.remote.connectionStatus}`);
    }
    hooks.onRemoteStateChange?.(newState.remote);
  }

  // ─── 7. 运行模式 ───

  if (newState.runMode !== oldState.runMode) {
    cliLogger.info('STATE', `Run mode: ${oldState.runMode} → ${newState.runMode}`);
    hooks.onRunModeChange?.(newState.runMode, oldState.runMode);
  }

  // ─── 8. 团队状态 ───

  if (newState.team !== oldState.team) {
    if (newState.team.active !== oldState.team.active) {
      cliLogger.info('STATE', `Team mode: ${newState.team.active ? 'active' : 'inactive'}`);
    }
    hooks.onTeamStateChange?.(newState.team);
  }

  // ─── 9. 内存压力 ───

  if (newState.memoryPressure !== oldState.memoryPressure) {
    if (newState.memoryPressure === 'critical') {
      cliLogger.warn('STATE', 'Memory pressure: CRITICAL — auto-compact should trigger');
    } else if (newState.memoryPressure === 'warning') {
      cliLogger.warn('STATE', 'Memory pressure: WARNING');
    }
  }

  // ─── 10. 执行状态 ───

  if (newState.isRunning !== oldState.isRunning) {
    cliLogger.info('STATE', `Execution: ${newState.isRunning ? 'RUNNING' : 'IDLE'}`);
  }
}

// ─── 便捷 state 更新函数 ───

/**
 * 追加审计日志条目
 * 使用方式：store.setState(appendAuditLog('permissions', 'mode_changed', 'auto → manual'))
 */
export function appendAuditLog(
  field: string,
  action: string,
  detail?: string,
): (prev: NeoxAppState) => NeoxAppState {
  return (prev) => {
    const entry = { timestamp: Date.now(), field, action, detail };
    const log = [...prev.auditLog, entry];
    // 容量限制
    const trimmed = log.length > MAX_AUDIT_LOG_SIZE
      ? log.slice(log.length - MAX_AUDIT_LOG_SIZE)
      : log;
    return { ...prev, auditLog: trimmed };
  };
}

/**
 * 记录审批决策
 */
export function recordApproval(entry: NeoxAppState['permissions']['history'][number]): (prev: NeoxAppState) => NeoxAppState {
  return (prev) => ({
    ...prev,
    permissions: {
      ...prev.permissions,
      history: [...prev.permissions.history, entry],
    },
  });
}

/**
 * 记录工具调用指标
 */
export function recordToolCall(
  toolName: string,
  category: string,
  success: boolean,
  durationMs: number,
): (prev: NeoxAppState) => NeoxAppState {
  return (prev) => {
    const byTool = { ...prev.toolMetrics.byTool };
    const existing = byTool[toolName] ?? { count: 0, successCount: 0, failCount: 0, avgDurationMs: 0, lastCalledAt: 0 };
    const newCount = existing.count + 1;
    byTool[toolName] = {
      count: newCount,
      successCount: existing.successCount + (success ? 1 : 0),
      failCount: existing.failCount + (success ? 0 : 1),
      avgDurationMs: Math.round((existing.avgDurationMs * existing.count + durationMs) / newCount),
      lastCalledAt: Date.now(),
    };

    const byCategory = { ...prev.toolMetrics.byCategory };
    byCategory[category] = (byCategory[category] ?? 0) + 1;

    return {
      ...prev,
      toolMetrics: {
        totalCalls: prev.toolMetrics.totalCalls + 1,
        byTool,
        byCategory,
      },
    };
  };
}

/**
 * 更新活跃会话
 */
export function updateActiveSession(
  sessionId: string,
  update: Partial<NeoxAppState['activeSessions'][number]>,
): (prev: NeoxAppState) => NeoxAppState {
  return (prev) => {
    const sessions = prev.activeSessions.map(s =>
      s.id === sessionId ? { ...s, ...update, lastActiveAt: Date.now() } : s,
    );
    return { ...prev, activeSessions: sessions };
  };
}

/**
 * 更新 MCP 服务器状态
 */
export function updateMcpServer(
  serverId: string,
  update: Partial<NeoxAppState['mcp']['servers'][number]>,
): (prev: NeoxAppState) => NeoxAppState {
  return (prev) => {
    const servers = prev.mcp.servers.map(s =>
      s.id === serverId ? { ...s, ...update } : s,
    );
    return {
      ...prev,
      mcp: { ...prev.mcp, servers },
    };
  };
}
