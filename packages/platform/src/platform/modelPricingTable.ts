/**
 * 内置模型定价表
 *
 * 内置公开定价，用户无需手动配置。
 *
 * 所有价格单位：$/1M tokens
 * 数据来源：各厂商公开定价页面。
 *
 * 策略：
 * 1. 内置表覆盖主流模型 → 零配置开箱即用
 * 2. 用户自定义定价优先级高于内置表
 * 3. 未匹配时用同系列默认价格兜底
 */

import type { ModelPricingConfig } from '../utils/config.js';

// ==================== 内置定价表 ====================

/**
 * 内置定价条目 — 扩展 ModelPricingConfig 增加 provider 维度
 */
export interface BuiltinPricingEntry extends ModelPricingConfig {
  /** 供应商标识（用于按 provider 查找） */
  provider?: string;
  /** 缓存创建价格 (Anthropic 125% = 3.75 for sonnet input 3.0) */
  cacheCreationPrice?: number;
}

/**
 * 内置模型定价表
 *
 * 维护规则：
 * - 每季度审核一次价格
 * - 新模型发布时立即添加
 * - 停用模型保留 6 个月后移除
 */
export const BUILTIN_PRICING_TABLE: BuiltinPricingEntry[] = [
  // ==================== Anthropic ====================
  // https://docs.anthropic.com/en/docs/about-claude/models
  {
    pattern: 'claude-opus-4*',
    provider: 'anthropic',
    inputPrice: 15.0,
    outputPrice: 75.0,
    cachedInputPrice: 1.5,
    cacheCreationPrice: 18.75,
  },
  {
    pattern: 'claude-sonnet-4*',
    provider: 'anthropic',
    inputPrice: 3.0,
    outputPrice: 15.0,
    cachedInputPrice: 0.3,
    cacheCreationPrice: 3.75,
  },
  {
    pattern: 'claude-3-7-sonnet*',
    provider: 'anthropic',
    inputPrice: 3.0,
    outputPrice: 15.0,
    cachedInputPrice: 0.3,
    cacheCreationPrice: 3.75,
  },
  {
    pattern: 'claude-3-5-sonnet*',
    provider: 'anthropic',
    inputPrice: 3.0,
    outputPrice: 15.0,
    cachedInputPrice: 0.3,
    cacheCreationPrice: 3.75,
  },
  {
    pattern: 'claude-3-5-haiku*',
    provider: 'anthropic',
    inputPrice: 0.80,
    outputPrice: 4.0,
    cachedInputPrice: 0.08,
    cacheCreationPrice: 1.0,
  },
  {
    pattern: 'claude-3-haiku*',
    provider: 'anthropic',
    inputPrice: 0.25,
    outputPrice: 1.25,
    cachedInputPrice: 0.03,
    cacheCreationPrice: 0.30,
  },
  {
    pattern: 'claude-3-opus*',
    provider: 'anthropic',
    inputPrice: 15.0,
    outputPrice: 75.0,
    cachedInputPrice: 1.5,
    cacheCreationPrice: 18.75,
  },

  // ==================== OpenAI ====================
  // https://openai.com/api/pricing/
  {
    pattern: 'gpt-4.1*',
    provider: 'openai',
    inputPrice: 2.0,
    outputPrice: 8.0,
    cachedInputPrice: 0.5,
  },
  {
    pattern: 'gpt-4.1-mini*',
    provider: 'openai',
    inputPrice: 0.40,
    outputPrice: 1.60,
    cachedInputPrice: 0.10,
  },
  {
    pattern: 'gpt-4.1-nano*',
    provider: 'openai',
    inputPrice: 0.10,
    outputPrice: 0.40,
    cachedInputPrice: 0.025,
  },
  {
    pattern: 'gpt-4o-2*',
    provider: 'openai',
    inputPrice: 2.50,
    outputPrice: 10.0,
    cachedInputPrice: 1.25,
  },
  {
    pattern: 'gpt-4o-mini*',
    provider: 'openai',
    inputPrice: 0.15,
    outputPrice: 0.60,
    cachedInputPrice: 0.075,
  },
  {
    pattern: 'gpt-4o*',
    provider: 'openai',
    inputPrice: 2.50,
    outputPrice: 10.0,
    cachedInputPrice: 1.25,
  },
  {
    pattern: 'o3*',
    provider: 'openai',
    inputPrice: 2.0,
    outputPrice: 8.0,
    cachedInputPrice: 0.5,
  },
  {
    pattern: 'o4-mini*',
    provider: 'openai',
    inputPrice: 1.10,
    outputPrice: 4.40,
    cachedInputPrice: 0.275,
  },
  {
    pattern: 'o1*',
    provider: 'openai',
    inputPrice: 15.0,
    outputPrice: 60.0,
    cachedInputPrice: 7.5,
  },
  {
    pattern: 'o1-mini*',
    provider: 'openai',
    inputPrice: 3.0,
    outputPrice: 12.0,
    cachedInputPrice: 1.5,
  },
  {
    pattern: 'gpt-4-turbo*',
    provider: 'openai',
    inputPrice: 10.0,
    outputPrice: 30.0,
  },
  {
    pattern: 'gpt-4-0*',
    provider: 'openai',
    inputPrice: 30.0,
    outputPrice: 60.0,
  },
  {
    pattern: 'gpt-3.5-turbo*',
    provider: 'openai',
    inputPrice: 0.50,
    outputPrice: 1.50,
  },

  // ==================== Google Gemini ====================
  // https://ai.google.dev/pricing
  {
    pattern: 'gemini-2.5-pro*',
    provider: 'gemini',
    inputPrice: 1.25,
    outputPrice: 10.0,
    cachedInputPrice: 0.3125,
  },
  {
    pattern: 'gemini-2.5-flash*',
    provider: 'gemini',
    inputPrice: 0.15,
    outputPrice: 0.60,
    cachedInputPrice: 0.0375,
  },
  {
    pattern: 'gemini-2.0-flash*',
    provider: 'gemini',
    inputPrice: 0.10,
    outputPrice: 0.40,
    cachedInputPrice: 0.025,
  },
  {
    pattern: 'gemini-1.5-pro*',
    provider: 'gemini',
    inputPrice: 1.25,
    outputPrice: 5.0,
    cachedInputPrice: 0.3125,
  },
  {
    pattern: 'gemini-1.5-flash*',
    provider: 'gemini',
    inputPrice: 0.075,
    outputPrice: 0.30,
    cachedInputPrice: 0.01875,
  },

  // ==================== DeepSeek ====================
  {
    pattern: 'deepseek-chat*',
    provider: 'deepseek',
    inputPrice: 0.27,
    outputPrice: 1.10,
    cachedInputPrice: 0.07,
  },
  {
    pattern: 'deepseek-reasoner*',
    provider: 'deepseek',
    inputPrice: 0.55,
    outputPrice: 2.19,
    cachedInputPrice: 0.14,
  },

  // ==================== 国产模型 (¥ → $ 近似换算) ====================
  // 价格按人民币标注，currency 标记 CNY
  {
    pattern: 'qwen-max*',
    provider: 'qwen',
    inputPrice: 2.80,   // ¥20/1M
    outputPrice: 11.20,  // ¥80/1M
    currency: 'CNY-approx',
  },
  {
    pattern: 'qwen-plus*',
    provider: 'qwen',
    inputPrice: 0.56,   // ¥4/1M
    outputPrice: 1.68,   // ¥12/1M
    currency: 'CNY-approx',
  },
  {
    pattern: 'qwen-turbo*',
    provider: 'qwen',
    inputPrice: 0.07,   // ¥0.5/1M
    outputPrice: 0.28,   // ¥2/1M
    currency: 'CNY-approx',
  },
  {
    pattern: 'glm-4*',
    provider: 'glm',
    inputPrice: 1.40,   // ¥10/1M
    outputPrice: 1.40,   // ¥10/1M
    currency: 'CNY-approx',
  },
  {
    pattern: 'moonshot-v1*',
    provider: 'kimi',
    inputPrice: 1.68,   // ¥12/1M
    outputPrice: 1.68,   // ¥12/1M
    currency: 'CNY-approx',
  },
  {
    pattern: 'doubao-pro*',
    provider: 'doubao',
    inputPrice: 0.11,   // ¥0.8/1M
    outputPrice: 0.28,   // ¥2/1M
    currency: 'CNY-approx',
  },
];

