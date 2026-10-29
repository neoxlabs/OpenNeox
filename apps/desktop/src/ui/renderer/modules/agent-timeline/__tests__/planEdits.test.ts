import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetPlanEditsForTesting,
  buildPlanEditDirective,
  getPlanEdits,
  mergePlanSteps,
  notePlanEdit,
  type PlanEditRecord,
} from '../../../state/planEdits';

/**
 * work:Q-06 计划可点可改 —— 跳过某步 / 先做某步 / 改标题
 *
 * 锁两件事:
 *   ① 本地合并的语义 (点下去立刻看到 skipped / 换标题 / 提前的步成为当前步);
 *   ② 送到 agent 的那条指令说得清是哪一步 —— 否则模型接不住。
 */

const STEPS = [
  { content: '收集素材', status: 'completed' },
  { content: '整理数据', status: 'completed' },
  { content: '写初稿', status: 'in_progress' },
  { content: '做竞品对比', status: 'pending' },
  { content: '排版', status: 'pending' },
];

function rec(partial: Partial<PlanEditRecord> & Pick<PlanEditRecord, 'kind' | 'index'>): PlanEditRecord {
  return { text: STEPS[partial.index]?.content ?? '', ...partial } as PlanEditRecord;
}

describe('mergePlanSteps', () => {
  it('没有修改时原样返回 (引用不变, 不白建数组)', () => {
    expect(mergePlanSteps(STEPS, [])).toBe(STEPS);
  });

  it('跳过第 4 步 → 那一步变 skipped, 其它不动', () => {
    const out = mergePlanSteps(STEPS, [rec({ kind: 'skip', index: 3 })]);
    expect(out[3].status).toBe('skipped');
    expect(out[2].status).toBe('in_progress');
    expect(out[0].status).toBe('completed');
  });

  it('已完成的步骤点跳过不会被改成 skipped (做过的活不能看起来像没做)', () => {
    const out = mergePlanSteps(STEPS, [rec({ kind: 'skip', index: 1 })]);
    expect(out[1].status).toBe('completed');
  });

  it('先做第 5 步 → 它变 in_progress, 原来的当前步退回 pending', () => {
    const out = mergePlanSteps(STEPS, [rec({ kind: 'focus', index: 4 })]);
    expect(out[4].status).toBe('in_progress');
    expect(out[2].status).toBe('pending');
  });

  it('改名 → 内容换掉, 状态不变', () => {
    const out = mergePlanSteps(STEPS, [rec({ kind: 'rename', index: 2, title: '写终稿' })]);
    expect(out[2].content).toBe('写终稿');
    expect(out[2].status).toBe('in_progress');
  });

  it('改名 + 跳过同一步时, 跳过仍然命中 (匹配按修改前的原文算)', () => {
    const out = mergePlanSteps(STEPS, [
      rec({ kind: 'rename', index: 2, title: '写终稿' }),
      rec({ kind: 'skip', index: 2 }),
    ]);
    expect(out[2].content).toBe('写终稿');
    expect(out[2].status).toBe('skipped');
  });

  it('改名后模型把标题写进新计划, 随后的「先做」仍然命中 (真机踩过的坑)', () => {
    const renamedByModel = STEPS.map((s, i) => (i === 2 ? { ...s, content: '写终稿' } : s));
    const out = mergePlanSteps(renamedByModel, [
      rec({ kind: 'rename', index: 2, title: '写终稿' }),
      rec({ kind: 'focus', index: 2 }),
    ]);
    expect(out[2].status).toBe('in_progress');
  });

  it('模型重写了计划, 同一下标换了内容 → 旧修改不生效 (不误伤别的步)', () => {
    const rewritten = STEPS.map((s, i) => (i === 3 ? { ...s, content: '补一页附录' } : s));
    const out = mergePlanSteps(rewritten, [rec({ kind: 'skip', index: 3 })]);
    expect(out[3].status).toBe('pending');
  });

  it('下标越界不崩', () => {
    expect(() => mergePlanSteps(STEPS, [rec({ kind: 'skip', index: 9, text: '不存在' })])).not.toThrow();
    expect(mergePlanSteps(STEPS, [rec({ kind: 'skip', index: 9, text: '不存在' })])[0].status).toBe('completed');
  });
});

describe('buildPlanEditDirective', () => {
  it('跳过: 点名第 N 步和原文, 说清不再执行', () => {
    const zh = buildPlanEditDirective(rec({ kind: 'skip', index: 3 }), true);
    expect(zh).toContain('第 4 步');
    expect(zh).toContain('做竞品对比');
    expect(zh).toContain('skipped');
    expect(buildPlanEditDirective(rec({ kind: 'skip', index: 3 }), false)).toContain('step 4');
  });

  it('先做: 要求标 in_progress 并从那一步开始', () => {
    const zh = buildPlanEditDirective(rec({ kind: 'focus', index: 4 }), true);
    expect(zh).toContain('第 5 步');
    expect(zh).toContain('in_progress');
  });

  it('改名: 旧名与新名都要出现', () => {
    const zh = buildPlanEditDirective(rec({ kind: 'rename', index: 2, title: '写终稿' }), true);
    expect(zh).toContain('写初稿');
    expect(zh).toContain('写终稿');
  });
});

describe('notePlanEdit (会话内累积)', () => {
  beforeEach(() => __resetPlanEditsForTesting());

  it('按会话存, 互不串', () => {
    notePlanEdit('a', { kind: 'skip', index: 1 }, '整理数据');
    expect(getPlanEdits('a')).toHaveLength(1);
    expect(getPlanEdits('b')).toHaveLength(0);
  });

  it('同 kind 同下标只留一条 (连点两次不叠)', () => {
    notePlanEdit('a', { kind: 'skip', index: 1 }, '整理数据');
    notePlanEdit('a', { kind: 'skip', index: 1 }, '整理数据');
    expect(getPlanEdits('a')).toHaveLength(1);
  });

  it('不同动作各自保留', () => {
    notePlanEdit('a', { kind: 'skip', index: 3 }, '做竞品对比');
    notePlanEdit('a', { kind: 'rename', index: 2, title: '写终稿' }, '写初稿');
    expect(getPlanEdits('a')).toHaveLength(2);
  });
});
