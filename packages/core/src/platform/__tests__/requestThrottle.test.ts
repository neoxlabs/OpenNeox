import { describe, it, expect } from 'vitest';
import { Semaphore, RequestThrottle } from '@neoxlabs/platform/platform/requestThrottle.js';

describe('Semaphore', () => {
  it('allows up to maxPermits concurrent acquires', async () => {
    const sem = new Semaphore(3);
    expect(sem.available).toBe(3);

    await sem.acquire();
    expect(sem.available).toBe(2);

    await sem.acquire();
    await sem.acquire();
    expect(sem.available).toBe(0);
  });

  it('blocks when no permits available', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    let resolved = false;
    const p = sem.acquire().then(() => { resolved = true; });

    // Should not resolve immediately
    await new Promise(r => setTimeout(r, 10));
    expect(resolved).toBe(false);

    // Release should unblock
    sem.release();
    await p;
    expect(resolved).toBe(true);
  });

  it('times out when acquire exceeds timeout', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    await expect(sem.acquire(50)).rejects.toThrow('timeout');
  });

  it('supports AbortSignal', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    const controller = new AbortController();
    const p = sem.acquire(0, controller.signal);

    setTimeout(() => controller.abort(), 10);

    await expect(p).rejects.toThrow('aborted');
  });

  it('releases correctly', async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    await sem.acquire();
    expect(sem.available).toBe(0);

    sem.release();
    expect(sem.available).toBe(1);

    sem.release();
    expect(sem.available).toBe(2);
  });

  it('does not exceed maxPermits on release', () => {
    const sem = new Semaphore(2);
    sem.release();
    sem.release();
    sem.release();
    expect(sem.available).toBe(2);
  });
});

describe('RequestThrottle', () => {
  it('throttles concurrent requests', async () => {
    const throttle = new RequestThrottle({
      globalMaxConcurrent: 2,
      perProviderMaxConcurrent: 2,
      acquireTimeoutMs: 1000,
    });

    const release1 = await throttle.acquire('openai');
    const release2 = await throttle.acquire('openai');

    const stats = throttle.getStats();
    expect(stats.currentGlobalConcurrent).toBe(2);
    expect(stats.totalAcquired).toBe(2);

    release1();
    release2();

    expect(throttle.getStats().totalReleased).toBe(2);
    expect(throttle.getStats().currentGlobalConcurrent).toBe(0);
  });

  it('prevents double release', async () => {
    const throttle = new RequestThrottle({
      globalMaxConcurrent: 2,
      perProviderMaxConcurrent: 2,
    });

    const release = await throttle.acquire('openai');
    release();
    release(); // Should not throw or double-count

    expect(throttle.getStats().totalReleased).toBe(1);
  });

  it('withThrottle auto-releases on completion', async () => {
    const throttle = new RequestThrottle({
      globalMaxConcurrent: 1,
      perProviderMaxConcurrent: 1,
    });

    const result = await throttle.withThrottle('openai', async () => 42);
    expect(result).toBe(42);
    expect(throttle.getStats().currentGlobalConcurrent).toBe(0);
  });

  it('withThrottle auto-releases on error', async () => {
    const throttle = new RequestThrottle({
      globalMaxConcurrent: 1,
      perProviderMaxConcurrent: 1,
    });

    await expect(
      throttle.withThrottle('openai', async () => { throw new Error('test'); })
    ).rejects.toThrow('test');

    expect(throttle.getStats().currentGlobalConcurrent).toBe(0);
  });

  it('tracks per-provider stats', async () => {
    const throttle = new RequestThrottle({
      globalMaxConcurrent: 4,
      perProviderMaxConcurrent: 2,
    });

    const r1 = await throttle.acquire('openai');
    const r2 = await throttle.acquire('anthropic');

    const stats = throttle.getStats();
    expect(stats.providers['openai'].concurrent).toBe(1);
    expect(stats.providers['anthropic'].concurrent).toBe(1);

    r1();
    r2();
  });
});
