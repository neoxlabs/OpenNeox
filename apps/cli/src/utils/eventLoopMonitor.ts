/**
 * Event Loop Monitor
 * 监控 Event Loop 延迟，检测阻塞并触发恢复机制
 */

import { performance } from 'perf_hooks';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

// 延迟导入 InputManager，避免循环依赖
let _getInputManager: (() => import('../../vendor/ink/src/InputManager.js').InputManager) | null = null;
async function ensureInputManager() {
  if (!_getInputManager) {
    try {
      const mod = await import('../../vendor/ink/src/InputManager.js');
      _getInputManager = mod.getInputManager;
    } catch (err) {
      cliLogger.debug('EVENT_LOOP', 'InputManager import not available yet', { error: String(err) });
    }
  }
  return _getInputManager;
}

export interface EventLoopMonitorConfig {
  /** 检查间隔（毫秒） */
  checkInterval: number;
  /** 警告阈值（毫秒） */
  warnThreshold: number;
  /** 严重阻塞阈值（毫秒） */
  criticalThreshold: number;
  /** 启用自动恢复 */
  autoRecover: boolean;
}

export interface EventLoopStats {
  /** 当前延迟（毫秒） */
  currentDelay: number;
  /** 平均延迟（毫秒） */
  averageDelay: number;
  /** 最大延迟（毫秒） */
  maxDelay: number;
  /** 警告次数 */
  warnCount: number;
  /** 严重阻塞次数 */
  criticalCount: number;
}

export type RecoveryCallback = (stats: EventLoopStats) => void;

export class EventLoopMonitor {
  private lastCheck: number = performance.now();
  private interval: NodeJS.Timeout | null = null;
  private config: EventLoopMonitorConfig;
  private stats: EventLoopStats = {
    currentDelay: 0,
    averageDelay: 0,
    maxDelay: 0,
    warnCount: 0,
    criticalCount: 0,
  };
  private delayHistory: number[] = [];
  private maxHistorySize = 60; // 保留最近 60 次测量
  private recoveryCallbacks: RecoveryCallback[] = [];
  private lastRecoveryTime = 0;
  private recoveryCooldown = 10000; // 10秒冷却期
  private suspendThreshold = 30000; // 30秒以上视为系统休眠，不是真正的事件循环阻塞

  constructor(config?: Partial<EventLoopMonitorConfig>) {
    this.config = {
      checkInterval: config?.checkInterval ?? 1000, // 1秒
      warnThreshold: config?.warnThreshold ?? 5000, // 5秒
      criticalThreshold: config?.criticalThreshold ?? 10000, // 10秒
      autoRecover: config?.autoRecover ?? true,
    };
  }

  /**
   * 启动监控
   */
  start(): void {
    if (this.interval) {
      cliLogger.warn('EVENT_LOOP', 'Monitor already started');
      return;
    }

    this.lastCheck = performance.now();
    
    this.interval = setInterval(() => {
      this.check();
    }, this.config.checkInterval);

    // 确保 interval 不阻止进程退出
    this.interval.unref();

    cliLogger.info('EVENT_LOOP', `Monitor started (check interval: ${this.config.checkInterval}ms)`);
  }

