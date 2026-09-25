/** Resolve a task-agent route from the current model override, then the global fallback. */

export interface TaskAgentRoute {
  providerId: string;
  modelName: string;
}

export interface TaskAgentPair {
  providerId?: string;
  model?: string;
}

export function resolveTaskAgentRoute(
  mainModel: string | undefined,
  perModelMap: Record<string, TaskAgentPair> | undefined,
  globalTaskAgent: TaskAgentPair | undefined,
): TaskAgentRoute | null {
  const key = (mainModel || '').trim().toLowerCase();
  if (key && perModelMap) {
    const pair = perModelMap[key];
    if (pair?.providerId && pair?.model) {
      return { providerId: pair.providerId, modelName: pair.model };
    }
  }
  if (globalTaskAgent?.providerId && globalTaskAgent?.model) {
    return { providerId: globalTaskAgent.providerId, modelName: globalTaskAgent.model };
  }
  return null;
}
