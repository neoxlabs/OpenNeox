/**
 * 界面回执差异 —— 这层最凶的失效方式是**静默残缺**: 差异算错不会报错, 只会让模型
 * 以为界面上少了 / 多了元素, 然后去点一个不存在的编号。所以每条退回全量的条件都钉死。
 */
import { describe, it, expect } from 'vitest';
import { ViewDeltaTracker, compressIds } from '../viewDelta.js';

const list = (n: number, tweak: (i: number) => string = (i) => `btn${i}`) =>
  Array.from({ length: n }, (_, k) => ({ id: k + 1, line: `${k + 1}. [Button] ${tweak(k + 1)}` }));

describe('compressIds', () => {
  it('连续编号压成区间', () => {
    expect(compressIds([5, 3, 4, 9, 12, 13])).toBe('3-5, 9, 12-13');
    expect(compressIds([])).toBe('');
  });
});

describe('ViewDeltaTracker', () => {
  it('第一次一定整份; 没变就是 0 差异', () => {
    const t = new ViewDeltaTracker();
    expect(t.next('s', 'w', list(20), { digest: 'a' }).mode).toBe('full');
    const d = t.next('s', 'w', list(20), { digest: 'a' });
    expect(d).toMatchObject({ mode: 'delta', unchanged: 20, changed: [], added: [], removed: '', extras: {} });
  });

  it('改 / 增 / 删分开报, 删的压成区间', () => {
    const t = new ViewDeltaTracker();
    t.next('s', 'w', list(20), {});
    const now = list(20, (i) => (i === 4 ? 'renamed' : `btn${i}`)).filter((x) => x.id < 18 || x.id > 19);
    now.push({ id: 21, line: '21. [Button] new' });
    const d = t.next('s', 'w', now, {});
    if (d.mode !== 'delta') throw new Error('expected delta');
    expect(d.changed).toEqual(['4. [Button] renamed']);
    expect(d.added).toEqual(['21. [Button] new']);
    expect(d.removed).toBe('18-19');
    expect(d.unchanged).toBe(17);
  });

  it('累计差异: 一直对着上一份**完整**的比, 不对着上一条差异比', () => {
    const t = new ViewDeltaTracker();
    t.next('s', 'w', list(20), {});
    const a = list(20, (i) => (i === 1 ? 'x' : `btn${i}`));
    t.next('s', 'w', a, {});
    const b = t.next('s', 'w', a, {});
    /* 链式的话第二次是"没变"; 累计的话 1 号相对完整清单仍然是变了的 */
    expect(b).toMatchObject({ mode: 'delta', changed: ['1. [Button] x'] });
  });

  it('其余字段只报变了的, 消失的字段也算变化', () => {
    const t = new ViewDeltaTracker();
    t.next('s', 'w', list(20), { digest: 'a', paging: 'p1' });
    const d = t.next('s', 'w', list(20), { digest: 'b' });
    expect(d).toMatchObject({ mode: 'delta', extras: { digest: 'b', paging: '(gone)' } });
  });

  it('退回全量的五种情况', () => {
    const t = new ViewDeltaTracker({ maxDeltasPerFull: 2, maxAgeMs: 1000 });
    /* 没有会话号 */
    t.next(undefined, 'w', list(20), {});
    expect(t.next(undefined, 'w', list(20), {}).mode).toBe('full');
    /* 换了窗口 */
    t.next('s', 'w', list(20), {}, { now: 0 });
    expect(t.next('s', 'other', list(20), {}, { now: 1 }).mode).toBe('full');
    /* 模型要整份 */
    expect(t.next('s', 'w', list(20), {}, { now: 2, forceFull: true }).mode).toBe('full');
    /* 差异发够次数 */
    expect(t.next('s', 'w', list(20), {}, { now: 3 }).mode).toBe('delta');
    expect(t.next('s', 'w', list(20), {}, { now: 4 }).mode).toBe('delta');
    expect(t.next('s', 'w', list(20), {}, { now: 5 }).mode).toBe('full');
    /* 太久 */
    expect(t.next('s', 'w', list(20), {}, { now: 5000 }).mode).toBe('full');
  });

  it('变得太多 (差异不比全量小多少) → 整份', () => {
    const t = new ViewDeltaTracker();
    t.next('s', 'w', list(20), {});
    const d = t.next('s', 'w', list(20, (i) => (i <= 12 ? `changed${i}` : `btn${i}`)), {});
    expect(d.mode).toBe('full');
  });

  it('子 agent 不能拿父会话的清单当底', () => {
    const t = new ViewDeltaTracker();
    t.next('parent', 'w', list(20), {});
    expect(t.next('agent_child', 'w', list(20), {}).mode).toBe('full');
  });
});
