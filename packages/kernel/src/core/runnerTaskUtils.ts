type TaskIntent = 'conversation' | 'analysis' | 'execution' | 'mutation';

export interface RunnerTaskRequirements {
  intent: TaskIntent;
  requireToolEvidence: boolean;
  requireMutation: boolean;
}

export function inferTaskRequirements(
  task: string,
  fallbackMode?: string,
): RunnerTaskRequirements {
  const normalized = (task || '').toLowerCase();
  const fallback = fallbackMode ?? 'lenient';

  const conversationResult: RunnerTaskRequirements = {
    intent: 'conversation',
    requireToolEvidence: false,
    requireMutation: false,
  };

  if (!normalized.trim()) {
    if (fallback === 'strict') {
      return { intent: 'execution', requireToolEvidence: true, requireMutation: false };
    }
    return conversationResult;
  }

  const conversationTask = /(^(hi|hello|hey|你好|嗨|哈喽)\s*[!！.。]?\s*$|^你是谁\s*[?？]?\s*$|^who are you|^what are you\b|^自我介绍|^introduce yourself|^(thanks|thank you|谢谢|感谢)\s*[!！.。]?\s*$|^(ok|好的|明白|收到)\s*$|^怎么用|^how to use|^能做什么|^what can you do|^帮助\s*$|^help\s*$)/i.test(normalized);
  if (conversationTask) {
    return conversationResult;
  }

  const mutationTask = /(修复|修改|实现|编写|重构|新增|删除|改造|修正|补丁|fix|implement|write|edit|refactor|create|delete|rename|patch|update)/i.test(normalized);
  if (mutationTask) {
    return {
      intent: 'mutation',
      requireToolEvidence: true,
      requireMutation: true,
    };
  }

  const executionTask = /(运行|测试|构建|执行|run|test|build|execute)/i.test(normalized);
  const analysisTask = /(验证|检查|排查|定位|分析|调查|复现|对比|诊断|调试|debug|validate|verify|check|analy(?:s|z)e|investigate|diagnose|locate|reproduce|trace|inspect)/i.test(normalized);
  if (executionTask || analysisTask) {
    return {
      intent: executionTask ? 'execution' : 'analysis',
      requireToolEvidence: true,
      requireMutation: false,
    };
  }

  if (fallback === 'strict') {
    return { intent: 'execution', requireToolEvidence: true, requireMutation: false };
  }
  return conversationResult;
}

export function isVerificationTool(toolName: string): boolean {
  const normalized = (toolName || '').toLowerCase();
  return (
    normalized.includes('read') ||
    normalized.includes('search') ||
    normalized.includes('grep') ||
    normalized.includes('glob') ||
    normalized.includes('tree') ||
    normalized.includes('list_directory') ||
    normalized === 'ls' ||
    normalized.includes('test') ||
    normalized.includes('lint') ||
    normalized.includes('build') ||
    normalized.includes('check') ||
    normalized.includes('execute_shell') ||
    normalized === 'bash'
  );
}

/* (已删) detectTestRunOutcome / isMutationTool —— 它们只为 VERIFY GATE
 * 收尾硬闸服务, 闸门随之删除。文件改动检测请用 reasoning/fileHotspotDetector 的
 * isMutationTool(另一实现, 仍有真实消费方)。 */
