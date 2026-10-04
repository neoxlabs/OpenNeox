import type { ToolOutcomeStatus } from './runnerToolOutcomeUtils.js';

export type IterationStats = {
  successCount: number;
  errorCount: number;
  alreadyDoneCount: number;
  hasVerificationSuccess: boolean;
};

export function createIterationStats(): IterationStats {
  return {
    successCount: 0,
    errorCount: 0,
    alreadyDoneCount: 0,
    hasVerificationSuccess: false,
  };
}

export function applyToolOutcomeToIterationStats(
  current: IterationStats,
  status: ToolOutcomeStatus,
  isVerification: boolean,
): IterationStats {
  if (status === 'error') {
    return {
      ...current,
      errorCount: current.errorCount + 1,
    };
  }
  if (status === 'already_done') {
    return {
      ...current,
      alreadyDoneCount: current.alreadyDoneCount + 1,
      hasVerificationSuccess: current.hasVerificationSuccess || isVerification,
    };
  }
  return {
    ...current,
    successCount: current.successCount + 1,
    hasVerificationSuccess: current.hasVerificationSuccess || isVerification,
  };
}

export function hasIterationProgress(stats: IterationStats): boolean {
  return (stats.successCount + stats.alreadyDoneCount) > 0;
}

export function isIterationLowProgress(stats: IterationStats): boolean {
  return stats.errorCount > 0 && !hasIterationProgress(stats);
}
