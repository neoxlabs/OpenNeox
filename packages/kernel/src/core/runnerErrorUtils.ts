import { classifyError, NeoxError, ErrorCategory, getErrorRecoverySuggestion } from '../types/errors.js';
import { formatLLMErrorMessage } from '../utils/errorMessages.js';

export type StreamErrorDiagnostic = {
  category: string;
  code: string | undefined;
  retryable: boolean;
  retryAfter: number | undefined;
  streamRetries: number;
  maxStreamRetries: number;
  providerManagedRetryObserved: boolean;
  iteration: number;
};

export function classifyRunnerError(error: any): NeoxError {
  return error instanceof NeoxError ? error : classifyError(error);
}

export function reclassifyFalseCancel(
  classifiedError: NeoxError,
  evidence: { aborted: boolean; steering: boolean },
): NeoxError {
  if (classifiedError.category !== ErrorCategory.CANCELED) return classifiedError;
  if (evidence.aborted || evidence.steering) return classifiedError;
  return new NeoxError({
    category: ErrorCategory.RETRYABLE_STREAM,
    code: 'STREAM_INTERRUPTED',
    message: `Stream interrupted by upstream (${classifiedError.message})`,
    retryable: true,
    context: classifiedError.context,
    originalError: classifiedError.originalError ?? classifiedError,
  });
}

export function logClassifiedErrorToConsole(classifiedError: NeoxError): void {
  if (process.env.CLI_DEBUG_CONSOLE === '1') {
    console.log('[Runner] Error classified:', {
      category: classifiedError.category,
      code: classifiedError.code,
      retryable: classifiedError.retryable,
      message: classifiedError.message,
    });
  }
}

export function buildStreamErrorDiagnostic(
  classifiedError: NeoxError,
  streamRetries: number,
  maxStreamRetries: number,
  providerManagedRetryObserved: boolean,
  iteration: number,
): StreamErrorDiagnostic {
  return {
    category: classifiedError.category,
    code: classifiedError.code,
    retryable: classifiedError.retryable,
    retryAfter: classifiedError.retryAfter,
    streamRetries,
    maxStreamRetries,
    providerManagedRetryObserved,
    iteration,
  };
}

export function buildFriendlyRunnerError(
  classifiedError: NeoxError,
  providerName?: string,
): { suggestion?: string; friendlyMessage: string } {
  /* 走到这里 = runner 已经把重试跑完了, 这条是终态。不加 exhausted 的话提示会说
   * "正在自动重试...", 而实际上下一步就是把错误抛给用户。 */
  const suggestion = getErrorRecoverySuggestion(classifiedError, { exhausted: true });
  return {
    suggestion,
    friendlyMessage: formatLLMErrorMessage(classifiedError.message, { providerName }),
  };
}

export function handleInterruptedPartialContent(options: {
  lastPartialContent: string;
  persistAssistantContent: (content: string) => void;
  logInfo: (message: string) => void;
}): string {
  const { lastPartialContent, persistAssistantContent, logInfo } = options;
  if (lastPartialContent.length === 0) {
    return lastPartialContent;
  }

  persistAssistantContent(lastPartialContent + '\n\n[task interrupted by user]');
  logInfo(`Saved partial assistant content on interrupt: ${lastPartialContent.length} chars`);
  return '';
}
