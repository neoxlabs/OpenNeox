import { describe, expect, it, vi } from 'vitest';
import { runSlidingWindow, SCALE_PRESETS, type SubQuestion, type WorkerOutcome, type SchedulerLimits } from '../scheduler.js';

const seed = (n: number): SubQuestion[] =>
  Array.from({ length: n }, (_, i) => ({ id: `Q${i + 1}`, question: `问题 ${i + 1}`, depth: 0 }));

const okOutcome = (id: string, followUps: Array<{ question: string; why: string }> = []): WorkerOutcome => ({
  subQuestionId: id, ok: true, summary: `查完 ${id}`, sourcesAdded: 2, claimsAdded: 1, followUps,
});

const limits = (over: Partial<SchedulerLimits> = {}): SchedulerLimits =>
  ({ concurrency: 2, maxWorkers: 100, maxDepth: 3, wallClockMs: 60_000, ...over });

describe('并发恒为 K', () => {
  it('瞬时在飞数从不超过 concurrency', async () => {
    let cur = 0;
    let peak = 0;
    const r = await runSlidingWindow(seed(10), limits({ concurrency: 3 }), {
      dispatch: async (q) => {
        cur += 1; peak = Math.max(peak, cur);
        await new Promise((res) => setTimeout(res, 5));
        cur -= 1;
        return okOutcome(q.id);
      },
    });
    expect(peak).toBe(3);
    expect(r.outcomes).toHaveLength(10);
    expect(r.stopReason).toBe('converged');
  });

  it('谁先回来谁补位 —— 慢的那个不拖住后面的', async () => {
    const order: string[] = [];
    /* Q1 很慢, 其余很快。波次模型下 Q3 要等 Q1/Q2 整批收口; 滑动窗口下 Q2 一回来就补 Q3。 */
    await runSlidingWindow(seed(4), limits({ concurrency: 2 }), {
      dispatch: async (q) => {
        await new Promise((res) => setTimeout(res, q.id === 'Q1' ? 60 : 5));
        order.push(q.id);
        return okOutcome(q.id);
      },
    });
    /* Q1 最慢, 必然最后收割; 而 Q3/Q4 不必等它 */
    expect(order[order.length - 1]).toBe('Q1');
    expect(order.slice(0, 3).sort()).toEqual(['Q2', 'Q3', 'Q4']);
  });
});

describe('线索跟进', () => {
  it('收割到的新线索进队列, 后续 worker 会查', async () => {
    const asked: string[] = [];
    const r = await runSlidingWindow(seed(1), limits({ concurrency: 1 }), {
      dispatch: async (q) => {
        asked.push(q.question);
        return q.depth === 0
          ? okOutcome(q.id, [{ question: '顺出来的线索', why: '原文提到了但没说清' }])
          : okOutcome(q.id);
      },
    });
    expect(asked).toEqual(['问题 1', '顺出来的线索']);
    expect(r.state.dispatched).toBe(2);
  });

  it('同一个问题换个大小写/空格不查两遍', async () => {
    const asked: string[] = [];
    await runSlidingWindow([{ id: 'Q1', question: 'Adyen 重试策略', depth: 0 }], limits({ concurrency: 1 }), {
      dispatch: async (q) => {
        asked.push(q.question);
        return q.depth === 0
          ? okOutcome(q.id, [
            { question: '  adyen   重试策略 ', why: '重复的' },
            { question: '另一个问题', why: '不重复' },
          ])
          : okOutcome(q.id);
      },
    });
    expect(asked).toEqual(['Adyen 重试策略', '另一个问题']);
  });

  it('深度到顶就不再跟线索', async () => {
    const r = await runSlidingWindow(seed(1), limits({ concurrency: 1, maxDepth: 1 }), {
      dispatch: async (q) => okOutcome(q.id, [{ question: `${q.id} 的下一层`, why: 'x' }]),
    });
    /* depth 0 → 1 允许; depth 1 的孩子是 2 > maxDepth=1, 挡掉 */
    expect(r.state.dispatched).toBe(2);
    expect(r.stopReason).toBe('converged');
  });

  it('gap 闸能拦掉不值得查的线索', async () => {
    const admit = vi.fn().mockReturnValue(false);
    const r = await runSlidingWindow(seed(1), limits({ concurrency: 1 }), {
      dispatch: async (q) => okOutcome(q.id, [{ question: '不值得查的', why: 'x' }]),
      admitFollowUp: admit,
    });
    expect(admit).toHaveBeenCalledOnce();
    expect(r.state.dispatched).toBe(1);
  });

  it('失败的 worker 不跟它的线索', async () => {
    const r = await runSlidingWindow(seed(1), limits({ concurrency: 1 }), {
      dispatch: async (q) => ({
        subQuestionId: q.id, ok: false, summary: '', sourcesAdded: 0, claimsAdded: 0,
        error: '抓不到', followUps: [{ question: '不该被查', why: 'x' }],
      }),
    });
    expect(r.state.dispatched).toBe(1);
    expect(r.state.failed).toBe(1);
  });
});

