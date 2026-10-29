import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  calculateBackoff,
  getRetryDelay,
  cancellableSleep,
  abortableSleep,
  interruptibleSleep,
  formatDelay,
  calculateRateLimitBackoff,
  getSmartRetryDelay,
  calculateTotalRetryTime,
  MAX_SERVER_RETRY_AFTER_MS,
  RATE_LIMIT_BACKOFF_CONFIG,
  STREAM_INTERRUPT_BACKOFF_CONFIG,
} from '../backoff.js';
import { ErrorCategory } from '../../types/errors.js';

const noJitter = { initialDelayMs: 1000, backoffFactor: 2, maxDelayMs: 60_000, jitterRange: 0 };

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('calculateBackoff', () => {
  it('按指数增长且没有 jitter 时是确定值', () => {
    expect(calculateBackoff(1, noJitter)).toBe(1000);
    expect(calculateBackoff(2, noJitter)).toBe(2000);
    expect(calculateBackoff(3, noJitter)).toBe(4000);
  });

  it('attempt <= 1 时指数为 0（不会变小）', () => {
    expect(calculateBackoff(0, noJitter)).toBe(1000);
    expect(calculateBackoff(-5, noJitter)).toBe(1000);
  });

  it('超过上限时被 cap', () => {
    expect(calculateBackoff(10, noJitter)).toBe(60_000);
  });

  it('jitter 上界：random=1 时增加 jitterRange 比例', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    expect(calculateBackoff(1, { ...noJitter, jitterRange: 0.5 })).toBe(1500);
  });

  it('jitter 下界：random=0 时减少 jitterRange 比例', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(calculateBackoff(1, { ...noJitter, jitterRange: 0.5 })).toBe(500);
  });

  it('结果向下取整', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.333);
    expect(Number.isInteger(calculateBackoff(1, { ...noJitter, jitterRange: 0.1 }))).toBe(true);
  });
});

describe('getRetryDelay', () => {
  it('优先使用服务端 retry-after', () => {
    expect(getRetryDelay(5000, 5, noJitter)).toBe(5000);
  });

  it('服务端给过长等待时截到 60 秒', () => {
    expect(getRetryDelay(446_105_000, 1)).toBe(MAX_SERVER_RETRY_AFTER_MS);
  });

  it('服务端值为 0 / 负数 / undefined 时回退退避', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(getRetryDelay(0, 2, noJitter)).toBe(2000);
    expect(getRetryDelay(-1, 2, noJitter)).toBe(2000);
    expect(getRetryDelay(undefined, 2, noJitter)).toBe(2000);
  });
});

describe('cancellableSleep', () => {
  it('正常计时结束后 resolve(true)', async () => {
    vi.useFakeTimers();
    const { promise } = cancellableSleep(100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(promise).resolves.toBe(true);
  });

  it('cancel 之后永不 resolve', async () => {
    vi.useFakeTimers();
    const { promise, cancel } = cancellableSleep(100);
    let settled = false;
    promise.then(() => { settled = true; });
    cancel();
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toBe(false);
  });
});

describe('abortableSleep', () => {
  it('正常结束后 resolve', async () => {
    vi.useFakeTimers();
    const p = abortableSleep(50);
    await vi.advanceTimersByTimeAsync(50);
    await expect(p).resolves.toBeUndefined();
  });

  it('传入已 abort 的 signal 立即 reject AbortError', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(abortableSleep(10, ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('等待中被 abort 时立即 reject', async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const p = abortableSleep(60_000, ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('interruptibleSleep', () => {
  it('已 abort 时立即 resolve（绝不 reject）', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(interruptibleSleep(10_000, ac.signal)).resolves.toBeUndefined();
  });

  it('等待中被 abort 时提前 resolve', async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const p = interruptibleSleep(60_000, ac.signal);
    ac.abort();
    await expect(p).resolves.toBeUndefined();
  });

  it('正常结束后 resolve', async () => {
    vi.useFakeTimers();
    const p = interruptibleSleep(30);
    await vi.advanceTimersByTimeAsync(30);
    await expect(p).resolves.toBeUndefined();
  });
});

describe('formatDelay', () => {
  it('毫秒 / 秒 / 分三档格式化', () => {
    expect(formatDelay(0)).toBe('0ms');
    expect(formatDelay(999)).toBe('999ms');
    expect(formatDelay(1000)).toBe('1.0s');
    expect(formatDelay(59_999)).toBe('60.0s');
    expect(formatDelay(60_000)).toBe('1.0m');
    expect(formatDelay(90_000)).toBe('1.5m');
  });
});

describe('calculateRateLimitBackoff', () => {
  it('无 retry-after 时用限流专用配置（1.5s 起步）', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // jitter = 1
    expect(calculateRateLimitBackoff(1)).toBe(1500);
    expect(calculateRateLimitBackoff(2)).toBe(3750);
  });

  it('有 retry-after 时仅加 0~20% jitter', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(calculateRateLimitBackoff(3, 2000)).toBe(2000);
    vi.restoreAllMocks();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(calculateRateLimitBackoff(3, 2000)).toBe(2200);
  });

  it('服务端 retry-after 过长时 cap 到 60 秒', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(calculateRateLimitBackoff(1, 500_000)).toBe(MAX_SERVER_RETRY_AFTER_MS);
  });
});

describe('getSmartRetryDelay', () => {
  it('限流错误走限流退避（服务端值优先）', () => {
    expect(getSmartRetryDelay(ErrorCategory.RETRYABLE_RATE_LIMIT, 2, 5000)).toBeLessThanOrEqual(6000);
    expect(getSmartRetryDelay(ErrorCategory.RETRYABLE_RATE_LIMIT, 2, 5000)).toBeGreaterThanOrEqual(5000);
  });

  it('流中断 / 网络错误走更温和的退避', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // jitter = 1
    expect(getSmartRetryDelay(ErrorCategory.RETRYABLE_STREAM, 1)).toBe(1000);
    expect(getSmartRetryDelay(ErrorCategory.RETRYABLE_NETWORK, 3)).toBe(2250);
    expect(getSmartRetryDelay(ErrorCategory.RETRYABLE_STREAM, 99)).toBe(10_000);
  });

  it('其他类别走标准退避', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(getSmartRetryDelay(ErrorCategory.RETRYABLE_HTTP, 1, 7000)).toBe(7000);
  });
});

describe('calculateTotalRetryTime', () => {
  it('累加不含 jitter 的指数退避', () => {
    expect(calculateTotalRetryTime(3, { initialDelayMs: 100, backoffFactor: 2, maxDelayMs: 10_000 })).toBe(700);
  });

  it('受 maxDelayMs 限制', () => {
    expect(calculateTotalRetryTime(3, { initialDelayMs: 100, backoffFactor: 2, maxDelayMs: 150 })).toBe(400);
  });

  it('0 次重试返回 0', () => {
    expect(calculateTotalRetryTime(0)).toBe(0);
  });
});

describe('退避配置常量', () => {
  it('限流配置与流中断配置符合注释约定', () => {
    expect(MAX_SERVER_RETRY_AFTER_MS).toBe(60_000);
    expect(RATE_LIMIT_BACKOFF_CONFIG).toMatchObject({ initialDelayMs: 1500, backoffFactor: 2.5, maxDelayMs: 60_000, jitterRange: 0.3 });
    expect(STREAM_INTERRUPT_BACKOFF_CONFIG).toMatchObject({ initialDelayMs: 1000, backoffFactor: 1.5, maxDelayMs: 10_000, jitterRange: 0.2 });
  });
});
