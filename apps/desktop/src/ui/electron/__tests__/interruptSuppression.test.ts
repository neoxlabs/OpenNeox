import { describe, expect, it } from 'vitest';
import { shouldSuppressRunningAfterInterrupt, INTERRUPT_SUPPRESS_MAX_MS } from '../services/interruptSuppression.js';

const T0 = 1_000_000;

describe('shouldSuppressRunningAfterInterrupt', () => {
  it('没中断过的会话完全不受影响', () => {
    expect(shouldSuppressRunningAfterInterrupt({
      next: 'running', reason: 'authority:run-state-changed', interruptedAt: undefined, sawActivityAfterInterrupt: false, now: T0,
    })).toBe(false);
  });

  /* 这条就是用户报的那个 bug */
  it('中断后窗口内的 running 心跳被吞掉', () => {
    expect(shouldSuppressRunningAfterInterrupt({
      next: 'running', reason: 'authority:run-state-changed', interruptedAt: T0, sawActivityAfterInterrupt: false, now: T0 + 5_000,
    })).toBe(true);
  });

  it('对账拉回来的 running 同样被吞', () => {
    expect(shouldSuppressRunningAfterInterrupt({
      next: 'running', reason: 'authority:reconcile', interruptedAt: T0, sawActivityAfterInterrupt: false, now: T0 + 8_000,
    })).toBe(true);
  });

  it('recovering 跟 running 一视同仁', () => {
    expect(shouldSuppressRunningAfterInterrupt({
      next: 'recovering', reason: 'authority:run-state-changed', interruptedAt: T0, sawActivityAfterInterrupt: false, now: T0 + 3_000,
    })).toBe(true);
  });

  it('idle 永远放行 —— 它正是我们在等的确认', () => {
    expect(shouldSuppressRunningAfterInterrupt({
      next: 'idle', reason: 'authority:run-state-changed', interruptedAt: T0, sawActivityAfterInterrupt: false, now: T0 + 1_000,
    })).toBe(false);
  });

  /* 真正解除抑制的判据是"又有产出了", 不是时间 —— 见下面两条。
   * 这条只验兜底上限还在。 */
  it('超过兜底上限后放行 (防抑制永远挂着)', () => {
    expect(shouldSuppressRunningAfterInterrupt({
      next: 'running', reason: 'authority:run-state-changed',
      interruptedAt: T0, sawActivityAfterInterrupt: false, now: T0 + INTERRUPT_SUPPRESS_MAX_MS + 1,
    })).toBe(false);
  });

  it('边界: 正好到上限时放行', () => {
    expect(shouldSuppressRunningAfterInterrupt({
      next: 'running', reason: 'authority:run-state-changed',
      interruptedAt: T0, sawActivityAfterInterrupt: false, now: T0 + INTERRUPT_SUPPRESS_MAX_MS,
    })).toBe(false);
  });

  /* 中断后用户立刻改主意再发一条 —— 新一轮必须能转起来,
   * 否则就从"停不下来"变成"发了消息不动", 一样是卡死。 */
  it('用户发的新消息不受抑制', () => {
    expect(shouldSuppressRunningAfterInterrupt({
      next: 'running', reason: 'send:start', interruptedAt: T0, sawActivityAfterInterrupt: false, now: T0 + 500,
    })).toBe(false);
    expect(shouldSuppressRunningAfterInterrupt({
      next: 'running', reason: 'send:accepted', interruptedAt: T0, sawActivityAfterInterrupt: false, now: T0 + 500,
    })).toBe(false);
  });
});

describe('活动信号优先于时间', () => {
  it('中断后没有产出 → 一直抑制 (哪怕远超旧的 12s 窗口)', () => {
    expect(shouldSuppressRunningAfterInterrupt({
      next: 'running', reason: 'authority:run-state-changed',
      interruptedAt: T0, sawActivityAfterInterrupt: false, now: T0 + 60_000,
    })).toBe(true);
  });

  it('中断后又有产出 → 立刻放行, 不瞒着用户', () => {
    expect(shouldSuppressRunningAfterInterrupt({
      next: 'running', reason: 'authority:run-state-changed',
      interruptedAt: T0, sawActivityAfterInterrupt: true, now: T0 + 500,
    })).toBe(false);
  });
});
