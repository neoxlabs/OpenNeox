import { describe, it, expect } from 'vitest';
import { generateDiffLines, diffSummary } from '../diffPreview.js';

describe('diffPreview', () => {
  describe('generateDiffLines', () => {
    it('detects no changes', () => {
      const lines = generateDiffLines('hello\nworld', 'hello\nworld', 'test.ts');
      expect(lines).toHaveLength(1);
      expect(lines[0].type).toBe('header');
      expect(lines[0].content).toContain('No changes');
    });

    it('detects added lines', () => {
      const lines = generateDiffLines('line1\nline2', 'line1\nline2\nline3', 'test.ts');
      const adds = lines.filter(l => l.type === 'add');
      expect(adds.length).toBeGreaterThan(0);
      expect(adds.some(a => a.content === 'line3')).toBe(true);
    });

    it('detects removed lines', () => {
      const lines = generateDiffLines('line1\nline2\nline3', 'line1\nline3', 'test.ts');
      const removes = lines.filter(l => l.type === 'remove');
      expect(removes.length).toBeGreaterThan(0);
    });

    it('detects modified lines', () => {
      const lines = generateDiffLines('hello world', 'hello universe', 'test.ts');
      const adds = lines.filter(l => l.type === 'add');
      const removes = lines.filter(l => l.type === 'remove');
      expect(adds.length).toBeGreaterThan(0);
      expect(removes.length).toBeGreaterThan(0);
    });

    it('generates new file diff', () => {
      const lines = generateDiffLines('', 'new content\nhere', 'test.ts', { isNewFile: true });
      const adds = lines.filter(l => l.type === 'add');
      expect(adds).toHaveLength(2);
      expect(lines[0].content).toContain('new file');
    });

    it('includes unified diff headers', () => {
      const lines = generateDiffLines('old', 'new', 'test.ts');
      const headers = lines.filter(l => l.type === 'header');
      expect(headers.some(h => h.content.includes('---'))).toBe(true);
      expect(headers.some(h => h.content.includes('+++'))).toBe(true);
    });

    it('respects maxLines', () => {
      const oldContent = Array.from({ length: 100 }, (_, i) => `old line ${i}`).join('\n');
      const newContent = Array.from({ length: 100 }, (_, i) => `new line ${i}`).join('\n');
      const lines = generateDiffLines(oldContent, newContent, 'test.ts', { maxLines: 10 });
      expect(lines.length).toBeLessThanOrEqual(11); // +1 for truncation message
    });
  });

  describe('diffSummary', () => {
    it('shows add/remove counts', () => {
      const lines = generateDiffLines('a\nb', 'a\nb\nc\nd', 'test.ts');
      const summary = diffSummary(lines);
      expect(summary).toContain('+');
    });

    it('returns no changes for identical', () => {
      const lines = generateDiffLines('same', 'same', 'test.ts');
      expect(diffSummary(lines)).toBe('no changes');
    });
  });
});
