import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { bumpWorkspaceEpoch } from '../smart-read/readLedger.js';
import { resolveShellCwd } from './shellCwd.js';
/* 命令没跑成 ≠ 工具失败 (退出码不标)。但**命令根本没被执行**这几种是工具层的拒绝, 要标。 */
import { markToolFailure } from '@neoxlabs/kernel/core/types/toolResult.js';
import type { PlatformLogger, PlatformServices } from '@neoxlabs/platform/platform/services.js';
import type { ProcessManager } from '@neoxlabs/platform/platform/processManager.js';
import type { TerminalExecutor } from '../terminal/executorRegistry.js';
import type { ShellOutputStreamPayload } from './shellWorkerClient.js';
import type { BackgroundTaskCallback } from './shellUiCallbacks.js';
import { analyzeCommandChainRisks, detectBlockedSleepPattern, isAutoBackgroundAllowed } from './shellCommandGuards.js';
import { getBackgroundTaskNotifier } from '../../runtime/shell/backgroundTaskNotifier.js';
import { LONG_FINITE_COMMAND_PATTERNS, LONG_RUNNING_COMMAND_PATTERNS } from './constants.js';
import { getBashDefaultTimeoutMs, getBashMaxTimeoutMs } from '@neoxlabs/platform/runtime/agentRuntimeConfig.js';
import { preflightServiceCheck } from './servicePreflightCheck.js';
import { formatBackgroundProcessDuplicate } from './executeShellMessages.js';


type ExecuteShellInWorkerParams = {
  toolId: string;
  command: string;
  background: boolean;
  workspaceRoot: string;
  signal?: AbortSignal;
};

type ExecuteShellInWorkerDeps = {
  logger: PlatformLogger;
  processManager: ProcessManager;
  onShellOutputStream?: (payload: ShellOutputStreamPayload) => void;
  onBackgroundTaskUpdateByPid?: (
    pid: number,
    updates: { status?: string; exitCode?: number }
  ) => void;
  /** shell_started 时即时通知 BackgroundTasksBar — 不再等 8s collectMs 后才显示 */
  onBackgroundTaskAdd?: (command: string, pid: number) => void;
};

type ExecuteShellInWorkerFn = (
  params: ExecuteShellInWorkerParams,
  deps: ExecuteShellInWorkerDeps
) => Promise<{
  success: boolean;
  output: string;
  background: boolean;
  pid?: number;
  exitCode?: number;
} | null>;

type CreateExecuteShellToolDeps = {
  shellOption: string | boolean;
  getWorkspaceRoot: () => string;
  getSandboxEnabled: () => boolean;
  getToolLogger: () => PlatformLogger;
  getToolServices: () => PlatformServices;
  getTerminalExecutor: () => TerminalExecutor | null;
  getShellOutputStreamCallback: () => ((payload: ShellOutputStreamPayload) => void) | null;
  getBackgroundTaskCallback: () => BackgroundTaskCallback | null;
  validateShellCommandForSandbox: (command: string, sandboxEnabled: boolean) => string | null;
  warnBackgroundCommandSyntax: (command: string, background: boolean, logger: PlatformLogger) => void;
  runTerminalUiShellCommand: (args: {
    command: string;
    workspaceRoot: string;
    terminalExecutor: TerminalExecutor | null;
    logger: PlatformLogger;
  }) => Promise<string | null>;
  executeShellInWorker: ExecuteShellInWorkerFn;
  runBackgroundShellCommand: (args: {
    command: string;
    workspaceRoot: string;
    shellOption: string | boolean;
    signal?: AbortSignal;
    services: PlatformServices;
    logger: PlatformLogger;
    getBackgroundTaskCallback: () => BackgroundTaskCallback | null;
  }) => Promise<string>;
  runForegroundShellCommand: (args: {
    command: string;
    workspaceRoot: string;
    shellOption: string | boolean;
    signal?: AbortSignal;
    services: PlatformServices;
    emitShellStream: (payload: {
      output: string;
      outputDelta?: string;
      elapsed: number;
      isComplete?: boolean;
      exitCode?: number;
    }) => void;
    timeoutMs?: number;
    shouldYieldToSteering?: () => boolean;
  }) => Promise<string>;
};

