/**
 * SharedContext - Agent 间共享上下文
 *
 * 用于在多个 Agent 之间共享信息：
 * 1. 全局上下文：所有 Agent 可见
 * 2. Agent 间通信：发布/订阅模式
 * 3. 依赖数据传递：任务结果共享
 */

import { EventEmitter } from 'events';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

export interface ContextEntry {
  key: string;
  value: unknown;
  source: string;      // 来源 Agent ID
  timestamp: number;
  ttl?: number;        // 生存时间（ms），undefined 表示永久
}

export interface AgentMessage {
  from: string;
  to: string | '*';    // '*' 表示广播
  type: 'data' | 'request' | 'response' | 'notification';
  payload: unknown;
  timestamp: number;
  correlationId?: string;  // 用于请求/响应关联
}

export interface TaskResult {
  taskId: string;
  agentId: string;
  success: boolean;
  output?: unknown;
  error?: string;
  timestamp: number;
}

export interface SharedContextOptions {
  /** 上下文最大条目数 */
  maxEntries?: number;
  /** 默认 TTL（ms） */
  defaultTtl?: number;
  /** 是否启用消息历史 */
  enableMessageHistory?: boolean;
  /** 消息历史最大长度 */
  maxMessageHistory?: number;
}

export class SharedContext extends EventEmitter {
  private context: Map<string, ContextEntry> = new Map();
  private taskResults: Map<string, TaskResult> = new Map();
  private messageHistory: AgentMessage[] = [];
  private options: Required<SharedContextOptions>;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(options: SharedContextOptions = {}) {
    super();
    this.options = {
      maxEntries: options.maxEntries ?? 1000,
      defaultTtl: options.defaultTtl ?? 0,  // 0 = 永久
      enableMessageHistory: options.enableMessageHistory ?? true,
      maxMessageHistory: options.maxMessageHistory ?? 100,
    };

    // 定期清理过期条目
    this.startCleanup();
  }

  // ==================== 上下文操作 ====================

  /**
   * 设置上下文值
   */
  set(key: string, value: unknown, source: string, ttl?: number): void {
    // 限制条目数
    if (this.context.size >= this.options.maxEntries) {
      this.evictOldest();
    }

    const entry: ContextEntry = {
      key,
      value,
      source,
      timestamp: Date.now(),
      ttl: ttl ?? (this.options.defaultTtl > 0 ? this.options.defaultTtl : undefined),
    };

    this.context.set(key, entry);
    cliLogger.debug('SHARED_CONTEXT', `Set: ${key}`, { source, hasValue: value !== undefined });

    this.emit('context_updated', { key, source, type: 'set' });
  }

  /**
   * 获取上下文值
   */
  get<T = unknown>(key: string): T | undefined {
    const entry = this.context.get(key);
    if (!entry) return undefined;

    // 检查是否过期
    if (entry.ttl && Date.now() - entry.timestamp > entry.ttl) {
      this.context.delete(key);
      return undefined;
    }

    return entry.value as T;
  }

  /**
   * 获取带元信息的上下文条目
   */
  getEntry(key: string): ContextEntry | undefined {
    return this.context.get(key);
  }

  /**
   * 检查键是否存在
   */
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /**
   * 删除上下文值
   */
  delete(key: string): boolean {
    const existed = this.context.delete(key);
    if (existed) {
      this.emit('context_updated', { key, type: 'delete' });
    }
    return existed;
  }

  /**
   * 获取所有键
   */
  keys(): string[] {
    return Array.from(this.context.keys());
  }

  /**
   * 获取某个 Agent 设置的所有上下文
   */
  getBySource(source: string): Map<string, unknown> {
    const result = new Map<string, unknown>();
    for (const [key, entry] of this.context) {
      if (entry.source === source) {
        result.set(key, entry.value);
      }
    }
    return result;
  }

  // ==================== Agent 间通信 ====================

  /**
   * 发送消息到其他 Agent
   */
  sendMessage(message: Omit<AgentMessage, 'timestamp'>): void {
    const fullMessage: AgentMessage = {
      ...message,
      timestamp: Date.now(),
    };

    cliLogger.debug('SHARED_CONTEXT', 'Message sent', {
      from: message.from,
      to: message.to,
      type: message.type,
    });

    // 存储消息历史
    if (this.options.enableMessageHistory) {
      this.messageHistory.push(fullMessage);
      if (this.messageHistory.length > this.options.maxMessageHistory) {
        this.messageHistory.shift();
      }
    }

    // 发送事件
    this.emit('message', fullMessage);

    // 如果是广播，额外发送 broadcast 事件
    if (message.to === '*') {
      this.emit('broadcast', fullMessage);
    } else {
      // 定向消息
      this.emit(`message:${message.to}`, fullMessage);
    }
  }

  /**
   * 订阅发送给特定 Agent 的消息
   */
  subscribeMessages(agentId: string, handler: (msg: AgentMessage) => void): () => void {
    const listener = (msg: AgentMessage) => {
      handler(msg);
    };

    // 订阅定向消息和广播
    this.on(`message:${agentId}`, listener);
    this.on('broadcast', listener);

    // 返回取消订阅函数
    return () => {
      this.off(`message:${agentId}`, listener);
      this.off('broadcast', listener);
    };
  }