// ==================== 默认兜底价格 ====================

/** 当模型完全无法匹配时，按这个默认价格计算 */
export const DEFAULT_FALLBACK_PRICING: ModelPricingConfig = {
  pattern: '*',
  inputPrice: 3.0,   // 中位数水平
  outputPrice: 15.0,
  cachedInputPrice: 0.3,
};

// ==================== 查找逻辑 ====================

/**
 * 从内置表查找模型定价
 *
 * 优先级：精确匹配 > 通配符匹配 > provider 内默认 > 全局默认
 */
export function findBuiltinPricing(
  modelId: string,
  provider?: string,
): BuiltinPricingEntry | null {
  // 1. 精确匹配
  const exact = BUILTIN_PRICING_TABLE.find(p => p.pattern === modelId);
  if (exact) return exact;

  // 2. 通配符匹配（优先匹配更长的 pattern，更精确）
  const matches: BuiltinPricingEntry[] = [];
  for (const entry of BUILTIN_PRICING_TABLE) {
    if (matchPattern(entry.pattern, modelId)) {
      // 如果指定了 provider，优先匹配同 provider
      if (provider && entry.provider === provider) {
        matches.unshift(entry); // 放前面
      } else {
        matches.push(entry);
      }
    }
  }

  // 按 pattern 长度降序（更具体的模式优先）
  if (matches.length > 0) {
    matches.sort((a, b) => b.pattern.length - a.pattern.length);
    return matches[0];
  }

  return null;
}

