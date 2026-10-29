/**
 * Server Health Heartbeat
 *
 * CLI 侧定期 ping Server 的健康检查模块。
 * 在 Server 不可用时提前发现并自动恢复连接，
 * 避免用户打字发 chat 时才遇到 ECONNREFUSED。
 */

import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

export interface ServerHealthHeartbeatOptions {
  /** Server 健康检查 URL，如 http://127.0.0.1:4399/health */
  healthUrl: string;
  /** 检查间隔ms，默认 15000 (15s) */
  intervalMs?: number;
  /** 健康请求超时ms，默认 3000 */
  timeoutMs?: number;
  /** 连续失败多少次后触发恢复，默认 2 */
  failThreshold?: number;
  /** 恢复回调：当 server 连续不可达时调用 */
  onServerUnreachable: (consecutiveFailures: number) => Promise<void>;
}

/** 单次自愈的硬上限 — 超时就放手, 让下一轮心跳重试, 绝不无限期挂住 */
const RECOVERY_TIMEOUT_MS = 30_000;

export class ServerHealthHeartbeat {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private consecutiveFailures = 0;
  private recovering = false;
  private readonly healthUrl: string;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly failThreshold: number;
  private readonly onServerUnreachable: (consecutiveFailures: number) => Promise<void>;

  constructor(options: ServerHealthHeartbeatOptions) {
    this.healthUrl = options.healthUrl;
    this.intervalMs = options.intervalMs ?? 15_000;
    this.timeoutMs = options.timeoutMs ?? 3_000;
    this.failThreshold = options.failThreshold ?? 2;
    this.onServerUnreachable = options.onServerUnreachable;
  }

  start(): void {
    if (this.timer) return;

    this.running = true;
    this.consecutiveFailures = 0;

    cliLogger.info('HEARTBEAT', `Server health heartbeat started (interval=${this.intervalMs}ms, url=${this.healthUrl})`);

    this.timer = setInterval(() => {
      void this.check();
    }, this.intervalMs);

    // 不阻止进程退出
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    cliLogger.info('HEARTBEAT', 'Server health heartbeat stopped');
  }

  /** 更新健康检查 URL（重连后 port 可能变化） */
  updateHealthUrl(newUrl: string): void {
    (this as any).healthUrl = newUrl;
    this.consecutiveFailures = 0;
    cliLogger.debug('HEARTBEAT', `Health URL updated: ${newUrl}`);
  }

  isRunning(): boolean {
    return this.running;
  }

  pauseFor(ms: number): void {
    this.recovering = true;
    this.consecutiveFailures = 0;
    setTimeout(() => {
      this.recovering = false;
    }, ms).unref();
    cliLogger.debug('HEARTBEAT', `Paused for ${ms}ms`);
  }

  private async check(): Promise<void> {
    if (!this.running || this.recovering) return;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      const res = await fetch(this.healthUrl, {
        signal: controller.signal,
        headers: { 'x-neox-client': 'cli-interactive' },
      });
      clearTimeout(timeout);

      if (res.ok) {
        if (this.consecutiveFailures > 0) {
          cliLogger.info('HEARTBEAT', `Server recovered after ${this.consecutiveFailures} failures`);
        }
        this.consecutiveFailures = 0;
        return;
      }

      this.consecutiveFailures++;
      cliLogger.warn('HEARTBEAT', `Server health check returned ${res.status} (failures=${this.consecutiveFailures})`);
    } catch {
      this.consecutiveFailures++;
      cliLogger.warn('HEARTBEAT', `Server health check failed (failures=${this.consecutiveFailures})`);
    }

    // 达到阈值，触发恢复
    if (this.consecutiveFailures >= this.failThreshold) {
      this.recovering = true;
      cliLogger.warn('HEARTBEAT', `Server unreachable for ${this.consecutiveFailures} checks, triggering recovery...`);
      try {
        await Promise.race([
          this.onServerUnreachable(this.consecutiveFailures),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`recovery timeout after ${RECOVERY_TIMEOUT_MS}ms`)),
              RECOVERY_TIMEOUT_MS).unref?.(),
          ),
        ]);
        this.consecutiveFailures = 0;
        cliLogger.info('HEARTBEAT', 'Server recovery completed');
      } catch (error: any) {
        cliLogger.error('HEARTBEAT', `Server recovery failed: ${error?.message || String(error)}`);
      } finally {
        this.recovering = false;
      }
    }
  }
}
