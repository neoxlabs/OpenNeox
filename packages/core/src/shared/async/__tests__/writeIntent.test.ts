import { describe, it, expect, vi } from 'vitest';
import { ProgressContext, CanceledError } from '@neoxlabs/platform/shared/async/progressContext.js';
import {
  WriteIntentRegistry,
  WriteIntentConflict,
} from '@neoxlabs/platform/shared/async/writeIntent.js';

describe('WriteIntentRegistry · basic lifecycle', () => {
  it('begin/end is idempotent', () => {
    const reg = new WriteIntentRegistry();
    const token = reg.begin({ label: 'save', files: ['/a/b.ts'] });
    expect(reg.isLocked('/a/b.ts')).toBe(true);
    reg.end(token);
    reg.end(token);  // 再次 end 应该是 no-op
    expect(reg.isLocked('/a/b.ts')).toBe(false);
  });

  it('tracks workspace-scope intent (empty files)', () => {
    const reg = new WriteIntentRegistry();
    reg.begin({ label: 'workspace-rebuild', files: [] });
    expect(reg.isLocked('/any/file.ts')).toBe(true);
    expect(reg.isLocked('/another/one.js')).toBe(true);
  });

  it('snapshot reflects active intents', () => {
    const reg = new WriteIntentRegistry();
    reg.begin({ label: 'a', files: ['/x.ts'] });
    reg.begin({ label: 'b', files: ['/y.ts'] });
    const snap = reg.snapshot();
    expect(snap.writes).toHaveLength(2);
    expect(snap.writes.map((w) => w.label).sort()).toEqual(['a', 'b']);
  });
});

describe('WriteIntentRegistry · read vs write conflict', () => {
  it('registerRead cancels ctx when conflicting write begins later', () => {
    const reg = new WriteIntentRegistry();
    const ctx = ProgressContext.detached('read-hover');
    reg.registerRead(ctx, { files: ['/a/b.ts'], label: 'hover' });
    expect(ctx.isCanceled).toBe(false);

    reg.begin({ label: 'save', files: ['/a/b.ts'] });
    expect(ctx.isCanceled).toBe(true);
    expect(ctx.reason).toBeInstanceOf(WriteIntentConflict);
  });

  it('registerRead on already-locked file cancels immediately', () => {
    const reg = new WriteIntentRegistry();
    reg.begin({ label: 'save', files: ['/a/b.ts'] });

    const ctx = ProgressContext.detached('read');
    reg.registerRead(ctx, { files: ['/a/b.ts'] });
    expect(ctx.isCanceled).toBe(true);
  });

  it('non-overlapping files do not cancel reads', () => {
    const reg = new WriteIntentRegistry();
    const ctx = ProgressContext.detached('read');
    reg.registerRead(ctx, { files: ['/x.ts'] });

    reg.begin({ label: 'save', files: ['/y.ts'] });
    expect(ctx.isCanceled).toBe(false);
  });

  it('workspace-scope write cancels all reads regardless of files', () => {
    const reg = new WriteIntentRegistry();
    const ctx1 = ProgressContext.detached('read1');
    const ctx2 = ProgressContext.detached('read2');
    reg.registerRead(ctx1, { files: ['/x.ts'] });
    reg.registerRead(ctx2, { files: ['/y.ts'] });

    reg.begin({ label: 'rebuild-index', files: [] });
    expect(ctx1.isCanceled).toBe(true);
    expect(ctx2.isCanceled).toBe(true);
  });

  it('workspace-scope read is canceled by any file-scoped write', () => {
    const reg = new WriteIntentRegistry();
    const ctx = ProgressContext.detached('search');
    reg.registerRead(ctx, { files: [] });  // workspace-level

    reg.begin({ label: 'save', files: ['/a.ts'] });
    expect(ctx.isCanceled).toBe(true);
  });

  it('WriteIntentConflict extends CanceledError', () => {
    const err = new WriteIntentConflict('save', ['/a.ts']);
    expect(err).toBeInstanceOf(CanceledError);
    expect(err.name).toBe('WriteIntentConflict');
    expect(err.intentLabel).toBe('save');
    expect(err.intentFiles).toEqual(['/a.ts']);
  });
});

describe('WriteIntentRegistry · registerRead unsubscribe', () => {
  it('returned unregister removes read from registry', () => {
    const reg = new WriteIntentRegistry();
    const ctx = ProgressContext.detached('read');
    const unregister = reg.registerRead(ctx, { files: ['/a.ts'] });

    expect(reg.snapshot().reads).toHaveLength(1);
    unregister();
    expect(reg.snapshot().reads).toHaveLength(0);

    // 之后的 write 不应再影响这个 ctx
    reg.begin({ label: 'save', files: ['/a.ts'] });
    expect(ctx.isCanceled).toBe(false);
  });

  it('ctx canceled externally auto-removes from registry', () => {
    const reg = new WriteIntentRegistry();
    const ctx = ProgressContext.detached('read');
    reg.registerRead(ctx, { files: ['/a.ts'] });
    ctx.cancel();
    expect(reg.snapshot().reads).toHaveLength(0);
  });
});

