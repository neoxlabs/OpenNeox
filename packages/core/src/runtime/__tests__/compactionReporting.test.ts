import { describe, it, expect } from 'vitest';
import { estimatePostCompactContext } from '../agentRuntimeHostHelpers.js';

/** host 的报数规则 (agentRuntimeHost 的 LLM 分支): 回退就报原值, 否则不许超过原值. */
function reportedFinal(opts: {
  savedTokens: number;
  postCompactTokens: number;
  realBefore: number;
}): number {
  const rolledBack = opts.savedTokens <= 0;
  return rolledBack ? opts.realBefore : Math.min(opts.postCompactTokens, opts.realBefore);
}

describe('校准系数会放大估算的波动 (这就是 +6K 的来路)', () => {
  it('估算只涨一点, 换算出来能涨好几倍', () => {
    /* 真实形状: 实报 100K, 而估算只有 20K (估算对代码/中文低估 39~43%),
     * 固定底座 24K → 系数 (100-24)/20 = 3.8 */
    const before = estimatePostCompactContext({
      postEstimate: 20_000,
      preEstimate: 20_000,
      realBefore: 100_000,
      additiveOverhead: 0,
      fixedBase: 24_000,
    });
    const afterGrewALittle = estimatePostCompactContext({
      postEstimate: 22_000, // 估算只涨了 2K
      preEstimate: 20_000,
      realBefore: 100_000,
      additiveOverhead: 0,
      fixedBase: 24_000,
    });
    expect(before).toBe(100_000);
    /* 2K 的估算增量被放大成 ~7.6K —— 卡片上就是 100K → 107K */
    expect(afterGrewALittle - before).toBeGreaterThan(6_000);
  });

  it('系数上限是 4 —— 再离谱的估算偏差也不会无限放大', () => {
    const v = estimatePostCompactContext({
      postEstimate: 10_000,
      preEstimate: 1_000,     // 估算离谱地小
      realBefore: 500_000,
      additiveOverhead: 0,
      fixedBase: 0,
    });
    expect(v).toBe(40_000); // 10_000 × 4, 不是 × 500
  });
});

describe('报出去的数不许自相矛盾', () => {
  it('压缩器回退时报原值, 不编一个更大的数', () => {
    const v = reportedFinal({ savedTokens: 0, postCompactTokens: 106_000, realBefore: 100_000 });
    expect(v).toBe(100_000);
  });

  it('真省了也不许报得比压前大 (换算放大的那部分被夹住)', () => {
    const v = reportedFinal({ savedTokens: 30_000, postCompactTokens: 107_600, realBefore: 100_000 });
    expect(v).toBe(100_000);
    expect(v).toBeLessThanOrEqual(100_000);
  });

  it('正常情况原样报', () => {
    const v = reportedFinal({ savedTokens: 40_000, postCompactTokens: 62_000, realBefore: 100_000 });
    expect(v).toBe(62_000);
  });
});