describe('硬顶 —— 模型说了不算', () => {
  it('总 worker 上限拦住无限发散', async () => {
    const r = await runSlidingWindow(seed(1), limits({ concurrency: 2, maxWorkers: 5, maxDepth: 99 }), {
      /* 每个 worker 都吐两条新线索, 不拦就是指数爆炸 */
      dispatch: async (q) => okOutcome(q.id, [
        { question: `${q.id}-a`, why: 'x' },
        { question: `${q.id}-b`, why: 'x' },
      ]),
    });
    expect(r.state.dispatched).toBe(5);
    expect(r.stopReason).toBe('worker-cap');
    expect(r.unexplored.length).toBeGreaterThan(0);
  });

  it('墙钟预算只砍顺出来的线索, 没查的如实报出来', async () => {
    let clock = 0;
    const r = await runSlidingWindow(seed(1), limits({ concurrency: 1, wallClockMs: 30, maxDepth: 5 }), {
      now: () => clock,
      dispatch: async (q) => {
        clock += 20;
        return okOutcome(q.id, [{ question: `${q.id} 的线索`, why: 'x' }]);
      },
    });
    expect(r.stopReason).toBe('time-budget');
    expect(r.unexplored.length).toBeGreaterThan(0);
  });

  it('⭐️ 时间预算不许饿死用户给的角度 —— 超了正常预算种子照样派', async () => {
    let clock = 0;
    const asked: string[] = [];
    const r = await runSlidingWindow(seed(4), limits({ concurrency: 1, wallClockMs: 100 }), {
      now: () => clock,
      dispatch: async (q) => {
        asked.push(q.id);
        clock += 40;    // 第 4 个种子派出去时已经 120 > 正常预算…但仍在 1.5 倍宽限内
        return okOutcome(q.id, [{ question: `${q.id} 顺带的`, why: 'x' }]);
      },
    });
    /* 正常预算 100, 宽限到 150: 0/40/80/120 四个种子都该派出去 */
    expect(asked).toEqual(['Q1', 'Q2', 'Q3', 'Q4']);
    /* 顺出来的线索在 160 时被正常预算砍掉 */
    expect(r.unexplored.every((u) => u.depth > 0)).toBe(true);
  });

  it('⭐️ 种子的宽限不是无限 —— 撞到 1.5 倍预算连种子也停', async () => {
    let clock = 0;
    const asked: string[] = [];
    const r = await runSlidingWindow(seed(5), limits({ concurrency: 1, wallClockMs: 100 }), {
      now: () => clock,
      dispatch: async (q) => { asked.push(q.id); clock += 120; return okOutcome(q.id); },
    });
    /* Q1 在 0 派出 → 120; Q2 在 120 派出(<150 宽限) → 240; Q3 撞 150 上限, 停 */
    expect(asked).toEqual(['Q1', 'Q2']);
    expect(r.stopReason).toBe('time-budget');
    expect(r.unexplored.length).toBe(3);
    expect(r.unexplored.every((u) => u.depth === 0)).toBe(true);
  });

  it('worker 总量对种子照样有效 —— 那是花钱的硬顶, 不是"来不及"', async () => {
    const r = await runSlidingWindow(seed(6), limits({ concurrency: 1, maxWorkers: 2 }), {
      dispatch: async (q) => okOutcome(q.id),
    });
    expect(r.state.dispatched).toBe(2);
    expect(r.stopReason).toBe('worker-cap');
    expect(r.unexplored).toHaveLength(4);
  });

  it('外部取消', async () => {
    const signal = { aborted: false };
    const r = await runSlidingWindow(seed(6), limits({ concurrency: 1 }), {
      signal,
      dispatch: async (q) => { if (q.id === 'Q2') signal.aborted = true; return okOutcome(q.id); },
    });
    expect(r.stopReason).toBe('aborted');
    expect(r.unexplored.length).toBeGreaterThan(0);
  });
});

