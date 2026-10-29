/**
 * pendingConfirmations 单测 (pilot:H-08)。
 *
 * 失效方式: 审批清了账本没清 → 下一轮一直说「在等你确认」; 会话收尾没清 → 幽灵待办。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  __resetPendingConfirmationsForTesting,
  clearPendingConfirmations,
  listPendingConfirmations,
  registerPendingConfirmation,
  resolvePendingConfirmation,
} from '../pendingConfirmations.js';

const S = 'sess-1';
const T0 = 1_700_000_000_000;

describe('pendingConfirmations', () => {
  beforeEach(() => __resetPendingConfirmationsForTesting());

  it('登记后能读到; 按登记顺序', () => {
    registerPendingConfirmation(S, { id: 'a', kind: 'approval', toolName: 'bash', since: T0 });
    registerPendingConfirmation(S, { id: 'b', kind: 'user', since: T0 + 1 });
    expect(listPendingConfirmations(S, T0 + 2).map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('注销 / 整条会话清账后读不到', () => {
    registerPendingConfirmation(S, { id: 'a', kind: 'approval', toolName: 'bash', since: T0 });
    resolvePendingConfirmation(S, 'a');
    expect(listPendingConfirmations(S, T0 + 1)).toEqual([]);

    registerPendingConfirmation(S, { id: 'b', kind: 'user', since: T0 });
    clearPendingConfirmations(S);
    expect(listPendingConfirmations(S, T0 + 1)).toEqual([]);
  });

  it('重复登记 / 重复注销都是幂等的', () => {
    registerPendingConfirmation(S, { id: 'a', kind: 'approval', toolName: 'bash', since: T0 });
    registerPendingConfirmation(S, { id: 'a', kind: 'approval', toolName: 'bash', since: T0 + 5 });
    expect(listPendingConfirmations(S, T0 + 6)).toHaveLength(1);
    resolvePendingConfirmation(S, 'a');
    expect(() => resolvePendingConfirmation(S, 'a')).not.toThrow();
  });

  it('超过 1 小时的等待项自动不再列出', () => {
    registerPendingConfirmation(S, { id: 'old', kind: 'approval', toolName: 'bash', since: T0 });
    expect(listPendingConfirmations(S, T0 + 61 * 60_000)).toEqual([]);
  });

  it('非法入参不抛也不入账', () => {
    registerPendingConfirmation('', { id: 'a', kind: 'approval' });
    registerPendingConfirmation(S, { id: '', kind: 'approval' });
    registerPendingConfirmation(S, { id: 'a', kind: 'nope' as any });
    expect(listPendingConfirmations(S, T0)).toEqual([]);
  });

  it('同一会话最多留 5 条 (旧的最先被挤掉)', () => {
    for (let i = 0; i < 7; i++) {
      registerPendingConfirmation(S, { id: `r${i}`, kind: 'approval', toolName: 'bash', since: T0 + i });
    }
    expect(listPendingConfirmations(S, T0 + 10).map((p) => p.id)).toEqual(['r2', 'r3', 'r4', 'r5', 'r6']);
  });
});
