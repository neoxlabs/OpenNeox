import { describe, expect, it } from 'vitest';

/** 复刻 useStreamHandler 的累加 + closeSlot 的换算。真实实现改了这里要一起改。 */
function accumulate(reqs: Array<{ outTok: number; genMs: number | undefined }>) {
  let genTokens = 0;
  let genMs = 0;
  for (const r of reqs) {
    const ms = Number(r.genMs) || 0;
    /* 没有生成窗口的请求 (纯工具回合 / 打点缺失) 两边都不计 —— 只加分母会把速度做低 */
    genTokens += ms > 0 ? r.outTok : 0;
    genMs += ms;
  }
  return { genTokens, genMs };
}

function toTps(snap: { genTokens: number; genMs: number }): number | undefined {
  return (snap.genMs > 300 && snap.genTokens > 0)
    ? Math.round((snap.genTokens / snap.genMs) * 1000 * 10) / 10
    : undefined;
}

const tps = (reqs: Array<{ outTok: number; genMs: number | undefined }>) => toTps(accumulate(reqs));

describe('总量相除, 不是求平均', () => {
  it('单次请求: 500 tok / 10s = 50 tok/s', () => {
    expect(tps([{ outTok: 500, genMs: 10_000 }])).toBe(50);
  });

  it('⚠️ 多次请求按总量算 —— 短请求不该把结果带偏', () => {
    /* 总 2003 tok / 20.1s ≈ 99.7。若按"各自 tok/s 平均"= (100 + 30)/2 = 65, 差得远。 */
    const r = tps([
      { outTok: 2000, genMs: 20_000 },   // 100 tok/s
      { outTok: 3, genMs: 100 },         // 30 tok/s, 但只有 3 个 token
    ]);
    expect(r).toBeCloseTo(99.7, 1);
    expect(r).not.toBe(65);
  });
});

describe('⚠️ 没有生成窗口的请求两边都不计', () => {
  it('纯工具回合 (genMs undefined) 不进分母, 否则速度被做低', () => {
    const withTool = tps([
      { outTok: 500, genMs: 10_000 },
      { outTok: 20, genMs: undefined },  // 工具回合: 有 output 但没吐字窗口
    ]);
    expect(withTool).toBe(50);          // 跟只有第一次请求时一样
  });

  it('genMs 为 0 同样跳过', () => {
    expect(tps([{ outTok: 500, genMs: 10_000 }, { outTok: 9, genMs: 0 }])).toBe(50);
  });
});

describe('拿不准就不显示 —— 宁可没有, 不要一个吓人的数', () => {
  it('生成窗口不足 300ms 不给数 (一两个 token 的瞬时值没意义)', () => {
    expect(tps([{ outTok: 2, genMs: 100 }])).toBeUndefined();
  });

  it('一个 token 都没生成时不给数', () => {
    expect(tps([{ outTok: 0, genMs: 5_000 }])).toBeUndefined();
  });

  it('完全没有请求 (纯工具轮) 不给数', () => {
    expect(tps([])).toBeUndefined();
    expect(tps([{ outTok: 30, genMs: undefined }])).toBeUndefined();
  });
});

describe('取值形状', () => {
  it('保留一位小数, 便于并排比较不同模型', () => {
    expect(tps([{ outTok: 1000, genMs: 3_000 }])).toBe(333.3);
  });
});
