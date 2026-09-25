import os from 'node:os';
import path from 'node:path';
import { ToolCategory, SandboxMode } from '../types/permissions.js';
import { getCurrentSandboxMode } from './sandboxMode.js';
import { isSensitivePath } from './sensitivePaths.js';

export type ToolRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type ToolRiskSignalDomain = 'shell' | 'sql' | 'path' | 'tool' | 'sandbox';

export interface ToolRiskSignal {
  code: string;
  domain: ToolRiskSignalDomain;
  level: ToolRiskLevel;
  message: string;
  evidence?: string;
}

export interface ToolRiskAssessment {
  level: ToolRiskLevel;
  signals: ToolRiskSignal[];
  summary: string;
}

interface EvaluateToolRiskInput {
  toolName: string;
  args: Record<string, any>;
  category?: ToolCategory;
  workspaceRoot?: string;
  /**
   * Sandbox mode 上下文. 不传则读 getCurrentSandboxMode() 全局状态.
   * READ_ONLY 模式下任何非 READ 类工具 → 注入 critical 'sandbox:read-only-violation' signal.
   */
  sandboxMode?: SandboxMode;
}

type ShellRiskRule = {
  code: string;
  level: ToolRiskLevel;
  pattern: RegExp;
  message: string;
};

/**
 * Shell 安全规则覆盖系统破坏、代码执行和跨平台危险命令。
 */
