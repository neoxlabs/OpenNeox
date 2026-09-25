import { describe, it, expect, afterEach } from 'vitest';
/* 历史 path: '../concurrencyLimiter.js' (core/core/). source 已迁 kernel,
   走 deep import 保留 test 覆盖 (kernel 本身无同名 test). */
import {
  createConcurrencyLimiter,
  getMaxToolConcurrency,
  DEFAULT_MAX_TOOL_CONCURRENCY,
} from '@neoxlabs/kernel/core/concurrencyLimiter.js';

describe('concurrencyLimiter', () => {
  it('never exceeds the cap', async () => {
    const cap = 3;
    const limit = createConcurrencyLimiter(cap);
    let active = 0;
    let peak = 0;

    async function task() {
      active += 1;
      if (active > peak) peak = active;
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    }

    const tasks = Array.from({ length: 10 }, () => limit(task));
    await Promise.all(tasks);

    expect(peak).toBeLessThanOrEqual(cap);
    expect(peak).toBeGreaterThan(1); // 实际有并行发生
  });

  it('returns fn result', async () => {
    const limit = createConcurrencyLimiter(2);
    const r = await limit(async () => 42);
    expect(r).toBe(42);
  });

  it('releases slot even if fn throws', async () => {
    const limit = createConcurrencyLimiter(1);
    await expect(limit(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    // 下一个任务应该能立刻开始
    const r = await limit(async () => 'ok');
    expect(r).toBe('ok');
  });

  it('preserves FIFO queue order', async () => {
    const limit = createConcurrencyLimiter(1);
    const order: number[] = [];
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < 5; i += 1) {
      tasks.push(
        limit(async () => {
          order.push(i);
          await new Promise((r) => setTimeout(r, 1));
        }),
      );
    }
    await Promise.all(tasks);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it('throws for invalid concurrency', () => {
    expect(() => createConcurrencyLimiter(0)).toThrow();
    expect(() => createConcurrencyLimiter(-1)).toThrow();
    expect(() => createConcurrencyLimiter(NaN)).toThrow();
  });

  describe('getMaxToolConcurrency', () => {
    const envKey = 'NEOX_MAX_TOOL_CONCURRENCY';
    const original = process.env[envKey];

    afterEach(() => {
      if (original === undefined) delete process.env[envKey];
      else process.env[envKey] = original;
    });

    it('defaults to 10 when env is unset', () => {
      delete process.env[envKey];
      expect(getMaxToolConcurrency()).toBe(DEFAULT_MAX_TOOL_CONCURRENCY);
    });

    it('respects valid env value', () => {
      process.env[envKey] = '5';
      expect(getMaxToolConcurrency()).toBe(5);
    });

    it('ignores invalid env values and falls back to default', () => {
      process.env[envKey] = 'nonsense';
      expect(getMaxToolConcurrency()).toBe(DEFAULT_MAX_TOOL_CONCURRENCY);

      process.env[envKey] = '-3';
      expect(getMaxToolConcurrency()).toBe(DEFAULT_MAX_TOOL_CONCURRENCY);

      process.env[envKey] = '0';
      expect(getMaxToolConcurrency()).toBe(DEFAULT_MAX_TOOL_CONCURRENCY);
    });

    it('floors fractional env values', () => {
      process.env[envKey] = '7.9';
      expect(getMaxToolConcurrency()).toBe(7);
    });
  });
});
