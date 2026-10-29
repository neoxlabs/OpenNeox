import { describe, expect, test } from 'vitest';
import { stabilizeSessionItems } from '../stableSessionItems';
import type { SessionItem } from '../../modules/shell/Sidebar';

const item = (id: string, over: Partial<SessionItem> = {}): SessionItem => ({
  id, title: `会话 ${id}`, ts: 1000, messageCount: 2, ...over,
});

describe('stabilizeSessionItems', () => {
  test('全部内容相同 → 交回上一次的数组本身 (引用都不动)', () => {
    const prev = [item('a'), item('b'), item('c')];
    const next = [item('a'), item('b'), item('c')];
    expect(stabilizeSessionItems(prev, next)).toBe(prev);
  });

  test('只有一条变了 → 只有那一条是新对象, 其余复用', () => {
    const prev = [item('a'), item('b'), item('c')];
    const changed = item('b', { messageCount: 3 });
    const out = stabilizeSessionItems(prev, [item('a'), changed, item('c')]);
    expect(out).not.toBe(prev);
    expect(out[0]).toBe(prev[0]);
    expect(out[1]).toBe(changed);
    expect(out[2]).toBe(prev[2]);
  });

  test('内容真变了必须换对象 —— 不许渲出过期内容', () => {
    const prev = [item('a', { title: '旧标题' })];
    const out = stabilizeSessionItems(prev, [item('a', { title: '新标题' })]);
    expect(out[0].title).toBe('新标题');
    expect(out[0]).not.toBe(prev[0]);
  });

  test('新增字段自动进入比较 (走 keys 并集, 不是写死字段表)', () => {
    const prev = [item('a')];
    const out = stabilizeSessionItems(prev, [item('a', { effectiveMode: 'work' })]);
    expect(out[0]).not.toBe(prev[0]);
    expect(out[0].effectiveMode).toBe('work');
  });

  test('删掉一条 / 加一条: 数组换新, 留下的仍复用', () => {
    const prev = [item('a'), item('b')];
    const removed = stabilizeSessionItems(prev, [item('a')]);
    expect(removed).not.toBe(prev);
    expect(removed[0]).toBe(prev[0]);

    const added = stabilizeSessionItems(prev, [item('a'), item('b'), item('c')]);
    expect(added).toHaveLength(3);
    expect(added[0]).toBe(prev[0]);
    expect(added[1]).toBe(prev[1]);
  });

  test('顺序变了不能当成没变 (数组引用必须换)', () => {
    const prev = [item('a'), item('b')];
    const out = stabilizeSessionItems(prev, [item('b'), item('a')]);
    expect(out).not.toBe(prev);
    expect(out[0]).toBe(prev[1]);
    expect(out[1]).toBe(prev[0]);
  });

  test('首次 / 空列表原样返回, 不炸', () => {
    const next = [item('a')];
    expect(stabilizeSessionItems(undefined, next)).toBe(next);
    expect(stabilizeSessionItems([], next)).toBe(next);
    expect(stabilizeSessionItems(next, [])).toEqual([]);
  });
});
