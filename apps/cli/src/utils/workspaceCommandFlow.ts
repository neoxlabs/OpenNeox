import type { SelectionChoice } from '../cliTypes.js';
import {
  handleWorkspaceCommandFlow,
  promptWorkspaceSelectionFlow,
  showWorkspaceListFlow,
  switchWorkspaceFlow,
} from '../ui/workspaceMenus.js';
import {
  formatWorkspaceLabel,
  getWorkspaceHistory,
  normalizeWorkspacePath,
} from './workspaceHistory.js';

type PromptSelect = (
  question: string,
  choices: SelectionChoice[],
  defaultValue?: string
) => Promise<string>;

type PromptText = (
  question: string,
  options?: { allowEmpty?: boolean }
) => Promise<string>;

export async function handleWorkspaceCommandForCliFlow(params: {
  args: string[];
  workDir: string;
  recentWorkspaces: unknown;
  homeDir: string;
  isTaskRunning: boolean;
  promptSelect: PromptSelect;
  promptText: PromptText;
  logInfo: (message: string, details?: string) => void;
  saveWorkspaceHistory: (workspaces: string[]) => void;
  applyResolvedWorkspace: (resolvedPath: string) => Promise<void>;
  setCommandOutputLines?: (lines: string[]) => void;
}): Promise<void> {
  const {
    args,
    workDir,
    recentWorkspaces,
    homeDir,
    isTaskRunning,
    promptSelect,
    promptText,
    logInfo,
    saveWorkspaceHistory,
    applyResolvedWorkspace,
    setCommandOutputLines,
  } = params;

  const formatLabel = (workspacePath: string) =>
    formatWorkspaceLabel(workspacePath, homeDir);
  const getHistory = () => getWorkspaceHistory(workDir, recentWorkspaces, homeDir);
  const showWorkspaceList = (workspaces: string[]) =>
    showWorkspaceListFlow(workspaces, workDir, formatLabel, setCommandOutputLines);

  const switchWorkspace = async (targetPath: string): Promise<void> => {
    await switchWorkspaceFlow({
      targetPath,
      isTaskRunning,
      currentWorkDir: workDir,
      normalizeWorkspacePath: (input) => normalizeWorkspacePath(input, homeDir),
      formatWorkspaceLabel: formatLabel,
      logInfo,
      getWorkspaceHistory: getHistory,
      saveWorkspaceHistory,
      applyResolvedWorkspace,
    });
  };

  const promptWorkspaceSelection = async (): Promise<void> => {
    const workspaces = getHistory();
    await promptWorkspaceSelectionFlow({
      workspaces,
      currentWorkDir: workDir,
      formatWorkspaceLabel: formatLabel,
      promptSelect,
      promptText,
      showWorkspaceList: () => showWorkspaceList(workspaces),
      switchWorkspace,
    });
  };

  await handleWorkspaceCommandFlow({
    args,
    promptWorkspaceSelection,
    showWorkspaceList,
    getWorkspaceHistory: getHistory,
    currentWorkDir: workDir,
    formatWorkspaceLabel: formatLabel,
    logInfo,
    promptText,
    normalizeWorkspacePath: (input) => normalizeWorkspacePath(input, homeDir),
    saveWorkspaceHistory,
    switchWorkspace,
  });
}
