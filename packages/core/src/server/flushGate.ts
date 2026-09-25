/** 在历史回放期间缓存新消息，并按序结束、丢弃或转移队列。 */

export class FlushGate<T> {
  private _active = false;
  private queue: T[] = [];

  /** 是否正在 flush（队列模式） */
  get active(): boolean {
    return this._active;
  }

  /** 开始 flush — 后续 enqueue() 会缓冲消息 */
  start(): void {
    this._active = true;
    this.queue = [];
  }

  /**
   * 尝试入队。
   * @returns true 如果消息被缓冲（flush 中），调用方不应立即发送
   * @returns false 如果不在 flush 中，调用方应立即发送
   */
  enqueue(...items: T[]): boolean {
    if (!this._active) return false;
    this.queue.push(...items);
    return true;
  }

  /**
   * 结束 flush — 返回排队的消息，调用方应按序发送。
   * 切回非队列模式。
   */
  end(): T[] {
    this._active = false;
    const drained = this.queue;
    this.queue = [];
    return drained;
  }

  /**
   * 丢弃队列（传输死亡时调用）。
   * 消息不会被发送。
   */
  drop(): void {
    this._active = false;
    this.queue = [];
  }

  /**
   * 停用队列模式但保留排队消息。
   * 用于传输切换：新传输可以 drain() 旧 gate 的消息。
   */
  deactivate(): T[] {
    this._active = false;
    const items = this.queue;
    this.queue = [];
    return items;
  }

  /** 当前排队消息数量 */
  get pendingCount(): number {
    return this.queue.length;
  }
}
