import type { AgentRuntimeEvent } from '../runtimeTypes.js';

export interface ExploreProgress {
  iterations: number;
  tokens: number;
  tokensEstimated: boolean;
  startedAt: number;
  elapsed: number;
}

/** Runtime usage is settled once per request; streamed text is only a temporary estimate. */
export function createExploreProgress(
  emit: (progress: ExploreProgress) => void,
  now: () => number = Date.now,
) {
  const startedAt = now();
  let iterations = 0;
  let settledTokens = 0;
  let unreportedTokens = 0;
  let pendingChars = 0;
  let estimatedUsage = false;
  let lastEmit = -Infinity;

  const flush = () => {
    lastEmit = now();
    emit({
      iterations,
      tokens: settledTokens + unreportedTokens + Math.ceil(pendingChars / 4),
      tokensEstimated: estimatedUsage || unreportedTokens > 0 || pendingChars > 0,
      startedAt,
      elapsed: Math.max(0, lastEmit - startedAt),
    });
  };

  return {
    flush,
    observe(event: AgentRuntimeEvent) {
      if (event.type === 'thinking') {
        iterations++;
        // A request without usage must not lose its estimate at the next boundary.
        if (pendingChars > 0) {
          unreportedTokens += Math.ceil(pendingChars / 4);
          pendingChars = 0;
        }
        flush();
      } else if (event.type === 'token_usage') {
        settledTokens += Math.max(0, event.totalTokens);
        // The runtime fallback estimates the whole run when no request returned usage.
        if (event.usageEstimated) unreportedTokens = 0;
        pendingChars = 0;
        estimatedUsage ||= event.usageEstimated === true;
        flush();
      } else if (event.type === 'text' || event.type === 'reasoning') {
        pendingChars += event.delta?.length || 0;
        if (now() - lastEmit >= 200) flush();
      }
    },
  };
}
