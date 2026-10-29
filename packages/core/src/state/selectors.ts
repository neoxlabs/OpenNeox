/**
 *  T-038b: 状态选择器 — 纯函数派生状态
 *
 * 采用 兼容格式 selectors.ts 精华：
 *  - 纯函数，无副作用
 *  - 最小输入约束（Pick<AppState, ...>）
 *  - 返回类型精确（discriminated union）
 *
 * 用途：
 *  - 组件/模块通过 selector 精准订阅需要的状态片段
 *  - 避免全量状态变化导致不必要的计算
 */

import type { NeoxAppState, ActiveSessionState, McpServerState } from './appState.js';

// ─── 会话选择器 ───

/** 获取当前活跃会话（最近活跃的） */
export function getActiveSession(
  state: Pick<NeoxAppState, 'activeSessions'>,
): ActiveSessionState | undefined {
  const running = state.activeSessions.filter(s => s.status === 'running');
  if (running.length > 0) {
    return running.reduce((a, b) => a.lastActiveAt > b.lastActiveAt ? a : b);
  }
  return state.activeSessions[0];
}

/** 获取总 Token 消耗 */
export function getTotalTokenUsage(
  state: Pick<NeoxAppState, 'activeSessions'>,
): { input: number; output: number; total: number } {
  let input = 0, output = 0;
  for (const s of state.activeSessions) {
    input += s.tokenUsage.inputTokens;
    output += s.tokenUsage.outputTokens;
  }
  return { input, output, total: input + output };
}

// ─── 权限选择器 ───

/** 权限摘要 */
export function getPermissionSummary(
  state: Pick<NeoxAppState, 'permissions'>,
): {
  mode: string;
  pendingCount: number;
  rememberedCount: number;
  approvalRate: number;
  recentApprovals: number;
} {
  const { permissions } = state;
  const total = permissions.history.length;
  const approved = permissions.history.filter(h => h.approved).length;
  const last24h = Date.now() - 24 * 60 * 60 * 1000;
  const recentApprovals = permissions.history.filter(h => h.timestamp > last24h).length;

  return {
    mode: permissions.mode,
    pendingCount: permissions.pendingApprovals.length,
    rememberedCount: permissions.rememberedTools.length,
    approvalRate: total > 0 ? Math.round((approved / total) * 100) : 100,
    recentApprovals,
  };
}

/** 获取指定工具的审批统计 */
export function getToolApprovalStats(
  state: Pick<NeoxAppState, 'permissions'>,
  toolName: string,
): { total: number; approved: number; denied: number; lastDecision?: boolean } {
  const entries = state.permissions.history.filter(h => h.toolName === toolName);
  const approved = entries.filter(h => h.approved).length;
  return {
    total: entries.length,
    approved,
    denied: entries.length - approved,
    lastDecision: entries.length > 0 ? entries[entries.length - 1].approved : undefined,
  };
}

// ─── MCP 选择器 ───

/** MCP 整体健康状态 */
export function getMcpHealthStatus(
  state: Pick<NeoxAppState, 'mcp'>,
): {
  status: 'healthy' | 'degraded' | 'down' | 'disabled';
  connectedCount: number;
  errorCount: number;
  totalServers: number;
  totalTools: number;
} {
  if (!state.mcp.enabled) {
    return { status: 'disabled', connectedCount: 0, errorCount: 0, totalServers: 0, totalTools: 0 };
  }
  const servers = state.mcp.servers;
  const connected = servers.filter(s => s.status === 'connected').length;
  const errors = servers.filter(s => s.status === 'error').length;
  const total = servers.length;

  let status: 'healthy' | 'degraded' | 'down' = 'healthy';
  if (total === 0) status = 'healthy';
  else if (connected === 0) status = 'down';
  else if (errors > 0) status = 'degraded';

  return {
    status,
    connectedCount: connected,
    errorCount: errors,
    totalServers: total,
    totalTools: state.mcp.totalTools,
  };
}

