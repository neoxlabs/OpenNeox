import type { ToolResult } from './parallelExecutor.js';

export function recordToolMetric(
  toolMetricsHistory: Array<{ name: string; duration: number; success: boolean }>,
  result: ToolResult,
): void {
  toolMetricsHistory.push({
    name: result.name,
    duration: result.executionTime || 0,
    success: result.success,
  });

  if (toolMetricsHistory.length > 50) {
    toolMetricsHistory.shift();
  }
}
