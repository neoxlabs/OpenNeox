/**
 * SDK ProviderConfig → kernel LLMProvider 实例.
 *
 * 用户在 SDK 里写 `provider({ type: 'anthropic', apiKey: 'sk-ant-...' })`,
 * 这里把它折成 kernel 能直接跑的 LLMProvider (OpenAIProvider /
 * AnthropicProvider / OpenAICompatibleClient 适配).
 *
 * 不再依赖 core 的 RuntimeOrchestrator / ProviderResolution — 直接拿 kernel
 * provider class 实例化, 当场 ready 给 StreamedRunner 用.
 */

import { OpenAIProvider, AnthropicProvider } from '@neoxlabs/kernel';

/* 同 eventAdapter: kernel 类型不进公开 .d.ts */
type LLMProvider = unknown;
import type { ProviderConfig } from '../provider.js';

const DEFAULT_OPENAI_BASE = 'https://api.openai.com/v1';
const DEFAULT_ANTHROPIC_BASE = 'https://api.anthropic.com';
const DEFAULT_DEEPSEEK_BASE = 'https://api.deepseek.com/v1';
const DEFAULT_KIMI_BASE = 'https://api.moonshot.cn/v1';
const DEFAULT_GLM_BASE = 'https://open.bigmodel.cn/api/paas/v4';
const DEFAULT_GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';
const DEFAULT_DOUBAO_BASE = 'https://ark.cn-beijing.volces.com/api/v3';

/**
 * 根据 SDK ProviderConfig 构造一个 LLMProvider 实例.
 *
 *   - anthropic → AnthropicProvider (Messages API)
 *   - openai / openai-responses / openai-compatible / deepseek / kimi / glm / gemini / doubao
 *       → OpenAIProvider (兼容 OpenAI Chat Completions / Responses API)
 *
 * baseURL 缺省自动按 provider type 填.
 */
export function buildLLMProvider(input: {
  provider: ProviderConfig;
  model: string;
}): LLMProvider {
  const { provider, model } = input;
  const baseUrl = (provider.baseURL ?? defaultBaseUrl(provider.type)).replace(/\/+$/, '');

  if (provider.type === 'anthropic') {
    return new AnthropicProvider({
      authToken: provider.apiKey,
      baseUrl,
      defaultModel: model,
      /* SDK 接公开 Anthropic API, 跳 Neox HMAC. AnthropicProvider 没 disableSigning 选项
       * (HMAC 路径走的不同分支), 但 baseUrl 默认是 anthropic.com → 不走 Neox gateway 路径. */
    } as any);
  }

  /* 其它全走 OpenAI 兼容路径 — 不同 provider 只是 baseUrl 不同, request shape 相同 */
  const useResponsesAPI = provider.type === 'openai-responses';
  return new OpenAIProvider({
    apiKey: provider.apiKey,
    baseUrl,
    defaultModel: model,
    useResponsesAPI,
    /* BYOK SDK 永远直连公开 endpoint, 跳 Neox HMAC fail-close. */
    disableSigning: true,
  } as any);
}

function defaultBaseUrl(type: ProviderConfig['type']): string {
  switch (type) {
    case 'anthropic':       return DEFAULT_ANTHROPIC_BASE;
    case 'openai':
    case 'openai-responses': return DEFAULT_OPENAI_BASE;
    case 'deepseek':         return DEFAULT_DEEPSEEK_BASE;
    case 'kimi':             return DEFAULT_KIMI_BASE;
    case 'glm':              return DEFAULT_GLM_BASE;
    case 'gemini':           return DEFAULT_GEMINI_BASE;
    case 'doubao':           return DEFAULT_DOUBAO_BASE;
    case 'openai-compatible': return DEFAULT_OPENAI_BASE;
    default: {
      const _exhaustive: never = type;
      throw new Error(`Unknown SDK provider type: ${String(_exhaustive)}`);
    }
  }
}
