import type { AgentConfig, Instructions, LLMProvider, StructuredOutputDefinition, Tool } from '@neoxlabs/kernel/types/index.js';
import { getPauseController, toPauseGate } from './pauseController.js';
import { getSmartReadDynamicPrompt } from '../tools/smart-read/index.js';
import { skillRegistry } from '../skills/index.js';
import { writeStallFile } from '@neoxlabs/kernel/utils/stallGuard.js';
import { resolveChannel } from '@neoxlabs/kernel/models/providerCapabilities.js';
import {
  isTargetActive,
  getTargetSystemPromptSection,
  setActiveTargetSession,
  rehydrateTargetFromDb,
  getTargetContinuationPrompt,
} from '../tools/targetModeTools.js';
/* 团队规划有自己的状态机 (teamPlanStore) —— 不再借 Target 的标记。
 * 三道续跑闸各加一条 team 分支: 规划没走完就别让这一轮结束, 走完就立刻收口交回用户。 */
import { isTeamPlanActive, teamStageDirective } from './team/teamPlanStore.js';
import { getTeamPlanPromptSection } from './team/teamPlanPrompt.js';
import { wrapSessionScopedToolsInPlace } from './sessionScopedTools.js';
import { wrapAskGateToolsInPlace } from './askGateTools.js';
import { appendDiagLog } from './agent/diagLogFile.js';
import { detectProjectContext } from '@neoxlabs/kernel/core/reasoning/projectContextDetector.js';
import { getModelOrchestrationPromptSection } from './modelOrchestrationPrompt.js';
import { getGitCoAuthorPromptSection } from './gitCoAuthor.js';
import { getActionFramePrompt } from '../tools/updatePlan.js';
import type { CompatProfile } from '@neoxlabs/kernel/types/compat.js';
import type { ProviderConfigEntry, ProviderModelConfig } from '@neoxlabs/platform/utils/config.js';
import type { ToolInputGuardrail, ToolOutputGuardrail } from '@neoxlabs/kernel/types/guardrails.js';
import type { MemoryPressureMonitor } from '@neoxlabs/kernel/compat/memoryPressure.js';
import type { PermissionManager } from '@neoxlabs/kernel/core/permissions/index.js';
import type { ResolvedModelProfile } from '@neoxlabs/kernel/profiles/index.js';
import { resolveBuiltinModelProfile } from '@neoxlabs/kernel/profiles/index.js';
import { StreamedRunner } from '@neoxlabs/kernel/core/runner.js';
import { DEFAULT_TOOL_INPUT_GUARDRAILS, DEFAULT_TOOL_OUTPUT_GUARDRAILS } from '@neoxlabs/kernel/core/defaultGuardrails.js';
import { getGlobalUserHookRunner, initGlobalUserHookRunner } from '../core/userHooks.js';
import { ShortTermMemory } from '@neoxlabs/kernel/memory/shortterm.js';
import { DefaultSessionManager } from '../memory/index.js';
import type { Session as PersistedSession } from '@neoxlabs/kernel/types/session.js';
import type { SessionSyncManager } from '../memory/session-sync.js';
import { ProviderFactory } from '../models/factory.js';
import { loadConfig } from '@neoxlabs/platform/utils/config.js';
import { hasRunningSubAgents } from './agent/backgroundAgent.js';
import { teamTerritoryGuardrail } from './team/teamTerritoryGuardrail.js';
import { OpenAIProvider } from '@neoxlabs/kernel/models/openai.js';
import { AnthropicProvider } from '@neoxlabs/kernel/models/anthropic.js';
import { DoubaoProvider } from '@neoxlabs/kernel/models/doubao.js';
import { GeminiProvider } from '@neoxlabs/kernel/models/gemini.js';
import { AgentRuntimeHost } from './agentRuntimeHost.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { readJevSettings } from './jev/jevClient.js';
import {
  UNFINISHED_MAX_NUDGES_PER_RUN,
  isUnfinished,
  judgeUnfinished,
  shouldAskUnfinished,
  unfinishedNudge,
} from './jev/jevTurnCompletion.js';
import type { SideAgentAdapter } from './sideAgentAdapter.js';

export interface ProviderControls {
  openai?: OpenAIProvider;
  anthropic?: AnthropicProvider;
  doubao?: DoubaoProvider;
  gemini?: GeminiProvider;
  setThinkingMode?: (mode: 'enabled' | 'disabled' | 'auto') => void;
}

