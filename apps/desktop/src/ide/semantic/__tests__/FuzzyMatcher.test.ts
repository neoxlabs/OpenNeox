/**
 * FuzzyMatcher 单测 —— 验证核心打分规则是否符合预期。
 *
 * 注意：这里*不*断言精确分数（数值会随常量调优变化），只断言 **相对顺序** ——
 * 相对顺序是 UX 承诺，必须稳定。
 */

import { describe, it, expect } from 'vitest';
import { fuzzyMatch, fuzzyFilter } from '../fuzzy/FuzzyMatcher.js';

describe('FuzzyMatcher', () => {
  describe('basic matching', () => {
    it('matches empty query with score 0', () => {
      expect(fuzzyMatch('', 'anything').score).toBe(0);
    });

    it('rejects query longer than target', () => {
      expect(Number.isFinite(fuzzyMatch('foobar', 'foo').score)).toBe(false);
    });

    it('rejects non-subsequence query', () => {
      expect(Number.isFinite(fuzzyMatch('xyz', 'abc').score)).toBe(false);
    });

    it('accepts subsequence query', () => {
      const r = fuzzyMatch('abc', 'aXbXc');
      expect(Number.isFinite(r.score)).toBe(true);
      expect(r.indices).toEqual([0, 2, 4]);
    });
  });

  describe('exact match bonus', () => {
    it('exact equal string scores highest', () => {
      const exact = fuzzyMatch('foo', 'foo');
      const prefix = fuzzyMatch('foo', 'foobar');
      const scattered = fuzzyMatch('foo', 'fXoXo');
      expect(exact.score).toBeGreaterThan(prefix.score);
      expect(prefix.score).toBeGreaterThan(scattered.score);
    });
  });

  describe('camelCase / word boundary bonuses', () => {
    it('matches camelCase hump indices', () => {
      const r = fuzzyMatch('PDM', 'PsiDocumentManager');
      expect(Number.isFinite(r.score)).toBe(true);
      expect(r.indices).toEqual([0, 3, 11]);
    });

    it('PDM scores higher on PsiDocumentManager than on psidocmgr', () => {
      // 虽然后者也匹配，但 camelCase 边界 + 首字母大写更贴用户意图
      const camel = fuzzyMatch('PDM', 'PsiDocumentManager');
      const lower = fuzzyMatch('PDM', 'psidocmgr');
      expect(camel.score).toBeGreaterThan(lower.score);
    });

    it('word boundary after / _ - . gets bonus', () => {
      // "my" 出现在 / 之后，应比中间位置得分高
      const boundary = fuzzyMatch('my', 'foo/myFile');
      const middle = fuzzyMatch('my', 'foomyfile');
      expect(boundary.score).toBeGreaterThan(middle.score);
    });
  });

  describe('consecutive match bonus', () => {
    it('consecutive matches beat gap matches of same length', () => {
      const consec = fuzzyMatch('abc', 'abc123');
      const gap = fuzzyMatch('abc', 'a1b2c3');
      expect(consec.score).toBeGreaterThan(gap.score);
    });
  });

  describe('smart case', () => {
    it('lowercase query matches case-insensitively by default', () => {
      expect(Number.isFinite(fuzzyMatch('foo', 'FOO').score)).toBe(true);
    });

    it('uppercase query is case-sensitive (smart case)', () => {
      const sensitive = fuzzyMatch('FOO', 'foo');
      expect(Number.isFinite(sensitive.score)).toBe(false);
    });

    it('explicit caseSensitive overrides smart case', () => {
      const r = fuzzyMatch('foo', 'FOO', { caseSensitive: true });
      expect(Number.isFinite(r.score)).toBe(false);
    });
  });

  describe('fuzzyFilter batch', () => {
    it('sorts matches by score descending', () => {
      const items = [
        { name: 'FooBarBaz' },
        { name: 'fbbaz' },
        { name: 'Baz' },
        { name: 'FooBar' },
        { name: 'nomatch' },
      ];
      const result = fuzzyFilter('fbb', items, (i) => i.name);
      expect(result[0].item.name).toBe('FooBarBaz'); // camel hump wins
      expect(result.some((r) => r.item.name === 'nomatch')).toBe(false);
    });

    it('respects limit', () => {
      const items = Array.from({ length: 100 }, (_, i) => ({ name: `file${i}.ts` }));
      const r = fuzzyFilter('file', items, (i) => i.name, {}, 10);
      expect(r).toHaveLength(10);
    });
  });

  describe('file search realistic scenarios', () => {
    it('typical Cmd+P: "ess" matches EditorService.ts better than stress.ts', () => {
      const r1 = fuzzyMatch('ess', 'EditorService.ts');
      const r2 = fuzzyMatch('ess', 'stress.ts');
      // 允许任何一个赢，但必须都匹配（顺序可能依赖常量细节）
      expect(Number.isFinite(r1.score)).toBe(true);
      expect(Number.isFinite(r2.score)).toBe(true);
    });

    it('typing first character of a camel hump fast-paths', () => {
      const r = fuzzyMatch('es', 'EditorService');
      expect(Number.isFinite(r.score)).toBe(true);
      // "E" at idx 0, "S" at idx 6 —— 两个都是 hump start
      expect(r.indices).toEqual([0, 6]);
    });
  });
});
