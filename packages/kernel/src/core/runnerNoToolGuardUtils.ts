import type { CompletionProfile } from '../profiles/index.js';
import { hasContinuationIntent, isIntermediateFinalizationText } from './runnerCompletionUtils.js';
import { isLeakedToolEnvelopeText } from './runnerEnvelopeUtils.js';

export type NoToolGuardReason =
  | 'none'
  | 'tool_call_text_leak'
  | 'intermediate_progress_text'
  | 'continuation_intent_detected';

export type NoToolGuardMeta = {
  reason: Exclude<NoToolGuardReason, 'none'>;
  logTag: 'ENVELOPE_LEAK' | 'INTERMEDIATE_BLOCK' | 'CONTINUATION_BLOCK';
  logMessage: string;
  promptReason: Exclude<NoToolGuardReason, 'none'>;
  incrementStreak: boolean;
  includeStreak: boolean;
  includeTotalToolCalls: boolean;
};

export function getNoToolGuardMeta(reason: NoToolGuardReason): NoToolGuardMeta | null {
  switch (reason) {
    case 'tool_call_text_leak':
      return {
        reason,
        logTag: 'ENVELOPE_LEAK',
        logMessage: 'Blocked leaked tool envelope text in final output',
        promptReason: reason,
        incrementStreak: false,
        includeStreak: false,
        includeTotalToolCalls: false,
      };
    case 'intermediate_progress_text':
      return {
        reason,
        logTag: 'INTERMEDIATE_BLOCK',
        logMessage: 'Blocked intermediate text, nudging to continue',
        promptReason: reason,
        incrementStreak: true,
        includeStreak: true,
        includeTotalToolCalls: false,
      };
    case 'continuation_intent_detected':
      return {
        reason,
        logTag: 'CONTINUATION_BLOCK',
        logMessage: 'Blocked continuation intent, nudging to continue',
        promptReason: reason,
        incrementStreak: true,
        includeStreak: true,
        includeTotalToolCalls: true,
      };
    default:
      return null;
  }
}

export function detectNoToolGuardReason(options: {
  fullContent: string;
  completionProfile: CompletionProfile;
  toolNames: string[];
  finishReason?: string;
  textOnlyStreakCount: number;
  totalToolCalls: number;
  onContinuationDetected?: (preview: string, length: number) => void;
}): NoToolGuardReason {
  const {
    fullContent,
    completionProfile,
    toolNames,
    finishReason,
    textOnlyStreakCount,
    totalToolCalls,
    onContinuationDetected,
  } = options;

  if (isLeakedToolEnvelopeText(fullContent, completionProfile, toolNames)) {
    return 'tool_call_text_leak';
  }

  if (textOnlyStreakCount >= 3 || finishReason === 'stop') {
    return 'none';
  }

  if (isIntermediateFinalizationText(fullContent, completionProfile)) {
    return 'intermediate_progress_text';
  }

  if (hasContinuationIntent(fullContent, totalToolCalls, completionProfile, onContinuationDetected)) {
    return 'continuation_intent_detected';
  }

  return 'none';
}
