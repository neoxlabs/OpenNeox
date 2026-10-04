import { cliLogger } from '../platform/cliLogger.js';
import type { RunContext, Tool } from '../types/index.js';
import { recordToolCall } from './sessionState.js';
import type { ToolResult } from './parallelExecutor.js';
import type { IterationStats } from './runnerIterationStatsUtils.js';
import { processToolOutcomeTracking } from './runnerToolTrackingUtils.js';
import type { ParsedToolArguments } from './toolArgsParser.js';

import type { ToolResultProvenance } from '../memory/shortterm.js';
import { resolveToolResultProvenance, type ExternalContentClassifier } from './trust/toolResultProvenance.js';

type SystemMemory = {
  addToolResult: (id: string, name: string, output: string, provenance?: ToolResultProvenance) => void;
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
export async function finalizeToolResultAndTracking(options: {
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
  /** 来源分级 (core/trust): 按工具声明判这条结果是不是外部内容; 是就包标签 + 给会话染色 */
  trust?: {
    tools: Tool[];
    workspacePath?: string;
    classify?: ExternalContentClassifier;
  };
}): Promise<IterationStats> {
  const { result, outputPolicy } = options;

  let provenance: ToolResultProvenance | undefined;
  if (options.trust) {
    provenance = await resolveToolResultProvenance({
      tool: options.trust.tools.find((t) => t.name === result.name),
      toolName: result.name,
      args: (options.parsedArgsByToolId.get(result.id)?.args ?? {}) as Record<string, any>,
      success: result.success,
      text: outputPolicy.truncatedResult,
      workspacePath: options.trust.workspacePath,
      classify: options.trust.classify,
    });
  }

  recordToolCall(options.runContext, result.name, outputPolicy.toolInput, result.success);

  cliLogger.info('TOOL_RESULT', `📦 Tool raw output: ${result.name}`, {
    toolName: result.name,
    success: result.success,
    rawLength: typeof result.output === 'string' ? result.output.length : JSON.stringify(result.output).length,
    truncatedLength: outputPolicy.truncatedResult.length,
    outputPreview: outputPolicy.truncatedResult.substring(0, 500),
  });

  options.memory.addToolResult(result.id, result.name, outputPolicy.truncatedResult, provenance);

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
