import { handleWorkspaceCommandForCliFlow } from './workspaceCommandFlow.js';

export async function handleWorkspaceCommandFromMain(params: {
  args: string[];
  workDir: string;
  recentWorkspaces: string[] | undefined;
  homeDir: string;
  isTaskRunning: boolean;
  promptSelect: (question: string, choices: any[], defaultValue?: string) => Promise<string>;
  promptText: (question: string, options?: any) => Promise<string>;
  logInfo: (message: string, details?: string) => void;
  saveWorkspaceHistory: (workspaces: string[]) => void;
  applyResolvedWorkspace: (resolvedPath: string) => Promise<void>;
  setCommandOutputLines?: (lines: string[]) => void;
}): Promise<void> {
  await handleWorkspaceCommandForCliFlow({
    args: params.args,
    workDir: params.workDir,
    recentWorkspaces: params.recentWorkspaces,
    homeDir: params.homeDir,
    isTaskRunning: params.isTaskRunning,
    promptSelect: params.promptSelect,
    promptText: params.promptText,
    logInfo: params.logInfo,
    saveWorkspaceHistory: params.saveWorkspaceHistory,
    applyResolvedWorkspace: params.applyResolvedWorkspace,
    setCommandOutputLines: params.setCommandOutputLines,
  });
}
