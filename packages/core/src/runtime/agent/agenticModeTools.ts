/**
 * AgenticModeTools - Agentic 模式的 explore 工具
 *
 * 学习 Claude Code 的设计：
 * - explore：只读任务 Agent，高频触发，用于代码探索
 * - 任务 Agent 能看到主 agent 的对话历史（"access to current context"）
 * - 任务 Agent 工具经过裁剪，避免递归和无关工具
 * - 支持 abort 信号传递和 UI 事件转发
 */

import type { Tool } from '@neoxlabs/kernel/types/index.js';
import type { ShortTermMemory } from '@neoxlabs/kernel/memory/shortterm.js';
import { PermissionManager } from '@neoxlabs/kernel/core/permissions/index.js';
import { ToolPermission } from '@neoxlabs/kernel/types/permissions.js';
import type { RuntimeOrchestrator } from '../runtimeOrchestrator.js';
import type { BackgroundAgentManager } from './backgroundAgent.js';
import { ShortTermMemory as STM } from '@neoxlabs/kernel/memory/shortterm.js';
import { buildParentContext } from './parentContext.js';
import { AgentMode } from '@neoxlabs/kernel/core/runner.js';
import { getAgentThreadContext } from '../agentThreadContext.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { createAgentTool, createAgentWorktree, finishAgentWorktree, registerAgentWorktree } from './agentTool.js';
import type { AgentWorktreeInfo } from './agentTool.js';
import { createTeamPlanTools } from '../team/teamPlanTools.js';
import { runTeamExecution } from '../team/teamExecutor.js';
import { getMaxConcurrentAgents } from './backgroundAgent.js';
import { isTeamPlanActive, getTeamPlan } from '../team/teamPlanStore.js';
import { createSendMessageTool } from './sendMessageTool.js';
import { createListAgentsTool } from './listAgentsTool.js';
import { createStopAgentTool } from './stopAgentTool.js';
import { buildAgentTypesPrompt } from './agentTypes.js';
import { createResearchRecordTool } from '../../research/recordTool.js';
import { createDeepResearchTool } from '../../research/deepResearch.js';
import { captureTaskAgentRuntimeError, resolveTaskAgentRunError } from './taskAgentRunFailure.js';
import { appendDiagLog } from './diagLogFile.js';
import { runWithReadScope } from '../../tools/smart-read/readLedger.js';
import { getConcurrencyProfile } from '@neoxlabs/platform/utils/config.js';
import { createExploreProgress } from './exploreProgress.js';

export interface AgenticModeToolsOptions {
  orchestrator: RuntimeOrchestrator;
  providerId: string;
  modelName: string;
  exploreProviderId?: string;
  exploreModelName?: string;
  getTaskAgentRoute?: () => { providerId: string; modelName: string } | null;
  permissionManager: PermissionManager;
  allTools: Tool[];
  workDir: string;
  /** 动态获取主 agent 的 memory */
  getParentMemory: () => ShortTermMemory;
  /** abort 信号（主 agent 中断时任务 Agent 也停） */
  abortSignal?: AbortSignal;
  /** 任务 Agent 运行时事件回调（转发到 UI） */
  onTaskAgentEvent?: (agentId: string, event: any, tracker?: any) => void;
  /** 后台 agent 管理器 */
  backgroundManager: BackgroundAgentManager;
  /** 模型别名解析 */
  resolveModelAlias?: (alias: string) => { providerId: string; modelName: string } | null;
  listAvailableModels?: () => import('./agentTool.js').AvailableModel[];
  /** 当前 session ID */
  sessionId?: string;
  /** 主 agent 的已渲染 system prompt（用于任务 Agent prompt cache 复用） */
  parentRenderedPrompt?: string;
  /** 按 agent 类型追加工具池 (透传给 agentTool) — Life 模式 online 型子 agent 拿 browser 工具用 */
  extraToolsForType?: Record<string, Tool[]>;
  /** 是否允许后台 agent (默认 true; `neox -p` 一次性宿主传 false, 详见 agentTool.ts) */
  allowBackgroundAgents?: boolean;
  agentMode?: string;
}

// ==================== 工具集定义 ====================

/**
 * 剥掉 explore 输出尾部的"承诺句" — 常见形式:
 *   - "找到了！现在读取完整内容:"
 *   - "接下来我读一下..."
 *   - "让我看看具体实现:"
 *   - "Now let me read the file:"
 *   - "Let me check..."
 *   - 任何以 ":" / "：" / "..." 结尾的最后一行 (通常是承诺, 不是事实)
 *
 * PARTIAL 场景 LLM 常在承诺"下一步做什么"时被截断, 尾部承诺让父 agent 误以为 explore 完成了.
 * 只剥最后一行 — 中间的承诺句可能已经跟着事实执行完了, 保留更安全.
 */