export interface ProviderBuildOptions {
  provider: ProviderConfigEntry;
  model: string;
  sessionId?: string;
  profileId?: string;
  runtimeMode?: 'agentic' | 'default';
  /** P1-1: HMAC 签名 hook — 走 Neox cloud gateway 时必填; 直连第三方 provider 不传.
   *  callee 是 electron main 进程, 内部用 neox-native module 算 hmac, root secret 不进 JS heap. */
  hmacSigner?: (path: string, bodyHexHash: string) => Promise<{ ts: string; nonce: string; sig: string; version: string }>;
}

export interface ProviderBuildResult {
  llmProvider: LLMProvider;
  controls: ProviderControls;
  modelProfile: ResolvedModelProfile;
}

export interface RunnerBuildOptions {
  llmProvider: LLMProvider;
  model: string;
  tools: Tool[];
  /** 模型点名一个 deferred 工具时当场解锁 (接 ToolTreeEngine.promote)。
   *  见 kernel runner 的 resolveDeferredTool —— 「工具存在就该能调」。 */
  resolveDeferredTool?: (name: string) => boolean;
  memory: ShortTermMemory;
  config: AgentConfig;
  agentName: string;
  agentDescription: string;
  instructions: Instructions;
  contextInjection?: Instructions;
  plannerMode?: boolean;
  structuredOutput?: StructuredOutputDefinition;
  providerName?: string;
  contextWindow?: number;
  tailTokenBudget?: number;
  maxInputTokensOverride?: number;
  toolInputGuardrails?: ToolInputGuardrail[];
  toolOutputGuardrails?: ToolOutputGuardrail[];
  compressionMode?: 'sync' | 'async';
  compressionThreshold?: number;
  autoCompressEnabled?: boolean;
  workspacePath?: string;
  workspaceRoots?: string[];
  permissionManager?: PermissionManager;
  disableSystemPrompt?: boolean;
  /** Fine-Grained Tool Streaming */
  enableFGTS?: boolean;
  modelProfile?: ResolvedModelProfile;
  providerModelNames?: string[];
  /** per-session approval mode: runner 透传到 RunContext.sessionId,
   *  让 executionPolicyOrchestrator 用 sessionId 作 scopeKey 查 per-session 模式. */
  sessionId?: string;
}

export interface RuntimeHostBuildOptions {
  runner: StreamedRunner;
  memory: ShortTermMemory;
  sessionManager?: DefaultSessionManager;
  runtimeSessionId?: string;
  agentName?: string;
  agentDescription?: string;
  configuredToolCount?: number;
  /** Tool names registered for this runtime, used to suppress hallucinated tool_call UI events. */
  registeredToolNames?: Set<string>;
  sessionEnabled?: boolean;
  session?: PersistedSession;
  sessionSync?: SessionSyncManager;
  workDir: string;
  model: string;
  memoryPressure?: MemoryPressureMonitor;
  compatProfile?: CompatProfile | null;
  systemPrompt?: string;
  setSandboxMode?: (enabled: boolean) => void;
  llmProvider?: LLMProvider;
  sideAgentAdapter?: SideAgentAdapter;
}

const DOUBAO_BASE_URL_HINT = 'ark.cn-beijing.volces.com';

function isClaudeThinkingModel(model: string): boolean {
  return model.includes('opus-4-6') || model.includes('opus-4.6') || model.includes('opus-4-5') || model.includes('opus-4.5') || model.endsWith('-thinking');
}

function isDoubaoSeedModel(model: string): boolean {
  return model.includes('doubao-seed');
}

function isDoubaoBaseUrl(baseUrl?: string): boolean {
  return !!baseUrl && baseUrl.includes(DOUBAO_BASE_URL_HINT);
}

function extractOpenAIProvider(adapter: any): OpenAIProvider | undefined {
  const provider = adapter?.getProvider?.();
  return provider instanceof OpenAIProvider ? provider : undefined;
}

function extractAnthropicProvider(adapter: any): AnthropicProvider | undefined {
  const provider = adapter?.getProvider?.();
  return provider instanceof AnthropicProvider ? provider : undefined;
}

function extractGeminiProvider(adapter: any): GeminiProvider | undefined {
  const provider = adapter?.getProvider?.();
  return provider instanceof GeminiProvider ? provider : undefined;
}

