/** 解析子 Agent 的父会话、工作区、模型和展示名称。父信息缺失时回退到 runtime workDir。 */

/** 'sub_agent' started 事件里跟建行有关的字段 (其余字段这里不关心)。 */
export interface SubAgentStartedInfo {
  agentId?: string;
  model?: string;
  name?: string;
  description?: string;
  prompt?: string;
}

/** 父会话里这里用得上的部分 —— 查不到时传 null。 */
export interface ParentSessionRef {
  workspacePath?: string;
  modelId?: string;
}

export interface SubAgentSessionOrigin {
  sessionId: string;
  workspacePath: string;
  modelId: string;
  name: string;
  parentSessionId: string;
  initialUserMessage: string;
  /** 父没查到 → 走了 workDir 兜底。调用方据此打一条 warn, 不影响建行。 */
  usedWorkDirFallback: boolean;
}

export function resolveSubAgentSessionOrigin(args: {
  info: SubAgentStartedInfo;
  parentSessionId: string;
  parent: ParentSessionRef | null | undefined;
  workDir: string;
}): SubAgentSessionOrigin {
  const { info, parentSessionId, parent, workDir } = args;
  const agentId = info.agentId ?? '';
  /* 父有 workspace 就跟父走; 没有 (查不到 / 父自己就是空的) 退 workDir。
   * 宁可归错组也好过永远悬空在 Unlinked —— 何况 workDir 绝大多数情况下就是对的。 */
  const parentWs = parent?.workspacePath || '';
  const workspacePath = parentWs || workDir || '';
  return {
    sessionId: agentId,
    workspacePath,
    modelId: info.model || parent?.modelId || '',
    /* description 可缺失；使用空字符串确保名称构造不会抛错。 */
    name: info.name || (info.description ?? '').slice(0, 40) || `子 Agent ${agentId.slice(0, 8)}`,
    parentSessionId,
    initialUserMessage: info.prompt || info.description || '',
    usedWorkDirFallback: !parentWs,
  };
}
