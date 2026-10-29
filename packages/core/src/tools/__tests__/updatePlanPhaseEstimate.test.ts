/**
 * update_plan 的 phase / estimateSec 归一化 (work:Q-07 / work:Q-09)
 *
 * 锁三件事:
 *   1) 四个标准阶段原样保留, 常见英文别名也归一; 不认识的当没标, 不拦计划;
 *   2) 预计时长只收正数秒, 上限 3600; 负 / NaN / 0 当没给;
 *   3) 缺字段的步骤不带空值 —— UI 靠「没有 phase」判定要不要提示重写。
 */
import { describe, expect, it } from 'vitest';
import {
  PLAN_STEP_PHASES,
  __normalizeUpdatePlanArgsForTesting as normalize,
  handleUpdatePlan,
} from '../updatePlan.js';

const planOf = (raw: unknown) => normalize({ plan: raw } as any)!;

describe('阶段归一化 (Q-09)', () => {
  it('四个标准阶段原样保留', () => {
    const out = planOf([
      { step: '读文档', status: 'pending', phase: '读材料' },
      { step: '对数字', status: 'pending', phase: '核对' },
      { step: '写报告', status: 'pending', phase: '产出' },
      { step: '自检', status: 'pending', phase: '自检' },
    ]);
    expect(out.plan.map((s) => s.phase)).toEqual([...PLAN_STEP_PHASES]);
  });

  it('英文别名 / 大小写 / 空格都认', () => {
    const out = planOf([
      { step: 'a', status: 'pending', phase: 'Read' },
      { step: 'b', status: 'pending', phase: 'fact-check' },
      { step: 'c', status: 'pending', phase: 'writing' },
      { step: 'd', status: 'pending', phase: 'Self Check' },
    ]);
    expect(out.plan.map((s) => s.phase)).toEqual(['读材料', '核对', '产出', '自检']);
  });

  it('不认识的阶段当没标, 不丢步骤也不报错', () => {
    const out = planOf([
      { step: 'a', status: 'pending', phase: '随便写的' },
      { step: 'b', status: 'pending', phase: 42 },
      { step: 'c', status: 'pending' },
    ]);
    expect(out.plan).toHaveLength(3);
    expect(out.plan.every((s) => s.phase === undefined)).toBe(true);
  });
});

describe('预计时长 (Q-07)', () => {
  it('正数秒保留, 字符串数字也认', () => {
    const out = planOf([
      { step: 'a', status: 'pending', estimateSec: 30 },
      { step: 'b', status: 'pending', estimateSec: '120' },
      { step: 'c', status: 'pending', estimate_sec: 45 },
    ]);
    expect(out.plan.map((s) => s.estimateSec)).toEqual([30, 120, 45]);
  });

  it('负数 / 0 / NaN / 乱码一律当没给', () => {
    const out = planOf([
      { step: 'a', status: 'pending', estimateSec: -5 },
      { step: 'b', status: 'pending', estimateSec: 0 },
      { step: 'c', status: 'pending', estimateSec: Number.NaN },
      { step: 'd', status: 'pending', estimateSec: 'soon' },
    ]);
    expect(out.plan.every((s) => s.estimateSec === undefined)).toBe(true);
  });

  it('超过一小时钳到 3600, 小数四舍五入', () => {
    const out = planOf([
      { step: 'a', status: 'pending', estimateSec: 999999 },
      { step: 'b', status: 'pending', estimateSec: 29.6 },
    ]);
    expect(out.plan[0].estimateSec).toBe(3600);
    expect(out.plan[1].estimateSec).toBe(30);
  });
});

describe('handleUpdatePlan 端到端', () => {
  it('带 phase / estimateSec 的计划照常更新, 不报错', async () => {
    const out = JSON.parse(await handleUpdatePlan({
      plan: [
        { step: '读文档', status: 'in_progress', phase: '读材料', estimateSec: 60 },
        { step: '写报告', status: 'pending', phase: '产出', estimateSec: 120 },
      ],
    } as any));
    expect(out.success).toBe(true);
  });
});
