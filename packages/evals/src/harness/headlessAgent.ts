/**
 * headlessAgent — 程序化跑一次 Neox agent, 不用 UI.
 *
 *   eval harness 的核心入口. 输入 (workspace 目录, prompt, model, provider key),
 *   内部:
 *     1. 起一个 isolated RuntimeOrchestrator (跟 SDK runAgent 同套路, 但 workDir 可配)
 *     2. 装载真实工具 (execute_shell / read_file / edit_file / browser_* / ...) — 不是 stub
 *     3. 跑到 agent 自己 yield 为止
 *     4. 返回 transcript / usage / 时长 / stop reason
 *
 *   不做的事 (留给上层 runner):
 *     · 把 workspace clone 到隔离目录 (Docker / git clone 的活)
 *     · 应用 patch / 跑测试 / 算分
 *     · 重试 / 并发调度
 *
 *   设计上跟 @neoxlabs/sdk 的 runAgent 互为镜像 — 后者面向公共, 用 sdk 提供的 stub 工具;
 *   这里面向内部 eval, 直接装载 neox-core 真工具, 不绕弯.
 */

import { createNodeServices } from '@neoxlabs/platform/platform/nodeServices.js';
import { PermissionManager } from '@neoxlabs/kernel/core/permissions/index.js';
import { ShortTermMemory } from '@neoxlabs/kernel/memory/shortterm.js';
import { RuntimeHostService } from '@neoxlabs/core/runtime/runtimeHostService.js';
import {
  RuntimeOrchestrator,
  type ProviderResolution,
} from '@neoxlabs/core/runtime/runtimeOrchestrator.js';
import { setToolServices, getTools } from '@neoxlabs/core/tools/runtimeTools.js';
import { runWithWorkspaceRoot } from '@neoxlabs/kernel/tools/workspaceContext.js';
import {
  createAgenticModeTools,
  AGENTIC_MODE_SUBAGENT_INSTRUCTIONS,
} from '@neoxlabs/core/runtime/agent/agenticModeTools.js';
import { BackgroundAgentManager } from '@neoxlabs/core/runtime/agent/backgroundAgent.js';
import type { AgentRuntimeEvent } from '@neoxlabs/core/runtime/runtimeTypes.js';
import type { ProviderConfigEntry, ProviderProtocol } from '@neoxlabs/kernel/types/configTypes.js';
import type { Message, Tool } from '@neoxlabs/kernel/types/index.js';

export type HeadlessProviderType =
  | 'anthropic' | 'openai' | 'openai-responses'
  | 'gemini' | 'kimi' | 'glm' | 'doubao';

export interface HeadlessAgentOptions {
  /** agent 的工作目录 — shell 命令 / 文件读写都从这里出发. 必须存在. */
  workspace: string;
  /** 用户 prompt — 对 SWE-bench 就是 issue body + 修复指引 */
  prompt: string;
  /** 模型名, e.g. 'claude-sonnet-4-6' / 'gpt-5' / 'kimi-k2' */
  model: string;
  /** provider 类型 — 决定走哪个协议 */
  providerType: HeadlessProviderType;
  /** API key (BYOK). env 没配就显式传 */
  apiKey: string;
  /** 可选 base URL — openai-compatible / 私有部署用 */
  baseURL?: string;
  /** 可选 system prompt 覆写; 不传走 neox-core 默认 layered prompt */
  systemPrompt?: string;
  /** 可选超时 ms; 不传不限. SWE-bench 单题 30min 上限是合理预算 */
  timeoutMs?: number;
  /**
   * 可选 turn/iteration 上限 — 传了就把 agentConfig.maxIterations 钉到这个值, 让 runner 跑满
   * N 次 LLM 迭代后 *优雅停* (stopReason='iteration_limit', 非 hard error). 不传 → runner 默认无限
   * (跟历史行为一致). Colony LEAN 实验用它给 builder 一个低 turn cap (强制 "实现直接, 别过度迭代").
   */
  maxIterations?: number;
  /** 流式回调 — 想看 agent 一步一步发生什么 (debug / 进度条) 时传. 默认不传 = 不订阅. */
  onEvent?: (event: AgentRuntimeEvent) => void;
  /** 外部 abort signal — 上层 runner 可强行打断 (超预算 / 用户 ctrl-c) */
  signal?: AbortSignal;
  /**
   * 子 Agent (explore / agent 任务 Agent) 配置 — 传了就把 agentic-mode 的
   * explore + agent + send_message 工具注入到主 agent 的工具集, 并把任务 Agent
   * 的 provider/model 路由到这里指定的模型.
   *
   *   · enabled=false / 不传 → 不注入子 Agent 工具 (单模型基线, 与历史行为一致).
   *   · model 不传 → 子 Agent 复用主 model (同模型自调度, 仍计入 subagent 调用数).
   *
   * 注入后:
   *   - explore 工具 (只读探索) 用 subAgent.model 跑.
   *   - agent 工具 (可写任务 Agent) 经 orchestrator.runSession + getTaskAgentRoute
   *     路由到 subAgent.model.
   * 主 agent 仍跑 options.model. 这就是 "main + sub 组合" 的注入点.
   */
  subAgent?: {
    enabled: boolean;
    /** 子 Agent 模型名; 不传则复用主 model (同 providerType / apiKey / baseURL). */
    model?: string;
  };
  /**
   * HMAC 签名回调 — 走 NeoxCloud gateway (apiKey=nxk_/anonkey_) 时必填.
   * 入参 path=完整 pathname (e.g. /n1/chat/completions), bodyHexHash=sha256(body) hex.
   * 出参 4 元组同 server sigverify 协议. 用 setExternalHmacSigner 注入到 OpenAIProvider.
   * BYOK 直连第三方 provider 时不需要.
   */
  hmacSigner?: (path: string, bodyHexHash: string) => Promise<{ ts: string; nonce: string; sig: string; version: string }>;
}

