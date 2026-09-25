/**
 * BackgroundAgentManager - 后台任务 Agent 生命周期管理
 *
 * 管理在基础模式中以后台方式运行的任务 Agent：
 * - 启动/终止/查询
 * - 进度追踪（工具调用数、token 用量、最近活动）
 * - 完成通知
 */

import type { AgentRuntimeHost } from '../agentRuntimeHost.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { getGlobalUserHookRunner } from '../../core/userHooks.js';
import { getBackgroundTaskNotifier } from '../shell/backgroundTaskNotifier.js';
import { getAgentThreadContext } from '../agentThreadContext.js';
import { appendDiagLog } from './diagLogFile.js';
import { sendOsNotification } from '@neoxlabs/platform/platform/osNotifier.js';
import { readPlanMaxConcurrentAgents } from '../../platform/membershipCacheRead.js';
import { sizeSubAgentOutput } from './subAgentOutputSizing.js';

// ============================================================================
// Types
// ============================================================================

export interface AgentProgress {
  toolUseCount: number;
  outputTokens: number;
  recentActivities: Array<{ tool: string; description: string; timestamp: number }>;
  elapsed: number;
  /** 最近一次收到 runtime event 的时刻 —— 停滞判死的唯一依据, 初值 = startedAt。 */
  lastProgressAt: number;
}

export interface BackgroundAgentTask {
  agentId: string;
  /** 用户指定的可读名称（用于 SendMessage 路由） */
  name?: string;
  description: string;
  prompt: string;
  /** 发起该 agent 的 session ID */
  sessionId?: string;
  /** 实际模型名 (含继承来的) */
  model?: string;
  /** 实际 provider — 同一模型名可能有多家提供, 展示与排障都要它 */
  providerId?: string;
  /** true = 跟主 agent 同一个模型 (调用方没指定)。UI 据此决定要不要显示标签:
   *  继承的不显示, 否则每个子 agent 都挂个跟主力一样的标签, 纯噪音。 */
  modelInherited?: boolean;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  progress: AgentProgress;
  result?: string;
  error?: string;
  /** 是谁把它掐的 —— 见 AbortOrigin。缺省 'unknown' 而不是 'user': 缺省值不许替调用方
   *  断言"是用户干的", 那正是"超时被谎报成用户中断"那类 bug 的成因。 */
  abortOrigin?: AbortOrigin;
  startedAt: number;
  completedAt?: number;
  abortController: AbortController;
  /** Host 未就绪时暂存的消息 */
  pendingMessages: string[];
  /** 运行中的 runtime host，用于按 turn 注入消息 */
  runtimeHost?: AgentRuntimeHost;
  /** 是否已通知主 agent（防重复） */
  notified: boolean;
  changedFiles: Map<string, number>;
  synchronous?: boolean;
}

export interface BackgroundAgentInfo {
  agentId: string;
  /** 友好名称, register 时可选传入 */
  name?: string;
  /** 发起 session — UI bar 按 sessionId 过滤显示 */
  sessionId?: string;
  description: string;
  status: BackgroundAgentTask['status'];
  progress: AgentProgress;
  elapsed: number;
  /** 实际模型 / provider / 是否继承主 agent — 见 BackgroundAgentTask 上的说明 */
  model?: string;
  providerId?: string;
  modelInherited?: boolean;
}

export interface SendMessageDeliveryResult {
  accepted: boolean;
  injected: boolean;
  queuePosition?: number;
  pendingCount: number;
}

// ============================================================================
// Manager
// ============================================================================

const DEFAULT_MAX_CONCURRENT_BACKGROUND_AGENTS = 3;

let resolvedMaxConcurrentAgents: number | null = null;

function resolveMaxConcurrentAgents(): number {
  if (resolvedMaxConcurrentAgents !== null) return resolvedMaxConcurrentAgents;

  const fromEnv = Number(process.env.NEOX_MAX_CONCURRENT_AGENTS);
  if (Number.isFinite(fromEnv) && fromEnv >= 1) {
    resolvedMaxConcurrentAgents = Math.floor(fromEnv);
    return resolvedMaxConcurrentAgents;
  }

  let fromPlan: number | null = null;
  try {
    fromPlan = readPlanMaxConcurrentAgents();
  } catch {
    /* 读缓存不该让 agent 起不来 —— 回落默认 */
  }

  resolvedMaxConcurrentAgents =
    fromPlan !== null && Number.isFinite(fromPlan) && fromPlan >= 1
      ? Math.floor(fromPlan)
      : DEFAULT_MAX_CONCURRENT_BACKGROUND_AGENTS;
  return resolvedMaxConcurrentAgents;
}

/** 仅供测试: 清掉记忆化的值, 让下一次 resolve 重新读 env / 缓存。 */
export function __resetMaxConcurrentAgentsForTest(): void {
  resolvedMaxConcurrentAgents = null;
}

export function getMaxConcurrentAgents(): number {
  return resolveMaxConcurrentAgents();
}
/** 最多保留的最近活动数 */
const MAX_RECENT_ACTIVITIES = 5;
/**
 * 单个后台 agent 硬超时 (wall-clock)。**默认 0 = 无限制** —— 长任务不该被时长判死。
 * 需要时用 env NEOX_AGENT_HARD_TIMEOUT_MS 显式打开 (eval / CI 场景可能想要确定性上界)。
 */
