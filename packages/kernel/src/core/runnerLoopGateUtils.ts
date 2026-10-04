import type { RawResponseStreamEvent } from '../types/index.js';

export function shouldTriggerLowProgressGate(
  requireToolEvidence: boolean,
  lowProgressStreak: number,
): boolean {
  return requireToolEvidence && lowProgressStreak >= 2;
}

export function buildLowProgressGateEvent(
  iteration: number,
  nudgeCount: number,
): RawResponseStreamEvent {
  return {
    type: 'raw_response_event',
    data: {
      type: 'loop.progress_gate',
      iteration,
      reason: 'low_progress',
      nudgeCount,
    },
    event_type: 'loop.progress_gate',
  } as RawResponseStreamEvent;
}
