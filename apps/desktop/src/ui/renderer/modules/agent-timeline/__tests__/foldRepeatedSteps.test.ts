import { describe, expect, it } from 'vitest';
import { foldRepeatedSteps, rowStepId, type RowStep } from '../timelineRows';

const step = (id: string, title: string, status: 'done' | 'failed' = 'done') =>
  ({ id, title, status } as unknown as RowStep);

describe('foldRepeatedSteps', () => {
  it('11 条一模一样折成 1 条, 次数如实为 11', () => {
    const items = Array.from({ length: 11 }, (_, i) => step(`a${i}`, '询问 · 先做 A 还是先做 B?'));
    const out = foldRepeatedSteps(items);
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(11);
    /* RowStep 是三种行形态的联合 (HistoryCellRow | LegacyStepRow | TimelineStep),
     * 只有其中一种直接带 .id —— 取 id 要走 rowStepId 这个统一访问器。
     * 直接点 .id 一直是类型错误, 只是 renderer 从没被 typecheck 覆盖, 没人看见。 */
    expect(rowStepId(out[0].step)).toBe('a0');   /* 留第一条, 位置不跳 */
  });

  it('标题不同的不合并', () => {
    const out = foldRepeatedSteps([step('a', 'X'), step('b', 'Y'), step('c', 'X')]);
    expect(out.map((x) => x.count)).toEqual([1, 1, 1]);
  });

  it('标题同但状态不同的不合并 —— 成功和失败是两件事', () => {
    const out = foldRepeatedSteps([step('a', 'X', 'done'), step('b', 'X', 'failed')]);
    expect(out).toHaveLength(2);
  });

  it('只合并**相邻**的: 中间夹了别的就分成两段', () => {
    const out = foldRepeatedSteps([
      step('a', 'X'), step('b', 'X'), step('c', 'Y'), step('d', 'X'), step('e', 'X'), step('f', 'X'),
    ]);
    expect(out.map((x) => x.count)).toEqual([2, 1, 3]);
  });

  it('不吃条目: 折出来的次数加起来等于原条目数', () => {
    const items = [step('a', 'X'), step('b', 'X'), step('c', 'Y'), step('d', 'Y'), step('e', 'Z')];
    const out = foldRepeatedSteps(items);
    expect(out.reduce((s, x) => s + x.count, 0)).toBe(items.length);
  });

  it('空列表不炸', () => {
    expect(foldRepeatedSteps([])).toEqual([]);
  });
});
