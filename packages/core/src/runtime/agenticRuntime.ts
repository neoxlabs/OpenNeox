/**
 * AgenticRuntime - 单 Agent 直连运行时
 *
 * 设计原则：
 * - 用户直接与执行 Agent 对话
 * - 内置 explore + task 任务 Agent 工具
 * - 适用于日常开发、调试、小功能
 */

import type { PlatformServices } from '@neoxlabs/platform/platform/services.js';
import { createHash } from 'node:crypto';
import type { PermissionManager } from '@neoxlabs/kernel/core/permissions/index.js';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { ShortTermMemory } from '@neoxlabs/kernel/memory/shortterm.js';
import type { SessionTitlePersistMeta } from './sideAgentAdapter.js';
import { SessionContext } from '@neoxlabs/platform/platform/sessionContext.js';
import { loadConfig } from '@neoxlabs/platform/utils/config.js';

function getUiLanguage(): 'zh' | 'en' {
  try { return (loadConfig() as any).language === 'en' ? 'en' : 'zh'; } catch { return 'zh'; }
}

/** 用户本轮明确禁止工具调用 — 硬关 tool surface, 不依赖模型自觉. */
function userRequestsNoTools(prompt: string): boolean {
  const t = String(prompt || '').trim();
  if (!t) return false;
  return /不要\s*调用?\s*任何\s*工具|不要\s*(用|使用|调用)?\s*工具|严禁\s*(使用|调用)?\s*工具|不用\s*工具|no\s*tools|don'?t\s+use\s+(any\s+)?tools|without\s+(using\s+)?(any\s+)?tools|do\s+not\s+use\s+(any\s+)?tools/i.test(t);
}
import { normalizeMessageContent } from '@neoxlabs/kernel/utils/messageUtils.js';
import type { RuntimeMetadata } from './runtimeTypes.js';
import type { ActionLogService } from '../platform/actionLog/index.js';
import { RuntimeHostService, type RuntimeHostConfig } from './runtimeHostService.js';
import type { AgentRuntimeHost } from './agentRuntimeHost.js';
import { getLastUserTask } from './agentRuntimeHostHelpers.js';
import {
  getTargetStatus, getCurrentTargetPlan,
  rememberUserText, grantTargetConsent, TARGET_INTENT_RE,
} from '../tools/targetModeTools.js';
import { isTeamPlanReady } from './team/teamPlanStore.js';

/** 自动续跑最多连着跑几轮 —— 撞上就把方向盘交回给人, 不许无人值守跑到天亮。 */
const AUTO_CONTINUE_MAX_ROUNDS = 40;
/** 连着这么多轮一个战略块都没推进 = 在原地打转, 停下来让人看一眼 (空转比停下更糟)。 */
const AUTO_CONTINUE_MAX_IDLE_ROUNDS = 3;
import { RuntimeOrchestrator, type ProviderResolution } from './runtimeOrchestrator.js';
import { resolveTaskAgentRoute } from './taskAgentRoute.js';
import { appendDiagLog } from './agent/diagLogFile.js';
import type { RuntimeCheckpointService } from './checkpoint/runtimeCheckpointService.js';
import { consumeSystemReminders, formatRemindersForMessage } from './systemReminder.js';
import { buildSkillRefDirective, buildSlashResearchDirective } from '../skills/router.js';
import { notifyActionFrameRunStart } from '../tools/updatePlan.js';
import { wrapSessionScopedTool } from './sessionScopedTools.js';
import { wrapAskGateTool } from './askGateTools.js';
import { clearAskSideEffectBlock } from '../tools/askUserTool.js';
import {
  armTurnStallGuard,
  disarmTurnStallGuard,
  noteTurnProgress,
} from './resilience/turnStallGuard.js';
import { buildInstructions } from './systemPrompt.js';
import {
  extractAndSaveSessionMemory,
  type SessionMemoryLLMProvider,
  type SessionMemorySummary,
} from '../memory/sessionMemorySummarizer.js';
import { AgentMode } from '@neoxlabs/kernel/core/runner.js';
import { normalizeAgentMode, type AgentMode as AgentModeType } from '@neoxlabs/platform/runtime/agentMode.js';
import { ensureRuntimePluginsLoaded, filterToolsByAgentMode } from '../tools/packs/toolPack.js';
import { collectConnectorToolsForPrompt } from '../tools/packs/connectorIntent.js';
import { wrapShellForGuardedMode } from '../tools/shell/guardedShellGate.js';
import { getSummaryModel } from '@neoxlabs/kernel/core/toolSummaryGenerator.js';
import { isCompactionSummaryMessage } from '@neoxlabs/kernel/utils/compression/llmSummarizer.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { neoxLogger } from '@neoxlabs/kernel/platform/neoxLogger.js';
import { createAgenticModeTools, getSubagentInstructionsForMode } from './agent/agenticModeTools.js';
import { resolveExploreModelSelection } from './agent/exploreModelPolicy.js';
import { BackgroundAgentManager, type BackgroundAgentTask } from './agent/backgroundAgent.js';
import { ToolTreeEngine } from '../tools/toolTreeEngine.js';
import { sharedJevToolPreloader } from './jev/sharedJevToolPreloader.js';
import { createStartTaskTool, decideTurnTier } from './turnTier.js';
import { buildChatPrompt } from './prompts/chatPrompt.js';
import { ALWAYS_ACTIVE_TOOLS } from '../tools/toolTree.js';
import { captureSessionSnapshot, clearSessionSnapshot } from './sessionSnapshot.js';
import { loadProjectMemory } from './projectMemory.js';
import { loadProjectMemoryV2, formatProjectMemoryForPrompt, matchRules, type ProjectMemoryV2Result } from '../memory/projectMemoryV2.js';
import { DynamicContextInjector } from '../memory/dynamicInjector.js';
import { AutoMemoryEngine } from '../memory/autoMemoryEngine.js';
import { createPTCTool } from '../tools/ptcExecute.js';
import { isGPTModel } from '@neoxlabs/platform/utils/modelDetect.js';
import { buildEnvironmentInfo } from './prompts/layers/index.js';
import { getModelIdentityNote } from './prompts/providerSupplements.js';
import { resolveReplyLanguageTag } from './prompts/replyLanguage.js';
import { setWorkspaceAdditionalRoots } from './workspaceRootsContext.js';
import { ensureProjectInstructionsForDetailed } from '@neoxlabs/kernel/core/projectInstructions.js';
import { emitInstructionsTimelineCard } from './instructionsTimelineCard.js';
import { getModelRouter, type ModelRouter } from '../services/modelRouter.js';
import { RunConfigStore } from '@neoxlabs/platform/utils/runConfigStore.js';
import { ProviderStore } from '@neoxlabs/platform/utils/providerStore.js';
import { readCachedMembershipModels } from '../platform/membershipCacheRead.js';
import { agentTypeRegistry } from './agent/agentTypeRegistry.js';
import type { AvailableModel } from './agent/agentTool.js';

/** 「现在能派哪些模型」进每一轮 system prompt, 所以有上限 —— 有人配了几十个 provider。
 *  截断而不是分页: 主 agent 只需要知道"有几个能挑", 不需要穷举。 */
const MAX_LISTED_MODELS = 24;

export function listAvailableModelsForAgents(): AvailableModel[] {
  const out: AvailableModel[] = [];
  const seen = new Set<string>();
  const push = (id: string, source: 'subscription' | 'byok', hint?: string) => {
    const key = String(id ?? '').trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ id: key, source, ...(hint ? { hint } : {}) });
  };
  try {
    for (const m of readCachedMembershipModels()) {
      /* allowed === false 是明确不给; undefined 视为给 (老 server 不返这个字段)。
       * 出图模型排除 —— 子 agent 是干活的, 派给它一个画图模型必然报错。 */
      if (m.allowed === false || m.modality === 'image') continue;
      push(m.modelId, 'subscription', m.family);
    }
  } catch (err) {
    cliLogger.debug('AGENTIC', `读订阅模型清单失败: ${(err as Error).message}`);
  }
  try {
    const store = new ProviderStore();
    for (const p of store.getProviders()) {
      /* 没配 key 的 provider 列出来等于给一个点了必炸的选项 */
      if (typeof p.apiKey !== 'string' || p.apiKey.length === 0) continue;
      for (const m of (p.models ?? [])) push(m.name, 'byok');
    }
  } catch (err) {
    cliLogger.debug('AGENTIC', `读 BYOK 模型清单失败: ${(err as Error).message}`);
  }
  return out.slice(0, MAX_LISTED_MODELS);
}
import { getDatabase } from '@neoxlabs/platform/platform/database.js';
import { InterruptedRunStore } from './store/InterruptedRunStore.js';
/* 走 kernel 根入口而不是深引 core/sessionScope.js —— 深引基线是棘轮, 不为一个新模块开口子 */
import { runWithSessionScope, disposeSessionScope } from '@neoxlabs/kernel';
import { MODEL_FACING_BROWSER_TOOL_NAMES } from './browser/browserToolDefs.js';
import { disposePauseController } from './pauseController.js';
import { beginUserTurnForResearch } from '../research/activeRuns.js';

/** 会话记忆最短落盘间隔。太密就是每轮烧一次轻量模型。 */
const SESSION_MEMORY_MIN_INTERVAL_MS = 3 * 60_000;
/** 或者新增这么多条消息就落一次 —— 长任务里一轮可能就很久。 */
const SESSION_MEMORY_MIN_NEW_MSGS = 20;

/**
 * 意图预解锁放哪几个 —— 干活的入口 + 最少的感知。
 *
 * 不预解锁整包: MAX_UNLOCKED=15, 整包 30+ 会把位子占死, 后续 edit/search 反而被 LRU 挤掉。
 * 也不放单步工具 (见调用点的说明) —— 那是在教模型一步一调。
 */
const PRE_UNLOCK_BROWSER = new Set([
  'browser_run', 'browser_replay',
  'browser_get_aria_tree', 'browser_get_state', 'browser_screenshot', 'browser_get_text',
]);

/**
 * AgenticRuntime 配置
 */
export interface AgenticRuntimeConfig {
  /** 平台服务 */
  services: PlatformServices;
  /** 权限管理器 */
  permissionManager: PermissionManager;
  /** 可用工具 */
  tools: Tool[];
  /** 短期记忆 */
  memory: ShortTermMemory;
  /** 工作目录 */
  workDir: string;
  /** 多根工作区项目路径 */
  workspaceRoots?: string[];
  /** Provider ID */
  providerId: string;
  /** 模型名称 */
  modelName: string;
  /** Provider 解析函数 */
  resolveProvider: (providerId?: string, modelName?: string) => ProviderResolution;
  /** 系统提示词 */
  systemPrompt?: string;
  /** ActionLog 服务（长期记忆注入） */
  actionLog?: ActionLogService;
  /** Agent 运行模式（dangerous 时用 AUTO 跳过审批） */
  agentMode?: AgentMode;
  /** Fine-Grained Tool Streaming */
  enableFGTS?: boolean;
  /** Programmatic Tool Calling */
  enablePTC?: boolean;
  /** 标题落库回调 — 由 desktop/CLI 实现写 sessionStore.title;不传则只 emit 事件不落库 */
  persistSessionTitle?: (sessionId: string, title: string, meta?: SessionTitlePersistMeta) => void | Promise<void>;
  /** Shadow Git 文件检查点服务 — 不传则整套「拒绝改动后回滚文件」能力静默失效。
   *  orchestrator 每轮 startMessage/finishMessage 靠它建快照, 这是唯一的自动建点入口。 */
  checkpointService?: RuntimeCheckpointService;
  /**
   * 是否允许后台 agent (默认 true)。一次性宿主 (`neox -p`) 置 false —— turn 结束进程就退,
   * 后台 agent 会被连坐杀掉且产出全丢, 详见 agentTool.ts 的 allowBackgroundAgents 注释。
   */
  allowBackgroundAgents?: boolean;
  /** 后台 sub-agent 生命周期事件桥 — server/main.ts 接到 EventBus, UI bar 按 sessionId 订阅.
   *  prompt/result/error 仅在 started/done 时填, 供 server 落 sub-agent session 消息历史用. */
  onBackgroundAgentLifecycle?: (
    kind: 'started' | 'updated' | 'done' | 'aborted',
    info: {
      agentId: string;
      name?: string;
      sessionId?: string;
      description: string;
      status: string;
      elapsed: number;
      toolUseCount: number;
      /** 子 agent 已产出 tokens — UI 状态条并入显示 */
      outputTokens?: number;
      model?: string;
      providerId?: string;
      modelInherited?: boolean;
      prompt?: string;
      result?: string;
      error?: string;
    },
  ) => void;
}

