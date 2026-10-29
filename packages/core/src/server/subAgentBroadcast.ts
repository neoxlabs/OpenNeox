/** 子 agent 生命周期 (started / updated / done / aborted) 广播到父会话 —— 侧栏 / 运行条靠它 */
export function publishSubAgentLifecycle(
  bus: { publish: (e: any) => void },
  parentSessionId: string,
  kind: string,
  info: {
    agentId: string; name?: string; description: string; status: string; elapsed: number;
    toolUseCount: number; outputTokens?: number; model?: string; providerId?: string; modelInherited?: boolean;
  },
): void {
  bus.publish({
    sessionId: parentSessionId,
    type: 'sub_agent',
    data: {
      type: 'sub_agent',
      action: kind,
      agentId: info.agentId,
      name: info.name,
      description: info.description,
      status: info.status,
      elapsed: info.elapsed,
      toolUseCount: info.toolUseCount,
      outputTokens: info.outputTokens,
      model: info.model,
      providerId: info.providerId,
      modelInherited: info.modelInherited,
      timestamp: Date.now(),
    },
    timestamp: Date.now(),
  });
}

export function publishSubAgentPromptBubble(
  bus: { publish: (e: any) => void },
  info: { agentId?: string; prompt?: string; description?: string },
): void {
  const text = info.prompt || info.description || '';
  if (!text || !info.agentId) return;
  bus.publish({
    sessionId: info.agentId,
    type: 'user_message_injected',
    data: { type: 'user_message_injected', text, sessionId: info.agentId, __subAgentMirror: true },
    timestamp: Date.now(),
  });
}