const MAX_AGENT_RUNTIME_MS = Math.max(0, Number(process.env.NEOX_AGENT_HARD_TIMEOUT_MS ?? 0));
const MAX_AGENT_OUTPUT_TOKENS = Math.max(0, Number(process.env.NEOX_AGENT_MAX_OUTPUT_TOKENS ?? 2_000_000));
const NO_PROGRESS_ABORT_MS = Math.max(0, Number(process.env.NEOX_AGENT_NO_PROGRESS_MS ?? 5 * 60_000));
/** watchdog 扫描间隔 — 只在有 running 任务时活跃 */
const LIMIT_SWEEP_INTERVAL_MS = 30_000;
/** 终态 (completed/failed/aborted) 任务保留窗口 — 超过即可被惰性清理 */
const TERMINAL_TASK_RETENTION_MS = Math.max(0, Number(process.env.NEOX_AGENT_TASK_RETENTION_MS ?? 30 * 60_000));
/** 终态任务条数上限 — 窗口内爆量时只留最近 N 条 */
const TERMINAL_TASK_MAX = 50;

function formatQueuedMessageForAgent(message: string): string {
  return `<send_message from="main_agent">\n${message}\n</send_message>`;
}

/** 会改盘的工具名 (含别名) — 命中即记入 task.changedFiles */
const FILE_WRITE_TOOLS = new Set([
  'write_file', 'write', 'edit_file', 'edit', 'apply_patch',
  'delete_file', 'rename_file',
]);
/** changedFiles 收集上限 — 防跑飞 agent 把 map 撑爆 */
const CHANGED_FILES_CAP = 100;
/** completion XML / 尾注里最多列出的文件数 */
const CHANGED_FILES_DISPLAY_MAX = 30;

/** 从 tool_call_end 事件提取被写文件路径 */
function extractWrittenPath(event: any): string | null {
  const p = event?.targetPath
    ?? event?.args?.file_path ?? event?.args?.path ?? event?.args?.filePath;
  return typeof p === 'string' && p.trim() ? p.trim() : null;
}

/** 改动清单人类可读块 — 空清单返回 '' */
function formatChangedFilesBlock(task: BackgroundAgentTask): string {
  if (task.changedFiles.size === 0) return '';
  const entries = [...task.changedFiles.entries()];
  const shown = entries.slice(0, CHANGED_FILES_DISPLAY_MAX)
    .map(([p, n]) => (n > 1 ? `${p} (x${n})` : p));
  const more = entries.length > CHANGED_FILES_DISPLAY_MAX
    ? `\n... and ${entries.length - CHANGED_FILES_DISPLAY_MAX} more`
    : '';
  return shown.join('\n') + more;
}

// ────────────────────────────────────────────────────────────────────────
// 的 notifier 收件箱。主 agent 下一轮 LLM 前会自动 drain 到 user message,
// 无需轮询 / 主动 SendMessage 查。
// ────────────────────────────────────────────────────────────────────────

export type AbortOrigin = 'user' | 'watchdog' | 'system' | 'unknown';

/** abort 时挂在 Error 上的结构化随行信息 —— 下游据此分类, 不许嗅 message 文本。 */
export interface NeoxAbortInfo {
  origin: AbortOrigin;
  reason: string;
}

/** 从 AbortSignal.reason / Error 上把结构化 abort 信息读出来 (没有就是 undefined)。 */
export function readAbortInfo(reason: unknown): NeoxAbortInfo | undefined {
  const info = (reason as { neoxAbort?: NeoxAbortInfo } | null | undefined)?.neoxAbort;
  return info && typeof info.origin === 'string' ? info : undefined;
}

const AGENT_COMPLETION_TAG = 'agent-completion';
/** 后台完成通知里结果的字数上限 —— 通知会进主 agent 上下文, 多个并行 agent 一起回来不能把它撑爆 */
const AGENT_COMPLETION_SUMMARY_MAX = 2000;

function escapeXml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildTerminationBlock(task: BackgroundAgentTask): string {
  if (task.status === 'completed') return '';
  const origin = task.abortOrigin ?? (task.status === 'failed' ? 'system' : 'unknown');
  const byLabel = origin === 'user' ? '用户主动停止'
    : origin === 'watchdog' ? '运行时看门狗判死 (非用户操作)'
    : origin === 'system' ? '系统/运行错误'
    : '未记录 —— 不要据此判断是用户中断';
  const advice = origin === 'watchdog'
    ? '\n<retry-advice>原样重派大概率会再撞同一道闸。先按上面的原因调整范围或确认上游, 再决定要不要重派。</retry-advice>'
    : origin === 'user'
      ? '\n<retry-advice>用户主动停的, 不要自作主张重派。</retry-advice>'
      : '\n<retry-advice>终止原因不明, 重派前先确认上一次到底做到哪一步了。</retry-advice>';
  return `\n<terminated-by>${escapeXml(byLabel)}</terminated-by>${advice}`;
}

