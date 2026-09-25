import { logger } from '../utils/logger.js';
import type { ToolResult } from './parallelExecutor.js';

export function logToolExecutionResult(result: ToolResult): void {
  logger.toolCall(result.name, {});
  if (result.success) {
    const resultLength = typeof result.output === 'string'
      ? result.output.length
      : JSON.stringify(result.output).length;
    logger.toolResult(result.name, true, resultLength, result.executionTime || 0);
    return;
  }
  logger.toolError(result.name, result.output);
}
