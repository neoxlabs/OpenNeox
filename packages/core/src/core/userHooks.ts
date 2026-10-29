
import { execFile, exec } from 'child_process';
import { access, readdir, readFile } from 'fs/promises';
import { constants as fsConstants } from 'fs';
import path from 'path';
import os from 'os';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import {
  HOOK_EVENTS, isBlockingEvent, mergeHookOutcomes, parseHookOutcome,
  type HookEvent, type HookOutcome,
} from './hookProtocol.js';

// ==================== 类型定义 ====================

export type UserHookType =
  | 'pre-tool-call'
  | 'post-tool-call'
  | 'pre-session'
  | 'post-session';

export interface UserHookResult {
  /** hook 是否执行成功 */
  success: boolean;
  /** exit code */
  exitCode: number;
  /** stdout 输出 */
  stdout: string;
  /** stderr 输出 */
  stderr: string;
  /** 执行耗时 ms */
  durationMs: number;
  /** 是否阻止操作（exit 1/2） */
  blocked: boolean;
  /** 替代结果（exit 2 时的 stdout） */
  alternateResult?: string;
}

export interface UserHookContext {
  hookType: UserHookType;
  toolName?: string;
  toolArgs?: Record<string, any>;
  toolResult?: string;
  workDir: string;
  sessionId?: string;
}


export interface DeclarativeHookCommand {
  type?: 'command';
  command: string;
  /** 秒, 默认 10 */
  timeout?: number;
}

export interface DeclarativeHookEntry {
  matcher?: string;
  hooks: DeclarativeHookCommand[];
}

export type DeclarativeHookEvent = HookEvent;

export interface HookDecision {
  allow: boolean;
  reason?: string;
}

/** matcher 匹配 — 空/缺省匹配所有; 否则按不区分大小写正则; 非法正则回退精确匹配 */
export function matchesTool(matcher: string | undefined, toolName: string): boolean {
  if (!matcher || !matcher.trim()) return true;
  const m = matcher.trim();
  try {
    return new RegExp(`^(?:${m})$`, 'i').test(toolName);
  } catch {
    return m === toolName;
  }
}

/** 决策解析 — exit 2 / stdout JSON decision:"block" 判 block, 其余放行 */
export function parseHookDecision(exitCode: number, stdout: string, stderr: string): HookDecision {
  if (exitCode === 2) {
    return { allow: false, reason: stderr.trim() || stdout.trim() || 'blocked by user hook (exit 2)' };
  }
  const trimmed = stdout.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && parsed.decision === 'block') {
        return { allow: false, reason: typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim() : 'blocked by user hook' };
      }
    } catch {
      /* stdout 非 JSON → 忽略 */
    }
  }
  return { allow: true };
}

// ==================== 常量 ====================

const HOOK_TIMEOUT_MS = 10_000; // 10s — 用户脚本不应太慢
const HOOKS_DIR_NAME = 'hooks';
const NEOX_CONFIG_DIR = '.neox';
const SETTINGS_FILE = 'settings.json';

/** Hook 文件名映射（支持 .sh / .py / .js / 无扩展名） */
const HOOK_FILE_PATTERNS: Record<UserHookType, string[]> = {
  'pre-tool-call': ['pre-tool-call', 'pre-tool-call.sh', 'pre-tool-call.py', 'pre-tool-call.js'],
  'post-tool-call': ['post-tool-call', 'post-tool-call.sh', 'post-tool-call.py', 'post-tool-call.js'],
  'pre-session': ['pre-session', 'pre-session.sh', 'pre-session.py', 'pre-session.js'],
  'post-session': ['post-session', 'post-session.sh', 'post-session.py', 'post-session.js'],
};

// ==================== UserHookRunner ====================

const HOOK_ENV_ALLOW = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ', 'PWD',
  /* Windows: 少一个都可能让 cmd/powershell 起不来 */
  'SystemRoot', 'SystemDrive', 'ComSpec', 'PATHEXT', 'USERPROFILE',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMDATA', 'WINDIR',
  'HOMEDRIVE', 'HOMEPATH', 'NUMBER_OF_PROCESSORS', 'OS', 'PROCESSOR_ARCHITECTURE',
];

