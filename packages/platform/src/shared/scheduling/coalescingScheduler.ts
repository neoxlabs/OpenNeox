/**
 * CoalescingScheduler —— IntelliJ `MergingUpdateQueue` 的 TypeScript 对应物.
 *
 * 高频事件 (光标移动、文本输入、watcher 抖动、decoration 刷新) 会把同一个
 * 逻辑更新反复排队. Scheduler 用 *identity* 聚合: 同 identity 的更新只保留
 * 最新一个, 到达 `delayMs` 后整批执行. `maxDelayMs` 防止持续高频抖动导致
 * 饥饿. 优先级决定 batch 内的执行顺序.
 *
 * 这一层是 Phase 2 DumbMode / Phase 3 索引刷新 / Phase 5 AST 重解析都要复用
 * 的基础设施 —— 不要直接在业务里写 setTimeout + dedupe.
 */
export type UpdatePriority = 'high' | 'normal' | 'low';

export interface ScheduledUpdate {
  /** 相同 identity 的 update 会互相合并, 只保留被 `eatenBy` 留下的那个. */
  readonly identity: string;
  /** 实际要跑的工作. 可以返回 Promise; scheduler 会在 `flush()` 时 await. */
  run(): void | Promise<void>;
  /** batch 内执行顺序. 默认 `normal`. */
  readonly priority?: UpdatePriority;
  /**
   * 自定义合并规则: 新 update 是否被已排队的 other 取代 (返回 true 则丢弃自己).
   * 默认实现 = "最新 wins" (总是取代已存在的同 identity 更新).
   */
  eatenBy?(other: ScheduledUpdate): boolean;
}

