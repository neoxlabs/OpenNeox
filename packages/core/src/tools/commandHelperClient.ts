
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { execa, type ExecaChildProcess } from 'execa';

type RunCommandOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  adoptOnTimeout?: boolean;
  /** 配合 adoptOnTimeout:子进程最终 exit 时的回调(完整 stdout/stderr/exitCode)*/
  onBackgroundExit?: (result: { pid: number; exitCode: number; stdout: string; stderr: string; totalDurationMs: number }) => void;
  /** 实时输出 chunk — 每次 child stdout/stderr 来数据就触发 */
  onStreamChunk?: (chunk: { kind: 'stdout' | 'stderr'; data: string; elapsed: number }) => void;
};

export type CommandHelperResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  adopted?: { pid: number; initialStdout: string; initialStderr: string; timeoutMs: number };
};

/**
 * 主入口 — in-process 直接 execa.
 * 支持: signal abort / timeout / adoption / stream chunk callback.
 */
export async function runCommandViaHelper(
  command: string,
  args: string[],
  cwd: string,
  options?: RunCommandOptions,
): Promise<CommandHelperResult> {
  const start = Date.now();
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let resolved = false;
  let adopted: CommandHelperResult['adopted'] | undefined;

  /* 起 child. reject:false 让 execa 不抛非零退出码; signal 用我们自己的 abort 路径管理. */
  let child: ExecaChildProcess<string>;
  try {
    child = execa(command, args, {
      cwd,
      env: options?.env as Record<string, string> | undefined,
      reject: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    return {
      stdout: '',
      stderr: `[spawn error] ${err?.message ?? err}`,
      exitCode: -1,
      durationMs: Date.now() - start,
    };
  }

  /* stream chunk 转发 */
  child.stdout?.on('data', (data) => {
    const s = String(data);
    stdoutChunks.push(s);
    try {
      options?.onStreamChunk?.({
        kind: 'stdout',
        data: s,
        elapsed: Math.floor((Date.now() - start) / 1000),
      });
    } catch { /* UI 回调坏了不影响命令本身 */ }
  });
  child.stderr?.on('data', (data) => {
    const s = String(data);
    stderrChunks.push(s);
    try {
      options?.onStreamChunk?.({
        kind: 'stderr',
        data: s,
        elapsed: Math.floor((Date.now() - start) / 1000),
      });
    } catch {}
  });

  /* signal abort → kill (在 promise 闭包外可以引用 child, 在闭包内是只读 capture) */
  const onAbort = () => {
    try { child.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1500).unref?.();
  };
  if (options?.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }

  const result = await new Promise<CommandHelperResult>((resolve) => {
    /* 闭包内 local 变量, 跟 finishAdopted 跨 promise 实例隔离, 并发调用互不污染 */
    let timeoutTimer: NodeJS.Timeout | undefined;
    let timedOut = false;

    const finishAdopted = () => {
      if (resolved) return;
      resolved = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolve({
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join(''),
        exitCode: 0,
        durationMs: Date.now() - start,
        adopted,
      });
      child.on('close', (code) => {
        try {
          options?.onBackgroundExit?.({
            pid: child.pid ?? -1,
            exitCode: code ?? 0,
            stdout: stdoutChunks.join(''),
            stderr: stderrChunks.join(''),
            totalDurationMs: Date.now() - start,
          });
        } catch (err: any) {
          cliLogger.warn('CMD_HELPER', `onBackgroundExit threw: ${err?.message ?? err}`);
        }
      });
    };

    /* timeout → 要么 kill 要么 adopt 成 background */
    if (options?.timeoutMs && options.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        if (options.adoptOnTimeout && child.pid) {
          adopted = {
            pid: child.pid,
            initialStdout: stdoutChunks.join(''),
            initialStderr: stderrChunks.join(''),
            timeoutMs: options.timeoutMs!,
          };
          finishAdopted();
        } else {
          timedOut = true;
          try { child.kill('SIGTERM'); } catch {}
          setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1500).unref?.();
        }
      }, options.timeoutMs);
      timeoutTimer.unref?.();
    }

    child.on('close', (code, signal) => {
      if (resolved) return;
      resolved = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (options?.signal) options.signal.removeEventListener('abort', onAbort);
      resolve({
        stdout: stdoutChunks.join(''),
        stderr: timedOut
          ? `${stderrChunks.join('')}[timeout] command killed after ${options?.timeoutMs}ms`
          : stderrChunks.join(''),
        exitCode: code ?? (timedOut ? 124 : signal ? -1 : 0),
        durationMs: Date.now() - start,
      });
    });
    child.catch((err: any) => {
      if (resolved) return;
      resolved = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (options?.signal) options.signal.removeEventListener('abort', onAbort);
      resolve({
        stdout: stdoutChunks.join(''),
        stderr: `${stderrChunks.join('')}[spawn error] ${err?.message ?? err}`,
        exitCode: -1,
        durationMs: Date.now() - start,
      });
    });
    child.on('error', (err: any) => {
      if (resolved) return;
      resolved = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (options?.signal) options.signal.removeEventListener('abort', onAbort);
      resolve({
        stdout: stdoutChunks.join(''),
        stderr: `${stderrChunks.join('')}[error] ${err?.message ?? err}`,
        exitCode: -1,
        durationMs: Date.now() - start,
      });
    });
  });

  return result;
}

export async function isHelperDaemonReachable(): Promise<boolean> {
  return true;
}

/**
 * 兼容 stub — 之前 spawn daemon. in-process 直接 no-op.
 */
export async function ensureCommandHelperRunning(): Promise<void> {
  /* no-op */
}
