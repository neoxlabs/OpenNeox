import { spawn } from 'node:child_process';
import { CLI_COMMAND, CLI_PREFIX_ARGS } from './repo.js';
import type { CliWorkspace } from './workspace.js';

export interface RunCliOptions {
  /** 工作目录, 默认 workspace.cwd */
  cwd?: string;
  /** stdin 内容; 不传则立即关闭 stdin (等效 </dev/null) */
  stdin?: string;
  /** wall-clock 上限, 默认 60s */
  timeoutMs?: number;
  env?: Record<string, string>;
  debug?: boolean;
}

export interface CliResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  args: string[];
}

/** 非交互跑一次 CLI (`neox <args>`), 收集 stdout/stderr/退出码. */
export function runCli(ws: CliWorkspace, args: string[], opts: RunCliOptions = {}): Promise<CliResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const started = Date.now();
  return new Promise<CliResult>((resolve) => {
    const child = spawn(CLI_COMMAND, [...CLI_PREFIX_ARGS, ...args], {
      cwd: opts.cwd ?? ws.cwd,
      env: { ...ws.env, ...(opts.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (opts.debug) process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (opts.debug) process.stderr.write(chunk);
    });

    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
        args,
      });
    };

    child.on('close', (code, signal) => finish(code, signal));
    child.on('error', (err) => {
      stderr += `\n[spawn error] ${err.message}`;
      finish(null, null);
    });
  });
}
