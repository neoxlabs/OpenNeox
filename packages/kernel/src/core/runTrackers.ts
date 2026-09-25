/**
 * Runner 主循环的三大决策单元：把散落在 run() 里 22 个有因果关系的
 * mutable 局部变量收拢为三个带方法的 tracker 对象。
 *
 * - RecoveryTracker:  max-output 续跑、递减回报、流重试、模型降级
 * - ProgressTracker:  无工具连击、预算兜底、结构化重试、进度门
 * - RunAccumulator:   迭代计数、工具计数、最终输出、usage、停止原因
 *
 * 每个 tracker 封装自己的交互规则，对外只暴露决策结论。
 * run() 不再需要理解内部计数器如何互相影响。
 */

import { cliLogger } from '../platform/cliLogger.js';

// ======================== Types ========================

export type StopReason =
  | 'iteration_limit'
  | 'tool_call_limit'
  | 'runtime_limit'
  | 'interrupted'
  | 'max_output_recovery_exhausted'
  /* tool call 死循环检测触发强停 (ToolCallDeduplicator streak >= 12).
   *   配合 prepareToolResultForMemory 返回的 dedupForceStop, runner 在 tool batch 后检测并设此 reason. */
  | 'tool_dedup_force_stop'
  /* reasoning loop 检测触发强停 (ReasoningLoopDetector streak >= 12).
   *   模型连续多轮纯文本回复无 tool_call, 文本高度相似 (prefix hash 相同) → 死循环. */
  | 'reasoning_loop_force_stop'
  | 'idle_no_tool_hard_stop'
  /* 工具被硬拦 (死循环 / 高危) 后的收尾轮, 模型连一句结论都没写 */
  | 'tool_blocked';

export interface RecoverySnapshot {
  maxOutputRecoveryCount: number;
  diminishingReturnStreak: number;
  streamRetries: number;
  providerManagedRetryObserved: boolean;
  lastTransitionReason: string | null;
  /** D8: 全 run 的总 retry 计数 (stream + max_output + structured + recovery_compact 等),
   *  跨 category 共享一个上限, 避免某一类先用完后另一类还无限重试 */
  totalRetryAttempts: number;
  /** retry budget 已用量按 category 分桶, 给可观测性用 */
  retryByCategory: Record<string, number>;
  /** audit §4: 429 限流退避单独计数 (不占 totalRetryAttempts), 见 tryRateLimitRetry */
  rateLimitRetryAttempts: number;
}

export interface ProgressSnapshot {
  textOnlyStreakCount: number;
  noToolContinueTotal: number;
  structuredRetryCount: number;
  lowProgressStreak: number;
  completionEvidenceNudges: number;
}

// ======================== RecoveryTracker ========================

const DEFAULT_MAX_OUTPUT_RECOVERY_LIMIT = 3;
const DEFAULT_DIMINISHING_THRESHOLD = 200;
/* Prompt-too-long recovery compaction is limited to three attempts per run. */
const DEFAULT_RECOVERY_COMPACT_LIMIT = 3;
/* A single retry budget is shared across categories so each run remains bounded. */
const DEFAULT_MAX_TOTAL_RETRY_BUDGET = 20;
/* audit §4: 429 限流退避从总预算里拆出来单独计数。
   长限流场景下 429 会连续吃掉多次 retry, 把 20 的总预算烧穿后连 prompt_too_long
   的压缩恢复都没预算做。拆分后: 429 走自己的上限 (8 次), 不消耗通用预算;
   streamRetries(6) 的细分上限仍然生效, 这里只是兜底防失控。 */
const DEFAULT_MAX_RATE_LIMIT_RETRY_BUDGET = 8;

export class RecoveryTracker {
  private maxOutputRecoveryCount = 0;
  private lastRecoveryOutputLength = 0;
  private diminishingReturnStreak = 0;
  private recoveryCompactAttempts = 0;
  /** D8: 全 run 总 retry 计数 (含 stream/max_output/structured/recovery_compact 等所有 category). */
  private totalRetryAttempts = 0;
  /** D8: 每 category 分桶计数, 仅用于诊断 */
  private retryByCategory = new Map<string, number>();
  /** 429 限流退避单独计数 — 不进 totalRetryAttempts (见 tryRateLimitRetry) */
  private rateLimitRetryAttempts = 0;

  streamRetries = 0;
  providerManagedRetryObserved = false;
  lastTransitionReason: string | null = null;

  private readonly maxRecoveryLimit: number;
  private readonly diminishingThreshold: number;
  private readonly recoveryCompactLimit: number;
  private readonly maxTotalRetryBudget: number;
  private readonly maxRateLimitRetryBudget: number;

