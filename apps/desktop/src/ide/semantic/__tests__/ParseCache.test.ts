/**
 * ParseCache —— LRU + hash key + path invalidate.
 */
import { describe, it, expect, vi } from 'vitest';
import { ParseCache } from '../parsers/parseCache.js';
import type { ParseResult } from '../parsers/Parser.js';

function makeResult(tag: string): ParseResult {
  return {
    symbols: [{
      name: tag,
      kind: 'function',
      range: { start: { line: 0, column: 0 }, end: { line: 0, column: 1 } },
    }],
    hasErrors: false,
  };
}

describe('ParseCache · basic', () => {
  it('starts empty', () => {
    const cache = new ParseCache();
    expect(cache.size()).toBe(0);
    expect(cache.get('/a.ts', 'h1')).toBeUndefined();
  });

  it('set + get returns same result', () => {
    const cache = new ParseCache();
    const res = makeResult('foo');
    cache.set('/a.ts', 'h1', res);
    expect(cache.get('/a.ts', 'h1')).toBe(res);
    expect(cache.size()).toBe(1);
  });

  it('distinguishes different hashes', () => {
    const cache = new ParseCache();
    const a = makeResult('a');
    const b = makeResult('b');
    cache.set('/x.ts', 'h1', a);
    cache.set('/x.ts', 'h2', b);
    expect(cache.get('/x.ts', 'h1')).toBe(a);
    expect(cache.get('/x.ts', 'h2')).toBe(b);
    expect(cache.size()).toBe(2);
  });

  it('set on same key overwrites (moves to newest)', () => {
    const cache = new ParseCache({ maxEntries: 2 });
    const a = makeResult('a');
    const a2 = makeResult('a2');
    cache.set('/x.ts', 'h1', a);
    cache.set('/x.ts', 'h1', a2);
    expect(cache.get('/x.ts', 'h1')).toBe(a2);
    expect(cache.size()).toBe(1);
  });
});

describe('ParseCache · LRU eviction', () => {
  it('evicts oldest when over capacity', () => {
    const cache = new ParseCache({ maxEntries: 2 });
    cache.set('/a.ts', 'h', makeResult('a'));
    cache.set('/b.ts', 'h', makeResult('b'));
    cache.set('/c.ts', 'h', makeResult('c'));  // 触发 evict /a.ts
    expect(cache.get('/a.ts', 'h')).toBeUndefined();
    expect(cache.get('/b.ts', 'h')).toBeDefined();
    expect(cache.get('/c.ts', 'h')).toBeDefined();
  });

  it('get() touches entry making it most recently used', () => {
    const cache = new ParseCache({ maxEntries: 2 });
    cache.set('/a.ts', 'h', makeResult('a'));
    cache.set('/b.ts', 'h', makeResult('b'));
    // 访问 a —— a 变成 MRU, b 变 LRU
    expect(cache.get('/a.ts', 'h')).toBeDefined();
    cache.set('/c.ts', 'h', makeResult('c'));  // 应 evict /b.ts
    expect(cache.get('/a.ts', 'h')).toBeDefined();
    expect(cache.get('/b.ts', 'h')).toBeUndefined();
    expect(cache.get('/c.ts', 'h')).toBeDefined();
  });

  it('maxEntries clamped to >= 1', () => {
    const cache = new ParseCache({ maxEntries: 0 });
    cache.set('/a.ts', 'h', makeResult('a'));
    expect(cache.size()).toBe(1);
  });
});

describe('ParseCache · invalidate / clear', () => {
  it('invalidate(path) removes all hash versions for that path', () => {
    const cache = new ParseCache();
    cache.set('/a.ts', 'h1', makeResult('a1'));
    cache.set('/a.ts', 'h2', makeResult('a2'));
    cache.set('/b.ts', 'h1', makeResult('b1'));
    const removed = cache.invalidate('/a.ts');
    expect(removed).toBe(2);
    expect(cache.get('/a.ts', 'h1')).toBeUndefined();
    expect(cache.get('/a.ts', 'h2')).toBeUndefined();
    expect(cache.get('/b.ts', 'h1')).toBeDefined();
  });

  it('invalidate on missing path returns 0', () => {
    const cache = new ParseCache();
    expect(cache.invalidate('/missing.ts')).toBe(0);
  });

  it('clear() empties the cache', () => {
    const cache = new ParseCache();
    cache.set('/a.ts', 'h', makeResult('a'));
    cache.set('/b.ts', 'h', makeResult('b'));
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});

describe('ParseCache · TTL', () => {
  it('expired entry is not returned and is cleaned', () => {
    let t = 0;
    const cache = new ParseCache({ ttlMs: 100, now: () => t });
    cache.set('/a.ts', 'h', makeResult('a'));
    t = 50;
    expect(cache.get('/a.ts', 'h')).toBeDefined();
    t = 200;
    expect(cache.get('/a.ts', 'h')).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it('default ttl is Infinity (never expires)', () => {
    let t = 0;
    const cache = new ParseCache({ now: () => t });
    cache.set('/a.ts', 'h', makeResult('a'));
    t = Number.MAX_SAFE_INTEGER;
    expect(cache.get('/a.ts', 'h')).toBeDefined();
  });
});

describe('ParseCache · snapshot', () => {
  it('lists entries in insertion (oldest-first) order', () => {
    const cache = new ParseCache();
    cache.set('/a.ts', 'h1', makeResult('a'));
    cache.set('/b.ts', 'h1', makeResult('b'));
    cache.set('/c.ts', 'h1', makeResult('c'));
    const snap = cache.snapshot();
    expect(snap.map((e) => e.path)).toEqual(['/a.ts', '/b.ts', '/c.ts']);
  });

  it('get() moves touched entry to newest position in snapshot', () => {
    const cache = new ParseCache();
    cache.set('/a.ts', 'h', makeResult('a'));
    cache.set('/b.ts', 'h', makeResult('b'));
    cache.get('/a.ts', 'h');
    const snap = cache.snapshot();
    expect(snap.map((e) => e.path)).toEqual(['/b.ts', '/a.ts']);
  });
});
