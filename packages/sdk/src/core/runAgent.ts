/**
 * Agent.run / Agent.stream 的真实现.
 *
 *   这一层用 kernel StreamedRunner 直接跑 — 不依赖 core 的 RuntimeOrchestrator /
 *   RuntimeHostService / createNodeServices (那批是 Neox 自家产品才有的高级编排,
 *   含 BYOK 路由 / Neox cloud fallback / 多 provider 智能选择, SDK 用户不需要).
 *
 *   流程:
 *     SDK ProviderConfig --buildLLMProvider--> kernel LLMProvider 实例
 *     SDK NeoxSdkTool[]  --sdkToolToKernelTool--> kernel Tool[]
 *     PermissionManager (kernel) + ShortTermMemory (kernel) 组装
 *     new StreamedRunner({...}).run(prompt)  → AsyncGenerator<StreamEvent>
 *     translateEvent(StreamEvent) → SDK AgentEvent → 回调 config.onEvent
 */

import {
  PermissionManager,
  applyDefaultToolPermissions,
  ShortTermMemory,
  StreamedRunner,
} from '@neoxlabs/kernel';
import type { AgentConfig, AgentResult } from '../agent.js';
import type { AgentEvent, PermissionDecision, StopReason } from '../types.js';
import { providerFromEnv } from '../provider.js';
import {
  isMockProvider,
  generateMockEvents,
  type MockProvider,
} from '../testing/index.js';
import { buildLLMProvider } from './providerAdapter.js';
import { sdkToolToKernelTool } from './toolAdapter.js';
import { createTranslatorState, translateEvent } from './eventAdapter.js';

type PermissionRisk = 'low' | 'medium' | 'high' | 'critical';

export interface RunAgentHandlers {
  /** 每个翻译好的 SDK 事件都会回调一次. stream 模式下用来喂 async iterator. */
  onEvent?: (event: AgentEvent) => void;
  /** 拿到原始 kernel 事件 (高级用法, debug 或自定义适配). */
  onRawEvent?: (event: any) => void;
}

/**
 * 一次 agent 跑: 从 config + prompt → AgentResult.
 * 事件通过 handlers.onEvent 实时派发, 返回值包含最终文本 + usage.
 */
export async function runAgent(
  config: AgentConfig,
  prompt: string,
  handlers: RunAgentHandlers = {},
): Promise<AgentResult> {
  const provider = config.provider ?? providerFromEnv();
  if (!provider) {
    throw new Error(
      'Neox SDK: no provider configured. ' +
        'Pass { provider: {...} } or set ANTHROPIC_API_KEY / OPENAI_API_KEY in env.',
    );
  }

  /* 测试旁路: mockLlm() 走脚本回放, 不接 kernel, 不发网络. */
  if (isMockProvider(provider)) {
    return runWithMockProvider(config, provider, handlers);
  }

  const permMode = config.permission ?? 'auto';
  if (permMode === 'ask') {
    throw new Error(
      "[neox-sdk] permission:'ask' requires a PermissionHandler.\n" +
        '  · Human in the loop: permission: async (req) => ({ approved: await ask(req) })\n' +
        "  · Run tools directly: permission: 'auto' (dangerous tools are still denied)",
    );
  }

  const toolByName = new Map((config.tools ?? []).map((t) => [t.name, t]));
  const decide = async (req: any): Promise<PermissionDecision> => {
    const sdkTool = toolByName.get(req?.toolName);
    const dangerous = sdkTool?.dangerous ?? false;
    const level = req?.risk?.level as PermissionRisk | undefined;
    const risky = dangerous || level === 'high' || level === 'critical';

    if (typeof permMode === 'function') {
      return permMode({
        tool: req?.toolName ?? 'unknown',
        input: req?.args,
        dangerous,
        risk: level,
      });
    }
    if (permMode === 'readonly') {
      /* 未登记的工具 (kernel 内置) 一律按非只读处理 —— readonly 模式宁可拒错不放错 */
      const readOnly = sdkTool?.readOnly ?? false;
      return {
        approved: readOnly && !risky,
        remember: false,
        reason: readOnly ? undefined : 'permission mode is readonly',
      };
    }
    /* 'auto' */
    return { approved: !risky, remember: false, reason: risky ? 'tool is marked dangerous' : undefined };
  };

  const permissionManager = new PermissionManager({
    approvalHandler: async (req: any) => {
      const d = await decide(req);
      return { approved: d.approved, remember: d.remember ?? false };
    },
    scopeModeResolver: () => 'manual',
  });
  applyDefaultToolPermissions(permissionManager);

  /* 2) Memory + tools + LLM provider */
  const memory = new ShortTermMemory();
  const kernelTools = (config.tools ?? []).map((t) => sdkToolToKernelTool(t));
  const llmProvider = buildLLMProvider({ provider, model: config.model });

  /* 3) StreamedRunner — kernel 真引擎 */
  const systemPrompt = await resolveSystemPrompt(config.systemPrompt);
  const sessionId = 'sdk-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const runner = new StreamedRunner({
    /* SDK 侧不把 kernel 类型写进公开 .d.ts (kernel 未发 npm), 交接处显式 cast */
    llmProvider: llmProvider as any,
    model: config.model,
    tools: kernelTools as any,
    memory,
    config: {
      model: config.model,
      maxIterations: config.maxSteps ?? 50,
    } as any,
    instructions: systemPrompt || 'You are a helpful assistant.',
    agentName: 'NeoxSdkAgent',
    agentDescription: 'Agent created via @neoxlabs/sdk',
    sessionId,
    providerName: provider.type,
    permissionManager,
  });

  /* 4) 跑 generator + 翻译事件 */
  const state = createTranslatorState();
  try {
    for await (const evt of runner.run(prompt, undefined, config.signal)) {
      handlers.onRawEvent?.(evt);
      const translated = translateEvent(evt, state);
      for (const ev of translated) {
        config.onEvent?.(ev);
        handlers.onEvent?.(ev);
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const errEvent: AgentEvent = { type: 'error', error };
    config.onEvent?.(errEvent);
    handlers.onEvent?.(errEvent);
    throw error;
  }

  return {
    text: state.textBuffer,
    usage: { ...state.usage },
    steps: [],
    messages: memory.getAll() as AgentResult['messages'],
    stopReason: state.errorFromStream && state.stopReason === 'end_turn'
      ? 'tool_error'
      : state.stopReason,
  };
}

async function resolveSystemPrompt(
  sp: AgentConfig['systemPrompt'],
): Promise<string> {
  if (!sp) return '';
  if (typeof sp === 'string') return sp;
  return await sp();
}

/**
 * Mock-provider 执行路径.
 * 脚本回放 generateMockEvents, 不触发 kernel, 不动网络.
 */
async function runWithMockProvider(
  config: AgentConfig,
  mockProvider: MockProvider,
  handlers: RunAgentHandlers,
): Promise<AgentResult> {
  let text = '';
  let stopReason: StopReason = 'end_turn';
  let usage = { inputTokens: 0, outputTokens: 0 };
  let errorFromStream: Error | null = null;

  for await (const ev of generateMockEvents(mockProvider)) {
    if (ev.type === 'text_delta') text += ev.delta;
    if (ev.type === 'done') {
      stopReason = ev.stopReason;
      usage = ev.usage;
    }
    if (ev.type === 'error') errorFromStream = ev.error;
    config.onEvent?.(ev);
    handlers.onEvent?.(ev);
  }

  if (errorFromStream) {
    stopReason = 'tool_error';
  }

  return {
    text,
    usage,
    steps: [],
    messages: [],
    stopReason,
  };
}
