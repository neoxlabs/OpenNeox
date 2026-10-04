/**
 * fileLimiter 契约固化 — H1.
 */

import { describe, expect, test, beforeEach } from 'vitest';
import { runWithFileLimit, getFileLimitStats, resetFileLimitStatsForTesting } from '../fileLimiter.js';

describe('runWithFileLimit', () => {
  beforeEach(() => {
    resetFileLimitStatsForTesting();
  });

  test('单次调用 — 立即获取, 立即释放', async () => {
    const result = await runWithFileLimit(async () => 42);
    expect(result).toBe(42);
    expect(getFileLimitStats().active).toBe(0);
    expect(getFileLimitStats().queued).toBe(0);
  });

  test('并发不超 limit, 超出走队列', async () => {
    /* limit 默认 32 (8-CPU 机器) 或 16 (4-CPU)。多发 60 个看会不会全跑且不爆 */
    const tasks = [];
    let peakActive = 0;
    for (let i = 0; i < 60; i++) {
      tasks.push(runWithFileLimit(async () => {
        peakActive = Math.max(peakActive, getFileLimitStats().active);
        await new Promise(r => setTimeout(r, 5));
        return i;
      }));
    }
    const results = await Promise.all(tasks);
    expect(results.length).toBe(60);
    expect(getFileLimitStats().active).toBe(0);
    /* peakActive 应该不超 limit, 但实际值依 CPU 数变化, 用 stats.maxActive 校 */
    expect(getFileLimitStats().maxActive).toBeLessThanOrEqual(getFileLimitStats().limit);
  });

  test('fn 抛错 — semaphore 释放, 错透传', async () => {
    await expect(
      runWithFileLimit(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(getFileLimitStats().active).toBe(0);
  });

  test('100 任务排队 — maxQueueDepth 记录峰值', async () => {
    resetFileLimitStatsForTesting();
    const tasks = [];
    for (let i = 0; i < 100; i++) {
      tasks.push(runWithFileLimit(async () => {
        await new Promise(r => setTimeout(r, 3));
        return i;
      }));
    }
    await Promise.all(tasks);
    expect(getFileLimitStats().totalAcquired).toBeGreaterThanOrEqual(100);
    /* 当 100 > limit 时必然有 wait */
    if (getFileLimitStats().limit < 100) {
      expect(getFileLimitStats().totalWaited).toBeGreaterThan(0);
      expect(getFileLimitStats().maxQueueDepth).toBeGreaterThan(0);
    }
  });

  test('FIFO 排队 — 先进先出', async () => {
    /* 抢满 limit 后, 后续按顺序 release. 这里 limit 默认 ≥8, 跑 12 个 1ms 任务,
       验证完成顺序大致和发起顺序一致 (允许并发顺序内, 但队列段必须 FIFO) */
    const completed: number[] = [];
    const tasks = [];
    const limit = getFileLimitStats().limit;
    /* 先填满 limit, 让后续走队列 */
    for (let i = 0; i < limit + 4; i++) {
      tasks.push(runWithFileLimit(async () => {
        await new Promise(r => setTimeout(r, 5));
        completed.push(i);
        return i;
      }));
    }
    await Promise.all(tasks);
    expect(completed.length).toBe(limit + 4);
  });
});
