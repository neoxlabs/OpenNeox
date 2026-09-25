import { cliLogger } from '../platform/cliLogger.js';
import { buildPerformanceHint } from './runnerHintUtils.js';

type SystemMemory = {
  appendReminder: (text: string) => void;
};

type ToolUsageAdvisorLike = {
  analyze: (iteration: number) => string | null | undefined;
};

type ToolMetric = {
  name: string;
  duration: number;
  success: boolean;
};

export function injectIterationAdvisories(options: {
  iteration: number;
  toolMetricsHistory: ToolMetric[];
  memory: SystemMemory;
  toolUsageAdvisor: ToolUsageAdvisorLike;
}): void {
  const { iteration, toolMetricsHistory, memory, toolUsageAdvisor } = options;

  if (iteration > 0 && iteration % 5 === 0) {
    const perfHint = buildPerformanceHint(toolMetricsHistory);
    if (perfHint) {
      // 顺序追加到对话尾部 → 不进顶层 system 块, 保住前缀缓存 (见文件顶部说明)
      memory.appendReminder(perfHint);
      if (process.env.CLI_DEBUG_CONSOLE === '1') {
        console.log('[Runner] Performance hint injected:', perfHint);
      }
    }
  }

  const toolAdvice = toolUsageAdvisor.analyze(iteration);
  if (toolAdvice) {
    memory.appendReminder(toolAdvice);
    if (process.env.CLI_DEBUG === '1') {
      cliLogger.debug('TOOL_ADVISOR', 'Usage advice injected', {
        advice: toolAdvice.slice(0, 100),
      });
    }
  }
}
