/** 累计 usage 快照在请求边界结算一次，并覆盖迭代、循环收尾和 finally 边界。 */
import { describe, expect, it } from 'vitest';

type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };

/** 复刻 agentRuntimeHost 的推迟结算契约: 只留最后一张快照, 到请求边界才结算一次。 */
function makeSettler() {
  const settled: Usage[] = [];
  let pending: Usage | null = null;
  return {
    settled,
    /** 收到一条 token_usage —— 只暂存, 不结算 */
    onUsage(u: Usage) { pending = u; },
    /** 请求边界 —— 结算并清空 (幂等: 空的时候是 no-op) */
    settle() {
      if (!pending) return;
      settled.push(pending);
      pending = null;
    },
  };
}

/** 一次请求的流: 累计快照, output 递增, input 恒定 —— DeepSeek 的真实形状。 */
function streamOneRequest(s: ReturnType<typeof makeSettler>, input: number, chunks: number) {
  for (let out = 1; out <= chunks; out++) {
    s.onUsage({ prompt_tokens: input, completion_tokens: out, total_tokens: input + out });
  }
}

describe('一次请求只结算一次', () => {
  it('150 条累计快照 → 只结算 1 次, 且取的是最后一张 (不是求和)', () => {
    const s = makeSettler();
    streamOneRequest(s, 43141, 150);
    s.settle(); // 请求边界

    expect(s.settled).toHaveLength(1);
    expect(s.settled[0]).toEqual({ prompt_tokens: 43141, completion_tokens: 150, total_tokens: 43291 });
    /* 累计快照不能按 chunk 重复求和。 */
    const oldBehaviour = 43141 * 150;
    expect(s.settled[0].prompt_tokens).toBeLessThan(oldBehaviour);
  });

  it('三次请求 → 结算 3 次, 每次都是各自的最后一张', () => {
    const s = makeSettler();
    streamOneRequest(s, 1000, 5);
    s.settle();                    // ① iteration_start
    streamOneRequest(s, 2000, 3);
    s.settle();                    // ① iteration_start
    streamOneRequest(s, 3000, 9);
    s.settle();                    // ② 循环收尾

    expect(s.settled.map((u) => [u.prompt_tokens, u.completion_tokens]))
      .toEqual([[1000, 5], [2000, 3], [3000, 9]]);
  });
});

describe('⚠️ 边界一个都不能塌 (漏结算 = 用量少记, 无声)', () => {
  it('② 收尾边界: 最后一次请求后面没有 iteration_start, 靠循环收尾那一次结算', () => {
    const s = makeSettler();
    streamOneRequest(s, 500, 4);
    s.settle();                    // 第一次请求, 由下一轮 iteration_start 触发
    streamOneRequest(s, 600, 7);
    // 没有下一个 iteration_start 了
    expect(s.settled).toHaveLength(1);   // 此刻最后一次请求还没结算

    s.settle();                    // ② 循环收尾
    expect(s.settled).toHaveLength(2);
    expect(s.settled[1].prompt_tokens).toBe(600);
  });

  it('③ 异常兜底: 循环里抛出来时 finally 仍结算掉最后一张', () => {
    const s = makeSettler();
    streamOneRequest(s, 800, 12);
    try {
      throw new Error('stream aborted');
    } catch {
      /* 收尾那一句够不着 —— finally 兜底 */
    } finally {
      s.settle();
    }
    expect(s.settled).toHaveLength(1);
    expect(s.settled[0].completion_tokens).toBe(12);
  });

  it('结算是幂等的 —— 收尾和 finally 都调一次也不会记两遍', () => {
    const s = makeSettler();
    streamOneRequest(s, 900, 3);
    s.settle();
    s.settle();  // finally 兜底再来一次
    expect(s.settled).toHaveLength(1);
  });

  it('一条 usage 都没有的请求不结算空账 (provider 全程不回 usage 时走估算兜底)', () => {
    const s = makeSettler();
    s.settle();
    s.settle();
    expect(s.settled).toHaveLength(0);
  });
});
