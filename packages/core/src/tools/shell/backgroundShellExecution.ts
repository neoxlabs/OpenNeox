import { execa } from 'execa';
import type { PlatformLogger, PlatformServices } from '@neoxlabs/platform/platform/services.js';
import type { BackgroundTaskCallback } from './shellUiCallbacks.js';
import {
  formatBackgroundProcessCompleted,
  formatBackgroundProcessDuplicate,
  formatBackgroundProcessStarted,
  formatBackgroundStartFailed,
  formatCommandInterrupted,
} from './executeShellMessages.js';
import { getBackgroundTaskNotifier } from '../../runtime/shell/backgroundTaskNotifier.js';
import { spawnWithPty, isPtyAvailable } from './ptyExecutor.js';
import { getShellOutputStreamCallback } from './shellUiCallbacks.js';
import { decodeShellChunk } from './winOutputDecode.js';
import { buildShellInvocation } from './shellInvocation.js';

type RunBackgroundShellCommandArgs = {
  command: string;
  workspaceRoot: string;
  /** 进程 spawn 的工作目录, 默认等于 workspaceRoot. */
  cwd?: string;
  /** UI 触发 (serviceLauncher) 的明确 sessionId — 用于 shell_output_stream 推流路由.
   *  agent 路径不传 (走 ALS 自动解析). 用户从 UI 点 Start 时活跃 chat session 可能已结束,
   *  activeSessions 为空, 必须显式带 sessionId 进来才能让 UI 收到日志推流. */
  streamSessionId?: string;
  shellOption: string | boolean;
  signal?: AbortSignal;
  services: PlatformServices;
  logger: PlatformLogger;
  getBackgroundTaskCallback: () => BackgroundTaskCallback | null;
};

