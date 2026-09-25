import { runCommandViaHelper } from '../commandHelperClient.js';
import { execa } from 'execa';
import { decodeShellChunk } from './winOutputDecode.js';
import type { PlatformServices } from '@neoxlabs/platform/platform/services.js';
import { formatForegroundFailed, formatForegroundTimeout, formatForegroundSteered } from './executeShellMessages.js';
import { shouldUseOsSandbox, getCurrentSandboxTier, buildMaybeSandboxedInvocation } from './osSandbox.js';
import { getBackgroundTaskNotifier } from '../../runtime/shell/backgroundTaskNotifier.js';
import { isAdoptOnTimeoutEnabled } from '@neoxlabs/platform/runtime/agentRuntimeConfig.js';
import { classifyShellResult } from './exitCodeSemantics.js';
import {
  buildShellInvocation,
  resolveExecaExitCode,
} from './shellInvocation.js';

export { resolveWindowsShellExecutable, resolveExecaExitCode, buildShellInvocation } from './shellInvocation.js';

type EmitShellStreamPayload = {
  output: string;
  outputDelta?: string;
  elapsed: number;
  isComplete?: boolean;
  exitCode?: number;
};

type RunForegroundShellCommandArgs = {
  command: string;
  workspaceRoot: string;
  shellOption: string | boolean;
  signal?: AbortSignal;
  services: PlatformServices;
  emitShellStream: (payload: EmitShellStreamPayload) => void;
  timeoutMs?: number;
  /** 用户在命令执行中"立即插话"时让出: 返回 true → 杀掉正在跑的命令, 用半截输出返回。
   *  判据来自 runner 的 steeringGeneration (与后台 bash_output 的让出同源)。 */
  shouldYieldToSteering?: () => boolean;
};

