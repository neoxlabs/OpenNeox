
import type { ProcessManager } from '@neoxlabs/platform/platform/processManager.js';
import type { TrackedProcessKind } from '@neoxlabs/platform/platform/processManager.js';
import type { PlatformLogger } from '@neoxlabs/platform/platform/services.js';
import {
  startInProcessShell,
  sendStdinToInProcessShell,
  resizeInProcessShell,
  getActiveInProcessShellPids,
} from './inProcessShell.js';
import { formatBackgroundProcessCompleted, formatBackgroundProcessStarted } from './executeShellMessages.js';

export type ShellOutputStreamPayload = {
  toolId: string;
  command: string;
  output: string;
  outputDelta?: string;
  elapsed: number;
  isComplete?: boolean;
  exitCode?: number;
  /** PTY 子进程 pid — 渲染端 xterm 把 onData 字节回流到 sendShellStdin(pid, data) 时需要它. */
  pid?: number;
  /** 显式 sessionId — UI 从 Hono handler 触发 (serviceLauncher) 时, ALS 无 session
   *  context, chat 又已结束 activeSessions 是空集, server callback 内部无法解析出哪个
   *  session 去 publish. 让 caller 带 sessionId 进来直接路由. */
  sessionId?: string;
};

export type ExecuteShellWorkerResult = {
  success: boolean;
  output: string;
  background: boolean;
  pid?: number;
  exitCode?: number;
};

type ExecuteShellWorkerParams = {
  toolId: string;
  command: string;
  background: boolean;
  workspaceRoot: string;
  signal?: AbortSignal;
  /* free shell 入口传 'free-shell' — Services 面板按这个过滤, 不让 exec /bin/zsh -i
   * 这种纯交互 PTY 出现在服务列表. 不传走默认 'background-task'. */
  kind?: TrackedProcessKind;
};

type ExecuteShellWorkerDeps = {
  logger: PlatformLogger;
  processManager: ProcessManager;
  onShellOutputStream?: (payload: ShellOutputStreamPayload) => void;
  onBackgroundTaskUpdateByPid?: (
    pid: number,
    updates: { status?: string; exitCode?: number }
  ) => void;
  /** 后台任务的"已启动"通知 — 起进程就立刻触发, 不等 collectMs (1.5s).
   *  daemon 时代之前 onAdd 在 executeShellInWorker resolve 之后才在 executeShellTool 里调,
   *  导致 BackgroundTasksBar 等 8s 才看到任务条目, 用户以为"没注册"。in-process 路径下
   *  onStarted 同步触发, 这个延迟问题不再存在。 */
  onBackgroundTaskAdd?: (command: string, pid: number) => void;
};

/** PTY stdin 透传 — xterm onData 字节通过本函数到子进程 stdin. */
export function sendShellStdin(pid: number, data: string): boolean {
  return sendStdinToInProcessShell(pid, data);
}

/** xterm 容器尺寸变化 — 调子进程 PTY resize, TUI 不错位. */
export function resizeShell(pid: number, cols: number, rows: number): boolean {
  return resizeInProcessShell(pid, cols, rows);
}

/** 诊断: 返回当前所有 active shell pid 列表. UI 端定位 "stdin 不通" 用. */
export function getActiveShellPids(): number[] {
  return getActiveInProcessShellPids();
}

export async function executeShellInWorker(
  params: ExecuteShellWorkerParams,
  deps: ExecuteShellWorkerDeps,
): Promise<ExecuteShellWorkerResult | null> {
  if (process.env.NEOX_SHELL_WORKER_DISABLED === '1') {
    return null;
  }

  const { toolId, command, background, workspaceRoot, signal, kind } = params;

  let startedPid: number | undefined;

  /* 起 in-process shell. background=true 时 collectMs 默认 1500ms 让 LLM 拿到第一段 output ack;
     foreground 直接等真完成. */
  const handle = startInProcessShell(
    {
      command,
      cwd: workspaceRoot,
      background,
      collectMs: background ? 1500 : 0,
      cols: 120,
      rows: 30,
    },
    {
      onStarted: (pid) => {
        startedPid = pid > 0 ? pid : undefined;
        if (pid <= 0) return;
        /* 起来后立即给 onShellOutputStream 发空 output 透 pid, 让 UI 显示 pid + start button */
        try {
          deps.onShellOutputStream?.({ toolId, command, output: '', elapsed: 0, pid });
        } catch { /* UI 回调坏了不影响命令本身 */ }
        if (background) {
          if (!deps.processManager.get(pid)) {
            deps.processManager.register({
              pid,
              command,
              cwd: workspaceRoot,
              workspaceRoot,
              background: true,
              kind,
            });
          }
          try { deps.onBackgroundTaskAdd?.(command, pid); } catch {}
        }
      },
      onStream: (chunk) => {
        if (background && startedPid && chunk.outputDelta) {
          try { deps.processManager.appendOutput(startedPid, chunk.outputDelta); } catch { /* noop */ }
        }
        try {
          deps.onShellOutputStream?.({
            toolId,
            command,
            output: chunk.output,
            outputDelta: chunk.outputDelta,
            elapsed: chunk.elapsed,
            isComplete: chunk.isComplete,
            exitCode: chunk.exitCode,
            pid: startedPid,
          });
        } catch { /* UI 回调坏了不影响命令本身 */ }
      },
      onBackgroundExit: (pid, exitCode) => {
        /* background 进程真退出 — 通知 UI 状态变 done/error + 清 processManager */
        try {
          deps.onBackgroundTaskUpdateByPid?.(pid, {
            status: exitCode === 0 ? 'done' : 'error',
            exitCode,
          });
        } catch {}
        try { deps.processManager.markCompleted(pid, exitCode); } catch {}
      },
    },
  );

  if (signal) {
    if (signal.aborted) {
      handle.kill();
    } else if (!background) {
      signal.addEventListener('abort', () => handle.kill(), { once: true });
    } else {
      /* 后台: 只在收集窗口内响应 abort (那时用户还在等这条命令的即时反馈);
       * 窗口一过就摘掉监听, 让它脱离 turn 独立活下去。 */
      const startupGuard = new AbortController();
      signal.addEventListener('abort', () => {
        if (startupGuard.signal.aborted) return;
        handle.kill();
      }, { once: true, signal: startupGuard.signal });
      setTimeout(() => startupGuard.abort(), 1500).unref?.();
    }
  }

  const result = await handle.result;
  const formattedOutput = background
    ? (result.background
        ? formatBackgroundProcessStarted({ workspaceRoot, command }, result.pid,
            Math.max(1, deps.processManager.getBackgroundRunning().length), 1.5, result.output)
        : formatBackgroundProcessCompleted({ workspaceRoot, command }, result.pid, result.exitCode, result.output))
    : result.output;

  return {
    success: result.success,
    output: formattedOutput,
    background: !!result.background,
    pid: result.pid,
    exitCode: result.exitCode,
  };
}
