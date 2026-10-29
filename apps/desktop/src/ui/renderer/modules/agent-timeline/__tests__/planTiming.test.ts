/**
 * Q-07 / Q-09 的纯函数测试: 每步预计与真实耗时、阶段缺失判定。
 *
 * 时间全部来自 timeline 上 plan_update entry 的时间戳 —— 这里用假 entry 复现
 * 「进入 in_progress → 完成」和「还在跑」两种形态, 不依赖渲染组件。
 */
import { describe, expect, it } from 'vitest';
import {
  computePlanStepTimings,
  elapsedSeconds,
  formatPlanDuration,
  isOverEstimate,
  phaseLabel,
  planLineage,
  stepsMissingPhase,
} from '../planTiming';

const T0 = 1_700_000_000_000;

const planEntry = (
  timestamp: number,
  steps: Array<{ content: string; status: string }>,
  extra: Record<string, unknown> = {},
) => ({
  id: `e-${timestamp}`,
  type: 'plan',
  timestamp,
  planSteps: steps.map((s, i) => ({ id: `s${i}`, ...s })),
  ...extra,
}) as any;

const STEPS = [
  { content: '读需求文档', phase: '读材料', estimateSec: 30 },
  { content: '核对数字', phase: '核对', estimateSec: 60 },
  { content: '写周报', phase: '产出', estimateSec: 120 },
];

describe('computePlanStepTimings', () => {
  it('进入 in_progress 到完成之间的真实耗时', () => {
    const timeline = [
      planEntry(T0, [
        { content: '读需求文档', status: 'pending' },
        { content: '核对数字', status: 'pending' },
        { content: '写周报', status: 'pending' },
      ]),
      planEntry(T0 + 10_000, [
        { content: '读需求文档', status: 'in_progress' },
        { content: '核对数字', status: 'pending' },
        { content: '写周报', status: 'pending' },
      ]),
      planEntry(T0 + 70_000, [
        { content: '读需求文档', status: 'completed' },
        { content: '核对数字', status: 'in_progress' },
        { content: '写周报', status: 'pending' },
      ]),
    ];

    const timings = computePlanStepTimings(timeline, STEPS);
    expect(timings[0]).toEqual({ startedAt: T0 + 10_000, endedAt: T0 + 70_000 });
    expect(timings[1]).toEqual({ startedAt: T0 + 70_000 });
    expect(timings[2]).toEqual({});
    expect(elapsedSeconds(timings[0], T0 + 999_000)).toBe(60);
  });

  it('还在跑的步骤用 now 算已用', () => {
    const timeline = [planEntry(T0, [
      { content: '读需求文档', status: 'in_progress' },
      { content: '核对数字', status: 'pending' },
      { content: '写周报', status: 'pending' },
    ])];
    const timings = computePlanStepTimings(timeline, STEPS);
    expect(elapsedSeconds(timings[0], T0 + 45_000)).toBe(45);
  });

  it('上一个任务的计划不污染当前计划', () => {
    const timeline = [
      planEntry(T0 - 600_000, [
        { content: '旧任务 A', status: 'in_progress' },
        { content: '旧任务 B', status: 'pending' },
        { content: '旧任务 C', status: 'pending' },
      ], { planFrozen: true }),
      planEntry(T0, [
        { content: '读需求文档', status: 'in_progress' },
        { content: '核对数字', status: 'pending' },
        { content: '写周报', status: 'pending' },
      ]),
    ];
    const timings = computePlanStepTimings(timeline, STEPS);
    expect(timings[0].startedAt).toBe(T0);
    expect(planLineage(timeline)).toHaveLength(1);
  });

  it('同一条计划的多条 entry 串起来 (旧的被标 frozen 也算)', () => {
    const timeline = [
      planEntry(T0, [
        { content: '读需求文档', status: 'in_progress' },
        { content: '核对数字', status: 'pending' },
        { content: '写周报', status: 'pending' },
      ], { planFrozen: true }),
      planEntry(T0 + 20_000, [
        { content: '读需求文档', status: 'completed' },
        { content: '核对数字', status: 'pending' },
        { content: '写周报', status: 'pending' },
      ]),
    ];
    expect(planLineage(timeline)).toHaveLength(2);
    const timings = computePlanStepTimings(timeline, STEPS);
    expect(timings[0]).toEqual({ startedAt: T0, endedAt: T0 + 20_000 });
  });
});

describe('偏差 >2x', () => {
  it('恰好 2 倍不算超时, 超过才提醒', () => {
    expect(isOverEstimate(60, 30)).toBe(false);
    expect(isOverEstimate(61, 30)).toBe(true);
  });

  it('没预计 / 没已用 → 永不提醒', () => {
    expect(isOverEstimate(undefined, 30)).toBe(false);
    expect(isOverEstimate(999, undefined)).toBe(false);
    expect(isOverEstimate(999, 0)).toBe(false);
  });
});

describe('展示文案', () => {
  it('秒 / 分秒格式', () => {
    expect(formatPlanDuration(45)).toBe('45s');
    expect(formatPlanDuration(60)).toBe('1m');
    expect(formatPlanDuration(125)).toBe('2m5s');
    expect(formatPlanDuration(3900)).toBe('1h5m');
  });

  it('阶段中英显示', () => {
    expect(phaseLabel('读材料', true)).toBe('读材料');
    expect(phaseLabel('读材料', false)).toBe('Read');
    expect(phaseLabel('自检', false)).toBe('Verify');
    expect(phaseLabel(undefined, true)).toBe('');
  });
});

describe('缺阶段 (Q-09)', () => {
  it('统计没标阶段的步骤数', () => {
    expect(stepsMissingPhase([
      { phase: '读材料' },
      { phase: '' },
      {},
    ])).toBe(2);
    expect(stepsMissingPhase(STEPS)).toBe(0);
  });
});
