/**
 * Provider Factory
 *
 * 根据 protocol 创建对应的 Provider Adapter
 */

import type { ProviderProtocol, ProviderConfigEntry } from '@neoxlabs/platform/utils/config.js';
import type { ProviderAdapter } from './adapters/base.js';
import { OpenAIAdapter, type OpenAIAdapterConfig } from './adapters/openai.js';
import { AnthropicAdapter, type AnthropicAdapterConfig } from './adapters/anthropic.js';
import { KimiAdapter, type KimiAdapterConfig } from './adapters/kimi.js';
import { GeminiAdapter, type GeminiAdapterConfig } from './adapters/gemini.js';
import { GLMAdapter, type GLMAdapterConfig } from './adapters/glm.js';

// Re-export ProviderAdapter for convenience
export type { ProviderAdapter } from './adapters/base.js';

/**
 * Provider Factory
 *
 * 统一创建各种 provider 的入口
 */
export class ProviderFactory {
  /**
   * 根据 protocol 创建对应的 Adapter
   *
   * @param protocol Provider 协议类型
   * @param config Provider 配置
   * @returns Provider Adapter 实例
   */
  static createAdapter(
    protocol: ProviderProtocol,
    config: ProviderConfigEntry
  ): ProviderAdapter {
    switch (protocol) {
      case 'openai':
        return ProviderFactory.createOpenAIAdapter(config, false);

      case 'openai-responses':
        return ProviderFactory.createOpenAIAdapter(config, true);

      case 'kimi':
        return ProviderFactory.createKimiAdapter(config);

      case 'glm':
        return ProviderFactory.createGLMAdapter(config);

      case 'deepseek':
        return ProviderFactory.createOpenAIAdapter({
          ...config,
          baseUrl: config.baseUrl || 'https://api.deepseek.com',
          defaultModel: config.defaultModel || config.lastSelectedModel || 'deepseek-v4-flash',
        }, false);

      case 'qwen':
        return ProviderFactory.createOpenAIAdapter({
          ...config,
          baseUrl: config.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          defaultModel: config.defaultModel || config.lastSelectedModel || 'qwen3.7-max',
        }, false);

      case 'minimax':
        return ProviderFactory.createOpenAIAdapter({
          ...config,
          baseUrl: config.baseUrl || 'https://api.minimax.chat/v1',
          defaultModel: config.defaultModel || config.lastSelectedModel || 'MiniMax-M3',
        }, false);

      case 'anthropic':
      case 'anthropic-openai':
        return ProviderFactory.createAnthropicAdapter(config);

      case 'glm-claude':
        // GLM models via Anthropic protocol
        return ProviderFactory.createAnthropicAdapter({
          ...config,
          baseUrl: config.baseUrl || 'https://open.bigmodel.cn/api/paas/v4',
          defaultModel: config.defaultModel || config.lastSelectedModel || 'glm-5.2',
        });

      case 'kimi-claude':
        // Kimi models via Anthropic protocol
        return ProviderFactory.createAnthropicAdapter({
          ...config,
          baseUrl: config.baseUrl || 'https://api.moonshot.cn/anthropic',
          defaultModel: config.defaultModel || config.lastSelectedModel || 'kimi-k2.7-code',
        });

      case 'doubao':
        return ProviderFactory.createOpenAIAdapter({
          ...config,
          baseUrl: config.baseUrl || 'https://ark.cn-beijing.volces.com/api/v3',
          defaultModel: config.defaultModel || config.lastSelectedModel || 'doubao-seed-1-6-251015',
        }, false); // Chat Completions, not Responses API

      case 'grok':
        /* xAI Grok — 主对话走 OpenAI Chat Completions; web_search 另走 /v1/responses 原生工具 */
        return ProviderFactory.createOpenAIAdapter({
          ...config,
          baseUrl: config.baseUrl || 'https://api.x.ai/v1',
          defaultModel: config.defaultModel || config.lastSelectedModel || 'grok-4.5',
        }, false);

      case 'gemini':
        return ProviderFactory.createGeminiAdapter(config);

      default:
        throw new Error(`Unsupported provider protocol: ${protocol}`);
    }
  }

  /**
   * 创建 OpenAI Adapter
   */
  private static createOpenAIAdapter(
    config: ProviderConfigEntry,
    useResponsesAPI: boolean
  ): OpenAIAdapter {
    const extended = config as ProviderConfigEntry & Record<string, any>;

    const adapterConfig: OpenAIAdapterConfig = {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      defaultModel: config.defaultModel || config.lastSelectedModel,
      useResponsesAPI,
      maxTokens: config.maxTokens,
      maxInputTokens: config.maxInputTokens,
      apiEndpoint: extended.apiEndpoint,
      streamFormat: extended.streamFormat,
      retry: extended.retry,
      sessionId: extended.sessionId,
      runtimeMode: extended.runtimeMode,
      modelConfig: extended.modelConfig,
      doubaoThinking: extended.doubaoThinking,
      modelProfile: extended.modelProfile,
    };

    return new OpenAIAdapter(adapterConfig);
  }