function buildProviderControls(options: {
  model: string;
  baseUrl?: string;
  openaiProvider?: OpenAIProvider;
  anthropicProvider?: AnthropicProvider;
  doubaoProvider?: DoubaoProvider;
  geminiProvider?: GeminiProvider;
}): ProviderControls {
  const { model, baseUrl, openaiProvider, anthropicProvider, doubaoProvider, geminiProvider } = options;
  const controls: ProviderControls = {
    openai: openaiProvider,
    anthropic: anthropicProvider,
    doubao: doubaoProvider,
    gemini: geminiProvider,
  };

  const isOpenAIDoubao = !!openaiProvider && isDoubaoBaseUrl(baseUrl) && isDoubaoSeedModel(model);
  const supportsThinking = !!anthropicProvider || !!doubaoProvider || isOpenAIDoubao;

  if (supportsThinking) {
    controls.setThinkingMode = (mode) => {
      if (doubaoProvider) {
        doubaoProvider.setThinking({ type: mode });
      }
      if (isOpenAIDoubao && openaiProvider) {
        openaiProvider.setDoubaoThinking({ type: mode });
      }
      if (anthropicProvider) {
        const claudeMode = mode === 'auto' ? 'enabled' : mode;
        anthropicProvider.setThinking({ type: claudeMode });
      }
    };
  }

  return controls;
}

