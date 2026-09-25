/**
 * 熔断器必须能自己恢复 — 行为锁
 *
 * 事故: state 是模块级单例, circuitOpen 只有 recordCompactSuccess 能清, 而熔断态下
 * shouldAutoCompact 直接 return false → 压缩再也不被调用 → 成功永不发生。三次失败之后
 * 整个进程(所有会话)的自动压缩永久关闭, 上下文一路长到 285% / 361%。
 *
 * 这里锁两个恢复出口: 冷却半开 + 溢出旁路。
 * (测试放 kernel 包内: 根 vitest 没给 @openneox/kernel 配 src alias, 从 core 的
 *  re-export shim 进来测到的是 dist 旧产物 —— 改了 src 也照样绿。)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  shouldAutoCompact,
  acquireCompactLock,
  recordCompactFailure,
  resetAutoCompactState,
} from '../autoCompactGuard.js';

describe('AutoCompactGuard circuit breaker recovery', () => {
  beforeEach(() => {
    resetAutoCompactState();
  });

  function tripBreaker(): void {
    for (let i = 0; i < 3; i++) {
      acquireCompactLock();
      recordCompactFailure(new Error(`fail ${i}`));
    }
  }

  it('half-opens after the cooldown elapses', () => {
    tripBreaker();
    expect(shouldAutoCompact(170_000, 200_000).should).toBe(false);

    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 4 * 60_000;   // 冷却 3 分钟 → 已过
      expect(shouldAutoCompact(170_000, 200_000).should).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });

  it('bypasses the breaker once context is already overflowing', () => {
    tripBreaker();
    // 180K = 有效窗口 (200K - 20K 摘要预留): 再拦就是必定 context_length_exceeded
    expect(shouldAutoCompact(185_000, 200_000).should).toBe(true);
    // 没溢出且冷却未到 → 仍然拦
    expect(shouldAutoCompact(170_000, 200_000).should).toBe(false);
  });
});
