import { cliLogger } from '../platform/cliLogger.js';
import type { RunContext } from '../types/index.js';
import { recordToolCall } from './sessionState.js';
import type { ToolResult } from './parallelExecutor.js';
import type { IterationStats } from './runnerIterationStatsUtils.js';
import { processToolOutcomeTracking } from './runnerToolTrackingUtils.js';
import type { ParsedToolArguments } from './toolArgsParser.js';

type SystemMemory = {
  addToolResult: (id: string, name: string, output: string) => void;
  add: (message: { role: 'system'; content: string }) => void;
};

/**
 * tool 结果的 memory/tracking 收尾:
 *   - recordToolCall 记到 runContext
 *   - memory.addToolResult 把截断后的输出加进对话
 *   - processToolOutcomeTracking 更新 advisor/tracker/stats
 *
 * 注:loopDetector / errorPatternMemory 已在 orchestrateToolUse 里统一记录,
 * 本函数不再重复调用, 避免双计数(参见 processToolOutcomeTracking 注释)。
 */
export function finalizeToolResultAndTracking(options: {
  result: ToolResult;
  outputPolicy: {
    truncatedResult: string;
    toolInput: Record<string, any>;
  };
  runContext: RunContext;
  memory: SystemMemory;
  iteration: number;
  recentToolOutcomes: Array<{
    iteration: number;
    name: string;
    status: 'success' | 'error' | 'already_done';
    executionTime: number;
  }>;
  iterationStats: IterationStats;
  executableToolCalls: Array<{ id: string }>;
  parsedArgsByToolId: Map<string, ParsedToolArguments>;
  toolUsageAdvisor: {
    record: (toolName: string, success: boolean, args: Record<string, any> | undefined, iteration: number) => void;
  };
}): IterationStats {
  const { result, outputPolicy } = options;

  recordToolCall(options.runContext, result.name, outputPolicy.toolInput, result.success);

  cliLogger.info('TOOL_RESULT', `📦 Tool raw output: ${result.name}`, {
    toolName: result.name,
    success: result.success,
    rawLength: typeof result.output === 'string' ? result.output.length : JSON.stringify(result.output).length,
    truncatedLength: outputPolicy.truncatedResult.length,
    outputPreview: outputPolicy.truncatedResult.substring(0, 500),
  });

  options.memory.addToolResult(result.id, result.name, outputPolicy.truncatedResult);

  return processToolOutcomeTracking({
    result,
    executableToolCalls: options.executableToolCalls,
    parsedArgsByToolId: options.parsedArgsByToolId,
    iteration: options.iteration,
    recentToolOutcomes: options.recentToolOutcomes,
    iterationStats: options.iterationStats,
    memory: options.memory,
    toolUsageAdvisor: options.toolUsageAdvisor,
  });
}
