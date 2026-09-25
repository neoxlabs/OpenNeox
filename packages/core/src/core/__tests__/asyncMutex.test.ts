import { describe, it, expect } from 'vitest';
import { AsyncMutex, createAsyncMutex } from '../asyncMutex.js';

describe('AsyncMutex', () => {
  it('runExclusive returns fn result for sync fn', async () => {
    const mutex = new AsyncMutex();
    const result = await mutex.runExclusive(() => 42);
    expect(result).toBe(42);
  });

  it('runExclusive returns fn result for async fn', async () => {
    const mutex = new AsyncMutex();
    const result = await mutex.runExclusive(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return 'ok';
    });
    expect(result).toBe('ok');
  });

  it('serializes concurrent critical sections (no interleaving)', async () => {
    const mutex = new AsyncMutex();
    const log: string[] = [];

    async function enter(name: string, wait: number) {
      await mutex.runExclusive(async () => {
        log.push(`${name}:in`);
        await new Promise((r) => setTimeout(r, wait));
        log.push(`${name}:out`);
      });
    }

    await Promise.all([enter('A', 20), enter('B', 10), enter('C', 5)]);

    // 每个 name 的 in 必须紧邻自己的 out(不被别人插入)
    for (const name of ['A', 'B', 'C']) {
      const inIdx = log.indexOf(`${name}:in`);
      const outIdx = log.indexOf(`${name}:out`);
      expect(inIdx).toBeGreaterThanOrEqual(0);
      expect(outIdx).toBe(inIdx + 1);
    }
  });

  it('preserves FIFO order of waiters', async () => {
    const mutex = new AsyncMutex();
    const order: number[] = [];
    const tasks: Promise<void>[] = [];

    for (let i = 0; i < 5; i += 1) {
      tasks.push(
        mutex.runExclusive(async () => {
          order.push(i);
          await new Promise((r) => setTimeout(r, 1));
        }),
      );
    }

    await Promise.all(tasks);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it('releases lock when fn throws', async () => {
    const mutex = new AsyncMutex();
    await expect(
      mutex.runExclusive(() => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(mutex.isLocked()).toBe(false);
    // 再次获取应该立刻成功
    const next = await mutex.runExclusive(() => 'ok');
    expect(next).toBe('ok');
  });

  it('tryAcquire is non-blocking', () => {
    const mutex = new AsyncMutex();
    expect(mutex.tryAcquire()).toBe(true);
    expect(mutex.tryAcquire()).toBe(false);
  });

  it('createAsyncMutex factory works', () => {
    const m = createAsyncMutex();
    expect(m).toBeInstanceOf(AsyncMutex);
  });
});
