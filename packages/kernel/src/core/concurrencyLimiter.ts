/**
 * ConcurrencyLimiter — 轻量并发上限器
 *
 * 目的:防止一次 LLM 响应里出现 N 个 parallel-safe tool call(例如 10 个大文件
 * readfile)同时冲进 event loop, 耗尽 memory / fd 或搞崩第三方服务。
 *
 * 设计:
 *   - 零外部依赖(避免引入 p-limit 的历史版本问题)
 *   - 与 Promise.all / Promise.allSettled 组合使用
 *   - 取消由 caller 负责(AbortSignal 从 fn 内部传播)
 *
 * 用法:
 * ```ts
 * const limit = createConcurrencyLimiter(10);
 * await Promise.allSettled(items.map(it => limit(() => doWork(it))));
 * ```
 *
 * ## 卡死防御(企业级)
 *   隐患:若某个 fn 永不 resolve, active 槽位永不释放, 后续 waiter 永久饿死。
 *   本实现接入 stallGuard 软看门狗:任务执行过久会打"还在跑"心跳日志(带 label),
 *   配合工具层硬超时, 槽位泄漏可被观测且最终能恢复。
 */

import { withWatchdog, envTimeoutMs } from '../utils/stallGuard.js';

export type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;

/** 单个受限任务执行过久的心跳阈值 */
const DEFAULT_TASK_WATCH_MS = envTimeoutMs('NEOX_LIMITER_TASK_WATCH_MS', 60_000);

export interface ConcurrencyLimiterOptions {
  /** 日志标签前缀, 例如 'toolBatch' */
  label?: string;
  /** 单任务心跳阈值(ms), 覆盖默认值。<=0 关闭看门狗。 */
  taskWatchMs?: number;
}

export function createConcurrencyLimiter(
  concurrency: number,
  opts: ConcurrencyLimiterOptions = {},
): Limiter {
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    throw new Error(
      `concurrencyLimiter: concurrency must be a finite integer >= 1, got ${concurrency}`,
    );
  }
  const cap = Math.floor(concurrency);
  const taskWatchMs = opts.taskWatchMs ?? DEFAULT_TASK_WATCH_MS;
  const label = opts.label ? `limiter:${opts.label}` : 'limiter';

  let active = 0;
  let seq = 0;
  const waiters: Array<() => void> = [];

  return async function limited<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= cap) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    active += 1;
    const taskId = ++seq;
    try {
      if (taskWatchMs > 0) {
        return await withWatchdog(Promise.resolve().then(fn), {
          label: `${label}#task${taskId}`,
          warnAfterMs: taskWatchMs,
          context: { active, cap, waiting: waiters.length },
        });
      }
      return await fn();
    } finally {
      active -= 1;
      const next = waiters.shift();
      if (next) next();
    }
  };
}

/** 默认 tool 并发上限 = 10, 由 env NEOX_MAX_TOOL_CONCURRENCY 覆盖 */
export const DEFAULT_MAX_TOOL_CONCURRENCY = 10;

export function getMaxToolConcurrency(): number {
  const raw = Number(process.env.NEOX_MAX_TOOL_CONCURRENCY);
  if (Number.isFinite(raw) && raw >= 1) return Math.floor(raw);
  return DEFAULT_MAX_TOOL_CONCURRENCY;
}