export function buildAgentCompletionXml(task: BackgroundAgentTask): string {
  const payload = task.status === 'completed'
    ? (task.result ?? '')
    /* 非正常收尾但没有任何原因文本时, 也不许留空 —— 空 summary 会让父 agent 自己脑补 */
    : (task.error || '(没有留下任何原因文本)');
  const summary = sizeSubAgentOutput(payload, { limit: AGENT_COMPLETION_SUMMARY_MAX, agentRole: task.name || 'background agent' }).output;
  const nameLine = task.name ? `\n<name>${escapeXml(task.name)}</name>` : '';
  /* 结构化改动清单 — 主 agent 据此定向抽查/发现并行 agent 的文件重叠, 不用盲读全仓 */
  const changedBlock = formatChangedFilesBlock(task);
  const changedLine = changedBlock ? `\n<changed-files>\n${escapeXml(changedBlock)}\n</changed-files>` : '';
  return `<${AGENT_COMPLETION_TAG}>
<agent-id>${escapeXml(task.agentId)}</agent-id>${nameLine}
<status>${task.status}</status>
<elapsed-seconds>${task.progress.elapsed}</elapsed-seconds>
<tool-use-count>${task.progress.toolUseCount}</tool-use-count>
<description>${escapeXml(task.description)}</description>${changedLine}${buildTerminationBlock(task)}
<summary>${escapeXml(summary)}</summary>
</${AGENT_COMPLETION_TAG}>`;
}

function notifySessionOfCompletion(task: BackgroundAgentTask): void {
  if (!task.sessionId) return;
  try {
    getBackgroundTaskNotifier().enqueueMessageForSession(
      task.sessionId,
      buildAgentCompletionXml(task),
      {
        command: `task-agent:${task.name || task.agentId}`,
        pid: 0,
        status: task.status === 'completed' ? 'completed'
          : task.status === 'failed' ? 'failed'
          : task.status === 'aborted' ? 'killed'
          : 'completed',
      },
    );
    cliLogger.info(
      'BG_AGENT',
      `Queued <${AGENT_COMPLETION_TAG}> for session ${task.sessionId}: ${task.agentId} ${task.status}`,
    );

    const label = task.name || task.agentId.slice(0, 10);
    const urgency = task.status === 'failed' ? 'error' : task.status === 'aborted' ? 'warning' : 'success';
    void sendOsNotification({
      title: task.status === 'completed' ? `✓ Agent "${label}" done` :
             task.status === 'failed' ? `✗ Agent "${label}" failed` :
             `⊘ Agent "${label}" aborted`,
      body: task.description.length > 80 ? task.description.slice(0, 80) + '…' : task.description,
      urgency,
    });
  } catch (err: any) {
    cliLogger.warn('BG_AGENT', `Failed to enqueue completion notification: ${err?.message ?? err}`);
  }
}

/* 活着的 manager —— 让"这个会话还有没有子 agent 在跑"能被续跑闸这类跨模块的地方问到,
 * 不用把 manager 实例一层层往下传 (buildRunner 拿不到它)。runtime 关停时 abortAll 摘掉。 */
const LIVE_MANAGERS = new Set<BackgroundAgentManager>();

export function hasRunningSubAgents(sessionId?: string): boolean {
  for (const m of LIVE_MANAGERS) {
    try {
      if (m.listActive(sessionId).length > 0) return true;
    } catch { /* 单个 manager 出错不影响判断 */ }
  }
  return false;
}

export class BackgroundAgentManager {
  private tasks = new Map<string, BackgroundAgentTask>();
  /** 名称 → agentId 映射（支持 SendMessage 按名称路由） */
  private nameRegistry = new Map<string, string>();
  /** 后台 agent 完成时的通知回调 */
  private onComplete?: (task: BackgroundAgentTask) => void;
  /** 生命周期事件回调 — UI bar 通过 SSE 订阅 (started/updated/done/aborted).
   *  在 register / status 变化 / abort 时触发. agenticRuntime 把它桥到 EventBus. */
  private onLifecycle?: (kind: 'started' | 'updated' | 'done' | 'aborted', task: BackgroundAgentTask) => void;
  /** 见 register: agentId 同时是子会话 id, 必须**全局**唯一, 不能只查内存. */
  private isAgentIdTaken?: (agentId: string) => boolean;

  constructor(opts?: {
    onComplete?: (task: BackgroundAgentTask) => void;
    onLifecycle?: (kind: 'started' | 'updated' | 'done' | 'aborted', task: BackgroundAgentTask) => void;
    /** agentId 是否已被历史占用 (落库的子会话) — 见 register 里的说明. 不传则只查内存. */
    isAgentIdTaken?: (agentId: string) => boolean;
  }) {
    this.onComplete = opts?.onComplete;
    this.onLifecycle = opts?.onLifecycle;
    this.isAgentIdTaken = opts?.isAgentIdTaken;
    LIVE_MANAGERS.add(this);
  }

  /**
   * 注册一个新的后台 agent 任务
   *
   * @param opts.synchronous 同步前台模式 — 仍出 lifecycle 事件 (画 bar / 建子会话),
   *   但 complete 时跳过 <agent-completion> XML 注入 (前台已经把 result 同步返给父了).
   *   背景: agentTool 前台分支之前根本不 register, UI 看不见任何 sub-agent 痕迹.
   */
  findDuplicateRunning(description: string, prompt: string, sessionId?: string): BackgroundAgentTask | null {
    const norm = (s: string) => (s || '').toLowerCase().replace(/\s+/g, '').replace(/[，。,.、:：;；!！?？]/g, '');
    const d = norm(description);
    const p = norm(prompt);
    if (!d && !p) return null;

    let similar: BackgroundAgentTask | null = null;
    for (const task of this.tasks.values()) {
      if (task.status !== 'running') continue;
      if (sessionId && task.sessionId && task.sessionId !== sessionId) continue;
      const td = norm(task.description);
      const tp = norm(task.prompt);
      if ((d && td === d) || (p && tp === p)) return task;
      /* 近似: 描述互为前缀/包含且长度接近 —— 只记不拦 */
      if (d && td && (td.includes(d) || d.includes(td))
          && Math.min(d.length, td.length) / Math.max(d.length, td.length) > 0.6) {
        similar = task;
      }
    }
    if (similar) {
      cliLogger.warn('BG_AGENT',
        `near-duplicate dispatch (未拦截): 新任务「${description}」与运行中的 ${similar.agentId}「${similar.description}」高度相似`);
    }
    return null;
  }