function stripTrailingPromiseLines(text: string): string {
  if (!text) return text;
  const lines = text.split('\n');
  /* 反向找最后一个非空行, 判是否是承诺 */
  let lastNonEmpty = lines.length - 1;
  while (lastNonEmpty >= 0 && lines[lastNonEmpty].trim() === '') lastNonEmpty--;
  if (lastNonEmpty < 0) return text;
  const lastLine = lines[lastNonEmpty].trim();
  /* 承诺特征: 尾字符是 ":" / "：" / "..." / "…" 且行不太长 (承诺句通常 <100 char) */
  const isPromiseTail = /[:：.]{1,3}$/.test(lastLine) && lastLine.length <= 120;
  if (!isPromiseTail) return text;
  /* 剥掉这一行 + 尾部空行 */
  return lines.slice(0, lastNonEmpty).join('\n').trimEnd();
}

/** explore 任务 Agent 的只读工具集 — 与 baseTools 实际 name 对齐 */
const EXPLORE_READ_ONLY_TOOLS = new Set([
  'search_files', 'search',
  'list_directory', 'show_tree', 'smart_tree',
  'git_status', 'git_diff', 'git_blame', 'git_branch_list',
  'readfile',
  'analyze_code',
  'web_search', 'web_fetch',
]);

/**
 * 创建 agentic 模式的 explore 工具
 */
export function createAgenticModeTools(options: AgenticModeToolsOptions): Tool[] {
  const agentTool = createAgentTool({
    orchestrator: options.orchestrator,
    providerId: options.providerId,
    modelName: options.modelName,
    /* 子 Agent 默认模型: 每次派发现取, 用户为当前主模型配过就用它, 没配就继承主模型 */
    getTaskAgentRoute: options.getTaskAgentRoute,
    permissionManager: options.permissionManager,
    allTools: options.allTools,
    workDir: options.workDir,
    getParentMemory: options.getParentMemory,
    abortSignal: options.abortSignal,
    onTaskAgentEvent: options.onTaskAgentEvent,
    backgroundManager: options.backgroundManager,
    resolveModelAlias: options.resolveModelAlias,
    listAvailableModels: options.listAvailableModels,
    sessionId: options.sessionId,
    parentRenderedPrompt: options.parentRenderedPrompt,
    parentSessionId: options.sessionId,  // sub-agent 用此 ID 查父 sessionSnapshot
    extraToolsForType: {
      ...options.extraToolsForType,
      research_worker: [
        ...(options.extraToolsForType?.research_worker ?? []),
        createResearchRecordTool({ workDir: options.workDir }),
      ],
    },
    allowBackgroundAgents: options.allowBackgroundAgents,
  });
  const teamSpecGuardedAgentTool: Tool = {
    ...agentTool,
    function: async (args: any, context?: any) => {
      const teamStage = getTeamPlan(options.sessionId)?.stage;
      const readOnlyType = /^(research|explore|analy)/i.test(String((args as { type?: string })?.type ?? ''));
      if (isTeamPlanActive(options.sessionId) && teamStage === 'requirements' && readOnlyType) {
        return agentTool.function(args, context);
      }
      if (isTeamPlanActive(options.sessionId)) {
        return JSON.stringify({
          success: false,
          blocked: true,
          reason: 'TEAM_SPEC_PLANNING',
          message: teamStage === 'requirements'
            ? '需求分析阶段只放行**只读**子 agent (type: research / explore) 去分域深挖; '
              + '写类子 agent 一律拒 —— 这一刀不实现任何东西。'
            : '团队规划进行中 (编制/领取阶段): 不能派子 agent —— 定谁来做、谁领什么是判断不是体力活, '
              + '外包出去等于没规划。按流程走完 team_roster → team_member_review → team_claim, '
              + '走完停下来把方案交给用户。',
        });
      }
      return agentTool.function(args, context);
    },
  };

  return [
    createExploreTool(options),
    teamSpecGuardedAgentTool,
    createDeepResearchTool({
      workDir: options.workDir,
      agentTool,
      sessionProviderId: options.providerId,
      sessionModelName: options.modelName,
      getMaxConcurrentAgents,
      abortSignal: options.abortSignal,
      onTaskAgentEvent: options.onTaskAgentEvent,
      sessionId: options.sessionId,
    }),
    ...createTeamPlanTools({
      sessionId: options.sessionId,
      modelName: options.modelName,
      onTaskAgentEvent: options.onTaskAgentEvent,
      /* 开工时钉住的工作目录 —— 这一层拿到的是构造期快照, 正是我们要的"开工那一刻" */
      workDir: options.workDir,
      executeTeam: (plan, execOpts) => runTeamExecution({
        sessionId: options.sessionId!,
        plan,
        agentTool,
        activeAgentCount: () => options.backgroundManager.listActive().length,
        maxConcurrent: getMaxConcurrentAgents(),
        emit: (event) => options.onTaskAgentEvent?.(plan.teamId, event),
        taskTimeoutMs: execOpts?.taskTimeoutMs,
        workDir: options.workDir,
      }),
    }),
    createSendMessageTool({
      backgroundManager: options.backgroundManager,
    }),
    /* 看得见 + 停得了: 两个都读 BackgroundAgentManager —— 跟侧栏、停止键同一份真相 */
    createListAgentsTool({
      callerSessionId: options.sessionId,
      backgroundManager: options.backgroundManager,
    }),
    createStopAgentTool({
      callerSessionId: options.sessionId,
      backgroundManager: options.backgroundManager,
    }),
  ];
}