/**
 * 聊天请求
 */
export interface AgenticChatRequest {
  /** 会话 ID */
  sessionId: string;
  /** 用户消息 */
  prompt: string;
  /** 元数据（附件等） */
  metadata?: RuntimeMetadata;
  /** Provider ID（可选，优先于运行时默认值） */
  providerId?: string;
  /** 模型名称（可选，优先于运行时默认值） */
  modelName?: string;
  /** 外部 abort signal — server.bridge.chat 传 main.ts 创建的 AC 进来.
   *  abort 时全链路立即中断: 主 agent runner 的 fetch / stream watchdog / 任务 Agent 工具
   *  全部能在不依赖 hostService.getHost(sessionId) 时序的前提下被打断. */
  abortSignal?: AbortSignal;
  /** 用途模式 (code/work) — renderer 每条消息带, 覆盖会话已记的模式 */
  agentMode?: string;
  /** 聊天模式 — 精简 prompt、不带工具 (turnTier.ts) */
  chatMode?: boolean;
  /** crash-resume 入口标记 — server bootstrap 自动接续上一个被打断的 turn 时设 true.
   *  设 true 时:
   *    · 不 inject user message (messages 历史里已经有,scanner 已经修补完整);
   *    · 不要 record_start (resume engine 已经把 row 状态从'running' 重置为'resumed_running');
   *    · prompt 字段可以为空字符串. */
  isResume?: boolean;
  /** 错误卡"重试": 在现有 memory 上重跑这一轮, 不追加新的 user 消息 (见 server/main.ts 的说明)。 */
  isRetry?: boolean;
  isContinue?: boolean;
  resumeServerToken?: string;
  /** 多根工作区: 本工作区全部项目根 (含 primary)。让 agent 在 env 段感知其它根。
   *  缺省/单根 → 无影响。 */
  workspaceRoots?: string[];
  workspacePath?: string;
}

/**
 * 聊天回调
 */
export interface AgenticChatHandlers {
  /** 文本流回调 */
  onText?: (text: string) => void;
  /** 思考流回调 */
  onThinking?: (text: string) => void;
  /** 工具调用回调 */
  onToolCall?: (name: string, args: any) => void;
  /** 工具结果回调 */
  onToolResult?: (name: string, result: string) => void;
  /** 完成回调 */
  onComplete?: (summary: string) => void;
  /** 错误回调 */
  onError?: (error: Error) => void;
  /** 原始 runtime 事件回调 — 用于 server 端转发完整事件到 SSE */
  onRuntimeEvent?: (event: any, tracker: any) => void;
}


function stableHash(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return createHash('sha256').update(text ?? '').digest('hex').slice(0, 12);
}

export class AgenticRuntime {
  private config: AgenticRuntimeConfig;
  private hostService: RuntimeHostService;
  private orchestrator: RuntimeOrchestrator;
  private modelRouter: ModelRouter;
  private runConfigStore: RunConfigStore;
  private contextCompression: {
    mode?: 'sync' | 'async';
    /** 0..1, undefined = 走默认公式 */
    threshold?: number;
    autoEnabled?: boolean;
  } = {};
  private sessionAbortControllers: Map<string, AbortController> = new Map();
  /** 后台任务 Agent 管理器 */
  private backgroundManager: BackgroundAgentManager;
  private sessionMemoryV2: Map<string, ProjectMemoryV2Result> = new Map();
  private sessionInjectors: Map<string, DynamicContextInjector> = new Map();
  private sessionMemoryMap: Map<string, ShortTermMemory> = new Map();
  /** sessionServicesSnapshot 已删 — 服务状态彻底不进 system prompt.
   *  锁缓存会幻觉 (agent 自信说 PID 还在跑实际早死), 每轮重渲又破 prefix cache.
   *  走 service_scan / bash_output 工具按需查 (业界通用做法). */
  private activeSessionHandlers: Map<string, { handlers?: AgenticChatHandlers; providerId?: string; modelName?: string }> = new Map();
  /** 上一次成功完成 chat 的真实 route。provider/model 切换时用它判断是否必须重建 system prompt。 */
  private sessionPromptRouteBySession: Map<string, { providerId: string; modelName: string }> = new Map();

  private _interruptedRunStore: InterruptedRunStore | null = null;
  private heartbeatTimers: Map<string, ReturnType<typeof setInterval>> = new Map();
  /** 每个 session 的用途模式 (work/code)。来源: chat request 携带 > set_agent_mode
   *  bridge > config.defaultAgentMode。切模式后下一轮生效 (prompt cache key 含 mode 自动重建)。 */
  private sessionAgentModes: Map<string, AgentModeType> = new Map();
  /** 进过满档的会话 —— 之后一直满档 (见 turnTier.ts「只升不降」) */
  private sessionAgentLatched = new Set<string>();
  /** 上一轮是轻档的会话 */
  private sessionLite = new Set<string>();
  /** 会话的工具数组 (host/runner 持有的就是它) 与当前这一轮的工具树 */
  private sessionLiveTools = new Map<string, Tool[]>();
  private sessionToolTrees = new Map<string, ToolTreeEngine>();
  /** 主 agent 的 cache prefix 快照。父 session snapshot 只保护 sub-agent, 这里保护主 agent 跨 turn 不漂移。 */
  private renderedPromptBySession: Map<string, {
    key: string;
    prompt: string;
    hash: string;
    capturedAt: number;
  }> = new Map();

  /** 设置 session 用途模式 (bridge set_agent_mode 调用)。下一轮 chat 生效。 */
  setSessionAgentMode(sessionId: string, mode: string): AgentModeType {
    const normalized = normalizeAgentMode(mode);
    this.sessionAgentModes.set(sessionId, normalized);
    cliLogger.info('SINGLE_AGENT', `Agent mode set: ${sessionId} → ${normalized}`);
    return normalized;
  }

  getSessionAgentMode(sessionId: string): AgentModeType {
    const explicit = this.sessionAgentModes.get(sessionId);
    if (explicit) return explicit;
    let stored: string | null = null;
    try { stored = getDatabase().getSessionAgentMode(sessionId); } catch { /* db 未初始化 (CLI/eval) → 走下面 */ }
    if (stored) {
      const mode = normalizeAgentMode(stored);
      this.sessionAgentModes.set(sessionId, mode);
      return mode;
    }
    const envMode = process.env.NEOX_AGENT_MODE;
    if (envMode) return normalizeAgentMode(envMode);
    return normalizeAgentMode((loadConfig() as { defaultAgentMode?: string }).defaultAgentMode);
  }

  /** lazy 拿 InterruptedRunStore — getDatabase() 抛错 (db 未初始化) 时返回 null,
   *  让 record/heartbeat/mark 路径全部 noop, 不影响主流程. */
  private getInterruptedRunStore(): InterruptedRunStore | null {
    if (this._interruptedRunStore) return this._interruptedRunStore;
    try {
      const db = getDatabase();
      this._interruptedRunStore = new InterruptedRunStore(db, this.config.workDir);
      return this._interruptedRunStore;
    } catch {
      return null;
    }
  }

  private isPTCEnabled(): boolean {
    try {
      const live = loadConfig().experimental?.enablePTC;
      if (typeof live === 'boolean') return live;
    } catch { /* 读盘失败 → 用启动快照 */ }
    return this.config.enablePTC === true;
  }

  /** 实验功能「Jev 加持」: 预判本轮要用的工具包并提前解锁 (进程级共用, 见 jev/sharedJevToolPreloader.ts)。 */
  private readonly jevPreloader = sharedJevToolPreloader;

  constructor(config: AgenticRuntimeConfig) {
    this.config = config;

    // 创建 HostService
    this.hostService = new RuntimeHostService({
      platformServices: config.services,
    });

    this.hostService.setEvictListener((sessionId) => {
      this.sessionMemoryMap.delete(sessionId);
      this.sessionInjectors.delete(sessionId);
      this.sessionPromptRouteBySession.delete(sessionId);
      this.sessionAgentModes.delete(sessionId);
      this.sessionAgentLatched.delete(sessionId);
      this.sessionLite.delete(sessionId);
      this.sessionLiveTools.delete(sessionId);
      this.sessionToolTrees.delete(sessionId);
      this.jevPreloader.forget(sessionId);
      this.autoContinueLastProgress.delete(sessionId);
      this.sessionInterrupted.delete(sessionId);
      this.sessionMemorySavedAt.delete(sessionId);
      /* 暂停控制器: **必须走 dispose 而不是直接从表里删** —— 它可能正挂在
       * waitForResume 上, 直接删掉那个 Promise 就永远没人 resolve。 */
      disposePauseController(sessionId);
      /* kernel 侧那批按会话分桶的状态 (sandbox 档 / 项目指令指针 / 压缩熔断 / 回灌账本 …)
       * 一起清 —— 它们各自有 LRU 上限兜底, 但会话淘汰时就该清, 别等被挤出去。
       * 只要用 createSessionScopedStore 建的 store 都会被这一句覆盖, 新增状态不用再改这里。 */
      disposeSessionScope(sessionId);
    });

    this.modelRouter = getModelRouter((providerId) => {
      const resolved = config.resolveProvider(providerId);
      return resolved.provider ?? undefined;
    });
    this.runConfigStore = new RunConfigStore(new ProviderStore(), 'agentic');

    // 创建 Orchestrator (在 runConfigStore 之后,getSideAgentConfig 要捕获它)
    this.orchestrator = new RuntimeOrchestrator({
      hostService: this.hostService,
      actionLog: config.actionLog,
      resolveProvider: config.resolveProvider,
      getSideAgentConfig: () => this.runConfigStore.getConfig().sideAgent,
      getTaskAgentRoute: (mainModel?: string) => {
        let perModelMap: Record<string, { providerId?: string; model?: string }> | undefined;
        try { perModelMap = loadConfig().taskAgentByModel; } catch { /* 配置读不到就退回全局值 */ }
        return resolveTaskAgentRoute(mainModel, perModelMap, this.runConfigStore.getConfig().taskAgent);
      },
      persistSessionTitle: config.persistSessionTitle,
      checkpointService: config.checkpointService,
      /* fatal_auth/fatal_limit 备胎链: 找同 modelName (或等价) 的其它 provider.
       *   典型触发: 用户选的 anthropic-relay-b balance 耗尽 → 自动切 deepseek/relay-f 上的
       *   同名 model. 不做自动 model rewrite (保持模型语义), 用户 model 在别的 provider 上没配
       *   就直接抛错 (chain 只有原 provider), 让用户手动换 model. */
      listAlternateProviders: (originalProviderId, modelName) => {
        if (!modelName) return [];
        try {
          const store = new ProviderStore();
          return store.getProviders()
            .filter(p => p.id !== originalProviderId)
            .filter(p => typeof p.apiKey === 'string' && p.apiKey.length > 0)
            .filter(p => Array.isArray(p.models) && p.models.some(m => m.name === modelName))
            .map(p => ({ providerId: p.id, modelName }));
        } catch (err) {
          cliLogger.warn('AGENTIC', `listAlternateProviders failed: ${(err as Error).message}`);
          return [];
        }
      },
    });

    // 后台 agent 管理器 — onComplete: 通知队列 (UI NotificationQueue 用).
    //
    // 注: <agent-completion> XML 的对话注入由 BackgroundAgentManager 内部的
    // Detached Watcher (notifySessionOfCompletion) 统一处理, 走 BackgroundTaskNotifier
    // 收件箱 → 主 agent 下一轮 LLM 前自动 drain。
    //
    //   原 triggerBackgroundAnnounce 会起一个新 LLM turn 让模型 "汇报" 给用户,
    //   导致 "后台任务汇报" 头重复 + 强迫模型在用户没问时凭空开口。
    //   现在: XML 仍注入下一轮 user message 给 LLM 当上下文 (notifySessionOfCompletion),
    //         UI 端 MessageRow 已经把 XML 解析成独立卡片展示给用户 (atl-msg--background-task /
    //         atl-agent-done details), 不需要额外 LLM 汇报。
    //   见 内部设计文档 §8.2。
    this.backgroundManager = new BackgroundAgentManager({
      /* agentId 同时是子会话 id (全局唯一命名空间), 所以撞名判定不能只看内存里的
       * 活跃 task —— 还要问"这个 id 是不是已经有一条落库的会话了"。
       * 同步查 (better-sqlite3 同步 API), register 是同步路径, 不能 await。 */
      isAgentIdTaken: (agentId: string): boolean => {
        try {
          return getDatabase().getSession(agentId) != null;
        } catch {
          return false;
        }
      },
      onComplete: (task) => {
        cliLogger.info('SINGLE_AGENT', `Background agent completed: ${task.agentId} (${task.status})`);

        // 入队通知（UI NotificationQueue，防重复由 notified 标志保证）
        void import('./agent/backgroundExecution.js').then(({ getNotificationQueue }) => {
          getNotificationQueue().enqueue({
            taskId: task.agentId,
            agentId: task.agentId,
            status: task.status === 'completed' ? 'completed' : 'failed',
            summary: task.description,
            result: (task.result || task.error || '').substring(0, 2000),
          });
        }).catch(() => {});
      },
      /* 桥到 server EventBus — UI 通过 SSE 拿到 sub_agent 事件, 控制栏据此渲染.
       *  started 时附 prompt (server 用来 seed sub-agent session 第一条 user message),
       *  done 时附 result/error (server append 成 assistant message). */
      onLifecycle: config.onBackgroundAgentLifecycle ? (kind, task) => {
        config.onBackgroundAgentLifecycle!(kind, {
          agentId: task.agentId,
          name: task.name,
          sessionId: task.sessionId,
          description: task.description,
          status: task.status,
          elapsed: task.progress.elapsed,
          toolUseCount: task.progress.toolUseCount,
          outputTokens: task.progress.outputTokens,
          model: task.model,
          providerId: task.providerId,
          modelInherited: task.modelInherited,
          ...(kind === 'started' ? { prompt: task.prompt } : {}),
          /* aborted 也带 error — 超时/token 熔断的原因要透传给子会话 final 文案 */
          ...(kind === 'done' || kind === 'aborted' ? { result: task.result, error: task.error } : {}),
        });
      } : undefined,
    });

    cliLogger.info('SINGLE_AGENT', 'AgenticRuntime initialized');
  }

