/** 跟踪 received、processing、processed、lost 状态，并累计丢批计数。 */

// ─── 类型定义 ───

export type DeliveryStatus = 'received' | 'processing' | 'processed' | 'lost';

export interface DeliveryRecord {
  /** 事件 ID (uuid 或 seq) */
  eventId: string;
  /** 会话 ID */
  sessionId: string;
  /** 当前投递状态 */
  status: DeliveryStatus;
  /** 首次记录时间 */
  receivedAt: number;
  /** 最后状态更新时间 */
  updatedAt: number;
}

export interface DeliveryStats {
  totalReceived: number;
  totalProcessing: number;
  totalProcessed: number;
  totalLost: number;
  droppedBatchCount: number;
}

// ─── DeliveryTracker ───

/** 投递记录保留容量 */
const DELIVERY_RECORD_CAPACITY = 1000;
/** 超时标记为 lost（毫秒） */
const DELIVERY_TIMEOUT_MS = 60_000;

export class DeliveryTracker {
  private records = new Map<string, DeliveryRecord>();
  private recordOrder: string[] = []; // FIFO 用于容量限制
  private _droppedBatchCount = 0;

  // 统计
  private stats: DeliveryStats = {
    totalReceived: 0,
    totalProcessing: 0,
    totalProcessed: 0,
    totalLost: 0,
    droppedBatchCount: 0,
  };

  /**
   * 单调递增的丢批计数器。
   * 调用方在 write 前后对比此值即可检测静默丢弃。
   */
  get droppedBatchCount(): number {
    return this._droppedBatchCount;
  }

  /**
   * 记录丢批事件（write 失败时调用）
   */
  recordDroppedBatch(count = 1): void {
    this._droppedBatchCount += count;
    this.stats.droppedBatchCount = this._droppedBatchCount;
  }

  /**
   * 记录事件到达（received 阶段）
   */
  markReceived(eventId: string, sessionId: string): void {
    const now = Date.now();
    this.ensureCapacity();

    const record: DeliveryRecord = {
      eventId,
      sessionId,
      status: 'received',
      receivedAt: now,
      updatedAt: now,
    };
    this.records.set(eventId, record);
    this.recordOrder.push(eventId);
    this.stats.totalReceived++;
  }

  /**
   * 更新为 processing（已转发给客户端）
   */
  markProcessing(eventId: string): boolean {
    const record = this.records.get(eventId);
    if (!record) return false;
    record.status = 'processing';
    record.updatedAt = Date.now();
    this.stats.totalProcessing++;
    return true;
  }

  /**
   * 更新为 processed（客户端确认处理完成）
   */
  markProcessed(eventId: string): boolean {
    const record = this.records.get(eventId);
    if (!record) return false;
    record.status = 'processed';
    record.updatedAt = Date.now();
    this.stats.totalProcessed++;
    return true;
  }

  /**
   * 获取投递记录
   */
  getRecord(eventId: string): DeliveryRecord | undefined {
    return this.records.get(eventId);
  }

  /**
   * 获取当前统计
   */
  getStats(): DeliveryStats {
    return { ...this.stats };
  }

  /**
   * 检查超时的投递并标记为 lost
   */
  sweepTimeouts(): number {
    const now = Date.now();
    let lostCount = 0;
    this.records.forEach((record) => {
      if (
        record.status !== 'processed' &&
        record.status !== 'lost' &&
        now - record.receivedAt > DELIVERY_TIMEOUT_MS
      ) {
        record.status = 'lost';
        record.updatedAt = now;
        lostCount++;
        this.stats.totalLost++;
      }
    });
    return lostCount;
  }

  /**
   * 获取指定 session 的未确认事件 ID
   */
  getPendingForSession(sessionId: string): string[] {
    const pending: string[] = [];
    this.records.forEach((record) => {
      if (record.sessionId === sessionId && record.status !== 'processed' && record.status !== 'lost') {
        pending.push(record.eventId);
      }
    });
    return pending;
  }

  /**
   * 清理指定 session 的投递记录
   */
  clearSession(sessionId: string): void {
    const toDelete: string[] = [];
    this.records.forEach((record, eventId) => {
      if (record.sessionId === sessionId) {
        toDelete.push(eventId);
      }
    });
    for (const id of toDelete) {
      this.records.delete(id);
    }
  }

  /**
   * 重置所有状态
   */
  clear(): void {
    this.records.clear();
    this.recordOrder = [];
    this._droppedBatchCount = 0;
    this.stats = {
      totalReceived: 0,
      totalProcessing: 0,
      totalProcessed: 0,
      totalLost: 0,
      droppedBatchCount: 0,
    };
  }

  // ─── 内部 ───

  private ensureCapacity(): void {
    while (this.records.size >= DELIVERY_RECORD_CAPACITY && this.recordOrder.length > 0) {
      const oldest = this.recordOrder.shift()!;
      this.records.delete(oldest);
    }
  }
}