/** 获取有问题的 MCP 服务器 */
export function getProblematicMcpServers(
  state: Pick<NeoxAppState, 'mcp'>,
): McpServerState[] {
  return state.mcp.servers.filter(s => s.status === 'error' || s.consecutiveErrors > 0);
}

// ─── 远程控制选择器 ───

/** 远程控制摘要 */
export function getRemoteSummary(
  state: Pick<NeoxAppState, 'remote'>,
): {
  active: boolean;
  status: string;
  devices: number;
  wsActive: boolean;
  reliability: number;
} {
  const { remote } = state;
  const { deliveryStats } = remote;
  const total = deliveryStats.totalReceived;
  const lost = deliveryStats.totalLost + deliveryStats.droppedBatchCount;
  const reliability = total > 0 ? Math.round(((total - lost) / total) * 100) : 100;

  return {
    active: remote.enabled && remote.connectionStatus === 'connected',
    status: remote.connectionStatus,
    devices: remote.connectedDevices,
    wsActive: remote.wsGatewayActive,
    reliability,
  };
}

// ─── 团队选择器 ───

export type ActiveAgentForInput =
  | { type: 'self' }
  | { type: 'leader' }
  | { type: 'teammate'; id: string; name: string };

/** 确定当前输入应路由到哪个 Agent */
export function getActiveAgentForInput(
  state: Pick<NeoxAppState, 'team'>,
): ActiveAgentForInput {
  if (!state.team.active) return { type: 'self' };
  if (state.team.viewingTeammateId) {
    const mate = state.team.teammates.find(t => t.id === state.team.viewingTeammateId);
    if (mate) return { type: 'teammate', id: mate.id, name: mate.name };
  }
  if (state.team.isLeader) return { type: 'self' };
  return { type: 'leader' };
}

/** 获取活跃队友数 */
export function getActiveTeammateCount(
  state: Pick<NeoxAppState, 'team'>,
): number {
  return state.team.teammates.filter(t => t.status === 'running' || t.status === 'waiting').length;
}

// ─── 工具指标选择器 ───

/** 获取最常调用的工具 TOP-N */
export function getTopTools(
  state: Pick<NeoxAppState, 'toolMetrics'>,
  n = 5,
): Array<{ name: string; count: number; successRate: number }> {
  return Object.entries(state.toolMetrics.byTool)
    .map(([name, stats]) => ({
      name,
      count: stats.count,
      successRate: stats.count > 0 ? Math.round((stats.successCount / stats.count) * 100) : 0,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}

// ─── 综合状态选择器 ───

/** 系统整体健康检查 */
export function getSystemHealth(
  state: Pick<NeoxAppState, 'memoryPressure' | 'mcp' | 'remote' | 'activeSessions' | 'isRunning'>,
): {
  overall: 'healthy' | 'warning' | 'critical';
  details: string[];
} {
  const details: string[] = [];
  let overall: 'healthy' | 'warning' | 'critical' = 'healthy';

  // 内存压力
  if (state.memoryPressure === 'critical') {
    details.push('Memory pressure: CRITICAL');
    overall = 'critical';
  } else if (state.memoryPressure === 'warning') {
    details.push('Memory pressure: WARNING');
    if (overall === 'healthy') overall = 'warning';
  }

  // MCP
  const mcpHealth = getMcpHealthStatus(state);
  if (mcpHealth.status === 'down') {
    details.push(`MCP: all ${mcpHealth.totalServers} servers down`);
    if (overall === 'healthy') overall = 'warning';
  } else if (mcpHealth.status === 'degraded') {
    details.push(`MCP: ${mcpHealth.errorCount} server(s) in error`);
    if (overall === 'healthy') overall = 'warning';
  }

  // 远程
  const remoteSummary = getRemoteSummary(state);
  if (remoteSummary.active && remoteSummary.reliability < 90) {
    details.push(`Remote delivery reliability: ${remoteSummary.reliability}%`);
    if (overall === 'healthy') overall = 'warning';
  }

  if (details.length === 0) {
    details.push('All systems nominal');
  }

  return { overall, details };
}