  /**
   * 执行聊天
   */

  private autoContinueLastProgress = new Map<string, { done: number; total: number; idleRounds: number }>();
  /** 这一轮是不是被用户打断的 —— 打断了就不许自动爬起来接着跑。 */
  private sessionInterrupted = new Map<string, boolean>();

  private shouldAutoContinueTarget(sessionId: string, rounds: number): { go: boolean; note?: string } {
    try {
      if ((loadConfig() as any)?.agentRuntime?.autoContinue !== 'on') {
        return { go: false, note: 'auto-continue disabled (agentRuntime.autoContinue)' };
      }
    } catch { return { go: false, note: 'auto-continue disabled (config unreadable)' }; }
    /* 还有子 agent 在跑 = 主 agent 在等, 不是停了 —— 别把它叫起来空转一轮。 */
    if (this.backgroundManager?.listActive?.(sessionId).length) {
      return { go: false, note: 'sub-agents still running' };
    }
    if (isTeamPlanReady(sessionId)) {
      return { go: false, note: 'team plan ready — handing it back to the user' };
    }
    if (rounds >= AUTO_CONTINUE_MAX_ROUNDS) {
      return { go: false, note: `hit max ${AUTO_CONTINUE_MAX_ROUNDS} auto rounds` };
    }
    /* 用户中断优先于一切 —— 点了停止就是不想让它再跑了 */
    if (this.sessionInterrupted.get(sessionId)) {
      this.sessionInterrupted.delete(sessionId);
      return { go: false, note: 'user interrupted this turn' };
    }
    let status: string;
    let plan: { sub_missions?: Array<{ status?: string }> } | null = null;
    try {
      status = getTargetStatus(sessionId);
      plan = getCurrentTargetPlan(sessionId) as any;
    } catch {
      return { go: false, note: 'target state unavailable' };
    }
    if (status !== 'active') return { go: false, note: `target status = ${status}` };

    const blocks = plan?.sub_missions ?? [];
    if (blocks.length === 0) {
      this.autoContinueLastProgress.delete(sessionId);
      return { go: true };
    }
    const done = blocks.filter((b) => b?.status === 'completed').length;
    const prev = this.autoContinueLastProgress.get(sessionId);
    const idleRounds = prev && prev.done === done && prev.total === blocks.length ? prev.idleRounds + 1 : 0;
    this.autoContinueLastProgress.set(sessionId, { done, total: blocks.length, idleRounds });
    if (idleRounds >= AUTO_CONTINUE_MAX_IDLE_ROUNDS) {
      return { go: false, note: `no block progressed in ${idleRounds} rounds (${done}/${blocks.length})` };
    }
    return { go: true };
  }

  /** 新一轮用户输入 —— 上一轮攒下的续跑计数跟这一轮无关, 不清会把旧账算到新目标头上。 */
  private resetAutoContinueState(sessionId: string): void {
    if (!sessionId) return;
    this.autoContinueLastProgress.delete(sessionId);
    this.sessionInterrupted.delete(sessionId);
    /* 用户开口了 = 人回来了 —— 解除"问完没人答"的副作用闸 (见 askGateTools.ts) */
    clearAskSideEffectBlock(sessionId);
  }

  async chat(
    request: AgenticChatRequest,
    handlers?: AgenticChatHandlers
  ): Promise<string> {
    const isRecovery = request.isContinue === true || request.isRetry === true;
    if (!isRecovery) this.recordTargetAuthorization(request);
    if (!isRecovery) this.resetAutoContinueState(request.sessionId);
    else this.sessionInterrupted.delete(request.sessionId);
    /* 深度调研一句话只跑一轮 —— 用户开口了才重新放行 (见 research/activeRuns.ts) */
    if (!isRecovery && request.sessionId) beginUserTurnForResearch(request.sessionId);
    let text = await this.chatOnce(request, handlers);
    let rounds = 0;
    for (;;) {
      const decision = this.shouldAutoContinueTarget(request.sessionId, rounds);
      if (!decision.go) {
        if (decision.note) {
          cliLogger.info('TARGET', `auto-continue stopped: ${decision.note}`, { sessionId: request.sessionId, rounds });
        }
        break;
      }
      rounds += 1;
      cliLogger.info('TARGET', `auto-continue round ${rounds}`, { sessionId: request.sessionId });
      text = await this.chatOnce({
        ...request,
        /* 前缀让 UI 能把它渲染成系统提示行而不是"用户又说了一句" (跟 [NEOX_RESUME] 同款约定) */
        prompt: '[NEOX_TARGET_CONTINUE] 目标还没完成, 继续推进: 挑下一个未完成的战略块, '
          + 'plan_block(start) 标住它, 干完用 plan_block(complete) 附上真实证据, '
          + '然后照常 check_target_done。别问要不要继续, 直接干。',
        isResume: false,
        isRetry: false,
        isContinue: false,
      }, handlers);
    }
    return text;
  }

  private recordTargetAuthorization(request: AgenticChatRequest): void {
    const { sessionId, prompt } = request;
    if (!sessionId || !prompt) return;
    if (prompt.startsWith('[NEOX_')) return;
    try {
      rememberUserText(sessionId, prompt);
      if (TARGET_INTENT_RE.test(prompt)) {
        grantTargetConsent(sessionId);
        cliLogger.info('TARGET', 'consent granted from user wording on runtime thread', { sessionId });
      }
    } catch (err: any) {
      /* 授权记录失败不该挡住这轮对话 —— 最坏结果是模型开不了长跑, 而不是发不出消息 */
      cliLogger.warn('TARGET', `recordTargetAuthorization failed: ${err?.message ?? err}`);
    }
  }

  private async chatOnce(
    request: AgenticChatRequest,
    handlers?: AgenticChatHandlers
  ): Promise<string> {
    return runWithSessionScope(
      { sessionId: request.sessionId },
      () => this.chatOnceInSessionScope(request, handlers),
    );
  }

