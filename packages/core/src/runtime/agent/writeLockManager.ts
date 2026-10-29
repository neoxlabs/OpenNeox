/**
 * WriteLockManager - 文件写入锁管理器
 *
 * 核心原则：读并发，写串行
 * - 多个 Agent 可以同时读取文件
 * - 写入前必须获取文件锁
 * - 同一时间只有一个 Agent 可以写入同一文件
 */

import { EventEmitter } from 'events';
import path from 'path';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { withRunPhase } from '@neoxlabs/kernel/utils/runTrace.js';

/**
 * 锁状态
 */
export interface LockInfo {
  /** 持有锁的 Agent ID */
  agentId: string;
  /** 文件路径 */
  path: string;
  /** 获取锁的时间 */
  acquiredAt: number;
  /** 锁的过期时间（防止死锁） */
  expiresAt: number;
}

/**
 * 锁请求结果
 */
export interface LockResult {
  success: boolean;
  /** 如果失败，当前持有锁的 Agent */
  heldBy?: string;
  /** 等待时间（毫秒） */
  waitTime?: number;
}

/**
 * WriteLockManager 配置
 */
export interface WriteLockManagerOptions {
  /** 默认锁超时时间（毫秒），默认 30 秒 */
  defaultTimeout?: number;
  /** 锁过期时间（毫秒），默认 60 秒，防止死锁 */
  lockTTL?: number;
  /** 重试间隔（毫秒），默认 100ms */
  retryInterval?: number;
}

export class WriteLockManager extends EventEmitter {
  private locks: Map<string, LockInfo> = new Map();
  private waitQueues: Map<string, Array<{
    agentId: string;
    resolve: (result: LockResult) => void;
    timeoutId: NodeJS.Timeout;
  }>> = new Map();

  private defaultTimeout: number;
  private lockTTL: number;
  private retryInterval: number;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(options: WriteLockManagerOptions = {}) {
    super();
    this.defaultTimeout = options.defaultTimeout ?? 30000;
    this.lockTTL = options.lockTTL ?? 60000;
    this.retryInterval = options.retryInterval ?? 100;

    // 启动定期清理过期锁
    this.startCleanup();
  }

  /**
   * 获取文件写入锁
   *
   * @param path 文件路径
   * @param agentId Agent ID
   * @param timeoutMs 超时时间（毫秒）
   * @returns 是否成功获取锁
   */
  async acquire(
    path: string,
    agentId: string,
    timeoutMs?: number
  ): Promise<LockResult> {
    const timeout = timeoutMs ?? this.defaultTimeout;
    const normalizedPath = this.normalizePath(path);
    const startTime = Date.now();

    // 尝试立即获取锁
    const immediateResult = this.tryAcquire(normalizedPath, agentId);
    if (immediateResult.success) {
      return immediateResult;
    }

    // 如果锁被占用，加入等待队列。
    //    立即获取成功的路径不套帧(不阻塞),只有真等待才进 phaseStack。
    return withRunPhase(
      'lock',
      `lock:${normalizedPath}`,
      () => this.waitForLock(normalizedPath, agentId, timeout, startTime),
      { heldBy: immediateResult.heldBy, agentId },
    );
  }

  /**
   * 尝试立即获取锁（不等待）
   */
  tryAcquire(path: string, agentId: string): LockResult {
    const normalizedPath = this.normalizePath(path);
    const existingLock = this.locks.get(normalizedPath);

    // 检查是否已有锁
    if (existingLock) {
      // 检查锁是否过期
      if (Date.now() > existingLock.expiresAt) {
        cliLogger.warn('WRITE_LOCK', `Lock expired for ${normalizedPath}`, {
          previousHolder: existingLock.agentId,
        });
        this.locks.delete(normalizedPath);
      } else {
        // 锁已被占用（同 Agent 并发也必须等待，避免同文件并发写）
        return { success: false, heldBy: existingLock.agentId };
      }
    }

    // 获取锁
    const now = Date.now();
    this.locks.set(normalizedPath, {
      agentId,
      path: normalizedPath,
      acquiredAt: now,
      expiresAt: now + this.lockTTL,
    });

    cliLogger.debug('WRITE_LOCK', `Lock acquired: ${normalizedPath}`, { agentId });
    this.emit('lock_acquired', { path: normalizedPath, agentId });

    return { success: true, waitTime: 0 };
  }