export function isReadOnlyShellCommand(command: string): boolean {
  const cmd = String(command ?? '').trim();
  if (!cmd) return false;
  // 剥离 cd xxx && 前缀
  const body = cmd.replace(/^\s*(cd\s+\S+\s*&&\s*)+/i, '').trim();
  // 禁止 `;` `&&` `||` 组合命令(只对单命令判定安全)
  if (/[;|&]{1,2}/.test(body)) return false;
  // 任何重定向都算写 (`echo x > f` / `cat a >> b` / `tee f`)
  if (/(^|\s)>{1,2}(\s|$)|\s>\S|\btee\b/.test(body)) return false;
  const READONLY_CMD_PREFIXES = [
    /^ls(\s|$)/i, /^cat(\s|$)/i, /^pwd(\s|$)/i, /^echo(\s|$)/i,
    /^head(\s|$)/i, /^tail(\s|$)/i, /^wc(\s|$)/i, /^file(\s|$)/i,
    /^which(\s|$)/i, /^whereis(\s|$)/i, /^find(\s|$)/i,
    /^git\s+(status|log|diff|show|blame|branch\s*$|remote\s*$|config\s+--get|rev-parse)/i,
    /^grep(\s|$)/i, /^rg(\s|$)/i, /^tree(\s|$)/i,
    /^stat(\s|$)/i, /^du(\s|$)/i, /^df(\s|$)/i,
    /^env(\s|$)/i, /^printenv(\s|$)/i,
    /^date(\s|$)/i, /^uname(\s|$)/i, /^hostname(\s|$)/i,
    /^node\s+-v/i, /^npm\s+(ls|list|-v|--version|config\s+get)/i,
  ];
  return READONLY_CMD_PREFIXES.some((re) => re.test(body));
}

