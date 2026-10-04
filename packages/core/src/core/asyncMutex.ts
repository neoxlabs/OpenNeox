/**
 * AsyncMutex — 轻量异步互斥锁
 *
 * ## 为什么写这个?
 *
 * 当一个共享状态类的 write 操作**本身是 async**(比如未来要落库 / 发到远端),
 * Node.js single-thread 语义就救不了你:await 中间会让出 event loop,
 * 别的 Promise 可能跑到你的 read-modify-write 中间。
 *
 * 但注意:如果 write 是**纯 sync 的 array.push**(例如当前的 loopDetector
 * / errorPatternMemory),Node 单线程在 microtask 之间不会被抢占,加锁反而是噪音。
 *
 * 这个类的存在价值:
 *   1. 给未来 "sync → async" 迁移提供零成本的锁基础设施
 *   2. 如果确实有外部 io 介入到 record 流程(比如 write-through cache),立刻可用
 *
 * ## 使用
 *
 * ```ts
 * const mutex = new AsyncMutex('loopDetector');
 * await mutex.runExclusive(async () => {
 *   // 被保护的 read-modify-write
 * }, { timeoutMs: 30_000 });
 * ```
 *
 * ## 卡死防御(企业级)
 *   历史隐患:如果临界区 fn 永不返回, release 永不触发, 所有 waiter 永久饿死,
 *   且日志里毫无线索。本实现接入 stallGuard:
 *     · acquire 等待过久 → 软看门狗心跳日志(谁在等、等了多久)
 *     · 临界区持有过久  → 软看门狗心跳日志(谁持有、持有多久)
 *     · 可选 acquireTimeoutMs → 等不到锁直接 reject(StallTimeoutError), 上层可恢复
 *   stallId 串起全过程, 卡死时 dumpInflightStalls() 一眼看到锁在哪。
 */

import { withWatchdog, withTimeout, envTimeoutMs } from '@neoxlabs/kernel/utils/stallGuard.js';

/** acquire 等待心跳阈值:等锁超过这个时长开始打日志 */
const DEFAULT_ACQUIRE_WATCH_MS = envTimeoutMs('NEOX_MUTEX_ACQUIRE_WATCH_MS', 15_000);
/** 临界区持有心跳阈值:持锁超过这个时长开始打日志(疑似 fn 卡住) */
const DEFAULT_HOLD_WATCH_MS = envTimeoutMs('NEOX_MUTEX_HOLD_WATCH_MS', 30_000);

export interface RunExclusiveOptions {
  /** 等锁硬超时(ms)。<=0 / 省略 → 不超时, 只软看门狗观测。 */
  acquireTimeoutMs?: number;
  /** 临界区持有心跳阈值(ms), 覆盖默认值 */
  holdWatchMs?: number;
  /** 标签后缀, 进日志便于区分同名 mutex 的不同调用点 */
  label?: string;
}

export class AsyncMutex {
  private _locked = false;
  private readonly _waiters: Array<() => void> = [];
  private readonly _name: string;
  /** 当前持有者标签(调试 / 卡死定位用) */
  private _heldBy: string | null = null;
  private _heldSince = 0;

  constructor(name = 'anonymous') {
    this._name = name;
  }

  /**
   * 运行一个受保护的临界区。传入的 fn 可以是 sync 或 async,返回值透传。
   *
   * @param opts 可选超时 / 看门狗配置(企业级卡死防御)
   */
  async runExclusive<T>(fn: () => T | Promise<T>, opts: RunExclusiveOptions = {}): Promise<T> {
    const label = opts.label ? `mutex:${this._name}:${opts.label}` : `mutex:${this._name}`;
    const holdWatchMs = opts.holdWatchMs ?? DEFAULT_HOLD_WATCH_MS;

    // ── 1. 获取锁(带看门狗 / 可选硬超时) ──
    const acquirePromise = this.acquire();
    if (opts.acquireTimeoutMs && opts.acquireTimeoutMs > 0) {
      await withTimeout(acquirePromise, {
        label: `${label}#acquire`,
        timeoutMs: opts.acquireTimeoutMs,
        context: { name: this._name, heldBy: this._heldBy, holdAgeMs: this._heldSince ? Date.now() - this._heldSince : 0 },
      });
    } else {
      await withWatchdog(acquirePromise, {
        label: `${label}#acquire`,
        warnAfterMs: DEFAULT_ACQUIRE_WATCH_MS,
        context: { name: this._name, heldBy: this._heldBy },
      });
    }

    // ── 2. 执行临界区(带看门狗, 持锁过久会打心跳, 让卡死可见) ──
    this._heldBy = label;
    this._heldSince = Date.now();
    try {
      return await withWatchdog(Promise.resolve().then(fn), {
        label: `${label}#critical`,
        warnAfterMs: holdWatchMs,
        context: { name: this._name },
      });
    } finally {
      this._heldBy = null;
      this._heldSince = 0;
      this.release();
    }
  }

  /**
   * 非阻塞尝试获取:拿到返回 true, 否则 false。
   */
  tryAcquire(): boolean {
    if (this._locked) return false;
    this._locked = true;
    return true;
  }

  /**
   * 是否当前已被持有
   */
  isLocked(): boolean {
    return this._locked;
  }

  /** 当前持有者标签(null = 未持有) */
  get heldBy(): string | null {
    return this._heldBy;
  }

  /** 等待队列长度(诊断用) */
  get waiterCount(): number {
    return this._waiters.length;
  }

  private acquire(): Promise<void> {
    if (!this._locked) {
      this._locked = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this._waiters.push(resolve);
    });
  }

  private release(): void {
    const next = this._waiters.shift();
    if (next) {
      // 直接交接锁,不先置 false 再置 true,避免竞争窗口
      next();
    } else {
      this._locked = false;
    }
  }
}

/**
 * 便捷工厂
 */
export function createAsyncMutex(name = 'anonymous'): AsyncMutex {
  return new AsyncMutex(name);
}
