
import type { PlatformLogger } from '@neoxlabs/platform/platform/services.js';
import { formatSandboxCommandBlocked, formatSandboxGitSubcommandBlocked } from './executeShellMessages.js';
import { parseShellCommand, type ParsedCommand } from './shellCommandParser.js';

/** 沙盒模式白名单命令 (Unix + Windows/PowerShell) */
const SANDBOX_SAFE_COMMANDS = new Set([
  // Unix
  'ls', 'pwd', 'echo', 'cat', 'grep', 'find', 'wc', 'head', 'tail',
  'sort', 'uniq', 'diff', 'basename', 'dirname', 'realpath', 'readlink',
  'date', 'whoami', 'hostname', 'uname', 'which', 'type', 'file',
  'tr', 'cut', 'paste', 'tee', 'xargs', 'env', 'true', 'false',
  'test', '[', 'printf', 'seq', 'yes', 'tree', 'du', 'df', 'stat',
  // Windows cmd
  'dir', 'where', 'systeminfo', 'hostname.exe', 'whoami.exe',
  'ipconfig', 'netstat', 'tasklist', 'attrib', 'ver',
  // PowerShell 只读 cmdlets
  'Get-Content', 'Get-ChildItem', 'Get-Item', 'Get-Location',
  'Get-Process', 'Get-Service', 'Get-Date', 'Get-Host',
  'Test-Path', 'Select-String', 'Where-Object', 'ForEach-Object',
  'Write-Output', 'Write-Host', 'Out-String', 'Format-List', 'Format-Table',
  'Measure-Object', 'Sort-Object', 'Select-Object', 'Group-Object',
  // Cross-platform tools
  'rg', 'fd', 'git',
]);

export function validateShellCommandForSandbox(
  command: string,
  sandboxEnabled: boolean
): string | null {
  if (!sandboxEnabled) {
    return null;
  }

  const parsed = parseShellCommand(command);

  if (parsed.hasSubstitution) {
    return '🚫 沙盒模式禁止使用子命令展开 ($(...) 或反引号)';
  }

  // 逐段检查
  for (const cmd of parsed.commands) {
    const baseCmd = extractBaseCommand(cmd.base);
    if (!SANDBOX_SAFE_COMMANDS.has(baseCmd)) {
      return formatSandboxCommandBlocked(baseCmd, [...SANDBOX_SAFE_COMMANDS].slice(0, 15));
    }

    // 破坏性子命令 (reset --hard / clean -f / push -f / branch -D / checkout .)
    // 不该借白名单直跑。只影响命令级沙盒路径; 常规审批路径由 riskEvaluator 把关。
    if (baseCmd === 'git') {
      const destructive = detectDestructiveGitSubcommand(cmd.args);
      if (destructive) {
        return formatSandboxGitSubcommandBlocked(destructive);
      }
    }

    // 管道后的命令也要验证
    // (管道已被 splitCommandChain 拆成独立段，这里已自动覆盖)
  }

  return null;
}

// ============================================================================
// 沙盒下 git 破坏性子命令黑名单
// ============================================================================

/** git 带值全局选项 — 找子命令时要连它的值一起跳过 (git -C /path reset --hard) */
const GIT_GLOBAL_OPTS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

