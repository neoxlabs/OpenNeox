/**
 * OpenAI Provider Constraints
 *
 * 定义 OpenAI/GPT 模型的参数约束、token 限制和验证规则
 */

import {
  BaseConstraints,
  type ProviderConstraints,
  rangeValidator,
  enumValidator,
  combineValidators,
} from './base.js';
import { lookupRegistryModel } from '@neoxlabs/platform/platform/modelCapabilities.js';

/**
 * OpenAI 约束配置
 *
 * 参考:
 * - https://platform.openai.com/docs/models
 * - https://platform.openai.com/docs/api-reference/chat/create
 */
export class OpenAIConstraints extends BaseConstraints {
  getConstraints(): ProviderConstraints {
    return {
      // ========================================================================
      // Token 限制
      // ========================================================================
      maxOutputTokens: {
        // GPT-4o 系列
        'gpt-4o': 16384,
        'gpt-4o-2024-11-20': 16384,
        'gpt-4o-2024-08-06': 16384,
        'gpt-4o-2024-05-13': 4096,
        'gpt-4o-mini': 16384,
        'gpt-4o-mini-2024-07-18': 16384,

        // GPT-4 Turbo 系列
        'gpt-4-turbo': 4096,
        'gpt-4-turbo-2024-04-09': 4096,
        'gpt-4-turbo-preview': 4096,
        'gpt-4-0125-preview': 4096,
        'gpt-4-1106-preview': 4096,

        // GPT-4 标准
        'gpt-4': 8192,
        'gpt-4-0613': 8192,
        'gpt-4-0314': 8192,

        // GPT-3.5 Turbo
        'gpt-3.5-turbo': 4096,
        'gpt-3.5-turbo-0125': 4096,
        'gpt-3.5-turbo-1106': 4096,

        // o1 系列（推理模型）
        'o1': 100000,
        'o1-2024-12-17': 100000,
        'o1-preview': 32768,
        'o1-preview-2024-09-12': 32768,
        'o1-mini': 65536,
        'o1-mini-2024-09-12': 65536,

        // o3 系列（新一代推理模型）
        'o3': 100000,
        'o3-mini': 100000,
        'o3-mini-2025-01-31': 100000,

        // o4 系列
        'o4-mini': 100000,

        // GPT-5 系列
        'gpt-5.6-sol': 128000,
        'gpt-5.6-terra': 128000,
        'gpt-5.6-luna': 128000,
        'gpt-5.5': 128000,
        'gpt-5.5-pro': 128000,
        'gpt-5.4': 128000,
        'gpt-5.4-pro': 128000,
        'gpt-5.4-mini': 128000,
        'gpt-5.4-nano': 128000,

        // 历史兼容 Codex ID
        'gpt-5': 100000,
        'gpt-5.1': 100000,
        'gpt-5.1-codex': 100000,
        'gpt-5.1-codex-max': 100000,
        'gpt-5.1-codex-mini': 100000,
        'gpt-5.2': 100000,
        'gpt-5.3': 100000,
        'gpt-5.2-codex': 100000,
        'gpt-5.3-codex': 100000,
        'gpt-5-codex': 100000,
        'gpt-5-codex-mini': 100000,
        'codex-mini-latest': 100000,

        // GPT-4.1 系列
        'gpt-4.1': 100000,
        'gpt-4.1-2025-04-14': 100000,

        // 通配符匹配
        'gpt-4o*': 16384,
        'gpt-4-turbo*': 4096,
        'gpt-4.1*': 100000,
        'gpt-4*': 8192,
        'gpt-3.5*': 4096,
        'gpt-5.6*': 128000,
        'gpt-5.5*': 128000,
        'gpt-5.4*': 128000,
        'gpt-5*': 100000,
        'codex*': 100000,
        'o1*': 100000,
        'o3*': 100000,
        'o4*': 100000,
      },

      maxInputTokens: {
        // GPT-4o 系列
        'gpt-4o': 128000,
        'gpt-4o-mini': 128000,

        // GPT-4 Turbo
        'gpt-4-turbo': 128000,
        'gpt-4-turbo-2024-04-09': 128000,

        // GPT-4.1 系列（超大上下文）
        'gpt-4.1': 1047576,
        'gpt-4.1-2025-04-14': 1047576,

        // GPT-4 标准
        'gpt-4': 8192,
        'gpt-4-32k': 32768,

        // GPT-3.5 Turbo
        'gpt-3.5-turbo': 16385,
        'gpt-3.5-turbo-16k': 16385,

        // GPT-5 系列
        'gpt-5.6-sol': 372000,
        'gpt-5.6-terra': 372000,
        'gpt-5.6-luna': 372000,
        'gpt-5.5': 272000,
        'gpt-5.5-pro': 272000,
        'gpt-5.4': 1000000,
        'gpt-5.4-pro': 1000000,
        'gpt-5.4-mini': 400000,
        'gpt-5.4-nano': 400000,

        // 历史兼容 Codex ID
        'gpt-5': 272000,
        'gpt-5.1': 272000,
        'gpt-5.1-codex': 272000,
        'gpt-5.1-codex-max': 272000,
        'gpt-5.1-codex-mini': 272000,
        'gpt-5-codex': 272000,
        'gpt-5-codex-mini': 272000,

        // GPT-5.2 系列（400K 上下文）
        'gpt-5.2': 400000,
        'gpt-5.3': 400000,
        'gpt-5.2-codex': 400000,
        'gpt-5.3-codex': 400000,

        // Codex 其他模型
        'codex-mini-latest': 200000,

        // o1 系列
        'o1': 200000,
        'o1-preview': 128000,
        'o1-mini': 128000,

        // o3 系列
        'o3': 200000,
        'o3-mini': 200000,

        // o4 系列
        'o4-mini': 200000,

        // 通配符
        'gpt-4o*': 128000,
        'gpt-4-turbo*': 128000,
        'gpt-4.1*': 1047576,
        'gpt-5.6*': 372000,
        'gpt-5.5*': 272000,
        'gpt-5.4*': 1000000,
        'gpt-5.3*': 400000,
        'gpt-5.2*': 400000,
        'gpt-5*': 272000,
        'codex*': 272000,
        'o1*': 200000,
        'o3*': 200000,
        'o4*': 200000,
      },

      // ========================================================================
      // 支持的参数
      // ========================================================================
      supportedParams: new Set([
        // 基础参数
        'model',
        'messages',
        'stream',
        'stream_options',

        // Token 控制
        'max_tokens',
        'max_completion_tokens',

        // 采样参数
        'temperature',
        'top_p',
        'top_k',
        'frequency_penalty',
        'presence_penalty',
        'stop',
        'n',
        'seed',

        // 推理模型参数 (o1/o3)
        'reasoning_effort',
        'verbosity',

        // 工具调用
        'tools',
        'tool_choice',
        'parallel_tool_calls',

        // 响应格式
        'response_format',

        // 日志概率
        'logprobs',
        'top_logprobs',
        'logit_bias',

        // 多模态
        'modalities',
        'audio',

        // 隐私相关 (通常会被过滤)
        'user',
        'safety_identifier',
        'store',
        'service_tier',

        // 缓存
        'prompt_cache_key',
        'prompt_cache_retention',

        // 元数据
        'metadata',
        'prediction',

        // 厂商扩展
        'extra_body',
        'search_parameters',
        'web_search_options',
      ]),

      // ========================================================================
      // 参数验证规则
      // ========================================================================
      validators: {
        // Temperature: 0.0 - 2.0
        temperature: rangeValidator(0, 2),

        // Top P: 0.0 - 1.0
        top_p: rangeValidator(0, 1),

        // Frequency/Presence Penalty: -2.0 - 2.0
        frequency_penalty: rangeValidator(-2, 2),
        presence_penalty: rangeValidator(-2, 2),

        // Reasoning Effort (max/ultra = GPT-5.6 新档, ultra 仅 Sol/Terra)
        reasoning_effort: enumValidator(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']),

        // Verbosity (部分模型支持)
        verbosity: enumValidator(['low', 'medium', 'high']),

        // Tool Choice
        tool_choice: (value: any) => {
          if (typeof value === 'string') {
            return ['none', 'auto', 'required'].includes(value) || `Must be 'none', 'auto', or 'required'`;
          }
          if (typeof value === 'object' && value.type === 'function') {
            return true;
          }
          return 'Invalid tool_choice format';
        },

        // Response Format Type
        'response_format.type': enumValidator(['text', 'json_object', 'json_schema']),

        // Stream (boolean)
        stream: (value: any) => typeof value === 'boolean' || 'Must be a boolean',

        // N (number of completions)
        n: combineValidators(
          (v) => typeof v === 'number' || 'Must be a number',
          rangeValidator(1, 10)
        ),

        // Max tokens
        max_tokens: (value: any, params?: Record<string, any>) => {
          const num = Number(value);
          if (isNaN(num)) return 'Must be a number';
          if (num < 1) return 'Must be at least 1';

          // 对于 o1/o3 模型，max_tokens 可以很大
          const model = params?.model || '';
          // if (model.startsWith('o1') || model.startsWith('o3')) {
          //   if (num > 100000) return 'Max tokens cannot exceed 100000';
          // } else {
          //   if (num > 16384) return 'Max tokens cannot exceed 16384';
          // }

          return true;
        },
      },

      // ========================================================================
      // 默认值
      // ========================================================================
      defaults: {
        temperature: 1.0,
        top_p: 1.0,
        n: 1,
        stream: false,
        max_tokens: 4096,
      },
    };
  }

  /**
   * 检查模型是否是 reasoning-only 协议模型 (o 系列: 不吃 temperature, 走 Responses API 语义)。
   * 注意 gpt-5 系列虽然也能走 Responses API, 但接受 temperature 且 chat-completions 同样可用,
   * 不属于这里的"o 系列特判"。
   */
  isResponsesAPIModel(model: string): boolean {
    return /^o[134]/.test(model);
  }

  /**
   * 检查模型是否支持推理参数 (reasoning_effort, verbosity) — registry 优先, 名字启发式兜底。
   */
  supportsReasoning(model: string): boolean {
    const meta = lookupRegistryModel(model);
    if (meta?.supportsThinking !== undefined) return meta.supportsThinking;
    return this.isResponsesAPIModel(model) || model.includes('gpt-5');
  }

  /**
   * 检查模型是否支持 vision (图像输入) — registry 优先, 名字启发式兜底。
   */
  supportsVision(model: string): boolean {
    const meta = lookupRegistryModel(model);
    if (meta?.supportsVision !== undefined) return meta.supportsVision;
    return (
      model.includes('gpt-5') ||
      model.includes('gpt-4.1') ||
      model.includes('gpt-4o') ||
      model.includes('gpt-4-turbo') ||
      model.includes('gpt-4-vision') ||
      /^o[134]/.test(model)
    );
  }

  /**
   * 检查模型是否支持工具调用 — registry 优先, 名字启发式兜底。
   */
  supportsTools(model: string): boolean {
    const meta = lookupRegistryModel(model);
    if (meta?.supportsTools !== undefined) return meta.supportsTools;

    // o1 早期系列不支持工具调用
    if (model.startsWith('o1-preview') || model.startsWith('o1-mini')) {
      return false;
    }

    // 其他现代模型都支持
    return (
      model.includes('gpt-5') ||
      model.includes('gpt-4') ||
      model.includes('gpt-3.5-turbo') ||
      /^o[34]/.test(model)
    );
  }

  /**
   * 获取推荐的 max_tokens 值
   * @param model 模型名称
   * @param useCase 使用场景
   */
  getRecommendedMaxTokens(model: string, useCase?: 'short' | 'medium' | 'long'): number {
    const limits = this.getTokenLimits(model);

    switch (useCase) {
      case 'short':
        return Math.min(1024, limits.maxOutput);
      case 'medium':
        return Math.min(4096, limits.maxOutput);
      case 'long':
        return limits.maxOutput;
      default:
        // 默认使用中等长度
        return Math.min(4096, limits.maxOutput);
    }
  }
}

/**
 * 导出单例实例
 */
export const openaiConstraints = new OpenAIConstraints();
