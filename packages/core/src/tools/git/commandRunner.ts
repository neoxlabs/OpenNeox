import { runCommandViaHelper } from '../commandHelperClient.js';

type RunCommandOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

export type RunCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
};

export async function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  options?: RunCommandOptions
): Promise<RunCommandResult> {
  return runCommandViaHelper(cmd, args, cwd, options);
}

export async function getGitRepoRoot(
  cwd: string,
  signal?: AbortSignal,
  runCommandFn: (
    command: string,
    args: string[],
    cwd: string,
    options?: RunCommandOptions
  ) => Promise<RunCommandResult> = runCommand
): Promise<{ repoRoot?: string; error?: string }> {
  try {
    const result = await runCommandFn('git', ['rev-parse', '--show-toplevel'], cwd, { signal, timeoutMs: 8000 });
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      return { error: 'Not a git repository' };
    }
    return { repoRoot: result.stdout.trim() };
  } catch (error: any) {
    return { error: error?.message || 'Not a git repository' };
  }
}
