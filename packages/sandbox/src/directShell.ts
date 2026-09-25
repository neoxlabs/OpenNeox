/**
 * Platform direct shell — 无沙盒/降级/默认 spawn 的统一拼参。
 * 零依赖, 供 neox-sandbox directInvocation 与 neox-core shellInvocation 共用。
 *
 * Win: 永远 ComSpec/cmd `/d /s /c` —— 禁止 SHELL=bash + `/c` 假成功。
 * *nix: $SHELL -lc
 */

export interface DirectShellInvocation {
  program: string;
  args: string[];
}

/**
 * @param command 用户/agent 提交的命令字符串
 * @param opts.shell 仅当明确是 cmd 时采用; 非 cmd (bash/pwsh) 在 Win 上忽略并回落 ComSpec
 */
export function buildPlatformDirectShell(
  command: string,
  opts: { shell?: string } = {},
): DirectShellInvocation {
  if (process.platform === 'win32') {
    const requested = (opts.shell || '').toLowerCase();
    const looksLikeCmd =
      !requested ||
      requested === 'cmd' ||
      requested === 'cmd.exe' ||
      requested.endsWith('\\cmd.exe') ||
      requested.endsWith('/cmd.exe');
    const program = looksLikeCmd
      ? (opts.shell || process.env.ComSpec || 'cmd.exe')
      : (process.env.ComSpec || 'cmd.exe');
    return {
      program,
      args: ['/d', '/s', '/c', command],
    };
  }
  const program = opts.shell || process.env.SHELL || '/bin/sh';
  return {
    program,
    args: ['-lc', command],
  };
}
