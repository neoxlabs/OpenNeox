
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

// ==================== Semaphore ====================

/**
 * 计数信号量 — 控制并发资源访问
 */
export class Semaphore {
  private permits: number;
  private readonly maxPermits: number;
  private waitQueue: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

  constructor(maxPermits: number) {
    this.maxPermits = maxPermits;
    this.permits = maxPermits;
  }

  /**
   * 获取一个许可（阻塞直到可用）
   *
   * @param timeoutMs 等待超时（0=无限等待）
   * @param signal AbortSignal（支持取消等待）
   */
  async acquire(timeoutMs = 0, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new Error('Semaphore acquire aborted');
    }

    if (this.permits > 0) {
      this.permits--;
      return;
    }

    // 排队等待
    return new Promise<void>((resolve, reject) => {
      const entry = { resolve, reject };
      this.waitQueue.push(entry);

      // 超时处理
      let timer: ReturnType<typeof setTimeout> | null = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          const idx = this.waitQueue.indexOf(entry);
          if (idx >= 0) {
            this.waitQueue.splice(idx, 1);
            reject(new Error(`Semaphore acquire timeout after ${timeoutMs}ms (${this.waitQueue.length} still waiting)`));
          }
        }, timeoutMs);
      }

      // AbortSignal 处理
      const onAbort = () => {
        if (timer) clearTimeout(timer);
        const idx = this.waitQueue.indexOf(entry);
        if (idx >= 0) {
          this.waitQueue.splice(idx, 1);
          reject(new Error('Semaphore acquire aborted'));
        }
      };

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
        // 包装 resolve 清理 listener
        const originalResolve = entry.resolve;
        entry.resolve = () => {
          signal.removeEventListener('abort', onAbort);
          if (timer) clearTimeout(timer);
          originalResolve();
        };
      } else if (timer) {
        const originalResolve = entry.resolve;
        entry.resolve = () => {
          clearTimeout(timer!);
          originalResolve();
        };
      }
    });
  }

  /** 释放一个许可 */
  release(): void {
    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift()!;
      // 不增加 permits，直接传递给下一个等待者
      next.resolve();
    } else {
      this.permits = Math.min(this.permits + 1, this.maxPermits);
    }
  }

  /** 当前可用许可数 */
  get available(): number {
    return this.permits;
  }

  /** 当前等待队列长度 */
  get waiting(): number {
    return this.waitQueue.length;
  }

  /** 是否有可用许可（不阻塞检查） */
  get hasAvailable(): boolean {
    return this.permits > 0;
  }
}

// ==================== RequestThrottle ====================

export interface ThrottleConfig {
  /** 全局最大并发请求数 */
  globalMaxConcurrent: number;
  /** 每个 Provider 的最大并发请求数 */
  perProviderMaxConcurrent: number;
  /** 获取许可的超时时间（毫秒）— 0=不限制 */
  acquireTimeoutMs: number;
}

const DEFAULT_THROTTLE_CONFIG: ThrottleConfig = {
  globalMaxConcurrent: 8,
  perProviderMaxConcurrent: 4,
  acquireTimeoutMs: 60_000,
};

/**
 * API 请求限流器
 *
 * 双层控制：
 * 1. 全局信号量 — 总并发上限（防止系统过载）
 * 2. Provider 信号量 — 每个 provider 独立限制（防止单 provider 429）
 */
export class RequestThrottle {
  private globalSemaphore: Semaphore;
  private providerSemaphores = new Map<string, Semaphore>();
  private config: ThrottleConfig;

  // 统计
  private stats = {
    totalAcquired: 0,
    totalReleased: 0,
    totalTimeouts: 0,
    totalAborted: 0,
    maxConcurrentSeen: 0,
  };

  constructor(config?: Partial<ThrottleConfig>) {
    this.config = { ...DEFAULT_THROTTLE_CONFIG, ...config };
    this.globalSemaphore = new Semaphore(this.config.globalMaxConcurrent);
  }

  /**
   * 获取请求许可 — 在发起 API 调用前调用
   *
   * @returns release 函数，API 调用完成后必须调用
   */
  async acquire(
    provider: string,
    signal?: AbortSignal,
  ): Promise<() => void> {
    const providerSem = this.getProviderSemaphore(provider);

    try {
      // 先获取全局许可
      await this.globalSemaphore.acquire(this.config.acquireTimeoutMs, signal);
    } catch (err) {
      if ((err as Error).message.includes('timeout')) {
        this.stats.totalTimeouts++;
        cliLogger.warn('THROTTLE', `Global semaphore timeout for ${provider} (${this.globalSemaphore.waiting} waiting)`);
      } else {
        this.stats.totalAborted++;
      }
      throw err;
    }

    try {
      // 再获取 Provider 许可
      await providerSem.acquire(this.config.acquireTimeoutMs, signal);
    } catch (err) {
      // Provider 许可获取失败，释放已获取的全局许可
      this.globalSemaphore.release();
      if ((err as Error).message.includes('timeout')) {
        this.stats.totalTimeouts++;
        cliLogger.warn('THROTTLE', `Provider semaphore timeout for ${provider} (${providerSem.waiting} waiting)`);
      } else {
        this.stats.totalAborted++;
      }
      throw err;
    }

    this.stats.totalAcquired++;
    const currentConcurrent = this.config.globalMaxConcurrent - this.globalSemaphore.available;
    if (currentConcurrent > this.stats.maxConcurrentSeen) {
      this.stats.maxConcurrentSeen = currentConcurrent;
    }

    let released = false;
    return () => {
      if (released) return; // 防止重复释放
      released = true;
      providerSem.release();
      this.globalSemaphore.release();
      this.stats.totalReleased++;
    };
  }

  /**
   * 包装 API 调用 — 自动获取/释放许可
   */
  async withThrottle<T>(
    provider: string,
    fn: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const release = await this.acquire(provider, signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** 获取全局统计 */
  getStats() {
    return {
      ...this.stats,
      currentGlobalConcurrent: this.config.globalMaxConcurrent - this.globalSemaphore.available,
      globalWaiting: this.globalSemaphore.waiting,
      providers: Object.fromEntries(
        [...this.providerSemaphores.entries()].map(([k, v]) => [k, {
          concurrent: this.config.perProviderMaxConcurrent - v.available,
          waiting: v.waiting,
        }]),
      ),
    };
  }

  /** 更新配置 */
  updateConfig(config: Partial<ThrottleConfig>): void {
    // 注意：更改 maxConcurrent 需要重建信号量，这里只更新 timeout
    if (config.acquireTimeoutMs !== undefined) {
      this.config.acquireTimeoutMs = config.acquireTimeoutMs;
    }
  }

  private getProviderSemaphore(provider: string): Semaphore {
    let sem = this.providerSemaphores.get(provider);
    if (!sem) {
      sem = new Semaphore(this.config.perProviderMaxConcurrent);
      this.providerSemaphores.set(provider, sem);
    }
    return sem;
  }
}

// ==================== 全局单例 ====================

let _globalThrottle: RequestThrottle | null = null;

export function getGlobalRequestThrottle(): RequestThrottle {
  if (!_globalThrottle) {
    _globalThrottle = new RequestThrottle();
  }
  return _globalThrottle;
}

export function initGlobalRequestThrottle(config?: Partial<ThrottleConfig>): RequestThrottle {
  _globalThrottle = new RequestThrottle(config);
  return _globalThrottle;
}