export interface HeadlessAgentResult {
  /** 最终 text 输出 (assistant 的最后一条 assistant message text concat) */
  finalText: string;
  /** 整个 run 的 message 序列 (含 tool calls / tool results) */
  messages: Message[];
  /** token 用量 */
  usage: {
    inputTokens: number;
    outputTokens: number;
    /** 含 cache hit 时填 (anthropic), 没有时 undefined */
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  /** agent 一共跑了几轮 (assistant 出 → 工具调用 → 结果回灌算 1 轮) */
  turns: number;
  /** 终止原因: end_turn / max_iterations / tool_error / abort / ... */
  stopReason: string;
  /** wall-clock 毫秒 */
  durationMs: number;
  /** 出现过的错误事件 (非 fatal, fatal 会直接 throw) */
  errors: string[];
  /** 子 Agent (explore / agent) 被主 agent 调起的次数; 没注入子 Agent 时为 0. */
  subAgentInvocations: number;
  /** 工具执行墙钟 (任意工具在飞的联合区间) — 推测/急切执行能重叠掉的天花板. */
  toolExecMs: number;
}

const SDK_PROVIDER_ID = 'neox-evals-inline';

function providerTypeToProtocol(type: HeadlessProviderType): ProviderProtocol {
  switch (type) {
    case 'anthropic': return 'anthropic';
    case 'openai': return 'openai';
    case 'openai-responses': return 'openai-responses';
    case 'gemini': return 'gemini';
    case 'kimi': return 'kimi';
    case 'glm': return 'glm';
    case 'doubao': return 'doubao';
  }
}

function buildResolveProvider(
  opts: { providerType: HeadlessProviderType; apiKey: string; baseURL?: string; model: string },
): (providerId?: string, modelName?: string) => ProviderResolution {
  const entry: ProviderConfigEntry = {
    id: SDK_PROVIDER_ID,
    name: opts.providerType,
    protocol: providerTypeToProtocol(opts.providerType),
    apiKey: opts.apiKey,
    baseUrl: opts.baseURL,
    models: [{ name: opts.model }],
    defaultModel: opts.model,
  };
  return (_pid?: string, mname?: string): ProviderResolution => ({
    provider: entry,
    llmConfig: {
      model: mname ?? opts.model,
      providerName: opts.providerType,
      maxInputTokens: 200_000,
    },
  });
}

export async function runHeadlessAgent(options: HeadlessAgentOptions): Promise<HeadlessAgentResult> {
  const { workspace, prompt, model, providerType, apiKey, baseURL, systemPrompt, timeoutMs, maxIterations, onEvent, signal, subAgent, hmacSigner } = options;

  if (!workspace || !workspace.trim()) {
    throw new Error('runHeadlessAgent: workspace 不能为空');
  }
  if (!apiKey || !apiKey.trim()) {
    throw new Error('runHeadlessAgent: apiKey 必填 (BYOK)');
  }

  /* timeout 跟外部 signal 合并 — 任一触发就 abort runner */
  const ctrl = new AbortController();
  if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  const timer = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;

  /* gateway HMAC — 注入纯 JS signer 给 OpenAIProvider, root secret 不进 native.
   *   没传 hmacSigner (BYOK 直连) 时不动, OpenAIProvider 自己决定要不要签.
   *   setExternalHmacSigner 是 neox-core 较新导出 — 用 runtime 取值兼容旧 dist
   *   (.d.ts 没声明时走 any 取属性, 真跑时 neox-core 已 rebuild 即生效). */
  if (hmacSigner) {
    const openaiMod = await import('@neoxlabs/kernel/models/openai.js');
    const setSigner = (openaiMod as Record<string, unknown>).setExternalHmacSigner;
    if (typeof setSigner === 'function') {
      (setSigner as (s: typeof hmacSigner) => void)(hmacSigner);
    }
  }

  const services = createNodeServices();
  setToolServices(services);
  /* eval 场景: 默认 dangerous mode — 工具调用一律放行, 不弹审批 (没 UI, 也没人接审批 callback).
   * SWE-bench / HumanEval 任务的合理预期就是允许 agent 改 repo / 跑测试 / 任意 shell.
   * 跟 UI 路径的 YOLO 模式同语义, 这里跟它 align.
   *
   * 实现: 通过 scopeModeResolver 永远返回 'dangerous' →
   * PermissionManager.resolveEffectivePermission 第一条命中 → ALLOW, 不进 ASK 分支,
   * 不会因为没有 approvalHandler 触发 fail-close 拒绝. */
  const permissionManager = new PermissionManager({
    scopeModeResolver: () => 'dangerous',
  });

  const memory = new ShortTermMemory();
  const resolveProvider = buildResolveProvider({ providerType, apiKey, baseURL, model });
  const hostService = new RuntimeHostService({ platformServices: services });

  /* 子 Agent 路由 — combo 测试在这里把任务 Agent 钉到 subModel.
   *   subAgent.model 不传 → 复用主 model (同模型自调度).
   *   provider 复用唯一的 inline provider (resolveProvider 忽略 providerId, 只认 model). */
  const subModel = subAgent?.enabled ? (subAgent.model || model) : null;
  const orchestrator = new RuntimeOrchestrator({
    hostService,
    resolveProvider,
    /* 任务 Agent (agent 工具内 orchestrator.runSession) 走这条 route → subModel. */
    getTaskAgentRoute: subModel
      ? () => ({ providerId: SDK_PROVIDER_ID, modelName: subModel })
      : undefined,
  });

  const sessionId = 'evals-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const baseTools = await getTools(workspace, services);

  /* 主 agent 工具集 — 注入 explore / agent / send_message 子 Agent 工具 (subAgent 开时).
   *   explore 用 exploreModelName=subModel 跑只读探索; agent 用 modelName=subModel
   *   跑可写任务 Agent. 主 agent 仍跑 options.model. */
  let tools: Tool[] = baseTools;
  let subAgentInvocations = 0;
  const backgroundManager = new BackgroundAgentManager();
  if (subModel) {
    const subAgentTools = createAgenticModeTools({
      orchestrator,
      providerId: SDK_PROVIDER_ID,
      modelName: subModel,
      exploreProviderId: SDK_PROVIDER_ID,
      exploreModelName: subModel,
      permissionManager: new PermissionManager({ scopeModeResolver: () => 'dangerous' }),
      allTools: baseTools,
      workDir: workspace,
      getParentMemory: () => memory,
      abortSignal: ctrl.signal,
      backgroundManager,
      sessionId,
    });
    tools = [...baseTools, ...subAgentTools];
  }

  let stopReason = 'end_turn';
  const errors: string[] = [];
  let turns = 0;
  const startedAt = Date.now();
  // per-phase 计时: 用 inflight 计数算"任意工具在执行"的墙钟联合区间 (= 当前串行死等的部分,
  // 也是推测/急切执行能重叠掉的天花板). 不需要 id 配对.
  let toolExecMs = 0;
  let toolInflight = 0;
  let toolWindowStart = 0;
  let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: undefined as number | undefined, cacheWriteTokens: undefined as number | undefined };

