/**
 * shellIntegration — 注入命令开始/结束 / cwd 跟随事件到 PTY shell, 不修改用户 dotfile.
 *
 * 策略:
 *   不动用户的 ~/.zshrc / ~/.bashrc, 而是通过启动参数注入临时 RC 文件:
 *
 *     bash:        bash --rcfile <TMP_RC>
 *     zsh:         ZDOTDIR=<TMP_DIR> zsh   (zsh 会读 $ZDOTDIR/.zshrc)
 *     fish:        fish --init-command='source <TMP_INIT>'
 *     powershell:  pwsh -File <TMP_PS1>
 *
 *   临时 RC 内部:
 *     1. source 用户原始配置 (保留 PS1 / aliases / fish_prompt)
 *     2. 注入 OSC 133 hook: 用 \e]133;A;B;C;D\a 通知 host 命令开始/结束 + exit code
 *     3. 注入 OSC 1337 hook 通知 cwd 变化
 *
 *   OSC 133 (俗称 "Final Term" 协议) 是终端生态里事实上的命令块标记标准, 主流终端都认.
 *   选它是因为它给 UI 端 (xterm.js) 提供 "命令块" 边界识别能力,
 *   能做"命令历史"、"按命令折叠/收起"、"命令耗时统计"等高级 UX.
 *
 * 用法:
 *   const integration = await installShellIntegration({ shell: '/bin/zsh', cleanupOnExit: true });
 *   spawn(integration.shell, integration.args, { env: { ...process.env, ...integration.env } });
 *   // 进程结束后 integration.cleanup() 删临时目录
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export type ShellKind = 'bash' | 'zsh' | 'fish' | 'pwsh' | 'unknown';

export interface InstallShellIntegrationResult {
  /** 实际执行的 shell 二进制 (跟入参 shell 一致, 方便调用方直接用) */
  shell: string;
  /** spawn 参数 */
  args: string[];
  /** 注入的环境变量 (合并到 process.env 给 spawn) */
  env: Record<string, string>;
  /** 探测到的 shell 类型, 调试用 */
  kind: ShellKind;
  /** 临时目录路径, 调用方进程结束后调 cleanup() 删 */
  tmpDir: string;
  /** 释放临时目录, 幂等 */
  cleanup: () => void;
}

export function detectShellKind(shellPath: string): ShellKind {
  const base = path.basename(shellPath).toLowerCase();
  if (base.includes('zsh')) return 'zsh';
  if (base.includes('bash')) return 'bash';
  if (base.includes('fish')) return 'fish';
  if (base === 'pwsh' || base === 'powershell' || base === 'powershell.exe') return 'pwsh';
  return 'unknown';
}

export interface InstallOpts {
  /** Shell 可执行路径 e.g. /bin/zsh, /usr/local/bin/fish */
  shell: string;
  /** 可选: 让 shell 启动后切到这个目录. 不传保持系统默认. */
  cwd?: string;
  /** 调用方进程结束后是否自动 cleanup 临时目录. 默认 true. */
  cleanupOnExit?: boolean;
}

export function installShellIntegration(opts: InstallOpts): InstallShellIntegrationResult {
  const kind = detectShellKind(opts.shell);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-shell-'));

  const cleanup = () => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  if (opts.cleanupOnExit !== false) {
    /* 当前 Node process 退出时尝试清掉. PTY 子进程已经死了, 临时目录不再用. */
    process.once('exit', cleanup);
  }

  switch (kind) {
    case 'zsh':   return installZsh(opts, tmpDir, cleanup);
    case 'bash':  return installBash(opts, tmpDir, cleanup);
    case 'fish':  return installFish(opts, tmpDir, cleanup);
    case 'pwsh':  return installPwsh(opts, tmpDir, cleanup);
    default:
      /* 未知 shell: 不注入, 透传, 用户至少能用. */
      return {
        shell: opts.shell,
        args: [],
        env: {},
        kind: 'unknown',
        tmpDir,
        cleanup,
      };
  }
}

/* ============================================================
 * Zsh — ZDOTDIR 策略
 *
 * zsh 启动顺序: /etc/zshenv → $ZDOTDIR/.zshenv → /etc/zshrc → $ZDOTDIR/.zshrc → ...
 *   我们写 $ZDOTDIR/.zshrc, 内部先 source 用户原始 ~/.zshrc 保留所有自定义,
 *   再 append 注入 OSC hook.
 * ============================================================ */
function installZsh(opts: InstallOpts, tmpDir: string, cleanup: () => void): InstallShellIntegrationResult {
  const rcPath = path.join(tmpDir, '.zshrc');
  const userRc = path.join(os.homedir(), '.zshrc');
  const content = `# Neox shell integration (auto-generated, do not edit)
${fs.existsSync(userRc) ? `[[ -f "${userRc}" ]] && source "${userRc}"` : ''}

# OSC 133 hook — 命令边界 + exit code
_neox_precmd() {
  local ec=$?
  printf '\\e]133;D;%d\\a' $ec
  printf '\\e]133;A\\a'
  printf '\\e]1337;CurrentDir=%s\\a' "$PWD"
}
_neox_preexec() {
  printf '\\e]133;C\\a'
}
typeset -ag precmd_functions preexec_functions
precmd_functions+=(_neox_precmd)
preexec_functions+=(_neox_preexec)

# PS1 末尾插入 prompt-end marker (133;B), 让 host 知道用户开始输入的位置
PS1=$'%{\\e]133;B\\a%}'"$PS1"
`;
  fs.writeFileSync(rcPath, content, 'utf-8');
  return {
    shell: opts.shell,
    args: ['-i'],
    env: { ZDOTDIR: tmpDir },
    kind: 'zsh',
    tmpDir,
    cleanup,
  };
}