export function createExecuteShellTool({
  shellOption,
  getWorkspaceRoot,
  getSandboxEnabled,
  getToolLogger,
  getToolServices,
  getTerminalExecutor,
  getShellOutputStreamCallback,
  getBackgroundTaskCallback,
  validateShellCommandForSandbox,
  warnBackgroundCommandSyntax,
  runTerminalUiShellCommand,
  executeShellInWorker,
  runBackgroundShellCommand,
  runForegroundShellCommand,
}: CreateExecuteShellToolDeps): Tool {
  return {
    name: 'execute_shell',
    // 动态并发安全判定:只读 shell 命令(ls / cat / git status 等)允许并发,
    // 写/修改类命令(rm / git commit / npm install 等)串行。
    // 白名单以 shell 命令开头(忽略前导 cd && 、 || 组合)。
    isConcurrencySafe: (args: Record<string, any>) => {
      if (args?.background === true) return false;
      return isReadOnlyShellCommand(String(args?.command ?? ''));
    },
    description: `Execute shell command. You are ALREADY in the workspace root — do not prefix \`cd <workspace>\` (it is redundant). To run inside a subdirectory pass cwd: "sub/dir" instead of chaining cd. State does not carry over between calls.

background=false (default) is for anything that finishes on its own and whose result you need: ls / git / grep, and also builds, tests, analyzers, installs and one-off scripts. You get the full output in this call. 120s timeout by default; builds/tests/installs get up to 600000ms automatically, or pass timeout.
background=true is ONLY for processes that keep running (dev server / watch mode / tail -f) or jobs you truly expect to exceed 10 minutes:
  · returns a pid after ~8s of output; when the process exits the next user turn carries <background-task-notification pid status> — do not sleep/poll
  · bash_output(pid) reads output, bash_kill(pid) stops it; do not retry the same command (duplicates are dropped)
  · do not append '&', and do not redirect logs to a file (the Neox services panel mirrors stdout — redirecting hides it from the user)
Running a test or build in the background and then polling bash_output wastes round trips — run it in the foreground.

Port conflicts: starting a dev server auto-detects a busy port and returns a warning plus the existing pid. Do not retry blindly — take it over with service_adopt(pid), or bash_kill(pid) and restart.`,
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell command to execute',
        },
        output_files: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional paths this command is expected to create/overwrite (workspace-relative or absolute). '
            + 'Declare known script outputs so they appear in turn changes without scanning the whole workspace. '
            + 'Do NOT list files from git pull / npm install — those are not turn work products.',
        },
        background: {
          type: 'boolean',
          description: 'Run in background. TRUE only for processes that do not exit on their own (npm run dev, servers, watch modes). FALSE for everything that finishes: ls, git, builds, tests, installs, scripts — you need their output. Default: false',
        },
        timeout: {
          type: 'number',
          description: 'Optional timeout in milliseconds (max 600000ms / 10 minutes). By default, timeout is auto-inferred from the command type (e.g. ls=10s, npm=5min, docker=10min).',
        },
        interactive: {
          type: 'boolean',
          description: 'Set TRUE only when the command needs stdin interaction (ssh, sudo, vim, mysql shell, python REPL, git commit without -m). Default: false. Most commands (build, test, grep, ls, install) do NOT need this.',
        },
        cwd: {
          type: 'string',
          description: 'Run in this directory instead of the workspace root (relative to workspace root, or absolute). Use this instead of a `cd ... &&` prefix.',
        },
      },
      required: ['command'],
    },
    async function({ command, background: _bg = false, timeout: _timeout, interactive: _interactive = false, output_files: _outputFiles, cwd: _cwd }, context) {
      let background = _bg;
      const logger = getToolLogger();
      const services = getToolServices();

      const mightWrite = !isReadOnlyShellCommand(command);
      const bumpIfNeeded = () => {
        if (!mightWrite) return;
        try { bumpWorkspaceEpoch(); } catch { /* 缓存失效失败不该影响命令本身 */ }
      };

      try {

      const sandboxError = validateShellCommandForSandbox(command, getSandboxEnabled());
      if (sandboxError) {
        /* 沙箱拦下 = 命令一行没跑, 这是工具层拒绝, 不是"命令执行结果不好" */
        return markToolFailure(sandboxError);
      }

      //   Claude Code 风格 — 替它做对而不是教育它. background 路径会立即 ack (~1.5s),
      //   进程真完成时 <background-task-notification> 通知 LLM. LLM 不需要懂 sleep != background.
      if (!background) {
        const sleepHit = detectBlockedSleepPattern(command);
        if (sleepHit) {
          logger.info('SHELL', `[auto-bg] sleep pattern detected (${sleepHit}) — flipping to background=true silently`);
          background = true;
        }
      }

      const chainRisks = analyzeCommandChainRisks(command);
      if (chainRisks.length > 0) {
        const allRisks = chainRisks.flatMap(r => r.risks);
        logger.warn('SHELL', `⚠️ Command chain risks detected: ${allRisks.join('; ')}`);
        // Git 内部路径写入 → 硬拒绝
        const gitInternalRisk = allRisks.find(r => r.includes('git internal path'));
        if (gitInternalRisk) {
          return markToolFailure(`🚫 命令被拒绝: ${gitInternalRisk}\n此操作可能导致 git hook 注入或仓库损坏。`);
        }
      }

      const cwdResolved = resolveShellCwd(_cwd, getWorkspaceRoot());
      if (cwdResolved.error) return markToolFailure(cwdResolved.error);
      const workspaceRoot = cwdResolved.dir;
      const signal = context?.signal;
      // 优先用 LLM 给的 tool_use_id (orchestrate → runner.invokeTool → context.toolCallId 透传过来),
      // 让 shell_output_stream 事件的 toolId 跟 timeline entry.toolCallId 一致, 渲染端 (xterm /
      // commandRawOutput / pending 状态) 才能正确匹配. 老的 fallback 仅用于离线测试 / 没经过
      // orchestrate 的直接调用路径.
      const shellStreamToolId =
        (context as any)?.toolCallId
        || `shell_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      const emitShellStream = (payload: {
        output: string;
        outputDelta?: string;
        elapsed: number;
        isComplete?: boolean;
        exitCode?: number;
      }) => {
        const cb = getShellOutputStreamCallback();
        if (!cb) {
          console.warn('[SHELL_TOOL] emitShellStream: callback is NULL (elapsed=' + payload.elapsed + ' complete=' + payload.isComplete + ')');
        }
        cb?.({
          toolId: shellStreamToolId,
          command,
          output: payload.output,
          outputDelta: payload.outputDelta,
          elapsed: payload.elapsed,
          isComplete: payload.isComplete,
          exitCode: payload.exitCode,
        });
      };

      warnBackgroundCommandSyntax(command, background, logger);

      /* interactive=true 时走 PTY 终端（ssh/sudo/vim/REPL 等需要 stdin 交互的命令）。
         默认 false 走 execa 直接执行——快、稳、输出实时 stream 到 timeline 卡片。 */
      if (_interactive) {
        const terminalOutput = await runTerminalUiShellCommand({
          command,
          workspaceRoot,
          terminalExecutor: getTerminalExecutor(),
          logger,
        });
        if (terminalOutput) {
          return terminalOutput;
        }
        // terminalExecutor 不可用时 fallback 到 execa
      }

      // 规则集合:LONG_RUNNING_COMMAND_PATTERNS(常量文件)覆盖 server/install/build/migrate。
      if (!background) {
        if (LONG_RUNNING_COMMAND_PATTERNS.some(p => p.test(command)) && isAutoBackgroundAllowed(command)) {
          logger.info('SHELL', `⚡ Auto-promoting to background: "${command.slice(0, 60)}..." (long-running pattern matched)`);
          background = true;
        }
      }

      if (!background) {
        /* 构建/安装/测试不再转后台 (见 LONG_FINITE_COMMAND_PATTERNS): 没给超时就放宽到上限, 前台等它跑完 */
        const longFinite = LONG_FINITE_COMMAND_PATTERNS.some(p => p.test(command));
        const effectiveTimeout = _timeout
          ? Math.min(Math.max(_timeout, 1000), getBashMaxTimeoutMs())
          : longFinite
            ? Math.max(getBashDefaultTimeoutMs(), getBashMaxTimeoutMs())
            : getBashDefaultTimeoutMs();
        logger.info('SHELL', `Timeout: ${effectiveTimeout}ms (${_timeout ? 'user-specified' : 'auto-inferred'}) for: ${command.slice(0, 60)}`);
        return runForegroundShellCommand({
          command,
          workspaceRoot,
          shellOption,
          signal,
          services,
          emitShellStream,
          timeoutMs: effectiveTimeout,
          shouldYieldToSteering: context?.shouldYieldToSteering,
        });
      }

      const preflightResult = preflightServiceCheck(command, services.processManager, logger);
      if (preflightResult) {
        return preflightResult;
      }

      {
        const normalizedCommand = command.trim().replace(/\s+/g, ' ').replace(/\s*&\s*$/, '');
        const existingProcess = services.processManager.getBackgroundRunning()
          .find(p => p.command.trim().replace(/\s+/g, ' ').replace(/\s*&\s*$/, '') === normalizedCommand);
        if (existingProcess) {
          const runtime = Math.floor((Date.now() - existingProcess.startTime.getTime()) / 1000);
          return formatBackgroundProcessDuplicate(
            { workspaceRoot, command },
            existingProcess.pid,
            runtime,
            services.processManager.getBackgroundRunning().length,
          );
        }
      }

      const workerResult = await executeShellInWorker(
        {
          toolId: shellStreamToolId,
          command,
          background,
          workspaceRoot,
          signal,
        },
        {
          logger,
          processManager: services.processManager,
          onShellOutputStream: getShellOutputStreamCallback() ?? undefined,
          onBackgroundTaskUpdateByPid: getBackgroundTaskCallback()?.onUpdateByPid,
          /* 关键: shellWorkerClient 在 shell_started 时即时调这个回调 → BackgroundTasksBar
             立刻显示, 不再等 collectMs (8s) 后才出现. */
          onBackgroundTaskAdd: getBackgroundTaskCallback()?.onAdd,
        }
      );
      if (workerResult) {
        if (workerResult.background && workerResult.pid) {
          /* shell_started 路径已经 register + onAdd 了, 这里只兜底 + 接 notifier.
             不再重复 onAdd (会创建重复条目, 因为 store 按 taskId 去重而 onAdd 每调一次新发 taskId). */
          if (!services.processManager.get(workerResult.pid)) {
            services.processManager.register({
              pid: workerResult.pid,
              command,
              cwd: workspaceRoot,
              workspaceRoot,
              background: true,
            });
          }
          // 绑定 pid ↔ 当前 session,让 notifier 在进程退出时注入 <background-task-notification>
          const notifier = getBackgroundTaskNotifier();
          notifier.attach(services.processManager);
          notifier.trackPid(workerResult.pid, command);
          const bgCount = services.processManager.getBackgroundRunning().length;
          const bgOutput = workerResult.output.replace(/当前后台进程总数:\s*\d+/, `当前后台进程总数: ${bgCount}`);
          /* services preamble — 服务全景变化时挂一行, LLM 一眼看到"哪些服务已在跑",
           * 不再盲目重启 (旧路径一直有, in-process 主路径漏了). */
          const preamble = services.processManager.consumeServicesPreambleIfChanged();
          return preamble ? `${preamble}\n${bgOutput}` : bgOutput;
        }
        return workerResult.output;
      }

      if (background) {
        return runBackgroundShellCommand({
          command,
          workspaceRoot,
          shellOption,
          signal,
          services,
          logger,
          getBackgroundTaskCallback,
        });
      }

      /* 同上: 读配置而不是静态常量 (见前一处注释) */
      const fallbackTimeout = _timeout
        ? Math.min(Math.max(_timeout, 1000), getBashMaxTimeoutMs())
        : LONG_FINITE_COMMAND_PATTERNS.some(p => p.test(command))
          ? Math.max(getBashDefaultTimeoutMs(), getBashMaxTimeoutMs())
          : getBashDefaultTimeoutMs();
      return runForegroundShellCommand({
        command,
        workspaceRoot,
        shellOption,
        signal,
        services,
        emitShellStream,
        timeoutMs: fallbackTimeout,
        shouldYieldToSteering: context?.shouldYieldToSteering,
      });
      } finally {
        bumpIfNeeded();
      }
    },
  };
}
