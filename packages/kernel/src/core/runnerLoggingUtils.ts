import { cliLogger } from '../platform/cliLogger.js';

export function logRunEntry(task: string, images?: string[], signal?: AbortSignal): void {
  if (process.env.CLI_DEBUG !== '1') {
    return;
  }
  cliLogger.debug('MK', `  hasSignal: ${!!signal}`);
  cliLogger.debug('RUNNER', '========================================');
  cliLogger.debug('RUNNER', '=== runner.run ENTRY ===');
  cliLogger.debug('RUNNER', `  task: "${task?.substring(0, 50)}..."`);
  cliLogger.debug('RUNNER', `  hasImages: ${!!images && images.length > 0}`);
  cliLogger.debug('RUNNER', `  hasSignal: ${!!signal}`);
}

export function logNoToolLoopExit(options: {
  finishReason?: string;
  fullContent: string;
  toolCallCount: number;
  iteration: number;
  textOnlyStreakCount: number;
}): void {
  if (process.env.CLI_DEBUG !== '1') {
    return;
  }
  const { finishReason, fullContent, toolCallCount, iteration, textOnlyStreakCount } = options;
  cliLogger.info('RUNNER', '=== Loop Exit: No Tool Calls ===');
  cliLogger.info('RUNNER', `Finish Reason: ${finishReason}`);
  cliLogger.info('RUNNER', `Content Length: ${fullContent.length}`);
  cliLogger.info('RUNNER', `Content Preview: ${fullContent.slice(0, 300)}`);
  cliLogger.info('RUNNER', `Tool Calls Count: ${toolCallCount}`);
  cliLogger.info('RUNNER', `Iteration: ${iteration}`);
  cliLogger.info('RUNNER', `Text-only streak: ${textOnlyStreakCount}`);
}

export function logRunCompletion(options: {
  iteration: number;
  totalToolCalls: number;
  encounteredError: boolean;
  textOnlyStreakCount: number;
  completionEvidenceNudges: number;
  taskIntent: string;
  streamRetries: number;
  stopReason?: string | null;
}): void {
  if (process.env.CLI_DEBUG !== '1') {
    return;
  }
  const {
    iteration,
    totalToolCalls,
    encounteredError,
    textOnlyStreakCount,
    completionEvidenceNudges,
    taskIntent,
    streamRetries,
    stopReason,
  } = options;

  cliLogger.debug('RUNNER', '=== runner.run COMPLETING ===');
  cliLogger.debug('RUNNER', `  iterations: ${iteration}`);
  cliLogger.debug('RUNNER', `  toolCalls: ${totalToolCalls}`);
  cliLogger.debug('RUNNER', `  encounteredError: ${encounteredError}`);
  cliLogger.debug('RUNNER', `  textOnlyStreakCount: ${textOnlyStreakCount}`);
  cliLogger.debug('RUNNER', `  completionEvidenceNudges: ${completionEvidenceNudges}`);
  cliLogger.debug('RUNNER', `  taskIntent: ${taskIntent}`);
  cliLogger.debug('RUNNER', `  streamRetries: ${streamRetries}`);
  if (stopReason) {
    cliLogger.debug('RUNNER', `  stoppedBy: ${stopReason}`);
  }
}

export function logIterationQuality(options: {
  iteration: number;
  taskIntent: string;
  requireMutation: boolean;
  success: number;
  alreadyDone: number;
  error: number;
  lowProgressStreak: number;
  verificationSuccess: boolean;
}): void {
  if (process.env.CLI_DEBUG !== '1') {
    return;
  }
  cliLogger.debug('LOOP_GATE', 'Iteration quality', options);
}