  private async chatOnceInSessionScope(
    request: AgenticChatRequest,
    handlers?: AgenticChatHandlers
  ): Promise<string> {
    const { sessionId } = request;
    /* 「继续」把标记打进 metadata —— metadata 是唯一一条从这里直通 runner.run 的透传通道
     * (orchestrator.runSession → hostService.runTask → host.runTask → runner.run),
     * 中间几层不需要认识这个字段。effortLevel 走的也是这条路。 */
    const isRecovery = request.isContinue === true || request.isRetry === true;
    const metadata = isRecovery
      ? { ...(request.metadata ?? {}), attachments: undefined, continuation: true }
      : request.metadata;
    // Recovery is a control operation. Read task context for policy decisions only;
    // neither a synthetic "continue" nor the old prompt is appended to history.
    const recoveryHistory = isRecovery
      ? this.sessionMemoryMap.get(sessionId)?.getAll()
        ?? SessionContext.get(sessionId).getAll().map(item => ({
          role: item.role, content: item.raw?.content ?? item.content,
        }))
      : [];
    const rawPrompt = isRecovery
      ? getLastUserTask(recoveryHistory) ?? ''
      : request.isResume && !request.prompt
        ? '[NEOX_RESUME] 服务已重启, 请基于已有对话历史继续. 若历史中有标 <INTERRUPTED> 的工具调用, 由你决定是否需要重新调用; 不需要的就直接推进下一步.'
        : request.prompt;

    const pendingReminders = isRecovery ? [] : consumeSystemReminders(sessionId);
    const reminderText = formatRemindersForMessage(pendingReminders);
    if (pendingReminders.length > 0) {
      cliLogger.info('SINGLE_AGENT', `🔔 consumed ${pendingReminders.length} system reminder(s) for session ${sessionId}`, {
        sources: pendingReminders.map(r => r.source ?? 'unknown'),
        priorities: pendingReminders.map(r => r.priority),
      });
    }
    /* action-frame run 边界 — 本次用户消息之前的 plan 视为陈旧, 不再随轮注入
     * (见 updatePlan.ts getActionFramePrompt 的门控说明)。 */
    if (!isRecovery) notifyActionFrameRunStart(sessionId);
    /* @skill: 引用消费 — Composer 的 skill 徽章只插 `@skill:id` 文本, 此前 runtime
     * 无人解析 (假触发, 全靠模型自觉)。转成硬指令强制首个动作 use_skill。 */
    const skillRefDirective = isRecovery ? '' : buildSkillRefDirective(rawPrompt);
    if (skillRefDirective) {
      cliLogger.info('SINGLE_AGENT', `🎯 @skill: reference(s) detected, injecting use_skill directive`, { sessionId });
    }
    /* /research <题目> — 显式命令 → 硬指令, 首个动作 deep_research (见 buildSlashResearchDirective) */
    const researchDirective = isRecovery ? '' : buildSlashResearchDirective(rawPrompt);
    if (researchDirective) {
      cliLogger.info('SINGLE_AGENT', `🔎 /research detected, injecting deep_research directive`, { sessionId });
    }
    const promptWithReminders = [reminderText, skillRefDirective, researchDirective, rawPrompt]
      .filter(Boolean)
      .join('\n\n') as string;
    const nowD = new Date();
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const nowStamp = `${nowD.getFullYear()}-${pad2(nowD.getMonth() + 1)}-${pad2(nowD.getDate())} `
      + `${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][nowD.getDay()]} ${pad2(nowD.getHours())}:${pad2(nowD.getMinutes())}`;
    const languageTag = resolveReplyLanguageTag(sessionId, rawPrompt.startsWith('[NEOX_') ? '' : rawPrompt);
    const prompt = isRecovery
      ? rawPrompt
      : [promptWithReminders, languageTag, `<current-time>${nowStamp}</current-time>`].filter(Boolean).join('\n\n');

    const runProviderId = request.providerId || this.config.providerId;
    const runModelName = request.modelName || this.config.modelName;
    const providerStore = new ProviderStore();
    const runProvider = providerStore.getProvider(runProviderId);
    const previousPromptRoute = this.sessionPromptRouteBySession.get(sessionId);
    const requestedRouteChanged = !!previousPromptRoute
      && (previousPromptRoute.providerId !== runProviderId || previousPromptRoute.modelName !== runModelName);
    if (requestedRouteChanged) {
      cliLogger.warn('SINGLE_AGENT', 'Requested provider/model changed for session; prompt will refresh after route resolution', {
        sessionId,
        previousProviderId: previousPromptRoute.providerId,
        previousModelName: previousPromptRoute.modelName,
        nextProviderId: runProviderId,
        nextModelName: runModelName,
      });
    }
    const agenticModeConfig = this.runConfigStore.getConfig();
    const sideAgentCfg = agenticModeConfig.sideAgent;
    const exploreModelSelection = resolveExploreModelSelection({
      sessionProviderId: runProviderId,
      sessionModelName: runModelName,
      provider: runProvider,
      configuredProviderId: sideAgentCfg?.providerId || agenticModeConfig.taskAgent?.providerId,
      configuredModelName: sideAgentCfg?.model || agenticModeConfig.taskAgent?.model,
      claudeExploreUseHaiku: sideAgentCfg?.features?.explore ?? agenticModeConfig.claudeExploreUseHaiku,
      claudeFallbackToOpusWhenNoHaiku: sideAgentCfg?.claudeFallbackToOpusWhenNoHaiku ?? agenticModeConfig.claudeFallbackToOpusWhenNoHaiku,
    });
    const exploreProviderId = exploreModelSelection.providerId;
    const exploreModelName = exploreModelSelection.modelName;
    /* 当前主模型对应的子 Agent 路由 (per-主模型 > 全局 > null=继承主模型) */
    let taskAgentPerModelMap: Record<string, { providerId?: string; model?: string }> | undefined;
    try { taskAgentPerModelMap = loadConfig().taskAgentByModel; } catch { /* 读不到就只看全局值 */ }
    const taskAgentRouteForRun = resolveTaskAgentRoute(
      runModelName, taskAgentPerModelMap, agenticModeConfig.taskAgent,
    );
    appendDiagLog('TASK_AGENT_ROUTE', {
      runModelName,
      mapFromDisk: taskAgentPerModelMap ?? null,
      globalTaskAgent: agenticModeConfig.taskAgent ?? null,
      resolved: taskAgentRouteForRun,
    });

    if (!request.modelName && this.config.modelName) {
      cliLogger.warn('SINGLE_AGENT', `⚠️ MODEL_FALLBACK: No modelName in request, falling back to config default "${this.config.modelName}". This may indicate UI model selection was not transmitted!`);
    }
    if (!request.providerId && this.config.providerId) {
      cliLogger.warn('SINGLE_AGENT', `⚠️ PROVIDER_FALLBACK: No providerId in request, falling back to config default "${this.config.providerId}"`);
    }

    if (request.modelName && request.modelName !== this.config.modelName) {
      cliLogger.info('SINGLE_AGENT', `🔄 MODEL_OVERRIDE: User selected "${request.modelName}" (config default was "${this.config.modelName}")`);
    }

    try {
      const { extractComplexitySignals, shouldSuggestUpgrade } = await import('./agent/backgroundExecution.js');
      const currentMemory = this.sessionMemoryMap.get(sessionId);
      const signals = extractComplexitySignals(prompt, {
        totalTokens: currentMemory?.checkContextHealth?.()?.totalTokens ?? 0,
      });
      const upgrade = shouldSuggestUpgrade(signals);
      if (upgrade.suggest) {
        cliLogger.info('SINGLE_AGENT', `🔄 COMPLEXITY_DETECTED: ${upgrade.reason} (confidence: ${Math.round(upgrade.confidence * 100)}%)`);
      }
    } catch (err: any) { cliLogger.debug('SINGLE_AGENT', `Complexity detection failed: ${err?.message}`); }

    this.activeSessionHandlers.set(sessionId, {
      handlers,
      providerId: request.providerId,
      modelName: request.modelName,
    });

    cliLogger.info('SINGLE_AGENT', `Chat started`, {
      sessionId,
      promptLength: prompt.length,
      requestProviderId: request.providerId,
      requestModelName: request.modelName,
      resolvedProviderId: runProviderId,
      resolvedModelName: runModelName,
      requestedRouteChanged,
      exploreProviderId,
      exploreModelName,
      exploreModelSource: exploreModelSelection.source,
      exploreModelReason: exploreModelSelection.reason,
      configProviderId: this.config.providerId,
      configModelName: this.config.modelName,
    });

    const _chatStartTime = Date.now();
    if (neoxLogger.isEnabled()) {
      neoxLogger.info('SINGLE', `═══ Chat START ═══`, {
        sessionId,
        provider: runProviderId,
        model: runModelName,
        exploreProvider: exploreProviderId,
        exploreModel: exploreModelName,
        exploreModelSource: exploreModelSelection.source,
        promptLen: prompt.length,
        memoryMessages: this.sessionMemoryMap.get(sessionId)?.getAll().length ?? 0,
      });
    }

    const abortController = new AbortController();
    this.sessionAbortControllers.set(sessionId, abortController);

    armTurnStallGuard(sessionId);

    if (request.abortSignal) {
      if (request.abortSignal.aborted) {
        abortController.abort();
      } else {
        const onExternalAbort = () => {
          if (!abortController.signal.aborted) abortController.abort();
        };
        request.abortSignal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }

    const interruptedRunStore = this.getInterruptedRunStore();
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    if (interruptedRunStore) {
      if (!request.isResume) {
        interruptedRunStore.recordStart({
          sessionId,
          workspacePath: this.config.workDir,
          mode: 'agentic',
          model: runModelName,
          providerId: runProviderId,
          prompt,
          metadata: metadata ? (metadata as any) : undefined,
          serverPid: process.pid,
          serverToken: process.env.NEOX_SERVER_TOKEN || `pid:${process.pid}`,
        });
      }
      heartbeatTimer = setInterval(() => {
        interruptedRunStore.heartbeat(sessionId);
      }, 5000);
      this.heartbeatTimers.set(sessionId, heartbeatTimer);
    }

    try {

      // 在 enhancedPrompt 构建完成后自动获取最新值
      let renderedPromptRef = '';

      const requestAgentMode = (request as { agentMode?: string }).agentMode;
      if (requestAgentMode) {
        this.sessionAgentModes.set(sessionId, normalizeAgentMode(requestAgentMode));
      }
      const agentMode = this.getSessionAgentMode(sessionId);
      const fullyOpen = this.config.permissionManager?.getScopeMode({ scopeKey: sessionId }) === 'dangerous';
      let modeTools = filterToolsByAgentMode(this.config.tools, agentMode);
      /* 用户显式说「不要工具 / no tools」— 硬关本轮工具面 (含 explore/agent 派遣).
       * QA marathon: soft instruction 常被模型忽略, 这里从表面层掐断. */
      /* 聊天模式 (输入框 + 菜单切的) 跟「不要工具」走同一道闸: 工具面整个关掉。
       * prompt 另换成聊天档 (见 turnTier / prompts/chatPrompt)。 */
      const chatMode = (request as { chatMode?: boolean }).chatMode === true;
      const noToolsIntent = chatMode || userRequestsNoTools(rawPrompt);
      if (noToolsIntent) {
        modeTools = [];
        cliLogger.info('SINGLE_AGENT', chatMode ? 'chat mode; tools disabled for turn' : 'no-tools intent detected; tools disabled for turn', {
          sessionId,
          promptPreview: String(rawPrompt).slice(0, 80),
        });
      }
      if (agentMode === 'work' && !fullyOpen) {
        modeTools = modeTools.map(t =>
          t.name === 'execute_shell' ? wrapShellForGuardedMode(t, 'work') : t,
        );
      }
      if (agentMode !== 'code') {
        cliLogger.info('SINGLE_AGENT', `Agent mode active: ${agentMode}`, {
          sessionId,
          toolsTotal: this.config.tools.length,
          toolsAllowed: modeTools.length,
        });
      }

      const taskAgentTools = noToolsIntent
        ? []
        : createAgenticModeTools({
        orchestrator: this.orchestrator,
        providerId: runProviderId,
        modelName: runModelName,
        /* 「子 Agent 模型」以前只喂到 explore 和侧路 agent —— `agent` 工具派出去的通用
         * 子 agent 一直拿主模型, 跟设置页那句"主 Agent 派出去跑子任务的模型"对不上。
         * 现在同一条路由也喂给它; 没配过时 resolve 返回 null → 继续继承主模型, 零变化。 */
        getTaskAgentRoute: () => {
          let map: Record<string, { providerId?: string; model?: string }> | undefined;
          try { map = loadConfig().taskAgentByModel; } catch { /* 读不到就只看全局值 */ }
          return resolveTaskAgentRoute(runModelName, map, this.runConfigStore.getConfig().taskAgent);
        },
        exploreProviderId,
        exploreModelName,
        permissionManager: this.config.permissionManager,
        /* team_run 只在 code 模式进工具表 —— 见 agenticModeTools 注册处 */
        agentMode,
        allTools: modeTools,
        /* online 型子 agent 的工具豁免口: 模式裁掉的 browser 工具它要用 — 给它全量池,
         * ONLINE_TOOLS 类型白名单会再裁一道 (resolveAgentTools), 不会把无关 dev 工具泄漏给它。 */
        extraToolsForType: { online: this.config.tools },
        allowBackgroundAgents: this.config.allowBackgroundAgents,
        workDir: this.config.workDir,
        getParentMemory: () => this.sessionMemoryMap.get(sessionId) || this.config.memory,
        abortSignal: abortController.signal,
        onTaskAgentEvent: handlers?.onRuntimeEvent
          ? (agentId, event, tracker) => {
            //
            // sessionId 发布到 bus (chatEventPublisher.publishRawEvent 里 sessionId 从闭包固定
            // 成主 session). 任务 Agent (explore / agent 工具) 有自己独立的 AgentRuntimeHost
            // 实例, 它的生命周期事件 (run_result / text_complete / reasoning_complete)
            // 在被 onTaskAgentEvent 透传上来之后也会带着主 sessionId 进 bus.
            //
            // 现象: 在 UI 上, 主 session 的 handleRunResult 会把收到的 run_result
            // 解读为 "整轮对话结束" → settleStatusToReadyIfIdle → streaming=false.
            // 于是 explore 完成的瞬间, GPT 正准备说第二段话, UI 却已经认为对话结束了,
            // GPT 之后产出的文本全部丢在 idle 状态下无人接收, 用户看到 "GPT 用完 explore 就没了".
            //
            // 修复: 在这里直接拦截任务 Agent 的 session 生命周期事件. 这些事件是每个
            // AgentRuntimeHost 实例内部的标记, 跨 session 没有意义, 也不是 UI 渲染
            // explore card 所需要的 (explore card 只需要 worker_start / worker_event /
            // worker_complete, 这些会照常透传).
            const type = (event as any)?.type;

            noteTurnProgress(sessionId, `sub-agent:${String(type ?? 'event')}`);

            if (
              type === 'run_result'
              || type === 'text_complete'
              || type === 'reasoning_complete'
              || type === 'session_status'
              || type === 'turn_complete'
            ) {
              return;
            }
            /* Team P2: 团级事件 (team_run_start/team_lane_update/team_blackboard_post/
             * team_run_complete) 是主 session 语义, 不打 taskAgentId 标 — renderer 主链
             * 的 team_* case 消费它们; 打了标会掉进 useStreamHandler 的 taskAgentId
             * 分支被当成"未知子 agent 事件"静默吞掉。lane 自己的 worker_* 照常走下面。 */
            if (typeof type === 'string' && (type.startsWith('team_') || type.startsWith('research_'))) {
              handlers.onRuntimeEvent!(event, tracker);
              return;
            }
            handlers.onRuntimeEvent!({
              ...event,
              taskAgentId: agentId,
              sourceLabel: agentId,
            }, tracker);
          }
          : undefined,
        backgroundManager: this.backgroundManager,
        sessionId,
        get parentRenderedPrompt() { return renderedPromptRef; },
        resolveModelAlias: (alias: string) => {
          try {
            const inHome = this.config.resolveProvider(runProviderId, alias);
            const homeHasModel = !!inHome.provider
              && (inHome.provider.models || []).some((m: { name?: string }) => m.name === alias);
            if (homeHasModel && inHome.llmConfig) {
              return { providerId: inHome.provider!.id || runProviderId, modelName: alias };
            }
          } catch { /* 主 provider 查不到就走下面的全局查找 */ }
          try {
            const resolved = this.config.resolveProvider(undefined, alias);
            if (resolved.provider && resolved.llmConfig) {
              return {
                providerId: resolved.provider.id || runProviderId,
                modelName: alias,
              };
            }
          } catch { /* fallback */ }
          return null;
        },
        listAvailableModels: listAvailableModelsForAgents,
      });

      /* 角色文件里的模型名, 在**加载时**就校验 (见 registry.warnUnknownModels)。
       * 装在这里而不是让注册表自己去取: 注册表不该知道模型是从订阅还是 BYOK 来的。 */
      agentTypeRegistry.knownModelIds = () => new Set(listAvailableModelsForAgents().map(m => m.id));

      const taskAgentToolsForMode: Tool[] = agentMode === 'code'
        ? taskAgentTools
        : taskAgentTools.filter(t => t.name !== 'agent');

      const allToolsForTree = [...modeTools, ...taskAgentToolsForMode];

      if (!this.isPTCEnabled()) {
        appendDiagLog('PTC_GATE', { injected: false, live: false, bootSnapshot: this.config.enablePTC === true, agentMode });
      }
      if (this.isPTCEnabled() && agentMode === 'code' && !noToolsIntent) {
        if (isGPTModel(runModelName)) {
          cliLogger.warn('SINGLE_AGENT', `PTC skipped: GPT model "${runModelName}" does not support Programmatic Tool Calling`);
        } else {
          const ptcTool = createPTCTool(this.config.tools);
          allToolsForTree.push(ptcTool);
          cliLogger.info('SINGLE_AGENT', 'PTC tool injected');
          appendDiagLog('PTC_GATE', { injected: true, live: this.isPTCEnabled(), bootSnapshot: this.config.enablePTC === true, agentMode });
        }
      }

      // 是单一实例字段, 两个并发 chat 会覆盖彼此. 现在每个 chat 作用域内独立持有.
      /* no-tools 意图: 跳过 ToolTreeEngine (否则仍会注入 tool_search/call_tool 元工具). */
      /* 桌面 worker 里插件 pack 不在启动时的 collectRuntimeTools 里 —— 必须在
       * 构造 ToolTreeEngine 之前把本线程的 connector/plugin pack 装上, 否则
       * tool_search 永远看不见 gcal_* 这种已连接工具。 */
      if (!noToolsIntent) {
        await ensureRuntimePluginsLoaded();
      }
      /* Jev 加持: 草稿预判已到手就用; 续跑 / 重试 / 合成消息只照账, 不问 (不是用户的新需求)。 */
      const jevTurn = await this.jevPreloader.beginTurn(
        sessionId,
        typeof rawPrompt === 'string' ? rawPrompt : '',
        new Set(allToolsForTree.map(t => t.name)),
        !isRecovery && !noToolsIntent && typeof rawPrompt === 'string' && !rawPrompt.startsWith('[NEOX_'),
      );
      const jevPreloaded = jevTurn.preload;
      /* 这一轮带多少 (聊天 / 轻档 / 满档), 判据见 turnTier.ts */
      const turnTier = decideTurnTier({
        chatMode,
        noToolsIntent,
        isRecovery: !!isRecovery,
        agentMode,
        latchedAgent: this.sessionAgentLatched.has(sessionId),
        wasLite: this.sessionLite.has(sessionId),
        hasToolHistory: (this.sessionMemoryMap.get(sessionId)?.getAll() ?? [])
          .some((m: any) => m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0),
        chatOnly: jevTurn.chatOnly,
      });
      if (turnTier === 'lite') this.sessionLite.add(sessionId);
      if (turnTier === 'agent' && !noToolsIntent) {
        this.sessionAgentLatched.add(sessionId);
        this.sessionLite.delete(sessionId);
      }
      if (turnTier !== 'agent') {
        cliLogger.info('SINGLE_AGENT', `turn tier: ${turnTier}`, { sessionId, chatOnly: jevTurn.chatOnly });
      }
      let toolTreeEngineRef: ToolTreeEngine | null = null;
      /* 会话持有同一个工具数组, 每轮的工具树都写进它 (见 ToolTreeEngine liveTarget):
       * host 跨轮复用, runner 手里一直是第一轮给它的那个数组。 */
      let sessionLive = this.sessionLiveTools.get(sessionId);
      if (!sessionLive) {
        sessionLive = [];
        this.sessionLiveTools.set(sessionId, sessionLive);
      }
      /* 上一轮 tool_search / 点名解锁的工具, 这一轮按原顺序接上 —— 工具集不因换了一棵树而变, 前缀缓存不断 */
      const carriedUnlocks = this.sessionToolTrees.get(sessionId)?.getUnlockedInOrder() ?? [];
      if (noToolsIntent) {
        sessionLive.length = 0;
        this.sessionToolTrees.delete(sessionId);
      }
      const liveTools: Tool[] = noToolsIntent
        ? sessionLive
        : (() => {
            const toolTreeEngine = new ToolTreeEngine(allToolsForTree, {
              liveTarget: sessionLive,
              /* 进 liveTools 的每个工具都套上 session ALS + 问完没人答的副作用闸,
               * 跟 buildRunner 的原地包装是同一对函数 (幂等, 包过的不再包)。 */
              decorateTool: (t) => wrapAskGateTool(wrapSessionScopedTool(t, sessionId), sessionId),
              /* 轻档: 模型面前只有 start_task, 调了就原地换满档, 本会话之后一直满档 */
              ...(turnTier === 'lite'
                ? {
                    liteTool: createStartTaskTool(() => {
                      toolTreeEngineRef?.escalate();
                      return (toolTreeEngineRef?.liveTools ?? []).map((t) => t.name);
                    }),
                    /* 谁触发的升档都一样闩住 (start_task / 模型点名工具 / 正则预解锁) */
                    onEscalate: () => {
                      this.sessionAgentLatched.add(sessionId);
                      this.sessionLite.delete(sessionId);
                      cliLogger.info('SINGLE_AGENT', 'lite → full toolset; session stays full from now on', { sessionId });
                    },
                  }
                : {}),
            });
            toolTreeEngineRef = toolTreeEngine;
            this.sessionToolTrees.set(sessionId, toolTreeEngine);
            if (carriedUnlocks.length > 0 && turnTier !== 'lite') toolTreeEngine.promote(carriedUnlocks);
            /* Jev 账上的先按原顺序 promote, 排在正则预解锁前面 —— 每轮同一顺序, 工具前缀稳定。
             * 轻档不 promote: promote 会把它当成"要干活"直接升满档。 */
            if (jevPreloaded.length > 0 && turnTier !== 'lite') {
              const pre = toolTreeEngine.promote([...jevPreloaded]);
              if (pre.length > 0) {
                cliLogger.info('TOOL_TREE', `Jev 预解锁: ${pre.join(', ')}`);
              }
            }
            const promptForIntent = typeof rawPrompt === 'string' ? rawPrompt : '';
            const connectorPre = collectConnectorToolsForPrompt(promptForIntent);
            if (connectorPre.length > 0) {
              const pre = toolTreeEngine.promote(connectorPre);
              if (pre.length > 0) {
                cliLogger.info('TOOL_TREE', `意图预解锁 connector: ${pre.join(', ')}`);
              }
            }
            if (/浏览器|browser|网页|网站|打开.*(https?:\/\/|www\.|\.com|\.cn|\.org|\.net)|https?:\/\/|上网|搜一下|搜索.*(网|web)/i.test(promptForIntent)) {
              const pre = toolTreeEngine.promote(
                MODEL_FACING_BROWSER_TOOL_NAMES.filter((n) => PRE_UNLOCK_BROWSER.has(n)),
              );
              if (pre.length > 0) {
                cliLogger.info('TOOL_TREE', `意图预解锁 browser: ${pre.join(', ')}`);
              }
            }
            return toolTreeEngine.liveTools;
          })();
      /* promote 会**原地**重建 liveTools (runner 持的是同一个数组引用), 所以解锁完
       * runner 重算白名单就能看到它。名字没注册过 → promote 返回空 → 照旧走拒绝路径。 */
      /* 查的是会话**当前**这一轮的工具树 —— 复用的 host 只在第一轮收到过这个函数,
       * 闭包里绑本轮的 toolTreeEngineRef 的话, 第二轮起点名解锁就打到第一轮那棵树上。 */
      const resolveDeferredTool = (name: string): boolean =>
        (this.sessionToolTrees.get(sessionId)?.promote([name]).length ?? 0) > 0;
      /* 本轮预判晚到 (没有草稿预判): 不挡首字, 回来时 promote 进本轮, runner 下一次迭代看得到。 */
      void jevTurn.late?.then((added) => {
        /* 轻档里晚到的工具包预判不 promote (会把会话顶成满档); 已记账, 升满档后下一轮自然带上 */
        if (toolTreeEngineRef?.isLite) return;
        const live = added.length > 0 ? (toolTreeEngineRef?.promote(added) ?? []) : [];
        if (live.length > 0) cliLogger.info('TOOL_TREE', `Jev 预解锁 (晚到): ${live.join(', ')}`);
      });

      /* env (含 git status / 日期等动态信息) lazy 注入. 启动期 buildInstructions 已传
       * skipEnvironment: true 把 env 移出主 systemPrompt, 防止 server boot 阻塞 git status.
       * 这里每次组装 prompt 时调一次, buildEnvironmentInfo 内有 30s TTL cache 避免热路径反复 fork git. */
      const requestWorkspace = (request as { workspacePath?: string }).workspacePath;
      const sessionWorkspace = typeof requestWorkspace === 'string' && requestWorkspace.trim()
        ? requestWorkspace
        : this.config.workDir;
      /* 多根工作区: 把本次请求带来的全部根登记到 ambient, buildEnvironmentInfo(同 workDir 键)
       * 读到后在 env 段列出附加根 → agent 知道其它项目根存在 (bash 本就能按绝对路径访问)。
       * 单根/无 roots → setWorkspaceAdditionalRoots 自动清除 → env 段无任何变化。 */
      setWorkspaceAdditionalRoots(sessionWorkspace, (request as { workspaceRoots?: string[] }).workspaceRoots);

      /* 项目指令 (NEOX.md / .neox/INSTRUCTIONS.md) 按**会话工作区**激活.
       * 必须在这里而不是只在 boot: 全局 workDir 是 server 启动参数, 而每条消息的
       * sessionWorkspace 才是这个会话真正的项目根 (多项目并存时两者不同).
       * 只在某 workDir 第一次出现时读盘, 之后是 Map.get —— 热路径零 IO,
       * 且同一 workDir 恒返同一对象 → hash 稳定 → 前缀缓存不断. */
      const instructionsOutcome = await ensureProjectInstructionsForDetailed(sessionWorkspace);
      /* 可见性: 加载本身是 agent 的一个动作, 走跟工具一样的卡片渲染 (不另造 status 栏).
       * 只在 freshlyLoaded 时发 —— 第 2..N 轮是 Map.get 零 IO, 不该重复出卡.
       * "没有指令文件" 由 shouldEmitInstructionsCard 判掉: 正常态, 不出卡不报错. */
      if (instructionsOutcome.freshlyLoaded) {
        emitInstructionsTimelineCard({
          emit: handlers?.onRuntimeEvent,
          workspace: sessionWorkspace,
          instructions: instructionsOutcome.instructions,
          providerId: runProviderId,
          modelName: runModelName,
        });
      }

      const uiLang = getUiLanguage();
      const modelIndependentPromptParts: string[] = [buildEnvironmentInfo(sessionWorkspace, uiLang)];

      /* Work 的用户画像由 prompts/sections 的 user-mode-profile 段注入 (原来这里又拼了一次, 重复两份) */

      // Feature 2: ActionLog 长期记忆注入
      if (this.config.actionLog) {
        try {
          const memorySummary = await this.config.actionLog.getMemoryInjectionSummary({
            language: uiLang,
            maxChars: 4000,
          });
          if (memorySummary) {
            modelIndependentPromptParts.push(memorySummary);
            cliLogger.info('SINGLE_AGENT', 'ActionLog memory injected', {
              chars: memorySummary.length,
            });
          }
        } catch (e: any) {
          cliLogger.warn('SINGLE_AGENT', 'ActionLog injection failed', { error: e.message });
        }
      }

      // Feature 3: 层级化项目记忆 V2 (.neox/project.md + modules + rules)
      let memoryV2: ProjectMemoryV2Result | null = null;
      try {
        memoryV2 = await loadProjectMemoryV2(sessionWorkspace);
        this.sessionMemoryV2.set(sessionId, memoryV2);
        const projectPrompt = formatProjectMemoryForPrompt(memoryV2);
        if (projectPrompt) {
          modelIndependentPromptParts.push(projectPrompt);
        }

        // 注入无条件规则（globs 为空的 rules）
        for (const [name, rule] of memoryV2.rules) {
          if (rule.globs.length === 0 && rule.content) {
            modelIndependentPromptParts.push(`## 规则: ${name}\n${rule.content}`);
          }
        }
      } catch (e: any) {
        cliLogger.warn('SINGLE_AGENT', 'ProjectMemoryV2 load failed, falling back', { error: e.message });
        // Fallback: 旧版 projectMemory
        try {
          const projectMemory = await loadProjectMemory(sessionWorkspace);
          if (projectMemory) {
            modelIndependentPromptParts.push(projectMemory);
          }
        } catch (e2: any) {
          cliLogger.warn('SINGLE_AGENT', 'Project memory fallback also failed', { error: e2.message });
        }
      }

      // Feature 4: 动态模块上下文注入器（工具调用时按需加载）
      if (memoryV2 && (memoryV2.modules.size > 0 || memoryV2.rules.size > 0)) {
        const injector = new DynamicContextInjector({
          memory: this.config.memory,
          memoryV2: memoryV2,
          workDir: sessionWorkspace,
        });
        this.sessionInjectors.set(sessionId, injector);
        cliLogger.info('SINGLE_AGENT', 'Dynamic context injector initialized', {
          sessionId,
          modules: memoryV2.modules.size,
          rules: memoryV2.rules.size,
        });
      }

      /* 服务状态信息不再注入 system prompt — 走工具查路径 (业界通用做法).
       *
       *   为啥撤: bg 进程死活在动, 每轮重渲会让整个 system prompt cache 失效
       *   (Anthropic cache 是 longest-prefix match, 任何字节变化都让整段废).
       *   每轮多收 ~10k token 重读, 不划算.
       *
       *   如果锁缓存 (per-session 缓存 snapshot), 又会出现"agent 自信说 PID 93481
       *   还在跑实际早死了"的幻觉.
       *
       *   正确做法: 让 agent 需要时自己调 service_scan / bash_output(pid) 查.
       *   universal-constraints prompt 里已经告诉 agent 这两个工具的用法,
       *   它会按需调用. 正确架构 — system prompt 只放"稳定能力描述",
       *   动态状态全走工具.
       *
       *   附带的 tool result preamble [services: ...] (P0-6) 仍然在,
       *   状态变化时 LLM 在下一次工具结果里就看到, 不需要主动调 service_scan. */

      const preparePromptForRoute = (provider: any, llmConfig: any): {
        enhancedPrompt: string;
        forceMemorySystemPromptRefresh: boolean;
        providerId: string;
        modelName: string;
      } => {
        const actualProviderId = provider?.id || runProviderId;
        const actualModelName = llmConfig?.model || runModelName;
        const actualRouteChanged = !!previousPromptRoute
          && (previousPromptRoute.providerId !== actualProviderId || previousPromptRoute.modelName !== actualModelName);

        // 增强 system prompt：先完整渲染一份候选 prompt，再按 session/provider/model/cwd 冻结。
        // env/git/ActionLog/project memory/rules 都可能跨 turn 变化；如果每轮把候选 prompt
        // 直接刷新进 Host，就会让主 agent 的 prompt-cache prefix 每轮漂移。
        //
        //   user UI 切语言后必须每次 chat 用当前 language 重建 basePrompt, 否则永远 zh.
        //   buildInstructions 用了模型 profile (style/append/edit_override), 比直接拿 cached 准确.
        //
        //   后再构建 prompt, 否则中途切模型后 identity/profile/cache 仍可能沿用旧模型。
        let basePrompt = this.config.systemPrompt ?? 'Single agent mode';
        try {
          const modelEntry = Array.isArray(provider?.models)
            ? provider.models.find((entry: any) => entry?.name === actualModelName)
            : undefined;
          const rebuilt = buildInstructions({
            workDir: this.config.workDir,
            language: uiLang,
            skipEnvironment: true,
            protocol: provider?.protocol,
            model: actualModelName,
            baseUrl: provider?.baseUrl,
            profileId: (modelEntry as any)?.profileId ?? provider?.profileId,
            agentMode,
            /* provider 设置里的 "注入 Codex Prompt" 开关 — false 时降级 layered */
            disableCodexPrompt: (provider as any)?.injectCodexPrompt === false,
          });
          if (rebuilt && typeof rebuilt === 'string') basePrompt = rebuilt;
        } catch { /* 失败时 fallback 用 cached this.config.systemPrompt */ }

        /* 聊天 / 轻档换精简 prompt (turnTier.ts)。轻档看的是引擎**此刻**还在不在轻档:
         * 正则预解锁之类在建树时就把它顶成满档的, 这里就给满档 prompt, 两边对得上。 */
        const promptTier = chatMode ? 'chat' as const : (toolTreeEngineRef?.isLite ? 'lite' as const : null);
        const promptParts = promptTier
          ? [buildChatPrompt(promptTier, uiLang)]
          : [basePrompt, getSubagentInstructionsForMode(agentMode), TOOL_TREE_INSTRUCTIONS];

        // PTC system prompt（GPT 模型跳过; 仅 code 模式, 与工具注入同门控）
        if (!promptTier && this.isPTCEnabled() && agentMode === 'code' && !isGPTModel(actualModelName)) {
          promptParts.push(PTC_INSTRUCTIONS);
        }

        // ── 以下为动态候选部分：每轮可能变化，最终会被 frozen prompt 截住，不直接刷新进模型前缀 ──
        /* 环境 / git / 项目记忆 / 规则都是干活用的, 聊天档不带 */
        if (!promptTier) promptParts.push(...modelIndependentPromptParts);

        const identityNote = getModelIdentityNote(actualModelName, uiLang);
        /* 幂等 marker — 中英文标语都查, 避免重复注入 */
        const identityMarker = uiLang === 'en' ? 'Your underlying model is' : '你的底层模型是';
        if (identityNote && !promptParts.some(p => p.includes(identityMarker))) {
          promptParts.push(identityNote);
        }

        const renderedPromptCandidate = promptParts.join('\n\n');
        const promptCacheKey = [
          sessionId,
          actualProviderId,
          actualModelName,
          this.config.workDir,
          `mode:${agentMode}`,
          `tier:${promptTier ?? 'agent'}`,
          this.isPTCEnabled() ? 'ptc:on' : 'ptc:off',
          stableHash(basePrompt),
        ].join('::');
        const candidateHash = stableHash(renderedPromptCandidate);
        const cachedRenderedPrompt = this.renderedPromptBySession.get(sessionId);
        const promptKeyChanged = !!cachedRenderedPrompt && cachedRenderedPrompt.key !== promptCacheKey;
        let enhancedPrompt = renderedPromptCandidate;
        let promptCacheState: 'captured' | 'reused' | 'replaced' = 'captured';
        if (cachedRenderedPrompt?.key === promptCacheKey) {
          enhancedPrompt = cachedRenderedPrompt.prompt;
          promptCacheState = 'reused';
          if (cachedRenderedPrompt.hash !== candidateHash) {
            cliLogger.warn('CACHE_PREFIX', 'Main agent prompt candidate changed; reusing frozen prompt for cache stability', {
              sessionId,
              model: actualModelName,
              frozenHash: cachedRenderedPrompt.hash,
              candidateHash,
              frozenChars: cachedRenderedPrompt.prompt.length,
              candidateChars: renderedPromptCandidate.length,
            });
          }
        } else {
          promptCacheState = cachedRenderedPrompt ? 'replaced' : 'captured';
          this.renderedPromptBySession.set(sessionId, {
            key: promptCacheKey,
            prompt: renderedPromptCandidate,
            hash: candidateHash,
            capturedAt: Date.now(),
          });
        }

        if (actualRouteChanged || promptKeyChanged) {
          clearSessionSnapshot(sessionId);
          cliLogger.warn('SINGLE_AGENT', 'Provider/model prompt route changed; forcing system prompt refresh', {
            sessionId,
            previousProviderId: previousPromptRoute?.providerId,
            previousModelName: previousPromptRoute?.modelName,
            nextProviderId: actualProviderId,
            nextModelName: actualModelName,
            promptKeyChanged,
          });
        }

        const forceMemorySystemPromptRefresh = actualRouteChanged
          || (!!previousPromptRoute && promptCacheState !== 'reused')
          || promptKeyChanged;
        cliLogger.info('CACHE_PREFIX', 'Main agent prompt prefix snapshot', {
          sessionId,
          provider: actualProviderId,
          model: actualModelName,
          state: promptCacheState,
          forceMemorySystemPromptRefresh,
          systemHash: stableHash(enhancedPrompt),
          candidateHash,
          systemChars: enhancedPrompt.length,
          liveToolsHash: stableHash(liveTools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }))),
          liveToolNames: liveTools.map(t => t.name),
        });
        renderedPromptRef = enhancedPrompt;

        /* sticky-latch: 把父 session 的 cache-safe 快照 (system + tools + model + cwd)
         * 落到全局 registry, sub-agent fork 时无需 caller 显式 thread 各种 ref, 直接按
         * parent sessionId 查. 已经 capture 过的不会被覆盖, 防 mid-session flip. */
        captureSessionSnapshot(sessionId, {
          renderedSystemPrompt: enhancedPrompt,
          liveTools,
          model: actualModelName,
          workspacePath: this.config.workDir,
        });

        return {
          enhancedPrompt,
          forceMemorySystemPromptRefresh,
          providerId: actualProviderId,
          modelName: actualModelName,
        };
      };
      const isAutoRouted = metadata?.isAutoRouted === true;
      if (isAutoRouted) {
        this.modelRouter.refresh();
      }