/** 剥掉 token 的引号壳 (parseShellCommand 保留引号原样) */
function stripQuotes(token: string): string {
  return token.replace(/^['"]|['"]$/g, '');
}

/**
 * 检测 git 参数里的破坏性子命令用法。
 * 命中返回可读的描述 (如 'git reset --hard'), 未命中返回 null。
 *
 * 覆盖 (与审计条目对齐, 刻意保守不扩面):
 *   reset --hard | clean -f/--force | push -f/--force* | branch -D | checkout .
 */
function detectDestructiveGitSubcommand(args: string[]): string | null {
  // 跳过全局选项定位真正的子命令 (git -C /repo push -f origin main)
  let subcommand = '';
  let rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = stripQuotes(args[i]);
    if (!token) continue;
    if (token.startsWith('-')) {
      if (GIT_GLOBAL_OPTS_WITH_VALUE.has(token)) i++; // 跳过选项值
      continue;
    }
    subcommand = token;
    rest = args.slice(i + 1).map(stripQuotes);
    break;
  }
  if (!subcommand) return null;

  // 短选项簇匹配: -f / -fd / -Df 这类组合里含目标字母即命中 (大小写敏感)
  const hasShortFlag = (letter: string) =>
    rest.some((a) => /^-[A-Za-z]+$/.test(a) && a.includes(letter));

  switch (subcommand) {
    case 'reset':
      return rest.includes('--hard') ? 'git reset --hard' : null;
    case 'clean':
      return hasShortFlag('f') || rest.includes('--force') ? 'git clean -f' : null;
    case 'push':
      // --force / --force-with-lease / --force-if-includes 一并算强推
      return hasShortFlag('f') || rest.some((a) => a === '--force' || a.startsWith('--force-'))
        ? 'git push --force'
        : null;
    case 'branch':
      return hasShortFlag('D') ? 'git branch -D' : null;
    case 'checkout':
      // checkout . / checkout -- . 丢弃全部工作区改动
      return rest.some((a) => a === '.') ? 'git checkout .' : null;
    default:
      return null;
  }
}

/**
 * 从可能带路径的命令中提取基础命令名
 * /usr/bin/git → git
 * ./scripts/deploy.sh → deploy.sh
 */
function extractBaseCommand(base: string): string {
  if (base.includes('/')) {
    return base.split('/').pop() || base;
  }
  return base;
}

// ============================================================================
// Auto-background policy — 决定哪些命令可以"超时自动转后台",以及
// 哪些看似是"等待"的命令应该被劝阻(引导 agent 用 run_in_background)
// ============================================================================

/**
 * 不允许自动后台化的命令白名单(黑名单语义)。
 * 这些命令要么是交互式的(vim/top/read),要么就是本身就是"等"的语义(sleep/wait),
 * 把它们"转后台"没意义。
 */
const DISALLOWED_AUTO_BACKGROUND_COMMANDS = new Set([
  // 纯等待语义 — 转后台无意义,应该引导 agent 重新设计调用
  'sleep', 'wait', 'read',
  // 交互式命令 — 后台化后无从交互
  'vim', 'vi', 'nano', 'emacs', 'less', 'more',
  'top', 'htop', 'btop', 'watch',
  'ssh', 'telnet', 'ftp', 'sftp',
  'mysql', 'psql', 'redis-cli', 'mongo',
  'python', 'python3', 'node', 'irb', 'bash', 'zsh', 'sh',  // REPL 入口
]);

export function isAutoBackgroundAllowed(command: string): boolean {
  const parsed = parseShellCommand(command);
  if (parsed.commands.length === 0) return true;
  // 看 chain 的第一段(通常是主命令),cd X && Y 形式里取 Y
  const first = parsed.commands[0];
  const baseCmd = extractBaseCommand(first.base);
  if (DISALLOWED_AUTO_BACKGROUND_COMMANDS.has(baseCmd)) return false;
  // 如果第一段是 cd,看第二段
  if (baseCmd === 'cd' && parsed.commands.length > 1) {
    const second = parsed.commands[1];
    const secondBase = extractBaseCommand(second.base);
    if (DISALLOWED_AUTO_BACKGROUND_COMMANDS.has(secondBase)) return false;
  }
  return true;
}

/**
 * 检测被禁止的 leading `sleep N`(N ≥ 2)模式。
 * 命中则返回错误说明;null 表示不拦截。
 *
 * 合法场景(不拦截):
 *   - `sleep 0.5`(sub-2s,纯节流)
 *   - `foo && sleep 30`(sleep 不在第一段)
 *   - `sleep $VAR`(动态,没法静态判)
 *
 * 拦截场景:
 *   - `sleep 30`(赤裸等待)
 *   - `sleep 30 && curl ...`(sleep 后再做事)
 *   - `sleep 30; cmd`
 */
export function detectBlockedSleepPattern(command: string): string | null {
  const parsed = parseShellCommand(command);
  if (parsed.commands.length === 0) return null;
  const first = parsed.commands[0];
  const baseCmd = extractBaseCommand(first.base);
  if (baseCmd !== 'sleep') return null;

  // 不该被拦. ≥ 5 才算"LLM 在搞轮询"模式, 配合外层 auto-flip-background 处理 (executeShellTool).
  const durationArg = (first.args || [])[0] ?? '';
  const secs = Number(durationArg);
  if (!Number.isInteger(secs) || secs < 5) return null;

  const tail = parsed.commands.slice(1);
  if (tail.length === 0) {
    return `sleep ${secs} with no follow-up`;
  }
  const tailPreview = tail
    .map(c => `${c.base}${(c.args || []).length ? ' ' + (c.args || []).join(' ') : ''}`)
    .join(' ; ')
    .slice(0, 80);
  return `sleep ${secs} followed by: ${tailPreview}`;
}

// ============================================================================
// 检查后台命令语法问题
// ============================================================================

/**
 * 检查后台命令语法问题
 */
export function warnBackgroundCommandSyntax(
  command: string,
  background: boolean,
  logger: PlatformLogger
): void {
  if (!background) return;

  const hasBackgroundSuffix = command.trim().endsWith('&');
  const parsed = parseShellCommand(command);

  if (hasBackgroundSuffix) {
    logger.info('SHELL', `提示: background=true 参数已经处理后台运行，无需在命令末尾添加 '&'`);
  }

  if (parsed.hasPipeline) {
    logger.warn('SHELL', `警告: 后台模式下使用管道可能导致输出截断或进程意外退出`);
  }
}

export interface CommandSegmentRisk {
  segment: ParsedCommand;
  risks: string[];
}

export function analyzeCommandChainRisks(command: string): CommandSegmentRisk[] {
  const parsed = parseShellCommand(command);
  const results: CommandSegmentRisk[] = [];

  for (const cmd of parsed.commands) {
    const risks: string[] = [];
    const base = extractBaseCommand(cmd.base);

    // 重定向到系统路径
    if (cmd.hasRedirect && cmd.redirectTarget) {
      const target = cmd.redirectTarget;
      if (target.startsWith('/etc/') || target.startsWith('/sys/') || target.startsWith('/proc/')) {
        risks.push(`redirect to system path: ${target}`);
      }
    }

    // 子命令展开 + 危险命令组合
    if (cmd.hasSubstitution && ['rm', 'dd', 'mkfs', 'chmod', 'chown'].includes(base)) {
      risks.push(`dangerous command with subshell expansion`);
    }

    // 管道到 shell（download-and-execute pattern 的结构化检测）
    if (cmd.connector === '|' && ['sh', 'bash', 'zsh', 'python', 'node', 'ruby', 'perl'].includes(base)) {
      risks.push(`pipe to shell interpreter: ${base}`);
    }

    if (isGitInternalWriteCommand(base, cmd.args)) {
      risks.push(`write to git internal path (potential hook injection)`);
    }

    if (risks.length > 0) {
      results.push({ segment: cmd, risks });
    }
  }

  return results;
}

// ============================================================================
// ============================================================================

/** 可能写入文件的命令 */
const WRITE_COMMANDS = new Set([
  'tee', 'cat', 'cp', 'mv', 'echo', 'printf', 'install',
  'touch', 'mkdir', 'ln', 'curl', 'wget', 'tar', 'unzip',
]);

/** Git 内部路径模式 */
const GIT_INTERNAL_PATTERNS = [
  /\.git\//i,
  /\.git$/i,
  /^hooks\//i,
  /\/hooks\//i,
  /^objects\//i,
  /\/objects\//i,
  /^refs\//i,
  /\/refs\//i,
  /\/HEAD$/i,
  /^HEAD$/i,
  // NTFS 8.3 短名称攻击
  /GIT~[1-4]/i,
];

/**
 * 检查命令是否在向 Git 内部路径写入
 *
 * 防御向量:
 * - bare-repo 攻击: 在 cwd 创建 HEAD + objects/ + refs/ → git 将 cwd 视为裸仓库
 * - hook injection: 向 .git/hooks/ 写入可执行脚本
 * - object corruption: 向 .git/objects/ 写入数据
 */
function isGitInternalWriteCommand(base: string, args: string[]): boolean {
  if (!WRITE_COMMANDS.has(base.toLowerCase())) return false;

  for (const arg of args) {
    const cleaned = arg.replace(/['"]/g, '').replace(/\\/g, '/');
    if (GIT_INTERNAL_PATTERNS.some(p => p.test(cleaned))) {
      return true;
    }
  }

  return false;
}
