import { describe, it, expect, beforeEach } from 'vitest';
import {
  getAgentBudgetAccessor,
  __resetAgentBudgetAccessorForTest,
  suggestFromSnapshot,
  computeWorstPct,
  type AgentBudgetSnapshot,
} from '../agentBudgetAccessor.js';

function makeSnapshot(partial: Partial<AgentBudgetSnapshot> = {}): AgentBudgetSnapshot {
  return {
    sessionId: 'test',
    outputTokensUsed: 0,
    outputTokenBudget: 1000,
    toolCallsUsed: 0,
    toolCallBudget: 100,
    elapsedMs: 0,
    timeBudgetMs: 600_000,
    inputTokensEstimate: 0,
    inputTokenBudget: 200_000,
    compressionThresholdTokens: 140_000,
    llmCallCount: 0,
    totalToolCalls: 0,
    ...partial,
  };
}

describe('suggestFromSnapshot', () => {
  it('returns "ok" below soft threshold', () => {
    expect(suggestFromSnapshot(makeSnapshot({ inputTokensEstimate: 100_000 }))).toBe('ok');
    expect(suggestFromSnapshot(makeSnapshot({ outputTokensUsed: 500 }))).toBe('ok');
  });

  it('returns "save_memory_soon" at/above 65%', () => {
    expect(suggestFromSnapshot(makeSnapshot({ inputTokensEstimate: 130_000 }))).toBe('save_memory_soon');
    expect(suggestFromSnapshot(makeSnapshot({ outputTokensUsed: 700 }))).toBe('save_memory_soon');
    expect(suggestFromSnapshot(makeSnapshot({ toolCallsUsed: 70 }))).toBe('save_memory_soon');
  });

  it('returns "save_memory_and_restart" at/above 85%', () => {
    expect(suggestFromSnapshot(makeSnapshot({ inputTokensEstimate: 170_000 }))).toBe('save_memory_and_restart');
    expect(suggestFromSnapshot(makeSnapshot({ outputTokensUsed: 900 }))).toBe('save_memory_and_restart');
    expect(suggestFromSnapshot(makeSnapshot({ elapsedMs: 540_000 }))).toBe('save_memory_and_restart');
  });

  it('takes worst dimension when multiple triggers', () => {
    expect(
      suggestFromSnapshot(makeSnapshot({
        inputTokensEstimate: 10_000,
        outputTokensUsed: 950,  // 95%
      })),
    ).toBe('save_memory_and_restart');
  });

  it('zero budgets dont trigger', () => {
    expect(
      suggestFromSnapshot(makeSnapshot({
        inputTokenBudget: 0,
        outputTokenBudget: 0,
        toolCallBudget: 0,
        timeBudgetMs: 0,
      })),
    ).toBe('ok');
  });
});

describe('computeWorstPct', () => {
  it('returns max across dimensions', () => {
    const pct = computeWorstPct(makeSnapshot({
      inputTokensEstimate: 20_000,    // 10%
      outputTokensUsed: 700,          // 70%
      toolCallsUsed: 50,              // 50%
      elapsedMs: 120_000,             // 20%
    }));
    expect(Math.round(pct * 100)).toBe(70);
  });
});

describe('AgentBudgetAccessor ALS', () => {
  beforeEach(() => { __resetAgentBudgetAccessorForTest(); });

  it('getSnapshot returns undefined outside session', () => {
    const a = getAgentBudgetAccessor();
    expect(a.getSnapshot()).toBeUndefined();
  });

  it('enterSession binds getter to current async context', () => {
    const a = getAgentBudgetAccessor();
    let used = 100;
    a.enterSession(() => makeSnapshot({ outputTokensUsed: used }));
    const first = a.getSnapshot();
    expect(first?.outputTokensUsed).toBe(100);
    // 值会被 getter 实时读 — mutate after enter
    used = 500;
    const second = a.getSnapshot();
    expect(second?.outputTokensUsed).toBe(500);
  });

  it('getter throwing returns undefined (defensive)', () => {
    const a = getAgentBudgetAccessor();
    a.enterSession(() => { throw new Error('boom'); });
    expect(a.getSnapshot()).toBeUndefined();
  });
});
