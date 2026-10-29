import { ipcMain } from './ipcMainBridged.js';
import type { ProjectManager } from '../context/ProjectManager.js';
import { makeBridgeResolver, makeOptionalBridgeResolver } from './scopeResolvers.js';

interface RegisterAssistantTeamIpcHandlersOptions {
  projectManager: ProjectManager;
}

/**
 * Assistant team / steward / kernel 的操作走发起窗口的 project bridge.
 * 创建/招募类操作需要 project, 没 project 就抛错.
 * 快照/诊断类读操作没 project 时返回 null.
 */
export function registerAssistantTeamIpcHandlers(options: RegisterAssistantTeamIpcHandlersOptions): void {
  const bridgeOf = makeBridgeResolver(options.projectManager);
  const bridgeOfOpt = makeOptionalBridgeResolver(options.projectManager);

  ipcMain.handle('assistant:create-team', async (event, goal: string) => {
    return bridgeOf(event).createLeaderTeam(goal);
  });

  ipcMain.handle('assistant:recruit-member', async (event, teamId: string, payload: { role: string; task: string; providerId?: string; model?: string }) => {
    return bridgeOf(event).leaderRecruitMember(teamId, payload);
  });

  ipcMain.handle('assistant:request-capability', async (event, teamId: string, capability: string, reason: string) => {
    return bridgeOf(event).leaderRequestCapability(teamId, capability, reason);
  });

  ipcMain.handle('assistant:get-steward-snapshot', async (event) => {
    return bridgeOfOpt(event)?.getStewardRuntimeSnapshot() ?? null;
  });

  ipcMain.handle('steward:cancel-commitment', async (event, commitmentId: string) => {
    return bridgeOf(event).cancelCommitment(commitmentId);
  });

  ipcMain.handle('kernel:get-diagnostics', async (event) => {
    return bridgeOfOpt(event)?.getKernelDiagnostics() ?? null;
  });
}