  /**
   * 创建 Anthropic Adapter
   */
  private static createAnthropicAdapter(
    config: ProviderConfigEntry
  ): AnthropicAdapter {
    const adapterConfig: AnthropicAdapterConfig = {
      authToken: config.apiKey,
      baseUrl: config.baseUrl,
      defaultModel: config.defaultModel || config.lastSelectedModel,
      maxTokens: config.maxTokens && config.maxTokens <= 8192 ? config.maxTokens : undefined,
      disableCaching: config.disableCaching ?? false,
      /* claudeCodeMode 显式透传 (不能靠 ...rest, factory 只挑字段).
       *   undefined = 让 provider 走 'auto' 默认. */
      claudeCodeMode: config.claudeCodeMode,
    };

    return new AnthropicAdapter(adapterConfig);
  }

  /**
   * 创建 Kimi Adapter
   */
  private static createKimiAdapter(config: ProviderConfigEntry): KimiAdapter {
    const adapterConfig: KimiAdapterConfig = {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      defaultModel: config.defaultModel || config.lastSelectedModel,
      maxTokens: config.maxTokens,
      maxInputTokens: config.maxInputTokens,
    };

    return new KimiAdapter(adapterConfig);
  }

  /**
   * 创建 Gemini Adapter
   */
  private static createGeminiAdapter(config: ProviderConfigEntry): GeminiAdapter {
    const adapterConfig: GeminiAdapterConfig = {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      urlSuffix: config.urlSuffix,
      defaultModel: config.defaultModel || config.lastSelectedModel,
      retry: config.retry,
    };

    return new GeminiAdapter(adapterConfig);
  }

  /**
   * 创建 GLM Adapter (智谱 AI)
   */
  private static createGLMAdapter(config: ProviderConfigEntry): GLMAdapter {
    const adapterConfig: GLMAdapterConfig = {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      defaultModel: config.defaultModel || config.lastSelectedModel,
      maxTokens: config.maxTokens,
      maxInputTokens: config.maxInputTokens,
    };

    return new GLMAdapter(adapterConfig);
  }

  /**
   * 检查 protocol 是否被支持
   */
  static isProtocolSupported(protocol: ProviderProtocol): boolean {
    return ['openai', 'openai-responses', 'anthropic', 'anthropic-openai', 'doubao', 'kimi', 'gemini', 'deepseek', 'minimax', 'qwen', 'glm', 'glm-claude', 'kimi-claude'].includes(protocol);
  }

  /**
   * 获取 protocol 的显示名称
   */
  static getProtocolDisplayName(protocol: ProviderProtocol): string {
    const names: Record<ProviderProtocol, string> = {
      'openai': 'OpenAI (Chat Completions)',
      'openai-responses': 'OpenAI (Responses API)',
      'openai-images': 'OpenAI Images (Generations/Edits)',
      'openai-tts': 'OpenAI TTS (Speech)',
      'openai-stt': 'OpenAI STT (Whisper)',
      'openai-embedding': 'OpenAI Embeddings',
      'anthropic': 'Anthropic (Claude)',
      'anthropic-openai': 'Anthropic (OpenAI Format)',
      'doubao': '豆包 (Doubao)',
      'doubao-images': '豆包 Seedream (图像)',
      'doubao-tts': '豆包 CosyVoice (TTS)',
      'gemini': 'Google Gemini',
      'gemini-images': 'Gemini Image (Nano Banana)',
      'grok': 'xAI Grok',
      'grok-images': 'Grok Image',
      'kimi': 'Kimi (Moonshot)',
      'deepseek': 'DeepSeek',
      'minimax': 'MiniMax',
      'minimax-tts': 'MiniMax TTS',
      'minimax-video': 'MiniMax 视频生成',
      'qwen': 'Qwen (阿里云百炼)',
      'qwen-images': '通义万相 (图像)',
      'dashscope-tts': 'Dashscope CosyVoice v2',
      'glm': 'GLM (智谱 AI)',
      'glm-claude': 'GLM (Claude 协议)',
      'glm-images': '智谱 CogView (图像)',
      'kimi-claude': 'Kimi (Claude 协议)',
      'openrouter': 'OpenRouter',
      'openrouter-images': 'OpenRouter (图像)',
      'mistral': 'Mistral',
      'groq': 'Groq',
      'together': 'Together AI',
    };

    return names[protocol] || protocol;
  }
}

/**
 * 便捷函数：创建 provider adapter
 */
export function createProviderAdapter(
  protocol: ProviderProtocol,
  config: ProviderConfigEntry
): ProviderAdapter {
  return ProviderFactory.createAdapter(protocol, config);
}
