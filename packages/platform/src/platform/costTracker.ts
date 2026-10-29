
import { getModelPricing, calculateRequestCost, formatCost, type BuiltinPricingEntry } from './modelPricingTable.js';
import type { ModelPricingConfig } from '../utils/config.js';
import type { TokenUsageRecord } from './tokenUsageService.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

// ==================== 类型定义 ====================

export interface CostSnapshot {
  /** 总费用（美元） */
  totalCostUsd: number;
  /** 输入 token 费用 */
  inputCostUsd: number;
  /** 输出 token 费用 */
  outputCostUsd: number;
  /** 缓存节省金额 */
  cacheSavingsUsd: number;
  /** 总输入 tokens */
  totalInputTokens: number;
  /** 总输出 tokens */
  totalOutputTokens: number;
  /** 总缓存命中 tokens */
  totalCachedTokens: number;
  /** 请求次数 */
  requestCount: number;
  /** 按模型分桶 */
  byModel: Record<string, {
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    requests: number;
  }>;
}

export interface CostBudget {
  /** Session 费用上限（美元）— 0 表示不限制 */
  sessionLimitUsd: number;
  /** 单次请求费用告警阈值（美元） */
  requestWarnUsd: number;
  /** 超限时的动作 */
  action: 'warn' | 'pause' | 'stop';
}

export interface CostEvent {
  type: 'cost_update' | 'budget_warning' | 'budget_exceeded';
  snapshot: CostSnapshot;
  lastRequestCost?: number;
  message?: string;
}

// ==================== CostTracker ====================

export class CostTracker {
  private snapshot: CostSnapshot;
  private budget: CostBudget;
  private userPricing: ModelPricingConfig[];
  private listeners: Array<(event: CostEvent) => void> = [];

  constructor(options?: {
    budget?: Partial<CostBudget>;
    userPricing?: ModelPricingConfig[];
  }) {
    this.snapshot = createEmptySnapshot();
    this.budget = {
      sessionLimitUsd: options?.budget?.sessionLimitUsd ?? 0,
      requestWarnUsd: options?.budget?.requestWarnUsd ?? 1.0,
      action: options?.budget?.action ?? 'warn',
    };
    this.userPricing = options?.userPricing ?? [];
  }