export function buildProvider(options: ProviderBuildOptions): ProviderBuildResult {
  const { provider: rawProvider, model, sessionId, profileId, runtimeMode, hmacSigner } = options;
  const channel = resolveChannel(rawProvider, { model, modality: 'chat' });
  const provider: ProviderConfigEntry = {
    ...rawProvider,
    protocol: channel.protocol,
    apiKey: channel.apiKey ?? rawProvider.apiKey,
    baseUrl: channel.baseUrl ?? rawProvider.baseUrl,
    urlSuffix: channel.urlSuffix ?? rawProvider.urlSuffix,
  };
  const protocol = provider.protocol;
  const modelConfig = provider.models?.find(entry => entry.name === model) as ProviderModelConfig | undefined;
  const baseUrl = provider.baseUrl || undefined;
  cliLogger.info('NEOX_DIAG', 'build-provider', {
    protocol,
    model,
    baseUrl,
    apiKeyPrefix: typeof provider.apiKey === 'string' ? provider.apiKey.slice(0, 12) + '...' : '(empty)',
    runtimeMode,
    providerName: provider.name,
    providerId: provider.id,
  });
  const modelProfile = resolveBuiltinModelProfile({
    protocol,
    model,
    baseUrl,
    explicitProfileId: profileId,
  });

  appendDiagLog('MODEL_PROFILE_RESOLVED', {
    model,
    profileId: modelProfile.id,
    sources: modelProfile.sourceProfileIds,
    reasoningEffort: modelProfile.reasoning?.effort ?? null,
    loopStrategy: modelProfile.loop?.strategy ?? null,
    areMaxLevel: modelProfile.are?.maxLevel ?? null,
    textOnlyGrace: modelProfile.completion?.textOnlyCompletionGrace ?? null,
  });
  cliLogger.info('MODEL_PROFILE', 'Resolved model profile', {
    protocol,
    model,
    profileId: modelProfile.id,
    profileSources: modelProfile.sourceProfileIds,
    promptStyle: modelProfile.prompt?.style,
    promptSource: modelProfile.prompt?.fullInstructions ? 'profile_full_instructions' : 'style_default',
    forceResponsesAPI: modelProfile.transport?.openai?.forceResponsesAPI ?? false,
    parallelToolCalls: modelProfile.transport?.openai?.parallelToolCalls ?? true,
    strictSSEDone: modelProfile.transport?.openai?.strictSSEDone ?? false,
  });

  let llmProvider: LLMProvider;
  let openaiProvider: OpenAIProvider | undefined;
  let anthropicProvider: AnthropicProvider | undefined;
  let doubaoProvider: DoubaoProvider | undefined;
  let geminiProvider: GeminiProvider | undefined;

  const uiLanguage = (() => {
    try { return (loadConfig() as any).language === 'en' ? 'en' : 'zh'; } catch { return 'zh'; }
  })() as 'zh' | 'en';

  if (protocol === 'openai' || protocol === 'openai-responses' || protocol === 'kimi' || protocol === 'glm' || protocol === 'deepseek' || protocol === 'qwen' || protocol === 'minimax' || protocol === 'grok') {
    const adapterConfig = {
      ...provider,
      defaultModel: model,
      lastSelectedModel: model,
      apiEndpoint: provider.urlSuffix,
      sessionId,
      runtimeMode,
      modelConfig,
      modelProfile,
      hmacSigner,
      language: uiLanguage,
      doubaoThinking: isDoubaoBaseUrl(baseUrl) && isDoubaoSeedModel(model) ? { type: 'enabled' as const } : undefined,
    };
    const adapter = ProviderFactory.createAdapter(protocol, adapterConfig as ProviderConfigEntry);
    llmProvider = adapter;
    openaiProvider = extractOpenAIProvider(adapter);
    if (openaiProvider && isDoubaoBaseUrl(baseUrl) && isDoubaoSeedModel(model)) {
      openaiProvider.setDoubaoThinking({ type: 'enabled' });
    }
  } else if (protocol === 'anthropic' || protocol === 'glm-claude' || protocol === 'kimi-claude') {
    const adapterConfig = {
      ...provider,
      defaultModel: model,
      lastSelectedModel: model,
      /* 会话 id 发上游 (session_id 头) —— opencode 不带就 400, 见 kernel anthropicSessionHeaders.ts */
      sessionId,
    };
    const adapter = ProviderFactory.createAdapter(protocol, adapterConfig as ProviderConfigEntry);
    llmProvider = adapter;
    anthropicProvider = extractAnthropicProvider(adapter);
    if (anthropicProvider && isClaudeThinkingModel(model)) {
      anthropicProvider.setThinking({ type: 'enabled' });
    }
  } else if (protocol === 'anthropic-openai') {
    const apiEndpoint = provider.urlSuffix || '/v1/messages';
    const openaiConfig = {
      apiKey: provider.apiKey,
      baseUrl,
      defaultModel: model,
      apiEndpoint,
      streamFormat: 'anthropic' as const,
      sessionId,
      runtimeMode,
      retry: provider.retry,
      modelConfig,
      modelProfile,
      hmacSigner,
      language: uiLanguage,
    };
    openaiProvider = new OpenAIProvider(openaiConfig);
    llmProvider = openaiProvider;
  } else if (protocol === 'doubao') {
    doubaoProvider = new DoubaoProvider({
      apiKey: provider.apiKey,
      baseUrl,
      defaultModel: model,
      thinking: { type: 'enabled' },
      retry: provider.retry,
    });
    llmProvider = doubaoProvider;
  } else if (protocol === 'gemini') {
    const adapterConfig = {
      ...provider,
      defaultModel: model,
      lastSelectedModel: model,
    };
    const adapter = ProviderFactory.createAdapter(protocol, adapterConfig as ProviderConfigEntry);
    llmProvider = adapter;
    geminiProvider = extractGeminiProvider(adapter);
  } else {
    throw new Error(`Unsupported provider protocol: ${protocol}`);
  }

  const controls = buildProviderControls({
    model,
    baseUrl,
    openaiProvider,
    anthropicProvider,
    doubaoProvider,
    geminiProvider,
  });

  return { llmProvider, controls, modelProfile };
}