  /**
   * 获取消息历史
   */
  getMessageHistory(filter?: {
    from?: string;
    to?: string;
    type?: AgentMessage['type'];
    since?: number;
  }): AgentMessage[] {
    if (!filter) return [...this.messageHistory];

    return this.messageHistory.filter((msg) => {
      if (filter.from && msg.from !== filter.from) return false;
      if (filter.to && msg.to !== filter.to) return false;
      if (filter.type && msg.type !== filter.type) return false;
      if (filter.since && msg.timestamp < filter.since) return false;
      return true;
    });
  }

  // ==================== 任务结果共享 ====================

  /**
   * 存储任务结果
   */
  storeTaskResult(result: TaskResult): void {
    this.taskResults.set(result.taskId, result);
    cliLogger.debug('SHARED_CONTEXT', 'Task result stored', {
      taskId: result.taskId,
      agentId: result.agentId,
      success: result.success,
    });

    this.emit('task_result', result);
  }

  /**
   * 获取任务结果
   */
  getTaskResult(taskId: string): TaskResult | undefined {
    return this.taskResults.get(taskId);
  }

  /**
   * 等待任务结果
   */
  async waitForTaskResult(taskId: string, timeoutMs: number = 30000): Promise<TaskResult> {
    // 先检查是否已有结果
    const existing = this.taskResults.get(taskId);
    if (existing) return existing;

    // 等待结果
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.off('task_result', listener);
        reject(new Error(`Timeout waiting for task ${taskId}`));
      }, timeoutMs);

      const listener = (result: TaskResult) => {
        if (result.taskId === taskId) {
          clearTimeout(timeout);
          this.off('task_result', listener);
          resolve(result);
        }
      };

      this.on('task_result', listener);
    });
  }

  /**
   * 获取 Agent 的所有任务结果
   */
  getAgentResults(agentId: string): TaskResult[] {
    return Array.from(this.taskResults.values())
      .filter(r => r.agentId === agentId);
  }

  // ==================== 依赖管理 ====================

  /**
   * 检查依赖是否满足
   */
  checkDependencies(taskIds: string[]): {
    satisfied: boolean;
    missing: string[];
    failed: string[];
  } {
    const missing: string[] = [];
    const failed: string[] = [];

    for (const taskId of taskIds) {
      const result = this.taskResults.get(taskId);
      if (!result) {
        missing.push(taskId);
      } else if (!result.success) {
        failed.push(taskId);
      }
    }

    return {
      satisfied: missing.length === 0 && failed.length === 0,
      missing,
      failed,
    };
  }

  /**
   * 等待所有依赖完成
   */
  async waitForDependencies(
    taskIds: string[],
    timeoutMs: number = 60000
  ): Promise<Map<string, TaskResult>> {
    const results = new Map<string, TaskResult>();
    const pending = new Set(taskIds);

    // 先收集已有结果
    for (const taskId of taskIds) {
      const result = this.taskResults.get(taskId);
      if (result) {
        results.set(taskId, result);
        pending.delete(taskId);
      }
    }

    if (pending.size === 0) {
      return results;
    }

    // 等待剩余结果
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.off('task_result', listener);
        reject(new Error(`Timeout waiting for dependencies: ${Array.from(pending).join(', ')}`));
      }, timeoutMs);

      const listener = (result: TaskResult) => {
        if (pending.has(result.taskId)) {
          results.set(result.taskId, result);
          pending.delete(result.taskId);

          if (pending.size === 0) {
            clearTimeout(timeout);
            this.off('task_result', listener);
            resolve(results);
          }
        }
      };

      this.on('task_result', listener);
    });
  }

  // ==================== 生命周期管理 ====================

  /**
   * 清空所有数据
   */
  clear(): void {
    this.context.clear();
    this.taskResults.clear();
    this.messageHistory = [];
    this.emit('cleared');
  }

  /**
   * 销毁实例
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.clear();
    this.removeAllListeners();
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    contextEntries: number;
    taskResults: number;
    messageHistory: number;
  } {
    return {
      contextEntries: this.context.size,
      taskResults: this.taskResults.size,
      messageHistory: this.messageHistory.length,
    };
  }

  // ==================== 私有方法 ====================

  private startCleanup(): void {
    // 每分钟清理一次过期条目
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpired();
    }, 60000);
  }

  private cleanupExpired(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.context) {
      if (entry.ttl && now - entry.timestamp > entry.ttl) {
        this.context.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      cliLogger.debug('SHARED_CONTEXT', `Cleaned ${cleaned} expired entries`);
    }
  }

  private evictOldest(): void {
    // 找到最老的条目并删除
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.context) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.context.delete(oldestKey);
      cliLogger.debug('SHARED_CONTEXT', `Evicted oldest entry: ${oldestKey}`);
    }
  }
}

/** 创建共享上下文实例 */
export function createSharedContext(options?: SharedContextOptions): SharedContext {
  return new SharedContext(options);
}
