/**
 * 项目指令自动加载
 *
 * Load project instructions from workspace, parent, and user locations.
 *
 * 层级（高→低优先级）：
 *   1. workspace/.neox/INSTRUCTIONS.md — 项目级指令
 *   2. workspace/NEOX.md — 项目根快捷方式
 *   3. workspace/AGENTS.md / .cursorrules / CLAUDE.md — Cursor/Codex/Claude 兼容
 *   4. parent dirs 同名候选 — 上级目录（monorepo 场景）
 *   5. ~/.neox/INSTRUCTIONS.md — 用户级全局指令
 *
 *  缓存关键设计：
 *   - 启动时加载一次 → 计算 content hash
 *   - 后续只在 hash 变化时刷新（不破坏 prompt cache）
 *   - 指令注入到 system prompt 的固定位置（Anthropic cache breakpoint 友好）
 *   - 不会在每次 LLM 调用时动态变化
 *
 * 与 project.md 记忆的区别：
 *   - INSTRUCTIONS.md = 静态规则（用户手写，不自动修改）
 *   - project.md = 动态学习（agent 自动更新的上下文记忆）
 */

import { readFile } from 'fs/promises';
import { createHash } from 'crypto';
import path from 'path';
import { cliLogger } from '../platform/cliLogger.js';
import { NEOX_HOME_DIRNAME } from '../platform/neoxHome.js';
import { createSessionScopedStore } from './sessionScope.js';

// ==================== 类型定义 ====================

export interface ProjectInstructions {
  /** 合并后的完整指令文本 */
  content: string;
  /** 内容 hash（用于缓存校验） */
  contentHash: string;
  /** 加载的指令文件来源 */
  sources: Array<{
    path: string;
    level: 'workspace' | 'parent' | 'user';
    lines: number;
  }>;
  /**
   * 读失败的候选文件 —— **不含** ENOENT/ENOTDIR.
   *
   * "没有指令文件" 是绝大多数目录的正常状态, 不进这里, 也不该上屏。
   * 进这里的是 "文件在, 但我们读不了" (EACCES / EISDIR / EMFILE ...) ——
   * 用户本意是有这份指令, 静默忽略就是老 bug 的翻版, 必须出可见的错误卡。
   */
  failures: Array<{
    path: string;
    code: string;
    message: string;
  }>;
  /** 加载时间戳 */
  loadedAt: number;
}

/** 扫描的文件名列表（同级只取第一个命中；顺序 = 优先级） */
const INSTRUCTION_FILENAMES = [
  '.neox/INSTRUCTIONS.md',
  'NEOX.md',
  'AGENTS.md',
  '.cursorrules',
  'CLAUDE.md',
];

/* Workspace and user instruction files use different roots; derive the user
 * path from NEOX_HOME_DIRNAME. */
const USER_INSTRUCTION_PATH = `${NEOX_HOME_DIRNAME}/INSTRUCTIONS.md`;

/** 最大向上扫描层级 */
const MAX_PARENT_SCAN_DEPTH = 5;

/** 指令最大总长度（字符）— 防止过大指令破坏 context budget */
const MAX_INSTRUCTIONS_CHARS = 20_000;

// ==================== 加载器 ====================

/**
 * 加载项目指令
 *
 * 启动时调用一次，结果缓存。只在 hash 变化时刷新。
 */
export async function loadProjectInstructions(workDir: string): Promise<ProjectInstructions> {
  const sources: ProjectInstructions['sources'] = [];
  const failures: ProjectInstructions['failures'] = [];
  const parts: string[] = [];

  // 1. workspace 级
  for (const filename of INSTRUCTION_FILENAMES) {
    const content = await tryReadFile(path.join(workDir, filename), failures);
    if (content !== null) {
      parts.push(content);
      sources.push({
        path: path.join(workDir, filename),
        level: 'workspace',
        lines: content.split('\n').length,
      });
      break; // 同级只取第一个匹配
    }
  }

  // 2. 上级目录扫描（monorepo 场景）
  let currentDir = path.dirname(workDir);
  let depth = 0;
  while (depth < MAX_PARENT_SCAN_DEPTH && currentDir !== path.dirname(currentDir)) {
    for (const filename of INSTRUCTION_FILENAMES) {
      const filePath = path.join(currentDir, filename);
      // 不重复加载已找到的
      if (sources.some(s => s.path === filePath)) continue;

      const content = await tryReadFile(filePath, failures);
      if (content !== null) {
        parts.push(content);
        sources.push({
          path: filePath,
          level: 'parent',
          lines: content.split('\n').length,
        });
        break;
      }
    }
    currentDir = path.dirname(currentDir);
    depth++;
  }

  // 3. 用户级 (~/.neox/INSTRUCTIONS.md)
  const userPath = path.join(process.env.HOME || process.env.USERPROFILE || '', USER_INSTRUCTION_PATH);
  if (!sources.some(s => s.path === userPath)) {
    const content = await tryReadFile(userPath, failures);
    if (content !== null) {
      parts.push(content);
      sources.push({
        path: userPath,
        level: 'user',
        lines: content.split('\n').length,
      });
    }
  }

  // 合并 + 截断
  let merged = parts.join('\n\n---\n\n');
  if (merged.length > MAX_INSTRUCTIONS_CHARS) {
    merged = merged.substring(0, MAX_INSTRUCTIONS_CHARS) + '\n\n[... instructions truncated]';
    cliLogger.warn('INSTRUCTIONS', `Project instructions truncated to ${MAX_INSTRUCTIONS_CHARS} chars`);
  }

  const contentHash = createHash('sha256').update(merged).digest('hex').substring(0, 16);

  if (sources.length > 0) {
    cliLogger.info('INSTRUCTIONS', `Loaded ${sources.length} instruction file(s): ${sources.map(s => s.path).join(', ')}`);
  }

  return {
    content: merged,
    contentHash,
    sources,
    failures,
    loadedAt: Date.now(),
  };
}

