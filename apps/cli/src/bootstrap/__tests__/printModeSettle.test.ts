import { describe, expect, it } from 'vitest';
import type { SessionWorkState } from '@neoxlabs/core/sdk/localRuntimeAdapter.js';
import {
  MAX_CONTINUATION_TURNS,
  waitForPrintSettlement,
  type PrintSettleResult,
} from '../printModeSettle.js';

const idle: SessionWorkState = {
  activeChat: false,
  pendingNotifications: false,
  trackedBackgroundProcesses: 0,
  runningSubAgents: false,
};
const active: SessionWorkState = { ...idle, activeChat: true };
const backgroundProcess: SessionWorkState = { ...idle, trackedBackgroundProcesses: 1 };
const pendingNotification: SessionWorkState = { ...idle, pendingNotifications: true };
const runningAgent: SessionWorkState = { ...idle, runningSubAgents: true };

/**
 * 假时钟 + 脚本事列。每调一次 getState 消耗一个状态, 用完后重复最后一个。
 * sleep 里推进时钟 —— 不需要真等。
 */
function harness(states: SessionWorkState[], overrides: {
  quietMs?: number;
  pollMs?: number;
  maxTurns?: number;
  maxContinuationTurns?: number;
  deadlineAt?: number;
  signal?: AbortSignal;
  onLimit?: (reason: 'max_turns' | 'continuations') => void;
} = {}): { run: Promise<PrintSettleResult>; elapsed: () => number; samples: () => number } {
  let t = 0;
  let i = 0;
  let sampleCount = 0;
  const run = waitForPrintSettlement({
    getState: () => {
      sampleCount++;
      return states[Math.min(i++, states.length - 1)] ?? null;
    },
    now: () => t,
    sleep: async (ms) => { t += ms; },
    pollMs: overrides.pollMs ?? 100,
    quietMs: overrides.quietMs ?? 1000,
    maxTurns: overrides.maxTurns,
    maxContinuationTurns: overrides.maxContinuationTurns,
    deadlineAt: overrides.deadlineAt,
    signal: overrides.signal,
    onLimit: overrides.onLimit,
  });
  return { run, elapsed: () => t, samples: () => sampleCount };
}

const repeating = (state: SessionWorkState, n = 50): SessionWorkState[] => Array.from({ length: n }, () => state);

describe('waitForPrintSettlement', () => {
  it('does not wait at all when the session is already idle after the first turn', async () => {
    const h = harness([idle]);
    await expect(h.run).resolves.toBe('settled');
    expect(h.elapsed()).toBe(0);
    expect(h.samples()).toBe(1);
  });

  it('treats an unreportable session (null) as settled instead of hanging', async () => {
    const run = waitForPrintSettlement({
      getState: () => null,
      now: () => 0,
      sleep: async () => { throw new Error('should not sleep'); },
    });
    await expect(run).resolves.toBe('settled');
  });

  it('waits for a running background process, then requires a quiet window', async () => {
    const h = harness([backgroundProcess, ...repeating(idle)], { quietMs: 1000, pollMs: 100 });
    await expect(h.run).resolves.toBe('settled');
    /* 先看到一次活, 再连续静默 1000ms 才收工 */
    expect(h.elapsed()).toBeGreaterThanOrEqual(1000);
  });

  it('waits while a background sub-agent is running', async () => {
    const h = harness([runningAgent, ...repeating(idle)], { quietMs: 1000, pollMs: 100 });
    await expect(h.run).resolves.toBe('settled');
    expect(h.elapsed()).toBeGreaterThanOrEqual(1000);
  });

  it('keeps waiting while notifications are queued (next turn not started yet)', async () => {
    const h = harness([pendingNotification, pendingNotification, idle], { quietMs: 300, pollMs: 100 });
    await expect(h.run).resolves.toBe('settled');
    expect(h.elapsed()).toBeGreaterThanOrEqual(300);
  });

  it('returns timeout when the deadline passes while background work is still pending', async () => {
    const h = harness(repeating(backgroundProcess), { deadlineAt: 500, pollMs: 100 });
    await expect(h.run).resolves.toBe('timeout');
    expect(h.elapsed()).toBeGreaterThanOrEqual(500);
  });

  it('returns aborted when the signal is already aborted (Ctrl+C / SIGTERM)', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(harness(repeating(backgroundProcess), { signal: ac.signal }).run).resolves.toBe('aborted');
  });

  it('stops at --max-turns and reports which limit fired', async () => {
    const limits: string[] = [];
    const h = harness(repeating(active), {
      maxTurns: 1,
      onLimit: (reason) => limits.push(reason),
    });
    await expect(h.run).resolves.toBe('turn_limit');
    expect(limits).toEqual(['max_turns']);
  });

  it('stops after too many background-triggered turns (internal fuse)', async () => {
    const limits: string[] = [];
    const h = harness([active, idle, active, idle, active], {
      maxContinuationTurns: 1,
      onLimit: (reason) => limits.push(reason),
    });
    await expect(h.run).resolves.toBe('turn_limit');
    expect(limits).toEqual(['continuations']);
  });

  it('ships a finite internal continuation fuse', () => {
    expect(MAX_CONTINUATION_TURNS).toBeGreaterThan(0);
    expect(Number.isFinite(MAX_CONTINUATION_TURNS)).toBe(true);
  });
});