  /* ─── 终态任务惰性清理 ─────────────────────────────────────────── */

  /** 从两张 Map 里摘掉一个任务 — nameRegistry 只删仍指向该 agentId 的映射 (重名后注册的不动) */
  private removeTask(task: BackgroundAgentTask): void {
    this.tasks.delete(task.agentId);
    if (task.name && this.nameRegistry.get(task.name) === task.agentId) {
      this.nameRegistry.delete(task.name);
    }
  }

  /**
   * 惰性清理终态任务 — register / 各查询入口顺手调用, 无常驻定时器。
   * running 永不动; 终态任务超过保留窗口, 或窗口内条数超上限 (按 completedAt 留最新
   * TERMINAL_TASK_MAX 条) 的删除。被删任务的 <agent-completion> 通知早已在进入终态时发出。
   */
  private sweepTerminalTasks(): void {
    const now = Date.now();
    const retained: BackgroundAgentTask[] = [];
    for (const task of this.tasks.values()) {
      if (task.status === 'running') continue;
      if (now - (task.completedAt ?? task.startedAt) > TERMINAL_TASK_RETENTION_MS) {
        this.removeTask(task);
      } else {
        retained.push(task);
      }
    }
    if (retained.length > TERMINAL_TASK_MAX) {
      retained.sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
      for (const task of retained.slice(0, retained.length - TERMINAL_TASK_MAX)) {
        this.removeTask(task);
      }
    }
  }

  register(
    agentId: string,
    description: string,
    prompt: string,
    sessionId?: string,
    name?: string,
    opts?: {
      synchronous?: boolean;
      /** 子 agent 实际跑的模型 — 不传则 UI 侧无从显示 (见 BackgroundAgentTask.model) */
      model?: string;
      providerId?: string;
      modelInherited?: boolean;
    },
  ): BackgroundAgentTask {
    this.sweepTerminalTasks();
    const running = this.listActive().length;
    if (running >= resolveMaxConcurrentAgents()) {
      throw new Error(
        `后台 agent 已达并发上限 (${resolveMaxConcurrentAgents()} 个同时运行)。`
        + `这一个没有派出去 —— 要么等已在跑的完成后再派，要么这部分自己直接做掉。`
        + `不要重复派发同一个任务。`,
      );
    }

    // 捕获 AgentThreadDepthExceededError 作为 tool 失败返回给 LLM。
    getAgentThreadContext().checkCanSpawnOrThrow(`background agent "${name || description.slice(0, 60)}"`);
    const _tc = getAgentThreadContext() as Partial<ReturnType<typeof getAgentThreadContext>>;
    appendDiagLog('THREAD_DEPTH_GATE', {
      currentDepth: _tc.getCurrentDepth?.() ?? null,
      childDepth: _tc.getNextChildDepth?.() ?? null,
      maxSeen: _tc.getMaxDepth?.() ?? null,
    });

    let finalAgentId = agentId;
    const taken = (id: string): boolean => {
      if (this.tasks.has(id)) return true;
      try {
        return this.isAgentIdTaken?.(id) === true;
      } catch {
        /* 查不动就退回只查内存 — 不能因为存储层抖动把派活整个挡掉 */
        return false;
      }
    };
    if (taken(finalAgentId)) {
      let suffix = 2;
      while (taken(`${agentId}#${suffix}`)) suffix++;
      finalAgentId = `${agentId}#${suffix}`;
      cliLogger.warn('BG_AGENT',
        `register collision: ${agentId} already taken (memory or persisted child session), renaming new task to ${finalAgentId}.`);
    }
    const task: BackgroundAgentTask = {
      agentId: finalAgentId,
      name,
      description,
      prompt,
      sessionId,
      model: opts?.model,
      providerId: opts?.providerId,
      modelInherited: opts?.modelInherited,
      status: 'running',
      progress: {
        toolUseCount: 0,
        outputTokens: 0,
        recentActivities: [],
        elapsed: 0,
        lastProgressAt: Date.now(),
      },
      startedAt: Date.now(),
      abortController: new AbortController(),
      pendingMessages: [],
      runtimeHost: undefined,
      notified: false,
      changedFiles: new Map(),
      synchronous: opts?.synchronous === true,
    };
    this.tasks.set(finalAgentId, task);

    /* SubagentStart —— 通知式, 不 await: 派子 agent 是热路径, 不该等用户脚本。
     * matcherKey 用子 agent 的类型/名字, 于是 hook 能只管某一类 (比如只审计 reviewer)。 */
    void (async () => {
      try {
        const hooks = getGlobalUserHookRunner();
        if (!hooks?.hasHooksFor('SubagentStart')) return;
        await hooks.fire('SubagentStart', {
          payload: {
            matcherKey: name || finalAgentId,
            agent_id: finalAgentId, name, description,
            model: opts?.model, session_id: sessionId,
          },
        });
      } catch (err: any) {
        cliLogger.warn('HOOKS', `SubagentStart hook 出错: ${err?.message}`);
      }
    })();
    if (name) {
      if (!this.nameRegistry.has(name)) {
        this.nameRegistry.set(name, finalAgentId);
        cliLogger.info('BG_AGENT', `Registered: ${finalAgentId} (name="${name}") — ${description}`);
      } else {
        cliLogger.warn('BG_AGENT',
          `name collision: "${name}" already mapped to ${this.nameRegistry.get(name)}, ${finalAgentId} not bound to name. send_message(to:"${name}") still goes to original.`);
      }
    } else {
      cliLogger.info('BG_AGENT', `Registered: ${finalAgentId} — ${description}`);
    }
    try { this.onLifecycle?.('started', task); } catch { /* lifecycle 不能影响主流程 */ }
    this.ensureLimitWatchdog();
    return task;
  }

