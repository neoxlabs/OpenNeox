/**
 * 分层 Prompt 系统 - 主入口
 *
 * 架构：
 * Layer 1: 固定约束（通用规则）
 * Layer 2: 通用 Agent（统一prompt）
 * Layer 3: Skills 信息（可用技能）
 */

import { buildUniversalConstraints } from './universal-constraints.js';
import { buildGeneralAssistantPrompt } from './general-assistant.js';
import { buildVerificationMandate } from './verification-mandate.js';
import { buildServiceAwarenessMandate } from './service-awareness-mandate.js';
import { skillRegistry } from '../../../skills/registry.js';
import { execSync } from 'child_process';
import os from 'os';
import { getWorkspaceAdditionalRoots } from '../../workspaceRootsContext.js';
import { getWindowsShell } from '../../../tools/powershell/powershellDetection.js';

/* Git 信息采集 — 模块级 30s TTL cache.
 *
 * 历史问题: 启动期 buildInstructions → buildLayeredPrompt → buildEnvironmentInfo
 * 同步串跑 3 条 git execSync, 最坏情况撞 3×3s timeout 阻塞 server health-ready 9s,
 * 用户感受为"敲 neox 卡数秒才进 REPL,不同目录耗时不同".
 *
 * 真正慢的只有 `git status --porcelain` (扫整个 work-tree, 大 monorepo cold cache
 * 可几十秒). 业界做法 (VSCode / JetBrains / CC): env 完全 lazy, 启动期 0 git 调用.
 *
 * 本模块的修复:
 *   1. server 启动期传 skipEnvironment: true (server/main.ts), 完全跳过本路径.
 *   2. 由 agenticRuntime 在每次组装 system prompt 时 lazy 调用 buildEnvironmentInfo.
 *   3. 这层 cache 让同 session 内 30s 复用结果, 避免热路径反复 fork git.
 *   4. status 改 `-uno` 跳 untracked (大 monorepo 里 untracked 占耗时 90%+).
 *   5. timeout 3s → 1s (不再阻塞启动, 失败 fallback 到 unknown 即可).
 */
type GitInfo = { branch: string; status: string; recentCommits: string };
const GIT_INFO_CACHE = new Map<string, { result: GitInfo; expiresAt: number }>();
/* Cache git metadata for five minutes and retain the last successful value when
 *
 * The metadata is part of the prefix-cached system prompt. A five-minute TTL,
 * sticky fallback, and omission of volatile dirty/clean state keep refresh
 * failures from changing the cached bytes. */
const GIT_INFO_TTL_MS = 5 * 60_000;
/* 拿到**完整**结果 (branch + 最近提交都齐) 之后就长期不再重查。
 *  二次发现: 高负载下 `git log --oneline -5` 也会超过 1s 超时, 于是「最近提交」
 * 整块从提示词里消失, 下次成功又冒出来 —— 同样是打穿前缀, 只是比 dirty/clean 更隐蔽
 * (是我自己的稳定性测试在 load 19.87 时把它逼出来的)。
 * branch 和最近 5 条提交本来就极少变, 拿 30 分钟的陈旧换"字节永不抖动"非常划算。 */
const GIT_INFO_STABLE_TTL_MS = 30 * 60_000;

