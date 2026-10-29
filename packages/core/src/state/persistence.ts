
import * as fs from 'fs';
import * as path from 'path';
import type { NeoxAppState, ApprovalHistoryEntry } from './appState.js';
import { getDefaultAppState } from './appState.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

// ─── 配置 ───

/** 审批历史最大保留条数 */
const MAX_APPROVAL_HISTORY = 500;
/** 审批历史保留天数 */
const APPROVAL_HISTORY_TTL_DAYS = 90;

// ─── 快照类型 ───

export interface StateSnapshot {
  /** 快照版本（用于前向兼容） */
  version: 2;
  /** 快照时间 */
  timestamp: number;
  /** 工作目录 */
  workDir: string;
  /** 运行模式 */
  runMode: string;
  /** 权限模式 */
  permissionMode: string;
  /** 设置 */
  settings: NeoxAppState['settings'];
  /** UI 状态 */
  ui: NeoxAppState['ui'];
  /** 工具指标 */
  toolMetrics: NeoxAppState['toolMetrics'];
  /** Auth 版本 */
  authVersion: number;
  /** MCP 启用状态 */
  mcpEnabled: boolean;
}

// ─── 快照 ───

/**
 * 创建状态快照（可恢复的最小子集）
 * 不保存会话/连接等瞬时状态
 */
export function createSnapshot(state: NeoxAppState): StateSnapshot {
  return {
    version: 2,
    timestamp: Date.now(),
    workDir: state.workDir,
    runMode: state.runMode,
    permissionMode: state.permissions.mode,
    settings: { ...state.settings },
    ui: { ...state.ui },
    toolMetrics: { ...state.toolMetrics },
    authVersion: state.authVersion,
    mcpEnabled: state.mcp.enabled,
  };
}

/**
 * 从快照恢复状态（合并到默认状态）
 */
export function restoreFromSnapshot(
  snapshot: StateSnapshot,
  options?: { workDir?: string; version?: string },
): NeoxAppState {
  const base = getDefaultAppState(options);

  // 版本校验
  if (!snapshot || snapshot.version !== 2) {
    cliLogger.warn('STATE', 'Invalid snapshot version, using defaults');
    return base;
  }

  return {
    ...base,
    workDir: options?.workDir ?? snapshot.workDir,
    runMode: snapshot.runMode as any,
    permissions: {
      ...base.permissions,
      mode: snapshot.permissionMode as any,
    },
    settings: { ...base.settings, ...snapshot.settings },
    ui: { ...base.ui, ...snapshot.ui },
    toolMetrics: snapshot.toolMetrics ?? base.toolMetrics,
    authVersion: snapshot.authVersion ?? 0,
    mcp: { ...base.mcp, enabled: snapshot.mcpEnabled ?? true },
  };
}

// ─── 文件持久化 ───

/**
 * 原子写入 JSON 文件
 */
function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmp = `${filePath}.tmp.${process.pid}`;
  const json = JSON.stringify(data, null, 2);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, json, null, 'utf-8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

/**
 * 安全读取 JSON 文件
 */
function safeReadJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ─── 快照持久化 ───

/**
 * 保存状态快照到磁盘
 */
export function saveSnapshot(configDir: string, state: NeoxAppState): void {
  try {
    const snapshot = createSnapshot(state);
    const filePath = path.join(configDir, 'state-snapshot.json');
    atomicWriteJson(filePath, snapshot);
  } catch (err) {
    cliLogger.warn('STATE', `Failed to save snapshot: ${(err as Error).message}`);
  }
}

/**
 * 从磁盘加载状态快照
 */
export function loadSnapshot(configDir: string): StateSnapshot | null {
  const filePath = path.join(configDir, 'state-snapshot.json');
  return safeReadJson<StateSnapshot>(filePath);
}

// ─── 审批历史持久化 ───

/**
 * 保存审批历史到磁盘
 */
export function saveApprovalHistory(configDir: string, history: ApprovalHistoryEntry[]): void {
  try {
    // 清理过期记录
    const cutoff = Date.now() - APPROVAL_HISTORY_TTL_DAYS * 24 * 60 * 60 * 1000;
    let trimmed = history.filter(h => h.timestamp > cutoff);

    // 容量限制
    if (trimmed.length > MAX_APPROVAL_HISTORY) {
      trimmed = trimmed.slice(trimmed.length - MAX_APPROVAL_HISTORY);
    }

    const filePath = path.join(configDir, 'approval-history.json');
    atomicWriteJson(filePath, trimmed);
  } catch (err) {
    cliLogger.warn('STATE', `Failed to save approval history: ${(err as Error).message}`);
  }
}

/**
 * 从磁盘加载审批历史
 */
export function loadApprovalHistory(configDir: string): ApprovalHistoryEntry[] {
  const filePath = path.join(configDir, 'approval-history.json');
  return safeReadJson<ApprovalHistoryEntry[]>(filePath) ?? [];
}

// ─── 工具指标持久化 ───

/**
 * 保存工具指标到磁盘
 */
export function saveToolMetrics(configDir: string, metrics: NeoxAppState['toolMetrics']): void {
  try {
    const filePath = path.join(configDir, 'tool-metrics.json');
    atomicWriteJson(filePath, metrics);
  } catch (err) {
    cliLogger.warn('STATE', `Failed to save tool metrics: ${(err as Error).message}`);
  }
}

/**
 * 从磁盘加载工具指标
 */
export function loadToolMetrics(configDir: string): NeoxAppState['toolMetrics'] | null {
  const filePath = path.join(configDir, 'tool-metrics.json');
  return safeReadJson<NeoxAppState['toolMetrics']>(filePath);
}
