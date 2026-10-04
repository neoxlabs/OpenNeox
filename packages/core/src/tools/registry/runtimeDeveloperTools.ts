import type { Tool } from '@neoxlabs/kernel/types/index.js';
import type { PlatformLogger } from '@neoxlabs/platform/platform/services.js';
import { createAnalyzeCodeTool } from '../analysis/analyzeCodeTool.js';
import { createRuntimeGitTools } from '../git/runtimeGitTools.js';
import { createRuntimeSearchToolBinding } from '../search/runtimeSearchToolBinding.js';
import { createRuntimeStructuredCommandTools } from '../terminal/runtimeStructuredCommandTools.js';

type RunCommand = (
  command: string,
  args: string[],
  cwd: string,
  options?: { timeoutMs?: number; signal?: AbortSignal }
) => Promise<{ stdout: string; stderr: string; exitCode: number; durationMs: number }>;

interface RuntimeDeveloperToolsDeps {
  formatDisplayPath: (absPath: string) => string;
  getGitRepoRoot: (cwd: string, signal?: AbortSignal) => Promise<{ repoRoot?: string; error?: string }>;
  getLogger: () => PlatformLogger;
  getWorkspaceRoot: () => string;  resolveWorkspacePath: (requestedPath?: string) => string;
  runCommand: RunCommand;
}

export function createRuntimeDeveloperTools(deps: RuntimeDeveloperToolsDeps): {
  analyzeCode: Tool;
  gitBlame: Tool;
  gitBranch: Tool;
  gitBranchList: Tool;
  gitCommit: Tool;
  gitDiff: Tool;
  gitStatus: Tool;
  runFormat: Tool;
  runLint: Tool;
  runTests: Tool;
  searchTool: Tool;
} {
  const runtimeGitTools = createRuntimeGitTools({
    resolveWorkspacePath: deps.resolveWorkspacePath,    getWorkspaceRoot: deps.getWorkspaceRoot,
    getGitRepoRoot: deps.getGitRepoRoot,
    runCommand: deps.runCommand,
  });

  const runtimeStructuredCommandTools = createRuntimeStructuredCommandTools({
    resolveWorkspacePath: deps.resolveWorkspacePath,    runCommand: deps.runCommand,
  });

  return {
    analyzeCode: createAnalyzeCodeTool({ resolveWorkspacePath: deps.resolveWorkspacePath }),
    gitBlame: runtimeGitTools.gitBlame,
    gitBranch: runtimeGitTools.gitBranch,
    gitBranchList: runtimeGitTools.gitBranchList,
    gitCommit: runtimeGitTools.gitCommit,
    gitDiff: runtimeGitTools.gitDiff,
    gitStatus: runtimeGitTools.gitStatus,
    runFormat: runtimeStructuredCommandTools.runFormat,
    runLint: runtimeStructuredCommandTools.runLint,
    runTests: runtimeStructuredCommandTools.runTests,
    searchTool: createRuntimeSearchToolBinding({
      resolveWorkspacePath: deps.resolveWorkspacePath,
      formatDisplayPath: deps.formatDisplayPath,
      getWorkspaceRoot: deps.getWorkspaceRoot,
      runCommand: deps.runCommand,
      getLogger: deps.getLogger,
    }),
  };
}