/** 白名单过滤后的基础环境。大小写按平台: Windows 的变量名大小写不敏感。 */
export function hookBaseEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  const wanted = new Set(HOOK_ENV_ALLOW.map((k) => k.toLowerCase()));
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined && wanted.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

export class UserHookRunner {
  private hookPaths = new Map<UserHookType, string>();
  /** 事件 → 该事件下的所有 matcher 组。用 Map 而不是定长记录: 加事件不用改这里。 */
  private declarative = new Map<HookEvent, DeclarativeHookEntry[]>();
  private initialized = false;

  constructor(private workDir: string) {}

  /**
   * 扫描 .neox/hooks/ 目录 + settings.json "hooks" 段。
   *
   * 搜索顺序：项目级 (.neox/) → 用户级 (~/.neox/)
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    const searchPaths = [
      path.join(this.workDir, NEOX_CONFIG_DIR, HOOKS_DIR_NAME),
      path.join(os.homedir(), NEOX_CONFIG_DIR, HOOKS_DIR_NAME),
    ];

    for (const dir of searchPaths) {
      await this.scanHooksDir(dir);
    }

    for (const settingsPath of [
      path.join(this.workDir, NEOX_CONFIG_DIR, SETTINGS_FILE),
      path.join(os.homedir(), NEOX_CONFIG_DIR, SETTINGS_FILE),
    ]) {
      await this.loadDeclarativeHooks(settingsPath);
    }

    let declarativeCount = 0;
    for (const v of this.declarative.values()) declarativeCount += v.length;
    if (this.hookPaths.size > 0 || declarativeCount > 0) {
      cliLogger.info('HOOKS', `Loaded user hooks: ${this.hookPaths.size} script(s), ${declarativeCount} declarative matcher group(s)`);
    }
  }

  /** 是否配置了任何 pre-tool 拦截 (脚本或声明式) — 调用方用它做零开销快速路径 */
  hasPreToolHooks(): boolean {
    return this.hookPaths.has('pre-tool-call') || (this.declarative.get('PreToolUse')?.length ?? 0) > 0;
  }

  /** 某个事件下有没有 hook —— 通用事件的零开销快速路径 */
  hasHooksFor(event: HookEvent): boolean {
    return (this.declarative.get(event)?.length ?? 0) > 0;
  }

  hasPostToolHooks(): boolean {
    return this.hookPaths.has("post-tool-call") || (this.declarative.get("PostToolUse")?.length ?? 0) > 0;
  }

  /**
   * PreToolUse 评估 — 依次跑: 文件约定式 pre-tool-call 脚本 → settings 声明式 matcher 命中的
   * 每条 command。第一个 block 短路; reason 回注给模型 (kernel preHook stage 的 block reason)。
   */
  async evaluatePreToolUse(toolName: string, toolArgs: Record<string, any>): Promise<HookDecision> {
    await this.initialize();

    const legacy = await this.run({ hookType: 'pre-tool-call', toolName, toolArgs, workDir: this.workDir });
    if (legacy?.blocked) {
      return { allow: false, reason: legacy.alternateResult || legacy.stderr.trim() || 'blocked by pre-tool-call hook' };
    }

    for (const entry of this.declarative.get("PreToolUse") ?? []) {
      if (!matchesTool(entry.matcher, toolName)) continue;
      for (const cmd of entry.hooks) {
        const decision = await this.execDeclarativeCommand('PreToolUse', cmd, { toolName, toolArgs });
        if (!decision.allow) return decision;
      }
    }
    return { allow: true };
  }

  /** PostToolUse — 通知式, 不拦截 (工具已执行); 失败只记日志。 */
  async firePostToolUse(toolName: string, toolArgs: Record<string, any>, toolResult: string): Promise<void> {
    await this.initialize();

    await this.run({ hookType: 'post-tool-call', toolName, toolArgs, toolResult, workDir: this.workDir });

    for (const entry of this.declarative.get("PostToolUse") ?? []) {
      if (!matchesTool(entry.matcher, toolName)) continue;
      for (const cmd of entry.hooks) {
        await this.execDeclarativeCommand('PostToolUse', cmd, { toolName, toolArgs, toolResult });
      }
    }
  }

