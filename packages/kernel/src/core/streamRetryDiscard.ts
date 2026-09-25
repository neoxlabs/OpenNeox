
import type { RawResponseStreamEvent } from '../types/index.js';

export function withRetryDiscard(
  event: RawResponseStreamEvent,
  partialBeforeRetry: string,
  continuedByPrefill: boolean,
): RawResponseStreamEvent {
  return {
    ...event,
    data: {
      ...(event.data as Record<string, unknown>),
      discardedText: continuedByPrefill ? '' : partialBeforeRetry,
      discardPartialToolCalls: true,
    },
  } as RawResponseStreamEvent;
}
