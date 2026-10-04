/**
 * Neox Agent SDK · provider() helper
 *
 * 简化 LLM provider 配置. 首版:几乎是类型 + 默认值,真正的 LLM 调用由 core
 * 的 ModelRouter / RuntimeOrchestrator 负责.
 */

export type ProviderType =
  | 'anthropic'
  | 'openai'
  | 'openai-responses'
  | 'openai-compatible'
  | 'deepseek'
  | 'gemini'
  | 'kimi'
  | 'glm'
  | 'doubao';

export interface ProviderConfig {
  type: ProviderType;
  apiKey: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
  proxy?: string;
  timeout?: number;
}

/** 构造一个 provider 配置对象. */
export function provider(config: ProviderConfig): ProviderConfig {
  return { ...config };
}

/**
 * 从环境变量自动推断 provider(fallback 路径).
 * 查找顺序: ANTHROPIC_API_KEY → OPENAI_API_KEY → DEEPSEEK_API_KEY → KIMI_API_KEY
 */
export function providerFromEnv(): ProviderConfig | null {
  const env = process.env;
  if (env.ANTHROPIC_API_KEY) {
    return { type: 'anthropic', apiKey: env.ANTHROPIC_API_KEY };
  }
  if (env.OPENAI_API_KEY) {
    return { type: 'openai', apiKey: env.OPENAI_API_KEY };
  }
  if (env.DEEPSEEK_API_KEY) {
    return {
      type: 'openai-compatible',
      apiKey: env.DEEPSEEK_API_KEY,
      baseURL: 'https://api.deepseek.com/v1',
    };
  }
  if (env.KIMI_API_KEY || env.MOONSHOT_API_KEY) {
    return {
      type: 'kimi',
      apiKey: env.KIMI_API_KEY || env.MOONSHOT_API_KEY!,
      baseURL: 'https://api.moonshot.cn/v1',
    };
  }
  return null;
}