  /**
   * 是否有指定类型的 hook
   */
  hasHook(type: UserHookType): boolean {
    return this.hookPaths.has(type);
  }

  /**
   * 执行 hook
   */
  async run(ctx: UserHookContext): Promise<UserHookResult | null> {
    const hookPath = this.hookPaths.get(ctx.hookType);
    if (!hookPath) return null;

    const startTime = Date.now();

    // 构建 stdin JSON
    const stdinData = JSON.stringify({
      hook_type: ctx.hookType,
      tool_name: ctx.toolName,
      tool_args: ctx.toolArgs,
      tool_result: ctx.toolResult?.substring(0, 8000), // 限制结果大小
      workspace: ctx.workDir,
      session_id: ctx.sessionId,
      timestamp: new Date().toISOString(),
    });

    // 构建环境变量
    const env: Record<string, string> = {
      ...hookBaseEnv(),
      NEOX_HOOK_TYPE: ctx.hookType,
      NEOX_WORKSPACE: ctx.workDir,
      ...(ctx.toolName ? { NEOX_TOOL_NAME: ctx.toolName } : {}),
      ...(ctx.sessionId ? { NEOX_SESSION_ID: ctx.sessionId } : {}),
    };

    try {
      const result = await this.execHookScript(hookPath, stdinData, env);
      const durationMs = Date.now() - startTime;

      const blocked = result.exitCode === 1 || result.exitCode === 2;
      const alternateResult = result.exitCode === 2 ? result.stdout : undefined;

      if (blocked) {
        cliLogger.warn('HOOKS', `${ctx.hookType} blocked by user hook (exit ${result.exitCode})${ctx.toolName ? ` for ${ctx.toolName}` : ''}`);
      }

      return {
        success: result.exitCode === 0,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs,
        blocked,
        alternateResult,
      };
    } catch (err: any) {
      cliLogger.error('HOOKS', `${ctx.hookType} hook error: ${err.message}`);
      return {
        success: false,
        exitCode: -1,
        stdout: '',
        stderr: err.message,
        durationMs: Date.now() - startTime,
        blocked: false,
      };
    }
  }

  /** 已加载的 hook 列表 */
  getLoadedHooks(): Array<{ type: UserHookType; path: string }> {
    return [...this.hookPaths.entries()].map(([type, p]) => ({ type, path: p }));
  }

  // ==================== 内部方法 ====================

