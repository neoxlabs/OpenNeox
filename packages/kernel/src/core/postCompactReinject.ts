/**
 * Reinject recent file reads, active skills, and unfinished work after context
 * compaction. Entries are session-scoped, ordered by recency, deduplicated
 * against preserved messages, and bounded by fixed token budgets.
 */

import { cliLogger } from '../platform/cliLogger.js';
import type { Message } from '../types/index.js';
import { getTextFromContent } from '../utils/messageUtils.js';
import { createSessionScopedStore } from './sessionScope.js';

// ============================================================================
// 配置常量
// ============================================================================

/**
 * Fixed total reinjection budget; it does not scale with the context window.
 *
 * The fixed budget keeps post-compaction placement predictable.
 */
const POST_COMPACT_TOKEN_BUDGET = 8_000;
/** 每个文件最大 token 数 (8K 预算下实际能灌 2 个) */
const PER_FILE_TOKEN_CAP = 4_000;
/** 最多重注入文件数 */
const MAX_REINJECT_FILES = 5;
/** 每个技能最大 token 数 */
const PER_SKILL_TOKEN_CAP = 3_000;
/** 技能总预算 — 文件优先, 技能只吃剩下的 */
const SKILL_TOTAL_BUDGET = 4_000;
/** 热文件路径清单条数上限 — 只报路径不带内容 (~30 tok/条), 见 1.5 节注释 */
const MAX_PATHLIST_ENTRIES = 12;

// ============================================================================
// 文件访问追踪
// ============================================================================

interface FileAccessRecord {
  /** 文件路径 */
  filePath: string;
  /** 最后访问时间 */
  lastAccessedAt: number;
  /** 文件内容（最近一次读取的） */
  content?: string;
  /** 访问次数 */
  accessCount: number;
}

/* 文件访问追踪表 —— 同样按会话独立。
 * 这张表的用途是"压缩后把最近读过的文件灌回去", 跨会话共用就会把别人读的文件
 * 灌进本会话的上下文, 既浪费预算又误导模型。 */
const fileAccessStore = createSessionScopedStore<Map<string, FileAccessRecord>>(
  () => new Map<string, FileAccessRecord>(),
  { inherit: false },
);

/**
 * 记录文件访问（由工具执行层调用）
 */
export function trackFileAccess(filePath: string, content?: string): void {
  const existing = fileAccessStore.get().get(filePath);
  fileAccessStore.get().set(filePath, {
    filePath,
    lastAccessedAt: Date.now(),
    content: content ?? existing?.content,
    accessCount: (existing?.accessCount ?? 0) + 1,
  });
}

/**
 * 压缩后清理追踪表中过旧的条目
 */
export function sweepFileAccessTracker(maxAgeMs: number = 10 * 60 * 1000): void {
  const cutoff = Date.now() - maxAgeMs;
  const keysToDelete: string[] = [];
  fileAccessStore.get().forEach((record, key) => {
    if (record.lastAccessedAt < cutoff) {
      keysToDelete.push(key);
    }
  });
  for (const key of keysToDelete) {
    fileAccessStore.get().delete(key);
  }
}

/**
 * 重置追踪器（测试用）
 */
export function resetFileAccessTracker(): void {
  fileAccessStore.get().clear();
}

// ============================================================================
// 技能追踪
// ============================================================================

interface SkillRecord {
  name: string;
  content: string;
  lastUsedAt: number;
}

/** 技能追踪同理 —— 按会话独立, 别把别的会话装的技能正文灌进来。 */
const skillsStore = createSessionScopedStore<Map<string, SkillRecord>>(
  () => new Map<string, SkillRecord>(),
  { inherit: false },
);

/**
 * 记录技能使用
 */
export function trackSkillInvocation(name: string, content: string): void {
  skillsStore.get().set(name, {
    name,
    content,
    lastUsedAt: Date.now(),
  });
}

/**
 * 重置技能追踪器
 */
export function resetSkillTracker(): void {
  skillsStore.get().clear();
}

// ============================================================================
// 未完成状态追踪 (计划 / 失败过的尝试) —— 连续性的核心
// ============================================================================

export interface WorkStateStep {
  content: string;
  status?: string;
}

interface FailureRecord { tool: string; brief: string; at: number }

/* 计划快照和失败记录改成按会话独立。
 *   这两样是"压缩后要回灌给模型"的内容 —— 全服务器共用一个 runtime 时, 会话 A 的计划
 *   会被回灌进会话 B 的上下文里 (模型于是照着别人的计划继续干)。运行时状态, inherit:false。 */
