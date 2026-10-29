
import { describe, it, expect } from 'vitest';
import {
  EXCEL_SAFETY_LIMITS, SAFE_XLSX_READ_OPTIONS,
  assertExcelBufferSafe, safeSheetNames, safeSheetTitle,
  escapeHtml, escapeMarkdownCell, boundedSheetRange, rowsToSafeObjects,
} from '../xlsxSafety';

describe('原型污染防护 · rowsToSafeObjects', () => {
  it('表头写 __proto__ 不能污染原型', () => {
    const out = rowsToSafeObjects([['__proto__', 'name'], ['{"polluted":true}', 'a']]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(out[0]!)).not.toContain('__proto__');
  });

  it.each(['__proto__', 'prototype', 'constructor'])('危险表头 %s 被换成 column_N', (bad) => {
    const out = rowsToSafeObjects([[bad], ['v']]);
    expect(Object.keys(out[0]!)).toEqual(['column_1']);
  });

  it('产出的对象没有原型 —— 后续 obj.toString 之类不会意外命中', () => {
    const out = rowsToSafeObjects([['a'], ['1']]);
    expect(Object.getPrototypeOf(out[0]!)).toBeNull();
  });

  it('重名表头自动加后缀, 不互相覆盖', () => {
    const out = rowsToSafeObjects([['name', 'name', 'name'], ['x', 'y', 'z']]);
    expect(out[0]).toEqual({ name: 'x', name_2: 'y', name_3: 'z' });
  });

  it('空表头用 column_N 兜底', () => {
    const out = rowsToSafeObjects([['', '  '], ['x', 'y']]);
    expect(Object.keys(out[0]!)).toEqual(['column_1', 'column_2']);
  });

  it('行比表头短时补 null, 不越界', () => {
    const out = rowsToSafeObjects([['a', 'b', 'c'], ['1']]);
    expect(out[0]).toEqual({ a: '1', b: null, c: null });
  });

  it('空输入不抛', () => {
    expect(rowsToSafeObjects([])).toEqual([]);
  });
});

describe('转义', () => {
  it('escapeHtml 必须先转 & —— 顺序错了会把已转义的实体再转一遍', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
    /* 关键: & 先转, 所以 "<" 产出的 &lt; 里那个 & 不会被二次转义 */
    expect(escapeHtml('<')).toBe('&lt;');
  });

  it('escapeHtml 处理引号 (属性上下文)', () => {
    expect(escapeHtml('"x"')).toBe('&quot;x&quot;');
    expect(escapeHtml("'x'")).toBe('&#39;x&#39;');
  });

  it('escapeMarkdownCell 转义竖线, 否则会撑破表格', () => {
    expect(escapeMarkdownCell('a|b')).toBe('a\\|b');
  });

  it('escapeMarkdownCell 把换行压成空格, 否则单元格会跨行', () => {
    expect(escapeMarkdownCell('a\nb')).toBe('a b');
    expect(escapeMarkdownCell('a\r\n\r\nb')).toBe('a b');
  });

  it('null / undefined 转成空串不抛', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeMarkdownCell(undefined)).toBe('');
  });
});

describe('体积与数量上限', () => {
  it('超过 maxBytes 抛错', () => {
    const big = new ArrayBuffer(EXCEL_SAFETY_LIMITS.maxBytes + 1);
    expect(() => assertExcelBufferSafe(big)).toThrow(/too large/);
  });

  it('刚好等于上限不抛 (边界是 > 不是 >=)', () => {
    expect(() => assertExcelBufferSafe(new ArrayBuffer(EXCEL_SAFETY_LIMITS.maxBytes))).not.toThrow();
  });

  it('工作表数量被截断', () => {
    const wb = { SheetNames: Array.from({ length: 100 }, (_, i) => `S${i}`) };
    expect(safeSheetNames(wb)).toHaveLength(EXCEL_SAFETY_LIMITS.maxSheets);
  });

  it('工作表名缺失/畸形不抛', () => {
    expect(safeSheetNames({})).toEqual([]);
    expect(safeSheetNames(null)).toEqual([]);
    expect(safeSheetNames({ SheetNames: 'not-an-array' })).toEqual([]);
  });

  it('工作表标题去掉换行制表符并截断', () => {
    expect(safeSheetTitle('a\n\tb')).toBe('a b');
    expect(safeSheetTitle('x'.repeat(300))).toHaveLength(120);
    expect(safeSheetTitle(null)).toBe('Sheet');
  });
});

describe('boundedSheetRange · 行列爆炸防护', () => {
  /* 用最小假 XLSX, 只实现用到的两个工具函数 */
  const XLSX = {
    utils: {
      decode_range: (ref: string) => {
        const [a, b] = ref.split(':');
        const parse = (s: string) => ({ c: s.charCodeAt(0) - 65, r: Number(s.slice(1)) - 1 });
        return { s: parse(a!), e: parse(b!) };
      },
      encode_range: (r: any) =>
        `${String.fromCharCode(65 + r.s.c)}${r.s.r + 1}:${String.fromCharCode(65 + r.e.c)}${r.e.r + 1}`,
    },
  };

  it('行数被截到上限', () => {
    const out = boundedSheetRange(XLSX, { '!ref': 'A1:B99999' }, 10, 200);
    expect(out).toBe('A1:B10');
  });

  it('列数被截到上限', () => {
    const out = boundedSheetRange(XLSX, { '!ref': 'A1:Z50' }, 5000, 3);
    expect(out).toBe('A1:C50');
  });

  it('本来就小的表不动', () => {
    expect(boundedSheetRange(XLSX, { '!ref': 'A1:B5' }, 5000, 200)).toBe('A1:B5');
  });

  it('没有 !ref 返回 undefined (调用方据此不传 range)', () => {
    expect(boundedSheetRange(XLSX, {})).toBeUndefined();
  });

  it('!ref 畸形时吞掉异常返回 undefined, 不让整个解析崩掉', () => {
    const boom = { utils: { decode_range: () => { throw new Error('bad ref'); }, encode_range: () => '' } };
    expect(boundedSheetRange(boom, { '!ref': 'garbage' })).toBeUndefined();
  });
});

describe('读取选项必须关掉危险特性', () => {
  it.each(['cellFormula', 'cellHTML', 'bookVBA', 'cellStyles', 'bookDeps', 'WTF'] as const)(
    '%s 必须为 false', (k) => {
      expect(SAFE_XLSX_READ_OPTIONS[k]).toBe(false);
    });
});