export async function runBackgroundShellCommand(
  args: RunBackgroundShellCommandArgs,
): Promise<string> {
  const { command, workspaceRoot, shellOption, signal, services, logger, getBackgroundTaskCallback } = args;
  /* spawn cwd 默认 = workspaceRoot, 显式传 cwd 时用显式 (serviceLauncher 走子目录). */
  const spawnCwd = args.cwd ?? workspaceRoot;
  const normalizedCommand = command.trim().replace(/\s+/g, ' ').replace(/\s*&\s*$/, '');
  const existingProcess = services.processManager.findByCommandCwd(normalizedCommand, spawnCwd)[0];

  if (existingProcess) {
    const runtime = Math.floor((Date.now() - existingProcess.startTime.getTime()) / 1000);
    const bgCount = services.processManager.getBackgroundRunning().length;

    return formatBackgroundProcessDuplicate(
      { workspaceRoot, command },
      existingProcess.pid,
      runtime,
      bgCount
    );
  }

  try {
    // 会保留彩色输出 + 实时进度条。PTY 不可用(测试环境 / 未 rebuild)回退到 execa。
    const usePty = isPtyAvailable();
    const ptyChild = usePty
      ? spawnWithPty({
          command,
          cwd: spawnCwd,
          env: services.shellEnv.getShellEnv(),
        })
      : null;

    // cmd.exe 解析原始命令, 导致后台命令与前台 (buildShellInvocation) 不同源
    // (PowerShell 语法 / UTF-8 注入丢失)。改为与前台共用 buildShellInvocation 包装。
    const invocation = buildShellInvocation(command, shellOption);
    const subprocess = ptyChild
      ? null
      : execa(invocation.cmd, invocation.args, {
          cwd: spawnCwd,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: services.shellEnv.getShellEnv(),
          /* win cmd 分支: 引号原样交给 cmd (见 ShellInvocation.windowsVerbatimArgs) */
          ...(invocation.windowsVerbatimArgs ? { windowsVerbatimArguments: true } : {}),
        });
    subprocess?.unref();
    void subprocess?.catch(() => { /* 结果走 processManager 事件通道 */ });

    const pid = ptyChild ? ptyChild.pid : subprocess!.pid;
    let bgTaskId: number | undefined;

    if (pid) {
      services.processManager.register({
        pid,
        command,
        cwd: spawnCwd,
        /* 归属工程根, 不是 spawnCwd —— serviceLauncher 会往子目录 spawn, 用 cwd 会把
         * 同一工程的服务拆散到几个"workspace"下 (多窗口隔离和退出清场都依赖这个字段). */
        workspaceRoot,
        background: true,
        processRef: ptyChild ?? subprocess,
      });

      // 让 BackgroundTaskNotifier 绑定 pid ↔ 当前 agentLoop session,
      // 进程退出时 notifier 会生成 <background-task-notification> XML 注入到 agent 的下一轮 user message。
      // 首次调用时懒订阅 processManager 事件。
      const notifier = getBackgroundTaskNotifier();
      notifier.attach(services.processManager);
      notifier.trackPid(pid, command);

      bgTaskId = getBackgroundTaskCallback()?.onAdd?.(command, pid);


      const handleExit = (code: number) => {
        services.processManager.markCompleted(pid, code);
        if (bgTaskId) {
          getBackgroundTaskCallback()?.onUpdate?.(bgTaskId, {
            status: code === 0 ? 'done' : 'error',
            exitCode: code,
          });
        }
        /* 关键 — bash 子进程的 OS pid 不在 processManager.processes 里, markCompleted
           对它是 noop, 不发 process:exit. notifier 用 attach 听 process:exit 永远等不到.
           直接通知 notifier 才能触发 handleTerminate → enqueueMessageForSession →
           autoResumeHandler → bridge.chat 自动起新一轮. */
        notifier.notifyTerminated(pid, code, false);
        /* 推一条 isComplete=true, exitCode 的终结流事件给 UI — ShellConsole 看 exit code 用 */
        const cb = getShellOutputStreamCallback();
        if (cb) {
          try {
            cb({
              toolId: streamToolId,
              command,
              output: outputChunks.join(''),
              outputDelta: '',
              elapsed: Date.now() - startedAt,
              isComplete: true,
              exitCode: code,
              pid,
              sessionId: args.streamSessionId,
            });
          } catch { /* 推流失败不影响主流程 */ }
        }
      };
      if (ptyChild) {
        ptyChild.onExit(({ exitCode }) => handleExit(exitCode ?? 0));
      } else {
        subprocess!.on('exit', (code) => handleExit(code ?? 0));
      }
    }

    /* abort listener 只在 instant ack 前那一刹那生效 — 之后 startupAbortGuard.abort()
     * 让 listener 失效. 后台进程的设计原意是脱离 agent turn 独立活下去, 不能跟 turn
     * abort 联动 (旧版每次 agent 回合结束就把 dev server 给杀了, 这里做防御). */
    const startupAbortGuard = new AbortController();
    if (signal && pid) {
      const onOuterAbort = () => {
        if (startupAbortGuard.signal.aborted) return; /* 收集窗口已过, 不再 kill bg */
        logger.info('SHELL', `收到中断信号 (启动收集期内)，终止后台进程 PID: ${pid}`);
        if (ptyChild) {
          ptyChild.kill('SIGTERM');
        } else {
          services.processManager.killProcessGroup(pid);
        }
      };
      signal.addEventListener('abort', onOuterAbort, { once: true, signal: startupAbortGuard.signal });
    }

    const outputChunks: string[] = [];
    /* 推流的 toolId — inline 路径没有 LLM tool_use_id, 用 pid 合成一个稳定 id.
     * 渲染端 ShellConsole subscribeTerminalChunkByPid 按 pid 反查 toolId, 这个 id 长啥样
     * 对 UI 没区别, 但 chunk bus 内部要靠它做去重 + ring buffer. */
    const streamToolId = pid ? `bg-shell-${pid}` : `bg-shell-${Date.now()}`;
    const startedAt = Date.now();

    const onData = (text: string) => {
      outputChunks.push(text);
      if (pid) {
        services.processManager.appendOutput(pid, text);
      }
      if (bgTaskId) {
        for (const line of text.split('\n').filter(Boolean)) {
          getBackgroundTaskCallback()?.onUpdate?.(bgTaskId, { outputLine: line });
        }
      }
      const cb = getShellOutputStreamCallback();
      if (cb && pid) {
        try {
          cb({
            toolId: streamToolId,
            command,
            output: outputChunks.join(''),
            outputDelta: text,
            elapsed: Date.now() - startedAt,
            pid,
            sessionId: args.streamSessionId,
          });
        } catch { /* 推流失败不影响主流程 */ }
      }
      if (process.env.CLI_DEBUG === '1') {
        logger.debug(ptyChild ? 'SHELL_PTY' : 'SHELL_STDOUT', text.trim());
      }
    };

    if (ptyChild) {
      // PTY merges stdout/stderr into a single data stream
      ptyChild.onData(onData);
    } else {
      subprocess!.stdout?.on('data', (d) => onData(decodeShellChunk(d)));
      subprocess!.stderr?.on('data', (d) => onData(decodeShellChunk(d)));
    }

    const COLLECT_WINDOW_MS = 1500;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, COLLECT_WINDOW_MS);
      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('Command interrupted by user'));
        }, { once: true });
      }
    });
    startupAbortGuard.abort();

    const fullOutput = outputChunks.join('');
    const trackedProc = pid !== undefined ? services.processManager.get(pid) : null;
    const exited = !trackedProc || trackedProc.status !== 'running';

    let result: string;
    if (exited && pid !== undefined) {
      /* 秒退 — 把真实 exit code + traceback 给 LLM, 不让它误报"已启动" */
      result = formatBackgroundProcessCompleted(
        { workspaceRoot, command },
        pid,
        trackedProc?.exitCode ?? 1,
        fullOutput,
      );
    } else {
      const bgCount = services.processManager.getBackgroundRunning().length;
      result = formatBackgroundProcessStarted(
        { workspaceRoot, command },
        pid,
        bgCount,
        COLLECT_WINDOW_MS / 1000,
        fullOutput,
      );
    }
    /* P0-6: services preamble — 状态变了 (启动 / 端口绑定 / 旧 pid 退出) 才挂一行,
     * LLM 一眼知道当前服务全景, 不需要再 service_scan. */
    const preamble = services.processManager.consumeServicesPreambleIfChanged();
    return preamble ? `${preamble}\n${result}` : result;
  } catch (error: any) {
    if (error.message === 'Command interrupted by user') {
      return formatCommandInterrupted({ workspaceRoot, command });
    }
    return formatBackgroundStartFailed({ workspaceRoot, command }, error.message);
  }
}