const workStateStore = createSessionScopedStore<{ current: { kind: 'plan' | 'todo'; steps: WorkStateStep[]; at: number } | null }>(
  () => ({ current: null }),
  { inherit: false },
);
/** 失败尝试按 `tool|brief` 去重 —— 同一个错反复出现只留最新一条, 否则回灌全是重复行。 */
const failuresStore = createSessionScopedStore<Map<string, FailureRecord>>(
  () => new Map<string, FailureRecord>(),
  { inherit: false },
);

/** 回灌的失败条数上限 —— 再多模型也不会逐条读, 只会挤掉计划。 */
const MAX_REINJECT_FAILURES = 6;
/** 单条失败摘要的字符上限 —— 只要"什么工具、为什么失败", 不要整段 stack。 */
const FAILURE_BRIEF_CHARS = 160;

/**
 * 记录当前计划/清单。全量替换 —— 传进来的就是最新全貌。
 * 空数组视为"计划已清空", 直接置 null, 免得回灌一段空清单误导模型。
 */
export function trackWorkState(kind: 'plan' | 'todo', steps: WorkStateStep[]): void {
  const cleaned = (steps ?? []).filter((s) => s && typeof s.content === 'string' && s.content.trim());
  workStateStore.get().current = cleaned.length ? { kind, steps: cleaned, at: Date.now() } : null;
}

/**
 * 记录一次工具失败 —— 让模型压缩后仍然知道"这条路走不通", 别再撞一次。
 */
export function trackToolFailure(tool: string, brief: string): void {
  const text = (brief ?? '').replace(/\s+/g, ' ').trim().slice(0, FAILURE_BRIEF_CHARS);
  if (!tool || !text) return;
  const key = `${tool}|${text}`;
  failuresStore.get().set(key, { tool, brief: text, at: Date.now() });
  /* 只留最近的若干条, 防长会话无限增长 */
  if (failuresStore.get().size > MAX_REINJECT_FAILURES * 4) {
    const sorted = [...failuresStore.get().entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [k] of sorted.slice(0, failuresStore.get().size - MAX_REINJECT_FAILURES * 4)) {
      failuresStore.get().delete(k);
    }
  }
}

export function resetWorkStateTracker(): void {
  workStateStore.get().current = null;
  failuresStore.get().clear();
}

/** 单测/诊断用 —— 看三个 tracker 里现在各有多少。
 *  必须把 files 也带上: 上一轮排查只报了 steps/failures, 结果"文件那条通没通"看不出来。 */
export function peekWorkState(): { steps: number; failures: number; files: number; skills: number } {
  return {
    steps: workStateStore.get().current?.steps.length ?? 0,
    failures: failuresStore.get().size,
    files: fileAccessStore.get().size,
    skills: skillsStore.get().size,
  };
}

/** 勾选框符号: 做完 / 进行中 / 受阻 / 待办 —— 跟 PlanStatusBar 同一套状态口径。 */
function statusMark(status?: string): string {
  const s = (status ?? 'pending').toLowerCase();
  if (s === 'completed' || s === 'done') return 'x';
  if (s === 'in_progress' || s === 'verifying') return '>';
  if (s === 'failed' || s === 'blocked') return '!';
  return ' ';
}

/**
 * 渲染未完成状态。返回 null 表示无可回灌内容。
 *
 * 刻意用 markdown 勾选框而不是 JSON: 它同时给人和模型看(压缩摘要卡里也可能露出),
 * 且比 JSON 省 token。
 */
function renderWorkState(): string | null {
  const parts: string[] = [];

  const work = workStateStore.get().current;
  if (work) {
    const { kind, steps } = work;
    const done = steps.filter((s) => statusMark(s.status) === 'x').length;
    const label = kind === 'plan' ? '当前计划' : '当前清单';
    parts.push(
      `## ${label} (${done}/${steps.length})\n`
      + steps.map((s) => `- [${statusMark(s.status)}] ${s.content}`).join('\n'),
    );
  }

  if (failuresStore.get().size) {
    const list = [...failuresStore.get().values()]
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_REINJECT_FAILURES);
    parts.push(
      '## 已经失败过的尝试 (不要原样重试)\n'
      + list.map((f) => `- ${f.tool}: ${f.brief}`).join('\n'),
    );
  }

  return parts.length ? parts.join('\n\n') : null;
}

// ============================================================================
// 核心：Post-compact 重注入
// ============================================================================

import { estimateTokens } from '../utils/tokenEstimate.js';
function roughTokenCount(text: string): number {
  return estimateTokens(text);
}