/** agentic 模式系统提示增强 */
export const AGENTIC_MODE_SUBAGENT_INSTRUCTIONS = `
## Task agents

You have two built-in dispatch tools, explore and agent. Both can see the current conversation context.
Their parameters are in the tool schemas — this section is only about **choosing between them**.

### explore vs agent vs doing it yourself
- Know the file and the lines already → just do it. A search for one keyword → search. Reading 1-2 known files → readfile.
- Read-only investigation that needs several rounds of searching → explore (lighter, and takes parallel prompts).
- Needs writes, or a long separable chunk of work → agent.
- One round of explore is normally enough to locate things; fill the gaps with readfile rather than dispatching again.

### Writing a good dispatch prompt
Be specific and bounded, with a completion criterion:
  ✓ "Find the auth entry point and middleware; list the key function signatures"
  ✓ "Create src/utils/dateFormatter.ts exporting formatDate and parseDate"
  ✗ "Analyse the whole auth module" / "Improve the code" (too vague)


## Asking the user

Use ask_user when the requirement is genuinely ambiguous, when there are 2-4 viable approaches with real
trade-offs, before destructive operations, or for technology choices. Do not ask when the requirement is
clear, when the user already gave you enough context, or for small low-risk changes — just do it.
`;

export const AGENTIC_MODE_SUBAGENT_INSTRUCTIONS_NONCODE = `
## Research agents

You have the explore tool: a read-only research agent that can search the web (web_search / web_fetch)
and read local files. It sees the current conversation context. Parameters are in the tool schema.

Dispatch explore when:
- Research spans several sources (price comparison, competitors, policy, industry background) — one explore per direction, in parallel
- Several files or long documents need reading and summarising
- You want the research to run while you carry on with the main task

Do it yourself when a single web_search answers it, or you only need 1-2 known files.

Prompts must be specific and bounded, with a completion criterion:
  ✓ "Find the mainstream mid-range robot vacuums on sale in 2026 with price ranges, and list source links"
  ✗ "Research robot vacuums" (too vague)

## Asking the user

Use ask_user when intent is unclear, when there are several viable options, or when an action has external
consequences (spending money, sending messages, changing someone's schedule). For clear, low-risk things,
just do them.
`;

/** 按用途模式取派遣指令 — code 用完整版 (explore+agent), 其余用研究版 (仅 explore)。 */
export function getSubagentInstructionsForMode(mode: 'work' | 'code'): string {
  return mode === 'code' ? AGENTIC_MODE_SUBAGENT_INSTRUCTIONS : AGENTIC_MODE_SUBAGENT_INSTRUCTIONS_NONCODE;
}

// ==================== explore ====================

const MAX_PARALLEL_EXPLORES = getConcurrencyProfile() === 'low'
  ? 1
  : Number(process.env.NEOX_MAX_PARALLEL_EXPLORES || 2);
/** 并行 explore 启动 stagger — 每个任务延迟 200ms 启动,
 *  避免真"同一毫秒"撞上 RPM 桶, 给 token bucket 一点喘息空间. */
const EXPLORE_STAGGER_MS = Number(process.env.NEOX_EXPLORE_STAGGER_MS || 200);
const EXPLORE_HARD_TIMEOUT_MS = Math.max(0, Number(process.env.NEOX_EXPLORE_HARD_TIMEOUT_MS ?? 0));
/** 传输层故障 —— 这类中断重试一次通常就好, 不该让模型从头重新探索。 */
const TRANSPORT_FAIL_RE =
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|socket hang up|network|fetch failed|terminated|premature close|stream (closed|ended)|TLS|certificate|502|503|504|upstream/i;

