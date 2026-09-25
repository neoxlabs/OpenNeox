/**
 * Shell invocation helper — 选 shell + arg 拼装 (FG / BG / sandbox-off 单一真源).
 *
 * Win 默认: ComSpec/cmd `/d /s /c` (与 neox-sandbox buildPlatformDirectShell 同源)
 * Win + PowerShell shellOption: 绝对路径 pwsh/powershell + -NoProfile -Command
 * *nix: $SHELL -lc
 */

import { buildPlatformDirectShell } from '@neoxlabs/sandbox';
import { findPowerShell, getWindowsShell } from '../powershell/powershellDetection.js';

export interface ShellInvocation {
  cmd: string;
  args: string[];
  windowsVerbatimArgs?: boolean;
}

/* PowerShell: 强制 stdout UTF-8 (中文 Windows 默认 GBK → utf8 解码乱码)。 */
function psUtf8(command: string): string {
  return `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;${command}`;
}
/* cmd: chcp 65001 (>nul 抑制 chcp 自身输出)。 */
function cmdUtf8(command: string): string {
  return `chcp 65001>nul & ${command}`;
}

/**
 * 把 runtime 传入的 shellOption 收成可 spawn 的绝对路径。
 * 裸 `powershell.exe` 依赖 PATH —— 打包版 / 坏 PATH 下会失败。
 */
export function resolveWindowsShellExecutable(shellOption: string): { exe: string; isPowerShell: boolean } {
  const lower = shellOption.toLowerCase();
  const isPowerShell = lower.includes('powershell') || lower.includes('pwsh');
  if (isPowerShell) {
    if (/[\\/]/.test(shellOption)) {
      return { exe: shellOption, isPowerShell: true };
    }
    const found = findPowerShell();
    if (found) return { exe: found, isPowerShell: true };
    const ws = getWindowsShell();
    if (ws?.isPowerShell) return { exe: ws.shellPath, isPowerShell: true };
    return { exe: shellOption, isPowerShell: true };
  }
  if (lower === 'cmd' || lower === 'cmd.exe' || lower.endsWith('\\cmd.exe') || lower.endsWith('/cmd.exe')) {
    return { exe: process.env.ComSpec || shellOption, isPowerShell: false };
  }
  return { exe: shellOption, isPowerShell: false };
}

/** execa reject:false 时 exitCode 可能为 null; 不得 ?? 0 伪装成功。 */
export function resolveExecaExitCode(r: {
  exitCode?: number | null;
  failed?: boolean;
  isCanceled?: boolean;
  timedOut?: boolean;
}): number {
  if (typeof r.exitCode === 'number') return r.exitCode;
  if (r.timedOut) return 124;
  if (r.failed || r.isCanceled) return 1;
  return 0;
}

/**
 * @param shellOption
 *   - string: 显式 shell (powershell 绝对路径 / cmd.exe)
 *   - true: Win 走 getWindowsShell() 偏好 (agent 环境同源)
 *   - false | undefined: Win 强制 ComSpec/cmd —— 与后台 PTY / 降级直跑一致
 */
export function buildShellInvocation(
  command: string,
  shellOption?: string | boolean,
): ShellInvocation {
  if (process.platform === 'win32') {
    if (typeof shellOption === 'string') {
      const { exe, isPowerShell } = resolveWindowsShellExecutable(shellOption);
      return isPowerShell
        ? { cmd: exe, args: ['-NoProfile', '-Command', psUtf8(command)] }
        : { cmd: exe, args: ['/d', '/s', '/c', cmdUtf8(command)], windowsVerbatimArgs: true };
    }
    if (shellOption === true) {
      const ws = getWindowsShell();
      if (ws?.isPowerShell) {
        return { cmd: ws.shellPath, args: ['-NoProfile', '-Command', psUtf8(command)] };
      }
      const d = buildPlatformDirectShell(command, { shell: ws?.shellPath });
      return { cmd: d.program, args: d.args, windowsVerbatimArgs: true };
    }
    if (shellOption === undefined) {
      const ws = getWindowsShell();
      if (ws?.isPowerShell) {
        return { cmd: ws.shellPath, args: ['-NoProfile', '-Command', psUtf8(command)] };
      }
      const dws = buildPlatformDirectShell(command, { shell: ws?.shellPath });
      return { cmd: dws.program, args: dws.args, windowsVerbatimArgs: true };
    }
    /* false: 显式要 cmd (后台降级 / 逃生门) */
    const d = buildPlatformDirectShell(command);
    return { cmd: d.program, args: d.args, windowsVerbatimArgs: true };
  }

  if (typeof shellOption === 'string') {
    return { cmd: shellOption, args: ['-lc', command] };
  }
  const d = buildPlatformDirectShell(command);
  return { cmd: d.program, args: d.args };
}