function truncateContent(content: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + '\n\n[... content truncated for post-compact re-injection ...]';
}

/**
 * 从保留的消息中提取已包含的文件路径（避免重复注入）
 */
function extractFilePathsFromMessages(messages: Message[]): Set<string> {
  const paths = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== 'tool') continue;
    const name = (msg as any).name || '';
    if (!name.includes('read') && !name.includes('edit') && !name.includes('write')) continue;

    // 尝试从对应的 tool_call 中提取路径
    // 简单回退：从 tool_call_id 对应的 assistant 消息中提取
    // 这里用 content 中的路径作为近似
    const content = getTextFromContent(msg.content);
    // 匹配常见路径模式
    const pathMatch = content.match(/(?:^|\s)((?:\/|\.\/|\.\.\/)[^\s\n]+)/);
    if (pathMatch) {
      paths.add(pathMatch[1]);
    }
  }
  return paths;
}

export interface PostCompactReinjectResult {
  /** 注入的文件数 */
  filesInjected: number;
  /** 注入的技能数 */
  skillsInjected: number;
  /** 是否注入了未完成状态 (计划 / 失败尝试) */
  workStateInjected: boolean;
  /** 只列路径不带内容的热文件条数 (file map) */
  pathsListed: number;
  /** 总注入 token 数 */
  totalTokens: number;
  /** 生成的注入消息 */
  messages: Message[];
}

/**
 * 生成 post-compact 重注入消息
 *
 * 在压缩完成后调用，生成包含最近文件内容和技能的消息，
 * 追加到压缩后的消息列表中。
 *
 * @param preservedMessages 压缩后保留的消息列表（用于去重）
 * @returns 重注入结果，包含要追加的消息
 */