  /* 注入子 Agent 工具说明 — 不告诉模型 explore / agent 工具存在, 它不会主动调.
   * 接到 systemPrompt 末尾 (subModel 开时), 没接默认 layered prompt 的 fallback. */
  const baseInstructions = systemPrompt
    || 'You are a senior software engineer solving a GitHub issue. Read the repo, understand the bug, write a patch, run the failing test to verify it now passes.';
  const effectiveInstructions = subModel
    ? `${baseInstructions}\n${AGENTIC_MODE_SUBAGENT_INSTRUCTIONS}`
    : baseInstructions;

  try {
    /* 工具内部 (executeShell / editFile / ...) 通过 ALS 读 workspaceRoot;
     * runWithWorkspaceRoot 包一层把 SWE-bench 任务的 workspace 注入 ALS, 所有 tool spawn 都走那个目录 */
    await runWithWorkspaceRoot(workspace, async () => {
      await orchestrator.runSession({
        sessionId,
        prompt,
        abortSignal: ctrl.signal,
        buildHostConfig: (providerEntry, llmConfig) => ({
          sessionId,
          configKey: `evals:${sessionId}`,
          provider: providerEntry,
          llmConfig,
          workDir: workspace,
          instructions: effectiveInstructions,
          systemPrompt: effectiveInstructions,
          agentName: 'NeoxEvalsAgent',
          agentDescription: 'Agent invocation from @neoxlabs/evals harness',
          permissionManager,
          tools,
          memory,
          disableSystemPrompt: false,
          /* turn cap (可选) — 传了就钉 maxIterations, runner 跑满 N 迭代优雅停 (iteration_limit).
           * 不传 → 不带 agentConfig, host 走默认无限 (跟历史行为一致). temperature 跟 host 默认 0.7 对齐. */
          ...(typeof maxIterations === 'number' && maxIterations > 0
            ? { agentConfig: { maxIterations, temperature: 0.7 } }
            : {}),
        }),
        onRuntimeEvent: (event, _tracker) => {
          onEvent?.(event);
          /* 抓 usage / turns / stop reason / 错误事件. 用真实事件名:
           *   tool_call_start = 一次工具调用; token_usage = 累计 token; run_result = 终态. */
          if (event.type === 'tool_call_start') {
            turns += 1;
            /* 子 Agent 调用计数 — 主 agent 调起 explore / agent 工具各算一次. */
            if (event.name === 'explore' || event.name === 'agent') subAgentInvocations += 1;
            /* 工具执行窗口开始 (有工具在飞时计墙钟) */
            if (toolInflight === 0) toolWindowStart = Date.now();
            toolInflight += 1;
          }
          if (event.type === 'tool_output') {
            toolInflight = Math.max(0, toolInflight - 1);
            if (toolInflight === 0 && toolWindowStart > 0) {
              toolExecMs += Date.now() - toolWindowStart;
              toolWindowStart = 0;
            }
          }
          if (event.type === 'token_usage') {
            usage.inputTokens += event.promptTokens ?? 0;
            usage.outputTokens += event.completionTokens ?? 0;
            const cr = event.cacheReadTokens ?? event.anthropicCacheReadTokens;
            const cw = event.cacheWriteTokens ?? event.anthropicCacheCreationTokens;
            if (cr) usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + cr;
            if (cw) usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + cw;
          }
          if (event.type === 'run_result') {
            /* run_result 不带 stopReason 字段 — 用 failed/interrupted 倒推一个 label */
            if (event.failed) stopReason = 'failed';
            else if (event.interrupted) stopReason = 'interrupted';
            else stopReason = 'end_turn';
          }
          if (event.type === 'error') {
            errors.push(event.message ?? 'unknown error');
          }
        },
      });
    });
  } catch (err) {
    /* abort by timeout / signal → 不是 hard failure, 算 max_iterations 等价 */
    if (ctrl.signal.aborted) {
      stopReason = signal?.aborted ? 'abort' : 'timeout';
    } else {
      throw err;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  /* finalText: 取 messages 里最后一条 assistant 的 text 内容 (兜底空串) */
  const messages = memory.getAll() as Message[];
  let finalText = '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as any;
    if (m?.role === 'assistant') {
      if (typeof m.content === 'string') { finalText = m.content; break; }
      if (Array.isArray(m.content)) {
        const text = m.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('');
        if (text) { finalText = text; break; }
      }
    }
  }

  return {
    finalText,
    messages,
    usage,
    turns,
    stopReason,
    durationMs: Date.now() - startedAt,
    errors,
    subAgentInvocations,
    toolExecMs,
  };
}
