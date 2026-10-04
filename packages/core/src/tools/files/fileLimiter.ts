/**
 * File Operations Concurrency Limiter — 共享 semaphore 防 FD 爆
 *
 *  H1 创建. audit 报告: K=10 explore 子 agent 同时跑大 monorepo, 每个调
 *   readfile/glob/list 100+ 文件 → 主进程瞬间 1000+ fs.open() → macOS 默认 ulimit
 *   nofiles=256 触底 → EMFILE → Agent 全员卡死。
 *
 * 本模块提供单一 semaphore, 所有 fs 操作走它:
 *   await runWithFileLimit(() => fs.promises.readFile(path));
 *
 * 默认上限 32 (留 ~80% 给其他 fd: sqlite / sockets / stderr / tty)。
 * 环境变量 NEOX_FILE_OP_CONCURRENCY 覆盖, 最小 1, 最大 256。
 *
 * 不抢占式排队 (FIFO), 不超时 (fs op 自身有超时归调用方负责)。
 */

import { cpus } from 'node:os';

const DEFAULT_LIMIT = Math.max(8, Math.min(32, cpus().length * 4));

function resolveLimit(): number {
  const env = Number(process.env.NEOX_FILE_OP_CONCURRENCY);
  if (Number.isFinite(env) && env >= 1) return Math.min(256, Math.floor(env));
  return DEFAULT_LIMIT;
}

const LIMIT = resolveLimit();

let active = 0;
const queue: Array<() => void> = [];

/* 诊断: 给 H1 telemetry 用. 暴露给 fileLimiter.stats 端点 */
const stats = {
  totalAcquired: 0,
  totalWaited: 0,   // 累计排队等待的调用数
  maxQueueDepth: 0, // 历史最长队列长度
  maxActive: 0,
};

function acquire(): Promise<void> {
  if (active < LIMIT) {
    active++;
    stats.totalAcquired++;
    if (active > stats.maxActive) stats.maxActive = active;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    queue.push(() => {
      active++;
      stats.totalAcquired++;
      if (active > stats.maxActive) stats.maxActive = active;
      resolve();
    });
    stats.totalWaited++;
    if (queue.length > stats.maxQueueDepth) stats.maxQueueDepth = queue.length;
  });
}

function release(): void {
  active--;
  const next = queue.shift();
  if (next) next();
}

/**
 * 唯一对外入口. 包住任何文件操作:
 *   const content = await runWithFileLimit(() => fs.promises.readFile(path, 'utf-8'));
 *
 * 错误传递: fn 抛错时不吞, 透传给 caller。semaphore 永远释放(finally)。
 */
export async function runWithFileLimit<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

export function getFileLimitStats(): Readonly<typeof stats> & { limit: number; active: number; queued: number } {
  return { ...stats, limit: LIMIT, active, queued: queue.length };
}

/** 测试用 — 重置 stats 不重置 active queue (那是真实状态) */
export function resetFileLimitStatsForTesting(): void {
  stats.totalAcquired = 0;
  stats.totalWaited = 0;
  stats.maxQueueDepth = 0;
  stats.maxActive = 0;
}
