import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  classifyRetry, backoffMs, noteAnomaly, getAutoRetryState, cancelAutoRetry,
  AUTO_RETRY_MAX, __resetAutoRetryForTests,
} from '../turnAutoRetry';

const SID = 'sess-retry';

beforeEach(() => { __resetAutoRetryForTests(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); __resetAutoRetryForTests(); });

describe('哪些错误可以自己重试', () => {
  it('链路故障 → 自动重试', () => {
    for (const code of ['NETWORK', 'TIMEOUT', 'CONNECT_TIMEOUT', 'STREAM_INCOMPLETE', 'UPSTREAM_5XX', 'POD_BUSY']) {
      expect(classifyRetry({ code })).toBe('transport');
    }
    expect(classifyRetry({ code: 'network.dns' })).toBe('transport');
    expect(classifyRetry({ code: 'stream.disconnected' })).toBe('transport');
  });

  it('限流 → 自动重试, 但走更长的退避', () => {
    expect(classifyRetry({ code: 'RATE_LIMIT' })).toBe('rate-limit');
    expect(backoffMs(1, 'rate-limit')).toBeGreaterThan(backoffMs(1, 'transport'));
  });

  it('400 / 鉴权 / 额度 / 上下文超窗 → 绝不自动重试 (重发只会把同一个错误再买一遍)', () => {
    for (const code of ['RUNTIME_ERROR', 'BAD_REQUEST', 'CONTEXT_EXCEEDED', 'AUTH_EXPIRED',
      'QUOTA_EXCEEDED', 'LOOP_DETECTED', 'EMPTY_RESPONSE', 'TIMELINE_TURN_WITHOUT_EVENTS']) {
      expect(classifyRetry({ code })).toBe('none');
    }
  });

  it('这些码即使上游说 retryable 也不自动 —— 白名单说了不算', () => {
    expect(classifyRetry({ code: 'RUNTIME_ERROR', retryable: true })).toBe('none');
    expect(classifyRetry({ code: 'QUOTA_EXCEEDED', retryable: true })).toBe('none');
  });

  it('没见过的码: 只有上游明说 retryable 才自动; 拿不准一律不自动', () => {
    expect(classifyRetry({ code: 'WEIRD_NEW_CODE' })).toBe('none');
    expect(classifyRetry({ code: 'WEIRD_NEW_CODE', retryable: true })).toBe('transport');
    expect(classifyRetry({})).toBe('none');
  });
});

describe('退避阶梯', () => {
  it('指数上升并封顶 30s —— 固定间隔猛打会把限流打得更死', () => {
    expect(backoffMs(1, 'transport')).toBe(2_000);
    expect(backoffMs(2, 'transport')).toBe(4_000);
    expect(backoffMs(3, 'transport')).toBe(8_000);
    expect(backoffMs(9, 'transport')).toBe(30_000);
    expect(backoffMs(99, 'rate-limit')).toBe(30_000);
  });
});

describe('排程', () => {
  const note = (seenAt: number, fire: () => void, code = 'NETWORK') =>
    noteAnomaly({ sessionId: SID, entryId: 'timeline-error-a-NETWORK', code, seenAt, fire });

  it('到点开火一次, 且只开一次', () => {
    const fire = vi.fn();
    note(1, fire);
    expect(getAutoRetryState(SID)?.nextAt).toBeTruthy();
    vi.advanceTimersByTime(2_000);
    expect(fire).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('同一次失败反复渲染不会叠定时器', () => {
    const fire = vi.fn();
    note(1, fire); note(1, fire); note(1, fire);
    vi.advanceTimersByTime(5_000);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('又失败一次 → 次数 +1, 等得更久', () => {
    const fire = vi.fn();
    note(1, fire);
    vi.advanceTimersByTime(2_000);          /* 第 1 次 */
    note(2, fire);                          /* 又失败 */
    expect(getAutoRetryState(SID)?.waitMs).toBe(4_000);
    vi.advanceTimersByTime(4_000);
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it(`最多 ${AUTO_RETRY_MAX} 次, 之后停下来交给用户`, () => {
    const fire = vi.fn();
    for (let i = 1; i <= AUTO_RETRY_MAX + 3; i++) {
      note(i, fire);
      vi.advanceTimersByTime(30_000);
    }
    expect(fire).toHaveBeenCalledTimes(AUTO_RETRY_MAX);
    expect(getAutoRetryState(SID)?.exhausted).toBe(true);
  });

  it('取消后不再开火 (用户点了关闭 / 这一轮跑成了)', () => {
    const fire = vi.fn();
    note(1, fire);
    cancelAutoRetry(SID);
    vi.advanceTimersByTime(30_000);
    expect(fire).not.toHaveBeenCalled();
    expect(getAutoRetryState(SID)).toBeNull();
  });

  it('不可自动重试的错误压根不排程', () => {
    const fire = vi.fn();
    note(1, fire, 'RUNTIME_ERROR');
    vi.advanceTimersByTime(60_000);
    expect(fire).not.toHaveBeenCalled();
    expect(getAutoRetryState(SID)).toBeNull();
  });

  it('换成另一条错误 → 从头开始数', () => {
    const fire = vi.fn();
    note(1, fire);
    vi.advanceTimersByTime(2_000);
    noteAnomaly({ sessionId: SID, entryId: 'timeline-error-b-TIMEOUT', code: 'TIMEOUT', seenAt: 9, fire });
    expect(getAutoRetryState(SID)?.waitMs).toBe(2_000);
  });
});
