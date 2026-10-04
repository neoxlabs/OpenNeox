import { getGitRepoRoot as getGitRepoRootFromRunner, runCommand as runCommandCore, type RunCommandResult } from './commandRunner.js';

type RuntimeRunCommandOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

type GetShellEnvFn = () => Record<string, string>;

export interface RuntimeCommandRunner {
  getGitRepoRoot: (cwd: string, signal?: AbortSignal) => Promise<{ repoRoot?: string; error?: string }>;
  runCommand: (
    command: string,
    args: string[],
    cwd: string,
    options?: RuntimeRunCommandOptions
  ) => Promise<RunCommandResult>;
}

export function createRuntimeCommandRunner(getShellEnv: GetShellEnvFn): RuntimeCommandRunner {
  async function runCommand(
    command: string,
    args: string[],
    cwd: string,
    options?: RuntimeRunCommandOptions
  ): Promise<RunCommandResult> {
    return runCommandCore(command, args, cwd, {
      ...options,
      env: {
        ...getShellEnv(),
        TERM: 'dumb',
      },
    });
  }

  async function getGitRepoRoot(
    cwd: string,
    signal?: AbortSignal
  ): Promise<{ repoRoot?: string; error?: string }> {
    return getGitRepoRootFromRunner(cwd, signal, runCommand);
  }

  return {
    getGitRepoRoot,
    runCommand,
  };
}
