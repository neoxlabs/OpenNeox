/**
 * 压缩落点 — 行为契约
 *
 * 压缩后的目标按统一 token 预算计算, 不随模型窗口比例漂移，
 * 让相同历史在不同窗口下都遵守调用方提供的明确落点。
 */
import { describe, it, expect } from 'vitest';
import {
  resolveTokenScale,
  resolveCompactionPlan,
  SUMMARY_OUTPUT_CAP_TOKENS,
  REINJECT_BUDGET_TOKENS,
  TAIL_PROTECT_TOKENS,
  FALLBACK_FIXED_OVERHEAD,
} from '../autoCompactGuard.js';

describe('压缩落点', () => {
  /* 固定请求开销独立计入总量预算。 */
  const scale = () => resolveTokenScale(100_000, 40_000, 17_000);

  it('落点与窗口无关 — 1M / 372K / 200K / 128K 压完剩一样多', () => {
    const targets = [1_000_000, 372_000, 272_000, 200_000, 128_000].map(
      cw => resolveCompactionPlan({ contextWindow: cw, maxInputTokens: Math.floor(cw * 0.7), scale: scale() }).targetTotal,
    );
    expect(new Set(targets).size).toBe(1);
    // 17K 前缀 + 6K 摘要 + 8K 回灌 + 8K 尾部保护
    expect(targets[0]).toBe(17_000 + SUMMARY_OUTPUT_CAP_TOKENS + REINJECT_BUDGET_TOKENS + TAIL_PROTECT_TOKENS);
    expect(targets[0]).toBeLessThan(40_000);
  });

  it('触发线仍随窗口走 — 什么时候压 和 压到哪 是两件事', () => {
    const big = resolveCompactionPlan({ contextWindow: 1_000_000, scale: scale() });
    const small = resolveCompactionPlan({ contextWindow: 200_000, scale: scale() });
    expect(big.triggerLine).toBeGreaterThan(small.triggerLine);
    expect(big.targetTotal).toBe(small.targetTotal);
    // 轻量线永远早于触发线 —— 包括用户把触发比例调到很低时
    expect(big.lightLine).toBeLessThan(big.triggerLine);
    const lowThreshold = resolveCompactionPlan({ contextWindow: 1_000_000, overrideRatio: 0.15, scale: scale() });
    expect(lowThreshold.lightLine).toBeLessThan(lowThreshold.triggerLine);
  });

  it('前缀实测优先, 没样本才用兜底 — "18K 不许写死"', () => {
    const measured = resolveCompactionPlan({ contextWindow: 200_000, scale: resolveTokenScale(100_000, 40_000, 23_500) });
    const fallback = resolveCompactionPlan({ contextWindow: 200_000, scale: resolveTokenScale(0, 0) });
    expect(measured.targetTotal).toBe(23_500 + 22_000);
    expect(fallback.targetTotal).toBe(FALLBACK_FIXED_OVERHEAD + 22_000);
    /* 前缀变大(装了更多工具/改了 system) → 落点自动跟着变, 不需要改代码 */
    expect(measured.targetTotal).toBeGreaterThan(fallback.targetTotal);
  });

  it('raw↔real 换算可逆, 且 real 永远 ≥ raw (前缀 + 低估修正)', () => {
    const s = scale();
    expect(s.fixedOverhead).toBe(17_000);
    expect(s.errorFactor).toBeGreaterThanOrEqual(1);
    const raw = 30_000;
    const real = s.toReal(raw);
    expect(real).toBeGreaterThan(raw);
    expect(s.toRaw(real)).toBeCloseTo(raw, -2);
  });

  it('传给摘要器的预算是 raw 口径, 且不含前缀', () => {
    const plan = resolveCompactionPlan({ contextWindow: 1_000_000, scale: scale() });
    /* targetMessagesRaw 必须显著小于 targetTotal —— 前缀不是摘要器能压的东西 */
    expect(plan.targetMessagesRaw).toBeLessThan(plan.targetTotal - 17_000 + 1);
    expect(plan.targetMessagesRaw).toBeGreaterThan(1_000);
  });
});
