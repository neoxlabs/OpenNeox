import { describe, expect, test } from 'vitest';
import { thinkingTail } from '../timelineRows';

describe('thinkingTail', () => {
  test('取最后一句, 空白折叠', () => {
    expect(thinkingTail('The repo has:\n- 行测.md.  They mean 综应 target = 115. I should correct this clearly but not pedantically.'))
      .toBe('I should correct this clearly but not pedantically.');
  });
  test('中文句读也能切', () => {
    expect(thinkingTail('先看进面线。2025 省直最低 133.5，最高 229.5，差距很大，不能一概而论'))
      .toBe('2025 省直最低 133.5，最高 229.5，差距很大，不能一概而论');
  });
  test('最后一句太短就往前多带一句', () => {
    expect(thinkingTail('They mean 综应 target = 115. So:')).toBe('They mean 综应 target = 115. So:');
  });
  test('超长保留结尾', () => {
    const out = thinkingTail('x'.repeat(500), 160);
    expect(out.length).toBe(160);
    expect(out.startsWith('…')).toBe(true);
  });
  test('空文本', () => {
    expect(thinkingTail('  \n ')).toBe('');
  });
});
