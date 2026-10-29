/**
 * Anthropic (Claude) Provider Constraints
 *
 * 定义 Anthropic Claude 模型的参数约束、token 限制和验证规则
 */

import {
  BaseConstraints,
  type ProviderConstraints,
  rangeValidator,
  enumValidator,
  combineValidators,
} from './base.js';
import { lookupRegistryModel } from '@neoxlabs/platform/platform/modelCapabilities.js';

/** claude-2 / claude-instant 老系列 — 唯一不具备现代能力 (vision/tools/caching) 的 Claude 世代 */
const LEGACY_CLAUDE = /claude-(instant|2)/;

/**
 * Anthropic 约束配置
 *
 * 参考:
 * - https://docs.anthropic.com/en/docs/models-overview
 * - https://docs.anthropic.com/en/api/messages
 */
export class AnthropicConstraints extends BaseConstraints {
  getConstraints(): ProviderConstraints {
    return {
      // ========================================================================
      // Token 限制
      // ========================================================================
      maxOutputTokens: {
        // Claude 3.5 系列
        'claude-3-5-sonnet-20241022': 8192,
        'claude-3-5-sonnet-20240620': 8192,
        'claude-3-5-haiku-20241022': 8192,

        // Claude 3 系列
        'claude-3-opus-20240229': 4096,
        'claude-3-sonnet-20240229': 4096,
        'claude-3-haiku-20240307': 4096,

        // Claude 2 系列 (legacy)
        'claude-2.1': 4096,
        'claude-2.0': 4096,
        'claude-instant-1.2': 4096,

        // 通配符
        'claude-3-5*': 8192,
        'claude-3*': 4096,
        'claude-2*': 4096,
      },

      maxInputTokens: {
        // Claude 3.5 系列 - 200K context
        'claude-3-5-sonnet-20241022': 200000,
        'claude-3-5-sonnet-20240620': 200000,
        'claude-3-5-haiku-20241022': 200000,

        // Claude 3 系列 - 200K context
        'claude-3-opus-20240229': 200000,
        'claude-3-sonnet-20240229': 200000,
        'claude-3-haiku-20240307': 200000,

        // Claude 2 系列
        'claude-2.1': 200000,
        'claude-2.0': 100000,
        'claude-instant-1.2': 100000,

        // 通配符
        'claude-3*': 200000,
        'claude-2*': 200000,
      },

      // ========================================================================
      // 支持的参数
      // ========================================================================
      supportedParams: new Set([
        // 基础参数
        'model',
        'messages',
        'system',
        'stream',

        // Token 控制
        'max_tokens',

        // 采样参数
        'temperature',
        'top_p',
        'top_k',
        'stop_sequences',

        // 工具调用
        'tools',
        'tool_choice',

        // Extended Thinking (Claude 特有)
        'thinking',

        // Metadata
        'metadata',

        // 多模态 (vision)
        // Claude 通过 messages.content 数组支持图片
      ]),

      // ========================================================================
      // 参数别名映射
      // ========================================================================
      paramAliases: {
        // Anthropic 使用 max_tokens，而不是 max_completion_tokens
        max_completion_tokens: 'max_tokens',
        // stop 序列在 Anthropic 中叫 stop_sequences
        stop: 'stop_sequences',
      },

      // ========================================================================
      // 参数验证规则
      // ========================================================================
      validators: {
        // Temperature: 0.0 - 1.0 (Anthropic 范围比 OpenAI 小)
        temperature: rangeValidator(0, 1),

        // Top P: 0.0 - 1.0
        top_p: rangeValidator(0, 1),

        // Top K: 整数，通常 1-500
        top_k: combineValidators(
          (v) => Number.isInteger(v) || 'Must be an integer',
          rangeValidator(1, 500)
        ),

        // Max tokens (必填参数)
        max_tokens: (value: any) => {
          const num = Number(value);
          if (isNaN(num)) return 'Must be a number';
          if (num < 1) return 'Must be at least 1';
          return true;
        },

        // Thinking configuration (Extended Thinking)
        'thinking.type': enumValidator(['enabled', 'disabled', 'adaptive']),
        'thinking.budget_tokens': (value: any) => {
          const num = Number(value);
          if (isNaN(num)) return 'Must be a number';
          if (num < 1024) return 'Budget tokens must be at least 1024';
          if (num > 32000) return 'Budget tokens cannot exceed 32000';
          return true;
        },

        // Tool Choice
        tool_choice: (value: any) => {
          if (typeof value === 'string') {
            return ['auto', 'any', 'tool'].includes(value) || `Must be 'auto', 'any', or 'tool'`;
          }
          if (typeof value === 'object' && value.type === 'tool') {
            if (!value.name) {
              return 'tool_choice.name is required when type is "tool"';
            }
            return true;
          }
          return 'Invalid tool_choice format';
        },

        // Stop sequences (最多 4 个)
        stop_sequences: (value: any) => {
          if (!Array.isArray(value)) {
            return 'Must be an array';
          }
          if (value.length > 4) {
            return 'Maximum 4 stop sequences allowed';
          }
          if (!value.every((s) => typeof s === 'string')) {
            return 'All stop sequences must be strings';
          }
          return true;
        },

        // Stream
        stream: (value: any) => typeof value === 'boolean' || 'Must be a boolean',

        // Metadata user_id (不能包含 PII)
        'metadata.user_id': (value: any) => {
          if (typeof value !== 'string') {
            return 'Must be a string';
          }
          if (value.length > 64) {
            return 'Maximum 64 characters';
          }
          // 简单检查是否可能包含 PII (email, phone)
          if (value.includes('@') || /\d{10,}/.test(value)) {
            return 'user_id should not contain PII (email, phone number, etc.)';
          }
          return true;
        },
      },

      // ========================================================================
      // 默认值
      // ========================================================================
      defaults: {
        temperature: 1.0,
        top_p: 1.0,
        stream: false,
        // 注意: max_tokens 在 Anthropic API 中是必填的，不提供默认值
      },
    };
  }

