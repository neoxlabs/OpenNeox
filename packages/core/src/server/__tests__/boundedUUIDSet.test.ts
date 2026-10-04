import { describe, it, expect } from 'vitest';
import { BoundedUUIDSet } from '../boundedUUIDSet.js';

describe('BoundedUUIDSet', () => {
  it('adds and checks UUIDs', () => {
    const set = new BoundedUUIDSet(10);
    set.add('aaa');
    set.add('bbb');
    expect(set.has('aaa')).toBe(true);
    expect(set.has('bbb')).toBe(true);
    expect(set.has('ccc')).toBe(false);
  });

  it('evicts oldest when capacity reached', () => {
    const set = new BoundedUUIDSet(3);
    set.add('a');
    set.add('b');
    set.add('c');
    expect(set.size).toBe(3);

    // 添加第 4 个，最旧的 'a' 被淘汰
    set.add('d');
    expect(set.has('a')).toBe(false);
    expect(set.has('b')).toBe(true);
    expect(set.has('c')).toBe(true);
    expect(set.has('d')).toBe(true);
    expect(set.size).toBe(3);
  });

  it('does not add duplicates', () => {
    const set = new BoundedUUIDSet(5);
    set.add('x');
    set.add('x');
    set.add('x');
    expect(set.size).toBe(1);
  });

  it('seed pre-populates', () => {
    const set = new BoundedUUIDSet(10);
    set.seed(['1', '2', '3']);
    expect(set.has('1')).toBe(true);
    expect(set.has('2')).toBe(true);
    expect(set.has('3')).toBe(true);
    expect(set.size).toBe(3);
  });

  it('clear resets everything', () => {
    const set = new BoundedUUIDSet(5);
    set.add('a');
    set.add('b');
    set.clear();
    expect(set.size).toBe(0);
    expect(set.has('a')).toBe(false);
  });

  it('handles capacity=1', () => {
    const set = new BoundedUUIDSet(1);
    set.add('first');
    expect(set.has('first')).toBe(true);
    set.add('second');
    expect(set.has('first')).toBe(false);
    expect(set.has('second')).toBe(true);
  });

  it('FIFO eviction order is correct over multiple cycles', () => {
    const set = new BoundedUUIDSet(3);
    // Fill: [a, b, c]
    set.add('a'); set.add('b'); set.add('c');
    // Add d: evicts a → [d, b, c]
    set.add('d');
    // Add e: evicts b → [d, e, c]
    set.add('e');
    expect(set.has('a')).toBe(false);
    expect(set.has('b')).toBe(false);
    expect(set.has('c')).toBe(true);
    expect(set.has('d')).toBe(true);
    expect(set.has('e')).toBe(true);
  });
});
