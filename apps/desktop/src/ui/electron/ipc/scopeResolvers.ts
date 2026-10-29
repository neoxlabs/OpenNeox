import type { IpcMainInvokeEvent } from 'electron';
import type { ProjectManager } from '../context/ProjectManager.js';
import type { AgentBridge } from '../services/agentBridge.js';
import { AGENT_BRIDGE } from '../context/tokens.js';

export function makeBridgeResolver(projectManager: ProjectManager) {
  /* event 可能是 undefined —— 通用 IPC 桥在非 Electron 宿主下没有 sender。
   * 漏了这一条的代价: session:create 直接抛
   * "Cannot read properties of undefined (reading 'sender')", 极简版连新建对话都不行。
   * (另外两个 resolver 早就改了, 唯独这个非可选版本漏掉。) */
  return (event: IpcMainInvokeEvent | undefined): AgentBridge => {
    const scope = projectManager.getBySender(event?.sender as any);
    if (!scope) {
      throw new Error('No project scope for sender window — call workspace:set first');
    }
    const bridge = scope.tryGetService(AGENT_BRIDGE);
    if (!bridge) {
      throw new Error(`Project scope ${scope.workspacePath} has no AgentBridge registered`);
    }
    return bridge;
  };
}

/**
 * 宽松版 —— 拿不到 bridge 时返回 undefined, 让 handler 自己决定如何 degrade.
 * 适合那些 "没 project 就返回空列表" 的读操作 (server:get-status 等).
 *
 * 同样严格按 sender 查, 不再 fallback 到 focused 避免跨窗口串扰.
 */
export function makeOptionalBridgeResolver(projectManager: ProjectManager) {
  /* event 可能是 undefined —— 通用 IPC 桥在非 Electron 宿主下没有 sender 可传
   * (见 ipcBridge.ts 的 BridgeHandler 注释)。这里必须容忍, 否则整条调用直接抛
   * "Cannot read properties of undefined", 而调用方本来就准备好了拿不到 scope 的情况。 */
  return (event: IpcMainInvokeEvent | undefined): AgentBridge | undefined => {
    const scope = event?.sender ? projectManager.getBySender(event?.sender as any) : undefined;
    return scope?.tryGetService(AGENT_BRIDGE);
  };
}

/**
 * 从 IPC sender 反查 workspace path.
 * 严格按 sender 查, 没 scope → undefined.
 */
export function makeWorkspaceResolver(projectManager: ProjectManager) {
  /* 同上: 拿不到 sender 就是拿不到 scope, 返回 undefined 走调用方的兜底分支。 */
  return (event: IpcMainInvokeEvent | undefined): string | undefined => {
    const scope = event?.sender ? projectManager.getBySender(event?.sender as any) : undefined;
    return scope?.workspacePath;
  };
}