function createExploreTool(opts: AgenticModeToolsOptions): Tool {
  let counter = 0;
  const exploreProviderId = opts.exploreProviderId ?? opts.providerId;
  const exploreModelName = opts.exploreModelName ?? opts.modelName;

  /** 执行单个 explore 任务 Agent
   *  workDirOverride: worktree 隔离时传入 — 与 agentTool 同款, 不 process.chdir
   *  (chdir 会污染全进程 cwd, 并发 explore/主 agent 工具全部串目录)。 */
  const runSingleExplore = async (
    prompt: string,
    explorerId: string,
    workDirOverride?: string,
  ): Promise<{ id: string; prompt: string; output: string; error?: string }> => {
    const readOnlyTools = opts.allTools.filter(t => EXPLORE_READ_ONLY_TOOLS.has(t.name));
    // 旧模式: const parentContext = buildParentContext(opts.getParentMemory());
    // 新模式: 仅传递必要的工作目录和任务描述
    const parentContext = buildParentContext(opts.getParentMemory());
    const memory = new STM();
    const effectiveWorkDir = workDirOverride || opts.workDir;
    const systemPrompt = buildExploreSystemPrompt(effectiveWorkDir, parentContext, prompt);

    cliLogger.info('SINGLE_EXPLORE', `${explorerId} started`, {
      prompt: prompt.substring(0, 80),
      toolCount: readOnlyTools.length,
    });

    if (opts.abortSignal?.aborted) {
      return { id: explorerId, prompt, output: '', error: 'aborted before start' };
    }

    let lastRuntimeError: string | undefined;
    /* 诊断: 起始时间 marker, 失败/超时分支拿来打耗时 */
    const startTimeMarker = Date.now();
    const progress = createExploreProgress(data => opts.onTaskAgentEvent?.(explorerId, {
      type: 'worker_event',
      agentId: explorerId,
      eventType: 'explore_progress',
      data,
      timestamp: Date.now(),
    }));

    /* 传输故障重试 —— 正常路径只走一圈 (内部都是 return), 只有网络类中断会 continue。
     * 循环必须包住整个 try/catch: 抛出来的网络异常也要能重来一次。 */
    let didTransportRetry = false;
    let parentSaidStop = false;
    // eslint-disable-next-line no-constant-condition
    while (true) {
    try {
      const sessionId = `explore_${explorerId}_${Date.now()}`;
      /* 审批档跟父会话走 (同 agentTool) */
      if (opts.sessionId) opts.permissionManager.inheritScope(sessionId, opts.sessionId);
      const startPayload = {
        sessionId,
        promptPreview: prompt.substring(0, 120),
        promptLen: prompt.length,
      };
      console.error(`[SINGLE_EXPLORE_START] ${explorerId}`, startPayload);
      appendDiagLog(`SINGLE_EXPLORE_START/${explorerId}`, startPayload);
      const localAbort = new AbortController();
      const timeout = EXPLORE_HARD_TIMEOUT_MS > 0
        ? setTimeout(() => {
            if (!localAbort.signal.aborted) {
              localAbort.abort(new Error(`explore timeout after ${Math.round(EXPLORE_HARD_TIMEOUT_MS / 1000)}s`));
            }
          }, EXPLORE_HARD_TIMEOUT_MS)
        : undefined;

      const parentAbortHandler = () => {
        parentSaidStop = true;      /* 用户/上层主动停 —— 这种绝不自动重试 */
        if (!localAbort.signal.aborted) {
          localAbort.abort(new Error('parent aborted'));
        }
      };

      if (opts.abortSignal) {
        if (opts.abortSignal.aborted) {
          parentAbortHandler();
        } else {
          opts.abortSignal.addEventListener('abort', parentAbortHandler, { once: true });
        }
      }

      const runAbortSignal = localAbort.signal;

      try {
        const result = await runWithReadScope(sessionId, () => opts.orchestrator.runSession({
          sessionId,
          prompt,
          providerId: exploreProviderId,
          modelName: exploreModelName,
          abortSignal: runAbortSignal,
          buildHostConfig: (provider, llmConfig) => ({
            sessionId,
            configKey: `explore_${explorerId}`,
            provider,
            llmConfig: { ...llmConfig, runtimeMode: 'agentic' as const },
            workspacePath: effectiveWorkDir,
            workDir: effectiveWorkDir,
            instructions: systemPrompt,
            systemPrompt,
            agentName: explorerId,
            agentDescription: 'Read-only codebase explorer',
            // Explore 任务 Agent 只有只读工具，完全不需要审批流程。
            // 用独立的全允许 PermissionManager，避免审批弹窗打断用户。
            permissionManager: new PermissionManager({ defaultPermission: ToolPermission.ALLOW }),
            tools: readOnlyTools,
            memory,
            agentConfig: {
              temperature: 0.4,
              mode: AgentMode.AUTO,
              maxIterations: 30,
              maxRuntimeMs: 0, // 不限墙钟; 停滞 / 用户停止才判死。eval 用 NEOX_EXPLORE_HARD_TIMEOUT_MS
            },
            sessionEnabled: false,
            disableSystemPrompt: true,
          }),
          onRuntimeEvent: (event, tracker) => {
            progress.observe(event);
            lastRuntimeError = captureTaskAgentRuntimeError(event, lastRuntimeError);
            opts.onTaskAgentEvent?.(explorerId, {
              ...event,
              workerRole: 'Explore',
              workerTask: prompt.substring(0, 60),
            }, tracker);
          },
        }));

        let runError = resolveTaskAgentRunError(result.summary, lastRuntimeError, 'explore run failed');
        /* 区分 timeout 跟其他 abort — runError = 'aborted' (interrupted=true 时) 不告诉
         * 我们是超时还是真的被 parent kill. 查 localAbort.signal.reason 看是不是 setTimeout
         * 触发的, 是就把 error 改成 "timeout (Ns)", UI/log 能看清楚原因. */
        if (runError?.startsWith('aborted')) {
          const reasonMsg = typeof (localAbort.signal as any).reason?.message === 'string'
            ? (localAbort.signal as any).reason.message
            : '';
          const isTransport = !parentSaidStop
            && !reasonMsg.includes('explore timeout')
            && TRANSPORT_FAIL_RE.test(runError);
          if (isTransport && !didTransportRetry) {
            didTransportRetry = true;
            cliLogger.warn('SINGLE_EXPLORE', `${explorerId} transport failure, retrying once`, { runError });
            appendDiagLog(`SINGLE_EXPLORE_RETRY/${explorerId}`, { runError, reasonMsg });
            clearTimeout(timeout);
            opts.abortSignal?.removeEventListener('abort', parentAbortHandler);
            continue;                 /* 重来一次, 不把 [PARTIAL] 甩给模型 */
          }
          if (reasonMsg.includes('explore timeout')) {
            runError = `timeout (${Math.round(EXPLORE_HARD_TIMEOUT_MS / 1000)}s)`;
            cliLogger.warn('SINGLE_EXPLORE', `${explorerId} hit hard timeout`, {
              timeoutMs: EXPLORE_HARD_TIMEOUT_MS,
              partialOutputLen: (result.summary.output || '').length,
            });
          }
        }
        if (runError) {
          /* 诊断: 失败时把所有可观测信号 dump 到 console.error + 文件.
           * cliLogger.warn 默认在 desktop 看不到完整 details, 这里同时:
           *   1. console.error  — devtools 可见
           *   2. /tmp/neox-explore-debug.log — tail -f 实时看, 不依赖 devtools */
          const failPayload = {
            error: runError,
            lastRuntimeError,
            promptPreview: prompt.substring(0, 120),
            summary: {
              failed: !!result.summary.failed,
              interrupted: !!result.summary.interrupted,
              outputPreview: (result.summary.output || '').substring(0, 500),
              outputLen: (result.summary.output || '').length,
              iterations: (result.summary as any).iterations,
              tokenUsage: (result.summary as any).tokenUsage,
            },
            timing: {
              elapsedMs: Date.now() - startTimeMarker,
              hardTimeoutMs: EXPLORE_HARD_TIMEOUT_MS,
            },
          };
          console.error(`[SINGLE_EXPLORE_FAIL] ${explorerId}`, failPayload);
          appendDiagLog(`SINGLE_EXPLORE_FAIL/${explorerId}`, failPayload);
          cliLogger.warn('SINGLE_EXPLORE', `${explorerId} failed`, {
            error: runError,
            output: (result.summary.output || '').substring(0, 200),
            failed: !!result.summary.failed,
            interrupted: !!result.summary.interrupted,
          });
          const partialOutputRaw = (result.summary.output || '').trim();
          const partialOutput = stripTrailingPromiseLines(partialOutputRaw);
          if (partialOutput) {
            const header = [
              `⚠ EXPLORE WAS CUT OFF — output below is partial and may end mid-sentence.`,
              `Cause: ${runError}`,
              `The text below is a work-in-progress dump, NOT a completed report. Do NOT treat any promise like "现在读取…" / "接下来…" / "Now let me…" as fulfilled — the tool call was aborted before it happened.`,
              `Next step: re-issue explore with a narrower prompt, OR use only the concrete facts below if they're already sufficient.`,
              `[end-of-partial-header]`,
            ].join('\n');
            return {
              id: explorerId,
              prompt,
              output: `${header}\n\n${partialOutput}\n\n[end-of-partial-output]`,
            };
          }
          return { id: explorerId, prompt, output: '', error: runError };
        }

        cliLogger.info('SINGLE_EXPLORE', `${explorerId} completed`, {
          output: (result.summary.output || '').substring(0, 200),
        });
        /* 静默 empty 兜底 (跟 agentTool.ts 同款): task-agent 没报错也没输出 = prompt
         * 太宽泛, 模型立刻 stop. 给主 agent 一段有诊断价值的回包, 不再传染成 RUNNER_ERROR. */
        const out = result.summary.output || '';
        if (!out.trim()) {
          const hint =
            `Explore task-agent completed without producing any output. ` +
            `The exploration prompt may have been too vague — model returned without searching. ` +
            `\n\nPrompt was: ${prompt.substring(0, 200)}` +
            `\n\nNext step: re-issue \`explore\` with a more specific target ` +
            `(e.g. "find the file that defines class X" instead of "look at the project").`;
          return { id: explorerId, prompt, output: hint };
        }
        return { id: explorerId, prompt, output: out };
      } finally {
        progress.flush();
        clearTimeout(timeout);
        if (opts.abortSignal) {
          opts.abortSignal.removeEventListener('abort', parentAbortHandler);
        }
      }
    } catch (error: any) {
      /* 注意: 超时的主路径是 try 内部 runSession 正常返回 + resolveTaskAgentRunError
       * 返 'aborted' (已在上方根据 localAbort.signal.reason 改写成 'timeout (Ns)'),
       * 不会走到 catch. 这里 catch 处理的是 runSession 真正 throw 的场景 (网络异常等). */
      const isTimeout = typeof error?.message === 'string' && error.message.includes('explore timeout');
      if (isTimeout) {
        cliLogger.warn('SINGLE_EXPLORE', `${explorerId} timeout`, { timeoutMs: EXPLORE_HARD_TIMEOUT_MS });
        return { id: explorerId, prompt, output: '', error: `timeout (${Math.round(EXPLORE_HARD_TIMEOUT_MS / 1000)}s)` };
      }
      if (error.name === 'AbortError' || opts.abortSignal?.aborted) {
        return { id: explorerId, prompt, output: '', error: 'aborted' };
      }
      /* 诊断: throw 路径的真实异常 — stack + cause + 原始 error 对象都打出 */
      const throwPayload = {
        name: error?.name,
        message: error?.message,
        stack: error?.stack,
        cause: (error as any)?.cause,
        code: (error as any)?.code,
        category: (error as any)?.category,
        promptPreview: prompt.substring(0, 120),
        elapsedMs: Date.now() - startTimeMarker,
      };
      console.error(`[SINGLE_EXPLORE_THROW] ${explorerId}`, throwPayload);
      appendDiagLog(`SINGLE_EXPLORE_THROW/${explorerId}`, throwPayload);
      /* throw 路径同样区分传输故障 —— runSession 直接抛的网络异常 (ECONNRESET /
       * fetch failed / socket hang up …) 重试一次, 不把重跑甩给模型。 */
      if (!parentSaidStop && !didTransportRetry && TRANSPORT_FAIL_RE.test(String(error?.message ?? ''))) {
        didTransportRetry = true;
        cliLogger.warn('SINGLE_EXPLORE', `${explorerId} transport throw, retrying once`, { error: error?.message });
        appendDiagLog(`SINGLE_EXPLORE_RETRY/${explorerId}`, { thrown: error?.message });
        continue;
      }
      cliLogger.error('SINGLE_EXPLORE', `${explorerId} failed`, { error: error.message });
      return { id: explorerId, prompt, output: '', error: error.message };
    }
    }   /* while — 只有传输故障重试才会转回来 */
  };

  return {
    name: 'explore',
    description: `Dispatch a read-only task agent to explore the codebase. The task agent can see the current conversation context.

Use it for open-ended searching — it does the many search/read round trips in its own context and hands you back only the conclusion, so your context stays clean and you stop paying a full round trip per search:
- You'd otherwise need **more than ~3 search/readfile calls** to find the answer (where is X handled, what calls Y, how does feature Z flow end to end)
- You're unsure which files are involved, the call chain is deep, or you need cross-module understanding (surveying structure before a change / bug localisation / analytical questions)
- Several independent questions → pass prompts=[...] and they run in parallel (up to ${MAX_PARALLEL_EXPLORES})

Skip it when you already know the exact file/symbol/keyword — one readfile or search is faster. After explore returns, fill small gaps with readfile instead of dispatching the same question again.

Writing a prompt — be specific and bounded:
  ✓ "Find the route definition files and list every API endpoint with its handler"
  ✓ "Locate the database model files and list the field definitions for User and Order"

⚠️ **What to do with what explore returns** (so the user does not read it twice):
The markdown explore returns is **working material for you (the main agent)**, not the final answer for the user. The explore card already renders on its own — the user can see the subagent's process and output. Your reply should:
  - **synthesise / distil / decide**, not restate the markdown explore already wrote (architecture diagrams / file tables / code excerpts)
  - User asks "how is X implemented": give a one-line conclusion plus the key file paths — cite, don't restate
  - User asks "how do I change X": give the change plan directly, without repeating explore's analysis of the status quo
  - **Bad**: pasting explore's "## Full data flow" again plus a "## Summary" that summarises it again → the user reads the same thing twice
  - **Good**: "Based on explore (plan_tool.rs / plan.rs / history_cell.rs): codex uses the update_plan tool to let the agent submit plan steps, and the TUI renders PlanUpdateCell. To change X, edit plan.rs:N."`,
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'A single exploration goal (use this or prompts, not both)',
        },
        prompts: {
          type: 'array',
          items: { type: 'string' },
          description: `Several exploration directions run in parallel (max ${MAX_PARALLEL_EXPLORES}). Each string is an independent exploration goal.`,
        },
        isolation: {
          type: 'string',
          enum: ['worktree'],
          description: 'Isolation mode. Set to "worktree" to run the task agent in a temporary git worktree with its own copy of the repo. Suitable for exploration that needs to modify files.',
        },
      },
    },
    async function(args: any) {
      getAgentThreadContext().checkCanSpawnOrThrow('explore task agent');
      /* 诊断: 立刻把 LLM 真实传进来的 args 整体 dump — 失败路径(8ms 那种)走外层早 return,
       * runSingleExplore 里的 log 根本不会触发. 这层抓最原始 args, 看看 Claude 跟 GPT
       * 各自送过来的形态有没有差异 (gateway 协议翻译可能丢字段). */
      const rawArgsPreview = (() => {
        try {
          return JSON.stringify(args, null, 2);
        } catch {
          return `<non-serializable: keys=${Object.keys(args || {}).join(',')}>`;
        }
      })();
      console.error('[EXPLORE_TOOL_ARGS]', rawArgsPreview);
      appendDiagLog('EXPLORE_TOOL_ARGS', { argsType: typeof args, argsPreview: rawArgsPreview, keys: Object.keys(args || {}) });

      // 兼容 prompt 和 prompts 两种参数
      let tasks: string[] = [];
      if (args.prompts && Array.isArray(args.prompts) && args.prompts.length > 0) {
        tasks = args.prompts.slice(0, MAX_PARALLEL_EXPLORES);
      } else if (args.prompt) {
        tasks = [args.prompt];
      } else {
        const validationFail = {
          reason: 'missing_prompt_or_prompts',
          rawArgs: rawArgsPreview,
          argsKeys: Object.keys(args || {}),
        };
        console.error('[EXPLORE_VALIDATION_FAIL]', validationFail);
        appendDiagLog('EXPLORE_VALIDATION_FAIL', validationFail);
        return '[ERROR] 需要提供 prompt 或 prompts 参数';
      }

      /* Worktree isolation — 与 agentTool 同款 workDirOverride 路线 (Team P1 前置修复):
       *   worktree 路径作为 explore 子会话的 workDir 传入, 全程不 process.chdir。
       *   旧实现 chdir 到 worktree 会污染**全进程** cwd — 并发 explore / 主 agent
       *   同时在跑时所有相对路径工具全部串目录。 */
      let worktreeInfo: AgentWorktreeInfo | null = null;
      /* 注册表键 — explore 的 explorerId 在此之后才分配, 用独立 owner id 提前登记 */
      const worktreeOwnerId = `explore-wt-${Date.now().toString(36)}`;
      if (args.isolation === 'worktree') {
        worktreeInfo = await createAgentWorktree(opts.workDir);
        if (worktreeInfo) {
          registerAgentWorktree(worktreeOwnerId, worktreeInfo);
          cliLogger.info('SINGLE_EXPLORE', `Worktree isolation: created ${worktreeInfo.path}`);
        } else {
          cliLogger.warn('SINGLE_EXPLORE', 'Worktree creation failed, continuing without isolation');
        }
      }
      const exploreWorkDirOverride = worktreeInfo?.path;

      /* 自动清理: 无改动删 worktree, 有改动保留并返回带分支名的注记 */
      const cleanupWorktree = (): string => finishAgentWorktree(worktreeOwnerId, worktreeInfo);

      // 单个任务：直接执行
      if (tasks.length === 1) {
        const explorerId = `Explorer-${++counter}`;
        const startTime = Date.now();

        /* 单任务也按一个成员的组下发: 卡片只有一种画法, 每个子 Agent 都带模型名 */
        opts.onTaskAgentEvent?.(explorerId, {
          type: 'worker_start',
          agentId: explorerId,
          role: 'Explore',
          task: tasks[0].substring(0, 80),
          timestamp: startTime,
          groupMembers: [{
            agentId: explorerId,
            task: tasks[0].substring(0, 80),
            model: exploreModelName,
            status: 'running' as const,
            toolCount: 0,
            tokens: 0,
            elapsed: 0,
          }],
        });

        const result = await runSingleExplore(tasks[0], explorerId, exploreWorkDirOverride);

        opts.onTaskAgentEvent?.(explorerId, {
          type: 'worker_event',
          agentId: explorerId,
          eventType: 'member_complete',
          data: {
            memberId: explorerId,
            status: result.error ? 'error' : 'completed',
            elapsed: Date.now() - startTime,
          },
          timestamp: Date.now(),
        });

        opts.onTaskAgentEvent?.(explorerId, {
          type: 'worker_complete',
          agentId: explorerId,
          role: 'Explore',
          summary: result.error ? undefined : result.output.substring(0, 200),
          error: result.error,
          success: !result.error,
          duration: Date.now() - startTime,
          timestamp: Date.now(),
        });

        if (result.error) { cleanupWorktree(); return `[ERROR] ${result.error}`; }
        /* 注记以清理结果为准: 无改动 worktree 已删 → 空串; 有改动 → 带路径+分支名 */
        const worktreeNote = cleanupWorktree();
        return result.output + worktreeNote;
      }

      // 多个任务：并行执行
      cliLogger.info('SINGLE_EXPLORE', `Launching ${tasks.length} parallel explorers`);

      const startTime = Date.now();
      const batchId = `explore-batch-${++counter}`;
      const explorerIds = tasks.map(() => `Explorer-${++counter}`);

      // 发一个 worker_start，带 groupMembers → 创建一张多列卡片
      opts.onTaskAgentEvent?.(batchId, {
        type: 'worker_start',
        agentId: batchId,
        role: 'Explore',
        task: `并行探索 ×${tasks.length}`,
        timestamp: startTime,
        groupMembers: explorerIds.map((id, i) => ({
          agentId: id,
          task: tasks[i].substring(0, 80),
          model: exploreModelName,
          status: 'running' as const,
          toolCount: 0,
          tokens: 0,
          elapsed: 0,
        })),
      });

      const results = await Promise.all(
        tasks.map(async (task, i) => {
          /* stagger 启动 — i=0 立即跑, i=1 等 200ms, i=2 等 400ms ...
           *   避免 N 个 explore 在同一毫秒发出首个 messages 请求撞上 Anthropic RPM 限额.
           *   总体并行红利不变 (大头是 long-running explore agent 自身循环), 只是错开起跳点. */
          if (i > 0 && EXPLORE_STAGGER_MS > 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, i * EXPLORE_STAGGER_MS));
          }
          const result = await runSingleExplore(task, explorerIds[i], exploreWorkDirOverride);
          opts.onTaskAgentEvent?.(batchId, {
            type: 'worker_event',
            agentId: batchId,
            eventType: 'member_complete',
            data: {
              memberId: explorerIds[i],
              status: result.error ? 'error' : 'completed',
              /* 毫秒: 卡片按毫秒格式化 */
              elapsed: Date.now() - startTime,
            },
            timestamp: Date.now(),
          });
          return result;
        })
      );

      const failedResults = results.filter(r => r.error);
      opts.onTaskAgentEvent?.(batchId, {
        type: 'worker_complete',
        agentId: batchId,
        role: 'Explore',
        summary: `${results.filter(r => !r.error).length}/${results.length} completed`,
        error: failedResults.length > 0 ? failedResults.map(r => `${r.id}: ${r.error}`).join('; ') : undefined,
        success: failedResults.length === 0,
        duration: Date.now() - startTime,
        timestamp: Date.now(),
      });

      // 汇总结果
      const parts: string[] = [];
      for (const r of results) {
        if (r.error) {
          parts.push(`## ${r.prompt}\n[ERROR] ${r.error}`);
        } else {
          parts.push(`## ${r.prompt}\n${r.output}`);
        }
      }
      /* 注记以清理结果为准 (同单任务路径) */
      const worktreeNote = cleanupWorktree();
      return parts.join('\n\n---\n\n') + worktreeNote;
    },
  };
}

// ==================== prompt builders ====================

function buildExploreSystemPrompt(workDir: string, parentContext: string, task: string): string {
  return `你是代码探索专家，擅长快速精准定位代码。工作目录: ${workDir}
${parentContext ? `\n## 对话背景\n${parentContext}` : ''}

## 工作策略
1. 先用 search_files 或 show_tree 建立全局视野（1 次）
2. 用 search/grep 精准定位目标文件和行号（1-3 次）
3. 用 readfile(path, symbol="xxx") 或 readfile(path, start_line=N) 读关键片段（2-5 次）
4. 信息足够就停止，输出结论

## 硬规则
- 只读，不修改任何文件
- readfile 禁止无参数读大文件（>200行），必须用 symbol/start_line/pattern 定位片段
- 每次工具调用前问自己："这次调用能回答任务中的哪个具体问题？"
- 如果连续 2 次调用没有产生新信息，立即停止并总结已知内容
- 不追求"完整覆盖"，只需回答任务要求的问题

## 输出格式
- 列出关键文件路径和行号
- 给出关键代码片段（不超过 30 行/片段）
- 一句话总结发现

## 任务
${task}`;
}

