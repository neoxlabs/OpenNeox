import { describe, it, expect, vi } from 'vitest';
import { CanceledError, isCanceledError, ProgressContext } from '@neoxlabs/platform/shared/async/progressContext.js';

describe('ProgressContext', () => {
  it('starts not canceled', () => {
    const ctx = ProgressContext.detached('test');
    expect(ctx.isCanceled).toBe(false);
    expect(() => ctx.checkCanceled()).not.toThrow();
  });

  it('checkCanceled throws after cancel()', () => {
    const ctx = ProgressContext.detached('test');
    ctx.cancel();
    expect(ctx.isCanceled).toBe(true);
    expect(() => ctx.checkCanceled()).toThrow(CanceledError);
  });

  it('cancel() is idempotent', () => {
    const ctx = ProgressContext.detached('test');
    const listener = vi.fn();
    ctx.onCanceled(listener);
    ctx.cancel();
    ctx.cancel();
    ctx.cancel();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('onCanceled fires with reason', () => {
    const ctx = ProgressContext.detached('test');
    const listener = vi.fn();
    ctx.onCanceled(listener);
    const reason = new Error('because');
    ctx.cancel(reason);
    expect(listener).toHaveBeenCalledWith(reason);
  });

  it('onCanceled after cancel fires immediately', () => {
    const ctx = ProgressContext.detached('test');
    ctx.cancel();
    const listener = vi.fn();
    ctx.onCanceled(listener);
    expect(listener).toHaveBeenCalled();
  });

  it('child cancel does not propagate to parent', () => {
    const parent = ProgressContext.detached('parent');
    const child = parent.child('child');
    child.cancel();
    expect(parent.isCanceled).toBe(false);
    expect(child.isCanceled).toBe(true);
  });

  it('parent cancel propagates to child', () => {
    const parent = ProgressContext.detached('parent');
    const child = parent.child('child');
    parent.cancel();
    expect(child.isCanceled).toBe(true);
    expect(parent.isCanceled).toBe(true);
  });

  it('already-canceled parent makes new child canceled', () => {
    const parent = ProgressContext.detached('parent');
    parent.cancel();
    const child = parent.child('child');
    expect(child.isCanceled).toBe(true);
  });

  it('fromAbortSignal propagates external abort', () => {
    const controller = new AbortController();
    const ctx = ProgressContext.fromAbortSignal(controller.signal, 'ext');
    expect(ctx.isCanceled).toBe(false);
    controller.abort(new Error('external'));
    expect(ctx.isCanceled).toBe(true);
  });

  it('fromAbortSignal on already-aborted signal cancels immediately', () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = ProgressContext.fromAbortSignal(controller.signal, 'ext');
    expect(ctx.isCanceled).toBe(true);
  });

  it('signal property can be passed to fetch-like APIs', () => {
    const ctx = ProgressContext.detached('test');
    expect(ctx.signal.aborted).toBe(false);
    ctx.cancel();
    expect(ctx.signal.aborted).toBe(true);
  });

  it('timeoutMs auto-cancels after delay', async () => {
    vi.useFakeTimers();
    const ctx = new ProgressContext({ label: 'timeout', timeoutMs: 100 });
    expect(ctx.isCanceled).toBe(false);
    await vi.advanceTimersByTimeAsync(150);
    expect(ctx.isCanceled).toBe(true);
    vi.useRealTimers();
  });

  it('race rejects when ctx cancels, even if promise is still pending', async () => {
    const ctx = ProgressContext.detached('race');
    const never = new Promise(() => { /* never resolves */ });
    const raced = ctx.race(never);
    ctx.cancel(new CanceledError('bye'));
    await expect(raced).rejects.toThrow(CanceledError);
  });

  it('race passes through resolved value when not canceled', async () => {
    const ctx = ProgressContext.detached('race');
    const resolved = Promise.resolve(42);
    await expect(ctx.race(resolved)).resolves.toBe(42);
  });

  it('isCanceledError recognizes CanceledError and AbortError', () => {
    expect(isCanceledError(new CanceledError())).toBe(true);
    const abortErr = new Error('abort');
    abortErr.name = 'AbortError';
    expect(isCanceledError(abortErr)).toBe(true);
    expect(isCanceledError(new Error('other'))).toBe(false);
    expect(isCanceledError(null)).toBe(false);
    expect(isCanceledError(undefined)).toBe(false);
  });

  it('onCanceled returns unsubscribe that prevents callback', () => {
    const ctx = ProgressContext.detached('test');
    const listener = vi.fn();
    const unsub = ctx.onCanceled(listener);
    unsub();
    ctx.cancel();
    expect(listener).not.toHaveBeenCalled();
  });
});