  constructor(opts?: {
    maxRecoveryLimit?: number;
    diminishingThreshold?: number;
    recoveryCompactLimit?: number;
    maxTotalRetryBudget?: number;
    maxRateLimitRetryBudget?: number;
  }) {
    this.maxRecoveryLimit = opts?.maxRecoveryLimit ?? DEFAULT_MAX_OUTPUT_RECOVERY_LIMIT;
    this.diminishingThreshold = opts?.diminishingThreshold ?? DEFAULT_DIMINISHING_THRESHOLD;
    this.recoveryCompactLimit = opts?.recoveryCompactLimit ?? DEFAULT_RECOVERY_COMPACT_LIMIT;
    this.maxTotalRetryBudget = opts?.maxTotalRetryBudget ?? DEFAULT_MAX_TOTAL_RETRY_BUDGET;
    this.maxRateLimitRetryBudget = opts?.maxRateLimitRetryBudget ?? DEFAULT_MAX_RATE_LIMIT_RETRY_BUDGET;
  }

  /**
   *  Shared retry-budget entry point. Each retry site calls tryRetry(category) first.
   *
   *   - 不消耗自身 category 的细分预算 (那些独立机制仍生效, e.g. streamRetries 上限 6 也得遵守)
   *   - 只追踪"全 run retry 攻势"的总量, 防止多 category 串联滚雪球
   *
   *   Return true to allow and count a retry; return false when the shared budget is exhausted.
   */
  tryRetry(category: string): boolean {
    if (this.totalRetryAttempts >= this.maxTotalRetryBudget) {
      cliLogger.warn('RUNNER',
        `total retry budget exhausted (${this.totalRetryAttempts}/${this.maxTotalRetryBudget}) at "${category}" — refusing further retries`);
      return false;
    }
    this.totalRetryAttempts++;
    this.retryByCategory.set(category, (this.retryByCategory.get(category) ?? 0) + 1);
    return true;
  }

  /**
   *  Dedicated budget for 429 backoff, separate from general recovery retries.
   *   限流是"等一等就能好"的容量问题, 不该和 recovery/fallback 抢 20 次总预算:
   *   长限流把总预算烧穿后, prompt_too_long 连压缩恢复的机会都没有。
   *
   *   - 不消耗 totalRetryAttempts (通用预算维持现值)
   *   - streamRetries 的细分上限 (decideRetry 里的 maxStreamRetries) 仍然生效
   *
   *   Return true to allow and count a 429 backoff; return false when its budget is exhausted.
   */
  tryRateLimitRetry(): boolean {
    if (this.rateLimitRetryAttempts >= this.maxRateLimitRetryBudget) {
      cliLogger.warn('RUNNER',
        `rate-limit retry budget exhausted (${this.rateLimitRetryAttempts}/${this.maxRateLimitRetryBudget}) — refusing further 429 retries`);
      return false;
    }
    this.rateLimitRetryAttempts++;
    return true;
  }

  getRetryBudgetSnapshot(): { used: number; max: number; byCategory: Record<string, number>; rateLimit: { used: number; max: number } } {
    return {
      used: this.totalRetryAttempts,
      max: this.maxTotalRetryBudget,
      byCategory: Object.fromEntries(this.retryByCategory),
      rateLimit: { used: this.rateLimitRetryAttempts, max: this.maxRateLimitRetryBudget },
    };
  }

  /**
   * prompt_too_long 时是否还能再尝试一次 emergency 压缩。
   * 调用即递增计数, 返回 true 表示这一次允许执行压缩。
   * 上限 3 次后返回 false (避免无限压缩循环)。
   */
  tryRecoveryCompact(): boolean {
    if (this.recoveryCompactAttempts >= this.recoveryCompactLimit) {
      return false;
    }
    this.recoveryCompactAttempts++;
    return true;
  }

  /** 诊断: 当前已用的压缩次数 */
  getRecoveryCompactAttempts(): number {
    return this.recoveryCompactAttempts;
  }

  /**
   * 模型输出被 max_output_tokens 截断（finish_reason=length）。
   * 返回 { exhausted, attempt } — 调用者据此决定 continue 还是 break。
   *
   * 内部处理：
   * - 计算增量 delta，判断递减回报
   * - 连续 2 次递减 → 强制封死后续恢复
   * - 递增恢复计数
   * - 重置压缩许可（允许续跑中再次压缩）
   */
  onFinishLength(currentOutputLength: number): {
    exhausted: boolean;
    attempt: number;
    maxAttempts: number;
  } {
    if (this.maxOutputRecoveryCount > 0) {
      const delta = currentOutputLength - this.lastRecoveryOutputLength;
      if (delta < this.diminishingThreshold) {
        this.diminishingReturnStreak++;
      } else {
        this.diminishingReturnStreak = 0;
      }
      if (this.diminishingReturnStreak >= 2) {
        cliLogger.warn('RUNNER', `Diminishing returns detected (delta=${delta}, streak=${this.diminishingReturnStreak}), stopping recovery`);
        this.maxOutputRecoveryCount = this.maxRecoveryLimit;
        return {
          exhausted: true,
          attempt: this.maxOutputRecoveryCount,
          maxAttempts: this.maxRecoveryLimit,
        };
      }
    }
    this.lastRecoveryOutputLength = currentOutputLength;

    if (this.maxOutputRecoveryCount >= this.maxRecoveryLimit) {
      return {
        exhausted: true,
        attempt: this.maxOutputRecoveryCount,
        maxAttempts: this.maxRecoveryLimit,
      };
    }

    this.maxOutputRecoveryCount++;
    this.lastTransitionReason = 'max_output_recovery';
    return {
      exhausted: false,
      attempt: this.maxOutputRecoveryCount,
      maxAttempts: this.maxRecoveryLimit,
    };
  }

