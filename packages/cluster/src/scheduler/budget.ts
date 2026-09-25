/**
 * 全局并发预算 —— 跨层统一收口。
 *
 * 【为什么必须有这个】
 *   集群节点是**完整 neox**, 它自己还能再派子 agent。所以并发是**乘起来**的:
 *
 *       你以为:  3 个节点            = 3 并发
 *       实际上:  3 节点 × 各 3 子agent = 12 并发
 *
 *   而 core 现在是每层各管各的两个独立常数:
 *       MAX_CONCURRENT_BACKGROUND_AGENTS = 3   (写入型子 agent)
 *       MAX_PARALLEL_EXPLORES            = 2   (explore)
 *   集群化之后会变成**三层各管各的**, 谁也不知道总数是多少 —— 必然失控。
 *
 *   实践参考: arXiv 2606.19135 —— 2026 年实践中的团队规模就是 3-4 个 agent,
 *   再往上协调开销涨得比收益快。我们自己的数据也一致: hrbench k=4 的集成修复
 *   (25.5min) 比并行段 (19.4min) 还长, 是负收益。
 *
 * 这个类只做**记账和放行**, 不做任何 LLM 判断 —— 确定性。
 */

export interface BudgetOptions {
  /** 全局并发上限 (节点 + 它们的子 agent 全算在内) */
  maxConcurrent: number;
  /** 输出 token 熔断; 0 = 关 */
  maxOutputTokens?: number;
  /** 墙钟上限 (ms); 0 = 无限 —— 长任务不该被时长判死 */
  wallClockMs?: number;
}

export class ClusterBudgetTracker {
  private readonly max: number;
  private readonly maxTokens: number;
  private readonly wallMs: number;
  private readonly startedAt = Date.now();

  /** 当前占用: key = 占用者 id (节点 id 或 "节点id/子agent序号") */
  private readonly inFlight = new Set<string>();
  private outputTokens = 0;

  constructor(opts: BudgetOptions) {
    this.max = Math.max(1, opts.maxConcurrent);
    this.maxTokens = Math.max(0, opts.maxOutputTokens ?? 0);
    this.wallMs = Math.max(0, opts.wallClockMs ?? 0);
  }

  get used(): number { return this.inFlight.size; }
  get free(): number { return Math.max(0, this.max - this.inFlight.size); }
  get tokens(): number { return this.outputTokens; }
  get elapsedMs(): number { return Date.now() - this.startedAt; }

  /** 尝试占一个额度; 占不到返回 false (调用方等位, 不抛错) */
  tryAcquire(holder: string): boolean {
    if (this.inFlight.has(holder)) return true;         // 幂等
    if (this.inFlight.size >= this.max) return false;
    this.inFlight.add(holder);
    return true;
  }

  release(holder: string): void {
    this.inFlight.delete(holder);
  }

  addOutputTokens(n: number): void {
    if (Number.isFinite(n) && n > 0) this.outputTokens += n;
  }

  /**
   * 该不该停。**只按"跑飞"和"墙钟上限"判, 不按迭代次数判** ——
   * 迭代计数是按"跑了多久"判死, 跟"还在不在干活"无关, 大任务撞上限是常态。
   * (同 core 侧长任务预算的口径)
   */
  exhausted(): { stop: boolean; reason?: string } {
    if (this.maxTokens > 0 && this.outputTokens >= this.maxTokens) {
      return { stop: true, reason: `输出 token 熔断 (${this.outputTokens} ≥ ${this.maxTokens})` };
    }
    if (this.wallMs > 0 && this.elapsedMs >= this.wallMs) {
      return { stop: true, reason: `墙钟预算耗尽 (${Math.round(this.elapsedMs / 1000)}s)` };
    }
    return { stop: false };
  }

  snapshot(): { used: number; max: number; tokens: number; elapsedMs: number; holders: string[] } {
    return {
      used: this.inFlight.size,
      max: this.max,
      tokens: this.outputTokens,
      elapsedMs: this.elapsedMs,
      holders: [...this.inFlight],
    };
  }
}
