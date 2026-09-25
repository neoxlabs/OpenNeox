
type ShellCommandContext = {
  workspaceRoot: string;
  command: string;
};

export function formatSandboxCommandBlocked(baseCmd: string, safeCommands: string[]): string {
  return `Sandbox blocked: ${baseCmd}\nAllowed: ${safeCommands.join(', ')}`;
}

export function formatSandboxGitSubcommandBlocked(detail: string): string {
  return `Sandbox blocked: ${detail}\nDestructive git subcommands are not allowed in sandbox mode (read-only git like status/log/diff is fine).`;
}

export function formatTerminalUiResult(
  _context: ShellCommandContext,
  output: string,
  exitCode: number
): string {
  const displayOutput = output.length > 10000
    ? output.slice(0, 10000) + '\n... (truncated)'
    : output;
  const trailer = exitCode === 0 ? '' : `\n[exit ${exitCode}]`;
  return (displayOutput || '(no output)') + trailer;
}

export function formatBackgroundProcessDuplicate(
  _context: ShellCommandContext,
  existingProcessPid: number,
  runtimeSeconds: number,
  backgroundCount: number
): string {
  return [
    `Already running in background.`,
    `pid=${existingProcessPid} · uptime ${runtimeSeconds}s · total ${backgroundCount}`,
    ``,
    `bash_output(pid=${existingProcessPid}) — read its stdout`,
    `bash_kill(pid=${existingProcessPid}) — terminate before re-running`,
  ].join('\n');
}


export function formatBackgroundProcessStarted(
  _context: ShellCommandContext,
  pid: number | undefined,
  _backgroundCount: number,
  _collectSeconds: number,
  fullOutput: string
): string {
  const trimmed = fullOutput.length > 3000
    ? fullOutput.slice(0, 3000) + '\n... (truncated)'
    : fullOutput;
  const body = trimmed.trim();
  const marker = pid !== undefined
    ? `[bg pid=${pid} · still running · bash_output(${pid}) to read · bash_kill(${pid}) to stop]`
    : `[bg started · still running]`;
  return body.length > 0 ? `${body}\n\n${marker}` : marker;
}

export function formatBackgroundProcessCompleted(
  _context: ShellCommandContext,
  pid: number | undefined,
  exitCode: number | undefined,
  fullOutput: string,
): string {
  const trimmed = fullOutput.length > 3000
    ? fullOutput.slice(0, 3000) + '\n... (truncated)'
    : fullOutput;
  const body = trimmed.trim();
  const pidStr = pid !== undefined ? `pid=${pid} ` : '';
  const exitStr = exitCode !== undefined ? `exit=${exitCode}` : 'exited';
  const marker = `[bg ${pidStr}${exitStr}]`;
  return body.length > 0 ? `${body}\n\n${marker}` : marker;
}

export function formatCommandInterrupted(_context: ShellCommandContext): string {
  return `Interrupted by user.`;
}

/**
 * 用户在命令执行中"立即插话" → 我们主动把这条命令杀了 (见 foregroundShellExecution 的 steering watch)。
 *
 * 必须跟"命令自己失败/超时"区分开: 否则模型会把半截输出当成完整结果去解读,
 * 也不知道自己为什么突然拿到了被截断的 stdout。
 */
export function formatForegroundSteered(
  _context: ShellCommandContext,
  stdout?: string,
  stderr?: string,
): string {
  const parts: string[] = ['Interrupted by user (steering): the running command was killed before it finished.'];
  if (stdout && stdout.trim()) parts.push('', stdout.trimEnd());
  if (stderr && stderr.trim()) parts.push('', '[stderr]', stderr.trimEnd());
  return parts.join('\n');
}

export function formatBackgroundStartFailed(_context: ShellCommandContext, message: string): string {
  return `Background start failed: ${message}`;
}

export function formatServiceAlreadyRunning(
  _context: ShellCommandContext,
  existingPid: number,
  port: number,
  existingCommand: string,
  tracked: boolean,
): string {
  const lines = [
    `⚠️ Port ${port} already in use by pid=${existingPid}`,
    `  command: ${existingCommand.length > 100 ? existingCommand.slice(0, 100) + '...' : existingCommand}`,
    `  tracked: ${tracked ? 'yes (Neox managed)' : 'no (external process)'}`,
    ``,
  ];
  if (tracked) {
    lines.push(
      `This service is already under your management:`,
      `  bash_output(pid=${existingPid}) — read its output`,
      `  bash_kill(pid=${existingPid}) — stop it before re-running`,
    );
  } else {
    lines.push(
      `This service was started outside Neox. Options:`,
      `  1. service_adopt(pid=${existingPid}) — take over management (attach mode)`,
      `  2. service_adopt(pid=${existingPid}, mode="restart") — kill & re-launch under Neox`,
      `  3. bash_kill won't work until you adopt it first`,
    );
  }
  return lines.join('\n');
}

export function formatForegroundTimeout(
  context: ShellCommandContext,
  timeoutMs?: number,
): string {
  const timeoutSec = Math.round((timeoutMs ?? 120_000) / 1000);
  return [
    `Timed out after ${timeoutSec}s.`,
    ``,
    `Recommended next step: re-run with background=true so you can poll output without blocking:`,
    `  {"command": "${context.command}", "background": true}`,
    `→ then bash_output(pid) to read, bash_kill(pid) to stop.`,
    `On exit, <background-task-notification> arrives automatically — do not sleep+retry.`,
  ].join('\n');
}

export function formatForegroundFailed(
  _context: ShellCommandContext,
  message: string,
  stdout?: string,
  stderr?: string
): string {
  const parts: string[] = [`Failed: ${message}`];
  if (stdout && stdout.trim()) parts.push(``, stdout);
  if (stderr && stderr.trim()) parts.push(``, `[stderr]`, stderr);
  return parts.join('\n');
}
