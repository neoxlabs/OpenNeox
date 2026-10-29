import { describe, expect, it } from 'vitest';
import { placeBackfilledEntries } from '../placeBackfilledEntries';

const e = (id: string, timestamp: number) => ({ id, timestamp });

describe('placeBackfilledEntries', () => {
  it('补进来的回话插回它那一轮, 不落在表尾被并进最后一轮', () => {
    const rows = [e('u1', 100), e('u2', 400), e('a2', 410), e('u3', 600), e('a3', 610), e('ledger-19', 107)];
    expect(placeBackfilledEntries(rows).map((r) => r.id)).toEqual(['u1', 'ledger-19', 'u2', 'a2', 'u3', 'a3']);
  });

  it('本地条目的相对顺序一点不动 (哪怕时间戳本身乱)', () => {
    const rows = [e('r', 300), e('a', 290), e('ledger-1', 295)];
    expect(placeBackfilledEntries(rows).map((r) => r.id)).toEqual(['ledger-1', 'r', 'a']);
  });

  it('没有补进来的条目原样返回同一个数组', () => {
    const rows = [e('a', 1)];
    expect(placeBackfilledEntries(rows)).toBe(rows);
  });
});