const SHELL_RISK_RULES: ShellRiskRule[] = [
  // === Critical: 系统破坏 ===
  /* 递归删除只有命中根目录、主目录、当前目录或系统顶级目录时才是 critical；
   * 普通递归删除保持 high，避免把常规构建清理误判为灾难级操作。 */
  { code: 'shell:rm-root', level: 'critical', pattern: /\brm\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*r[a-zA-Z]*\s+(?:-[a-zA-Z]+\s+)*["']?(?:\/|~\/?|\.\/?|\.\.\/?)["']?\s*(?:$|[;&|)>])/i, message: 'recursive delete of filesystem root / home / current directory itself' },
  { code: 'shell:rm-system-dir', level: 'critical', pattern: /\brm\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*r[a-zA-Z]*\s+(?:-[a-zA-Z]+\s+)*["']?\/(?:etc|usr|bin|sbin|var|boot|opt|srv|System|Library|Applications|Users|home)\/?["']?\s*(?:$|[;&|)>])/i, message: 'recursive delete of top-level system directory' },
  { code: 'shell:rm-no-preserve-root', level: 'critical', pattern: /\brm\b[^\n]*--no-preserve-root/i, message: 'rm with --no-preserve-root' },
  { code: 'shell:rm-root-wildcard', level: 'critical', pattern: /\brm\s+[^\n;|&]*\s["']?\/\*/i, message: 'recursive delete of root-level wildcard' },
  { code: 'shell:rm-recursive', level: 'high', pattern: /\brm\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*r/i, message: 'recursive delete' },
  { code: 'shell:mkfs', level: 'critical', pattern: /\bmkfs(\.[a-z0-9_]+)?\b/i, message: 'filesystem format command' },
  { code: 'shell:dd-device', level: 'critical', pattern: /\bdd\b[^\n]*\bof=\/dev\/[a-z0-9/_-]+/i, message: 'raw write to /dev device' },
  { code: 'shell:fork-bomb', level: 'critical', pattern: /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\};\s*:/, message: 'fork bomb pattern' },
  { code: 'shell:curl-pipe-shell', level: 'critical', pattern: /\b(curl|wget)\b[^\n|]*\|\s*(sh|bash|zsh|python|node|ruby|perl)\b/i, message: 'download and execute pipeline' },

  // === Critical: 代码执行入口 ===
  /* eval 从 critical 降 high : `eval "$(ssh-agent)"` / nvm init 等日常模式
   * 会被误伤; eval 真正的危险载荷 (curl|sh / base64 解码执行) 有独立规则兜底. */
  { code: 'shell:eval', level: 'high', pattern: /\beval\s+["'`$]/i, message: 'eval with dynamic content' },
  /* sudo + rm 曾经一律 critical —— 但 `sudo rm -rf /tmp/build-cache` 这种日常清理跟
   * "删系统目录"是两件事, 一刀切 critical 让 auto 档天天弹卡。按目标拆:
   * 磁盘级命令 (dd/mkfs/fdisk/wipefs) 无论目标都 critical; sudo rm 只有打在根/家/系统
   * 顶级目录上才 critical, 其余算 high (auto 仍会问, dangerous 放行)。  */
  { code: 'shell:sudo-disk', level: 'critical', pattern: /\bsudo\s+(dd|mkfs(\.[a-z0-9_]+)?|fdisk|wipefs)\b/i, message: 'privileged disk-level destructive command' },
  { code: 'shell:sudo-rm-system', level: 'critical', pattern: /\bsudo\s+rm\s+(?:-[a-zA-Z]+\s+)*["']?(?:\/|~\/?|\.\/?|\/(?:etc|usr|bin|sbin|var|boot|opt|srv|System|Library|Applications|Users|home)\/?)["']?\s*(?:$|[;&|)>])/i, message: 'privileged recursive delete of root / home / system directory' },
  { code: 'shell:sudo-rm', level: 'high', pattern: /\bsudo\s+rm\b/i, message: 'privileged delete' },

  // === High: Git 危险操作 (数据丢失) ===
  { code: 'shell:git-reset-hard', level: 'high', pattern: /\bgit\s+reset\s+--hard\b/i, message: 'git hard reset — may discard uncommitted changes' },
  { code: 'shell:git-clean-force', level: 'high', pattern: /\bgit\s+clean\b(?![^\n]*(?:-[a-zA-Z]*n|--dry-run))[^\n]*-[a-zA-Z]*f/i, message: 'git clean force — may permanently delete untracked files' },
  { code: 'shell:git-force-push', level: 'high', pattern: /\bgit\s+push\b[^\n]*(?:--force|-f)\b/i, message: 'git force push — may overwrite remote history' },
  { code: 'shell:git-branch-D', level: 'high', pattern: /\bgit\s+branch\s+(?:-D|--delete\s+--force|--force\s+--delete)\b/i, message: 'force delete branch — may lose unmerged commits' },
  { code: 'shell:git-checkout-dot', level: 'high', pattern: /\bgit\s+(checkout|restore)\s+(--\s+)?\.[ \t]*($|[;&|\n])/i, message: 'discard all working tree changes' },
  { code: 'shell:git-stash-drop', level: 'medium', pattern: /\bgit\s+stash\s+(drop|clear)\b/i, message: 'discard stashed changes permanently' },

  // === Medium: Git 安全绕过 (hooks/签名/历史改写) ===
  { code: 'shell:git-no-verify', level: 'medium', pattern: /\bgit\s+(commit|push|merge)\b[^\n]*--no-verify\b/i, message: 'skipping safety hooks (--no-verify) — investigate hook failure instead' },
  { code: 'shell:git-amend', level: 'medium', pattern: /\bgit\s+commit\b[^\n]*--amend\b/i, message: 'amending commit — may rewrite published history' },
  { code: 'shell:git-no-gpg-sign', level: 'medium', pattern: /\bgit\s+(commit|tag)\b[^\n]*--no-gpg-sign\b/i, message: 'skipping GPG signature' },
  { code: 'shell:git-rebase-main', level: 'high', pattern: /\bgit\s+rebase\b[^\n]*(main|master)\b/i, message: 'rebasing onto main/master — may cause conflicts' },
  { code: 'shell:git-force-push-main', level: 'critical', pattern: /\bgit\s+push\b[^\n]*(?:--force|-f)[^\n]*\b(main|master)\b/i, message: 'force push to main/master — extremely dangerous' },

  // === High: Git 内部路径写入 (bare-repo / hook 攻击) ===
  { code: 'shell:git-internal-write', level: 'high', pattern: /\b(tee|cat|cp|mv|echo|printf)\b[^\n]*(\.git\/|hooks\/|objects\/|refs\/|HEAD\b)/i, message: 'writing to git internal path — potential hook injection' },
  { code: 'shell:git-hook-create', level: 'high', pattern: /\b(chmod\s+\+x|install\s+-m)\b[^\n]*hooks\//i, message: 'creating executable git hook' },

  // === High: 系统管理 ===
  { code: 'shell:shutdown', level: 'high', pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, message: 'system shutdown/reboot command' },
  { code: 'shell:kill-all', level: 'high', pattern: /\b(killall|pkill)\s+/i, message: 'mass process termination' },
  { code: 'shell:chmod-777', level: 'high', pattern: /\bchmod\s+[0-7]*7[0-7]*\b/i, message: 'overly permissive file mode' },
  { code: 'shell:chown-root', level: 'high', pattern: /\bchown\s+root\b/i, message: 'ownership change to root' },

  // === High: 网络/权限提升 ===
  { code: 'shell:ssh-exec', level: 'high', pattern: /\bssh\s+[^\n]+['"]/i, message: 'remote command execution via SSH' },
  { code: 'shell:docker-privileged', level: 'high', pattern: /\bdocker\s+run\s+[^\n]*--privileged\b/i, message: 'privileged Docker container' },
  { code: 'shell:sudo-su', level: 'high', pattern: /\b(sudo\s+su|sudo\s+-i|sudo\s+-s)\b/i, message: 'privilege escalation' },

  // === Medium: 包管理器全局安装 ===
  { code: 'shell:npm-global', level: 'medium', pattern: /\bnpm\s+install\s+-g\b/i, message: 'global npm package install' },
  { code: 'shell:pip-install', level: 'medium', pattern: /\bpip3?\s+install\b[^\n]*(?!--user)/i, message: 'pip install (may affect system)' },

  // === Medium: 数据丢失风险 ===
  { code: 'shell:truncate', level: 'medium', pattern: />\s*(\/|~\/)[^\s]+/i, message: 'output redirection to absolute path (may truncate)' },
  { code: 'shell:mv-force', level: 'medium', pattern: /\bmv\s+-f\b/i, message: 'force move (no confirmation)' },

  // === Medium: 编码执行 ===
  { code: 'shell:python-c', level: 'medium', pattern: /\b(python3?|node|ruby|perl)\s+-[ce]\s+['"`]/i, message: 'inline code execution' },
  { code: 'shell:base64-decode-exec', level: 'high', pattern: /\bbase64\s+(-d|--decode)\b[^\n]*\|\s*(sh|bash|python|node)\b/i, message: 'base64 decode and execute' },

  // === Medium: 环境变量泄露 ===
  { code: 'shell:env-dump', level: 'medium', pattern: /\b(env|printenv|set)\s*(\||>)/i, message: 'environment variable dump to pipe/file' },
  { code: 'shell:history-access', level: 'medium', pattern: /\bcat\s+[^\n]*\.(bash_|zsh_)?history\b/i, message: 'shell history access' },
];

const SQL_DDL_PATTERN = /\b(DROP\s+(DATABASE|SCHEMA|TABLE)|TRUNCATE\s+TABLE)\b/i;
const SQL_DELETE_PATTERN = /^\s*DELETE\s+FROM\b/i;
const SQL_UPDATE_PATTERN = /^\s*UPDATE\s+\S+\s+SET\b/i;

const RISK_PRIORITY: Record<ToolRiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function maxRiskLevel(signals: ToolRiskSignal[]): ToolRiskLevel {
  let level: ToolRiskLevel = 'low';
  for (const signal of signals) {
    if (RISK_PRIORITY[signal.level] > RISK_PRIORITY[level]) {
      level = signal.level;
    }
  }
  return level;
}

function getWorkspaceRoot(workspaceRoot?: string): string {
  const root = workspaceRoot || process.env.NEOX_WORKDIR || process.cwd();
  return path.resolve(root);
}

function resolveRiskPath(rawPath: string, workspaceRoot: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) return workspaceRoot;
  if (trimmed.startsWith('~/')) {
    return path.resolve(path.join(os.homedir(), trimmed.slice(2)));
  }
  return path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(workspaceRoot, trimmed);
}

function isPathOutsideWorkspace(rawPath: string, workspaceRoot: string): boolean {
  const absolutePath = resolveRiskPath(rawPath, workspaceRoot);
  const relative = path.relative(workspaceRoot, absolutePath);
  return relative !== '' && (relative.startsWith('..') || path.isAbsolute(relative));
}

/* Shell 启动/初始化文件 — 写入 = 下次开 shell 即代码执行 (持久化 RCE 向量)。
 *  安全闸门修复: 这些文件的写入在无人值守 (Auto/子 Agent) 路径必须拦下
 * 让模型转 ask_user; 有人值守走 ASK。不进敏感路径硬 deny 名单 — 用户显式要求
 * "帮我改 zshrc" 是合法场景 (pathHelpers.ts 的历史产品决策), 只是不能静默发生。 */
const SHELL_INIT_BASENAMES = new Set([
  '.zshrc', '.zprofile', '.zshenv', '.zlogin',
  '.bashrc', '.bash_profile', '.bash_login', '.profile',
  'config.fish',
]);

function isShellInitFile(rawPath: string, workspaceRoot: string): boolean {
  const absolutePath = resolveRiskPath(rawPath, workspaceRoot);
  return SHELL_INIT_BASENAMES.has(path.basename(absolutePath).toLowerCase());
}

// ============================================================================
// 路径验证攻击防护。
// ============================================================================

/**
 * 检测路径遍历攻击 (../ 序列)
 */
export function containsPathTraversal(rawPath: string): boolean {
  const normalized = rawPath.replace(/\\/g, '/');
  // 检测 ../ 序列（包括编码变体）
  return /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(normalized)
    || normalized.includes('%2e%2e')
    || normalized.includes('%2E%2E');
}

/**
 * 检测 Windows UNC 路径注入 (\\server\share)
 * 可能导致 SMB 凭据泄露
 */
export function containsVulnerableUncPath(rawPath: string): boolean {
  return /^\\\\[^\\]+\\/.test(rawPath) || /^\/\/[^/]+\//.test(rawPath);
}

/**
 * 从 glob 模式提取基础目录（用于权限验证）
 * "src/** /*.ts" → "src"
 * "/tmp/*.log" → "/tmp"
 */
export function getGlobBaseDirectory(globPattern: string): string {
  const parts = globPattern.replace(/\\/g, '/').split('/');
  const baseParts: string[] = [];
  for (const part of parts) {
    if (part.includes('*') || part.includes('?') || part.includes('{') || part.includes('[')) {
      break;
    }
    baseParts.push(part);
  }
  return baseParts.join('/') || '.';
}

function collectPathArgs(toolName: string, args: Record<string, any>): string[] {
  if (!args || typeof args !== 'object') {
    return [];
  }

  if (toolName === 'rename_file' || toolName === 'move_file') {
    const source = args.source_path ?? args.source ?? args.from ?? args.old_path;
    const destination = args.destination_path ?? args.destination ?? args.destinationPath ?? args.to ?? args.new_path;
    return [source, destination].filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  }

  const pathKeys = [
    'file_path',
    'path',
    'filePath',
    'file',
    'target_path',
    'targetPath',
    'directory_path',
    'dir_path',
    'directory',   /* list_directory 用这个参数名 —— 敏感路径检查要覆盖到 */
  ];

  const paths: string[] = [];
  for (const key of pathKeys) {
    const candidate = args[key];
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      paths.push(candidate);
    }
  }
  return paths;
}

function extractCommand(args: Record<string, any>): string {
  const value = args.command ?? args.cmd ?? '';
  return typeof value === 'string' ? value : '';
}

/* SQL 关键字只有在命令调用数据库客户端时才参与风险判断，避免普通文本内容触发 SQL 规则。 */
const SQL_CLIENT_BINARY = /(?:^|[\s;|&(])(?:psql|mysql|mariadb|sqlite3?|mongosh?|clickhouse-client|cockroach|duckdb|pgcli|mycli|prisma|alembic|flyway)\b/i;

function extractSqlContent(toolName: string, args: Record<string, any>): string {
  const direct = args.query ?? args.sql ?? args.statement;
  if (typeof direct === 'string' && direct.trim().length > 0) {
    return direct;
  }
  if (toolName === 'execute_shell') {
    const command = extractCommand(args);
    return SQL_CLIENT_BINARY.test(command) ? command : '';
  }
  return '';
}

/**
 * 把 computer_run 的脚本压成一行给审批卡看。
 *
 * 审批的价值全在"人能看懂它要干什么"。只显示 "computer_run (8 步)" 等于让人闭着眼点同意,
 * 所以这里把每一步的动作和目标都摊开。
 * 超过 8 步截断 —— 卡片是回执不是文档, 字太多反而没人看。
 */
function summarizeComputerSteps(steps: unknown[]): string {
  const parts = steps.slice(0, 8).map((raw) => {
    const s = (raw ?? {}) as { action?: unknown; target?: unknown; text?: unknown; key?: unknown; label?: unknown };
    const action = String(s.action ?? '?');
    if (s.label) return `${action}(${String(s.label).slice(0, 20)})`;
    if (action === 'type' || action === 'set_value') return `${action}"${String(s.text ?? '').slice(0, 24)}"`;
    if (action === 'key') return `key:${String(s.key ?? '')}`;
    if (s.target !== undefined) return `${action}#${String(s.target)}`;
    return action;
  });
  if (steps.length > 8) parts.push(`…还有 ${steps.length - 8} 步`);
  return parts.join(' · ');
}

/** 会改变站点状态的动作。只读的 (navigate/get_text/screenshot/…) 不在里面。 */
const BROWSER_INPUT_ACTIONS = new Set([
  'click', 'type', 'fill_form', 'press_key', 'select_option', 'hover', 'drag',
]);

/**
 * 把 browser_run 的脚本压成一行给审批卡看 —— 跟 computer_run 同一个理由:
 * 只显示 "browser_run (12 步)" 等于让人闭着眼点同意。
 *
 * eval 步骤**要把代码本身露出来**, 那正是要人看的东西。
 */
function summarizeBrowserSteps(steps: unknown[]): string {
  const parts = steps.slice(0, 8).map((raw) => {
    const s = (raw ?? {}) as { action?: unknown; args?: unknown; label?: unknown };
    const action = String(s.action ?? '?');
    const a = (s.args ?? {}) as Record<string, unknown>;
    if (action === 'eval') return `eval:${String(a.expression ?? a.script ?? a.code ?? '').slice(0, 60)}`;
    if (action === 'navigate') return `open ${String(a.url ?? '').slice(0, 48)}`;
    if (s.label) return `${action}(${String(s.label).slice(0, 20)})`;
    const target = a.selector ?? a.text ?? a.name ?? a.key ?? '';
    return target ? `${action} ${String(target).slice(0, 28)}` : action;
  });
  if (steps.length > 8) parts.push(`…还有 ${steps.length - 8} 步`);
  return parts.join(' · ');
}

function evaluateShellRisks(command: string): ToolRiskSignal[] {
  if (!command.trim()) {
    return [];
  }
  const signals: ToolRiskSignal[] = [];
  for (const rule of SHELL_RISK_RULES) {
    if (rule.pattern.test(command)) {
      signals.push({
        code: rule.code,
        domain: 'shell',
        level: rule.level,
        message: rule.message,
        evidence: command.slice(0, 200),
      });
    }
  }
  return signals;
}

/* DB 客户端会用 psql -c、mysql -e 或同类参数包装 SQL；匹配前先剥掉这层包装。 */
const SQL_CLI_WRAPPER = /^\s*\S*\b(?:psql|mysql|mariadb|sqlite3?|mongo(?:sh)?|clickhouse-client|cockroach|duckdb)\b[^"'`]*(?:-{1,2}(?:c|e|eval|command|query)\b)?[^"'`]*["'`]?/i;

/** 剥掉 DB 客户端包装 + 首尾引号, 拿到裸 SQL 语句 */
function unwrapSqlStatement(segment: string): string {
  let s = segment.trim();
  const stripped = s.replace(SQL_CLI_WRAPPER, '');
  /* 只在确实剥掉了东西、且剩余部分非空时采用 —— 避免把裸 SQL 自己吃掉 */
  if (stripped.trim() && stripped.length < s.length) s = stripped.trim();
  return s.replace(/^["'`]+/, '').replace(/["'`]+$/, '').trim();
}

function evaluateSqlRisks(sqlText: string): ToolRiskSignal[] {
  if (!sqlText.trim()) {
    return [];
  }
  const statements = sqlText
    .split(';')
    .map((segment) => unwrapSqlStatement(segment))
    .filter(Boolean);
  const signals: ToolRiskSignal[] = [];

  for (const statement of statements) {
    if (SQL_DDL_PATTERN.test(statement)) {
      signals.push({
        code: 'sql:ddl-destructive',
        domain: 'sql',
        level: 'critical',
        message: 'destructive DDL statement detected',
        evidence: statement.slice(0, 200),
      });
      continue;
    }
    if (SQL_DELETE_PATTERN.test(statement) && !/\bWHERE\b/i.test(statement)) {
      signals.push({
        code: 'sql:delete-no-where',
        domain: 'sql',
        level: 'high',
        message: 'DELETE without WHERE clause',
        evidence: statement.slice(0, 200),
      });
      continue;
    }
    if (SQL_UPDATE_PATTERN.test(statement) && !/\bWHERE\b/i.test(statement)) {
      signals.push({
        code: 'sql:update-no-where',
        domain: 'sql',
        level: 'high',
        message: 'UPDATE without WHERE clause',
        evidence: statement.slice(0, 200),
      });
    }
  }
  return signals;
}

export function isHighRiskLevel(level: ToolRiskLevel): boolean {
  return level === 'high' || level === 'critical';
}

export function evaluateToolRisk(input: EvaluateToolRiskInput): ToolRiskAssessment {
  const { toolName, args, category } = input;
  const normalizedArgs = args && typeof args === 'object' ? args : {};
  const workspaceRoot = getWorkspaceRoot(input.workspaceRoot);
  const signals: ToolRiskSignal[] = [];

  /* Sandbox 硬约束 — 最高优先级, 早于其它规则.
   * READ_ONLY 下任何非 READ 类工具 (有 category 才能判断) → 注入 critical signal.
   * 上层 guardrail 看 level=critical 会 raiseException 拒, 不进 approval / risk 升级链. */
  const sandboxMode = input.sandboxMode ?? getCurrentSandboxMode();
  if (sandboxMode === SandboxMode.READ_ONLY && category && category !== ToolCategory.READ) {
    signals.push({
      code: 'sandbox:read-only-violation',
      domain: 'sandbox',
      level: 'critical',
      message: `Sandbox is read-only — tool "${toolName}" (category=${category}) is blocked`,
      evidence: `sandbox=${sandboxMode}, category=${category}`,
    });
  }

  if (toolName === 'delete_file') {
    signals.push({
      code: 'tool:delete-file',
      domain: 'tool',
      level: 'high',
      message: 'delete_file is destructive by default',
    });
  }

  if (toolName === 'execute_shell' || category === 'execute') {
    signals.push(...evaluateShellRisks(extractCommand(normalizedArgs)));
  }

  /* computer_run —— OS 级 GUI 操作, 一律 high。
   *
   * 为什么不能按内容分级: 鼠标点击不像 shell 命令能静态判风险。"点第 7 个按钮"可能是
   * 关个窗口, 也可能是转账、发消息、删邮件 —— 从参数上根本看不出来, 而且同一个编号在
   * 不同界面指的是不同东西。既然分不出, 就整体按 high 给, 让审批卡把脚本逐条列给人看,
   * 由人来判。
   *
   * 落到三档上的效果 (见 PermissionManager.resolveEffectivePermission 的判定顺序):
   *   dangerous → 放行 (用户明确要无人托管, high 也不弹)
   *   auto      → **弹卡** (auto 的语义是"除了危险命令都自动跑", 这条正是危险的那类)
   *   manual    → 弹卡
   * 感知类的 computer_snapshot / computer_check_access 是只读, 不在这儿加信号。 */
  if (toolName === 'computer_run') {
    const steps = Array.isArray((normalizedArgs as { steps?: unknown }).steps)
      ? (normalizedArgs as { steps: unknown[] }).steps : [];
    const app = String((normalizedArgs as { app?: unknown }).app ?? '前台应用');
    signals.push({
      code: 'tool:computer-use',
      domain: 'tool',
      level: 'high',
      /* 不带工具名 —— 这句话会原样出现在审批卡上给人看, 「computer_run」对用户是黑话 */
      message: `会真的操作「${app}」的界面, 跟你自己点鼠标一样 (${steps.length} 步)`,
      /* 证据里带上动作序列 —— 审批卡上要让人看清它到底要点什么, 而不是只看到一个工具名 */
      evidence: summarizeComputerSteps(steps),
    });
  }

  /* browser_run —— 浏览器脚本。**按内容分级, 不像 computer_run 那样一律 high。**
   *
   * 为什么不一律 high: 浏览器脚本绝大多数是只读浏览 (导航/读文本/截图), 全 high 会让
   * auto 档每跑一段就弹一次卡, 结果是用户把整条闸关掉 —— 跟敏感名单一刀切同一个下场。
   * 为什么也不能全不管 (改之前就是全不管): 脚本跑在用户**已登录**的浏览器里, 能转账、
   * 能删邮件、能发消息; 而 eval 一步就能把 cookie / localStorage 读出来发走。
   *
   * 分级判据是能从参数上静态看出来的那两条:
   *   eval        → high    任意 JS, 跟 execute_shell 同类 (auto 档会弹卡)
   *   输入类动作  → medium 点击/打字/提交, 会改变站点状态 (auto 放行, manual 会弹,
   *                         但证据进卡片 —— 人要看得见它到底点了什么)
   *   纯只读      → 不加信号
   */
  if (toolName === 'browser_run') {
    const steps = Array.isArray((normalizedArgs as { steps?: unknown }).steps)
      ? (normalizedArgs as { steps: unknown[] }).steps : [];
    const actions = steps.map((s) => String((s as { action?: unknown })?.action ?? '').toLowerCase());
    const evidence = summarizeBrowserSteps(steps);
    if (actions.includes('eval')) {
      signals.push({
        code: 'tool:browser-eval',
        domain: 'tool',
        level: 'high',
        /* 这句话原样出现在审批卡上给人看, 别写工具名黑话 */
        message: `会在网页里执行一段自己写的 JavaScript (共 ${steps.length} 步) —— 它能读到你在这个站点的登录态`,
        evidence,
      });
    } else if (actions.some((a) => BROWSER_INPUT_ACTIONS.has(a))) {
      signals.push({
        code: 'tool:browser-input',
        domain: 'tool',
        level: 'medium',
        message: `会在你已登录的浏览器里点按/填写 (共 ${steps.length} 步)`,
        evidence,
      });
    }
  }

  /* browser_replay —— 跑一段**录好的**脚本。步骤在磁盘上, 参数里只有一个名字,
   * 所以静态看不到它要干什么 —— 正因为看不到, 不能当成"没风险"。
   * 给 medium: auto 放行 (复跑本来就是为了省事), manual/审批卡会写明是哪一份录制。 */
  if (toolName === 'browser_replay' && (normalizedArgs as { name?: unknown }).name) {
    signals.push({
      code: 'tool:browser-replay',
      domain: 'tool',
      level: 'medium',
      message: `会复跑一段录好的浏览器操作「${String((normalizedArgs as { name: unknown }).name)}」`,
      evidence: '步骤存在 ~/.neox/skills/ 下的 SKILL.md 里, 可以打开看',
    });
  }

  /* SQL 风险只对 execute_shell 检—— execute_sql / run_query 这两个名字曾经列在这里,
   * 但全仓从来没有注册过同名工具。留着名字的后果是模型以为有这个能力去调, 拿到的却是
   * "not in the current toolset (mode-restricted or not fetched)", 那句话还教它去
   * tool_search 找替代 —— 找不到, 白烧一轮。数据库操作走 execute_shell。 */
  if (toolName === 'execute_shell') {
    signals.push(...evaluateSqlRisks(extractSqlContent(toolName, normalizedArgs)));
  }

  /* 不再单靠 category (调用方常不传) — 常见 mutation 工具名直接纳入,
   * 否则 write_file/edit 的路径风险检查在无 category 的调用点整体失效。 */
  const isMutationToolName = /^(write_file|write|edit|edit_file|multi_edit|create_file|append_file|delete_file|rename_file|move_file)$/i.test(toolName);
  if (category === 'write' || isMutationToolName) {
    const writablePaths = collectPathArgs(toolName, normalizedArgs);
    for (const candidate of writablePaths) {
      if (isPathOutsideWorkspace(candidate, workspaceRoot)) {
        signals.push({
          code: 'path:outside-workspace',
          domain: 'path',
          level: 'high',
          message: `path outside workspace: ${candidate}`,
          evidence: candidate,
        });
      }
      /* shell rc 写入 = 持久化代码执行向量, 升 critical (无人值守硬拦, 有人值守 ASK) */
      if (isShellInitFile(candidate, workspaceRoot)) {
        signals.push({
          code: 'path:shell-init-write',
          domain: 'path',
          level: 'critical',
          message: `write to shell init file (persistent code-execution vector): ${candidate}`,
          evidence: candidate,
        });
      }
      // 路径遍历攻击检测
      if (containsPathTraversal(candidate)) {
        signals.push({
          code: 'path:traversal-attack',
          domain: 'path',
          level: 'high',
          message: `path traversal detected: ${candidate}`,
          evidence: candidate,
        });
      }
      // UNC 路径注入检测
      if (containsVulnerableUncPath(candidate)) {
        signals.push({
          code: 'path:unc-injection',
          domain: 'path',
          level: 'critical',
          message: `UNC path injection (SMB credential leak risk): ${candidate}`,
          evidence: candidate,
        });
      }
    }
  }

  /* 敏感路径覆盖凭据存储和可执行配置；读写都记录为 critical 风险信号。 */
  {
    const candidates = [...collectPathArgs(toolName, normalizedArgs)];
    if (typeof normalizedArgs.cwd === 'string' && normalizedArgs.cwd.trim()) candidates.push(normalizedArgs.cwd);
    for (const candidate of candidates) {
      if (isSensitivePath(resolveRiskPath(candidate, workspaceRoot))) {
        signals.push({
          code: 'path:sensitive',
          domain: 'path',
          level: 'critical',
          message: `touches a sensitive location (credentials / executable config): ${candidate}`,
          evidence: candidate,
        });
        break;
      }
    }
  }

  const level = maxRiskLevel(signals);
  const summary = signals.length > 0
    ? signals.slice(0, 2).map((signal) => signal.message).join('; ')
    : 'No obvious high-risk signals';

  return {
    level,
    signals,
    summary,
  };
}