  /**
   * 检查模型是否支持 Extended Thinking — registry 优先, 名字启发式兜底。
   * Claude 3.7+ / 4.x 全系支持; 3.5 及更早不支持 (原实现把 3.5-sonnet/3-opus 误判为支持)。
   */
  supportsThinking(model: string): boolean {
    const meta = lookupRegistryModel(model);
    if (meta?.supportsThinking !== undefined) return meta.supportsThinking;
    return /claude-(opus|sonnet|haiku)-[45]/.test(model) || model.includes('claude-3-7');
  }

  /**
   * 检查模型是否支持 vision (图像输入) — registry 优先; Claude 3 及更高版本都支持。
   */
  supportsVision(model: string): boolean {
    const meta = lookupRegistryModel(model);
    if (meta?.supportsVision !== undefined) return meta.supportsVision;
    return model.includes('claude') && !LEGACY_CLAUDE.test(model);
  }

  /**
   * 检查模型是否支持工具调用 — registry 优先; Claude 3 及更高版本都支持。
   */
  supportsTools(model: string): boolean {
    const meta = lookupRegistryModel(model);
    if (meta?.supportsTools !== undefined) return meta.supportsTools;
    return model.includes('claude') && !LEGACY_CLAUDE.test(model);
  }

  /**
   * 检查模型是否支持 Prompt Caching — Claude 3 Opus/Sonnet 以来全系支持 (含 4.x)。
   * 原实现只认 claude-3-5/claude-3-opus/claude-3-sonnet, 导致 claude-4 系被静默关掉缓存。
   */
  supportsPromptCaching(model: string): boolean {
    return model.includes('claude') && !LEGACY_CLAUDE.test(model);
  }

  /**
   * 获取推荐的 max_tokens 值
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
        return Math.min(4096, limits.maxOutput);
    }
  }

  /**
   * 验证 system prompt
   * Anthropic 对 system prompt 有特殊要求
   */
  validateSystemPrompt(systemPrompt: string | Array<{ type: string; text?: string; cache_control?: any }>): { valid: boolean; error?: string } {
    if (typeof systemPrompt === 'string') {
      if (systemPrompt.length === 0) {
        return { valid: false, error: 'System prompt cannot be empty' };
      }
      if (systemPrompt.length > 100000) {
        return { valid: false, error: 'System prompt too long (max 100K chars)' };
      }
      return { valid: true };
    }

    if (Array.isArray(systemPrompt)) {
      for (const block of systemPrompt) {
        if (block.type !== 'text') {
          return { valid: false, error: 'System prompt blocks must be of type "text"' };
        }
        if (!block.text || block.text.trim().length === 0) {
          return { valid: false, error: 'System prompt text blocks cannot be empty' };
        }
      }
      return { valid: true };
    }

    return { valid: false, error: 'System prompt must be a string or array of text blocks' };
  }

  /**
   * 获取 Prompt Caching 推荐配置
   */
  getCachingRecommendation(model: string, promptLength: number): {
    shouldUseCache: boolean;
    cacheTTL: '5m' | '1h';
    reason: string;
  } {
    if (!this.supportsPromptCaching(model)) {
      return {
        shouldUseCache: false,
        cacheTTL: '5m',
        reason: 'Model does not support prompt caching',
      };
    }

    // 短 prompt (<2K tokens) 不建议缓存
    if (promptLength < 2000) {
      return {
        shouldUseCache: false,
        cacheTTL: '5m',
        reason: 'Prompt too short, caching overhead not worth it',
      };
    }

    // 中等长度 (2K-10K) 使用 5 分钟缓存
    if (promptLength < 10000) {
      return {
        shouldUseCache: true,
        cacheTTL: '5m',
        reason: 'Medium prompt, 5-minute cache recommended',
      };
    }

    // 长 prompt (>10K) 使用 1 小时缓存
    return {
      shouldUseCache: true,
      cacheTTL: '1h',
      reason: 'Long prompt, 1-hour cache recommended for cost savings',
    };
  }
}

/**
 * 导出单例实例
 */
export const anthropicConstraints = new AnthropicConstraints();