  // ─── 止损护栏: 硬超时 + token 熔断 ─────────────────────────────

  private limitWatchdogTimer?: ReturnType<typeof setInterval>;

  /** 有 running 任务时保持一个低频扫描器; 全部结束自动停, 不常驻。 */
  private ensureLimitWatchdog(): void {
    if (this.limitWatchdogTimer) return;
    if (MAX_AGENT_RUNTIME_MS <= 0 && MAX_AGENT_OUTPUT_TOKENS <= 0 && NO_PROGRESS_ABORT_MS <= 0) return;
    this.limitWatchdogTimer = setInterval(() => this.sweepLimits(), LIMIT_SWEEP_INTERVAL_MS);
    (this.limitWatchdogTimer as any)?.unref?.();
  }

  private sweepLimits(): void {
    const now = Date.now();
    let anyRunning = false;
    for (const task of this.tasks.values()) {
      if (task.status !== 'running') continue;
      anyRunning = true;
      if (MAX_AGENT_RUNTIME_MS > 0 && now - task.startedAt > MAX_AGENT_RUNTIME_MS) {
        const mins = Math.round(MAX_AGENT_RUNTIME_MS / 60_000);
        cliLogger.warn('BG_AGENT', `Hard timeout: ${task.agentId} exceeded ${mins}min, aborting`);
        this.abort(task.agentId,
          `硬超时终止: 运行超过 ${mins} 分钟 (${task.progress.toolUseCount} 工具已执行)。任务可能卡死或范围过大, 可拆小后重派`,
          false, 'watchdog');
      } else if (this.isStalled(task, now)) {
        const idleSecs = Math.round((now - task.progress.lastProgressAt) / 1000);
        const ranSecs = Math.round((now - task.startedAt) / 1000);
        cliLogger.warn('BG_AGENT',
          `Stall stop: ${task.agentId} idle ${idleSecs}s (ran ${ranSecs}s, ${task.progress.toolUseCount} tools), aborting`);
        this.abort(task.agentId,
          `停滞终止: 已经 ${Math.round(idleSecs / 60)} 分钟没有任何工具调用、也没有任何输出` +
          `(此前跑了 ${ranSecs} 秒, 执行过 ${task.progress.toolUseCount} 次工具调用)。` +
          `通常是上游请求挂起或模型空转 —— **不是任务太大**, 拆小重派没用, ` +
          `先确认上游连通, 或把任务改写得更具体后再派。`,
          false, 'watchdog');
      } else if (this.exceedsTokenBudget(task)) {
        this.abortForTokenBudget(task);
      }
    }
    if (!anyRunning && this.limitWatchdogTimer) {
      clearInterval(this.limitWatchdogTimer);
      this.limitWatchdogTimer = undefined;
    }
  }

  private exceedsTokenBudget(task: BackgroundAgentTask): boolean {
    return MAX_AGENT_OUTPUT_TOKENS > 0 && task.progress.outputTokens > MAX_AGENT_OUTPUT_TOKENS;
  }

  private isStalled(task: BackgroundAgentTask, now: number): boolean {
    if (NO_PROGRESS_ABORT_MS <= 0) return false;
    return now - task.progress.lastProgressAt > NO_PROGRESS_ABORT_MS;
  }

  private abortForTokenBudget(task: BackgroundAgentTask): void {
    cliLogger.warn('BG_AGENT',
      `Token budget exceeded: ${task.agentId} output ${task.progress.outputTokens} > ${MAX_AGENT_OUTPUT_TOKENS}, aborting`);
    this.abort(task.agentId,
      `Token 熔断终止: 输出 ${Math.round(task.progress.outputTokens / 1000)}k 超过上限 ${Math.round(MAX_AGENT_OUTPUT_TOKENS / 1000)}k。任务范围可能失控, 建议拆分`,
      false, 'watchdog');
  }

  /** 前台同步 task 超时后转后台: 保留同一个 task/host/abortController/进度, 只切换通知语义. */
  markBackgrounded(agentId: string): boolean {
    const task = this.tasks.get(agentId);
    if (!task || task.status !== 'running') return false;
    if (!task.synchronous) return true;
    task.synchronous = false;
    task.progress.elapsed = Math.floor((Date.now() - task.startedAt) / 1000);
    cliLogger.info('BG_AGENT', `Marked foreground task as backgrounded: ${agentId}`);
    try { this.onLifecycle?.('updated', task); } catch { /* lifecycle 不能影响主流程 */ }
    return true;
  }

  /** 心跳/进度更新 — runtime 内部周期调一下, UI bar 更新 elapsed 用. */
  emitProgress(agentId: string): void {
    const task = this.tasks.get(agentId);
    if (!task || task.status !== 'running') return;
    task.progress.elapsed = Math.floor((Date.now() - task.startedAt) / 1000);
    try { this.onLifecycle?.('updated', task); } catch { /* ignore */ }
  }

