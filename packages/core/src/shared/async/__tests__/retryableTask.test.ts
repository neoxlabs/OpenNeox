import { describe, it, expect, vi } from 'vitest';
import { CanceledError, ProgressContext } from '@neoxlabs/platform/shared/async/progressContext.js';
import { runRetryable } from '@neoxlabs/platform/shared/async/retryableTask.js';

describe('runRetryable', () => {
  it('returns result on first success', async () => {
    const fn = vi.fn(async () => 42);
    const result = await runRetryable(fn);
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on CanceledError until success', async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      n += 1;
      if (n < 3) throw new CanceledError('interrupted');
      return 'done';
    });
    const result = await runRetryable(fn, { maxRetries: 5 });
    expect(result).toBe('done');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('gives up after maxRetries', async () => {
    const fn = vi.fn(async () => { throw new CanceledError('always'); });
    await expect(runRetryable(fn, { maxRetries: 2 })).rejects.toThrow(CanceledError);
    expect(fn).toHaveBeenCalledTimes(3);  // 1 初次 + 2 retry
  });

  it('does NOT retry on non-CanceledError by default', async () => {
    const fn = vi.fn(async () => { throw new Error('real failure'); });
    await expect(runRetryable(fn, { maxRetries: 5 })).rejects.toThrow('real failure');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('outer ctx cancel stops retry loop immediately', async () => {
    const outer = ProgressContext.detached('outer');
    const fn = vi.fn(async () => { throw new CanceledError('per-attempt'); });

    const promise = runRetryable(fn, { outerCtx: outer, maxRetries: 10, retryDelayMs: 50 });
    // 让第一次 attempt 抛, 进入 retryDelay 再 cancel outer
    await new Promise((r) => setTimeout(r, 10));
    outer.cancel(new CanceledError('outer cancel'));

    await expect(promise).rejects.toThrow(CanceledError);
    expect(fn.mock.calls.length).toBeLessThan(3);
  });

  it('preconditions failing → CanceledError without running fn', async () => {
    const fn = vi.fn();
    await expect(
      runRetryable(fn, { conditions: [() => false] }),
    ).rejects.toThrow(CanceledError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('conditions re-checked between retries', async () => {
    let allow = true;
    let n = 0;
    const fn = vi.fn(async () => {
      n += 1;
      throw new CanceledError(`n=${n}`);
    });
    const promise = runRetryable(fn, {
      maxRetries: 5,
      retryDelayMs: 10,
      conditions: [() => allow],
      onRetry: () => { allow = false; },  // 第一次 retry 后条件变 false
    });
    await expect(promise).rejects.toThrow(CanceledError);
    expect(fn).toHaveBeenCalledTimes(1);  // 第一次跑后 conditions=false, 不再重试
  });

  it('custom shouldRetry overrides default', async () => {
    const fn = vi.fn(async () => { throw new Error('network blip'); });
    await expect(
      runRetryable(fn, {
        maxRetries: 2,
        shouldRetry: (err) => (err as Error).message === 'network blip',
      }),
    ).rejects.toThrow('network blip');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('retryDelayMs accepts fn for exponential backoff', async () => {
    const t0 = Date.now();
    let n = 0;
    const fn = vi.fn(async () => {
      n += 1;
      if (n < 3) throw new CanceledError('retry me');
      return 'ok';
    });
    await runRetryable(fn, {
      maxRetries: 5,
      retryDelayMs: (attempt) => attempt * 20,  // 20, 40
    });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(55);
  });

  it('perAttemptTimeoutMs forces CanceledError and triggers retry', async () => {
    let n = 0;
    const fn = vi.fn(async (ctx: ProgressContext) => {
      n += 1;
      if (n === 1) {
        // 第一次: 等到被 timeout, 然后 checkCanceled 抛.
        await new Promise((r) => setTimeout(r, 100));
        ctx.checkCanceled();
        return 'never';
      }
      return 'ok';
    });
    const result = await runRetryable(fn, {
      maxRetries: 2,
      perAttemptTimeoutMs: 30,
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('external signal aborted pre-execution → CanceledError', async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn();
    await expect(
      runRetryable(fn, { signal: controller.signal }),
    ).rejects.toThrow(CanceledError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('onRetry hook fires between attempts', async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      n += 1;
      if (n < 3) throw new CanceledError('x');
      return 'done';
    });
    const onRetry = vi.fn();
    await runRetryable(fn, { maxRetries: 5, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0][1]).toBe(1);  // attempt = 1
    expect(onRetry.mock.calls[1][1]).toBe(2);
  });

  it('inner ctx is child of outer — outer cancel propagates to fn.ctx', async () => {
    const outer = ProgressContext.detached('outer');
    let innerSeen: ProgressContext | undefined;

    const fn = vi.fn(async (ctx: ProgressContext) => {
      innerSeen = ctx;
      await new Promise((r) => setTimeout(r, 50));
      ctx.checkCanceled();
      return 'never';
    });

    const promise = runRetryable(fn, { outerCtx: outer, maxRetries: 2 });
    await new Promise((r) => setTimeout(r, 10));
    outer.cancel();
    await expect(promise).rejects.toThrow(CanceledError);
    expect(innerSeen?.isCanceled).toBe(true);
  });
});