/**
 * 检查指令是否发生变化（用于决定是否刷新）
 */
export async function hasInstructionsChanged(
  workDir: string,
  previousHash: string,
): Promise<boolean> {
  const current = await loadProjectInstructions(workDir);
  return current.contentHash !== previousHash;
}

/**
 * 将指令格式化为 system prompt 注入段
 *
 *  此段放在 system prompt 的固定位置（紧跟基础指令之后），
 *     不会在每次调用时变化，确保 prompt cache 命中。
 */
export function formatInstructionsForPrompt(instructions: ProjectInstructions): string {
  if (!instructions.content) return '';

  const sourceLabels = instructions.sources.map(s => {
    const label = s.level === 'workspace' ? 'project' : s.level;
    return `${label}: ${path.basename(path.dirname(s.path))}/${path.basename(s.path)}`;
  });

  return [
    '## Project Instructions',
    '',
    `Sources: ${sourceLabels.join(', ')}`,
    '',
    instructions.content,
  ].join('\n');
}

// ==================== 内部工具 ====================

/**
 * 读一个候选指令文件.
 *
 *  fail-loud 边界 — 两种"读不到"必须区分:
 *   · ENOENT / ENOTDIR = 文件不存在 → **正常情况**, 绝大多数目录都没有指令文件, 静默返 null.
 *   · 其它 errno (EACCES 权限 / EISDIR 建成了目录 / EMFILE ...) = 用户**本意是有**这个文件
 *     但我们读不了 → 必须 warn 上屏, 否则就是老 bug 的翻版: 用户写了指令被静默忽略.
 *
 * 空文件 / 全空白也算"没有指令", 但记 debug — 用户可能以为自己写了东西.
 */
async function tryReadFile(
  filePath: string,
  failures: ProjectInstructions['failures'],
): Promise<string | null> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err: any) {
    const code = err?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null; // 正常: 没这个文件
    const message = err?.message ?? String(err);
    /* 记进 failures —— 消费端 (agenticRuntime) 会把它渲成 timeline 上的错误卡.
     * 只 warn 进 cliLogger 等于没说: cliLogger 仅在 CLI_DEBUG=1 落盘, 正常用户看不到. */
    failures.push({ path: filePath, code: code ?? 'UNKNOWN', message });
    cliLogger.warn(
      'INSTRUCTIONS',
      `Failed to read instruction file ${filePath}: ${code ?? ''} ${message}`.trim(),
    );
    return null;
  }

  const trimmed = content.trim();
  if (trimmed.length === 0) {
    cliLogger.debug('INSTRUCTIONS', `Instruction file is empty, ignored: ${filePath}`);
    return null;
  }
  return trimmed;
}

// ==================== 全局缓存 ====================

/* 为什么是 Map 而不是单槽:
 *   一个 server 进程同时服务多个工作区 —— renderer 每条消息带 workspacePath
 *   (agenticRuntime.ts 的 sessionWorkspace), 优先于全局 workDir. 若只有一个槽,
 *   项目 A 和项目 B 的会话交替发消息就会互相覆盖, `projectInstructionsHash` 每轮翻转,
 *   `project-instructions` section 的 memo 每轮 miss → **前缀缓存每轮被打穿**.
 *   按 workDir 分槽后, 每个会话看到的 hash 在其生命周期内恒定.
 *
 * `_active` 是"当前这轮该用哪个"的指针 —— 因为消费端 getCachedInstructions() 是
 * 无参 API (sections.ts / systemPrompt.ts 已经写好, 不改), 只能靠调用前先 activate. */
const _byWorkDir = new Map<string, ProjectInstructions>();

/* "当前激活的是哪份指令"从两个 module-level 变量改成按会话分桶。
 *
 *   上面那段注释已经点出这是个**指针**: 消费端 getCachedInstructions() 是无参 API,
 *   靠"调用前先 activate"。而全服务器共用一个 runtime —— 会话 A 在项目甲 activate 完,
 *   会话 B 紧接着在项目乙 activate, A 这一轮的 prompt 就拿到了乙的项目指令。
 *   (_byWorkDir 那层缓存本身是按 workDir 的, 没问题, 有问题的只是这个全局指针。)
 *
 *   继承语义: 会话没 activate 过就读默认桶 —— CLI/SDK 那种"进程里只有一个项目"的
 *   用法完全不受影响。 */
