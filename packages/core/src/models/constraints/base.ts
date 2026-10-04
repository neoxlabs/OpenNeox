/**
 * Provider Constraints - 基础接口和抽象类
 *
 * 用于定义每个 AI Provider 的参数约束、验证规则和 token 限制
 */

import { modelRegistry } from '@neoxlabs/platform/models/registry/index.js';

// ============================================================================
// 类型定义
// ============================================================================

/** 参数验证结果 */
export interface ValidationResult {
  /** 是否验证通过 */
  valid: boolean;
  /** 错误信息列表 */
  errors: string[];
  /** 警告信息列表 */
  warnings?: string[];
}

/** 参数验证函数 */
export type ParamValidator = (value: any, allParams?: Record<string, any>) => boolean | string;

/** Provider 约束配置 */
export interface ProviderConstraints {
  /** 模型名称 -> 最大输出 tokens */
  maxOutputTokens: Record<string, number>;

  /** 模型名称 -> 最大输入 tokens (context window) */
  maxInputTokens: Record<string, number>;

  /** 该 provider 支持的参数列表 */
  supportedParams: Set<string>;

  /** 参数别名映射 (标准名 -> provider 特定名) */
  paramAliases?: Record<string, string>;

  /** 参数验证规则 (参数名 -> 验证函数) */
  validators?: Record<string, ParamValidator>;

  /** 默认参数值 */
  defaults?: Record<string, any>;
}

/** Token 限制信息 */
export interface TokenLimits {
  /** 最大输出 tokens */
  maxOutput: number;
  /** 最大输入 tokens */
  maxInput: number;
  /** 是否找到该模型的限制 */
  found: boolean;
  /** 如果未找到，使用的默认值来源 */
  source?: 'model' | 'default' | 'fallback';
}

// ============================================================================
// 基础约束抽象类
// ============================================================================

export abstract class BaseConstraints {
  /** 获取该 provider 的约束配置 */
  abstract getConstraints(): ProviderConstraints;