  // ─── 名称注册表 ─────────────────────────────────────────────────

  /** 按名称或 agentId 查找任务 */
  resolveAgent(nameOrId: string): BackgroundAgentTask | undefined {
    const byId = this.tasks.get(nameOrId);
    if (byId) return byId;
    const id = this.nameRegistry.get(nameOrId);
    return id ? this.tasks.get(id) : undefined;
  }

  /** 获取名称注册表快照 */
  getNameRegistry(): ReadonlyMap<string, string> {
    return this.nameRegistry;
  }

  // ─── SendMessage 消息投递 ───────────────────────────────────────

  /** 向运行中 agent 暂存消息（仅在 runtime host 未就绪时使用） */
  queueMessage(agentId: string, message: string): boolean {
    const task = this.tasks.get(agentId);
    if (!task || task.status !== 'running') return false;
    const PENDING_MESSAGES_CAP = 32;
    if (task.pendingMessages.length >= PENDING_MESSAGES_CAP) {
      cliLogger.warn('BG_AGENT',
        `pendingMessages cap (${PENDING_MESSAGES_CAP}) reached for ${agentId}, dropping oldest. Host likely stuck — investigate.`);
      task.pendingMessages.shift(); // 丢最老的, 保最新
    }
    task.pendingMessages.push(message);
    cliLogger.info('BG_AGENT', `Message queued for ${agentId} (${task.pendingMessages.length} pending)`);
    return true;
  }

  /** 在 host 就绪后，把暂存消息按 turn 注入其输入队列 */
  private flushPendingMessages(task: BackgroundAgentTask): number {
    const host = task.runtimeHost;
    if (!host || task.pendingMessages.length === 0) {
      return 0;
    }

    const pending = [...task.pendingMessages];
    task.pendingMessages = [];
    let injectedCount = 0;

    for (const msg of pending) {
      const position = host.injectUserMessage(formatQueuedMessageForAgent(msg));
      if (position > 0) {
        injectedCount++;
      } else {
        task.pendingMessages.push(msg);
      }
    }

    if (injectedCount > 0) {
      cliLogger.info('BG_AGENT', `Flushed ${injectedCount} queued message(s) into ${task.agentId} runtime queue`);
    }

    return injectedCount;
  }

  /** 绑定运行中的 runtime host，后续 send_message 直接走 host turn-queue */
  attachRuntimeHost(agentId: string, runtimeHost: AgentRuntimeHost): boolean {
    const task = this.tasks.get(agentId);
    if (!task) return false;
    task.runtimeHost = runtimeHost;
    const flushed = this.flushPendingMessages(task);
    cliLogger.info('BG_AGENT', `Attached runtime host for ${agentId}${flushed > 0 ? `, flushed ${flushed} pending` : ''}`);
    return true;
  }

  /**
   * 向运行中 agent 投递消息：
   * - runtime host 已就绪：直接注入 host 的 pendingInjectedMessages（下个 turn 处理）
   * - host 未就绪：先本地暂存，待 host 就绪时立即 flush
   */
  deliverMessage(agentId: string, message: string): SendMessageDeliveryResult {
    const task = this.tasks.get(agentId);
    if (!task || task.status !== 'running') {
      return {
        accepted: false,
        injected: false,
        pendingCount: task?.pendingMessages.length ?? 0,
      };
    }

    if (task.runtimeHost) {
      const queuePosition = task.runtimeHost.injectUserMessage(formatQueuedMessageForAgent(message));
      if (queuePosition > 0) {
        cliLogger.info('BG_AGENT', `Message injected for ${agentId} (queue position ${queuePosition})`);
        return {
          accepted: true,
          injected: true,
          queuePosition,
          pendingCount: task.pendingMessages.length,
        };
      }

      cliLogger.warn('BG_AGENT', `Runtime host rejected injected message for ${agentId}, falling back to local queue`);
    }

    task.pendingMessages.push(message);
    cliLogger.info('BG_AGENT', `Message locally queued for ${agentId} (${task.pendingMessages.length} pending)`);
    return {
      accepted: true,
      injected: false,
      pendingCount: task.pendingMessages.length,
    };
  }

  /** 在旧实现/调试场景下获取并清空待处理消息 */
  drainMessages(agentId: string): string[] {
    const task = this.tasks.get(agentId);
    if (!task || task.pendingMessages.length === 0) return [];
    const drained = [...task.pendingMessages];
    task.pendingMessages = [];
    cliLogger.info('BG_AGENT', `Drained ${drained.length} messages for ${agentId}`);
    return drained;
  }