describe('WriteIntentRegistry · runUnderRead', () => {
  it('runs fn when no conflict', async () => {
    const reg = new WriteIntentRegistry();
    const fn = vi.fn(async () => 42);
    const result = await reg.runUnderRead(fn, { files: ['/a.ts'] });
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('cancel-on-conflict strategy aborts fn mid-flight', async () => {
    const reg = new WriteIntentRegistry();
    let sawCtx: ProgressContext | undefined;
    const fn = async (ctx: ProgressContext) => {
      sawCtx = ctx;
      await new Promise((r) => setTimeout(r, 50));
      ctx.checkCanceled();
      return 'never';
    };

    const promise = reg.runUnderRead(fn, { files: ['/a.ts'] });
    // 等 fn 开始
    await new Promise((r) => setTimeout(r, 10));
    reg.begin({ label: 'save', files: ['/a.ts'] });

    await expect(promise).rejects.toThrow(WriteIntentConflict);
    expect(sawCtx?.isCanceled).toBe(true);
  });

  it('wait-then-run strategy blocks until conflicting write ends', async () => {
    const reg = new WriteIntentRegistry();
    const token = reg.begin({ label: 'save', files: ['/a.ts'] });
    let ran = false;

    const promise = reg.runUnderRead(
      async () => { ran = true; return 'ok'; },
      { files: ['/a.ts'], strategy: 'wait-then-run' },
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(ran).toBe(false);  // 还在等

    reg.end(token);
    await expect(promise).resolves.toBe('ok');
    expect(ran).toBe(true);
  });
});

describe('WriteIntentRegistry · waitUntilIdle', () => {
  it('resolves immediately when no active writes', async () => {
    const reg = new WriteIntentRegistry();
    await expect(reg.waitUntilIdle()).resolves.toBeUndefined();
  });

  it('resolves after all active writes end', async () => {
    const reg = new WriteIntentRegistry();
    const t1 = reg.begin({ label: 'w1', files: ['/a.ts'] });
    const t2 = reg.begin({ label: 'w2', files: ['/b.ts'] });

    let done = false;
    const promise = reg.waitUntilIdle().then(() => { done = true; });

    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);

    reg.end(t1);
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);

    reg.end(t2);
    await promise;
    expect(done).toBe(true);
  });

  it('rejects on timeout', async () => {
    const reg = new WriteIntentRegistry();
    reg.begin({ label: 'forever', files: ['/a.ts'] });
    await expect(reg.waitUntilIdle(30)).rejects.toThrow(CanceledError);
  });
});

describe('WriteIntentRegistry · signal / timeout auto-end', () => {
  it('external AbortSignal triggers auto end', async () => {
    const reg = new WriteIntentRegistry();
    const controller = new AbortController();
    const token = reg.begin({ label: 'x', files: ['/a.ts'], signal: controller.signal });
    expect(reg.isLocked('/a.ts')).toBe(true);

    controller.abort();
    await new Promise((r) => setTimeout(r, 5));
    expect(reg.isLocked('/a.ts')).toBe(false);
  });

  it('timeoutMs auto-ends after delay', async () => {
    const reg = new WriteIntentRegistry();
    reg.begin({ label: 'tm', files: ['/a.ts'], timeoutMs: 30 });
    expect(reg.isLocked('/a.ts')).toBe(true);

    await new Promise((r) => setTimeout(r, 60));
    expect(reg.isLocked('/a.ts')).toBe(false);
  });

  it('pre-aborted signal ends in next microtask', async () => {
    const reg = new WriteIntentRegistry();
    const controller = new AbortController();
    controller.abort();
    reg.begin({ label: 'pre', files: ['/a.ts'], signal: controller.signal });
    expect(reg.isLocked('/a.ts')).toBe(true);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(reg.isLocked('/a.ts')).toBe(false);
  });
});

describe('WriteIntentRegistry · dispose', () => {
  it('cancels all reads and ends all writes', () => {
    const reg = new WriteIntentRegistry();
    reg.begin({ label: 'w', files: ['/a.ts'] });
    const ctx = ProgressContext.detached('read');
    reg.registerRead(ctx, { files: ['/b.ts'] });

    reg.dispose();

    expect(reg.snapshot().writes).toHaveLength(0);
    expect(reg.snapshot().reads).toHaveLength(0);
    expect(ctx.isCanceled).toBe(true);
  });
});
