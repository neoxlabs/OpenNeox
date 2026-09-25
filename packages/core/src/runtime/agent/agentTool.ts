/**
 * AgentTool - 基础模式通用任务 Agent 工具
 *
 * 主 agent 通过 type 参数选择不同类型的任务 Agent：
 * - explore: 只读代码探索（search/read）
 * - code: 代码编辑（edit/write，无 shell）— 默认
 * - shell: 全能执行（读写 + shell + 测试）
 * - plan: 架构规划（只读 + 分析输出）
 *
 * 每种类型有独立的工具白名单和系统提示，能力边界约束让 LLM 更聚焦。
 */

import { execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import type { ShortTermMemory } from '@neoxlabs/kernel/memory/shortterm.js';
import type { PermissionManager } from '@neoxlabs/kernel/core/permissions/index.js';
import type { RuntimeOrchestrator } from '../runtimeOrchestrator.js';
import type { AgentRuntimeHost } from '../agentRuntimeHost.js';
import type { BackgroundAgentManager } from './backgroundAgent.js';
import { getMaxConcurrentAgents, readAbortInfo } from './backgroundAgent.js';
import { ShortTermMemory as STM } from '@neoxlabs/kernel/memory/shortterm.js';
import { buildParentContext } from './parentContext.js';
import { AgentMode } from '@neoxlabs/kernel/core/runner.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { sizeSubAgentOutput } from './subAgentOutputSizing.js';
import { getAgentType, getAvailableAgentTypes, isKnownAgentType, resolveAgentTools, buildAgentTypesPrompt, DEFAULT_AGENT_TYPE_ID } from './agentTypes.js';
import { createReportToConductorTool } from './reportToConductorTool.js';
import { getSessionSnapshot } from '../sessionSnapshot.js';
import { captureTaskAgentRuntimeError, resolveTaskAgentRunError } from './taskAgentRunFailure.js';
import { appendDiagLog } from './diagLogFile.js';
import { runWithReadScope } from '../../tools/smart-read/readLedger.js';
import type { AgentTypeDefinition } from './agentTypes.js';

// ============================================================================
// Options
// ============================================================================

/** 一个"现在真的能派出去"的模型。 */
export interface AvailableModel {
  /** 派发时填进 `model` 参数的那个字符串 */
  id: string;
  /** 来路 —— 订阅档位下发的, 还是用户自己配 key 的 provider */
  source: 'subscription' | 'byok';
  /** 给主 agent 的取舍线索 (如 "轻/快")。只给认得出的, 认不出就不写 —— 编一个比不写更糟。 */
  hint?: string;
}

export interface AgentToolOptions {
  orchestrator: RuntimeOrchestrator;
  providerId: string;
  modelName: string;
  permissionManager: PermissionManager;
  allTools: Tool[];
  workDir: string;
  getParentMemory: () => ShortTermMemory;
  abortSignal?: AbortSignal;
  onTaskAgentEvent?: (agentId: string, event: any, tracker?: any) => void;
  backgroundManager: BackgroundAgentManager;
  /** 模型别名解析 (e.g. 'haiku' → 实际模型名) */
  resolveModelAlias?: (alias: string) => { providerId: string; modelName: string } | null;
  /** 这一刻**真的能用**的模型清单 —— 订阅档位下发的 + 已配 key 的 BYOK provider 的, 合起来。
   *
   *  没有它的时候, `model` 参数是一个自由字符串: 主 agent 只能猜名字, 猜错了
   *  resolveModelAlias 返回 null, 然后**静默继承主模型** —— 用户看到的是
   *  "我让它用重模型审计, 它答应了, 结果根本没用"。
   *  给了清单之后 model 参数变成 enum (协议层就拒绝错的名字), 描述里也列出来带取舍。
   *  返回空数组 = 这一刻问不出来 (membership 缓存冷 / 没配 provider), 那时保持自由字符串,
   *  不能因为列不出来就把这个能力关掉。 */
  listAvailableModels?: () => AvailableModel[];
  /** 用户为当前主模型配的子 Agent 默认模型 —— 派发时求值 (工具随 host 缓存, 传值会过期) */
  getTaskAgentRoute?: () => { providerId: string; modelName: string } | null;
  /** 当前 session ID（用于后台 agent 结果回注） */
  sessionId?: string;
  /**
   * 主 agent 的已渲染 system prompt（稳定部分）。
   * 任务 Agent 复用此前缀 + 追加类型专属指令，实现 prompt cache 共享。
   * 不传则由任务 Agent 独立构建完整 prompt。
   */
  parentRenderedPrompt?: string;
  /** 父 session ID — 用来从 sessionSnapshot 拉 cache-safe 快照, 跟 cacheHealthMonitor 联动观测. */
  parentSessionId?: string;
  allowBackgroundAgents?: boolean;
  /**
   * 按 agent 类型追加的工具池 (name 去重, allTools 优先) — 突破模式收口的**唯一**豁免口。
   * 场景: Life 模式 modeTools 裁掉了 browser 55 工具, 但 online 型子 agent 干活需要 —
   * 传 { online: 全量 tools }, resolveAgentTools 的类型白名单会再裁一道, 不会泄漏无关工具。
   */
  extraToolsForType?: Record<string, Tool[]>;
}

// ============================================================================
// Constants
// ============================================================================

const AGENT_HARD_TIMEOUT_MS = Math.max(0, Number(process.env.NEOX_AGENT_HARD_TIMEOUT_MS ?? 0));

/* 停滞判死不在这个文件里 —— 唯一的判死者是 backgroundAgent 的 sweepLimits
 * (`NEOX_AGENT_NO_PROGRESS_MS`, 默认 5 分钟)。前台 agent 也 register 进那个 manager,
 * 所以前台/后台共用同一条判据、同一套文案。别在这里再加第二个看门狗。 */

/** 用户**显式**设了 NEOX_AGENT_HARD_TIMEOUT_MS 吗 — 显式值要盖过类型默认, 否则调了等于没调。 */
const HARD_TIMEOUT_EXPLICIT = Number.isFinite(Number(process.env.NEOX_AGENT_HARD_TIMEOUT_MS))
  && String(process.env.NEOX_AGENT_HARD_TIMEOUT_MS ?? '').trim() !== '';

/** 这个 agent 类型这一次实际用哪个墙钟上限, 0 = 不限时。显式 env 优先, 否则用类型默认。 */
export function resolveAgentTimeoutMs(typeMaxRuntimeMs: number | undefined): number {
  if (HARD_TIMEOUT_EXPLICIT) return AGENT_HARD_TIMEOUT_MS;
  return Math.max(0, typeMaxRuntimeMs ?? 0) || AGENT_HARD_TIMEOUT_MS;
}

/* 软 abort 到硬 reject 之间的宽限期.
 *   到 timeoutMs 先 abort signal(协作式取消, 能拿到部分产出); 再等这么久,
 *   若 runSession 仍不 settle 说明它根本没响应 signal, 直接 Promise.race 掉。
 *   30s 足够一次流式请求收尾, 又不至于让卡死的 agent 拖太久。*/
const HARD_TIMEOUT_GRACE_MS = Number(process.env.NEOX_AGENT_HARD_TIMEOUT_GRACE_MS || 30_000);

/* 2.5: sub-agent 递归深度上限 — 防 LLM 自己 spawn 自己 spawn 自己... 把 token 烧光.
 *   3 层够用 (main → 任务 agent → 任务的子 agent), 再深 99% 是 prompt 设计问题.
 *   AsyncLocalStorage 跟 async context, 并发 sub-agent 各自独立计数, 不撞. */
import { AsyncLocalStorage } from 'node:async_hooks';
const MAX_AGENT_NESTING_DEPTH = Number(process.env.NEOX_AGENT_MAX_DEPTH || 3);
const agentDepthStore = new AsyncLocalStorage<number>();

// ============================================================================
// Worktree isolation — Team P1: 模块级注册表 + 自动清理 + 合并后清理导出
// ============================================================================

export interface AgentWorktreeInfo {
  /** worktree 目录 */
  path: string;
  /** worktree 分支名 */
  branch: string;
  /** 主仓库根 (git rev-parse --show-toplevel) — 清理时 git 命令的 cwd, 不依赖 process.cwd() */
  gitRoot: string;
}

/* agentId → 存活 worktree。子 agent 完成且无改动的当场删掉;
 * 有改动的保留在此注册表里, 等 Team 合并后调 cleanupWorktree(agentId) 收尾。 */
const activeAgentWorktrees = new Map<string, AgentWorktreeInfo>();

/**
 * 创建隔离 worktree。全部 git 命令用显式 cwd — 不碰 process.chdir, 并发安全。
 * 失败 (非 git repo / git 异常) 返回 null, 调用方降级为共享 workspace。
 */
export async function createAgentWorktree(workDir: string): Promise<AgentWorktreeInfo | null> {
  try {
    const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: workDir, encoding: 'utf-8', timeout: 10_000 }).trim();
    /* 时间戳+随机后缀 — 同一毫秒并发创建两个 worktree 也不撞名 */
    const slug = `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const branchName = `neox-worktree/${slug}`;
    const parentDir = path.dirname(gitRoot);
    const repoName = path.basename(gitRoot);
    const worktreePath = path.join(parentDir, `.${repoName}-worktrees`, slug);
    const worktreeParent = path.dirname(worktreePath);
    if (!fs.existsSync(worktreeParent)) {
      fs.mkdirSync(worktreeParent, { recursive: true });
    }
    execFileSync('git', ['worktree', 'add', '-b', branchName, worktreePath], { cwd: gitRoot, encoding: 'utf-8', timeout: 30_000 });
    cliLogger.info('AGENT_TOOL', `Worktree created: ${worktreePath}`);
    return { path: worktreePath, branch: branchName, gitRoot };
  } catch (error: any) {
    cliLogger.warn('AGENT_TOOL', `Worktree creation failed: ${error.message}`);
    return null;
  }
}

/** 登记 agentId → worktree (register 撞名改名后以最终 agentId 登记)。 */
export function registerAgentWorktree(agentId: string, info: AgentWorktreeInfo): void {
  activeAgentWorktrees.set(agentId, info);
}

/**
 * 子 agent 完成时的自动清理:
 *   - 无改动 → 删 worktree + 分支, 注册表移除, 返回空串;
 *   - 有改动 → 保留 worktree (注册表保留, 等 Team 合并后 cleanupWorktree),
 *     返回带路径+分支名的注记, 拼进回传给主 agent 的结果。
 */
export function finishAgentWorktree(agentId: string, info: AgentWorktreeInfo | null): string {
  if (!info) return '';
  try {
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: info.path, encoding: 'utf-8', timeout: 10_000 }).trim();
    if (!status) {
      removeAgentWorktree(info);
      activeAgentWorktrees.delete(agentId);
      cliLogger.info('AGENT_TOOL', `Worktree cleaned up (no changes): ${info.path}`);
      return '';
    }
    cliLogger.info('AGENT_TOOL', `Worktree kept (has changes): ${info.path} on ${info.branch}`);
    return `\n\n[Worktree: ${info.path} (branch: ${info.branch})]`;
  } catch (error: any) {
    cliLogger.error('AGENT_TOOL', `Worktree cleanup failed: ${error.message}`);
    return '';
  }
}

/**
 * 查询 agentId 名下存活的 worktree (Team P2 team_run 汇聚用) —
 * lane 完成且有改动时 worktree 保留在注册表, team_run 据此拿分支名进合并指引。
 * 只读, 不动注册表。
 */
export function getAgentWorktree(agentId: string): AgentWorktreeInfo | null {
  return activeAgentWorktrees.get(agentId) ?? null;
}

/**
 * Team 合并后清理入口: 无条件强删 agentId 名下的 worktree + 分支。
 * 返回是否真的清掉了 (agentId 无登记 → false)。
 */
export function cleanupWorktree(agentId: string): boolean {
  const info = activeAgentWorktrees.get(agentId);
  if (!info) return false;
  activeAgentWorktrees.delete(agentId);
  try {
    removeAgentWorktree(info);
    cliLogger.info('AGENT_TOOL', `Worktree cleanup (post-merge): removed ${info.path} (${info.branch})`);
    return true;
  } catch (error: any) {
    cliLogger.error('AGENT_TOOL', `Worktree cleanup (post-merge) failed: ${error.message}`);
    return false;
  }
}

function removeAgentWorktree(info: AgentWorktreeInfo): void {
  execFileSync('git', ['worktree', 'remove', info.path, '--force'], { cwd: info.gitRoot, encoding: 'utf-8', timeout: 30_000 });
  try {
    execFileSync('git', ['branch', '-D', info.branch], { cwd: info.gitRoot, encoding: 'utf-8', timeout: 10_000 });
  } catch { /* 分支可能已被删/被 checkout, 不阻塞 */ }
}

// ============================================================================
// Tool
// ============================================================================

/** 把清单写成一行给模型看。带来路和取舍, 不带就只有一串名字, 它还是不知道该挑哪个。 */
export function describeAvailableModels(models: AvailableModel[]): string {
  return models
    .map(m => `${m.id}${m.hint ? ` (${m.hint})` : ''}${m.source === 'byok' ? ' [BYOK]' : ''}`)
    .join(', ');
}

export function createAgentTool(opts: AgentToolOptions): Tool {
  let counter = 0;

  /* 工具是**每轮重建**的 (agenticRuntime 在每次 run 里调 createAgenticModeTools),
   * 所以这里取一次就是这一轮的真实情况: 中途换订阅档位 / 加一个 provider, 下一轮就跟上。
   * 拿不到就是空数组 —— 那时 model 参数保持自由字符串, 不能因为列不出来就关掉这个能力。 */
  const availableModels: AvailableModel[] = (() => {
    try { return opts.listAvailableModels?.() ?? []; }
    catch { return []; }
  })();

  /** 执行单个任务 Agent */
  const runAgent = async (
    agentId: string,
    prompt: string,
    description: string,
    agentType: AgentTypeDefinition,
    agentAbortSignal: AbortSignal,
    providerId: string = opts.providerId,
    modelName: string = opts.modelName,
    /** 工作目录覆盖（worktree 隔离时传入，避免 process.chdir 并发问题） */
    workDirOverride?: string,
    onHostReady?: (host: AgentRuntimeHost) => void,
  ): Promise<{ output: string; toolCount: number; error?: string; timedOut?: boolean }> => {
    /* 子 agent 会话 id — 提前到工具组装之前: report_to_conductor 要带上它作 bus fromSessionId */
    const sessionId = `agent_${agentId}_${Date.now()}`;
    /* 审批档跟父会话走: 用户在父会话开了 dangerous, 子 agent 不该再弹卡 */
    if (opts.parentSessionId) opts.permissionManager.inheritScope(sessionId, opts.parentSessionId);

    // 按 agent 类型裁剪工具集 (extraToolsForType: 类型专属追加池, name 去重 allTools 优先)
    const extraForType = opts.extraToolsForType?.[agentType.id];
    let toolSource = opts.allTools;
    if (extraForType?.length) {
      const seen = new Set(opts.allTools.map(t => t.name));
      toolSource = [...opts.allTools, ...extraForType.filter(t => !seen.has(t.name))];
    }
    /* Team P1 (§3.4): 成员→Conductor 单向上报工具。父 sessionId 已知才有投递目标;
     *   注入工具池后仍走 resolveAgentTools 的类型白名单裁剪 (agentTypes.ts 已放行),
     *   ALWAYS_EXCLUDED 不含它 — 再委派仍被禁, 通信只上行。 */
    if (opts.sessionId && !toolSource.some(t => t.name === 'report_to_conductor')) {
      toolSource = [...toolSource, createReportToConductorTool({
        conductorSessionId: opts.sessionId,
        agentSessionId: sessionId,
        agentId,
      })];
    }
    const tools = resolveAgentTools(toolSource, agentType);
    const parentContext = buildParentContext(opts.getParentMemory());
    const memory = new STM();
    const timeoutMs = resolveAgentTimeoutMs(agentType.config.maxRuntimeMs);

    const effectiveWorkDir = workDirOverride || opts.workDir;

    // 作为前缀复用（API 侧 prompt cache 命中），仅追加类型专属后缀
    const typeSuffix = agentType.buildSystemPrompt(effectiveWorkDir, '', description, prompt);
    const systemPrompt = opts.parentRenderedPrompt
      ? `${opts.parentRenderedPrompt}\n\n---\n\n## Sub-Agent 专属指令\n\n${typeSuffix}`
      : agentType.buildSystemPrompt(effectiveWorkDir, parentContext, description, prompt);

    cliLogger.info('AGENT_TOOL', `${agentId} [${agentType.id}] started`, {
      description,
      prompt: prompt.substring(0, 80),
      toolCount: tools.length,
      toolNames: tools.map(t => t.name).join(', '),
    });

    /* cache-safe 快照对比 — 跟 cacheHealthMonitor 联动: sub-agent 启动时记录
     * 跟父 snapshot 的差异 (model / cwd / tools 数 / system prompt 是否复用),
     * 之后看 CACHE_HEALTH warn 时能定位是 sub-agent 的 fork 把 cache 带飞还是别的. */
    if (opts.parentSessionId) {
      const parent = getSessionSnapshot(opts.parentSessionId);
      if (parent) {
        const sharedPromptPrefix = !!opts.parentRenderedPrompt
          && opts.parentRenderedPrompt === parent.renderedSystemPrompt;
        cliLogger.info('AGENT_TOOL', `${agentId} cache-safe diff vs parent`, {
          modelMatch: parent.model === modelName,
          cwdMatch: parent.workspacePath === effectiveWorkDir,
          parentToolCount: parent.liveTools.length,
          subAgentToolCount: tools.length,
          sharedPromptPrefix,
        });
      }
    }

    let toolCount = 0;
    let lastRuntimeError: string | undefined;
    /* 自己超时 vs 被父 signal 顺带拉走 —— catch 里必须分得开。
     * 光看 error 分不出: 两者都是 AbortError, 而下面 catch 的 AbortError 分支排在
     * isTimeout 判断**之前**, 会把自超时也吞成裸 'aborted'。这个标记是唯一可靠证据。
     * (声明在 try 外, catch 才看得见。) */
    let selfTimedOut = false;

    try {
      const localAbort = new AbortController();
      /* 墙钟闸: 默认 0 = 不装。只有显式配了上限才有这个定时器。 */
      const timeout = timeoutMs > 0
        ? setTimeout(() => {
          if (!localAbort.signal.aborted) {
            selfTimedOut = true;
            armHardTimeout();
            localAbort.abort(new Error(`agent timeout after ${Math.round(timeoutMs / 1000)}s`));
          }
        }, timeoutMs)
        : undefined;


      let hardTimerId: ReturnType<typeof setTimeout> | undefined;
      let rejectHard: ((err: Error) => void) | undefined;
      const armHardTimeout = () => {
        if (hardTimerId) return;
        hardTimerId = setTimeout(
          () => rejectHard?.(new Error('agent aborted (hard: abort 未被响应)')),
          HARD_TIMEOUT_GRACE_MS,
        );
        if (typeof hardTimerId?.unref === 'function') hardTimerId.unref();
      };
      const hardTimeout = new Promise<never>((_, reject) => { rejectHard = reject; });

      const parentAbortHandler = () => {
        if (localAbort.signal.aborted) return;
        /* 父级停止同样要挂硬兜底 —— 否则子 agent 卡在不响应 signal 的 await 上时,
         * 用户按了停止界面还得一直转。 */
        armHardTimeout();
        const upstream = (agentAbortSignal as { reason?: unknown }).reason;
        localAbort.abort(upstream instanceof Error ? upstream : new Error('parent aborted'));
      };
      if (agentAbortSignal.aborted) {
        parentAbortHandler();
      } else {
        agentAbortSignal.addEventListener('abort', parentAbortHandler, { once: true });
      }

      try {
        /* 2.5: 在 runSession 调用上 wrap depthStore.run(+1, ...) — sub-agent 内的 agent 工具
         *   实例化时 agentDepthStore.getStore() 拿到的就是 currentDepth+1, 达到 MAX 自动 fail.
         *   async context 自然延伸到子 agent 的整个 LLM loop / tool calls. */
        const nextDepth = (agentDepthStore.getStore() ?? 0) + 1;
        const runPromise = runWithReadScope(sessionId, () => agentDepthStore.run(nextDepth, () => opts.orchestrator.runSession({
          sessionId,
          prompt,
          providerId,
          modelName,
          abortSignal: localAbort.signal,
          onHostReady,
          buildHostConfig: (provider, llmConfig) => ({
            sessionId,
            configKey: `agent_${agentId}`,
            provider,
            llmConfig: { ...llmConfig, runtimeMode: 'agentic' as const },
            workspacePath: effectiveWorkDir,
            workDir: effectiveWorkDir,
            instructions: systemPrompt,
            systemPrompt,
            agentName: agentId,
            agentDescription: `${agentType.name}: ${description}`,
            permissionManager: opts.permissionManager,
            tools,
            memory,
            agentConfig: {
              temperature: agentType.config.temperature,
              mode: AgentMode.AUTO,
              maxIterations: agentType.config.maxIterations,
              maxRuntimeMs: timeoutMs,
            },
            sessionEnabled: false,
            disableSystemPrompt: true,
          }),
          onRuntimeEvent: (event, tracker) => {
            /* 停滞看门狗的喂食走下面那句 backgroundManager.updateProgress —— 它对
             * 每个 event 都会刷 lastProgressAt。这里不再自己记一份时间, 免得两份漂移。 */
            lastRuntimeError = captureTaskAgentRuntimeError(event, lastRuntimeError);
            if (event.type === 'tool_call_start') {
              toolCount++;
              opts.onTaskAgentEvent?.(agentId, {
                type: 'worker_event',
                agentId,
                eventType: 'tool_progress',
                workerRole: agentType.name,
                isAgentTool: true,
                timestamp: Date.now(),
                toolName: event.name,
                toolArgs: event.args,
              });

            }
            opts.backgroundManager.updateProgress(agentId, event);
            opts.onTaskAgentEvent?.(agentId, {
              ...event,
              workerRole: agentType.name,
              isAgentTool: true,
              workerTask: description.substring(0, 60),
            }, tracker);
          },
        })));
        /* 输掉 race 的那个 promise 仍会在后台跑完/抛错 —— 挂个 no-op catch,
         * 否则硬超时后它抛出来就是 unhandledRejection. */
        runPromise.catch(() => {});
        const result = await Promise.race([runPromise, hardTimeout]);

        let runError = resolveTaskAgentRunError(result.summary, lastRuntimeError, 'task-agent run failed');
        /* 这一轮到底是不是"撞上限被停" —— 结构化带出去, 下游不用嗅文本 */
        let runTimedOut = false;
        if (runError?.startsWith('aborted')) {
          const rawReason = (localAbort.signal as { reason?: unknown }).reason;
          const abortReason = String((rawReason as { message?: string } | undefined)?.message ?? '');
          /* 看门狗判死走结构化字段 (backgroundManager.abort 挂的 neoxAbort), 不嗅文案。
           * 它的 reason 已经写清了是停滞还是 token 熔断, 原样透传比在这里再编一遍准。 */
          const abortInfo = readAbortInfo(rawReason);
          if (abortInfo?.origin === 'watchdog') {
            runTimedOut = true;
            runError = `${abortInfo.reason} (已执行 ${toolCount} 次工具调用)`;
          } else if (abortInfo?.origin === 'user') {
            /* 用户按了停止 —— 这不是错误, 也不该建议重派。 */
            runError = `用户停止了这个子 agent (已执行 ${toolCount} 次工具调用)`;
          } else if (selfTimedOut || abortReason.includes('agent timeout')) {
            const secs = Math.round(timeoutMs / 1000);
            runTimedOut = true;
            cliLogger.warn('AGENT_TOOL', `[TIMEOUT] ${agentId} hit maxRuntimeMs ${secs}s (${toolCount} tools)`);
            runError = `timeout (${secs}s): 子 agent 撞到自身运行时上限被停止, 已执行 ${toolCount} 次工具调用。`
              + `这不是它的结论有问题, 而是没跑完 —— 要么把任务拆小重派, 要么这一块自己接手做。`
              + `原样重派只会再撞一次同样的上限。`;
          }
        }
        if (runError && runTimedOut) {
          const partial = (result.summary.output || '').trim();
          if (partial) {
            runError += `\n\n【被停止前已完成的部分, 可直接接着用】\n${partial}`;
          }
        }
        if (runError) {
          /* 诊断: agent 工具失败完整 dump (devtools console + /tmp/neox-explore-debug.log) */
          const failPayload = {
            error: runError,
            lastRuntimeError,
            toolCount,
            descriptionPreview: description.substring(0, 120),
            summary: {
              failed: !!result.summary.failed,
              interrupted: !!result.summary.interrupted,
              outputPreview: (result.summary.output || '').substring(0, 500),
              outputLen: (result.summary.output || '').length,
              iterations: (result.summary as any).iterations,
              tokenUsage: (result.summary as any).tokenUsage,
            },
          };
          console.error(`[AGENT_TOOL_FAIL] ${agentId} [${agentType.id}]`, failPayload);
          appendDiagLog(`AGENT_TOOL_FAIL/${agentId}/${agentType.id}`, failPayload);
          cliLogger.warn('AGENT_TOOL', `${agentId} [${agentType.id}] failed`, {
            toolCount,
            error: runError,
            output: (result.summary.output || '').substring(0, 200),
            failed: !!result.summary.failed,
            interrupted: !!result.summary.interrupted,
          });
          return { output: '', toolCount, error: runError, timedOut: runTimedOut };
        }

        cliLogger.info('AGENT_TOOL', `${agentId} [${agentType.id}] completed`, {
          toolCount,
          output: (result.summary.output || '').substring(0, 200),
        });
        /* 静默 empty 兜底:
         *   task-agent 跑完没报 runError, 但 summary.output 为空 (常见 case: 模型见到
         *   'test/hi/测试' 这种太宽泛的 prompt, 一轮就 stop, 0 token / 0 tool / 0 text).
         *
         *   旧实现返字面 '(no output)' — 没信息量, 主 agent 看到后多半也 stop empty,
         *   层层传染最终触发 RUNNER_ERROR.
         *
         *   新实现: 返一段对模型友好的诊断文案, 让主 agent 知道"task-agent 啥也没干",
         *   能自行决定是 (a) 直接给用户答复 (b) 改 prompt 重派 (c) 自己接手做.
         *   不会再走到 RUNNER_ERROR. */
        const out = result.summary.output || '';
        if (!out.trim() && toolCount === 0) {
          const hint =
            `Sub-agent (${agentType.name}) completed without producing any output ` +
            `(0 tools called, 0 text). This usually means the prompt was too vague — ` +
            `the model didn't know what specific work to do. ` +
            `\n\nOriginal prompt: ${description.substring(0, 200)}` +
            `\n\nNext step: either give the user the best answer from existing context, ` +
            `or re-issue \`agent\` with a more concrete task description.`;
          return { output: hint, toolCount };
        }
        return { output: out || '(no output)', toolCount };
      } finally {
        if (timeout) clearTimeout(timeout);
        if (hardTimerId) clearTimeout(hardTimerId);
        agentAbortSignal.removeEventListener('abort', parentAbortHandler);
      }
    } catch (error: any) {
      /* 看门狗判死的 throw 路径 —— 跟上面 race 路径同一套判据 (结构化 origin, 不嗅文本) */
      const thrownAbortInfo = readAbortInfo((agentAbortSignal as { reason?: unknown }).reason);
      if (thrownAbortInfo?.origin === 'watchdog') {
        return {
          output: '',
          toolCount,
          error: `${thrownAbortInfo.reason} (已执行 ${toolCount} 次工具调用)`,
          timedOut: true,
        };
      }
      if (selfTimedOut) {
        const secs = Math.round(timeoutMs / 1000);
        cliLogger.warn('AGENT_TOOL', `[TIMEOUT] ${agentId} hit maxRuntimeMs ${secs}s (${toolCount} tools)`);
        return {
          output: '',
          toolCount,
          error: `timeout (${secs}s): 子 agent 撞到自身运行时上限被停止, 已执行 ${toolCount} 次工具调用。`
            + `这不是它的结论有问题, 而是没跑完 —— 要么把任务拆小重派, 要么这一块自己接手做。`,
          timedOut: true,
        };
      }
      if (error.name === 'AbortError' || agentAbortSignal.aborted) {
        const info = {
          agent: `${agentId}[${agentType.id}]`,
          parentSignalAborted: agentAbortSignal.aborted,
          parentReason: (agentAbortSignal as any).reason?.message,
          errorName: error?.name,
          errorMessage: error?.message,
          toolCount,
        };
        cliLogger.warn('AGENT_TOOL', `[ABORT] ${agentId}`, info);
        console.warn('[ABORT] agentTool child aborted', info);
        return { output: '', toolCount, error: 'aborted' };
      }
      /* 硬兜底 reject 路径: 软 abort 发出后 GRACE 时间内 runSession 仍不 settle
       * (卡在不响应 signal 的 fetch/流上)。这里 timeoutMs 可能是 0 (不限时模式),
       * 别再拿它拼文案 —— 会印出 "timeout (0s)" 这种自相矛盾的话。 */
      const isHardAbort = typeof error?.message === 'string'
        && (error.message.includes('agent timeout') || error.message.includes('agent aborted'));
      if (isHardAbort) {
        return {
          output: '',
          toolCount,
          error: `子 agent 被停止后 ${Math.round(HARD_TIMEOUT_GRACE_MS / 1000)}s 内没有响应取消 (上游请求卡死), `
            + `已强制收尾, 已执行 ${toolCount} 次工具调用。`,
          timedOut: true,
        };
      }
      /* 诊断: throw 路径完整 stack + cause (devtools console + /tmp/neox-explore-debug.log) */
      const throwPayload = {
        name: error?.name,
        message: error?.message,
        stack: error?.stack,
        cause: (error as any)?.cause,
        code: (error as any)?.code,
        category: (error as any)?.category,
        toolCount,
      };
      console.error(`[AGENT_TOOL_THROW] ${agentId} [${agentType.id}]`, throwPayload);
      appendDiagLog(`AGENT_TOOL_THROW/${agentId}/${agentType.id}`, throwPayload);
      cliLogger.error('AGENT_TOOL', `${agentId} [${agentType.id}] failed`, { error: error.message });
      return { output: '', toolCount, error: error.message };
    }
  };


  // ====================
  // Tool definition
  // ====================

  return {
    name: 'agent',
    description: `Launch a task-agent to do a substantial, self-contained chunk of work.

⚠️ Dispatching costs 1-3 minutes of startup + context transfer, and the sub-agent CANNOT see your conversation. Doing it yourself is usually faster and always better-informed. Delegate only when the work is big enough to pay that back.

DON'T dispatch when:
- You could finish it yourself in a few tool calls (reading a known file, one edit, a single test run) — just do it.
- It needs context only you have (what the user actually meant, decisions made earlier in this conversation).
- You'd immediately sit idle waiting for it — that's strictly slower than doing it inline.
- An agent is already running the same task. Re-dispatching does NOT speed it up; it creates two agents writing the same files.

DO dispatch when:
- The work is long AND separable (a whole subsystem, a broad refactor, a wide search across many files).
- You have 2+ such chunks touching DIFFERENT files and can genuinely work in parallel.


⚠️ HARD LIMIT: at most ${getMaxConcurrentAgents()} agents run at once (foreground ones count too). Dispatching beyond that FAILS with an error — the extra agent is simply not created. If you have more chunks than that, dispatch ${getMaxConcurrentAgents()} and do the rest yourself, or wait for one to report before dispatching the next. Never dispatch more than the limit and hope.

⚠️ Parallel dispatch boundaries: agents write to the SHARED workspace with NO cross-agent file locks. Partition parallel tasks by file/directory so no two agents touch the same file. If task B depends on task A's output (e.g. views need routes' new params), dispatch B AFTER A's completion notice — not in parallel.

Defaults to code. Agents run in the background by default, so you keep working and get notified when one finishes; pass run_in_background=false only when the next step strictly depends on its output. Completion reports include a changed-files list — use it to spot-verify and detect overlap.

A dispatched agent is still running until you get its <agent-completion>. "Still running" is NOT failure — never re-dispatch to "retry" it.`,
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'A 3-5 word summary of the task',
        },
        prompt: {
          type: 'string',
          description: 'Detailed task instructions. Be specific, with clear completion criteria.',
        },
        type: {
          type: 'string',
          enum: getAvailableAgentTypes().map(t => t.id),
          description: 'Agent type. code=code editing, no shell (default) | shell=code editing plus shell commands and tests | plan=architecture design, read-only | research=deep research in isolation, writes REQUIREMENTS.md only | verify=runs and verifies your changes, read+execute but no writes | online=drives the embedded browser for interactive web tasks, stops at payment/login/captcha',
        },
        model: {
          type: 'string',
          ...(availableModels.length > 0 ? { enum: availableModels.map(m => m.id) } : {}),
          description: 'Optional model override. Omit it to inherit the main agent\'s model, which is usually right. '
            + 'Downgrade only when the subtask really is simple and mechanical, and only to **a lighter model in the same generation** '
            + '(e.g. 5.6-sol → 5.6-luna). Do not drop a generation to a previous mini — that noticeably lowers output quality.'
            + (availableModels.length > 0
              ? `\nAvailable right now (nothing else will work): ${describeAvailableModels(availableModels)}`
              : ''),
        },
        name: {
          type: 'string',
          description: 'Optional agent name, used to reference it from SendMessage (e.g. "researcher"). Auto-assigned as Agent-N when omitted.',
        },
        run_in_background: {
          type: 'boolean',
          default: true,
          description: 'Default true (background): returns immediately so you can keep working; you are notified when the agent finishes. '
            + 'This is the point of delegating — a foreground agent blocks you until it is done, which is rarely better than doing the work yourself. '
            + 'Pass false only when the very next step strictly depends on its output and you have nothing else to do meanwhile.',
        },
        auto_background_ms: {
          type: 'number',
          description: 'Milliseconds after which a foreground agent automatically moves to the background. If it has not finished by then, it continues in the background.',
        },
        isolation: {
          type: 'string',
          enum: ['worktree'],
          description: 'Set to "worktree" to work in an isolated git branch.',
        },
      },
      required: ['description', 'prompt'],
    },
    async function(args: any, context?: { signal?: AbortSignal }) {
      const description: string = args.description || 'Sub-agent task';
      const prompt: string = args.prompt;
      /* 归一化 typeId: trim + toLowerCase.
       *   Registry map key 是 lowercase (code/shell/plan/verify), buildAgentTypesPrompt 也告诉 LLM 用 lowercase,
       *   但 LLM 偶尔发 "Code" / "PLAN". 单点归一化避免 106 次/日 "Unknown agent type" 白 iter. */
      const rawTypeId: string | undefined = args.type;
      const typeId: string | undefined = rawTypeId ? String(rawTypeId).trim().toLowerCase() : undefined;
      const agentName: string | undefined = args.name;
      /* 一次性宿主 (neox -p) 不允许后台 agent: 降级为前台同步等待, 否则 turn 一结束进程就退,
       * 子 agent 被杀、产出全丢且退出码 0。降级只影响调度方式, 工作照做, 对模型是透明的。 */
      const backgroundAllowed = opts.allowBackgroundAgents !== false;
      const runInBackground: boolean = args.run_in_background !== false && backgroundAllowed;
      if (args.run_in_background !== false && !backgroundAllowed) {
        cliLogger.info('AGENT_TOOL', 'run_in_background 降级为前台 (一次性宿主不支持后台 agent)');
      }
      const isolation: string | undefined = args.isolation;
      const rawOutput: boolean = args.raw_output === true;
      const pinnedWorkDir: string | undefined = typeof args.workDir === 'string' && args.workDir.trim()
        ? args.workDir.trim() : undefined;
      const modelAlias: string | undefined = args.model;

      if (!prompt) return '[ERROR] 需要提供 prompt 参数';

      /* 2.5: 递归深度检查 — 在最早 fail-fast, 避免任何无谓的资源分配 (worktree / model lookup).
       *   错误消息明确告诉 LLM 当前深度 + 上限 + 建议, 让它不要继续尝试 spawn. */
      const currentDepth = agentDepthStore.getStore() ?? 0;
      if (currentDepth >= MAX_AGENT_NESTING_DEPTH) {
        return `[ERROR] Sub-agent nesting depth limit reached (depth=${currentDepth}, max=${MAX_AGENT_NESTING_DEPTH}). \
You are already inside a nested agent — spawning deeper would burn tokens without parallelism gain. \
Either complete the work in the current context, or break it into sibling tasks at the same depth.`;
      }

      if (typeId) {
        const available = getAvailableAgentTypes().map(t => t.id);
        /* 内部类型 (research_worker) 不列给模型看, 但工具内部派发必须认得 */
        if (!isKnownAgentType(typeId)) {
          return `[ERROR] Unknown agent type "${rawTypeId}". Available: ${available.join(', ')}. \
Either pick one of those, or omit the type parameter to use the default '${DEFAULT_AGENT_TYPE_ID}' agent.`;
        }
      }
      const agentType = getAgentType(typeId);

      // 模型覆盖
      /* 默认模型: 用户为当前主模型配过子 Agent 模型就用它, 否则继承主模型。
         现取而不是建工具时定死 —— host 按 session 缓存, 定死的话会话中途改设置不生效。 */
      const configuredDefault = opts.getTaskAgentRoute?.() ?? null;
      let agentProviderId = configuredDefault?.providerId || opts.providerId;
      let agentModelName = configuredDefault?.modelName || opts.modelName;
      /* modelInherited: 调用方没指定 model, 或指定了但没解析成功 (退回主 agent 模型) —
       * 两种都算"跟主力同款"。UI 据此决定要不要挂模型标签: 继承的不挂, 否则每个子 agent
       * 都顶着一个跟主力一样的标签, 纯噪音。 */
      let modelInherited = true;
      const roleModel = (agentType as { model?: string }).model;
      if (roleModel && opts.resolveModelAlias) {
        const resolved = opts.resolveModelAlias(roleModel);
        if (resolved) {
          agentProviderId = resolved.providerId;
          agentModelName = resolved.modelName;
          modelInherited = false;
          cliLogger.info('AGENT_TOOL', `角色 ${agentType.id} 钉死模型: ${roleModel} → ${agentProviderId}/${agentModelName}`);
        } else {
          cliLogger.warn('AGENT_TOOL', `角色 ${agentType.id} 写的模型 "${roleModel}" 解析不到`);
          return `[ERROR] 角色 "${agentType.id}" 的定义里写的模型 "${roleModel}" 现在用不了。`
            + (availableModels.length > 0
              ? `\n当前可用: ${describeAvailableModels(availableModels)}`
              : '\n(这一刻列不出可用模型 —— 可能是订阅信息还没拉到, 或者没有配置任何 provider。)')
            + `\n改 .neox/agents/${agentType.id}.md 里的 model 字段 (改完立即生效, 不用重启), `
            + '或者这次派发时用 model 参数临时指定一个。';
        }
      }
      if (modelAlias && opts.resolveModelAlias) {
        const resolved = opts.resolveModelAlias(modelAlias);
        if (resolved) {
          agentProviderId = resolved.providerId;
          agentModelName = resolved.modelName;
          modelInherited = false;
          cliLogger.info('AGENT_TOOL', `Model override: ${modelAlias} → ${agentProviderId}/${agentModelName}`);
        } else {
          cliLogger.warn('AGENT_TOOL', `派发时点名的模型 "${modelAlias}" 解析不到`);
          return `[ERROR] 模型 "${modelAlias}" 现在用不了。`
            + (availableModels.length > 0
              ? `\n当前可用: ${describeAvailableModels(availableModels)}`
              : '\n(这一刻列不出可用模型 —— 可能是订阅信息还没拉到, 或者没有配置任何 provider。)')
            + '\n换一个, 或者去掉 model 参数继承主 agent 的模型。';
        }
      }
      appendDiagLog('AGENT_TOOL_DISPATCH_INTENT', {
        chosenProviderId: agentProviderId, chosenModel: agentModelName,
        modelInherited, alias: modelAlias ?? null,
        defaultProviderId: opts.providerId, defaultModel: opts.modelName,
        configuredDefault,
      });
      /** register 时随 task 存下来, 一路带到事件/UI — 见 BackgroundAgentTask.model */
      const modelMeta = {
        model: agentModelName,
        providerId: agentProviderId,
        modelInherited,
      };

      /* 重复派发闸门 —— 同一任务已有 agent 在跑就不再开第二个.
       *   只拦归一化后完全相同的 description/prompt (判据见 findDuplicateRunning),
       *   正当的分区并行不受影响. */
      const dup = opts.backgroundManager.findDuplicateRunning(description, prompt, opts.sessionId);
      if (dup) {
        cliLogger.warn('AGENT_TOOL', `duplicate dispatch blocked: 「${description}」已由 ${dup.agentId} 在跑`);
        return JSON.stringify({
          status: 'already_running',
          agentId: dup.agentId,
          name: dup.name,
          description: dup.description,
          still_running: true,
          do_not_redispatch: true,
          message:
            `任务「${description}」已经有 agent "${dup.agentId}" 在执行了(已跑 ` +
            `${Math.round((Date.now() - dup.startedAt) / 1000)} 秒), **本次派发已被拦截, 没有启动新 agent**。\n\n` +
            `⚠️ 不要再重复派发同一个任务。\n` +
            `✅ 它完成时结果会以 <agent-completion> 自动送达你。\n` +
            (dup.name ? `✅ 想问进度可 SendMessage(to: "${dup.name}")。\n` : '') +
            `✅ 现在该做的是: 去做与它**不重叠**的其他工作, 或直接等它的完成通知。`,
        });
      }

      let agentId = agentName || `Agent-${++counter}`;
      const startTime = Date.now();

      // Worktree isolation — 全程显式 cwd, 不 process.chdir (并发安全)
      let worktreeInfo: AgentWorktreeInfo | null = null;
      if (isolation === 'worktree') {
        worktreeInfo = await createAgentWorktree(opts.workDir);
      }

      // === 后台模式 ===
      if (runInBackground) {
        const task = opts.backgroundManager.register(agentId, description, prompt, opts.sessionId, agentName, { ...modelMeta });
        agentId = task.agentId; // 撞名时 register 会改名, 以返回值为准
        if (worktreeInfo) registerAgentWorktree(agentId, worktreeInfo); // 以最终 agentId 登记
        const bgAbortSignal = task.abortController.signal;
        // 父 session abort (ESC / Enter interrupt) 也要杀掉后台 agent
        if (opts.abortSignal) {
          if (opts.abortSignal.aborted) {
            task.abortController.abort();
          } else {
            opts.abortSignal.addEventListener(
              'abort',
              () => { try { task.abortController.abort(); } catch { /* ignore */ } },
              { once: true },
            );
          }
        }

        opts.onTaskAgentEvent?.(agentId, {
          type: 'worker_start',
          agentId,
          role: agentType.name,
          isAgentTool: true,
          task: description,
          model: agentModelName,
          modelInherited,
          timestamp: startTime,
          isBackground: true,
        });

        void (async () => {
          try {
            const result = await runAgent(
              agentId,
              prompt,
              description,
              agentType,
              bgAbortSignal,
              agentProviderId,
              agentModelName,
              worktreeInfo?.path ?? pinnedWorkDir,
              host => {
                opts.backgroundManager.attachRuntimeHost(agentId, host);
              },
            );
            const worktreeNote = finishAgentWorktree(agentId, worktreeInfo);

            if (result.error) {
              opts.backgroundManager.fail(agentId, result.error, result.timedOut ? 'watchdog' : 'system');
            } else {
              const sizedBg = sizeSubAgentOutput(result.output, { agentRole: agentType.name });
              opts.backgroundManager.complete(agentId, sizedBg.output + worktreeNote);
            }

            opts.onTaskAgentEvent?.(agentId, {
              type: 'worker_complete',
              agentId,
              role: agentType.name,
              isAgentTool: true,
              summary: result.error ? undefined : result.output.substring(0, 200),
              error: result.error,
              success: !result.error,
              duration: Date.now() - startTime,
              toolCount: result.toolCount,
              timestamp: Date.now(),
              isBackground: true,
            });
          } catch (err: any) {
            const message = err?.message || String(err);
            opts.backgroundManager.fail(agentId, message);
            finishAgentWorktree(agentId, worktreeInfo);
            opts.onTaskAgentEvent?.(agentId, {
              type: 'worker_complete',
              agentId,
              role: agentType.name,
              isAgentTool: true,
              summary: undefined,
              error: message,
              success: false,
              duration: Date.now() - startTime,
              toolCount: 0,
              timestamp: Date.now(),
              isBackground: true,
            });
          }
        })();

        return JSON.stringify({
          status: 'background_launched',
          agentId,
          name: agentName,
          agentType: agentType.id,
          description,
          still_running: true,
          do_not_redispatch: true,
          message:
            `${agentType.name} agent "${agentId}" 已在后台启动, 任务「${description}」。\n` +
            `⚠️ 不要为同一任务再派 agent(会并发写同一批文件)。结果完成时以 <agent-completion> 自动送达。` +
            (agentName ? ` 想问进度可 SendMessage(to: "${agentName}")。` : ''),
        });
      }

      // === 同步模式（支持自动转后台）===
      /* 同理: 一次性宿主下不允许"前台跑着超时自动转后台" —— 转后台等于把剩下的活扔给一个
       * 马上要被杀掉的进程。置 0 = 一直前台等到 AGENT_HARD_TIMEOUT_MS 为止。 */
      const autoBackgroundMs = backgroundAllowed ? (Number(args.auto_background_ms) || 0) : 0;

      const foregroundTask = opts.backgroundManager.register(
        agentId, description, prompt, opts.sessionId, agentName, { synchronous: true, ...modelMeta },
      );
      agentId = foregroundTask.agentId; // 同上: 撞名改名后以返回值为准
      if (worktreeInfo) registerAgentWorktree(agentId, worktreeInfo); // 以最终 agentId 登记

      opts.onTaskAgentEvent?.(agentId, {
        type: 'worker_start',
        agentId,
        role: agentType.name,
        isAgentTool: true,
        task: description,
        model: agentModelName,
        modelInherited,
        timestamp: startTime,
      });

      const runAbortController = new AbortController();
      const abortRun = (signal: AbortSignal) => {
        if (!runAbortController.signal.aborted) {
          runAbortController.abort((signal as any).reason || new Error('agent aborted'));
        }
      };
      const linkedSignals = [
        opts.abortSignal,
        foregroundTask.abortController.signal,
        context?.signal,
      ].filter((s): s is AbortSignal => !!s);
      const abortListeners: Array<{ signal: AbortSignal; handler: () => void }> = [];
      for (const signal of linkedSignals) {
        if (signal.aborted) abortRun(signal);
        else {
          const handler = () => abortRun(signal);
          abortListeners.push({ signal, handler });
          signal.addEventListener('abort', handler, { once: true });
        }
      }
      const cleanupAbortLinks = () => {
        for (const { signal, handler } of abortListeners) {
          signal.removeEventListener('abort', handler);
        }
        abortListeners.length = 0;
      };
      const abortSignal = runAbortController.signal;
      let pendingBackgroundHost: AgentRuntimeHost | null = null;
      const agentPromise = runAgent(
        agentId,
        prompt,
        description,
        agentType,
        abortSignal,
        agentProviderId,
        agentModelName,
        worktreeInfo?.path ?? pinnedWorkDir,
        autoBackgroundMs > 0
          ? (host) => {
              pendingBackgroundHost = host;
              opts.backgroundManager.attachRuntimeHost(agentId, host);
            }
          : (host) => {
              opts.backgroundManager.attachRuntimeHost(agentId, host);
            },
      );

      if (autoBackgroundMs > 0) {
        // 用可清理的定时器, race 结束后必 clear, 避免空转定时器泄漏(历史隐患:
        // agentPromise 先完成时 setTimeout 不被清, 挂到期才回收)。
        let bgTimerId: ReturnType<typeof setTimeout> | undefined;
        const bgTimer = new Promise<'background'>(resolve => {
          bgTimerId = setTimeout(() => resolve('background'), autoBackgroundMs);
          if (typeof bgTimerId?.unref === 'function') bgTimerId.unref();
        });
        let raceResult: { type: 'done'; result: any } | { type: 'background' };
        try {
          raceResult = await Promise.race([
            agentPromise.then(r => ({ type: 'done' as const, result: r })),
            bgTimer.then(type => ({ type })),
          ]);
        } finally {
          if (bgTimerId) clearTimeout(bgTimerId);
        }

        if (raceResult.type === 'background') {
          // 转后台：保留原 task,不要用同一个 agentId 二次 register 覆盖 host/abort/progress。
          const marked = opts.backgroundManager.markBackgrounded(agentId);
          if (!marked) {
            opts.backgroundManager.register(agentId, description, prompt, opts.sessionId, agentName, { ...modelMeta });
          }
          if (pendingBackgroundHost) {
            opts.backgroundManager.attachRuntimeHost(agentId, pendingBackgroundHost);
          }
          cliLogger.info('AGENT_TOOL', `${agentId} auto-backgrounded after ${autoBackgroundMs}ms`);

          opts.onTaskAgentEvent?.(agentId, {
            type: 'worker_event',
            agentId,
            eventType: 'auto_backgrounded',
            workerRole: agentType.name,
            timestamp: Date.now(),
            isBackground: true,
          });

          // fire-and-forget 等待完成
          void agentPromise.then(result => {
            const wNote = finishAgentWorktree(agentId, worktreeInfo);
            if (result.error) {
              opts.backgroundManager.fail(agentId, result.error, result.timedOut ? 'watchdog' : 'system');
            } else {
              const sizedFnf = sizeSubAgentOutput(result.output, { agentRole: agentType.name });
              opts.backgroundManager.complete(agentId, sizedFnf.output + wNote);
            }
            cleanupAbortLinks();
            opts.onTaskAgentEvent?.(agentId, {
              type: 'worker_complete',
              agentId,
              role: agentType.name,
              isAgentTool: true,
              summary: result.error ? undefined : result.output.substring(0, 200),
              error: result.error,
              success: !result.error,
              duration: Date.now() - startTime,
              toolCount: result.toolCount,
              timestamp: Date.now(),
              isBackground: true,
            });
          }).catch(err => {
            const message = err?.message || String(err);
            opts.backgroundManager.fail(agentId, message);
            finishAgentWorktree(agentId, worktreeInfo);
            cleanupAbortLinks();
            opts.onTaskAgentEvent?.(agentId, {
              type: 'worker_complete',
              agentId,
              role: agentType.name,
              isAgentTool: true,
              summary: undefined,
              error: message,
              success: false,
              duration: Date.now() - startTime,
              toolCount: 0,
              timestamp: Date.now(),
              isBackground: true,
            });
          });

          return JSON.stringify({
            status: 'auto_backgrounded',
            agentId,
            name: agentName,
            agentType: agentType.id,
            description,
            still_running: true,
            do_not_redispatch: true,
            message:
              `${agentType.name} agent "${agentId}" 仍在后台继续执行任务「${description}」——` +
              `它**没有失败, 也没有停下**, 只是超过 ${autoBackgroundMs}ms 还没做完, 已转入后台。\n\n` +
              `⚠️ 不要为同一个任务再派一个 agent —— 它正在改文件, 再派一个会与它并发写同一批文件造成冲突。\n` +
              `✅ 它完成时结果会以 <agent-completion> 自动送达你, 你无需轮询。\n` +
              (agentName ? `✅ 想问进度可以 SendMessage(to: "${agentName}")。\n` : '') +
              `✅ 现在该做的是: 去做与「${description}」**不重叠**的其他工作; 若没有别的可做, 就直接等它的完成通知。`,
          });
        }

        // 正常完成（未超时）
        const result = raceResult.result;
        const worktreeNote = finishAgentWorktree(agentId, worktreeInfo);
        const sizedForCompleteAuto = result.error
          ? { output: '', truncated: false, originalLength: 0 }
          : sizeSubAgentOutput(result.output, { agentRole: agentType.name });
        if (result.error) opts.backgroundManager.fail(agentId, result.error, result.timedOut ? 'watchdog' : 'system');
        else opts.backgroundManager.complete(agentId, sizedForCompleteAuto.output);
        cleanupAbortLinks();
        opts.onTaskAgentEvent?.(agentId, {
          type: 'worker_complete',
          agentId,
          role: agentType.name,
          isAgentTool: true,
          summary: result.error ? undefined : result.output.substring(0, 200),
          error: result.error,
          success: !result.error,
          duration: Date.now() - startTime,
          toolCount: result.toolCount,
          timestamp: Date.now(),
        });
        if (result.error) return `[ERROR] ${result.error}`;
        if (rawOutput) return result.output;
        return sizedForCompleteAuto.output + opts.backgroundManager.getChangedFilesNote(agentId) + worktreeNote;
      }

      // 纯同步：无自动转后台
      const result = await agentPromise;
      const worktreeNote = finishAgentWorktree(agentId, worktreeInfo);

      const sized = result.error
        ? { output: '', truncated: false, originalLength: 0 }
        : sizeSubAgentOutput(result.output, { agentRole: agentType.name });

      if (result.error) opts.backgroundManager.fail(agentId, result.error, result.timedOut ? 'watchdog' : 'system');
      else opts.backgroundManager.complete(agentId, sized.output);
      cleanupAbortLinks();

      opts.onTaskAgentEvent?.(agentId, {
        type: 'worker_complete',
        agentId,
        role: agentType.name,
        isAgentTool: true,
        summary: result.error ? undefined : result.output.substring(0, 200),
        error: result.error,
        success: !result.error,
        duration: Date.now() - startTime,
        toolCount: result.toolCount,
        timestamp: Date.now(),
      });

      if (result.error) return `[ERROR] ${result.error}`;
      /* raw_output 连尾巴上的 changed-files / worktree 说明一起省掉 —— 那两段也是拼在
       * 输出末尾的自然语言, 拼进 JSON 同样解析不了。 */
      if (rawOutput) return result.output;
      return sized.output + opts.backgroundManager.getChangedFilesNote(agentId) + worktreeNote;
    },
  };
}