const _activeStore = createSessionScopedStore<{ instructions: ProjectInstructions; workDir: string } | null>(() => null);

export function getCachedInstructions(): ProjectInstructions | null {
  return _activeStore.get()?.instructions ?? null;
}

/** 当前激活的 workDir (未激活时 null). 测试 / 诊断用. */
export function getActiveInstructionsWorkDir(): string | null {
  return _activeStore.get()?.workDir ?? null;
}

/** 清空全部缓存 — 仅测试用. */
export function __resetProjectInstructionsCacheForTest(): void {
  _byWorkDir.clear();
  _activeStore.clearAll();
}

function activate(workDir: string, instructions: ProjectInstructions): ProjectInstructions {
  _byWorkDir.set(workDir, instructions);
  _activeStore.set({ instructions, workDir });
  return instructions;
}

/**
 * 首次加载 (runtime bridge 组装时调用一次).
 *
 * 无条件读盘并覆盖该 workDir 的槽 —— 这是"进程刚起, 以盘上为准"的断言.
 */
export async function initProjectInstructions(workDir: string): Promise<ProjectInstructions> {
  return activate(workDir, await loadProjectInstructions(workDir));
}

/**
 * 热路径入口 (每轮组装 prompt 前调) —— 把 `workDir` 对应的指令设为当前激活项.
 *
 *  命中 Map 时**零 IO 零分配**, 直接切指针; 只有某个 workDir 第一次出现才读盘。
 *    这就是"不要每轮都重新读盘"的落点: 第 N 轮 (N>1) 走的是 Map.get.
 *  也因此一次会话中间指令内容不会无谓变化 —— 同一 workDir 拿到的永远是同一个对象,
 *    hash 恒定, `project-instructions` section memo 常命中 → 前缀缓存不断。
 *    盘上文件真的改了要生效, 必须显式走 refreshProjectInstructions (切工作区时).
 */
export async function ensureProjectInstructionsFor(workDir: string): Promise<ProjectInstructions> {
  return (await ensureProjectInstructionsForDetailed(workDir)).instructions;
}

export interface EnsureInstructionsOutcome {
  instructions: ProjectInstructions;
  /**
   * true = 本次真读了盘 (该 workDir 第一次出现).
   * false = Map 命中, 零 IO.
   *
   *  这个标志是 timeline 卡片的**唯一**触发条件. 加载卡必须只在真加载那一次出现:
   *    每轮都发 = timeline 刷屏, 而且会把用户训练成无视这张卡. (前缀缓存本身不受影响 ——
   *    命中分支根本不读盘也不换对象引用 —— 但重复出卡同样是 bug.)
   */
  freshlyLoaded: boolean;
}

/** Return cached instructions together with whether this call read from disk. */
export async function ensureProjectInstructionsForDetailed(
  workDir: string,
): Promise<EnsureInstructionsOutcome> {
  const hit = _byWorkDir.get(workDir);
  if (hit) {
    _activeStore.set({ instructions: hit, workDir });
    return { instructions: hit, freshlyLoaded: false };
  }
  const loaded = await loadProjectInstructions(workDir);
  cliLogger.info(
    'INSTRUCTIONS',
    loaded.sources.length > 0
      ? `Activated ${loaded.sources.length} instruction file(s) for ${workDir} (hash ${loaded.contentHash.substring(0, 8)})`
      : `No instruction files under ${workDir} (normal)`,
  );
  return { instructions: activate(workDir, loaded), freshlyLoaded: true };
}

/**
 * 刷新指令（重新读盘, 仅在 hash 变化时替换缓存对象）
 *
 *  前缀缓存: hash 不变时**不替换对象引用**, 于是 `projectInstructionsHash` 不变 →
 *    sectionRegistry 的 `project-instructions` section 命中 memo, 渲染出逐字节相同的
 *    字符串 → LLM 侧前缀缓存不断。所以重复调用是安全的, 但它**读盘**, 不该挂在每轮上。
 *
 * @returns true 如果内容发生了变化
 */
export async function refreshProjectInstructions(workDir: string): Promise<boolean> {
  const previous = _byWorkDir.get(workDir);
  const oldHash = previous?.contentHash ?? '';
  const newInstructions = await loadProjectInstructions(workDir);

  if (previous && newInstructions.contentHash === oldHash) {
    /* 内容没变 —— 保留原对象引用, 绝不替换, 否则白白让下游 memo 失效. */
    _activeStore.set({ instructions: previous, workDir });
    return false;
  }

  activate(workDir, newInstructions);
  cliLogger.info(
    'INSTRUCTIONS',
    `Instructions updated for ${workDir} ` +
    `(hash: ${oldHash.substring(0, 8) || '<none>'} → ${newInstructions.contentHash.substring(0, 8)}, ` +
    `${newInstructions.sources.length} file(s))`,
  );
  return true;
}