/* ============================================================
 * Bash — --rcfile 策略
 *
 * 注意: --rcfile 跟 --login 互斥, 我们走 interactive non-login (`-i`),
 *   因为大多数 dev 场景用户在 IDE 终端期望 interactive 行为, 而不是 login shell.
 *   如果用户需要 login shell, 通过 InstallOpts 扩展 (暂不需要).
 * ============================================================ */
function installBash(opts: InstallOpts, tmpDir: string, cleanup: () => void): InstallShellIntegrationResult {
  const rcPath = path.join(tmpDir, '.bashrc');
  const userBashrc = path.join(os.homedir(), '.bashrc');
  const userProfile = path.join(os.homedir(), '.bash_profile');
  /* bash --rcfile 不会读 .bash_profile, 但 interactive non-login 也只读 .bashrc.
   * 为兼容用户配置可能放在 .bash_profile (macOS 习惯), 都 source 一下. */
  const sources = [
    fs.existsSync(userBashrc) ? `[[ -f "${userBashrc}" ]] && source "${userBashrc}"` : '',
    fs.existsSync(userProfile) ? `[[ -f "${userProfile}" ]] && source "${userProfile}"` : '',
  ].filter(Boolean).join('\n');

  const content = `# Neox shell integration (auto-generated, do not edit)
${sources}

# OSC 133 hook
_neox_precmd() {
  local ec=$?
  printf '\\e]133;D;%d\\a' "$ec"
  printf '\\e]133;A\\a'
  printf '\\e]1337;CurrentDir=%s\\a' "$PWD"
}
# Bash 没有内置 preexec — DEBUG trap 在每个命令前触发, 但要排除 prompt 本身, 用 BASH_COMMAND 守护
_neox_preexec() {
  if [[ -n "$COMP_LINE" || "$BASH_COMMAND" == "_neox_precmd" ]]; then return; fi
  printf '\\e]133;C\\a'
}
PROMPT_COMMAND="_neox_precmd\${PROMPT_COMMAND:+; \$PROMPT_COMMAND}"
trap '_neox_preexec' DEBUG

# Prompt 末尾插入 133;B marker
PS1='\\[\\e]133;B\\a\\]'"$PS1"
`;
  fs.writeFileSync(rcPath, content, 'utf-8');
  return {
    shell: opts.shell,
    args: ['--rcfile', rcPath, '-i'],
    env: {},
    kind: 'bash',
    tmpDir,
    cleanup,
  };
}

/* ============================================================
 * Fish — --init-command 策略
 * ============================================================ */
function installFish(opts: InstallOpts, tmpDir: string, cleanup: () => void): InstallShellIntegrationResult {
  const initPath = path.join(tmpDir, 'init.fish');
  const content = `# Neox shell integration (auto-generated)
function _neox_postexec --on-event fish_postexec
    printf '\\e]133;D;%d\\a' $status
    printf '\\e]133;A\\a'
    printf '\\e]1337;CurrentDir=%s\\a' "$PWD"
end
function _neox_preexec --on-event fish_preexec
    printf '\\e]133;C\\a'
end
`;
  fs.writeFileSync(initPath, content, 'utf-8');
  /* fish 的 --init-command 可重复, 用 source 把我们的 hook 注入到用户 config 之后 */
  return {
    shell: opts.shell,
    args: ['--init-command', `source ${initPath}`, '-i'],
    env: {},
    kind: 'fish',
    tmpDir,
    cleanup,
  };
}

/* ============================================================
 * PowerShell — -NoExit -File 策略
 *
 * Windows / 跨平台 pwsh 都用这套. -NoExit 让 shell 启动后保持交互.
 * ============================================================ */
function installPwsh(opts: InstallOpts, tmpDir: string, cleanup: () => void): InstallShellIntegrationResult {
  const initPath = path.join(tmpDir, 'init.ps1');
  /* PowerShell 没有 preexec / postexec hook, 但可以重写 prompt() function 拿命令边界.
   * 简化: 只在 prompt 时发 D + A marker, 不区分命令开始 C. UI 端能做命令分块仍然够用.
   * 注意: PowerShell 里 $global: / $ec 等用 $ 前缀, 跟 TS template literal ${} 互相干扰,
   * 这里用普通字符串拼接避免误解析. */
  const content = [
    '# Neox shell integration',
    '$global:__neox_orig_prompt = $function:prompt',
    'function prompt {',
    '  $ec = if ($?) { 0 } else { 1 }',
    '  [Console]::Write([char]27 + "]133;D;$ec" + [char]7)',
    '  [Console]::Write([char]27 + "]133;A" + [char]7)',
    '  [Console]::Write([char]27 + "]1337;CurrentDir=" + (Get-Location).Path + [char]7)',
    '  if ($global:__neox_orig_prompt) { & $global:__neox_orig_prompt }',
    '}',
    '',
  ].join('\n');
  fs.writeFileSync(initPath, content, 'utf-8');
  return {
    shell: opts.shell,
    args: ['-NoExit', '-File', initPath],
    env: {},
    kind: 'pwsh',
    tmpDir,
    cleanup,
  };
}
