/**
 * Guarded Write Tools - 带写入锁保护的文件操作工具
 *
 * 在多 Agent 协作模式下，确保文件写入的串行化
 * 读取操作不受影响，可以并发执行
 */

import type { Tool } from '@neoxlabs/kernel/types/index.js';
import path from 'path';
import { getGlobalWriteLockManager } from '../runtime/agent/writeLockManager.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

/**
 * 当前 Agent ID（用于锁管理）
 * 在单 Agent 模式下为 'main'
 * 在多 Agent 模式下由 ProcessManager 设置
 */
let currentAgentId = 'main';

/**
 * 设置当前 Agent ID
 */
export function setCurrentAgentId(agentId: string): void {
  currentAgentId = agentId;
}

/**
 * 获取当前 Agent ID
 */
export function getCurrentAgentId(): string {
  return currentAgentId;
}

/**
 * 是否启用写入锁（多 Agent 模式下启用）
 */
let writeLockEnabled = true;

/**
 * 启用写入锁
 */
export function enableWriteLock(): void {
  if (writeLockEnabled) return;
  writeLockEnabled = true;
  cliLogger.info('GUARDED_WRITE', 'Write lock enabled');
}

/**
 * 禁用写入锁
 */
export function disableWriteLock(): void {
  if (!writeLockEnabled) return;
  writeLockEnabled = false;
  cliLogger.info('GUARDED_WRITE', 'Write lock disabled');
}

/**
 * 检查写入锁是否启用
 */
export function isWriteLockEnabled(): boolean {
  return writeLockEnabled;
}

const WRITE_TOOL_NAMES = new Set([
  'write_file',
  'edit',
  'edit_file',
  'delete_file',
  'rename_file',
  'move_file',
  'create_directory',
]);

function normalizeLockPath(rawPath: string): string {
  const cleaned = rawPath.trim();
  if (!cleaned || cleaned === '/dev/null') return '';
  const resolved = path.isAbsolute(cleaned) ? cleaned : path.resolve(process.cwd(), cleaned);
  const normalized = path.normalize(resolved).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function resolveLockTargets(toolName: string, args: any): string[] {
  const lowered = toolName.toLowerCase();
  if (!WRITE_TOOL_NAMES.has(lowered) || !args || typeof args !== 'object') {
    return [];
  }

  const candidates: string[] = [];
  if (typeof args.file_path === 'string') candidates.push(args.file_path);
  if (typeof args.filePath === 'string') candidates.push(args.filePath);
  if (typeof args.path === 'string') candidates.push(args.path);
  if (typeof args.file === 'string') candidates.push(args.file);
  if (typeof args.old_path === 'string') candidates.push(args.old_path);
  if (typeof args.new_path === 'string') candidates.push(args.new_path);
  if (typeof args.source_path === 'string') candidates.push(args.source_path);
  if (typeof args.destination_path === 'string') candidates.push(args.destination_path);

  return Array.from(new Set(
    candidates
      .map((item) => normalizeLockPath(item))
      .filter((item) => item.length > 0)
  )).sort();
}

function createWrappedTool(tool: Tool, agentIdOverride?: string): Tool {
  const originalFunction = tool.function;

  return {
    ...tool,
    function: async (args: any, context?: { signal?: AbortSignal }) => {
      // 如果未启用写入锁，直接执行
      if (!writeLockEnabled) {
        return originalFunction(args, context);
      }

      const lockTargets = resolveLockTargets(tool.name, args);
      if (lockTargets.length === 0) {
        return originalFunction(args, context);
      }

      const lockManager = getGlobalWriteLockManager();
      const agentId = agentIdOverride ?? currentAgentId;
      const acquiredTargets: string[] = [];

      for (const lockTarget of lockTargets) {
        const lockResult = await lockManager.acquire(lockTarget, agentId);
        if (!lockResult.success) {
          cliLogger.warn('GUARDED_WRITE', `Failed to acquire lock for ${lockTarget}`, {
            agentId,
            heldBy: lockResult.heldBy,
            waitTime: lockResult.waitTime,
          });
          for (let i = acquiredTargets.length - 1; i >= 0; i--) {
            lockManager.release(acquiredTargets[i], agentId);
          }
          return JSON.stringify({
            tool: tool.name,
            status: 'error',
            message: `Write lock timeout: path ${lockTarget} is being written by another agent`,
            details: {
              path: lockTarget,
              held_by: lockResult.heldBy,
              wait_time_ms: lockResult.waitTime,
            },
          });
        }
        acquiredTargets.push(lockTarget);
      }

      try {
        return await originalFunction(args, context);
      } finally {
        for (let i = acquiredTargets.length - 1; i >= 0; i--) {
          lockManager.release(acquiredTargets[i], agentId);
        }
      }
    },
  };
}

/**
 * 包装写入工具，添加锁保护
 */
export function wrapWithWriteLock(tool: Tool): Tool {
  return createWrappedTool(tool);
}

/**
 * 为指定 Agent 包装写入工具
 */
export function wrapWithWriteLockForAgent(tool: Tool, agentId: string): Tool {
  return createWrappedTool(tool, agentId);
}

/**
 * 批量包装写入工具
 */
export function wrapWriteTools(tools: Tool[], agentId?: string): Tool[] {
  return tools.map((tool) => {
    if (WRITE_TOOL_NAMES.has(tool.name.toLowerCase())) {
      return agentId ? wrapWithWriteLockForAgent(tool, agentId) : wrapWithWriteLock(tool);
    }
    return tool;
  });
}

/**
 * 释放当前 Agent 持有的所有锁
 * 在 Agent 终止时调用
 */
export function releaseAllLocksForCurrentAgent(): number {
  const lockManager = getGlobalWriteLockManager();
  return lockManager.releaseAll(currentAgentId);
}

/**
 * 获取锁状态统计
 */
export function getWriteLockStats(): {
  enabled: boolean;
  currentAgentId: string;
  activeLocks: number;
  waitingRequests: number;
} {
  const lockManager = getGlobalWriteLockManager();
  const stats = lockManager.getStats();

  return {
    enabled: writeLockEnabled,
    currentAgentId,
    activeLocks: stats.activeLocks,
    waitingRequests: stats.waitingRequests,
  };
}