  /**
   * 等待获取锁
   */
  private waitForLock(
    path: string,
    agentId: string,
    timeoutMs: number,
    startTime: number
  ): Promise<LockResult> {
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        // 超时，从队列中移除
        this.removeFromQueue(path, agentId);
        const heldBy = this.locks.get(path)?.agentId;
        // 诊断:写锁等待超时是潜在卡死/争用信号, 升级为 warn 并带定位信息
        cliLogger.warn('WRITE_LOCK', `⏱️ Lock wait timed out after ${timeoutMs}ms`, {
          path,
          requester: agentId,
          heldBy,
          waitedMs: Date.now() - startTime,
          queueDepth: this.waitQueues.get(path)?.length ?? 0,
        });
        resolve({
          success: false,
          heldBy,
          waitTime: Date.now() - startTime,
        });
      }, timeoutMs);

      // 加入等待队列
      if (!this.waitQueues.has(path)) {
        this.waitQueues.set(path, []);
      }

      this.waitQueues.get(path)!.push({
        agentId,
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve({ ...result, waitTime: Date.now() - startTime });
        },
        timeoutId,
      });

      cliLogger.debug('WRITE_LOCK', `Waiting for lock: ${path}`, { agentId });
    });
  }

  /**
   * 释放文件写入锁
   */
  release(path: string, agentId: string): boolean {
    const normalizedPath = this.normalizePath(path);
    const lock = this.locks.get(normalizedPath);

    if (!lock) {
      cliLogger.warn('WRITE_LOCK', `No lock to release: ${normalizedPath}`);
      return false;
    }

    if (lock.agentId !== agentId) {
      cliLogger.warn('WRITE_LOCK', `Cannot release lock held by another agent`, {
        path: normalizedPath,
        holder: lock.agentId,
        requester: agentId,
      });
      return false;
    }

    // 释放锁
    this.locks.delete(normalizedPath);
    cliLogger.debug('WRITE_LOCK', `Lock released: ${normalizedPath}`, { agentId });
    this.emit('lock_released', { path: normalizedPath, agentId });

    // 唤醒等待队列中的下一个
    this.processWaitQueue(normalizedPath);

    return true;
  }

  /**
   * 释放指定 Agent 持有的所有锁
   */
  releaseAll(agentId: string): number {
    let released = 0;
    const entries = Array.from(this.locks.entries());
    for (const [path, lock] of entries) {
      if (lock.agentId === agentId) {
        this.locks.delete(path);
        this.emit('lock_released', { path, agentId });
        this.processWaitQueue(path);
        released++;
      }
    }

    if (released > 0) {
      cliLogger.info('WRITE_LOCK', `Released ${released} locks for agent`, { agentId });
    }

    return released;
  }

  /**
   * 检查文件是否被锁定
   */
  isLocked(path: string): boolean {
    const normalizedPath = this.normalizePath(path);
    const lock = this.locks.get(normalizedPath);
    if (!lock) return false;

    // 检查是否过期
    if (Date.now() > lock.expiresAt) {
      this.locks.delete(normalizedPath);
      return false;
    }

    return true;
  }

  /**
   * 获取锁信息
   */
  getLockInfo(path: string): LockInfo | undefined {
    const normalizedPath = this.normalizePath(path);
    return this.locks.get(normalizedPath);
  }

  /**
   * 获取所有锁信息
   */
  getAllLocks(): LockInfo[] {
    return Array.from(this.locks.values());
  }

  /**
   * 获取指定 Agent 持有的所有锁
   */
  getLocksForAgent(agentId: string): LockInfo[] {
    return Array.from(this.locks.values()).filter(
      (lock) => lock.agentId === agentId
    );
  }

  /**
   * 处理等待队列
   */
  private processWaitQueue(path: string): void {
    const queue = this.waitQueues.get(path);
    if (!queue || queue.length === 0) return;

    // 取出队列中的第一个等待者
    const next = queue.shift();
    if (!next) return;

    // 尝试为其获取锁
    const result = this.tryAcquire(path, next.agentId);
    next.resolve(result);

    // 如果队列为空，删除队列
    if (queue.length === 0) {
      this.waitQueues.delete(path);
    }
  }

  /**
   * 从等待队列中移除
   */
  private removeFromQueue(path: string, agentId: string): void {
    const queue = this.waitQueues.get(path);
    if (!queue) return;

    const index = queue.findIndex((item) => item.agentId === agentId);
    if (index !== -1) {
      clearTimeout(queue[index].timeoutId);
      queue.splice(index, 1);
    }

    if (queue.length === 0) {
      this.waitQueues.delete(path);
    }
  }

  /**
   * 规范化路径
   */
  private normalizePath(rawPath: string): string {
    const resolved = rawPath
      ? (path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath))
      : '';
    const normalized = path.normalize(resolved).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  }

  /**
   * 启动定期清理过期锁
   */
  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredLocks();
    }, this.lockTTL / 2);
    // 清理定时器绝不阻止进程退出(历史隐患:未 unref 导致 CLI 任务结束后进程挂着)
    if (typeof this.cleanupInterval?.unref === 'function') this.cleanupInterval.unref();
  }

  /**
   * 清理过期锁
   */
  private cleanupExpiredLocks(): void {
    const now = Date.now();
    const entries = Array.from(this.locks.entries());
    for (const [path, lock] of entries) {
      if (now > lock.expiresAt) {
        cliLogger.warn('WRITE_LOCK', `Cleaning up expired lock: ${path}`, {
          agentId: lock.agentId,
          expiredAt: new Date(lock.expiresAt).toISOString(),
        });
        this.locks.delete(path);
        this.emit('lock_expired', { path, agentId: lock.agentId });
        this.processWaitQueue(path);
      }
    }
  }

  /**
   * 销毁管理器
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // 清理所有等待队列
    const queues = Array.from(this.waitQueues.values());
    for (const queue of queues) {
      for (const item of queue) {
        clearTimeout(item.timeoutId);
        item.resolve({ success: false });
      }
    }

    this.waitQueues.clear();
    this.locks.clear();
    this.removeAllListeners();
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    activeLocks: number;
    waitingRequests: number;
    locksByAgent: Map<string, number>;
  } {
    const locksByAgent = new Map<string, number>();
    const locks = Array.from(this.locks.values());
    for (const lock of locks) {
      const count = locksByAgent.get(lock.agentId) ?? 0;
      locksByAgent.set(lock.agentId, count + 1);
    }

    let waitingRequests = 0;
    const queues = Array.from(this.waitQueues.values());
    for (const queue of queues) {
      waitingRequests += queue.length;
    }

    return {
      activeLocks: this.locks.size,
      waitingRequests,
      locksByAgent,
    };
  }
}

// 全局单例
let globalWriteLockManager: WriteLockManager | null = null;

/**
 * 获取全局 WriteLockManager 实例
 */
export function getGlobalWriteLockManager(): WriteLockManager {
  if (!globalWriteLockManager) {
    globalWriteLockManager = new WriteLockManager();
  }
  return globalWriteLockManager;
}

/**
 * 重置全局 WriteLockManager（用于测试）
 */
export function resetGlobalWriteLockManager(): void {
  if (globalWriteLockManager) {
    globalWriteLockManager.destroy();
    globalWriteLockManager = null;
  }
}
