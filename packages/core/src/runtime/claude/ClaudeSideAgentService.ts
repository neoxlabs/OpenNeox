import { createProviderAdapter } from '../../models/factory.js';
import { AnthropicAdapter } from '../../models/adapters/anthropic.js';
import type { Message } from '@neoxlabs/kernel/types/index.js';
import type { ProviderResolution } from '../runtimeOrchestrator.js';
import { resolveSubAgentModelSelection } from '../agent/exploreModelPolicy.js';
import { withTimeout, isStallTimeoutError, envTimeoutMs } from '@neoxlabs/kernel/utils/stallGuard.js';

/** side-agent(标题/总结/ack 等轻活)硬超时, 防止底层 fetch 挂起泄漏句柄。0 = 关闭。 */
const SIDE_AGENT_TIMEOUT_MS = envTimeoutMs('NEOX_SIDE_AGENT_TIMEOUT_MS', 60_000);

export interface ClaudeSideAgentRequest {
  providerId: string;
  modelName: string;
  messages: Message[];
  maxTokens: number;
  temperature?: number;
  signal?: AbortSignal;
  allowOpusFallback?: boolean;
  /** 关 side-agent thinking — 跨 family 统一开关. default true (caller 不传时).
   *  user 可在 Settings → 侧路 Agent 调整, 持久化进 SideAgentConfig.disableThinking. */
  disableThinking?: boolean;
}

export interface ClaudeSideAgentResult {
  providerId: string;
  modelName: string;
  text: string | null;
  reason: string;
}

export class ClaudeSideAgentService {
  constructor(private readonly resolveProvider: (providerId?: string, modelName?: string) => ProviderResolution) {}

  async query(input: ClaudeSideAgentRequest): Promise<ClaudeSideAgentResult> {
    const initialResolved = this.resolveProvider(input.providerId, input.modelName);
    // 通用版降级: Claude→Haiku, deepseek→flash, glm→flash 等 (非流 side-agent: 标题/总结/ack
    // 都是轻活, 同族 flash 够用且省; 原 resolveClaudeSmallFast 只降 Claude, 非 Claude 一直用主模型)。
    const selected = resolveSubAgentModelSelection({
      providerId: input.providerId,
      modelName: input.modelName,
      provider: initialResolved.provider ?? undefined,
      allowOpusFallback: input.allowOpusFallback,
    });

    const finalResolved = this.resolveProvider(selected.providerId, selected.modelName);
    const provider = finalResolved.provider;
    if (!provider) {
      throw new Error(`Provider not found for Claude side-agent: ${selected.providerId}`);
    }

    const adapterConfig = provider.defaultModel?.trim()
      ? provider
      : { ...provider, defaultModel: finalResolved.llmConfig?.model || selected.modelName };
    const adapter = createProviderAdapter(provider.protocol, adapterConfig);
    const canUseAnthropicFastPath = adapter instanceof AnthropicAdapter;
    const disableThinking = input.disableThinking ?? true;

    /* 卡死防御:side-agent 是 fire-and-forget(caller `void service.query(...)`)。
     * 若底层 fetch 因网络抖动永不返回, 这条 Promise 永不 settle → 句柄泄漏。
     * 接入 stallGuard 硬超时:超时 → abort 请求 signal + 抛 StallTimeoutError, 由本方法
     * 转成"text:null"优雅降级(标题/总结缺失不影响主链)。combine 用户 signal + 超时 signal。 */
    const timeoutController = new AbortController();
    const userSignal = input.signal;
    let offUserAbort: (() => void) | undefined;
    if (userSignal) {
      if (userSignal.aborted) timeoutController.abort();
      else {
        const onAbort = () => timeoutController.abort();
        userSignal.addEventListener('abort', onAbort, { once: true });
        offUserAbort = () => userSignal.removeEventListener('abort', onAbort);
      }
    }
    const effectiveSignal = timeoutController.signal;

    const doChat = () => canUseAnthropicFastPath
      ? adapter.getProvider().chat(input.messages, {
          model: selected.modelName,
          temperature: input.temperature,
          maxTokens: input.maxTokens,
          stream: false,
          thinking: disableThinking ? { type: 'disabled' } : undefined,
          disableCaching: true,
          signal: effectiveSignal,
        })
      : adapter.chat(input.messages, {
          model: selected.modelName,
          temperature: input.temperature,
          maxTokens: input.maxTokens,
          signal: effectiveSignal,
          /* 跨 family 统一开关, 每家 adapter 自己映射:
           *   GLM/Kimi/DeepSeek → thinking:{type:'disabled'}
           *   OpenAI (Responses) → reasoning_effort:'minimal'
           *   Anthropic → thinking:{type:'disabled'} (上面 fast-path 已处理) */
          disableThinking,
        });

    let response;
    try {
      response = await withTimeout(doChat, {
        label: `sideAgent:${selected.providerId}/${selected.modelName}`,
        timeoutMs: SIDE_AGENT_TIMEOUT_MS,
        tag: 'SIDE_AGENT',
        context: { providerId: selected.providerId, modelName: selected.modelName },
        onTimeout: () => timeoutController.abort(),
      });
    } catch (err) {
      if (isStallTimeoutError(err)) {
        // 超时降级:返回空文本, 不抛 — side-agent 失败绝不能影响主 agent 链。
        return {
          providerId: selected.providerId,
          modelName: selected.modelName,
          text: null,
          reason: `${selected.reason} (timed out after ${SIDE_AGENT_TIMEOUT_MS}ms)`,
        };
      }
      throw err;
    } finally {
      offUserAbort?.();
    }

    return {
      providerId: selected.providerId,
      modelName: selected.modelName,
      text: response.choices[0]?.message.content?.trim() || null,
      reason: selected.reason,
    };
  }
}