function collectGitInfo(workDir: string): GitInfo {
  const now = Date.now();
  const cached = GIT_INFO_CACHE.get(workDir);
  if (cached && cached.expiresAt > now) return cached.result;
  /* sticky 基准: 过期了也先留着, 查不到就原样返回, 不让"查失败"变成"提示词变了" */
  const last = cached?.result;

  let branch = '';
  let status = '';
  let recentCommits = '';
  try {
    branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: workDir, encoding: 'utf-8', timeout: 1000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch { /* not a git repo or git unavailable */ }

  if (branch) {
    try {
      /* -uno: 不列 untracked. 大 monorepo 中 untracked (node_modules 之外的临时文件 / build
       * 产物 / 未 commit 的目录) 经常成千上万, git 要 stat 每一个, cold cache 数秒.
       * 我们只关心 dirty/clean 信号, tracked 文件的修改足够代表. */
      const porcelain = execSync('git status --porcelain -uno', {
        cwd: workDir, encoding: 'utf-8', timeout: 1000, stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      status = porcelain.length === 0 ? 'clean' : 'dirty';
    } catch { status = 'unknown'; }

    try {
      recentCommits = execSync('git log --oneline -5', {
        cwd: workDir, encoding: 'utf-8', timeout: 1000, stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch { /* ignore */ }
  }

  /* 任何一段查不到 → 沿用上一次拿到的值。宁可用 5 分钟前的 branch, 也不要让一次超时
     把 system 段改成另一个版本 (那代价是整条前缀缓存作废)。 */
  const result: GitInfo = {
    branch: branch || last?.branch || '',
    status: status && status !== 'unknown' ? status : (last?.status || status),
    recentCommits: recentCommits || last?.recentCommits || '',
  };
  /* 完整就长期锁住; 缺东西 (可能是超时) 就短 TTL, 过一会儿再试补齐 */
  const complete = !!result.branch && !!result.recentCommits;
  GIT_INFO_CACHE.set(workDir, {
    result,
    expiresAt: now + (complete ? GIT_INFO_STABLE_TTL_MS : GIT_INFO_TTL_MS),
  });
  return result;
}

/** 测试用 —— 清掉进程级 git 缓存 (连 sticky 基准一起清, 相当于全新进程) */
export function __resetGitInfoCache(): void { GIT_INFO_CACHE.clear(); }

/** 测试用 —— 只把 TTL 判过期, **保留 sticky 基准**。
 *  这才对应生产里真实发生的事: TTL 到点重查, 查失败时靠上一次的好值兜住。
 *  (用 __resetGitInfoCache 模拟这个场景是错的 —— 它把兜底的依据也删了。) */
export function __expireGitInfoCache(): void {
  for (const [k, v] of GIT_INFO_CACHE) GIT_INFO_CACHE.set(k, { ...v, expiresAt: 0 });
}

// ============================================================================
// 类型定义
// ============================================================================

/**
 * Prompt 构建选项
 */
export interface LayeredPromptOptions {
  workDir: string;
  language?: 'zh' | 'en';
  /** 跳过环境信息（日期/git 等动态内容），由调用方单独注入为 contextInjection */
  skipEnvironment?: boolean;
}

// ============================================================================
// Skills section — 单一来源 (sections.ts 与 buildLayeredPrompt 共用)
// ============================================================================

/**
 * Build the skills prompt section from the registry; return null when empty.
 *
 * Matching skills are mandatory before the agent performs the task, and their
 * instructions take precedence over default behavior. use_skill remains in
 * ALWAYS_ACTIVE_TOOLS (toolTree.ts), so the prompt and tool surface remain consistent.
 */
export function buildSkillsSection(language: 'zh' | 'en'): string | null {
  const skillsPrompt = skillRegistry.getSkillsForPrompt();
  if (!skillsPrompt) return null;
  const skillsHeader = language === 'zh'
    ? `## 可用技能 (Skills)

以下是已注册的技能。技能是用户安装的标准作业流程，优先级**高于**你自己的默认做法。

**硬规则**:
- 用户意图匹配到某个技能时，**必须先调用 \`use_skill\` 获取完整指令，再开始动手**。禁止跳过技能凭默认知识裸做。例: 用户说"审查一下这次改动"且存在 review 技能时，不许直接开始读 diff，必须先 \`use_skill\`。
- 不要问用户"要不要使用某技能"——意图匹配即自动加载。
- 技能指令与你的默认习惯冲突时，以技能指令为准。

`
    : `## Available Skills

Below are registered skills. Skills are user-installed standard operating procedures and take **priority over** your default approach.

**Hard rules**:
- When user intent matches a skill, you **MUST call \`use_skill\` to get the full instructions BEFORE acting**. Never skip the skill and act from default knowledge. Example: if the user says "review these changes" and a review skill exists, do not start reading the diff directly — call \`use_skill\` first.
- Never ask "do you want to use skill X?" — load it automatically on intent match.
- When skill instructions conflict with your default habits, the skill wins.

`;
  return skillsHeader + skillsPrompt;
}

// ============================================================================
// 主函数
// ============================================================================

/**
 * 构建分层 Prompt
 *
 * 统一的通用prompt，适用于所有场景
 */
export function buildLayeredPrompt(options: LayeredPromptOptions): string {
  const {
    workDir,
    language = 'zh',
  } = options;

  const sections: string[] = [];

  // ========================================================================
  //  Cache-friendly ordering: 稳定内容在前（形成 KV cache prefix），动态内容在后
  // ========================================================================

  // Layer 1: 通用 Agent 身份（最稳定 — 只有代码变更才会改）
  // ========================================================================
  sections.push(buildGeneralAssistantPrompt(language));
  sections.push('');

  // ========================================================================
  // Layer 2: 固定约束（所有 Agent 通用，极少变化）
  // ========================================================================
  sections.push(buildUniversalConstraints(workDir, language));
  sections.push('');

  // ========================================================================
  // Layer 2.5: Verification Mandate (完成代码必须验证 — 反偷懒+yield gate 提示)
  // ========================================================================
  sections.push(buildVerificationMandate(language));
  sections.push('');

  // ========================================================================
  // Layer 2.6: Service Awareness (启动 dev/server 前先 service_scan — 防重复 spawn)
  // 跟 verification mandate 配套: 验证别新起一份服务, 用已有的.
  // ========================================================================
  sections.push(buildServiceAwarenessMandate(language));
  sections.push('');

  // ========================================================================
  // Layer 3: Skills 信息（可用技能，仅在注册新 skill 时变化）
  // ========================================================================
  const skillsSection = buildSkillsSection(language);
  if (skillsSection) {
    sections.push(skillsSection);
    sections.push('');
  }

  // ========================================================================
  // Layer 4: 环境信息（动态 — 每天/每次 git 操作都可能变化，放最后避免破坏 cache prefix）
  // 当 skipEnvironment=true 时，由调用方单独注入为 contextInjection（完全不进主 system msg）
  // ========================================================================
  if (!options.skipEnvironment) {
    const envInfo = buildEnvironmentInfo(workDir, language);
    sections.push(envInfo);
    sections.push('');
  }

  // ========================================================================
  // 结束
  // ========================================================================
  sections.push(language === 'zh' ? '开始工作。' : 'Start working.');

  return sections.join('\n');
}

// ============================================================================
// 环境信息采集
// ============================================================================

/**
 * 自动采集环境信息，注入到 system prompt
 * 包括：平台、Shell、Git 状态、当前日期
 *  导出供 agenticRuntime 单独注入为 contextInjection
 */
export function buildEnvironmentInfo(workDir: string, language: 'zh' | 'en'): string {
  const platform = process.platform;
  const arch = process.arch;
  const osRelease = os.release();
  const shell = process.env.SHELL || process.env.COMSPEC || 'unknown';
  /* 本地日期+星期 (曾用 UTC toISOString — 晚间差一天)。 只放"天"级信息:
   * system 段每字节变化都打穿前缀缓存, 分钟级时刻走消息流 (agenticRuntime
   * 在最新 user 消息尾部挂 <current-time>, 历史不可变 → 缓存无损)。 */
  const nowD = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const today = `${nowD.getFullYear()}-${pad(nowD.getMonth() + 1)}-${pad(nowD.getDate())}`;
  const weekdayZh = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][nowD.getDay()];
  const weekdayEn = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][nowD.getDay()];

  /* Git 信息: 走 cached helper (30s TTL). 启动期不应调用此函数 — 见 collectGitInfo 注释. */
  /* status 故意不取 —— dirty/clean 不进被缓存的 system 段 (见 collectGitInfo 上方注释)。
     collectGitInfo 仍然算它, 因为别处 (会话头/UI) 要用; 只是提示词不吃。 */
  const { branch: gitBranch, recentCommits: gitRecentCommits } = collectGitInfo(workDir);

  /* 多根工作区: workDir 之外的附加项目根 (单根时为空 → 完全无影响)。 */
  const additionalRoots = getWorkspaceAdditionalRoots(workDir);

  //  Windows 平台感知指导 — 与执行端 (buildShellInvocation) 共用 getWindowsShell() 同源,
  //    保证"告诉 agent 的 shell"="实际执行的 shell"; 按 PowerShell edition 区分 && / ;。
  const isWindows = platform === 'win32';
  const winShell = isWindows ? getWindowsShell() : null;
  const isPowerShell = !!winShell?.isPowerShell;
  /* powershell.exe 5.1 (desktop) 不支持 && → 必须用 ; ; pwsh 7+ (core) 支持 &&。 */
  const psMustUseSemicolon = isPowerShell && !winShell!.supportsChaining;
  const displayShell = winShell?.shellPath || shell;
  const platformGuidance = isWindows ? (isPowerShell ? [
    `- ⚠️ 你在 Windows PowerShell (${winShell!.edition === 'core' ? 'pwsh 7+' : 'Windows PowerShell 5.1'}) 环境中运行`,
    `- 使用 PowerShell 语法，不要使用 bash/Unix 命令`,
    psMustUseSemicolon
      ? `- ⚠️ 多命令连接必须用 ;（分号），不能用 &&/||（PowerShell 5.1 会报 InvalidEndOfLine）`
      : `- 多命令连接可用 &&/||（pwsh 7+ 支持）或 ;`,
    `- 终端输出已强制 UTF-8（不会乱码，可放心读中文输出）`,
    `- 文件搜索: 用 rg（ripgrep）替代 grep/find — rg 已安装且跨平台`,
    `- 文件读取: 用 Get-Content 替代 cat，或直接用 readfile 工具`,
    `- 目录列表: 用 Get-ChildItem 或 ls（PowerShell alias）`,
    `- 路径分隔符: 用 \\ 或 /（PowerShell 两者都支持）`,
    `- 进程管理: 用 Stop-Process 替代 kill`,
    `- 环境变量: 用 $env:VAR 替代 $VAR`,
  ] : [
    `- ⚠️ 你在 Windows cmd.exe 环境中运行`,
    `- 使用 cmd 语法，不要使用 bash/Unix 命令`,
    `- 终端输出自动 UTF-8（内建命令按系统代码页输出, 已自动转码, 不会乱码）`,
    `- 文件搜索: 用 rg（ripgrep）替代 grep/find`,
    `- 目录列表: 用 dir，文件内容用 type 或 readfile 工具（cmd 没有 ls/cat）`,
    `- 路径分隔符: 用 \\`,
    `- 环境变量: 用 %VAR% 替代 $VAR`,
    `- 命令连接: 用 && 或 &（cmd 不支持 ;）`,
    `- 需要 PowerShell 脚本能力时用 execute_powershell 工具（自动 UTF-8）`,
  ]) : [];

  if (language === 'zh') {
    const lines = [
      `## 环境`,
      `- 工作目录: ${workDir}`,
      ...(additionalRoots.length > 0 ? [
        `- 本工作区还包含以下并列项目根 (可直接用绝对路径读写/运行命令访问):`,
        ...additionalRoots.map((r) => `    · ${r}`),
      ] : []),
      `- 平台: ${platform} (${arch}), OS: ${osRelease}`,
      `- Shell: ${displayShell}`,
      `- 当前日期: ${today} ${weekdayZh} (本机时区; 精确时刻在最新用户消息尾部的 <current-time> 标记里, 回答"现在几点"直接用, 不要调工具)`,
      `- Shell 每次调用独立，cd 不跨调用持续`,
      ...platformGuidance,
    ];
    if (gitBranch) {
      /* Volatile dirty/clean state stays out of the cached prompt; the agent can
         query current status when it needs that fact. */
      lines.push(`- Git 分支: ${gitBranch}`);
      if (gitRecentCommits) {
        lines.push(`- 最近提交:\n${gitRecentCommits.split('\n').map(l => '  ' + l).join('\n')}`);
      }
    }
    return lines.join('\n');
  } else {
    // English platform guidance — same getWindowsShell() source, edition-aware && vs ;
    const enPlatformGuidance = isWindows ? (isPowerShell ? [
      `- ⚠️ Running on Windows PowerShell (${winShell!.edition === 'core' ? 'pwsh 7+' : 'Windows PowerShell 5.1'}) — use PowerShell syntax, NOT bash/Unix commands`,
      psMustUseSemicolon
        ? `- ⚠️ Chain commands with ; (semicolon), NOT && / || (PowerShell 5.1 errors with InvalidEndOfLine)`
        : `- Chain commands with && / || (pwsh 7+) or ;`,
      `- Terminal output is forced to UTF-8 (no mojibake, safe to read non-ASCII output)`,
      `- Search: use rg (ripgrep) instead of grep/find — rg is installed and cross-platform`,
      `- Read files: use Get-Content or the readfile tool, not cat`,
      `- Env vars: use $env:VAR not $VAR`,
      `- Process management: use Stop-Process not kill`,
    ] : [
      `- ⚠️ Running on Windows cmd.exe — use cmd syntax, NOT bash/Unix commands`,
      `- Terminal output is auto-converted to UTF-8 (cmd internal commands emit system-codepage bytes; auto-decoded, no mojibake)`,
      `- Search: use rg (ripgrep) instead of grep/find`,
      `- List dirs with dir, read files with type or the readfile tool (no ls/cat in cmd)`,
      `- Env vars: use %VAR% not $VAR`,
      `- Chain commands with && or & (no ; in cmd)`,
      `- For PowerShell scripting use the execute_powershell tool (auto UTF-8)`,
    ]) : [];

    const lines = [
      `## Environment`,
      `- Working directory: ${workDir}`,
      ...(additionalRoots.length > 0 ? [
        `- This workspace also contains these sibling project roots (access them directly by absolute path for read/write/commands):`,
        ...additionalRoots.map((r) => `    · ${r}`),
      ] : []),
      `- Platform: ${platform} (${arch}), OS: ${osRelease}`,
      `- Shell: ${displayShell}`,
      `- Current date: ${today} ${weekdayEn} (local timezone; exact clock time is in the <current-time> tag at the end of the latest user message — answer time questions directly, no tools)`,
      `- Shell calls are independent; cd does not persist across calls`,
      ...enPlatformGuidance,
    ];
    if (gitBranch) {
      /* 同上: dirty/clean 会打穿前缀缓存, 不进 system 段 */
      lines.push(`- Git branch: ${gitBranch}`);
      if (gitRecentCommits) {
        lines.push(`- Recent commits:\n${gitRecentCommits.split('\n').map(l => '  ' + l).join('\n')}`);
      }
    }
    return lines.join('\n');
  }
}