  /**
   * 更新进度（由 onRuntimeEvent 回调调用）
   */
  updateProgress(agentId: string, event: any): void {
    const task = this.tasks.get(agentId);
    if (!task || task.status !== 'running') return;

    task.progress.elapsed = Math.floor((Date.now() - task.startedAt) / 1000);
    /* 停滞判死的唯一喂食点。刻意放在最前、不挑事件类型:
     * 挑窄了 (只认 tool_call_start) 会把"正在流式吐一大段文本"误判成停滞 —— 那正是
     * 墙钟犯过的错。只要 runtime 还在发事件, 它就还活着。 */
    task.progress.lastProgressAt = Date.now();

    const isToolStart = event.type === 'tool_call_start' || event.eventType === 'tool_call_start'
      || event.type === 'tool_call' || event.eventType === 'tool_call';
    if (isToolStart) {
      task.progress.toolUseCount++;
      const toolName = event.toolName || event.name || 'unknown';
      const desc = event.description || event.title || toolName;
      task.progress.recentActivities.push({
        tool: toolName,
        description: typeof desc === 'string' ? desc.substring(0, 80) : toolName,
        timestamp: Date.now(),
      });
      if (task.progress.recentActivities.length > MAX_RECENT_ACTIVITIES) {
        task.progress.recentActivities.shift();
      }
    }

    // 改动文件收集 — tool_call_end 带 targetPath/args, 成功的写工具计入清单
    if (event.type === 'tool_call_end' && event.success !== false
        && FILE_WRITE_TOOLS.has(String(event.name || '').toLowerCase())) {
      const p = extractWrittenPath(event);
      if (p && (task.changedFiles.has(p) || task.changedFiles.size < CHANGED_FILES_CAP)) {
        task.changedFiles.set(p, (task.changedFiles.get(p) ?? 0) + 1);
      }
    }

    // 更新 token 用量
    if (event.type === 'token_usage' && typeof event.outputTokens === 'number') {
      task.progress.outputTokens = event.outputTokens;
      /* token 熔断即时检查 — 不等 30s watchdog 扫描, 超限当场止损 */
      if (this.exceedsTokenBudget(task)) {
        this.abortForTokenBudget(task);
      } else {
        /* token 数变了发一次 updated — UI 状态条把子 agent 用量并进显示。
         * token_usage 每子回合一次, 频率低, 不用节流。 */
        try { this.onLifecycle?.('updated', task); } catch { /* ignore */ }
      }
    }
  }

  /**
   * 标记任务完成（原子通知：notified 标志防重复）
   */
  complete(agentId: string, result: string): void {
    const task = this.tasks.get(agentId);
    if (!task) return;
    if (task.status !== 'running') {
      cliLogger.warn('BG_AGENT', `Ignoring complete for non-running task ${agentId} (${task.status})`);
      return;
    }
    if (task.pendingMessages.length > 0) {
      cliLogger.warn('BG_AGENT', `Completing ${agentId} with ${task.pendingMessages.length} undelivered queued message(s)`);
    }
    task.status = 'completed';
    void (async () => {
      try {
        const hooks = getGlobalUserHookRunner();
        if (!hooks?.hasHooksFor('SubagentStop')) return;
        await hooks.fire('SubagentStop', {
          payload: {
            matcherKey: task.name || task.agentId,
            agent_id: task.agentId, name: task.name,
            tool_use_count: task.progress?.toolUseCount ?? 0,
            elapsed_ms: Date.now() - task.startedAt,
            session_id: task.sessionId,
          },
        });
      } catch (err: any) {
        cliLogger.warn('HOOKS', `SubagentStop hook 出错: ${err?.message}`);
      }
    })();
    task.result = result;
    task.completedAt = Date.now();
    task.progress.elapsed = Math.floor((task.completedAt - task.startedAt) / 1000);
    task.runtimeHost = undefined;
    task.pendingMessages = [];
    cliLogger.info('BG_AGENT', `Completed: ${agentId} (${task.progress.elapsed}s, ${task.progress.toolUseCount} tools)`);
    if (!task.notified) {
      task.notified = true;
      this.onComplete?.(task);
      if (!task.synchronous) {
        notifySessionOfCompletion(task);
      }
    }
    try { this.onLifecycle?.('done', task); } catch { /* ignore */ }
  }

  /**
   * 标记任务失败（原子通知）
   */
  fail(agentId: string, error: string, origin: AbortOrigin = 'system'): void {
    const task = this.tasks.get(agentId);
    if (!task) return;
    if (task.status !== 'running') {
      cliLogger.warn('BG_AGENT', `Ignoring fail for non-running task ${agentId} (${task.status})`);
      return;
    }
    if (task.pendingMessages.length > 0) {
      cliLogger.warn('BG_AGENT', `Failing ${agentId} with ${task.pendingMessages.length} undelivered queued message(s)`);
    }
    task.status = 'failed';
    task.error = error;
    task.abortOrigin = origin;
    task.completedAt = Date.now();
    task.progress.elapsed = Math.floor((task.completedAt - task.startedAt) / 1000);
    task.runtimeHost = undefined;
    task.pendingMessages = [];
    cliLogger.warn('BG_AGENT', `Failed: ${agentId} — ${error}`);
    if (!task.notified) {
      task.notified = true;
      this.onComplete?.(task);
      if (!task.synchronous) {
        notifySessionOfCompletion(task);
      }
    }
    try { this.onLifecycle?.('done', task); } catch { /* ignore */ }
  }