      const result = await this.orchestrator.runSession({
        sessionId,
        prompt,
        metadata,
        providerId: runProviderId,
        modelName: runModelName,
        isAutoRouted,
        routeConfig: metadata?.routeConfig,
        modelRouter: isAutoRouted ? this.modelRouter : null,
        /* 关键: 把 abort signal 透传给 hostService.runTask → host.runTask → runner.run.
           runner 内的 withStreamWatchdog 会 race signal 拒绝, 立刻抛 AbortError,
           主 LLM SSE 流第一时间断开, run_result 事件触发, 前端 streaming 翻 false. */
        abortSignal: abortController.signal,
        buildHostConfig: (provider, llmConfig) => {
          // SessionSyncManager.loadHistory() 调用 memory.clear() 清空了其他 session 的上下文
          let sessionMemory = this.sessionMemoryMap.get(sessionId);
          if (!sessionMemory) {
            sessionMemory = new ShortTermMemory(
              (this.config.memory as any).maxMessages ?? 50
            );
            try {
              const ctx = SessionContext.get(sessionId);
              for (const item of ctx.getAll()) {
                // system 由本轮 frozen prompt 注入；旧库里如果残留 system，直接复用会破坏 cache prefix。
                // 压缩摘要例外: 原文已压掉, 摘要不还原 = 那段历史蒸发。
                if (item.role === 'system' && !isCompactionSummaryMessage(item)) continue;
                if (item.raw && typeof item.raw === 'object') {
                  /* 完整还原: 保留 tool_calls / tool_call_id / 多模态 content array.
                   * normalizeMessageContent 顺手把 string content 规范化成 Claude 兼容形状. */
                  const normalized = {
                    ...item.raw,
                    role: item.role,
                    content: normalizeMessageContent(item.raw.content ?? item.content),
                  };
                  sessionMemory.add(normalized as any);
                } else {
                  sessionMemory.add({ role: item.role as any, content: item.content });
                }
              }
              cliLogger.info('SINGLE_AGENT',
                `✨ Restored memory for session ${sessionId} (${ctx.size} messages from SessionContext)`,
              );
            } catch (err: any) {
              cliLogger.warn('SINGLE_AGENT', `SessionContext restore failed: ${err?.message}`);
            }
            this.sessionMemoryMap.set(sessionId, sessionMemory);
          } else {
            cliLogger.info('SINGLE_AGENT', `🔄 Reusing existing memory for session ${sessionId} (${sessionMemory.getAll().length} messages)`);
          }

	          /* configKey 必须包含 provider.updatedAt — 否则 /provider edit 改 apiKey 后,
	           * sessionId+providerId+modelName 不变 → 复用 cached host → 旧 OpenAIProvider
	           * 实例里的旧 apiKey 一直被用. ProviderStore.updateProvider 已在每次写入时
	           * 刷新 updatedAt, 这里跟着变就能强制重建 host. */
	          const providerVersion = provider.updatedAt || provider.createdAt || '';
	          const preparedPrompt = preparePromptForRoute(provider, llmConfig);
	          return {
	            sessionId,
	            /* configKey 带上 workspace — 同 session 换项目根时强制重建 host,
	             * 否则旧 host 的 runner.workspacePath 还指着旧目录 (工具 ALS 全错). */
            configKey: `single_agent:${sessionId}:${preparedPrompt.providerId}:${preparedPrompt.modelName}:${providerVersion}:${sessionWorkspace}:cw${llmConfig?.maxInputTokens ?? ''}`,
	            provider,
	            llmConfig,
	            workspacePath: sessionWorkspace,
	            workspaceRoots: (request as any).workspaceRoots || this.config.workspaceRoots,
	            workDir: sessionWorkspace,
	            instructions: preparedPrompt.enhancedPrompt,
	            systemPrompt: preparedPrompt.enhancedPrompt,
            agentName: 'AgenticAgent',
            agentDescription: 'Single agent mode runtime',
            permissionManager: this.config.permissionManager,
            tools: liveTools,
            resolveDeferredTool,
	            memory: sessionMemory,
	            // Feature 1: 启用 session 持久化
	            sessionEnabled: true,
	            forceSystemPromptRefresh: preparedPrompt.forceMemorySystemPromptRefresh,
            enableFGTS: this.config.enableFGTS,
            compressionMode: this.contextCompression.mode,
            compressionThreshold: this.contextCompression.threshold,
            autoCompressEnabled: this.contextCompression.autoEnabled,
            agentConfig: {
              temperature: 0.6,
              mode: this.config.agentMode ?? AgentMode.AGENT,
              maxIterations: 0,
              maxToolCalls: 9999,
            },
          };
        },
        onRuntimeEvent: (event, tracker) => {
          /* 任何一个运行时事件都算"这一轮还活着" — 文本 token / thinking / 工具开始 /
           * 工具返回 / 状态事件全都在这条路上汇聚, 所以在这里记一次进展最完整,
           * 不用去每个子系统里补埋点。 */
          noteTurnProgress(sessionId, String((event as { type?: unknown })?.type ?? 'event'));
          // agentic 模式主 agent 不设 sourceLabel，UI 不显示多余标签
          // 任务 Agent（explore）的 sourceLabel 在 agenticModeTools 中已设置
          handlers?.onRuntimeEvent?.(event, tracker);
          this.handleRuntimeEvent(event, sessionId, handlers);
        },
        onStatus: (level, message) => {
          const statusType = level === 'warning'
            ? 'warning'
            : level === 'error'
              ? 'error'
              : 'info';

          handlers?.onRuntimeEvent?.({
            type: 'status',
            status: statusType,
            message,
            timestamp: Date.now(),
          }, {
            contextUsed: 0,
            startTime: Date.now(),
            provider: runProviderId || 'unknown',
            model: runModelName || 'unknown',
          });
        },
      });

