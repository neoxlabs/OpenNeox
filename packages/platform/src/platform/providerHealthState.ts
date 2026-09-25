
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

// ==================== 类型定义 ====================

export type ProviderHealth = 'healthy' | 'degraded' | 'down';

export interface ProviderHealthInfo {
  provider: string;
  health: ProviderHealth;
  /** 连续错误次数 */
  consecutiveErrors: number;
  /** 连续成功次数（从最近一次错误后） */
  consecutiveSuccesses: number;
  /** 最近一次错误信息 */
  lastError?: string;
  /** 最近一次错误时间 */
  lastErrorAt?: number;
  /** 最近一次成功时间 */
  lastSuccessAt?: number;
  /** 状态变更时间 */
  stateChangedAt: number;
  lastProbeAt?: number;
}

export interface HealthTransitionEvent {
  provider: string;
  from: ProviderHealth;
  to: ProviderHealth;
  reason: string;
  timestamp: number;
}

export interface HealthConfig {
  /** 连续多少次错误进入 degraded */
  degradedThreshold: number;
  /** 连续多少次错误进入 down */
  downThreshold: number;
  /** 连续多少次成功恢复到 healthy */
  recoveryThreshold: number;
  /** down 状态下探测间隔（毫秒） */
  probeIntervalMs: number;
  /** 哪些错误不计入连续错误（如 user canceled） */
  ignoredErrors: Set<string>;
}

const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  degradedThreshold: 3,
  downThreshold: 8,
  recoveryThreshold: 2,
  probeIntervalMs: 30_000,
  ignoredErrors: new Set(['CANCELED', 'AbortError', 'aborted']),
};

// ==================== ProviderHealthTracker ====================

export class ProviderHealthTracker {
  private providers = new Map<string, ProviderHealthInfo>();
  private config: HealthConfig;
  private listeners: Array<(event: HealthTransitionEvent) => void> = [];

  constructor(config?: Partial<HealthConfig>) {
    this.config = { ...DEFAULT_HEALTH_CONFIG, ...config };
  }

  /**
   * 记录请求成功
   */
  recordSuccess(provider: string): void {
    const info = this.getOrCreate(provider);
    info.consecutiveErrors = 0;
    info.consecutiveSuccesses++;
    info.lastSuccessAt = Date.now();

    // 状态转换
    if (info.health !== 'healthy' && info.consecutiveSuccesses >= this.config.recoveryThreshold) {
      this.transition(info, 'healthy', `${info.consecutiveSuccesses} consecutive successes`);
    }
  }

  /**
   * 记录请求失败
   */
  recordError(provider: string, error: string): void {
    // 忽略特定错误类型
    if (this.config.ignoredErrors.has(error)) return;

    const info = this.getOrCreate(provider);
    info.consecutiveErrors++;
    info.consecutiveSuccesses = 0;
    info.lastError = error;
    info.lastErrorAt = Date.now();

    // 状态转换
    if (info.health === 'healthy' && info.consecutiveErrors >= this.config.degradedThreshold) {
      this.transition(info, 'degraded', `${info.consecutiveErrors} consecutive errors: ${error}`);
    } else if (info.health === 'degraded' && info.consecutiveErrors >= this.config.downThreshold) {
      this.transition(info, 'down', `${info.consecutiveErrors} consecutive errors: ${error}`);
    }
  }

  /**
   * 获取 Provider 健康状态
   */
  getHealth(provider: string): ProviderHealth {
    return this.providers.get(provider)?.health ?? 'healthy';
  }

  /**
   * 获取完整健康信息
   */
  getInfo(provider: string): Readonly<ProviderHealthInfo> | null {
    return this.providers.get(provider) ?? null;
  }

  /**
   * 是否允许发起请求
   *
   * - healthy: 允许
   * - degraded: 允许（但调用方应增加延迟）
   * - down: 仅允许探测请求（按 probeIntervalMs 间隔）
   */
  shouldAllowRequest(provider: string): { allowed: boolean; isProbe: boolean; delay: number } {
    const info = this.providers.get(provider);
    if (!info) return { allowed: true, isProbe: false, delay: 0 };

    switch (info.health) {
      case 'healthy':
        return { allowed: true, isProbe: false, delay: 0 };

      case 'degraded':
        // 允许，但建议增加延迟（退避）
        const degradedDelay = Math.min(info.consecutiveErrors * 1000, 10_000);
        return { allowed: true, isProbe: false, delay: degradedDelay };

      case 'down': {
        // 只允许定期探测
        const now = Date.now();
        const elapsed = now - (info.lastProbeAt ?? 0);
        if (elapsed >= this.config.probeIntervalMs) {
          info.lastProbeAt = now;
          return { allowed: true, isProbe: true, delay: 0 };
        }
        return { allowed: false, isProbe: false, delay: 0 };
      }
    }
  }

  /**
   * 获取所有 Provider 状态概览
   */
  getAllHealth(): Record<string, ProviderHealthInfo> {
    return Object.fromEntries(this.providers);
  }

  /** 订阅状态变更 */
  onTransition(listener: (event: HealthTransitionEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  /** 手动重置某个 Provider */
  reset(provider: string): void {
    this.providers.delete(provider);
  }

  /** 重置全部 */
  resetAll(): void {
    this.providers.clear();
  }

  // ==================== 内部方法 ====================

  private getOrCreate(provider: string): ProviderHealthInfo {
    let info = this.providers.get(provider);
    if (!info) {
      info = {
        provider,
        health: 'healthy',
        consecutiveErrors: 0,
        consecutiveSuccesses: 0,
        stateChangedAt: Date.now(),
      };
      this.providers.set(provider, info);
    }
    return info;
  }

  private transition(info: ProviderHealthInfo, to: ProviderHealth, reason: string): void {
    const from = info.health;
    if (from === to) return;

    const event: HealthTransitionEvent = {
      provider: info.provider,
      from,
      to,
      reason,
      timestamp: Date.now(),
    };

    info.health = to;
    info.stateChangedAt = Date.now();

    const emoji = to === 'healthy' ? '✅' : to === 'degraded' ? '⚠️' : '❌';
    cliLogger.warn('HEALTH', `${emoji} Provider ${info.provider}: ${from} → ${to} (${reason})`);

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 监听器异常不影响状态机
      }
    }
  }
}

// ==================== 全局单例 ====================

let _globalTracker: ProviderHealthTracker | null = null;

export function getGlobalHealthTracker(): ProviderHealthTracker {
  if (!_globalTracker) {
    _globalTracker = new ProviderHealthTracker();
  }
  return _globalTracker;
}