export function buildRunner(options: RunnerBuildOptions): StreamedRunner {
  if (options.sessionId) {
    setActiveTargetSession(options.sessionId);
    rehydrateTargetFromDb(options.sessionId);
  } else {
    setActiveTargetSession(null);
  }

  /* UI language — 用于 loopContinuationGate.message i18n. 跟 buildProvider 走同一 config.language 字段. */
  const uiLanguage: 'zh' | 'en' = (() => {
    try { return (loadConfig() as any).language === 'en' ? 'en' : 'zh'; } catch { return 'zh'; }
  })();

  /* 本 run 内 verify 闸已经提醒过几次 — 闭包变量, 跟 runner 的 consecutiveBlocks 分开计。
   * (consecutiveBlocks 是"被任意 gate 拦下"的总数, 这里只数验证闸自己拦的。) */
  let verifyGateNudges = 0;

  /* Jev 收尾判定 (实验功能, 见 jev/jevTurnCompletion.ts): 其余闸都放行时再看一眼 ——
   * 模型只宣布了下一步就想结束, 拦一次让它直接做。同一次退出只拦一次, 每个 run 最多两次。 */
  let unfinishedNudges = 0;
  type GateDecision = { shouldContinue: boolean; message?: string; kind?: 'target' | 'verify' | 'team_spec' | 'unfinished' };
  const withJevUnfinishedGate = <C extends { consecutiveBlocks: number; task: string; finalText: string; totalToolCalls: number }>(
    gate: (ctx: C) => GateDecision,
  ) => async (ctx: C): Promise<GateDecision> => {
    const base = gate(ctx);
    if (base.shouldContinue || ctx.consecutiveBlocks > 0) return base;
    if (unfinishedNudges >= UNFINISHED_MAX_NUDGES_PER_RUN || hasRunningSubAgents(options.sessionId)) return base;
    if (!shouldAskUnfinished(ctx.finalText, ctx.totalToolCalls)) return base;
    let settings: ReturnType<typeof readJevSettings> = null;
    try { settings = readJevSettings(); } catch { /* 读盘失败 = 当没开 */ }
    if (!settings) return base;
    const verdict = await judgeUnfinished(settings, ctx.task, ctx.finalText);
    appendDiagLog('JEV_UNFINISHED', {
      sessionId: options.sessionId, ...verdict, nudge: !!verdict && isUnfinished(verdict),
      text: ctx.finalText.trim().slice(0, 80),
    });
    if (!verdict || !isUnfinished(verdict)) return base;
    unfinishedNudges++;
    return { shouldContinue: true, message: unfinishedNudge(uiLanguage === 'en'), kind: 'unfinished' };
  };

  /* P2-6: 用户 hooks 接线 — settings.json PreToolUse/PostToolUse matcher + .neox/hooks/ 脚本。
   *   惰性: 无任何 hook 配置时零 exec 开销 (hasPreToolHooks 快速路径)。
   *   pre 走 kernel preHook stage: block + reason 回注模型; postSuccess 通知式不拦截。 */
  const userHookRunner = options.workspacePath
    ? (getGlobalUserHookRunner() ?? initGlobalUserHookRunner(options.workspacePath))
    : null;
  const userToolHooks = userHookRunner
    ? {
        pre: {
          name: 'user-hooks',
          run: async (toolName: string, args: Record<string, unknown>) => {
            await userHookRunner.initialize();
            if (!userHookRunner.hasPreToolHooks()) return { allow: true };
            return userHookRunner.evaluatePreToolUse(toolName, args as Record<string, any>);
          },
        },
        postSuccess: {
          name: 'user-hooks',
          run: async (toolName: string, args: Record<string, unknown>, output: string) => {
            await userHookRunner.initialize();
            if (!userHookRunner.hasPostToolHooks()) return;
            await userHookRunner.firePostToolUse(toolName, args as Record<string, any>, output);
          },
        },
      }
    : undefined;

  /* 两层原地包装 (都保数组身份): session 作用域 + 「问完没人答禁副作用」闸 (askGateTools.ts) */
  const wrappedTools = wrapAskGateToolsInPlace(
    wrapSessionScopedToolsInPlace(options.tools, options.sessionId),
    options.sessionId,
  );

  return new StreamedRunner({
    llmProvider: options.llmProvider,
    model: options.model,
    tools: wrappedTools,
    resolveDeferredTool: options.resolveDeferredTool,
    memory: options.memory,
    config: options.config,
    agentName: options.agentName,
    agentDescription: options.agentDescription,
    instructions: options.instructions,
    contextInjection: options.contextInjection,
    plannerMode: options.plannerMode,
    structuredOutput: options.structuredOutput,
    providerName: options.providerName,
    contextWindow: options.contextWindow,
    tailTokenBudget: options.tailTokenBudget,
    maxInputTokensOverride: options.maxInputTokensOverride,
    toolInputGuardrails: [...(options.toolInputGuardrails ?? DEFAULT_TOOL_INPUT_GUARDRAILS), teamTerritoryGuardrail],
    toolOutputGuardrails: options.toolOutputGuardrails ?? DEFAULT_TOOL_OUTPUT_GUARDRAILS,
    compressionMode: options.compressionMode,
    compressionThreshold: options.compressionThreshold,
    autoCompressEnabled: options.autoCompressEnabled,
    workspacePath: options.workspacePath,
    workspaceRoots: options.workspaceRoots,
    permissionManager: options.permissionManager,
    disableSystemPrompt: options.disableSystemPrompt,
    enableFGTS: options.enableFGTS,
    modelProfile: options.modelProfile,
    providerModelNames: options.providerModelNames,
    sessionId: options.sessionId,
    pauseGate: options.sessionId ? toPauseGate(getPauseController(options.sessionId)) : undefined,
    smartReadHintProvider: getSmartReadDynamicPrompt,
    skillActivation: skillRegistry,
    userToolHooks,
    //   target 激活且尚未 done → 阻止 no-tool 退出, 注入 system 提醒让 model 下一轮继续.
    //   连续 3 次仍阻止不了(说明 model 不听话/环境异常) → 兜底放行, 避免死循环(loop 外部还有 maxIter 兜底).
    //   message 按 UI language 分中/英, 与 target system prompt section 保持语言一致.
    loopContinuationGate: withJevUnfinishedGate((ctx): GateDecision => {
      if (hasRunningSubAgents(options.sessionId)) return { shouldContinue: false };

      const forcedContinueOn = (() => {
        try { return (loadConfig() as any)?.agentRuntime?.autoContinue === 'on'; } catch { return false; }
      })();

      if (forcedContinueOn && isTeamPlanActive(options.sessionId)) {
        if (ctx.consecutiveBlocks >= 3) {
          /* 跟 target 同款兜底: 拦三次还不动手就放行, 不跟模型死磕 */
          cliLogger.warn('TEAM', `team plan gate: 连续 ${ctx.consecutiveBlocks} 次无 tool_use, 放行退出`);
          return { shouldContinue: false };
        }
        const directive = teamStageDirective(options.sessionId!, uiLanguage === 'en');
        const msg = (uiLanguage === 'en'
          ? '⚠ Team planning is not finished — do the next concrete step now, do not end this turn with a narration.\n'
          : '⚠ 团队规划还没走完 —— 立刻做下一步, 不许只说一段话就结束这一轮。\n') + (directive ?? '');
        return { shouldContinue: true, message: msg, kind: 'team_spec' };
      }
      if (!forcedContinueOn || !isTargetActive(options.sessionId)) {
        if (!forcedContinueOn) return { shouldContinue: false };
        if (ctx.runMutationCount <= 0 || ctx.ranVerifyTool) return { shouldContinue: false };
        if (verifyGateNudges >= 2) {
          try {
            writeStallFile('info', 'VERIFY', 'verify gate bailout: model kept ending without tests', {
              reason: 'verify_gate_bailout',
              nudges: verifyGateNudges,
              runMutationCount: ctx.runMutationCount,
              iteration: ctx.iteration,
              sessionId: options.sessionId ?? null,
            });
          } catch { /* 诊断写盘失败不影响主流程 */ }
          return { shouldContinue: false };
        }
        let testCommand: string | undefined;
        try {
          /* workspacePath = 会话绑定的项目根 (buildRunner 已按会话解析好);
           * 缺省时不猜测 cwd —— 拿错目录探到别人的 package.json 比不拦更糟。 */
          if (options.workspacePath) testCommand = detectProjectContext(options.workspacePath)?.testCommand;
        } catch { /* 探测失败 = 不拦 */ }
        if (!testCommand) return { shouldContinue: false };   // 项目没测试 → 本来就无从验证
        verifyGateNudges++;
        const msg = uiLanguage === 'en'
          ? `⚠ You changed ${ctx.runMutationCount} file(s) this turn but never ran the tests. `
            + `Run \`${testCommand}\` (run_tests) now. If it is red, fix it before ending the turn. `
            + `If the tests genuinely do not cover this change, say so in one line and finish.`
          : `⚠ 本轮改了 ${ctx.runMutationCount} 处文件但一次测试都没跑。`
            + `现在跑 \`${testCommand}\`(run_tests)。红了就修完再收尾。`
            + `如果这次改动确实不在测试覆盖范围内, 用一句话说明再结束。`;
        cliLogger.info('VERIFY', `verify gate: nudging model to run tests (nudge=${verifyGateNudges}, mutations=${ctx.runMutationCount})`);
        return { shouldContinue: true, message: msg, kind: 'verify' };
      }
      if (ctx.consecutiveBlocks >= 3) {
        try {
          writeStallFile('warn', 'TARGET', 'loop released: 3x no tool_use (agent narrated instead of acting)', {
            reason: 'target_gate_bailout',
            consecutiveBlocks: ctx.consecutiveBlocks,
            iteration: ctx.iteration,
            sessionId: options.sessionId ?? null,
          });
        } catch { /* 诊断写盘失败不影响主流程 */ }
        cliLogger.warn(
          'TARGET',
          `loopContinuationGate: 连续 ${ctx.consecutiveBlocks} 次仍无 tool_use, 放行退出以避免死循环. 建议用户 /target status 检查.`,
        );
        return { shouldContinue: false };
      }
      const message = uiLanguage === 'en'
        ? [
            '⚠ Target Mission is not yet confirmed done — you tried to end this turn without calling check_target_done.',
            'First update_plan to match reality (finished → completed, next milestone → in_progress).',
            'Then decide: every requirement backed by concrete evidence → check_target_done(done=true);',
            'otherwise done=false with what remains, and keep working with other tools (read code, edit files, run tests).',
            '"Close enough" exits are not allowed.',
          ].join(' ')
        : [
            '⚠ Target Mission 未确认完成 —— 你想结束这轮但还没调 check_target_done。',
            '先用 update_plan 对齐现实(完成的标 completed、下一个里程碑标 in_progress)。',
            '再判断: 目标每条要求都有真实证据 → check_target_done(done=true);',
            '否则 done=false 说明剩余, 然后继续用其他工具推进(读代码、改文件、跑测试)。',
            '不允许"感觉差不多了"就停。',
          ].join(' ');
      return { shouldContinue: true, message };
    }),
    //   · Target Mission: target 激活时追加约束段(粒度/plan-immutable/check_target_done 闸门等),
    //     off/satisfied/abandoned 时为空, dynamic_section 会被 memory.removeSystemTagged 清掉.
    //   · 智能模型编排 (Team P1 能力 1): config.agentRuntime.modelOrchestration='on' 时追加
    //     编排知识段 (查池选型/交叉审查/带理由), 默认 off 即完全无此段 — 关闭零行为变化.
    dynamicSystemPromptProvider: () => {
      const sections = [
        getTeamPlanPromptSection(options.sessionId, uiLanguage === 'en'),
        getTargetSystemPromptSection(options.sessionId),
        getModelOrchestrationPromptSection(),
        getGitCoAuthorPromptSection(),
      ].filter(Boolean);
      return sections.length > 0 ? sections.join('\n\n') : undefined;
    },
    perTurnInjector: (ctx) => {
      /* 团队规划优先 —— 它有自己的三阶段口径, 跟 Target 那套"逐块攻"完全不同 */
      if (isTeamPlanActive(options.sessionId)) {
        const directive = teamStageDirective(options.sessionId!, uiLanguage === 'en');
        return directive ? { message: directive } : undefined;
      }
      if (isTargetActive(options.sessionId)) {
        const prompt = getTargetContinuationPrompt(ctx.iteration, options.sessionId);
        return prompt ? { message: prompt } : undefined;
      }
      const frame = getActionFramePrompt(options.sessionId);
      return frame ? { message: frame } : undefined;
    },
  });
}

export function buildRuntimeHost(options: RuntimeHostBuildOptions): AgentRuntimeHost {
  return new AgentRuntimeHost({
    runner: options.runner,
    memory: options.memory,
    sessionManager: options.sessionManager || new DefaultSessionManager(),
    runtimeSessionId: options.runtimeSessionId,
    agentName: options.agentName,
    agentDescription: options.agentDescription,
    configuredToolCount: options.configuredToolCount,
    registeredToolNames: options.registeredToolNames,
    sessionEnabled: options.sessionEnabled ?? false,
    session: options.session,
    sessionSync: options.sessionSync,
    workDir: options.workDir,
    model: options.model,
    memoryPressure: options.memoryPressure,
    compatProfile: options.compatProfile,
    systemPrompt: options.systemPrompt,
    setSandboxMode: options.setSandboxMode,
    llmProvider: options.llmProvider,
    sideAgentAdapter: options.sideAgentAdapter,
  });
}

export function buildMemory(size?: number): ShortTermMemory {
  return new ShortTermMemory(size);
}