      const summary = result.summary.output || 'Task completed';
      handlers?.onComplete?.(summary);

      if (neoxLogger.isEnabled()) {
        const chatDuration = Date.now() - _chatStartTime;
        neoxLogger.info('SINGLE', `═══ Chat END ═══`, {
          sessionId,
          durationMs: chatDuration,
          durationSec: (chatDuration / 1000).toFixed(1),
          contextUsed: result.contextUsed,
          model: runModelName,
        });
      }

      // Feature 5: Auto Memory — 对话结束后异步提取记忆
      if (this.config.actionLog) {
        this.runAutoMemory(sessionId, runProviderId, runModelName).catch(e => {
          cliLogger.warn('SINGLE_AGENT', 'Auto memory extraction failed', { error: e.message });
        });
      }

      cliLogger.info('SINGLE_AGENT', `Chat completed`, {
        sessionId,
        contextUsed: result.contextUsed,
      });

      this.sessionPromptRouteBySession.set(sessionId, {
        providerId: result.providerId || runProviderId,
        modelName: result.modelName || runModelName,
      });

      interruptedRunStore?.markCompleted(sessionId);
      return summary;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      handlers?.onError?.(err);
      cliLogger.error('SINGLE_AGENT', `Chat failed`, { error: err.message });
      /* abort 跟 error 分开标记 — abort 是用户主动 (UI 点停止 / 切 session 等),
       * 不算 in-flight, 应该被 resume scanner 忽略. */
      const isAbort = abortController.signal.aborted
        || /aborted|cancel/i.test(err.message || '');
      if (isAbort) {
        interruptedRunStore?.markCancelled(sessionId);
      } else {
        interruptedRunStore?.markErrored(sessionId, err.message || 'unknown');
      }
      throw err;
    } finally {
      // 都是本次 chat 作用域内的东西, 不应该跨 chat 存留.
      // 注意: sessionMemoryMap 和 activeSessionHandlers 是跨 chat 保持的 (后台 agent
      // 完成后还要 announce), 不在这里清.
      if (this.sessionAbortControllers.get(sessionId) === abortController) {
        this.sessionAbortControllers.delete(sessionId);
      }
      this.sessionInjectors.delete(sessionId);
      this.sessionMemoryV2.delete(sessionId);
      /* 这一轮结束 — 无论正常收尾/abort/抛错都要拆看门狗, 否则空转的定时器会
       * 在一个已经结束的 turn 上误报停滞。 */
      disarmTurnStallGuard(sessionId);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      this.heartbeatTimers.delete(sessionId);
      /* 清父 session 的 cache-safe 快照 — 本轮 chat 结束, 下次 chat 重新 capture.
       * 不立即清, sub-agent 在本 finally 之后可能还会读 (orchestrator runSession 是
       * await 完整完成才到 finally, 所以 sub-agent 都跑完了, 这里清是安全的). */
      clearSessionSnapshot(sessionId);
      void this.maybeSaveSessionMemory(sessionId);
    }
  }

  private sessionMemorySavedAt = new Map<string, { at: number; msgs: number }>();

  private async maybeSaveSessionMemory(sessionId: string): Promise<void> {
    try {
      const all = this.sessionMemoryMap.get(sessionId)?.getAll() ?? [];
      const msgs = all.length;
      if (msgs < 3) return;   /* 太短没意义 —— 跟 saveSessionMemoryNow 自己的判据一致 */
      if (!all.some((m: any) => m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0)) return;
      const last = this.sessionMemorySavedAt.get(sessionId);
      const enoughTime = !last || Date.now() - last.at >= SESSION_MEMORY_MIN_INTERVAL_MS;
      const enoughNew = !last || msgs - last.msgs >= SESSION_MEMORY_MIN_NEW_MSGS;
      if (!enoughTime && !enoughNew) return;
      /* 先记账再干活 —— 不然一轮跑得慢时下一轮会重复触发 */
      this.sessionMemorySavedAt.set(sessionId, { at: Date.now(), msgs });
      await this.saveSessionMemoryNow(sessionId);
    } catch (err: any) {
      /* 落盘失败绝不能影响这一轮的收尾 */
      cliLogger.debug('SINGLE_AGENT', `每轮会话记忆落盘跳过: ${err?.message ?? err}`);
    }
  }


  private handleRuntimeEvent(
    event: any,
    sessionId: string,
    handlers?: AgenticChatHandlers
  ): void {
    switch (event.type) {
      case 'text':
        handlers?.onText?.(event.text);
        break;
      case 'thinking':
        handlers?.onThinking?.(event.text);
        break;
      case 'tool_call':
        handlers?.onToolCall?.(event.name, event.args);
        // 动态模块上下文注入 (per-session)
        this.sessionInjectors.get(sessionId)?.onToolCall(event.name, event.args);
        break;
      case 'tool_result':
        handlers?.onToolResult?.(event.name, event.result);
        break;
    }
  }
  abort(sessionId?: string): void {
    /* 记下"这一轮是被打断的" —— target 自动续跑看这个标记决定要不要爬起来。
     * 用户点了停止就是不想让它再跑, 自动续跑必须让位。 */
    if (sessionId) this.sessionInterrupted.set(sessionId, true);
    // (并发 agent 工具共享主 session signal, 一次 abort 会把还在飞的兄弟全拉下)
    // 双写: cliLogger (开了 CLI_DEBUG 就落盘) + console.warn (dev stderr 立刻看到)
    const trigger = new Error('abort-trigger').stack?.split('\n').slice(1, 8).join('\n') || '(no stack)';
    const activeAgents = this.backgroundManager?.listActive?.().length ?? 0;
    const info = {
      sessionId,
      activeSessionCount: this.sessionAbortControllers.size,
      runningBackgroundAgents: activeAgents,
    };
    cliLogger.warn('SINGLE_AGENT', '[ABORT_TRIGGER] abort() called', { ...info, stack: trigger });
    console.warn('[ABORT_TRIGGER] agenticRuntime.abort()', info, '\n' + trigger);

    if (sessionId) {
      const host = this.hostService.getHost(sessionId);
      host?.interrupt();
      const ac = this.sessionAbortControllers.get(sessionId);
      if (ac) {
        ac.abort();
        this.sessionAbortControllers.delete(sessionId);
      }
      this.backgroundManager.abortBySession(sessionId);
    } else {
      for (const ac of this.sessionAbortControllers.values()) {
        ac.abort();
      }
      this.sessionAbortControllers.clear();
      this.backgroundManager.abortAll();
    }
    // Host 复用机制会在下次 chat() 时 getOrCreateHost()
    // Host 内部的 runTask finally 已经正确清理了 isRunning/abortController
    cliLogger.info('SINGLE_AGENT', 'Aborted (host preserved for conversation continuity)', { sessionId });
  }

  setAgentMode(mode: AgentMode): void {
    this.config.agentMode = mode;
  }

  /** server/main.ts 拿到 manager 才能做 list/abort sub-agent —— UI 控制栏所需 */
  getBackgroundAgentManager(): BackgroundAgentManager {
    return this.backgroundManager;
  }

  /**
   * R2 wire: 触发 W4 SessionMemory 提取 — 拿当前 session 的 messages 用 LLM 生成
   * 7 段语义化摘要, 写到 ~/.neox/workspaces/<id>/session-memory.md (不进用户项目). 下次同 workspace 新 session
   * 自动通过 sectionRegistry 'session-memory-context' 注入到 prompt.
   *
   * 调用时机 (业务方决定):
   *   - 用户 /clear (CLI 命令处理点)
   *   - 用户主动 /save-memory (CLI 命令)
   *   - desktop session-close button
   *
   * 失败静默 (cliLogger.warn), 不抛错 — 摘要失败不该阻塞 user 操作.
   * 消息数 < 3 时跳过 (太短没意义).
   *
   * @returns 写入的文件路径 + summary, 或 null 表示跳过
   */
  async saveSessionMemoryNow(
    sessionId: string,
    options?: { providerId?: string; modelName?: string; maxSummaryWords?: number },
  ): Promise<{ filePath: string; summary: SessionMemorySummary } | null> {
    const sessionMemory = this.sessionMemoryMap.get(sessionId);
    if (!sessionMemory) {
      cliLogger.debug('SINGLE_AGENT', `saveSessionMemoryNow: no memory for session ${sessionId}`);
      return null;
    }
    const messages = sessionMemory.getAll();
    if (messages.length < 3) {
      cliLogger.debug('SINGLE_AGENT', `saveSessionMemoryNow: session ${sessionId} too short (${messages.length} msgs)`);
      return null;
    }

    const host = this.hostService.getHost(sessionId);
    if (!host) {
      cliLogger.debug('SINGLE_AGENT', `saveSessionMemoryNow: no active host for session ${sessionId}`);
      return null;
    }
    const llmProvider = host.getLlmProvider();
    if (!llmProvider) {
      cliLogger.debug('SINGLE_AGENT', `saveSessionMemoryNow: host has no llmProvider for session ${sessionId}`);
      return null;
    }

    const mainModelName = options?.modelName
      || this.activeSessionHandlers.get(sessionId)?.modelName
      || this.config.modelName;
    if (!mainModelName) {
      cliLogger.debug('SINGLE_AGENT', `saveSessionMemoryNow: no modelName for session ${sessionId}`);
      return null;
    }

    const summaryModelName = getSummaryModel(mainModelName);

    /* 适配 Neox LLMProvider → SessionMemoryLLMProvider (简化接口).
     *   chat() 是 stateless 调用, prompt cache 按 system prompt 自然分开 — 不会破主 cache. */
    const adapter: SessionMemoryLLMProvider = {
      chat: async (msgs, opts) => {
        const response = await llmProvider.chat(msgs as any, {
          model: opts?.model ?? summaryModelName,
          temperature: opts?.temperature,
          maxTokens: opts?.maxTokens,
        } as any);
        const content = response.choices?.[0]?.message?.content ?? '';
        return { content };
      },
    };

    try {
      const result = await extractAndSaveSessionMemory({
        workspaceRoot: this.config.workDir,
        messages: messages as any,
        llmProvider: adapter,
        model: summaryModelName,
        maxSummaryWords: options?.maxSummaryWords,
      });
      cliLogger.info('SINGLE_AGENT',
        `W4 session memory saved: ${result.filePath} (${messages.length} msgs → 9 sections, summary-model=${summaryModelName} vs main=${mainModelName})`);
      return result;
    } catch (err: any) {
      cliLogger.warn('SINGLE_AGENT', `saveSessionMemoryNow failed for ${sessionId}: ${err?.message ?? err}`);
      return null;
    }
  }

  async compactSession(
    sessionId: string,
    onEvent?: (event: any) => void,
    modelOverride?: string,
  ): Promise<void> {
    let host = this.hostService.getHost(sessionId);
    if (!host) {
      host = await this.ensureHostForCompaction(sessionId, modelOverride);
    }
    const unsubscribe = onEvent ? host.on(onEvent) : undefined;
    try {
      await host.compactSession();
    } finally {
      unsubscribe?.();
    }
  }

  private async ensureHostForCompaction(sessionId: string, modelOverride?: string): Promise<AgentRuntimeHost> {
    const sessionRef = this.activeSessionHandlers.get(sessionId);

    /* model：桌面传的 session.modelId > 同进程 chat 记录 > config 默认。
     * 订阅模式下 modelName 一定有值（session 创建时就确定了），直接传给 resolveProvider，
     * resolveProvider 收到 modelName 后直接用，不查本地模型列表。 */
    const modelName = modelOverride || sessionRef?.modelName || this.config.modelName;
    const providerId = sessionRef?.providerId || this.config.providerId;
    const resolved = this.config.resolveProvider(providerId, modelName);
    const resolvedModel = resolved.llmConfig?.model;

    if (!resolved.provider) {
      throw new Error('压缩暂不可用:未找到可用的模型 provider。请检查模型/网关配置。');
    }
    if (!resolvedModel) {
      throw new Error('压缩暂不可用:无法确定会话使用的模型。请先发送一条消息(选好模型)后再压缩。');
    }

    /* 还原/复用 session memory(跟 chat 的 buildHostConfig 同款: 从 SessionContext 单源还原) */
    let sessionMemory = this.sessionMemoryMap.get(sessionId);
    if (!sessionMemory) {
      sessionMemory = new ShortTermMemory((this.config.memory as any).maxMessages ?? 50);
      try {
        const ctx = SessionContext.get(sessionId);
        for (const item of ctx.getAll()) {
          // system 由本轮 host/systemPrompt 注入；旧库残留 system 不参与恢复。压缩摘要例外。
          if (item.role === 'system' && !isCompactionSummaryMessage(item)) continue;
          if (item.raw && typeof item.raw === 'object') {
            sessionMemory.add({
              ...item.raw,
              role: item.role,
              content: normalizeMessageContent(item.raw.content ?? item.content),
            } as any);
          } else {
            sessionMemory.add({ role: item.role as any, content: item.content });
          }
        }
        cliLogger.info('COMPACT', `restored memory for compaction: session ${sessionId} (${ctx.size} msgs)`);
      } catch (err: any) {
        cliLogger.warn('COMPACT', `SessionContext restore failed: ${err?.message}`);
      }
      this.sessionMemoryMap.set(sessionId, sessionMemory);
    }

    const providerVersion = (resolved.provider as any).updatedAt || (resolved.provider as any).createdAt || '';
    const basePrompt = this.config.systemPrompt ?? 'Single agent mode';
    const config: RuntimeHostConfig = {
      sessionId,
      configKey: `single_agent:${sessionId}:${providerId}:${modelName}:${providerVersion}:cw${resolved.llmConfig?.maxInputTokens ?? ''}`,
      provider: resolved.provider,
      /* 强制带上 model — OpenAIAdapter 要求显式 llmConfig.model, 不接受静默 fallback。 */
      llmConfig: { ...(resolved.llmConfig || {}), model: resolvedModel },
      workspacePath: this.config.workDir,
      workDir: this.config.workDir,
      instructions: basePrompt,
      systemPrompt: basePrompt,
      agentName: 'AgenticAgent',
      agentDescription: 'Single agent mode runtime',
      permissionManager: this.config.permissionManager,
      tools: [],
      memory: sessionMemory,
      sessionEnabled: true,
      enableFGTS: this.config.enableFGTS,
      agentConfig: { temperature: 0.6, mode: this.config.agentMode ?? AgentMode.AGENT },
    };
    cliLogger.info('COMPACT', `creating on-demand host for compaction: session ${sessionId} model=${modelName}`);
    return this.hostService.getOrCreateHost(config);
  }

  /**
   * 设置页「上下文」三个开关的唯一写入口。
   *
   * 两件事一起做, 缺一不可:
   *   1. 存进 contextCompression → 之后新建的 host 在 buildHostConfig 里带上 (重启/换会话仍生效)
   *   2. 热推给所有在跑的 host → 用户改完立刻生效, 不用重启
   *
   * 传 undefined 表示"这一项不动"; threshold 传 0 或越界值等于恢复默认公式。
   */
  setContextCompression(next: {
    mode?: 'sync' | 'async';
    threshold?: number;
    autoEnabled?: boolean;
  }): void {
    if (next.mode !== undefined) this.contextCompression.mode = next.mode;
    if (next.threshold !== undefined) {
      this.contextCompression.threshold =
        next.threshold > 0 && next.threshold <= 1 ? next.threshold : undefined;
    }
    if (next.autoEnabled !== undefined) this.contextCompression.autoEnabled = next.autoEnabled;

    const { mode, threshold, autoEnabled } = this.contextCompression;
    let applied = 0;
    this.hostService.forEachHost((host) => {
      applied++;
      if (next.mode !== undefined) host.setCompressionMode?.(mode!);
      if (next.threshold !== undefined) host.setCompressionThreshold?.(threshold);
      if (next.autoEnabled !== undefined) host.setAutoCompressEnabled?.(autoEnabled!);
    });
    cliLogger.info(
      'COMPACT',
      `context compression updated (mode=${mode ?? 'default'} threshold=${threshold ?? 'default'} auto=${autoEnabled ?? 'default'}) → pushed to ${applied} live host(s)`,
    );
  }

  getSessionMemory(sessionId: string): ShortTermMemory | undefined {
    return this.sessionMemoryMap.get(sessionId);
  }

  getSessionContextWindow(sessionId: string): number | undefined {
    const host = this.hostService.getHost(sessionId);
    return host?.getContextWindow();
  }

  injectMessageToSession(sessionId: string, message: string, images?: Array<{ mediaType: string; data: string; name?: string }>): number {
    const host = this.hostService.getHost(sessionId);
    if (!host) return 0;
    return host.injectUserMessage(message, images);
  }

  steerSession(sessionId: string): boolean {
    const host = this.hostService.getHost(sessionId);
    return host?.requestSteeringInterrupt() ?? false;
  }

  /** 排队插话为什么没排上 —— 区分"这个 sessionId 压根没有 host"和"有 host 但它没在跑"。
   *  上游以前一律报 no_running_task, 两种情况完全不同的修法却给同一个说法, 查起来全靠猜。 */
  describeInjectTarget(sessionId: string): { hasHost: boolean; isRunning: boolean; hostSessionIds: string[] } {
    const host = this.hostService.getHost(sessionId);
    const hostSessionIds: string[] = [];
    this.hostService.forEachHost((_h, sid) => { hostSessionIds.push(sid); });
    return {
      hasHost: !!host,
      isRunning: host ? host.isTaskRunning() : false,
      hostSessionIds,
    };
  }

  /**
   * 撤回指定 session 最后一条排队消息 (↑ 拉回输入框编辑), 返回其文本 (空/无 host → null)。
   */
  removeLastPendingFromSession(sessionId: string): string | null {
    const host = this.hostService.getHost(sessionId);
    return host?.removeLastPendingMessage() ?? null;
  }

  /**
   * 获取模式名称
   */
  getModeName(): string {
    return 'agentic';
  }

  private async runAutoMemory(sessionId: string, providerId?: string, modelName?: string): Promise<void> {
    if (!this.config.actionLog) return;

    // 从配置读取 Auto Memory 参数
    const { configService } = await import('@neoxlabs/platform/platform/configService.js');
    const amConfig = configService.getAutoMemoryConfig();
    if (!amConfig.enabled) return;

    const { readJevSettings } = await import('./jev/jevClient.js');
    let jev: ReturnType<typeof readJevSettings> = null;
    try { jev = readJevSettings(); } catch { /* 读盘失败 = 当没开 */ }
    if (!jev) return;

    const messages = this.sessionMemoryMap.get(sessionId)?.getAll() ?? [];
    if (messages.length < 4) return; // 对话太短，不提取

    const { lastExchange, judgeWorthRemembering, worthRemembering } = await import('./jev/jevMemoryGate.js');
    const exchange = lastExchange(messages as Array<{ role?: string; content?: unknown }>);
    const verdict = exchange ? await judgeWorthRemembering(jev, exchange) : null;
    cliLogger.info('SINGLE_AGENT', 'Auto memory gate (Jev)', verdict
      ? { rule: verdict.rule, lesson: verdict.lesson, ms: verdict.ms, extract: worthRemembering(verdict) }
      : { verdict: null });
    /* 判不出来 (Jev 超时 / 没有完整一问一答) 就不提 —— 拿不准时宁可不记 */
    if (!verdict || !worthRemembering(verdict)) return;

    try {
      /* 用这一轮实际跑的 provider + 模型。取 provider 列表的第一个模型会落到列表里排在
       * 最前的那个 (常是最贵的旗舰), 每轮多出一次无缓存的贵模型调用。 */
      const resolution = this.config.resolveProvider(providerId, modelName);
      if (!resolution.provider) return;
      const extractModel = modelName || resolution.provider.models?.[0]?.name || '';

      const { buildProvider } = await import('./runtimeBuilder.js');
      const result = buildProvider({
        provider: resolution.provider,
        model: extractModel,
        sessionId: `auto_memory_${Date.now()}`,
      });

      const engine = new AutoMemoryEngine({
        provider: result.llmProvider,
        model: extractModel,
        enabled: true,
        minConfidence: amConfig.minConfidence,
        maxItemsPerSession: amConfig.maxItemsPerSession,
        dedupThreshold: amConfig.dedupThreshold,
      });

      const { saved, skipped } = await engine.extract(messages, this.config.actionLog);
      if (saved > 0) {
        cliLogger.info('SINGLE_AGENT', `Auto memory: ${saved} saved, ${skipped} skipped`);
      }
    } catch (e: any) {
      cliLogger.warn('SINGLE_AGENT', 'Auto memory failed', { error: e.message });
    }
  }
}

