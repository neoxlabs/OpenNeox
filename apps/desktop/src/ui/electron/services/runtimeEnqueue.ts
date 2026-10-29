import { getDatabase } from '@neoxlabs/platform/platform/database.js';
import type { ProjectManager } from '../context/ProjectManager.js';
import { AGENT_BRIDGE } from '../context/tokens.js';

let pm: ProjectManager | null = null;

export function configureRuntimeEnqueue(projectManager: ProjectManager): void {
  pm = projectManager;
}

export interface EnqueueOpts {
  kind?: string;
  command?: string;
  /** 只入队, 不代用户起一轮 —— 留给下一轮真正的用户消息带出去 */
  noAutoResume?: boolean;
}

/** 会话所在工作区的 AgentBridge; 那个工作区没开就用当前聚焦的窗口 (Pilot 会话不挑目录) */
export function agentBridgeForSession(sessionId: string) {
  if (!pm) return null;
  let workspacePath = '';
  try {
    workspacePath = String(getDatabase().getSession(sessionId)?.workspacePath ?? getDatabase().getSession(sessionId)?.workspace_path ?? '');
  } catch { /* 库读不到就按当前聚焦的窗口走 */ }
  const scope = (workspacePath && pm.getByPath(workspacePath)) || pm.getFocused() || pm.listScopes()[0];
  return scope?.tryGetService(AGENT_BRIDGE) ?? null;
}

/** 从现在起等这个会话下一轮说完的话 (超时 / 没有 runtime → 空串)。要在起那一轮之前调。 */
export function awaitSessionReply(sessionId: string, timeoutMs: number): Promise<string> {
  const agentBridge = agentBridgeForSession(sessionId);
  return agentBridge ? agentBridge.awaitNextRunResult(sessionId, timeoutMs) : Promise.resolve('');
}

/** 投成功返回 true; 找不到活着的 runtime 返回 false (调用方自己决定兜底)。 */
export async function enqueueToSessionRuntime(sessionId: string, xml: string, opts: EnqueueOpts = {}): Promise<boolean> {
  const agentBridge = agentBridgeForSession(sessionId);
  if (!agentBridge) return false;
  try {
    await agentBridge.getClientAsync();
    const rb = agentBridge.getRuntimeBridge();
    if (typeof rb?.enqueueSessionMessage !== 'function') return false;
    return (await rb.enqueueSessionMessage(sessionId, xml, { pid: 0, status: 'completed', ...opts })) === true;
  } catch (err) {
    console.warn('[runtimeEnqueue] enqueue failed:', sessionId, (err as Error)?.message);
    return false;
  }
}
