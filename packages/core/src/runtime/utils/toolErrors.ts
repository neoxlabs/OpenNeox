/**
 * Tool Error Utilities
 * Functions for handling and classifying tool errors
 */

import {
  classifyToolError,
  ErrorCategory,
  getErrorRecoverySuggestion,
} from '@neoxlabs/kernel/types/errors.js';

/**
 * Tool error result with recovery information
 */
export interface ToolErrorResult {
  success: false;
  error: string;
  code: string;
  category: ErrorCategory;
  message: string;
  suggestion?: string;
  retryable: boolean;
  receivedArgs?: string;
}

/**
 * Create structured error result for tool failures
 */
export function createToolErrorResult(
  toolName: string,
  args: string,
  error: Error
): ToolErrorResult {
  const classifiedError = classifyToolError(toolName, args, error);
  const suggestion = getErrorRecoverySuggestion(classifiedError);

  return {
    success: false,
    error: classifiedError.code,
    code: classifiedError.code,
    category: classifiedError.category,
    message: classifiedError.message,
    suggestion,
    retryable: classifiedError.retryable,
    receivedArgs: args?.substring(0, 500),
  };
}