  /** 正常完成（finish_reason 非 length）→ 重置续跑计数 */
  onFinishNormal(): void {
    this.maxOutputRecoveryCount = 0;
  }

  /** 是否还能降级到备用模型（防止 fallback 循环） */
  canFallback(): boolean {
    return !this.lastTransitionReason?.includes('fallback');
  }

  /** 诊断快照，供 loopWasteSummary / runTrace dump 使用 */
  snapshot(): RecoverySnapshot {
    return {
      maxOutputRecoveryCount: this.maxOutputRecoveryCount,
      diminishingReturnStreak: this.diminishingReturnStreak,
      streamRetries: this.streamRetries,
      providerManagedRetryObserved: this.providerManagedRetryObserved,
      lastTransitionReason: this.lastTransitionReason,
      totalRetryAttempts: this.totalRetryAttempts,
      retryByCategory: Object.fromEntries(this.retryByCategory),
      rateLimitRetryAttempts: this.rateLimitRetryAttempts,
    };
  }
}

// ======================== ProgressTracker ========================

export class ProgressTracker {
  textOnlyStreakCount = 0;
  noToolContinueTotal = 0;
  structuredRetryCount = 0;
  lowProgressStreak = 0;
  completionEvidenceNudges = 0;

  private readonly maxNoToolContinue: number;
  private readonly maxStructuredRetry: number;

  constructor(opts?: {
    maxNoToolContinue?: number;
    maxStructuredRetry?: number;
  }) {
    this.maxNoToolContinue = opts?.maxNoToolContinue ?? 8;
    this.maxStructuredRetry = opts?.maxStructuredRetry ?? 5;
  }

  /** 工具分支走完 → 重置纯文本连击 */
  onToolBatch(): void {
    this.textOnlyStreakCount = 0;
  }

  /**
   * 消耗一次无工具续跑预算。
   * 返回 true = 预算耗尽，应该 break。
   */
  consumeNoToolBudget(context?: string): boolean {
    const exceeded = ++this.noToolContinueTotal > this.maxNoToolContinue;
    if (exceeded) {
      cliLogger.warn('RUNNER',
        `no-tool continue budget exhausted (${this.maxNoToolContinue}) at ${context ?? 'unknown'} — forcing finalize`);
    }
    return exceeded;
  }

  /**
   * Consume one structured-output retry budget without changing the general
   * no-tool continuation counter.
   * 触顶上限即返回 true。
   */
  consumeStructuredRetryBudget(): boolean {
    this.structuredRetryCount++;
    if (this.structuredRetryCount > this.maxStructuredRetry) {
      cliLogger.warn('RUNNER',
        `structured-output retry budget exhausted (retry=${this.structuredRetryCount}/${this.maxStructuredRetry})`);
      return true;
    }
    return false;
  }

  /** 更新进度门结果 */
  applyProgressGate(result: { lowProgressStreak: number; completionEvidenceNudges: number }): void {
    this.lowProgressStreak = result.lowProgressStreak;
    this.completionEvidenceNudges = result.completionEvidenceNudges;
  }

  /** 进度门禁用时重置 */
  resetProgressGate(): void {
    this.lowProgressStreak = 0;
  }

  /** 诊断快照 */
  snapshot(): ProgressSnapshot {
    return {
      textOnlyStreakCount: this.textOnlyStreakCount,
      noToolContinueTotal: this.noToolContinueTotal,
      structuredRetryCount: this.structuredRetryCount,
      lowProgressStreak: this.lowProgressStreak,
      completionEvidenceNudges: this.completionEvidenceNudges,
    };
  }
}

// ======================== RunAccumulator ========================

export class RunAccumulator {
  iteration = 0;
  totalToolCalls = 0;
  finalOutput = '';
  encounteredError = false;
  stopReason: StopReason | null = null;
  planAutoFollowups = 0;

  readonly finalUsageStats = {
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
  };

  /** 重试/恢复时不消耗迭代次数 */
  undoIteration(): void {
    this.iteration = Math.max(0, this.iteration - 1);
  }

  /** 错误终止：设停止原因 + 标记出错 */
  terminate(reason: StopReason): void {
    this.stopReason = reason;
    this.encounteredError = true;
  }

  /** 累加工具调用数 */
  addToolCalls(count: number): void {
    this.totalToolCalls += count;
  }

  /** 累加 token 用量 */
  addUsage(usage: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number }): void {
    if (usage.total_tokens) this.finalUsageStats.totalTokens = usage.total_tokens;
    if (usage.prompt_tokens) this.finalUsageStats.promptTokens = usage.prompt_tokens;
    if (usage.completion_tokens) this.finalUsageStats.completionTokens = usage.completion_tokens;
  }
}
