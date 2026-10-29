import { applyWorkspaceSwitchRuntimeFlow } from '../ui/workspaceMenus.js';
import { formatWorkspaceLabel as formatWorkspaceLabelUtil } from './workspaceHistory.js';

export async function applyResolvedWorkspaceSwitchFromMain(params: {
  resolvedPath: string;
  getWorkDir: () => string;
  homeDir: string;
  uiController: any;
  sessionEnabled: boolean;
  setWorkDir: (workDir: string) => void;
  applyProcessWorkDir: (workDir: string) => void;
  setActionLogWorkspace: (workDir: string) => Promise<void>;
  setSdkWorkspace: (workDir: string) => void;
  reloadBaseTools: () => Promise<void>;
  ensureMcpTools: () => Promise<void>;
  clearSdkMemory: () => void;
  resetSessionForWorkspace: () => Promise<void>;
}): Promise<void> {
  await applyWorkspaceSwitchRuntimeFlow({
    resolvedPath: params.resolvedPath,
    setWorkDir: params.setWorkDir,
    applyProcessWorkDir: params.applyProcessWorkDir,
    setActionLogWorkspace: params.setActionLogWorkspace,
    setSdkWorkspace: params.setSdkWorkspace,
    reloadBaseTools: params.reloadBaseTools,
    ensureMcpTools: params.ensureMcpTools,
    clearSdkMemory: params.clearSdkMemory,
    resetSessionForWorkspace: async () => {
      if (!params.sessionEnabled) {
        return;
      }
      await params.resetSessionForWorkspace();
    },
    updateUiAfterWorkspaceSwitch: () => {
      if (params.uiController) {
        const workDir = params.getWorkDir();
        params.uiController.updateWorkDir(
          formatWorkspaceLabelUtil(workDir, params.homeDir),
        );
        params.uiController.updateStatus('Workspace switched', 'complete');
      }
    },
  });
}