  /**
   * 停止监控
   */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      cliLogger.info('EVENT_LOOP', 'Monitor stopped');
    }
  }

  /**
   * 执行检查
   */
  private check(): void {
    const now = performance.now();
    const expectedInterval = this.config.checkInterval;
    const actualInterval = now - this.lastCheck;
    const delay = actualInterval - expectedInterval;

    // 不是真正的事件循环阻塞，不报错但仍需执行恢复操作
    if (delay > this.suspendThreshold) {
      cliLogger.info('EVENT_LOOP',
        `🛌 System suspend/resume detected (${Math.round(delay / 1000)}s gap), triggering recovery`,
        { suspendDuration: Math.round(delay / 1000) }
      );
      this.lastCheck = now;
      // 清空历史记录，因为休眠前的数据已经没有参考价值
      this.delayHistory = [];
      this.triggerSuspendRecovery();
      return;
    }

    // 更新统计
    this.stats.currentDelay = delay;
    this.delayHistory.push(delay);

    // 限制历史记录大小
    if (this.delayHistory.length > this.maxHistorySize) {
      this.delayHistory.shift();
    }

    // 计算平均延迟
    this.stats.averageDelay = this.delayHistory.reduce((a, b) => a + b, 0) / this.delayHistory.length;

    // 更新最大延迟
    if (delay > this.stats.maxDelay) {
      this.stats.maxDelay = delay;
    }

    // 检查阈值
    if (delay > this.config.criticalThreshold) {
      this.handleCriticalDelay(delay);
    } else if (delay > this.config.warnThreshold) {
      this.handleWarning(delay);
    }

    // 更新最后检查时间
    this.lastCheck = now;
  }

  /**
   * 处理警告级别延迟
   */
  private handleWarning(delay: number): void {
    this.stats.warnCount++;
    
    cliLogger.warn('EVENT_LOOP', 
      `Event loop delay detected: ${Math.round(delay)}ms (expected ~${this.config.checkInterval}ms)`,
      {
        currentDelay: Math.round(delay),
        averageDelay: Math.round(this.stats.averageDelay),
        maxDelay: Math.round(this.stats.maxDelay),
      }
    );
  }

  /**
   * 处理严重阻塞
   */
  private handleCriticalDelay(delay: number): void {
    this.stats.criticalCount++;
    
    cliLogger.error('EVENT_LOOP', 
      `🚨 CRITICAL: Severe event loop delay detected: ${Math.round(delay)}ms`,
      {
        currentDelay: Math.round(delay),
        averageDelay: Math.round(this.stats.averageDelay),
        maxDelay: Math.round(this.stats.maxDelay),
        criticalCount: this.stats.criticalCount,
      }
    );

    // 触发自动恢复
    if (this.config.autoRecover) {
      this.triggerRecovery();
    }
  }

  /**
   * 触发恢复机制
   */
  private triggerRecovery(): void {
    const now = Date.now();

    // 检查冷却期
    if (now - this.lastRecoveryTime < this.recoveryCooldown) {
      cliLogger.debug('EVENT_LOOP',
        `Recovery skipped (cooldown: ${Math.round((this.recoveryCooldown - (now - this.lastRecoveryTime)) / 1000)}s)`
      );
      return;
    }

    this.lastRecoveryTime = now;

    cliLogger.warn('EVENT_LOOP', '🔄 Triggering emergency recovery callbacks');

    // 调用所有恢复回调
    for (const callback of this.recoveryCallbacks) {
      try {
        callback(this.getStats());
      } catch (err) {
        cliLogger.error('EVENT_LOOP', 'Recovery callback failed', { error: err });
      }
    }

    if (global.gc) {
      cliLogger.debug('EVENT_LOOP', 'Running forced GC');
      global.gc();
    }

    this.forceStdinRecovery();
  }

  /**
   * 系统休眠唤醒后的恢复（不增加错误计数，不受冷却期限制）
   */
  private triggerSuspendRecovery(): void {
    cliLogger.info('EVENT_LOOP', '🔄 Triggering suspend recovery');

    // 调用所有恢复回调
    for (const callback of this.recoveryCallbacks) {
      try {
        callback(this.getStats());
      } catch (err) {
        cliLogger.error('EVENT_LOOP', 'Recovery callback failed', { error: err });
      }
    }

    this.forceStdinRecovery();

    // 更新恢复时间，避免后续正常检测再次触发
    this.lastRecoveryTime = Date.now();
  }

  private forceStdinRecovery(): void {
    try {
      if (_getInputManager) {
        const inputManager = _getInputManager();
        inputManager.forceRecover();
        cliLogger.info('EVENT_LOOP', '✓ stdin recovery delegated to InputManager');
        return;
      }

      // InputManager 还没初始化，尝试异步加载
      ensureInputManager().then(getter => {
        if (getter) {
          try {
            const inputManager = getter();
            inputManager.forceRecover();
            cliLogger.info('EVENT_LOOP', '✓ stdin recovery delegated to InputManager (async)');
          } catch (err: any) {
            cliLogger.debug('EVENT_LOOP', `InputManager recovery failed, using direct: ${err?.message}`);
            this.directStdinRecovery();
          }
        } else {
          this.directStdinRecovery();
        }
      }).catch(err => {
        cliLogger.debug('EVENT_LOOP', `ensureInputManager failed: ${err?.message}`);
        this.directStdinRecovery();
      });
    } catch (err) {
      cliLogger.error('EVENT_LOOP', 'stdin recovery failed', { error: err });
    }
  }

  /**
   * 直接恢复 stdin（仅在 InputManager 不可用时使用）
   */
  private directStdinRecovery(): void {
    try {
      if (!process.stdin.isTTY || process.stdin.destroyed || process.stdin.readable === false) {
        return;
      }

      const wasPaused = process.stdin.isPaused?.();
      const wasRaw = (process.stdin as any).isRaw;

      if (wasPaused) {
        process.stdin.resume();
      }
      if (!process.stdin.destroyed && !wasRaw) {
        process.stdin.setRawMode(true);
      }

      cliLogger.info('EVENT_LOOP', '✓ direct stdin recovery completed', { wasPaused, wasRaw });
    } catch (err) {
      cliLogger.error('EVENT_LOOP', 'direct stdin recovery failed', { error: err });
    }
  }

  /**
   * 注册恢复回调
   */
  onRecovery(callback: RecoveryCallback): void {
    this.recoveryCallbacks.push(callback);
  }

  /**
   * 获取统计信息
   */
  getStats(): EventLoopStats {
    return { ...this.stats };
  }

  /**
   * 重置统计
   */
  resetStats(): void {
    this.stats = {
      currentDelay: 0,
      averageDelay: 0,
      maxDelay: 0,
      warnCount: 0,
      criticalCount: 0,
    };
    this.delayHistory = [];
    cliLogger.info('EVENT_LOOP', 'Statistics reset');
  }
}

let globalMonitor: EventLoopMonitor | null = null;

/**
 * 获取全局 Event Loop 监控器
 */
export function getEventLoopMonitor(config?: Partial<EventLoopMonitorConfig>): EventLoopMonitor {
  if (!globalMonitor) {
    globalMonitor = new EventLoopMonitor(config);
  }
  return globalMonitor;
}

/**
 * 启动全局监控
 */
export function startEventLoopMonitoring(config?: Partial<EventLoopMonitorConfig>): EventLoopMonitor {
  const monitor = getEventLoopMonitor(config);
  monitor.start();
  return monitor;
}

/**
 * 停止全局监控
 */
export function stopEventLoopMonitoring(): void {
  if (globalMonitor) {
    globalMonitor.stop();
  }
}