export async function runForegroundShellCommand({
  command,
  workspaceRoot,
  shellOption,
  signal,
  services,
  emitShellStream,
  timeoutMs,
  shouldYieldToSteering,
}: RunForegroundShellCommandArgs): Promise<string> {
  try {
    const startTime = Date.now();
    const effectiveTimeout = timeoutMs ?? 120_000;

    const startSteeringWatch = (kill: () => void): { stop: () => void; steered: () => boolean } => {
      let steered = false;
      if (!shouldYieldToSteering) return { stop: () => {}, steered: () => false };
      const timer = setInterval(() => {
        if (steered) return;
        try { if (!shouldYieldToSteering()) return; } catch { return; }
        steered = true;
        kill();
      }, 250);
      timer.unref?.();
      return { stop: () => clearInterval(timer), steered: () => steered };
    };

    // 走 sandbox-exec (macOS) / unshare (Linux);不可用时 graceful fallback。
    if (shouldUseOsSandbox()) {
      const sbInv = buildMaybeSandboxedInvocation(command, workspaceRoot);
      const sbStart = Date.now();
      let sbOut = '';
      let sbErr = '';
      const subprocess = execa(sbInv.cmd, sbInv.args, {
        cwd: workspaceRoot,
        reject: false,
        timeout: effectiveTimeout,
        env: services.shellEnv.getShellEnv(),
        stdin: 'ignore',
        /* win cmd 分支: 引号原样交给 cmd (与下方 direct 分支同源, 见 windowsVerbatimArgs) */
        ...(sbInv.windowsVerbatimArgs ? { windowsVerbatimArguments: true } : {}),
      } as any);
      const sbKillTree = () => {
        if (subprocess.pid) {
          try { services.processManager.killProcessGroup(subprocess.pid, 'SIGTERM', 'user'); } catch {}
        }
      };
      if (signal) {
        if (signal.aborted) sbKillTree();
        else signal.addEventListener('abort', sbKillTree, { once: true });
      }
      const sbWatch = startSteeringWatch(sbKillTree);
      subprocess.stdout?.on('data', (chunk: Buffer) => {
        const text = decodeShellChunk(chunk);
        sbOut += text;
        emitShellStream({ output: sbOut + sbErr, outputDelta: text, elapsed: Math.floor((Date.now() - sbStart) / 1000), isComplete: false });
      });
      subprocess.stderr?.on('data', (chunk: Buffer) => {
        const text = decodeShellChunk(chunk);
        sbErr += text;
        emitShellStream({ output: sbOut + sbErr, outputDelta: text, elapsed: Math.floor((Date.now() - sbStart) / 1000), isComplete: false });
      });
      let sbExit = 0;
      try {
        const r = await subprocess;
        sbExit = resolveExecaExitCode(r as any);
      } finally {
        signal?.removeEventListener('abort', sbKillTree);
        sbWatch.stop();
        sbInv.cleanup();
      }
      emitShellStream({
        output: sbOut + sbErr,
        elapsed: Math.floor((Date.now() - sbStart) / 1000),
        isComplete: true,
        exitCode: sbExit,
      });

      const tierLabels: Record<string, string> = {
        'read-only': '只读 (read-only)',
        'workspace-write': '工作区可写 · 断网 (workspace-write)',
        'workspace-net': '工作区可写 · 联网 (workspace-net)',
        'trusted': '完全放开 (trusted)',
      };
      const backendLabel =
        sbInv.backend === 'appcontainer'
          ? 'appcontainer (Win FS 隔离)'
          : sbInv.backend === 'restricted-token'
            ? 'restricted-token (Win Job Object)'
            : sbInv.sandboxed
              ? sbInv.backend
              : 'fallback (unavailable)';
      const tier = getCurrentSandboxTier();
      let out = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      if (sbWatch.steered()) {
        /* 用户插话 → 命令是被我们杀掉的, 不是命令本身失败; 半截输出照常给模型。 */
        return formatForegroundSteered({ workspaceRoot, command }, sbOut, sbErr);
      }
      out += `▸ 工作目录: ${workspaceRoot}\n`;
      out += `▸ 执行命令: ${command}\n`;
      out += `▸ 沙箱: ${backendLabel} · ${tierLabels[tier] ?? tier}\n`;
      if (sbInv.degraded) out += `▸ ⚠ 降级: ${sbInv.degraded}\n`;
      // 沙盒下命令非0退出且断网档 → 提示可能是被沙盒拦 (写越界/网络断), 给用户方向
      if (sbExit !== 0 && tier !== 'trusted') {
        const blob = `${sbOut}${sbErr}`.toLowerCase();
        if (/operation not permitted|permission denied|access is denied|拒绝访问|could not resolve host|network is unreachable|connection refused/.test(blob)) {
          out += `▸ ⓘ 提示: 命令失败可能因沙盒限制 (写越界/密钥护栏/断网)。如需放宽, 在设置调整沙盒档位。\n`;
        }
      }
      out += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      out += sbExit === 0 ? `✓ 执行成功\n\n` : `! 退出码: ${sbExit}\n\n`;
      if (sbOut) out += `◦ stdout:\n${sbOut}\n\n`;
      if (sbErr) out += `◦ stderr:\n${sbErr}\n\n`;
      if (!sbOut && !sbErr) out += `(无输出)\n\n`;
      out += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
      return out;
    }

    /* 与后台/降级共用 shellInvocation 真源 (不再本地另写一套拼参)。 */
    const invocation = buildShellInvocation(command, shellOption);

    // env: NEOX_DISABLE_FG_ADOPT=1 / config: agentRuntime.adoptOnTimeout.enabled / default: true
    const adoptOnTimeout: boolean = isAdoptOnTimeoutEnabled();

    /* Shell 执行：默认直接 execa（本地模式），显式远程模式走 daemon。
       daemon 只在 NEOX_USE_DAEMON=1 或 remoteServer 配置时启用。 */
    let accumulatedOutput = '';
    const useDaemon = process.env.NEOX_USE_DAEMON === '1';
    let result: { stdout: string; stderr: string; exitCode: number; timedOut?: boolean; adopted?: any };

    if (useDaemon) {
      result = await runCommandViaHelper(invocation.cmd, invocation.args, workspaceRoot, {
        timeoutMs: effectiveTimeout,
        signal,
        env: services.shellEnv.getShellEnv(),
        adoptOnTimeout,
        onStreamChunk: ({ kind, data, elapsed }) => {
          accumulatedOutput += data;
          emitShellStream({ output: accumulatedOutput, outputDelta: data, elapsed, isComplete: false });
          void kind;
        },
        onBackgroundExit: adoptOnTimeout
          ? ({ pid, exitCode, stdout, stderr }) => {
              if (stdout) services.processManager.appendOutput(pid, stdout);
              if (stderr) services.processManager.appendOutput(pid, `[stderr] ${stderr}`);
              services.processManager.markCompleted(pid, exitCode);
            }
          : undefined,
      }) as any;
    } else {
      const directStart = Date.now();
      // 导致 zsh -lc 'npx tsc --noEmit; echo EXIT=$?' 变成 sh -c 'zsh -lc npx tsc --noEmit; echo EXIT=$?'
      // sh 解析后 zsh 只接到 -c npx (无参数), npx 进交互模式等 stdin → 整个 shell 调用卡死
      // 修法: buildShellInvocation 已经返回 (zsh, ['-lc', command]) 完整调用形式, 不需要再 shell: true.
      const subprocess = execa(invocation.cmd, invocation.args, {
        cwd: workspaceRoot,
        reject: false,
        timeout: effectiveTimeout,
        env: services.shellEnv.getShellEnv(),
        // stdin 显式给 'ignore', 防止意外 inherit 父进程 stdin 让 npx 类工具等输入
        stdin: 'ignore',
        /* win cmd 分支: 引号原样交给 cmd 解析 (见 ShellInvocation.windowsVerbatimArgs)。
         * 不加的话 execa 把 `"` 转义成 `\"`, cmd 不认 → 引号错乱。 */
        ...(invocation.windowsVerbatimArgs ? { windowsVerbatimArguments: true } : {}),
      } as any);
      const killTree = () => {
        if (subprocess.pid) {
          try { services.processManager.killProcessGroup(subprocess.pid, 'SIGTERM', 'user'); } catch {}
        }
      };
      if (signal) {
        if (signal.aborted) killTree();
        else signal.addEventListener('abort', killTree, { once: true });
      }
      /* 用户插话 → 让出: 杀树 + 立刻返回半截输出 (见上方 startSteeringWatch) */
      const fgWatch = startSteeringWatch(killTree);
      let stdoutAcc = '';
      let stderrAcc = '';
      subprocess.stdout?.on('data', (chunk: Buffer) => {
        const text = decodeShellChunk(chunk);
        stdoutAcc += text;
        accumulatedOutput += text;
        emitShellStream({ output: accumulatedOutput, outputDelta: text, elapsed: Math.floor((Date.now() - directStart) / 1000), isComplete: false });
      });
      subprocess.stderr?.on('data', (chunk: Buffer) => {
        const text = decodeShellChunk(chunk);
        stderrAcc += text;
        accumulatedOutput += text;
        emitShellStream({ output: accumulatedOutput, outputDelta: text, elapsed: Math.floor((Date.now() - directStart) / 1000), isComplete: false });
      });
      const r = await subprocess.finally(() => {
        signal?.removeEventListener('abort', killTree);
        fgWatch.stop();
      });
      const exitCode = resolveExecaExitCode(r as any);
      /* 流式监听是 UI 真源; result.stdout 在部分 execa/消费组合下会空,
       * 若只信 r.stdout 会误报 empty_output / SUCCESS。优先用累加器。 */
      const finalStdout = stdoutAcc || r.stdout || '';
      const finalStderr = stderrAcc || r.stderr || '';
      emitShellStream({
        output: accumulatedOutput || `${finalStdout}${finalStderr}`,
        elapsed: Math.floor((Date.now() - directStart) / 1000),
        isComplete: true,
        exitCode,
      });
      result = { stdout: finalStdout, stderr: finalStderr, exitCode, timedOut: (r as any).timedOut };
      if (fgWatch.steered()) {
        /* 用户插话 → 命令是被我们杀掉的, 不是命令本身失败: 如实说明 + 带上已产出的半截输出。 */
        return formatForegroundSteered({ workspaceRoot, command }, finalStdout, finalStderr);
      }
    }

    if (result.adopted) {
      const { pid, initialStdout, initialStderr, timeoutMs: adoptedTimeoutMs } = result.adopted;
      services.processManager.register({
        pid,
        command,
        cwd: workspaceRoot,
        workspaceRoot,
        background: true,
      });
      // 种下初始 output 快照
      if (initialStdout) services.processManager.appendOutput(pid, initialStdout);
      if (initialStderr) services.processManager.appendOutput(pid, `[stderr] ${initialStderr}`);
      // 绑定 pid ↔ 当前 agentLoop session
      const notifier = getBackgroundTaskNotifier();
      notifier.attach(services.processManager);
      notifier.trackPid(pid, command);

      emitShellStream({
        output: `${initialStdout || ''}${initialStderr || ''}`,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        isComplete: true,
        exitCode: undefined,
      });
      const timeoutSec = Math.round(adoptedTimeoutMs / 1000);
      return `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
▸ 工作目录: ${workspaceRoot}
▸ 执行命令: ${command}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⏳ 命令运行超过 ${timeoutSec} 秒,已自动转为后台继续跑
• 后台进程 PID: ${pid}
• 初始输出已记录,完整 stdout/stderr 会在进程结束后累加到 bash_output 缓冲

🔔 进程结束时你会收到 <background-task-notification pid=${pid}>,届时可以:
- 用 bash_output({pid: ${pid}}) 查看完整输出
- 用 bash_kill({pid: ${pid}}) 提前终止

💡 现在继续其它工作,不要 sleep 轮询。
${initialStdout ? `\n◦ 前 ${timeoutSec}s 输出:\n${initialStdout}` : ''}
${initialStderr ? `\n◦ 前 ${timeoutSec}s stderr:\n${initialStderr}` : ''}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    }

    const stdout = result.stdout || '';
    const stderr = result.stderr || '';
    const exitCode = result.exitCode ?? 0;

    emitShellStream({
      output: `${stdout}${stderr}`,
      elapsed: Math.floor((Date.now() - startTime) / 1000),
      isComplete: true,
      exitCode,
    });

    /* 简洁风 — 卡片头部已显示命令, 输出只贴 stdout/stderr 原文.
       不画 ━━━ 分隔条, 不写"工作目录/执行命令/标准输出"这种重复装饰. exit code 非 0 时
       才单行标注; stderr 用 [stderr] tag 跟 stdout 区分. */
    let output = '';
    if (stdout) output += stdout;
    if (stderr) {
      if (stdout && !stdout.endsWith('\n')) output += '\n';
      output += stdout ? `[stderr]\n${stderr}` : stderr;
    }
    if (!stdout && !stderr) output += '(no output)';
    if (exitCode !== 0) {
      if (output && !output.endsWith('\n')) output += '\n';
      const sem = classifyShellResult(command, exitCode);
      // grep 退出 1 / diff 退出 1 这类是 "命令工作正常 + 任务成功"
      // 给 LLM 标 [exit 1 / no_match / SUCCESS] 不要被数字骗
      if (sem.semantics) {
        const tag = sem.success ? 'SUCCESS' : 'FAILURE';
        output += `\n[exit ${exitCode} / ${sem.semantics} / ${tag}]`;
        if (sem.semanticsHint) {
          output += `\n[hint] ${sem.semanticsHint}`;
        }
      } else {
        output += `\n[exit ${exitCode}]`;
      }
    } else if (!stdout && !stderr) {
      // 否则 agent 收到 '(no output)' 完全无法判断成功/失败, 极易 hallucinate
      output += `\n[exit 0 / empty_output / SUCCESS]`;
    }

    output += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    return output;
  } catch (error: any) {
    emitShellStream({
      output: `${error?.stdout || ''}${error?.stderr || ''}`,
      elapsed: 0,
      isComplete: true,
      exitCode: typeof error?.exitCode === 'number' ? error.exitCode : -1,
    });

    if (error?.timedOut || error?.message?.includes('timeout')) {
      return formatForegroundTimeout({ workspaceRoot, command }, timeoutMs);
    }

    return formatForegroundFailed(
      { workspaceRoot, command },
      error.message,
      error.stdout,
      error.stderr,
    );
  }
}
