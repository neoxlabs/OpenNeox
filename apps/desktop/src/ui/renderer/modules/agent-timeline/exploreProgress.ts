import type { TimelineEntry } from '../../utils/workspaceUtils';

type Member = NonNullable<TimelineEntry['exploreGroupMembers']>[number];
type Progress = Pick<Member, 'iterations' | 'tokens' | 'tokensEstimated' | 'startedAt' | 'elapsed'>;

export function applyExploreProgress(
  entry: Pick<TimelineEntry, 'exploreGroupMembers'>,
  agentId: string,
  progress: Progress,
): Partial<TimelineEntry> {
  const members = entry.exploreGroupMembers;
  if (!members?.some(m => m.agentId === agentId)) return {};
  const next = members.map(m => m.agentId === agentId ? { ...m, ...progress } : m);
  return {
    exploreGroupMembers: next,
    exploreTokens: next.reduce((sum, m) => sum + m.tokens, 0),
  };
}
