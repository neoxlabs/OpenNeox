import * as path from 'path';
import type { SelectionChoice } from '../cliTypes.js';
import { colors } from '../constants.js';
import { cliPrintln } from '../utils/output.js';
import { validateWorkspaceSwitchTarget } from '../utils/workspaceSwitchValidation.js';

export function showWorkspaceListFlow(
  workspaces: string[],
  currentWorkDir: string,
  formatWorkspaceLabel: (workspacePath: string) => string,
  outputLines?: (lines: string[]) => void,
): void {
  const lines: string[] = [];
  lines.push('');
  lines.push(colors.highlight('  Workspaces'));
  lines.push('');
  if (workspaces.length === 0) {
    lines.push(colors.dim('  (none)'));
  } else {
    workspaces.forEach((workspace, index) => {
      const isCurrent = path.resolve(workspace) === currentWorkDir;
      const label = formatWorkspaceLabel(workspace);
      const prefix = isCurrent ? colors.success('*') : colors.dim(' ');
      lines.push(`${colors.dim(`  ${index + 1}.`)} ${prefix} ${colors.info(label)}`);
    });
  }
  lines.push('');

  if (outputLines) {
    outputLines(lines);
    return;
  }

  for (const line of lines) {
    cliPrintln(line);
  }
}

interface PromptWorkspaceSelectionDeps {
  workspaces: string[];
  currentWorkDir: string;
  formatWorkspaceLabel: (workspacePath: string) => string;
  promptSelect: (question: string, choices: SelectionChoice[], defaultValue?: string) => Promise<string>;
  promptText: (question: string, options?: { allowEmpty?: boolean }) => Promise<string>;
  showWorkspaceList: () => void;
  switchWorkspace: (targetPath: string) => Promise<void>;
}

export async function promptWorkspaceSelectionFlow(
  deps: PromptWorkspaceSelectionDeps,
): Promise<void> {
  const choices: SelectionChoice[] = deps.workspaces.map((workspace) => ({
    label: deps.formatWorkspaceLabel(workspace),
    value: workspace,
    description: workspace === deps.currentWorkDir ? '当前' : undefined,
  }));
  /* `__add__` 是**钉住项** (SelectMenu 不给它编号), 原来插在工作区列表和
   * "Show list" 中间 —— 视觉上变成 "1. 2. / + Add workspace / 3. Show list",
   * 编号被它劈开。钉住项放末尾, 有编号的连成一段。 */
  choices.push({ label: '查看完整列表', value: '__list__' });
  choices.push({ label: '+ 添加工作区', value: '__add__' });

  const selected = await deps.promptSelect('工作区', choices, deps.currentWorkDir);
  if (selected === '__list__') {
    deps.showWorkspaceList();
    return;
  }
  if (selected === '__add__') {
    const input = await deps.promptText('Workspace path', { allowEmpty: false });
    await deps.switchWorkspace(input);
    return;
  }
  await deps.switchWorkspace(selected);
}

interface HandleWorkspaceCommandDeps {
  args: string[];
  promptWorkspaceSelection: () => Promise<void>;
  showWorkspaceList: (workspaces: string[]) => void;
  getWorkspaceHistory: () => string[];
  currentWorkDir: string;
  formatWorkspaceLabel: (workspacePath: string) => string;
  logInfo: (message: string, details?: string) => void;
  promptText: (question: string, options?: { allowEmpty?: boolean }) => Promise<string>;
  normalizeWorkspacePath: (input: string) => string;
  saveWorkspaceHistory: (workspaces: string[]) => void;
  switchWorkspace: (targetPath: string) => Promise<void>;
}

export async function handleWorkspaceCommandFlow(
  deps: HandleWorkspaceCommandDeps,
): Promise<void> {
  const action = deps.args[0]?.toLowerCase();

  if (!action) {
    await deps.promptWorkspaceSelection();
    return;
  }
  if (action === 'list') {
    deps.showWorkspaceList(deps.getWorkspaceHistory());
    return;
  }
  if (action === 'current') {
    deps.logInfo('当前工作区', deps.formatWorkspaceLabel(deps.currentWorkDir));
    return;
  }
  if (action === 'add') {
    const input = deps.args.slice(1).join(' ') || await deps.promptText('Workspace path', { allowEmpty: false });
    try {
      const resolved = deps.normalizeWorkspacePath(input);
      const updatedHistory = [resolved, ...deps.getWorkspaceHistory()];
      deps.saveWorkspaceHistory(updatedHistory);
      deps.logInfo('已添加工作区', deps.formatWorkspaceLabel(resolved));
    } catch (error: any) {
      deps.logInfo('工作区路径无效', error?.message || String(error));
    }
    return;
  }
  if (action === 'switch') {
    const target = deps.args.slice(1).join(' ');
    if (!target) {
      await deps.promptWorkspaceSelection();
      return;
    }
    await deps.switchWorkspace(target);
    return;
  }
  await deps.switchWorkspace(deps.args.join(' '));
}

interface SwitchWorkspaceFlowDeps {
  targetPath: string;
  isTaskRunning: boolean;
  currentWorkDir: string;
  normalizeWorkspacePath: (input: string) => string;
  formatWorkspaceLabel: (workspacePath: string) => string;
  logInfo: (message: string, details?: string) => void;
  getWorkspaceHistory: () => string[];
  saveWorkspaceHistory: (workspaces: string[]) => void;
  applyResolvedWorkspace: (resolvedPath: string) => Promise<void>;
}

export async function switchWorkspaceFlow(deps: SwitchWorkspaceFlowDeps): Promise<void> {
  if (deps.isTaskRunning) {
    deps.logInfo('当前任务运行中，无法切换工作区');
    return;
  }

  const validation = validateWorkspaceSwitchTarget({
    targetPath: deps.targetPath,
    currentWorkDir: deps.currentWorkDir,
    normalizeWorkspacePath: deps.normalizeWorkspacePath,
    formatWorkspaceLabel: deps.formatWorkspaceLabel,
  });
  if (!validation.ok) {
    deps.logInfo(validation.message, validation.details);
    return;
  }

  const resolvedPath = validation.resolvedPath;
  const updatedHistory = [resolvedPath, ...deps.getWorkspaceHistory()];
  deps.saveWorkspaceHistory(updatedHistory);
  await deps.applyResolvedWorkspace(resolvedPath);
  deps.logInfo('已切换工作区', deps.formatWorkspaceLabel(resolvedPath));
}

interface ApplyWorkspaceSwitchRuntimeFlowDeps {
  resolvedPath: string;
  setWorkDir: (workDir: string) => void;
  applyProcessWorkDir: (workDir: string) => void;
  setActionLogWorkspace: (workDir: string) => Promise<void>;
  setSdkWorkspace: (workDir: string) => void;
  reloadBaseTools: () => Promise<void>;
  ensureMcpTools: () => Promise<void>;
  clearSdkMemory: () => void;
  resetSessionForWorkspace: () => Promise<void>;
  updateUiAfterWorkspaceSwitch: () => void;
}

export async function applyWorkspaceSwitchRuntimeFlow(
  deps: ApplyWorkspaceSwitchRuntimeFlowDeps,
): Promise<void> {
  deps.setWorkDir(deps.resolvedPath);
  deps.applyProcessWorkDir(deps.resolvedPath);
  await deps.setActionLogWorkspace(deps.resolvedPath);
  deps.setSdkWorkspace(deps.resolvedPath);
  await deps.reloadBaseTools();
  await deps.ensureMcpTools();
  deps.clearSdkMemory();
  await deps.resetSessionForWorkspace();
  deps.updateUiAfterWorkspaceSwitch();
}
