import { describe, expect, it, vi } from 'vitest';
import { awaitToolWithAbort, TOOL_ABANDONED, DEFAULT_TOOL_ABORT_GRACE_MS } from '../toolAbortRace.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('awaitToolWithAbort', () => {
  it('没有 signal → 直接等结果 (CLI/SDK 不传信号的场合行为不变)', async () => {
    await expect(awaitToolWithAbort(Promise.resolve('ok'), undefined)).resolves.toBe('ok');
  });

  it('abort 前工具已完成 → 返回真结果', async () => {
    const ac = new AbortController();
    const onAbandoned = vi.fn();
    const p = awaitToolWithAbort(Promise.resolve('done'), ac.signal, { graceMs: 50, onAbandoned });
    await expect(p).resolves.toBe('done');
    ac.abort();
    await sleep(80);
    expect(onAbandoned).not.toHaveBeenCalled();
  });

  it('工具正常响应 abort (grace 内返回) → 拿到它自己的结果, 不算放弃', async () => {
    const ac = new AbortController();
    const onAbandoned = vi.fn();
    const run = new Promise<string>((resolve) => {
      ac.signal.addEventListener('abort', () => setTimeout(() => resolve('stopped by signal'), 5), { once: true });
    });
    const p = awaitToolWithAbort(run, ac.signal, { graceMs: 200, onAbandoned });
    setTimeout(() => ac.abort(), 10);
    await expect(p).resolves.toBe('stopped by signal');
    expect(onAbandoned).not.toHaveBeenCalled();
  });

  it('工具不响应 abort → 超过 graceMs 返回 TOOL_ABANDONED, 并回调 onAbandoned', async () => {
    const ac = new AbortController();
    const onAbandoned = vi.fn();
    const never = new Promise<string>(() => { /* 永不 settle */ });
    const p = awaitToolWithAbort(never, ac.signal, { graceMs: 60, onAbandoned });
    const started = Date.now();
    setTimeout(() => ac.abort(), 10);
    await expect(p).resolves.toBe(TOOL_ABANDONED);
    expect(Date.now() - started).toBeLessThan(500);
    expect(onAbandoned).toHaveBeenCalledTimes(1);
    expect(onAbandoned.mock.calls[0][0].waitedMs).toBeGreaterThanOrEqual(55);
  });

  it('放弃之后工具才 settle → 结果不进调用方, 只走 onLateSettle (迟到 fulfilled)', async () => {
    const ac = new AbortController();
    const onLateSettle = vi.fn();
    const late = sleep(120).then(() => 'late-secret');
    const p = awaitToolWithAbort(late, ac.signal, { graceMs: 30, onLateSettle });
    setTimeout(() => ac.abort(), 5);
    await expect(p).resolves.toBe(TOOL_ABANDONED);
    expect(onLateSettle).not.toHaveBeenCalled();
    await sleep(200);
    expect(onLateSettle).toHaveBeenCalledTimes(1);
    expect(onLateSettle.mock.calls[0][0].outcome).toBe('fulfilled');
  });

  it('放弃之后工具才 reject → 不抛未处理异常, 只记一行 (迟到 rejected)', async () => {
    const ac = new AbortController();
    const onLateSettle = vi.fn();
    const late = sleep(80).then(() => { throw new Error('late boom'); });
    const p = awaitToolWithAbort(late, ac.signal, { graceMs: 20, onLateSettle });
    setTimeout(() => ac.abort(), 5);
    await expect(p).resolves.toBe(TOOL_ABANDONED);
    await sleep(160);
    expect(onLateSettle).toHaveBeenCalledTimes(1);
    expect(onLateSettle.mock.calls[0][0].outcome).toBe('rejected');
    expect(String(onLateSettle.mock.calls[0][0].error)).toContain('late boom');
  });

  it('把工具抛的错原样传给调用方 (没废弃时)', async () => {
    const ac = new AbortController();
    await expect(
      awaitToolWithAbort(Promise.reject(new Error('real failure')), ac.signal, { graceMs: 50 }),
    ).rejects.toThrow('real failure');
  });

  it('默认宽容 3 秒 (总控定的数不能被默默改小)', () => {
    expect(DEFAULT_TOOL_ABORT_GRACE_MS).toBe(3000);
  });
});