/**
 * 获取模型定价 — 统一入口
 *
 * 优先级：用户自定义 > 内置表 > 全局默认
 */
export function getModelPricing(
  modelId: string,
  provider?: string,
  userPricing?: ModelPricingConfig[],
): ModelPricingConfig {
  // 1. 用户自定义优先
  if (userPricing && userPricing.length > 0) {
    const userMatch = findUserPricing(userPricing, modelId);
    if (userMatch) return userMatch;
  }

  // 2. 内置表
  const builtin = findBuiltinPricing(modelId, provider);
  if (builtin) return builtin;

  // 3. 全局默认
  return DEFAULT_FALLBACK_PRICING;
}

/**
 * 计算单次请求费用（美元）
 *
 * 支持 Anthropic 缓存创建 (125%) 和缓存读取 (10%) 差异化计费
 */
export function calculateRequestCost(
  pricing: ModelPricingConfig & { cacheCreationPrice?: number },
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;
    cacheCreationTokens?: number;
  },
): number {
  // 基础输入费用（扣除缓存命中部分）
  const nonCachedInput = Math.max(0, usage.inputTokens - (usage.cachedTokens ?? 0) - (usage.cacheCreationTokens ?? 0));
  const inputCost = (nonCachedInput / 1_000_000) * pricing.inputPrice;

  // 输出费用
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputPrice;

  // 缓存读取费用（10% of input price）
  const cachedReadCost = usage.cachedTokens
    ? (usage.cachedTokens / 1_000_000) * (pricing.cachedInputPrice ?? pricing.inputPrice * 0.1)
    : 0;

  // 缓存创建费用（125% of input price）
  const cacheCreateCost = usage.cacheCreationTokens
    ? (usage.cacheCreationTokens / 1_000_000) * ((pricing as any).cacheCreationPrice ?? pricing.inputPrice * 1.25)
    : 0;

  return inputCost + outputCost + cachedReadCost + cacheCreateCost;
}

/**
 * 格式化费用显示
 */
export function formatCost(costUsd: number): string {
  if (costUsd < 0.001) return `$${costUsd.toFixed(6)}`;
  if (costUsd < 0.01) return `$${costUsd.toFixed(4)}`;
  if (costUsd < 1) return `$${costUsd.toFixed(3)}`;
  return `$${costUsd.toFixed(2)}`;
}

// ==================== 内部工具 ====================

function matchPattern(pattern: string, modelId: string): boolean {
  if (!pattern.includes('*')) return pattern === modelId;
  const regex = new RegExp('^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, (m) => m === '*' ? '.*' : '\\' + m) + '$');
  return regex.test(modelId);
}

function findUserPricing(list: ModelPricingConfig[], modelId: string): ModelPricingConfig | null {
  const safe = (list || []).filter(
    (p): p is ModelPricingConfig => !!p && typeof p.pattern === 'string' && p.pattern.length > 0,
  );
  const exact = safe.find(p => p.pattern === modelId);
  if (exact) return exact;
  for (const p of safe) {
    if (p.pattern.includes('*') && matchPattern(p.pattern, modelId)) {
      return p;
    }
  }
  return null;
}
