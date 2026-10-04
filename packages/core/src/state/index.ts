/**
 *  T-039b: Neox State Management — 统一入口
 *
 * 整合 Store + AppState + onChange + Selectors + Persistence
 * 提供全局单例和迁移桥接
 */

// ─── 核心导出 ───

export { createStore, createSelector, type Store, type DeepReadonly } from './store.js';
export {
  type NeoxAppState,
  type ReadonlyNeoxAppState,
  type ApprovalMode,
  type RunMode,
  type McpConnectionStatus,
  type RemoteConnectionStatus,
  type MemoryPressureLevel,
  type ToolCategoryType,
  type AgentStatus,
  type TaskStatus,
  type ApprovalHistoryEntry,
  type McpServerState,
  type McpState,
  type RemoteState,
  type ActiveSessionState,
  type PermissionState,
  type TeamState,
  type ToolMetrics,
  type UIState,
  type FileTrackingState,
  type SettingsSnapshot,
  getDefaultAppState,
} from './appState.js';
export {
  onStateChange,
  registerStateChangeHooks,
  appendAuditLog,
  recordApproval,
  recordToolCall,
  updateActiveSession,
  updateMcpServer,
  type StateChangeHooks,
} from './onStateChange.js';
export {
  getActiveSession,
  getTotalTokenUsage,
  getPermissionSummary,
  getToolApprovalStats,
  getMcpHealthStatus,
  getProblematicMcpServers,
  getRemoteSummary,
  getActiveAgentForInput,
  getActiveTeammateCount,
  getTopTools,
  getSystemHealth,
  type ActiveAgentForInput,
} from './selectors.js';
export {
  createSnapshot,
  restoreFromSnapshot,
  saveSnapshot,
  loadSnapshot,
  saveApprovalHistory,
  loadApprovalHistory,
  saveToolMetrics,
  loadToolMetrics,
  type StateSnapshot,
} from './persistence.js';

// ─── 全局 Store 单例 ───

import { createStore, type Store } from './store.js';
import { type NeoxAppState, getDefaultAppState } from './appState.js';
import { onStateChange } from './onStateChange.js';
import { loadSnapshot, restoreFromSnapshot, loadApprovalHistory, loadToolMetrics } from './persistence.js';

let globalStore: Store<NeoxAppState> | null = null;

/**
 * 初始化全局 Store — 应用启动时调用一次
 *
 * @param configDir 配置目录（用于加载快照和审批历史）
 * @param options 覆盖选项
 */
export function initGlobalStore(
  configDir?: string,
  options?: { workDir?: string; version?: string; runMode?: 'agentic' },
): Store<NeoxAppState> {
  if (globalStore) return globalStore;

  let initialState: NeoxAppState;

  // 尝试从快照恢复
  if (configDir) {
    const snapshot = loadSnapshot(configDir);
    if (snapshot) {
      initialState = restoreFromSnapshot(snapshot, options);
    } else {
      initialState = getDefaultAppState(options);
    }

    // 加载持久化的审批历史
    const history = loadApprovalHistory(configDir);
    if (history.length > 0) {
      initialState = { ...initialState, permissions: { ...initialState.permissions, history } };
    }

    // 加载工具指标
    const metrics = loadToolMetrics(configDir);
    if (metrics) {
      initialState = { ...initialState, toolMetrics: metrics };
    }
  } else {
    initialState = getDefaultAppState(options);
  }

  globalStore = createStore(initialState, onStateChange);
  return globalStore;
}

/**
 * 获取全局 Store 实例
 * @throws 如果未初始化
 */
export function getGlobalStore(): Store<NeoxAppState> {
  if (!globalStore) {
    throw new Error('Global store not initialized — call initGlobalStore() first');
  }
  return globalStore;
}

/**
 * 获取全局 Store（安全版本，未初始化时返回 null）
 */
export function getGlobalStoreSafe(): Store<NeoxAppState> | null {
  return globalStore;
}

/**
 * 便捷函数：获取当前全局状态
 */
export function getAppState(): NeoxAppState {
  return getGlobalStore().getState();
}

/**
 * 便捷函数：更新全局状态
 */
export function setAppState(updater: (prev: NeoxAppState) => NeoxAppState): void {
  getGlobalStore().setState(updater);
}

/**
 * 便捷函数：订阅全局状态变化
 */
export function subscribeAppState(listener: () => void): () => void {
  return getGlobalStore().subscribe(listener);
}

/**
 * 销毁全局 Store（测试用）
 */
export function destroyGlobalStore(): void {
  globalStore = null;
}