  /**
   * 验证请求参数
   * @param params 要验证的参数对象
   * @returns 验证结果
   */
  validateParams(params: Record<string, any>): ValidationResult {
    const constraints = this.getConstraints();
    const errors: string[] = [];
    const warnings: string[] = [];

    // 1. 检查不支持的参数
    for (const key of Object.keys(params)) {
      if (!constraints.supportedParams.has(key)) {
        warnings.push(`Parameter '${key}' is not supported by this provider and will be ignored`);
      }
    }

    // 2. 运行自定义验证器
    if (constraints.validators) {
      for (const [paramName, validator] of Object.entries(constraints.validators)) {
        if (params[paramName] !== undefined) {
          const result = validator(params[paramName], params);

          if (result === false) {
            errors.push(`Invalid value for parameter '${paramName}': ${params[paramName]}`);
          } else if (typeof result === 'string') {
            errors.push(`Parameter '${paramName}': ${result}`);
          }
        }
      }
    }

    // 3. 验证 token 限制
    if (params.model && params.max_tokens !== undefined) {
      const limits = this.getTokenLimits(params.model);

      // 硬限制：不能超过模型的上下文窗口（maxInput）
      if (limits.found && params.max_tokens > limits.maxInput) {
        errors.push(
          `max_tokens (${params.max_tokens}) exceeds model context window (${limits.maxInput}) for ${params.model}`
        );
      }
      // 软限制：超过建议的 maxOutput 时给出警告
      else if (limits.found && params.max_tokens > limits.maxOutput) {
        warnings.push(
          `max_tokens (${params.max_tokens}) exceeds recommended output limit (${limits.maxOutput}) for ${params.model}, but is within context window`
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * 获取模型的 token 限制
   * @param model 模型名称
   * @returns Token 限制信息
   *
   * 优先级:
   * 1. 统一模型注册表 (models/registry) - 单一真实来源
   * 2. Provider 约束表 (constraints) - 精确匹配
   * 3. Provider 约束表 (constraints) - 通配符匹配
   * 4. 回退默认值
   */
  getTokenLimits(model: string): TokenLimits {
    const registryModel = modelRegistry.getModel(model);
    if (registryModel) {
      return {
        maxOutput: registryModel.maxOutputTokens,
        maxInput: registryModel.maxInputTokens,
        found: true,
        source: 'model',
      };
    }

    // 回退到 Provider 约束表
    const constraints = this.getConstraints();

    const maxOutput = constraints.maxOutputTokens[model];
    const maxInput = constraints.maxInputTokens[model];

    if (maxOutput !== undefined && maxInput !== undefined) {
      return {
        maxOutput,
        maxInput,
        found: true,
        source: 'model',
      };
    }

    // 尝试通配符匹配 (例如 "gpt-4*" 匹配 "gpt-4-turbo")
    for (const [pattern, limit] of Object.entries(constraints.maxOutputTokens)) {
      if (this.matchPattern(model, pattern)) {
        return {
          maxOutput: limit,
          maxInput: constraints.maxInputTokens[pattern] || 128000,
          found: true,
          source: 'model',
        };
      }
    }

    // 返回默认值
    return {
      maxOutput: 4096,
      maxInput: 128000,
      found: false,
      source: 'fallback',
    };
  }

  /**
   * 标准化参数名称（应用别名映射）
   * @param params 原始参数
   * @returns 标准化后的参数
   */
  normalizeParams(params: Record<string, any>): Record<string, any> {
    const constraints = this.getConstraints();
    const normalized: Record<string, any> = {};

    for (const [key, value] of Object.entries(params)) {
      // 应用别名
      const actualKey = constraints.paramAliases?.[key] || key;

      // 只保留支持的参数
      if (constraints.supportedParams.has(key)) {
        normalized[actualKey] = value;
      }
    }

    // 应用默认值
    if (constraints.defaults) {
      for (const [key, defaultValue] of Object.entries(constraints.defaults)) {
        if (normalized[key] === undefined) {
          normalized[key] = defaultValue;
        }
      }
    }

    return normalized;
  }

  /**
   * 简单的模式匹配（支持 * 通配符）
   */
  private matchPattern(value: string, pattern: string): boolean {
    if (!pattern.includes('*')) {
      return value === pattern;
    }

    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return regex.test(value);
  }

  /**
   * 检查参数是否被支持
   */
  isParamSupported(paramName: string): boolean {
    const constraints = this.getConstraints();
    return constraints.supportedParams.has(paramName);
  }

  /**
   * 获取参数的别名（如果有）
   */
  getParamAlias(paramName: string): string {
    const constraints = this.getConstraints();
    return constraints.paramAliases?.[paramName] || paramName;
  }
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 创建范围验证器
 * @param min 最小值
 * @param max 最大值
 */
export function rangeValidator(min: number, max: number): ParamValidator {
  return (value: any) => {
    const num = Number(value);
    if (isNaN(num)) {
      return `Must be a number`;
    }
    if (num < min || num > max) {
      return `Must be between ${min} and ${max}`;
    }
    return true;
  };
}

/**
 * 创建枚举验证器
 * @param allowedValues 允许的值列表
 */
export function enumValidator(allowedValues: any[]): ParamValidator {
  return (value: any) => {
    if (!allowedValues.includes(value)) {
      return `Must be one of: ${allowedValues.join(', ')}`;
    }
    return true;
  };
}

/**
 * 创建类型验证器
 * @param expectedType 期望的类型
 */
export function typeValidator(expectedType: string): ParamValidator {
  return (value: any) => {
    const actualType = typeof value;
    if (actualType !== expectedType) {
      return `Expected ${expectedType}, got ${actualType}`;
    }
    return true;
  };
}

/**
 * 组合多个验证器
 */
export function combineValidators(...validators: ParamValidator[]): ParamValidator {
  return (value: any, allParams?: Record<string, any>) => {
    for (const validator of validators) {
      const result = validator(value, allParams);
      if (result !== true) {
        return result;
      }
    }
    return true;
  };
}
