import { describe, expect, it, vi } from 'vitest';
import { createExploreProgress } from '../exploreProgress.js';
import type { AgentRuntimeEvent } from '../../runtimeTypes.js';

const usage = (totalTokens: number, usageEstimated = false): AgentRuntimeEvent => ({
  type: 'token_usage', totalTokens, promptTokens: totalTokens - 10, completionTokens: 10,
  sessionPromptTokens: 0, sessionCompletionTokens: 0, usageEstimated,
});

describe('explore progress', () => {
  it('replaces streaming estimates with settled input + output and sums requests', () => {
    let now = 1000;
    const emit = vi.fn();
    const progress = createExploreProgress(emit, () => now);
    progress.observe({ type: 'thinking', iteration: 1 });
    now += 250;
    progress.observe({ type: 'reasoning', delta: 'thinking' });
    expect(emit.mock.lastCall?.[0]).toMatchObject({ iterations: 1, tokens: 2, tokensEstimated: true });
    progress.observe(usage(110));
    expect(emit.mock.lastCall?.[0]).toMatchObject({ tokens: 110, tokensEstimated: false });
    progress.observe({ type: 'thinking', iteration: 2 });
    progress.observe({ type: 'text', delta: 'result' });
    progress.observe(usage(210));
    now += 1000;
    progress.flush();
    expect(emit.mock.lastCall?.[0]).toEqual({
      iterations: 2, tokens: 320, tokensEstimated: false, startedAt: 1000, elapsed: 1250,
    });
  });

  it('throttles deltas but flushes the last partial output on completion or abort', () => {
    const emit = vi.fn();
    const progress = createExploreProgress(emit, () => 1000);
    progress.observe({ type: 'thinking', iteration: 1 });
    for (let i = 0; i < 20; i++) progress.observe({ type: 'text', delta: 'a' });
    expect(emit).toHaveBeenCalledTimes(1);
    progress.flush();
    expect(emit.mock.lastCall?.[0]).toMatchObject({ tokens: 5, tokensEstimated: true });
  });

  it('keeps parallel agents isolated and counts transport retry iterations', () => {
    const emitA = vi.fn();
    const emitB = vi.fn();
    const a = createExploreProgress(emitA);
    const b = createExploreProgress(emitB);
    a.observe({ type: 'thinking', iteration: 1 });
    a.observe(usage(100));
    b.observe({ type: 'thinking', iteration: 1 });
    b.observe(usage(200));
    a.observe({ type: 'thinking', iteration: 1 });
    a.observe(usage(300));
    expect(emitA.mock.lastCall?.[0]).toMatchObject({ iterations: 2, tokens: 400 });
    expect(emitB.mock.lastCall?.[0]).toMatchObject({ iterations: 1, tokens: 200 });
  });

  it('marks provider-less usage and unfinished requests as estimates', () => {
    const emit = vi.fn();
    const progress = createExploreProgress(emit);
    progress.observe({ type: 'thinking', iteration: 1 });
    progress.observe({ type: 'text', delta: '12345678' });
    progress.observe({ type: 'thinking', iteration: 2 });
    progress.observe(usage(100, true));
    expect(emit.mock.lastCall?.[0]).toMatchObject({ iterations: 2, tokens: 100, tokensEstimated: true });
  });
});