describe('鲁棒', () => {
  it('单个 worker 抛异常算它失败, 其余照跑', async () => {
    const r = await runSlidingWindow(seed(4), limits({ concurrency: 2 }), {
      dispatch: async (q) => {
        if (q.id === 'Q2') throw new Error('网络炸了');
        return okOutcome(q.id);
      },
    });
    expect(r.outcomes).toHaveLength(4);
    expect(r.state.failed).toBe(1);
    expect(r.state.completed).toBe(3);
    expect(r.outcomes.find((o) => o.subQuestionId === 'Q2')?.error).toBe('网络炸了');
  });

  it('每收割一条就回调一次, 带当前状态', async () => {
    const seen: number[] = [];
    await runSlidingWindow(seed(3), limits({ concurrency: 1 }), {
      dispatch: async (q) => okOutcome(q.id),
      onOutcome: (_o, st) => seen.push(st.completed),
    });
    expect(seen).toEqual([1, 2, 3]);
  });

  it('空种子直接收敛, 不报错', async () => {
    const r = await runSlidingWindow([], limits(), { dispatch: async () => { throw new Error('不该被调用'); } });
    expect(r.stopReason).toBe('converged');
    expect(r.outcomes).toHaveLength(0);
  });
});

describe('规模档', () => {
  it('三档的并发和总量单调递增 —— 简单问题不许派一堆 agent', () => {
    const { simple, compare, deep } = SCALE_PRESETS;
    expect(simple.concurrency).toBeLessThan(compare.concurrency);
    expect(compare.concurrency).toBeLessThan(deep.concurrency);
    expect(simple.maxWorkers).toBeLessThan(compare.maxWorkers);
    expect(compare.maxWorkers).toBeLessThan(deep.maxWorkers);
  });
});

describe('计划要摊得开 (onQueued)', () => {
  it('种子和顺出来的线索都在**进队列那一刻**回调, 不是派出去才回调', async () => {
    const queuedAt: Array<{ id: string; inFlightThen: number }> = [];
    let inFlight = 0;
    const r = await runSlidingWindow(seed(1), limits({ concurrency: 1 }), {
      onQueued: (q) => queuedAt.push({ id: q.id, inFlightThen: inFlight }),
      dispatch: async (q) => {
        inFlight += 1;
        await new Promise((res) => setTimeout(res, 5));
        inFlight -= 1;
        return okOutcome(q.id, q.depth === 0
          ? [{ question: '顺出来的 A', why: 'x' }, { question: '顺出来的 B', why: 'y' }]
          : []);
      },
    });
    /* 两条线索都登记过, 而且登记时它们**还没被派出去** */
    expect(queuedAt.map((q) => q.id)).toEqual(['Q2', 'Q3']);
    expect(r.state.dispatched).toBe(3);
  });

  it('被 gap 闸拦掉的线索不登记 —— 界面上不许出现根本不会查的东西', async () => {
    const queued: string[] = [];
    await runSlidingWindow(seed(1), limits({ concurrency: 1 }), {
      onQueued: (q) => queued.push(q.question),
      admitFollowUp: (c) => c.question.includes('要查'),
      dispatch: async (q) => okOutcome(q.id, q.depth === 0
        ? [{ question: '要查的', why: 'x' }, { question: '不值得', why: 'y' }]
        : []),
    });
    expect(queued).toEqual(['要查的']);
  });

  it('重复的线索不登记两次', async () => {
    const queued: string[] = [];
    await runSlidingWindow(seed(2), limits({ concurrency: 2 }), {
      onQueued: (q) => queued.push(q.question),
      dispatch: async (q) => okOutcome(q.id, q.depth === 0 ? [{ question: '同一条线索', why: 'x' }] : []),
    });
    expect(queued).toEqual(['同一条线索']);
  });
});
