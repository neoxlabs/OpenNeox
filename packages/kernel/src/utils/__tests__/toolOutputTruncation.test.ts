import { describe, it, expect } from 'vitest';
import {
  truncateToolOutput,
  needsTruncation,
  getTruncationStats,
  estimateObjectSize,
  formatResponseHeaders,
  TOOL_OUTPUT_MAX_BYTES,
} from '../toolOutputTruncation.js';

const loneSurrogate = (s: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

function paddedOutput(errorLine: string, errorAt = 40): string {
  const lines: string[] = [];
  for (let i = 0; i < 120; i++) {
    if (i === errorAt) lines.push(errorLine);
    else lines.push(`line-${i} ${'x'.repeat(40)}`);
  }
  return lines.join('\n');
}

describe('truncateToolOutput — 基本行为', () => {
  it('未超过上限时原样返回（含空串）', () => {
    expect(truncateToolOutput('', 100)).toBe('');
    expect(truncateToolOutput('short', 100)).toBe('short');
    expect(needsTruncation('short', 100)).toBe(false);
    expect(needsTruncation('x'.repeat(101), 100)).toBe(true);
  });

  it('无错误证据时走常规中段截断，头尾都保留', () => {
    const content = 'HEAD'.repeat(1000) + 'MIDDLE' + 'TAIL'.repeat(1000);
    const out = truncateToolOutput(content, 1000);
    expect(out.length).toBeLessThanOrEqual(1300);
    expect(out.startsWith('HEAD')).toBe(true);
    expect(out.endsWith('TAIL')).toBe(true);
    expect(out).toContain('chars truncated in middle');
  });

  it('默认上限是 16K code units', () => {
    expect(TOOL_OUTPUT_MAX_BYTES).toBe(16_000);
    const content = 'x'.repeat(TOOL_OUTPUT_MAX_BYTES + 1);
    expect(truncateToolOutput(content).length).toBeLessThan(content.length);
  });
});

describe('truncateToolOutput — 错误行对齐', () => {
  it('中段错误行被对齐保留，并标注 error_aligned', () => {
    const out = truncateToolOutput(paddedOutput('Error: boom happened', 60), 2000);
    expect(out).toContain('error_aligned=true');
    expect(out).toContain('Error: boom happened');
    expect(out).toContain('不必重读');
    expect(out).toContain('line-119');
  });

  it('“0 errors” 不算证据，走常规截断', () => {
    const out = truncateToolOutput(paddedOutput('0 errors, all good', 60), 2000);
    expect(out).not.toContain('error_aligned=true');
    expect(out).toContain('chars truncated in middle');
  });

  it('“errorHandler” 这类命名不误伤', () => {
    const out = truncateToolOutput(paddedOutput('const errorHandler = () => {}', 60), 2000);
    expect(out).not.toContain('error_aligned=true');
  });

  it('超长单行（>2000）不当作错误行', () => {
    const out = truncateToolOutput(paddedOutput('Error: ' + 'x'.repeat(2500), 60), 2000);
    expect(out).not.toContain('error_aligned=true');
  });

  it('错误行已经在头部保留区时不重复对齐', () => {
    const out = truncateToolOutput(paddedOutput('Error: early', 1), 2000);
    expect(out).not.toContain('error_aligned=true');
  });

  it('错误行已经在尾部保留区时不重复对齐', () => {
    const out = truncateToolOutput(paddedOutput('Error: late', 119), 2000);
    expect(out).not.toContain('error_aligned=true');
  });

  it('stack trace 的 at 行也算失败证据', () => {
    const content = paddedOutput('    at foo (/tmp/a.ts:10:2)', 60);
    expect(truncateToolOutput(content, 2000)).toContain('error_aligned=true');
  });

  it('E123 错误码也算证据', () => {
    expect(truncateToolOutput(paddedOutput('build failed with E1234', 60), 2000)).toContain('error_aligned=true');
  });
});

describe('truncateToolOutput — UTF-16 安全', () => {
  it('emoji 截断后不产生孤立 surrogate', () => {
    const out = truncateToolOutput('😀'.repeat(5000), 2000);
    expect(out.length).toBeLessThan(10_000);
    expect(loneSurrogate(out)).toBe(false);
  });

  it('错误对齐路径同样不产生孤立 surrogate', () => {
    const lines = Array.from({ length: 200 }, (_, i) => (i === 100 ? 'Error: 😀😀😀' : `l-${i}-😀${'x'.repeat(20)}`));
    const out = truncateToolOutput(lines.join('\n'), 2000);
    expect(loneSurrogate(out)).toBe(false);
  });
});

describe('统计与辅助函数', () => {
  it('getTruncationStats', () => {
    const s = getTruncationStats('abcdef', 'abc');
    expect(s).toEqual({ originalSize: 6, truncatedSize: 3, savedBytes: 3, compressionRatio: 0.5, wasTruncated: true });
    expect(getTruncationStats('abc', 'abc').wasTruncated).toBe(false);
  });

  it('estimateObjectSize 正常 / 循环引用', () => {
    expect(estimateObjectSize({ a: 1 })).toBe(JSON.stringify({ a: 1 }).length);
    const cyclic: any = {};
    cyclic.self = cyclic;
    expect(estimateObjectSize(cyclic)).toBe(0);
  });

  it('formatResponseHeaders 支持 toJSON 与普通对象', () => {
    expect(formatResponseHeaders({ a: 1 })).toContain('"a": 1');
    expect(formatResponseHeaders({ toJSON: () => ({ b: 2 }) })).toContain('"b": 2');
  });

  it('formatResponseHeaders 空 / 循环 / 超长', () => {
    expect(formatResponseHeaders(undefined)).toBe('{}');
    const cyclic: any = {};
    cyclic.self = cyclic;
    expect(formatResponseHeaders(cyclic)).toBe('[object Object]');
    const long = formatResponseHeaders({ s: 'x'.repeat(5000) }, 100);
    expect(long).toContain('...[truncated');
    expect(long.length).toBeLessThan(200);
  });
});
