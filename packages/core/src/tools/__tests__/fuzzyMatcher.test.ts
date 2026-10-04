import { describe, it, expect } from 'vitest';
import {
  normalizeMatchLine,
  seekSequence,
  seekSequenceWith,
  findNextMatch,
  countNormalizedMatches,
  comparators,
} from '../files/fuzzyMatcher.js';

describe('fuzzyMatcher — unified matching engine', () => {
  describe('normalizeMatchLine', () => {
    it('normalizes smart quotes to ASCII', () => {
      expect(normalizeMatchLine('\u201Chello\u201D')).toBe('"hello"');
      expect(normalizeMatchLine('\u2018world\u2019')).toBe("'world'");
    });

    it('normalizes fancy dashes to ASCII hyphen', () => {
      expect(normalizeMatchLine('a\u2014b')).toBe('a-b');
      expect(normalizeMatchLine('x\u2212y')).toBe('x-y');
    });

    it('normalizes fullwidth punctuation', () => {
      expect(normalizeMatchLine('\uFF08test\uFF09')).toBe('(test)');
      expect(normalizeMatchLine('\uFF5B\uFF5D')).toBe('{}');
      expect(normalizeMatchLine('\u3002')).toBe('.');
    });

    it('normalizes various unicode spaces to ASCII', () => {
      expect(normalizeMatchLine('a\u00A0b')).toBe('a b');
      expect(normalizeMatchLine('a\u3000b')).toBe('a b');
    });

    it('trims leading and trailing whitespace', () => {
      expect(normalizeMatchLine('  hello  ')).toBe('hello');
    });
  });

  describe('seekSequence', () => {
    const lines = ['function foo() {', '  const a = 1;', '  return a;', '}'];

    it('L0 — exact match', () => {
      const result = seekSequence(lines, ['  const a = 1;', '  return a;'], 0);
      expect(result).not.toBeNull();
      expect(result!.index).toBe(1);
      expect(result!.line).toBe(2);
      expect(result!.fuzzLevel).toBe(0);
    });

    it('L1 — trimEnd match (trailing whitespace difference)', () => {
      const result = seekSequence(lines, ['  const a = 1;  ', '  return a;  '], 0);
      expect(result).not.toBeNull();
      expect(result!.index).toBe(1);
      expect(result!.fuzzLevel).toBe(1);
    });

    it('L2 — trim match (leading whitespace difference)', () => {
      const result = seekSequence(lines, ['const a = 1;', 'return a;'], 0);
      expect(result).not.toBeNull();
      expect(result!.index).toBe(1);
      expect(result!.fuzzLevel).toBe(2);
    });

    it('L3 — unicode normalize match', () => {
      const result = seekSequence(lines, ['\u2018function foo() {'], 0, 3);
      // 'function foo() {' doesn't have quotes, so this won't match easily.
      // Let's test with a more realistic case:
      const lines2 = ['const x = "hello";'];
      const result2 = seekSequence(lines2, ['const x = \u201Chello\u201D;'], 0, 3);
      expect(result2).not.toBeNull();
      expect(result2!.fuzzLevel).toBe(3);
    });

    it('returns null when no match at any level', () => {
      const result = seekSequence(lines, ['this does not exist'], 0);
      expect(result).toBeNull();
    });

    it('respects start position', () => {
      const result = seekSequence(lines, ['function foo() {'], 1);
      expect(result).toBeNull(); // starts after line 0
    });
  });

  describe('findNextMatch', () => {
    const lines = ['line1', 'line2', 'line3', 'line4'];

    it('finds a match', () => {
      const result = findNextMatch(lines, ['line2', 'line3'], ['new2', 'new3'], 0);
      expect(result).not.toBeNull();
      expect(result!.start).toBe(1);
    });

    it('handles trailing empty line tolerance', () => {
      const result = findNextMatch(lines, ['line2', ''], ['new2', ''], 0);
      // Should retry without trailing empty line and find 'line2' at index 1
      expect(result).not.toBeNull();
      expect(result!.start).toBe(1);
      expect(result!.oldLines).toEqual(['line2']); // trimmed
    });

    it('returns null when not found', () => {
      const result = findNextMatch(lines, ['no_exist'], ['new'], 0);
      expect(result).toBeNull();
    });
  });

  describe('countNormalizedMatches', () => {
    const lines = ['  const a = 1;', 'other', '  const a = 1;', 'end'];

    it('counts all matching positions', () => {
      const result = countNormalizedMatches(lines, ['const a = 1;'], 0, 10);
      expect(result).toEqual([1, 3]); // 1-based line numbers
    });

    it('respects maxCount', () => {
      const result = countNormalizedMatches(lines, ['const a = 1;'], 0, 1);
      expect(result).toEqual([1]);
    });

    it('respects start position', () => {
      const result = countNormalizedMatches(lines, ['const a = 1;'], 1, 10);
      expect(result).toEqual([3]); // skips index 0
    });
  });

  describe('seekSequenceWith', () => {
    const lines = ['a', 'b', 'c', 'd'];

    it('works with exact comparator', () => {
      const result = seekSequenceWith(lines, ['b', 'c'], comparators[0], 0);
      expect(result).toBe(1);
    });

    it('respects end boundary', () => {
      const result = seekSequenceWith(lines, ['c', 'd'], comparators[0], 0, 1);
      expect(result).toBeNull(); // pattern at index 2, but end=1
    });
  });
});
