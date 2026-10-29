import type { ToolResult } from './parallelExecutor.js';
import type { ParsedToolArguments } from './toolArgsParser.js';
import { isVerificationTool } from './runnerTaskUtils.js';
import { detectToolOutcomeStatus, type ToolOutcomeStatus } from './runnerToolOutcomeUtils.js';
import { applyToolOutcomeToIterationStats, type IterationStats } from './runnerIterationStatsUtils.js';

type RecentToolOutcome = {
  iteration: number;
  name: string;
  status: ToolOutcomeStatus;
  executionTime: number;
};

type SystemMemory = {
  add: (message: { role: 'system'; content: string }) => void;
};

/**
 * 对 tool 执行结果做"观测/决策"性记账:
 *   - recentToolOutcomes(最近 24 次结果)
 *   - iterationStats(本轮成功/失败/验证计数)
 *   - toolUsageAdvisor(建议下次用什么工具)
 *
 * 注:loopDetector / errorPatternMemory 的 record 已经由 orchestrateToolUse 的
 * gate+postHook 阶段统一完成, 本函数**不再重复 record**, 避免双计数。
 */
export function processToolOutcomeTracking(options: {
  result: ToolResult;
  executableToolCalls: Array<{ id: string }>;
  parsedArgsByToolId: Map<string, ParsedToolArguments>;
  iteration: number;
  recentToolOutcomes: RecentToolOutcome[];
  iterationStats: IterationStats;
  memory: SystemMemory;
  toolUsageAdvisor: {
    record: (toolName: string, success: boolean, args: Record<string, any> | undefined, iteration: number) => void;
  };
}): IterationStats {
  const { result, executableToolCalls, parsedArgsByToolId, iteration, recentToolOutcomes, iterationStats } = options;

  const detectedStatus = detectToolOutcomeStatus(result.success, result.output);

  recentToolOutcomes.push({
    iteration,
    name: result.name,
    status: detectedStatus,
    executionTime: result.executionTime || 0,
  });
  if (recentToolOutcomes.length > 24) {
    recentToolOutcomes.shift();
  }

  const matchingTc = executableToolCalls.find((tc) => tc.id === result.id);
  const parsedArgs = matchingTc ? parsedArgsByToolId.get(matchingTc.id) : undefined;
  const parsedCallArgs = parsedArgs?.args;

  const nextIterationStats = applyToolOutcomeToIterationStats(
    iterationStats,
    detectedStatus,
    isVerificationTool(result.name),
  );

  options.toolUsageAdvisor.record(result.name, result.success, parsedCallArgs, iteration);
  return nextIterationStats;
}