  /**
   * 记录一次 API 请求的费用
   *
   * 每次 tokenUsageService.recordUsage() 之后调用此方法
   */
  recordRequest(record: {
    model: string;
    provider?: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;
    cacheCreationTokens?: number;
  }): CostEvent {
    const pricing = getModelPricing(record.model, record.provider, this.userPricing);
    const cost = calculateRequestCost(
      pricing as BuiltinPricingEntry,
      {
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        cachedTokens: record.cachedTokens,
        cacheCreationTokens: record.cacheCreationTokens,
      },
    );

    // 计算缓存节省
    const fullInputCost = record.cachedTokens
      ? (record.cachedTokens / 1_000_000) * pricing.inputPrice
      : 0;
    const actualCachedCost = record.cachedTokens
      ? (record.cachedTokens / 1_000_000) * (pricing.cachedInputPrice ?? pricing.inputPrice * 0.1)
      : 0;
    const savings = fullInputCost - actualCachedCost;

    // 更新快照
    this.snapshot.totalCostUsd += cost;
    this.snapshot.inputCostUsd += (record.inputTokens / 1_000_000) * pricing.inputPrice;
    this.snapshot.outputCostUsd += (record.outputTokens / 1_000_000) * (pricing.outputPrice ?? 0);
    this.snapshot.cacheSavingsUsd += savings;
    this.snapshot.totalInputTokens += record.inputTokens;
    this.snapshot.totalOutputTokens += record.outputTokens;
    this.snapshot.totalCachedTokens += record.cachedTokens ?? 0;
    this.snapshot.requestCount++;

    // 按模型分桶
    const modelKey = record.model;
    if (!this.snapshot.byModel[modelKey]) {
      this.snapshot.byModel[modelKey] = { costUsd: 0, inputTokens: 0, outputTokens: 0, requests: 0 };
    }
    this.snapshot.byModel[modelKey].costUsd += cost;
    this.snapshot.byModel[modelKey].inputTokens += record.inputTokens;
    this.snapshot.byModel[modelKey].outputTokens += record.outputTokens;
    this.snapshot.byModel[modelKey].requests++;

    // 生成事件
    let event: CostEvent;

    // 检查预算
    if (this.budget.sessionLimitUsd > 0 && this.snapshot.totalCostUsd >= this.budget.sessionLimitUsd) {
      event = {
        type: 'budget_exceeded',
        snapshot: { ...this.snapshot },
        lastRequestCost: cost,
        message: `Session cost ${formatCost(this.snapshot.totalCostUsd)} exceeded budget ${formatCost(this.budget.sessionLimitUsd)}`,
      };
      cliLogger.warn('COST', event.message!);
    } else if (cost >= this.budget.requestWarnUsd) {
      event = {
        type: 'budget_warning',
        snapshot: { ...this.snapshot },
        lastRequestCost: cost,
        message: `Single request cost ${formatCost(cost)} (model: ${record.model})`,
      };
      cliLogger.warn('COST', event.message!);
    } else {
      event = {
        type: 'cost_update',
        snapshot: { ...this.snapshot },
        lastRequestCost: cost,
      };
    }

    // 通知监听器
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 监听器异常不影响主流程
      }
    }

    return event;
  }

  /** 获取当前费用快照 */
  getSnapshot(): Readonly<CostSnapshot> {
    return { ...this.snapshot };
  }

  /** 获取格式化的 Session 费用摘要 */
  getSessionSummary(): string {
    const s = this.snapshot;
    if (s.requestCount === 0) return 'No API requests made';

    const lines: string[] = [
      `Cost: ${formatCost(s.totalCostUsd)} (${s.requestCount} requests)`,
      `Tokens: ${fmtNum(s.totalInputTokens)} in / ${fmtNum(s.totalOutputTokens)} out`,
    ];

    if (s.totalCachedTokens > 0) {
      const cacheRate = s.totalInputTokens > 0
        ? ((s.totalCachedTokens / s.totalInputTokens) * 100).toFixed(0)
        : '0';
      lines.push(`Cache: ${fmtNum(s.totalCachedTokens)} tokens (${cacheRate}% hit, saved ${formatCost(s.cacheSavingsUsd)})`);
    }

    // 按模型分桶
    const models = Object.entries(s.byModel).sort((a, b) => b[1].costUsd - a[1].costUsd);
    if (models.length > 1) {
      lines.push('By model:');
      for (const [model, stats] of models) {
        lines.push(`  ${model}: ${formatCost(stats.costUsd)} (${stats.requests} req)`);
      }
    }

    return lines.join('\n');
  }

  /** 是否已超预算 */
  isBudgetExceeded(): boolean {
    return this.budget.sessionLimitUsd > 0 && this.snapshot.totalCostUsd >= this.budget.sessionLimitUsd;
  }

  /** 预算动作 */
  getBudgetAction(): CostBudget['action'] {
    return this.budget.action;
  }

  /** 更新预算 */
  setBudget(budget: Partial<CostBudget>): void {
    Object.assign(this.budget, budget);
  }

  /** 更新用户定价 */
  setUserPricing(pricing: ModelPricingConfig[]): void {
    this.userPricing = pricing;
  }

  /** 订阅费用事件 */
  onCostEvent(listener: (event: CostEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  /**
   * 从历史记录恢复费用状态（session resume 时调用）
   * 静默重放，不触发 budget 事件和监听器
   */
  restoreFromRecords(records: Array<{
    model: string;
    provider?: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;
    cacheCreationTokens?: number;
    requests: number;
  }>): void {
    for (const record of records) {
      const pricing = getModelPricing(record.model, record.provider, this.userPricing);
      // 按请求数均摊计算（聚合记录）
      const cost = calculateRequestCost(
        pricing as BuiltinPricingEntry,
        {
          inputTokens: record.inputTokens,
          outputTokens: record.outputTokens,
          cachedTokens: record.cachedTokens,
          cacheCreationTokens: record.cacheCreationTokens,
        },
      );

      const fullInputCost = record.cachedTokens
        ? (record.cachedTokens / 1_000_000) * pricing.inputPrice
        : 0;
      const actualCachedCost = record.cachedTokens
        ? (record.cachedTokens / 1_000_000) * (pricing.cachedInputPrice ?? pricing.inputPrice * 0.1)
        : 0;
      const savings = fullInputCost - actualCachedCost;

      this.snapshot.totalCostUsd += cost;
      this.snapshot.inputCostUsd += (record.inputTokens / 1_000_000) * pricing.inputPrice;
      this.snapshot.outputCostUsd += (record.outputTokens / 1_000_000) * (pricing.outputPrice ?? 0);
      this.snapshot.cacheSavingsUsd += savings;
      this.snapshot.totalInputTokens += record.inputTokens;
      this.snapshot.totalOutputTokens += record.outputTokens;
      this.snapshot.totalCachedTokens += record.cachedTokens ?? 0;
      this.snapshot.requestCount += record.requests;

      const modelKey = record.model;
      if (!this.snapshot.byModel[modelKey]) {
        this.snapshot.byModel[modelKey] = { costUsd: 0, inputTokens: 0, outputTokens: 0, requests: 0 };
      }
      this.snapshot.byModel[modelKey].costUsd += cost;
      this.snapshot.byModel[modelKey].inputTokens += record.inputTokens;
      this.snapshot.byModel[modelKey].outputTokens += record.outputTokens;
      this.snapshot.byModel[modelKey].requests += record.requests;
    }

    if (records.length > 0) {
      cliLogger.info('COST', `Restored ${this.snapshot.requestCount} requests, ${formatCost(this.snapshot.totalCostUsd)} total cost`);
    }
  }

  /** 重置（新 Session） */
  reset(): void {
    this.snapshot = createEmptySnapshot();
  }
}

// ==================== 工具函数 ====================

function createEmptySnapshot(): CostSnapshot {
  return {
    totalCostUsd: 0,
    inputCostUsd: 0,
    outputCostUsd: 0,
    cacheSavingsUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCachedTokens: 0,
    requestCount: 0,
    byModel: {},
  };
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ==================== 全局单例 ====================

let _globalTracker: CostTracker | null = null;

export function getGlobalCostTracker(): CostTracker {
  if (!_globalTracker) {
    _globalTracker = new CostTracker();
  }
  return _globalTracker;
}

export function initGlobalCostTracker(options?: {
  budget?: Partial<CostBudget>;
  userPricing?: ModelPricingConfig[];
}): CostTracker {
  _globalTracker = new CostTracker(options);
  return _globalTracker;
}
