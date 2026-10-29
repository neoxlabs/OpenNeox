import type { Instructions, RunContext } from '../types/index.js';

type AgentInfo = {
  name: string;
  description: string;
};

export async function resolveInstructions(
  instructions: Instructions,
  context: RunContext,
  agentInfo: AgentInfo,
): Promise<string> {
  if (typeof instructions === 'string') {
    return instructions;
  }
  return await instructions(context, agentInfo);
}

export async function resolveContextInjection(
  contextInjection: Instructions | undefined,
  context: RunContext,
  agentInfo: AgentInfo,
): Promise<string | null> {
  if (!contextInjection) {
    return null;
  }
  const injection = typeof contextInjection === 'string'
    ? contextInjection
    : await contextInjection(context, agentInfo);
  const trimmed = injection?.trim();
  return trimmed ? trimmed : null;
}

export function shouldIncludeLastRun(task: string): boolean {
  const normalized = task.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  // Recognize common continuation phrases in both Chinese and English.
  return /上次|之前|前面|上一步|上轮|继续|接着|接下来|还没|没做完|回顾|resume|continue|previous|last time|keep going|go on|carry on/.test(normalized);
}

export function createRunContext(
  task: string,
  userData?: Record<string, any>,
  iteration: number = 0,
  sessionId?: string,
): RunContext {
  return {
    task,
    timestamp: Date.now(),
    currentTime: new Date(),
    iteration,
    userData,
    systemStatus: undefined,
    sessionId,
  };
}