export function generatePostCompactReinjectMessages(
  preservedMessages: Message[],
  /**
   * 本次可用于回灌的 token 上限。不传时退回固定 POST_COMPACT_TOKEN_BUDGET(50K)。
   *
   * 为什么要能传: 固定 50K 在小窗口上会把刚压完的上下文顶回阈值附近 ——
   * 128K 窗压缩阈值 95K, 压完若剩 40K, 再灌 50K 就是 90K, 下一轮几乎立刻又触发压缩,
   * 形成"压完就再压"的空转。调用方按真实余量传, 大窗口自然还是 50K 封顶。
   */
  budgetOverride?: number,
): PostCompactReinjectResult {
  const result: PostCompactReinjectResult = {
    filesInjected: 0,
    skillsInjected: 0,
    workStateInjected: false,
    pathsListed: 0,
    totalTokens: 0,
    messages: [],
  };

  let budgetRemaining = Math.max(
    0,
    Math.min(POST_COMPACT_TOKEN_BUDGET, budgetOverride ?? POST_COMPACT_TOKEN_BUDGET),
  );

  /* --- 0. 未完成状态 —— 必须排在文件/技能之前, 且**不吃预算** ---
   * 它最小(几百 token)且最不可替代: 文件内容还能靠重读拿回来, "我做到第几步 /
   * 哪条路已经走不通"一旦被折掉就真没了, 模型只能重猜或重踩。
   * 所以即使 budgetOverride 压到 0 也照灌 —— 真正该被预算挤掉的是下面的文件和技能。 */
  const workState = renderWorkState();
  if (workState) {
    const tokens = roughTokenCount(workState);
    result.messages.push({
      role: 'user',
      content:
        '[Post-compact work state — 这是压缩前的进度快照。压缩会折掉这些细节, 这里原样恢复。'
        + '继续时请接着未完成的步骤走, 不要重头再来, 也不要重试下面已失败的做法。]\n\n'
        + workState,
      name: 'PostCompactWorkState',
    });
    budgetRemaining -= tokens;
    result.totalTokens += tokens;
    result.workStateInjected = true;
  }

  // --- 1. 文件重注入 ---
  const alreadyInContext = extractFilePathsFromMessages(preservedMessages);

  // 按最近访问排序
  const allFiles: FileAccessRecord[] = [];
  fileAccessStore.get().forEach(r => allFiles.push(r));
  const sortedFiles = allFiles
    .filter(r => r.content && !alreadyInContext.has(r.filePath))
    .sort((a, b) => b.lastAccessedAt - a.lastAccessedAt)
    .slice(0, MAX_REINJECT_FILES);

  const fileParts: string[] = [];
  for (const file of sortedFiles) {
    if (budgetRemaining <= 0) break;

    const cap = Math.min(PER_FILE_TOKEN_CAP, budgetRemaining);
    const truncated = truncateContent(file.content!, cap);
    const tokens = roughTokenCount(truncated);

    fileParts.push(`### ${file.filePath}\n\`\`\`\n${truncated}\n\`\`\``);
    budgetRemaining -= tokens;
    result.filesInjected++;
    result.totalTokens += tokens;
  }

  if (fileParts.length > 0) {
    result.messages.push({
      role: 'user',
      content: `[Post-compact context restoration — ${fileParts.length} recently accessed files]\n\n${fileParts.join('\n\n')}`,
      name: 'PostCompactFileRestore',
    });
  }

  /* --- 1.5 热文件路径地图  ---
   * 8K 预算只装得下 ~2 个文件全文, 其余最近访问的文件此前**直接消失** —— 模型压缩后
   * 连"我刚才在哪几个文件里干活"都不知道, 只能盲搜重探。路径清单几乎免费 (~30 tok/条),
   * 给模型一张工作地图: 内容需要时 readfile 重读即可。
   * 跟 workState 同理由不吃预算 (可靠性 > 精确预算), 有 MAX_PATHLIST_ENTRIES 硬上限。 */
  const injectedContentPaths = new Set(sortedFiles.slice(0, result.filesInjected).map((f) => f.filePath));
  const pathListFiles = allFiles
    .filter((r) => !alreadyInContext.has(r.filePath) && !injectedContentPaths.has(r.filePath))
    .sort((a, b) => b.lastAccessedAt - a.lastAccessedAt)
    .slice(0, MAX_PATHLIST_ENTRIES);
  if (pathListFiles.length > 0) {
    const lines = pathListFiles.map(
      (r) => `- ${r.filePath}${r.accessCount > 1 ? ` (accessed ${r.accessCount}x)` : ''}`,
    );
    const text =
      '[Post-compact file map — 压缩前最近还操作过下列文件, 其内容已被折叠。'
      + '需要内容时用 readfile 重读, 不要凭记忆猜测这些文件的现状。]\n\n'
      + lines.join('\n');
    const tokens = roughTokenCount(text);
    result.messages.push({
      role: 'user',
      content: text,
      name: 'PostCompactFileMap',
    });
    result.pathsListed = pathListFiles.length;
    result.totalTokens += tokens;
  }

  // --- 2. 技能重注入 ---
  const allSkills: SkillRecord[] = [];
  skillsStore.get().forEach(s => allSkills.push(s));
  const sortedSkills = allSkills
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt);

  let skillBudget = Math.min(SKILL_TOTAL_BUDGET, budgetRemaining);
  const skillParts: string[] = [];

  for (const skill of sortedSkills) {
    if (skillBudget <= 0) break;

    const cap = Math.min(PER_SKILL_TOKEN_CAP, skillBudget);
    const truncated = truncateContent(skill.content, cap);
    const tokens = roughTokenCount(truncated);

    skillParts.push(`### Skill: ${skill.name}\n${truncated}`);
    skillBudget -= tokens;
    budgetRemaining -= tokens;
    result.skillsInjected++;
    result.totalTokens += tokens;
  }

  if (skillParts.length > 0) {
    result.messages.push({
      role: 'user',
      content: `[Post-compact skill restoration — ${skillParts.length} recently used skills]\n\n${skillParts.join('\n\n')}`,
      name: 'PostCompactSkillRestore',
    });
  }

  if (result.filesInjected > 0 || result.skillsInjected > 0 || result.workStateInjected || result.pathsListed > 0) {
    cliLogger.info('PostCompactReinject',
      `Reinjected workState=${result.workStateInjected} ${result.filesInjected} files + ${result.pathsListed} path-only + ${result.skillsInjected} skills ` +
      `(${(result.totalTokens / 1000).toFixed(1)}K tokens)`,
    );
  } else {
    /* 这条曾经是**恒定状态** —— 两个 tracker 没有任何调用方, 每次压缩后
     * 都静默注入 0 条。留一条 warn, 下次再断线能立刻看出来, 而不是又沉默几个月。 */
    cliLogger.warn('PostCompactReinject',
      'nothing to reinject — trackers are empty. 若压缩后模型明显失忆, 先查 runner 的 track* 调用是否还在。');
  }

  return result;
}

/**
 * Post-compact 清理（重置各种缓存状态）
 * 采用 兼容格式 runPostCompactCleanup
 */
export function runPostCompactCleanup(): void {
  // 清理 microCompact 状态（如果有缓存的话）
  // 清理过旧的文件追踪
  sweepFileAccessTracker();

  cliLogger.debug('PostCompactCleanup', 'Post-compact state cleanup completed');
}