  /** 读 settings.json 的 "hooks" 段, 校验形状后并入 (项目级在前, 用户级追加) */
  private async loadDeclarativeHooks(settingsPath: string): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(settingsPath, 'utf-8');
    } catch {
      return; // 文件不存在 = 正常
    }
    try {
      const parsed = JSON.parse(raw);
      const hooks = parsed?.hooks;
      if (!hooks || typeof hooks !== 'object') return;
      for (const event of HOOK_EVENTS) {
        const entries = (hooks as Record<string, unknown>)[event];
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) continue;
          const commands = entry.hooks
            .filter((h: any) => h && typeof h.command === 'string' && h.command.trim())
            .map((h: any) => ({
              type: 'command' as const,
              command: h.command,
              timeout: typeof h.timeout === 'number' && h.timeout > 0 ? h.timeout : undefined,
            }));
          if (commands.length === 0) continue;
          const bucket = this.declarative.get(event) ?? [];
          bucket.push({
            matcher: typeof entry.matcher === 'string' ? entry.matcher : undefined,
            hooks: commands,
          });
          this.declarative.set(event, bucket);
        }
      }
    } catch (err: any) {
      cliLogger.warn('HOOKS', `Failed to parse hooks in ${settingsPath}: ${err?.message}`);
    }
  }

  /**
   * 触发任意事件 —— **所有新事件都走这一个入口**。
   *
   * 为什么不给每个事件写一个方法: 事件有 21 个, 各写一遍就必然出现"加了事件但某处
   * 忘了接"的静默漏接 —— 而 hook 漏接是最难发现的一类 bug (用户以为自己的脚本在跑,
   * 其实从来没被调用过, 且没有任何报错)。
   *
   * 语义:
   *   · 可拦事件 (PreToolUse / UserPromptSubmit / PermissionRequest / Stop / PreCompact /
   *     SubagentStart) —— 返回值有效, deny 会真的拦住
   *   · 其余是通知式 —— 脚本说什么都不改变流程, 但 additionalContext / updatedToolOutput
   *     仍然会被采纳 (那不是"拦截", 是"补充/改写")
   *   · 多个 hook 的合成规则全在 mergeHookOutcomes 里, 这里不重复判 (谁压过谁只有一处真相)
   *
   * matcher 对非工具事件的含义: 拿 `payload.matcherKey` 去比 (比如 SubagentStart 比
   * 子 agent 类型名); 没给就只有空 matcher 的 hook 会命中。
   */
  async fire(
    event: HookEvent,
    ctx?: { toolName?: string; toolArgs?: Record<string, any>; toolResult?: string; payload?: Record<string, unknown> },
  ): Promise<HookOutcome> {
    await this.initialize();
    const entries = this.declarative.get(event) ?? [];
    if (entries.length === 0) return { allow: true };

    const matchKey = String(
      ctx?.toolName ?? (ctx?.payload?.matcherKey as string | undefined) ?? '',
    );
    const outcomes: HookOutcome[] = [];
    for (const entry of entries) {
      if (!matchesTool(entry.matcher, matchKey)) continue;
      for (const cmd of entry.hooks) {
        outcomes.push(await this.execDeclarativeCommand(event, cmd, {
          toolName: matchKey,
          toolArgs: ctx?.toolArgs,
          toolResult: ctx?.toolResult,
          payload: ctx?.payload,
        }));
      }
    }
    const merged = mergeHookOutcomes(outcomes);
    /* 通知式事件不许拦 —— 脚本写了 exit 2 也只当它在抱怨, 记一条日志就过 */
    if (!merged.allow && !isBlockingEvent(event)) {
      cliLogger.warn('HOOKS', `${event} 是通知式事件, hook 的拒绝不生效: ${merged.reason ?? ''}`);
      return { ...merged, allow: true, decision: undefined };
    }
    return merged;
  }

  /** 声明式 command 执行 — shell 语义 (用户写的是命令行), stdin 喂 JSON, 决策按 parseHookDecision */
  private execDeclarativeCommand(
    event: DeclarativeHookEvent,
    cmd: DeclarativeHookCommand,
    ctx: { toolName: string; toolArgs?: Record<string, any>; toolResult?: string; payload?: Record<string, unknown> },
  ): Promise<HookOutcome> {
    const timeoutMs = (cmd.timeout ?? HOOK_TIMEOUT_MS / 1000) * 1000;
    /* 载荷: 工具那几个字段留着 (老脚本按它们写的, 不能改名), 其余事件的数据平铺进来。
     * 8000 字符截断只切 tool_result —— 它可能是整份文件内容, 而 hook 是拿来判断的不是拿来读全文的。 */
    const stdinData = JSON.stringify({
      hook_event: event,
      tool_name: ctx.toolName,
      tool_args: ctx.toolArgs ?? {},
      tool_result: ctx.toolResult?.substring(0, 8000),
      workspace: this.workDir,
      timestamp: new Date().toISOString(),
      ...(ctx.payload ?? {}),
    });

    return new Promise((resolve) => {
      const child = exec(cmd.command, {
        cwd: this.workDir,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        env: {
          ...hookBaseEnv(),
          NEOX_HOOK_EVENT: event,
          NEOX_TOOL_NAME: ctx.toolName,
          NEOX_WORKSPACE: this.workDir,
        },
      }, (error, stdout, stderr) => {
        const exitCode = error ? ((error as any).code === 'ETIMEDOUT' ? 124 : (error as any).status ?? (typeof (error as any).code === 'number' ? (error as any).code : 1)) : 0;
        const outcome = parseHookOutcome(exitCode, stdout || '', stderr || '', { source: cmd.command });
        if (!outcome.allow) {
          cliLogger.warn('HOOKS', `${event} hook blocked ${ctx.toolName}: ${outcome.reason}`);
        }
        resolve(outcome);
      });
      if (child.stdin) {
        /* 钩子不读 stdin 就退出时, EPIPE 是异步 'error' 事件 —— 没有监听就是 uncaught exception */
        child.stdin.on('error', (err: NodeJS.ErrnoException) => {
          cliLogger.debug('HOOKS', `stdin write failed: ${err?.message}`);
        });
        child.stdin.write(stdinData);
        child.stdin.end();
      }
    });
  }

  private async scanHooksDir(dir: string): Promise<void> {
    try {
      await access(dir, fsConstants.R_OK);
    } catch (err: any) {
      cliLogger.debug('HOOKS', `Hook dir not accessible ${dir}: ${err?.message}`);
      return;
    }

    let files: string[];
    try {
      files = await readdir(dir);
    } catch (err: any) {
      cliLogger.debug('HOOKS', `Hook dir readdir failed ${dir}: ${err?.message}`);
      return;
    }

    const fileSet = new Set(files);

    for (const [hookType, patterns] of Object.entries(HOOK_FILE_PATTERNS) as Array<[UserHookType, string[]]>) {
      if (this.hookPaths.has(hookType)) continue; // 项目级优先，不覆盖

      for (const pattern of patterns) {
        if (fileSet.has(pattern)) {
          const fullPath = path.join(dir, pattern);
          // 检查可执行权限
          try {
            await access(fullPath, fsConstants.X_OK);
            this.hookPaths.set(hookType, fullPath);
            break;
          } catch (err: any) {
            // .py / .js 不需要可执行权限，用解释器执行
            cliLogger.debug('HOOKS', `Hook ${pattern} not executable, checking extension: ${err?.message}`);
            if (pattern.endsWith('.py') || pattern.endsWith('.js')) {
              this.hookPaths.set(hookType, fullPath);
              break;
            }
          }
        }
      }
    }
  }

  private execHookScript(
    scriptPath: string,
    stdinData: string,
    env: Record<string, string>,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      // 根据扩展名选择解释器
      let cmd: string;
      let args: string[];
      if (scriptPath.endsWith('.py')) {
        cmd = 'python3';
        args = [scriptPath];
      } else if (scriptPath.endsWith('.js')) {
        cmd = 'node';
        args = [scriptPath];
      } else {
        cmd = scriptPath;
        args = [];
      }

      const child = execFile(cmd, args, {
        env,
        timeout: HOOK_TIMEOUT_MS,
        maxBuffer: 1024 * 1024, // 1MB
        cwd: this.workDir,
      }, (error, stdout, stderr) => {
        const exitCode = error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          ? 1
          : (error as any)?.code === 'ETIMEDOUT'
            ? 124 // timeout
            : error
              ? (error as any).status ?? 1
              : 0;
        resolve({ exitCode, stdout: stdout || '', stderr: stderr || '' });
      });

      // 通过 stdin 传入 JSON 上下文
      if (child.stdin) {
        /* 钩子不读 stdin 就退出时, EPIPE 是异步 'error' 事件 —— 没有监听就是 uncaught exception */
        child.stdin.on('error', (err: NodeJS.ErrnoException) => {
          cliLogger.debug('HOOKS', `stdin write failed: ${err?.message}`);
        });
        child.stdin.write(stdinData);
        child.stdin.end();
      }
    });
  }
}

// ==================== 全局单例 ====================

let _globalRunner: UserHookRunner | null = null;

export function getGlobalUserHookRunner(): UserHookRunner | null {
  return _globalRunner;
}

export function initGlobalUserHookRunner(workDir: string): UserHookRunner {
  _globalRunner = new UserHookRunner(workDir);
  return _globalRunner;
}
