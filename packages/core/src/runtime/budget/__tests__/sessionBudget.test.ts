import { describe, it, expect, beforeEach } from 'vitest';
import {
  __resetBudgetsForTest, setSessionBudget, recordBudgetUsage, getBudgetSnapshot, onBudgetEvent,
  linkChildSession, advisorRouteFor, getBudgetPromptSection, priceOf, costOf, isBudgetExceeded,
  isConductorMain, workerRouteFor,
  type BudgetEvent,
} from '../sessionBudget.js';

const ADV = { providerId: 'neox-cloud-payg', modelName: 'gpt-6.1-sol' };

describe('会话预算', () => {
  beforeEach(() => __resetBudgetsForTest());

  it('按官方价记账: 缓存命中按 10% 输入价', () => {
    /* flash: 输入 $0.3 / 输出 $1.2 每百万; 100 万输入里 80 万命中缓存 */
    const usd = costOf({ inputTokens: 1_000_000, cachedTokens: 800_000, outputTokens: 100_000 }, priceOf('deepseek-v4.1-flash')!);
    expect(usd).toBeCloseTo(0.2 * 0.3 + 0.8 * 0.03 + 0.1 * 1.2, 6);
  });

  it('带日期后缀的模型名按最长前缀找价', () => {
    expect(priceOf('claude-haiku-4-5-20251001')).toEqual({ input: 1, output: 5 });
    expect(priceOf('totally-unknown')).toBeNull();
  });

  it('没设预算的会话不记账', () => {
    expect(recordBudgetUsage('s1', { model: 'gpt-6.1-sol', inputTokens: 1000, outputTokens: 10, source: 'main' })).toBeNull();
  });

  it('子 agent 的花费记到根会话, 分模型列出, 并给出「全程用规划模型」的对照价', () => {
    setSessionBudget('root', { limitUsd: 2, advisor: ADV });
    linkChildSession('child', 'root');
    recordBudgetUsage('root', { model: 'deepseek-v4.1-flash', inputTokens: 1_000_000, outputTokens: 50_000, source: 'main' });
    recordBudgetUsage('child', { model: 'gpt-6.1-sol', inputTokens: 20_000, outputTokens: 2_000, source: 'sub' });
    const s = getBudgetSnapshot('child')!;
    expect(s.sessionId).toBe('root');
    expect(Object.keys(s.byModel).sort()).toEqual(['deepseek-v4.1-flash', 'gpt-6.1-sol']);
    expect(s.spentUsd).toBeCloseTo(0.3 + 0.06 + 0.04 + 0.02, 6);
    /* 同样的 token 全按 gpt-6.1 ($2/$10) 算 */
    expect(s.allAdvisorUsd).toBeCloseTo((1_020_000 * 2 + 52_000 * 10) / 1e6, 6);
  });

  it('跨 50% / 80% 各提醒一次, 到线发一次 exceeded', () => {
    const events: BudgetEvent[] = [];
    onBudgetEvent((_, e) => { if (e.type !== 'budget_update') events.push(e); });
    setSessionBudget('s', { limitUsd: 1 });
    const step = { model: 'gpt-6.1-sol', inputTokens: 0, outputTokens: 30_000, source: 'main' as const }; // $0.30 一发
    recordBudgetUsage('s', step); // 0.3
    recordBudgetUsage('s', step); // 0.6 → 50%
    recordBudgetUsage('s', step); // 0.9 → 80%
    recordBudgetUsage('s', step); // 1.2 → exceeded
    recordBudgetUsage('s', step); // 不重复
    expect(events.map((e) => e.type === 'budget_threshold' ? `t${e.threshold}` : e.type)).toEqual(['t0.5', 't0.8', 'budget_exceeded']);
    expect(isBudgetExceeded('s')).toBe(true);
  });

  it('调高预算不清账, 允许再提醒', () => {
    setSessionBudget('s', { limitUsd: 0.5 });
    recordBudgetUsage('s', { model: 'gpt-6.1-sol', inputTokens: 0, outputTokens: 60_000, source: 'main' }); // $0.6
    expect(isBudgetExceeded('s')).toBe(true);
    setSessionBudget('s', { limitUsd: 2 });
    const s = getBudgetSnapshot('s')!;
    expect(s.spentUsd).toBeCloseTo(0.6, 6);
    expect(s.exceeded).toBe(false);
  });

  it('limit=0 只记账不熔断', () => {
    setSessionBudget('s', { limitUsd: 0 });
    recordBudgetUsage('s', { model: 'claude-opus-5-5', inputTokens: 0, outputTokens: 1_000_000, source: 'main' });
    expect(isBudgetExceeded('s')).toBe(false);
  });

  it('只有 plan / verify 走规划模型', () => {
    setSessionBudget('s', { limitUsd: 1, advisor: ADV });
    expect(advisorRouteFor('s', 'plan')).toEqual(ADV);
    expect(advisorRouteFor('s', 'verify')).toEqual(ADV);
    expect(advisorRouteFor('s', 'code')).toBeNull();
    expect(advisorRouteFor('other', 'plan')).toBeNull();
  });

  it('提示段只带取整后的进度 —— 小额花费不改字 (不打掉缓存)', () => {
    setSessionBudget('s', { limitUsd: 1, advisor: ADV });
    const a = getBudgetPromptSection('s');
    recordBudgetUsage('s', { model: 'deepseek-v4.1-flash', inputTokens: 10_000, outputTokens: 100, source: 'main' });
    expect(getBudgetPromptSection('s')).toBe(a);
    expect(a).toContain('gpt-6.1-sol');
    expect(a).toContain('$1.00');
    expect(getBudgetPromptSection('nobody')).toBe('');
  });

  it('指挥模式: 只有主循环算指挥, 子 agent 是干活的; 提示段换成指挥规则', () => {
    const W = { providerId: 'neox-cloud-payg', modelName: 'deepseek-v4.1-flash' };
    setSessionBudget('boss', { limitUsd: 0, worker: W });
    linkChildSession('agent_a_1', 'boss');
    expect(isConductorMain('boss')).toBe(true);
    expect(isConductorMain('agent_a_1')).toBe(false);
    expect(workerRouteFor('agent_a_1')).toEqual(W);
    const p = getBudgetPromptSection('boss');
    expect(p).toContain('<conductor>');
    expect(p).toContain('deepseek-v4.1-flash');
    setSessionBudget('plain', { limitUsd: 1 });
    expect(isConductorMain('plain')).toBe(false);
  });
});
