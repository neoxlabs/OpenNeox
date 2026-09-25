import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CoalescingScheduler } from '@neoxlabs/platform/shared/scheduling/coalescingScheduler.js';

describe('CoalescingScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs a single update after delayMs', async () => {
    const scheduler = new CoalescingScheduler({ delayMs: 50 });
    const run = vi.fn();
    scheduler.schedule({ identity: 'a', run });

    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('coalesces same identity → only latest runs', async () => {
    const scheduler = new CoalescingScheduler({ delayMs: 50 });
    const run1 = vi.fn();
    const run2 = vi.fn();
    const run3 = vi.fn();

    scheduler.schedule({ identity: 'same', run: run1 });
    scheduler.schedule({ identity: 'same', run: run2 });
    scheduler.schedule({ identity: 'same', run: run3 });

    await vi.advanceTimersByTimeAsync(100);
    expect(run1).not.toHaveBeenCalled();
    expect(run2).not.toHaveBeenCalled();
    expect(run3).toHaveBeenCalledTimes(1);
  });

  it('keeps different identities independent', async () => {
    const scheduler = new CoalescingScheduler({ delayMs: 50 });
    const runA = vi.fn();
    const runB = vi.fn();

    scheduler.schedule({ identity: 'a', run: runA });
    scheduler.schedule({ identity: 'b', run: runB });

    await vi.advanceTimersByTimeAsync(100);
    expect(runA).toHaveBeenCalledTimes(1);
    expect(runB).toHaveBeenCalledTimes(1);
  });

  it('maxDelayMs prevents starvation under continuous re-schedule', async () => {
    const scheduler = new CoalescingScheduler({ delayMs: 50, maxDelayMs: 120 });
    const run = vi.fn();

    // 每 30ms 重新排队, 永远不到 delayMs=50 的窗口; maxDelayMs=120 应该强制 fire.
    scheduler.schedule({ identity: 'a', run });
    for (let i = 0; i < 10; i += 1) {
      await vi.advanceTimersByTimeAsync(30);
      scheduler.schedule({ identity: 'a', run });
    }
    // 至少在 maxDelayMs 内被 fire 一次
    expect(run).toHaveBeenCalled();
  });

  it('priority high runs before normal/low in same batch', async () => {
    const scheduler = new CoalescingScheduler({ delayMs: 50 });
    const order: string[] = [];

    scheduler.schedule({ identity: 'low', run: () => { order.push('low'); }, priority: 'low' });
    scheduler.schedule({ identity: 'high', run: () => { order.push('high'); }, priority: 'high' });
    scheduler.schedule({ identity: 'normal', run: () => { order.push('normal'); }, priority: 'normal' });

    await vi.advanceTimersByTimeAsync(60);
    expect(order).toEqual(['high', 'normal', 'low']);
  });

  it('flush() runs pending immediately', async () => {
    vi.useRealTimers();  // flush 走 await Promise, 不能用假 timer
    const scheduler = new CoalescingScheduler({ delayMs: 1000 });
    const run = vi.fn();

    scheduler.schedule({ identity: 'a', run });
    await scheduler.flush();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('flush(identity) only runs that one', async () => {
    vi.useRealTimers();
    const scheduler = new CoalescingScheduler({ delayMs: 1000 });
    const runA = vi.fn();
    const runB = vi.fn();

    scheduler.schedule({ identity: 'a', run: runA });
    scheduler.schedule({ identity: 'b', run: runB });
    await scheduler.flush('a');

    expect(runA).toHaveBeenCalledTimes(1);
    expect(runB).not.toHaveBeenCalled();
    expect(scheduler.has('b')).toBe(true);
  });

  it('cancel(identity) prevents execution', async () => {
    const scheduler = new CoalescingScheduler({ delayMs: 50 });
    const run = vi.fn();

    scheduler.schedule({ identity: 'a', run });
    expect(scheduler.cancel('a')).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(run).not.toHaveBeenCalled();
  });

  it('errorHandler swallows run() errors, keeps batch going', async () => {
    const scheduler = new CoalescingScheduler({
      delayMs: 50,
      errorHandler: vi.fn(),
    });
    const runA = vi.fn(() => { throw new Error('boom'); });
    const runB = vi.fn();

    scheduler.schedule({ identity: 'a', run: runA });
    scheduler.schedule({ identity: 'b', run: runB });
    await vi.advanceTimersByTimeAsync(60);

    expect(runA).toHaveBeenCalled();
    expect(runB).toHaveBeenCalled();
  });

  it('dispose() clears pending by default', async () => {
    const scheduler = new CoalescingScheduler({ delayMs: 50 });
    const run = vi.fn();

    scheduler.schedule({ identity: 'a', run });
    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(100);
    expect(run).not.toHaveBeenCalled();
  });

  it('dispose() with flushOnDispose runs pending', async () => {
    vi.useRealTimers();
    const scheduler = new CoalescingScheduler({ delayMs: 1000, flushOnDispose: true });
    const run = vi.fn();

    scheduler.schedule({ identity: 'a', run });
    scheduler.dispose();
    await new Promise((r) => setTimeout(r, 10));  // 让 fire-and-forget promise 跑
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('eatenBy can reject newer update in favor of older', async () => {
    const scheduler = new CoalescingScheduler({ delayMs: 50 });
    const run1 = vi.fn();
    const run2 = vi.fn();

    scheduler.schedule({ identity: 'a', run: run1 });
    scheduler.schedule({
      identity: 'a',
      run: run2,
      eatenBy: () => true,  // "I am eaten by existing, drop me"
    });

    await vi.advanceTimersByTimeAsync(60);
    expect(run1).toHaveBeenCalledTimes(1);
    expect(run2).not.toHaveBeenCalled();
  });

  it('size() reflects queued count', () => {
    const scheduler = new CoalescingScheduler({ delayMs: 50 });
    expect(scheduler.size()).toBe(0);
    scheduler.schedule({ identity: 'a', run: () => {} });
    scheduler.schedule({ identity: 'b', run: () => {} });
    scheduler.schedule({ identity: 'a', run: () => {} });  // dedupe
    expect(scheduler.size()).toBe(2);
  });

  it('schedule() after dispose is a no-op', async () => {
    const scheduler = new CoalescingScheduler({ delayMs: 50 });
    scheduler.dispose();
    const run = vi.fn();
    scheduler.schedule({ identity: 'a', run });
    await vi.advanceTimersByTimeAsync(100);
    expect(run).not.toHaveBeenCalled();
  });

  it('awaits async run in order', async () => {
    vi.useRealTimers();
    const scheduler = new CoalescingScheduler({ delayMs: 10 });
    const order: string[] = [];

    scheduler.schedule({
      identity: 'a',
      priority: 'high',
      run: async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push('a-done');
      },
    });
    scheduler.schedule({
      identity: 'b',
      priority: 'normal',
      run: () => { order.push('b-done'); },
    });

    await scheduler.flush();
    expect(order).toEqual(['a-done', 'b-done']);
  });
});
