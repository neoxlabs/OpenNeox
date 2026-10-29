/**
 * Memory Session 实现
 *
 * 纯内存存储，用于临时会话或测试
 * 重启后数据丢失
 */

import type {
  Session,
  SessionItem,
  SessionMeta,
  CheckpointItem,
  MessageItem,
  TimestampedSessionItem
} from '@neoxlabs/kernel/types/session.js';
import type { Message } from '@neoxlabs/kernel/types/index.js';
import { generateSessionId } from '@neoxlabs/kernel/types/session.js';

// ============================================================================
// 配置
// ============================================================================

export interface MemorySessionOptions {
  /** 会话 ID */
  sessionId: string;
  /** Agent 名称 */
  agentName?: string;
  /** 模型名称 */
  model?: string;
  /** 最大项目数（可选，超出则自动清理旧项目） */
  maxItems?: number;
}

// ============================================================================
// MemorySession 实现
// ============================================================================

export class MemorySession implements Session {
  readonly sessionId: string;
  private items: TimestampedSessionItem[] = [];
  private sequenceNumber: number = 0;
  private options: MemorySessionOptions;
  private meta: SessionMeta | null = null;

  constructor(options: MemorySessionOptions | string) {
    if (typeof options === 'string') {
      options = { sessionId: options };
    }

    this.sessionId = options.sessionId;
    this.options = options;

    // 创建元数据
    this.meta = {
      sessionId: this.sessionId,
      createdAt: new Date().toISOString(),
      agentName: options.agentName,
      model: options.model
    };

    // 添加元数据项
    this.addItemInternal({ type: 'meta', data: this.meta });
  }

  // --------------------------------------------------------------------------
  // 私有方法
  // --------------------------------------------------------------------------

  private addItemInternal(item: SessionItem): void {
    const timestamped: TimestampedSessionItem = {
      item,
      timestamp: Date.now(),
      seq: this.sequenceNumber++
    };
    this.items.push(timestamped);

    // 检查是否需要清理
    if (this.options.maxItems && this.items.length > this.options.maxItems) {
      // 保留元数据和检查点，清理旧消息
      const meta = this.items.filter(ti => ti.item.type === 'meta');
      const checkpoints = this.items.filter(ti => ti.item.type === 'checkpoint');
      const others = this.items.filter(
        ti => ti.item.type !== 'meta' && ti.item.type !== 'checkpoint'
      );

      const keepCount = this.options.maxItems - meta.length - checkpoints.length;
      const keptOthers = others.slice(-keepCount);

      this.items = [...meta, ...checkpoints, ...keptOthers];
      this.items.sort((a, b) => a.seq - b.seq);
    }
  }

  // --------------------------------------------------------------------------
  // 公共接口实现
  // --------------------------------------------------------------------------

  async getItems(limit?: number): Promise<SessionItem[]> {
    const items = this.items.map(ti => ti.item);

    if (limit === undefined) {
      return items;
    }
    return items.slice(-limit);
  }

  async addItems(items: SessionItem[]): Promise<void> {
    for (const item of items) {
      this.addItemInternal(item);
    }
  }

  async popItem(): Promise<SessionItem | null> {
    if (this.items.length === 0) return null;

    // 不允许删除元数据
    let index = this.items.length - 1;
    while (index >= 0 && this.items[index].item.type === 'meta') {
      index--;
    }

    if (index < 0) return null;

    const [popped] = this.items.splice(index, 1);
    return popped.item;
  }

  async popItems(count: number): Promise<SessionItem[]> {
    if (count <= 0) return [];

    const popped: SessionItem[] = [];

    for (let i = 0; i < count; i++) {
      const item = await this.popItem();
      if (item === null) break;
      popped.unshift(item); // 保持顺序
    }

    return popped;
  }

  async createCheckpoint(name?: string, description?: string, fileCheckpointId?: string): Promise<string> {
    const checkpointId = `cp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    const checkpoint: CheckpointItem = {
      type: 'checkpoint',
      data: {
        id: checkpointId,
        name,
        description,
        fileCheckpointId
      }
    };

    this.addItemInternal(checkpoint);
    return checkpointId;
  }

  async rollbackToCheckpoint(checkpointId: string): Promise<number> {
    const checkpointIndex = this.items.findIndex(
      ti => ti.item.type === 'checkpoint' &&
           (ti.item as CheckpointItem).data.id === checkpointId
    );

    if (checkpointIndex === -1) {
      throw new Error(`Checkpoint not found: ${checkpointId}`);
    }

    const removedCount = this.items.length - checkpointIndex - 1;
    this.items = this.items.slice(0, checkpointIndex + 1);

    return removedCount;
  }

  async getCheckpoints(): Promise<Array<{ id: string; name?: string; timestamp: number }>> {
    const checkpoints: Array<{ id: string; name?: string; timestamp: number }> = [];

    for (const ti of this.items) {
      if (ti.item.type === 'checkpoint') {
        const cp = ti.item as CheckpointItem;
        checkpoints.push({
          id: cp.data.id,
          name: cp.data.name,
          timestamp: ti.timestamp
        });
      }
    }

    return checkpoints;
  }

  async clearSession(): Promise<void> {
    this.items = [];
    this.sequenceNumber = 0;
    this.meta = null;
  }

  async getMeta(): Promise<SessionMeta | null> {
    return this.meta;
  }

  async getMessages(): Promise<Message[]> {
    const messages: Message[] = [];

    for (const ti of this.items) {
      if (ti.item.type === 'message') {
        messages.push((ti.item as MessageItem).data);
      }
    }

    return messages;
  }

  async getItemCount(): Promise<number> {
    return this.items.length;
  }

  async getTimeline(): Promise<TimestampedSessionItem[]> {
    return this.items.map(item => ({ ...item }));
  }

  async replaceTimeline(items: TimestampedSessionItem[]): Promise<void> {
    this.items = items.map((item, index) => ({
      item: item.item,
      timestamp: item.timestamp ?? Date.now(),
      seq: index,
    }));
    this.sequenceNumber = this.items.length;
  }

  // --------------------------------------------------------------------------
  // 静态工具方法
  // --------------------------------------------------------------------------

  /**
   * 创建新会话（带自动 ID）
   */
  static create(options?: Omit<MemorySessionOptions, 'sessionId'>): MemorySession {
    return new MemorySession({
      sessionId: generateSessionId(),
      ...options
    });
  }
}