  /**
   * 终止任务。reason 缺省为用户主动终止; 超时/token 熔断传具体原因,
   * 经 task.error → <agent-completion> / 子会话 final 透传给主 agent 和 UI。
   */
  abort(agentId: string, reason?: string, silent = false, origin: AbortOrigin = 'unknown'): boolean {
    const task = this.tasks.get(agentId);
    if (!task || task.status !== 'running') return false;
    /* 没给原因时**不许**编一句"user aborted" —— 那是在替调用方断言是用户干的。
     * 如实说"原因未记录", 并落一条 warn 好让人回头把调用点补上。 */
    if (!reason) {
      cliLogger.warn('BG_AGENT',
        `abort(${agentId}) 没带原因 (origin=${origin}) —— 父 agent 将收到"原因未记录", 请在调用点补上`);
    }
    const recorded = reason || (origin === 'user' ? '用户停止' : '终止原因未记录 (调用方未提供)');
    /* origin 挂在 Error 上结构化带走 —— 下游 (agentTool / UI) 要区分"用户按了停止"和
     * "看门狗判死"时, 只能读这个字段, 不许去嗅 message 里的中文。文案随时会改,
     * 嗅文本的判断迟早失效, 而失效的方向恰好是"当成用户中断" —— 正是要根除的那类谎报。 */
    task.abortController.abort(Object.assign(new Error(recorded), {
      neoxAbort: { origin, reason: recorded },
    }));
    try { task.runtimeHost?.interrupt(); } catch { /* host 已经收摊就算了, 不能挡住后面的状态收尾 */ }
    task.status = 'aborted';
    task.abortOrigin = origin;
    task.error = recorded;
    task.completedAt = Date.now();
    task.progress.elapsed = Math.floor((task.completedAt - task.startedAt) / 1000);
    task.runtimeHost = undefined;
    task.pendingMessages = [];
    cliLogger.info('BG_AGENT', `Aborted: ${agentId}`);
    if (!task.notified && !task.synchronous && !silent) {
      task.notified = true;
      notifySessionOfCompletion(task);
    } else if (silent) {
      /* 标记成已通知, 免得后续路径又补一条唤醒 */
      task.notified = true;
      cliLogger.info('BG_AGENT', `Aborted silently (user stop): ${agentId}`);
    }
    try { this.onLifecycle?.('aborted', task); } catch { /* ignore */ }
    return true;
  }

  /**
   * 终止指定 session 的所有运行中任务
   */
  /** 用户按停止 / 会话中断 —— 静默中止, 绝不投递唤醒通知 (见 abort 的 silent 说明)。 */
  abortBySession(sessionId: string): void {
    for (const task of this.tasks.values()) {
      if (task.status === 'running' && task.sessionId === sessionId) {
        this.abort(task.agentId, '用户停止了这个会话', true, 'user');
      }
    }
  }

  abortForegroundBySession(sessionId: string, reason = '本轮已结束, 前台子 agent 一并收工'): number {
    let killed = 0;
    for (const task of this.tasks.values()) {
      if (task.status === 'running' && task.synchronous === true && task.sessionId === sessionId) {
        if (this.abort(task.agentId, reason, true)) killed += 1;
      }
    }
    return killed;
  }

  /**
   * 终止所有运行中的任务（runtime 关停时调用）
   */
  abortAll(): void {
    for (const task of this.tasks.values()) {
      if (task.status === 'running') {
        this.abort(task.agentId, 'runtime shutdown', true);
      }
    }
    LIVE_MANAGERS.delete(this);
  }

  /**
   * 查询进度
   */
  getProgress(agentId: string): AgentProgress | null {
    const task = this.tasks.get(agentId);
    if (!task) return null;
    if (task.status === 'running') {
      task.progress.elapsed = Math.floor((Date.now() - task.startedAt) / 1000);
    }
    return { ...task.progress };
  }

  /**
   * 获取结果
   */
  getResult(agentId: string): { status: BackgroundAgentTask['status']; result?: string; error?: string } | null {
    this.sweepTerminalTasks();
    const task = this.tasks.get(agentId);
    if (!task) return null;
    return { status: task.status, result: task.result, error: task.error };
  }

  /**
   * 列出活跃任务. 可选 sessionId 过滤 — UI bar 只关心当前 session 起的 sub-agent.
   */
  listActive(sessionId?: string): BackgroundAgentInfo[] {
    const now = Date.now();
    return Array.from(this.tasks.values())
      .filter(t => t.status === 'running')
      .filter(t => !sessionId || t.sessionId === sessionId)
      .map(t => ({
        agentId: t.agentId,
        name: t.name,
        sessionId: t.sessionId,
        description: t.description,
        status: t.status,
        progress: { ...t.progress, elapsed: Math.floor((now - t.startedAt) / 1000) },
        elapsed: Math.floor((now - t.startedAt) / 1000),
        model: t.model,
        providerId: t.providerId,
        modelInherited: t.modelInherited,
      }));
  }

  /**
   * 列出所有任务（包括已完成）— 只含保留窗口内的终态任务 (超窗已被惰性清理)
   */
  listAll(): BackgroundAgentInfo[] {
    this.sweepTerminalTasks();
    return Array.from(this.tasks.values()).map(t => ({
      agentId: t.agentId,
      name: t.name,
      sessionId: t.sessionId,
      description: t.description,
      status: t.status,
      progress: { ...t.progress },
      elapsed: t.progress.elapsed,
      model: t.model,
      providerId: t.providerId,
      modelInherited: t.modelInherited,
    }));
  }

  /**
   * 获取 abort signal（用于传给任务 Agent）
   */
  getAbortSignal(agentId: string): AbortSignal | undefined {
    return this.tasks.get(agentId)?.abortController.signal;
  }

  /** 改动文件尾注 — 同步 agent 的 tool result 末尾附上, 与 completion XML 同源同格式 */
  getChangedFilesNote(agentId: string): string {
    const task = this.tasks.get(agentId);
    if (!task) return '';
    const block = formatChangedFilesBlock(task);
    return block ? `\n\n[Changed files]\n${block}` : '';
  }

  /**
   * 清理已完成的任务（释放内存）
   */
  clearCompleted(): number {
    let cleared = 0;
    for (const [id, task] of this.tasks.entries()) {
      if (task.status !== 'running') {
        this.tasks.delete(id);
        cleared++;
      }
    }
    return cleared;
  }
}