const TOOL_TREE_INSTRUCTIONS = `
## 工具树
你的工具按类别组织。默认只有常驻工具可用。
需要其他工具时：
1. 先调用 tool_search 按关键词搜索，拿到工具的完整描述和参数格式
2. 搜到即解锁：命中的工具会直接进入你的工具表，下一轮直接原生调用它即可
   （只有还没解锁的工具才需要 call_tool({ name, args }) 代调）
不要猜测工具名和参数，必须先 tool_search 拿到 schema。
`;

const PTC_INSTRUCTIONS = `
## Programmatic Tool Calling (PTC)

\`ptc_execute\` 可以写 JavaScript 脚本一次性编排多个工具调用（比逐个 tool_call 快 3-10 倍）。

**何时用**：连续 3+ 个工具调用、批量文件操作、搜索→读取→分析组合、条件逻辑。
**何时不用**：1-2 次简单操作、需要用户确认。

⚠️ 预计 3+ 个工具调用时**必须用 ptc_execute**，不要逐个调用。

脚本里所有工具都是 async 函数，await 调用，console.log() 输出。
\`\`\`javascript
// 搜索 + 定位 + 批量读取
const results = await search({ pattern: 'handleError', path: 'src/' });
const files = results.split('\\n').filter(l => l.trim()).slice(0, 5);
for (const f of files) {
  const match = f.split(':')[0];
  const content = await readfile({ path: match, symbol: 'handleError' });
  console.log('=== ' + match + ' ===');
  console.log(content);
}
\`\`\`
`;
