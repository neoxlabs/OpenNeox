import type { RawResponseStreamEvent } from '../types/index.js';
import { buildLowProgressReplanPrompt } from './runnerHintUtils.js';
import type { IterationStats } from './runnerIterationStatsUtils.js';
import { isIterationLowProgress } from './runnerIterationStatsUtils.js';
import { buildLowProgressGateEvent, shouldTriggerLowProgressGate } from './runnerLoopGateUtils.js';
import { logIterationQuality } from './runnerLoggingUtils.js';

type SystemMemory = {
  /* Append progress reminders at the end of the memory stream so the system
   * prompt and its cache boundary remain stable. */
  appendReminder: (text: string) => void;
};

type ToolOutcomeSnapshotLike = {
  name: string;
  status: 'success' | 'error' | 'already_done';
};

export function applyIterationProgressGate(options: {
  iteration: number;
  taskIntent: string;
  requireMutation: boolean;
  requireToolEvidence: boolean;
  iterationStats: IterationStats;
  lowProgressStreak: number;
  completionEvidenceNudges: number;
  recentToolOutcomes: ToolOutcomeSnapshotLike[];
  memory: SystemMemory;
}): {
  lowProgressStreak: number;
  completionEvidenceNudges: number;
  event?: RawResponseStreamEvent;
} {
  let nextLowProgressStreak = isIterationLowProgress(options.iterationStats)
    ? options.lowProgressStreak + 1
    : 0;

  logIterationQuality({
    iteration: options.iteration,
    taskIntent: options.taskIntent,
    requireMutation: options.requireMutation,
    success: options.iterationStats.successCount,
    alreadyDone: options.iterationStats.alreadyDoneCount,
    error: options.iterationStats.errorCount,
    lowProgressStreak: nextLowProgressStreak,
    verificationSuccess: options.iterationStats.hasVerificationSuccess,
  });

  if (!shouldTriggerLowProgressGate(options.requireToolEvidence, nextLowProgressStreak)) {
    return {
      lowProgressStreak: nextLowProgressStreak,
      completionEvidenceNudges: options.completionEvidenceNudges,
    };
  }

  options.memory.appendReminder(
    buildLowProgressReplanPrompt(nextLowProgressStreak, options.recentToolOutcomes),
  );

  const nextCompletionEvidenceNudges = options.completionEvidenceNudges + 1;
  nextLowProgressStreak = 0;

  return {
    lowProgressStreak: nextLowProgressStreak,
    completionEvidenceNudges: nextCompletionEvidenceNudges,
    event: buildLowProgressGateEvent(options.iteration, nextCompletionEvidenceNudges),
  };
}
