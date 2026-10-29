import { describe, test, expect } from 'vitest';
import {
  evaluateExecutionWatchdog,
  EXECUTION_HARD_CEILING_MS,
  WATCHDOG_IDLE_RENEW_MS,
} from '../executionWatchdogPolicy.js';

describe('executionWatchdogPolicy', () => {
  test('★ 流一直活着也要报长跑 — 这就是 612s 长尾"未触发 stuck"的形状', () => {
    /* 每 5s 一个心跳 → idleForMs 永远很小, 老实现里上界永远等不到 */
    const d = evaluateExecutionWatchdog({
      idleForMs: 5_000,
      totalMs: 612_000,
      alreadyNotifiedLongRun: false,
    });
    expect(d.warnLongRun).toBe(true);
    expect(d.renewOnly).toBe(true);   // 仍然继续观察, 不强制收敛
    expect(d.longRunMinutes).toBe(10);
  });

  test('同一轮只报一次 — 看门狗每次续期都会重跑判定', () => {
    const d = evaluateExecutionWatchdog({
      idleForMs: 5_000,
      totalMs: 900_000,
      alreadyNotifiedLongRun: true,
    });
    expect(d.warnLongRun).toBe(false);
  });

  test('没到上界不报', () => {
    const d = evaluateExecutionWatchdog({
      idleForMs: 5_000,
      totalMs: EXECUTION_HARD_CEILING_MS - 1,
      alreadyNotifiedLongRun: false,
    });
    expect(d.warnLongRun).toBe(false);
    expect(d.renewOnly).toBe(true);
  });

  test('断流才进入收敛判定 (renewOnly=false)', () => {
    expect(evaluateExecutionWatchdog({
      idleForMs: WATCHDOG_IDLE_RENEW_MS - 1, totalMs: 60_000, alreadyNotifiedLongRun: false,
    }).renewOnly).toBe(true);
    expect(evaluateExecutionWatchdog({
      idleForMs: WATCHDOG_IDLE_RENEW_MS, totalMs: 60_000, alreadyNotifiedLongRun: false,
    }).renewOnly).toBe(false);
  });

  test('两个条件互不影响 — 断流 + 超上界时两件事都要发生', () => {
    const d = evaluateExecutionWatchdog({
      idleForMs: 200_000,
      totalMs: 700_000,
      alreadyNotifiedLongRun: false,
    });
    expect(d.warnLongRun).toBe(true);
    expect(d.renewOnly).toBe(false);
  });
});