export interface SchedulerOptions {
  /** 正常延迟窗口. 默认 50ms. */
  delayMs?: number;
  /** 饥饿上限: 首次入队到执行最多等 maxDelayMs. 默认 200ms. */
  maxDelayMs?: number;
  /** dispose 时是否先 flush 再清空. 默认 false (直接丢弃 pending). */
  flushOnDispose?: boolean;
  /** update.run() 抛异常时的兜底. 默认 console.error. */
  errorHandler?: (err: unknown, identity: string) => void;
  /** 测试注入用, 控制 "现在". 生产保持默认. */
  now?: () => number;
  /** 测试注入用, 控制定时器. 生产保持默认. */
  setTimeout?: (fn: () => void, delay: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

interface QueuedEntry {
  update: ScheduledUpdate;
  firstEnqueuedAt: number;
}

const PRIORITY_ORDER: Record<UpdatePriority, number> = { high: 0, normal: 1, low: 2 };

export class CoalescingScheduler {
  private readonly delayMs: number;
  private readonly maxDelayMs: number;
  private readonly flushOnDispose: boolean;
  private readonly errorHandler: (err: unknown, identity: string) => void;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, delay: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private readonly queued = new Map<string, QueuedEntry>();
  private timer: unknown = null;
  private timerFireAt = 0;
  private disposed = false;
  private running: Promise<void> | null = null;

  constructor(options: SchedulerOptions = {}) {
    this.delayMs = Math.max(0, options.delayMs ?? 50);
    this.maxDelayMs = Math.max(this.delayMs, options.maxDelayMs ?? 200);
    this.flushOnDispose = options.flushOnDispose ?? false;
    this.errorHandler = options.errorHandler ?? ((err, identity) => {
      // eslint-disable-next-line no-console
      console.error(`[CoalescingScheduler] "${identity}" threw:`, err);
    });
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimeout ?? ((fn, delay) => setTimeout(fn, delay));
    this.clearTimer = options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /**
   * 将一个 update 入队. 若同 identity 已存在, 按 `eatenBy` 决定合并方向.
   * disposed 后调用无副作用 (防止 teardown 期间的残留回调排队).
   */
  schedule(update: ScheduledUpdate): void {
    if (this.disposed) return;

    const existing = this.queued.get(update.identity);
    const firstEnqueuedAt = existing?.firstEnqueuedAt ?? this.now();

    // 合并规则: 若新 update 被 old 吃掉, 丢弃新的; 否则新的替换 old
    // (默认 "最新 wins": 即 old 被 new 吃掉).
    if (existing && update.eatenBy?.(existing.update) === true) {
      return;
    }

    this.queued.set(update.identity, { update, firstEnqueuedAt });
    this.scheduleFire();
  }

  /** 某个 identity 当前是否有等待中的 update. */
  has(identity: string): boolean {
    return this.queued.has(identity);
  }

  /** 从队列里移除某个 identity. 返回是否真的有移除. 不影响已经在执行的 batch. */
  cancel(identity: string): boolean {
    const removed = this.queued.delete(identity);
    if (this.queued.size === 0) this.clearTimer_internal();
    return removed;
  }

  /**
   * 立刻跑 pending batch. 若传入 identity 只跑这一条 (保留其他在队列里).
   * 返回 Promise 在该批次全部 run() 完成后 resolve.
   */
  async flush(identity?: string): Promise<void> {
    if (identity !== undefined) {
      const entry = this.queued.get(identity);
      if (!entry) return;
      this.queued.delete(identity);
      await this.executeBatch([entry]);
      return;
    }

    this.clearTimer_internal();
    if (this.running) await this.running;

    while (this.queued.size > 0) {
      const batch = Array.from(this.queued.values());
      this.queued.clear();
      await this.executeBatch(batch);
    }
  }

  size(): number {
    return this.queued.size;
  }

  /** 释放. flushOnDispose=true 时会先把 pending 跑完. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimer_internal();
    if (this.flushOnDispose && this.queued.size > 0) {
      const batch = Array.from(this.queued.values());
      this.queued.clear();
      // fire-and-forget: dispose 不等 batch 跑完
      void this.executeBatch(batch);
    } else {
      this.queued.clear();
    }
  }

  // ── private ──────────────────────────────────────────────────────────────

  private scheduleFire(): void {
    const nowTs = this.now();
    const oldestFirstEnqueuedAt = this.getOldestFirstEnqueuedAt() ?? nowTs;
    const deadline = oldestFirstEnqueuedAt + this.maxDelayMs;
    const preferredFireAt = nowTs + this.delayMs;
    const nextFireAt = Math.min(preferredFireAt, deadline);

    // 如果当前 timer 已经要在更早的时刻 fire, 就不用重置
    if (this.timer !== null && this.timerFireAt <= nextFireAt) return;

    this.clearTimer_internal();
    this.timerFireAt = nextFireAt;
    const delay = Math.max(0, nextFireAt - nowTs);
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.timerFireAt = 0;
      void this.fire();
    }, delay);
  }

  private clearTimer_internal(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
      this.timerFireAt = 0;
    }
  }

  private getOldestFirstEnqueuedAt(): number | undefined {
    let oldest: number | undefined;
    for (const entry of this.queued.values()) {
      if (oldest === undefined || entry.firstEnqueuedAt < oldest) oldest = entry.firstEnqueuedAt;
    }
    return oldest;
  }

  private async fire(): Promise<void> {
    if (this.disposed || this.queued.size === 0) return;

    const batch = Array.from(this.queued.values());
    this.queued.clear();
    await this.executeBatch(batch);

    // 执行期间可能又有新 update 进来, 继续调度下一轮
    if (!this.disposed && this.queued.size > 0) this.scheduleFire();
  }

  private async executeBatch(batch: QueuedEntry[]): Promise<void> {
    // 串行执行以保证 priority 顺序稳定 + 便于上层用 flush() await
    batch.sort((a, b) => {
      const pa = PRIORITY_ORDER[a.update.priority ?? 'normal'];
      const pb = PRIORITY_ORDER[b.update.priority ?? 'normal'];
      if (pa !== pb) return pa - pb;
      return a.firstEnqueuedAt - b.firstEnqueuedAt;
    });

    const runPromise = (async () => {
      for (const entry of batch) {
        try {
          await entry.update.run();
        } catch (err) {
          try { this.errorHandler(err, entry.update.identity); } catch { /* swallow */ }
        }
      }
    })();

    this.running = runPromise;
    try {
      await runPromise;
    } finally {
      if (this.running === runPromise) this.running = null;
    }
  }
}
