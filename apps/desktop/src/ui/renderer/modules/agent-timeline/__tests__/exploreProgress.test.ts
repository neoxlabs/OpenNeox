import { describe, expect, it } from 'vitest';
import { applyExploreProgress } from '../exploreProgress';

describe('explore member progress', () => {
  it('updates only its member and derives the batch total without adding snapshots twice', () => {
    const entry = { exploreGroupMembers: ['a', 'b'].map(agentId => ({
      agentId, task: 'inspect', status: 'running' as const, toolCount: 1, tokens: 10, elapsed: 0,
    })) };
    const progress = { iterations: 2, tokens: 150, tokensEstimated: false, startedAt: 1000, elapsed: 2000 };
    const next = applyExploreProgress(entry, 'b', progress);
    expect(next.exploreTokens).toBe(160);
    expect(next.exploreGroupMembers?.[0]).toBe(entry.exploreGroupMembers[0]);
    expect(next.exploreGroupMembers?.[1]).toMatchObject({ ...progress, agentId: 'b', toolCount: 1 });
    expect(applyExploreProgress(next, 'b', progress).exploreTokens).toBe(160);
    expect(entry.exploreGroupMembers[1].tokens).toBe(10);
  });

  it('does not attribute an unknown worker to another member', () => {
    expect(applyExploreProgress({}, 'unknown', { tokens: 500, elapsed: 100 })).toEqual({});
  });
});
