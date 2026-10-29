/**
 * WorkReceiptNote 渲染 —— 回执旁注 (work:R-02 / R-05 / R-07)
 *
 * 只测「说了什么」: 对得上的数字带出处、对不上的挑出来、失败时三行、
 * 没什么可说的时候一个字都不多出 (不打扰)。
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, test, expect } from 'vitest';
import { WorkReceiptNote } from '../cells/WorkReceiptNote';
import type { ReceiptNote } from '../workReceipt';

const verifiedNote: ReceiptNote = {
  failure: null,
  verifiedNumbers: [{ raw: '412.6 万', source: { value: 4126000, raw: '4126000', file: '/w/周报.xlsx', cell: 'B14' } }],
  unmatchedNumbers: [],
  unmatchedPaths: [],
};

describe('WorkReceiptNote', () => {
  test('核对上的数字连出处一起显示', () => {
    const html = renderToStaticMarkup(<WorkReceiptNote note={verifiedNote} zh />);
    expect(html).toContain('数字核对过');
    expect(html).toContain('412.6 万');
    expect(html).toContain('周报.xlsx');
    expect(html).toContain('B14');
  });

  test('对不上的数字 / 文件说一句, 带提示', () => {
    const html = renderToStaticMarkup(
      <WorkReceiptNote note={{ failure: null, verifiedNumbers: [], unmatchedNumbers: ['8.3%'], unmatchedPaths: ['旧稿.docx'] }} zh />,
    );
    expect(html).toContain('没找到出处');
    expect(html).toContain('8.3%');
    expect(html).toContain('旧稿.docx');
    expect(html).toContain('title=');
  });

  test('失败时三行, 不贴堆栈', () => {
    const html = renderToStaticMarkup(
      <WorkReceiptNote
        note={{
          failure: { failedStep: '修改表格「周报」', tried: '试了 2 次「修改表格」', suggestion: '告诉我要改哪一处, 或者让我重试这一步' },
          verifiedNumbers: [], unmatchedNumbers: [], unmatchedPaths: [],
        }}
        zh
      />,
    );
    expect(html).toContain('哪一步没过');
    expect(html).toContain('我试了什么');
    expect(html).toContain('建议你怎么走');
    expect(html).toContain('修改表格「周报」');
    expect(html).not.toContain('at ');
  });

  test('英文文案', () => {
    const html = renderToStaticMarkup(
      <WorkReceiptNote
        note={{ failure: { failedStep: 'Edit sheet “Weekly”', tried: 'tried once', suggestion: 'Retry this step' }, verifiedNumbers: [], unmatchedNumbers: [], unmatchedPaths: [] }}
        zh={false}
      />,
    );
    expect(html).toContain('Where it stopped');
    expect(html).toContain('What I tried');
    expect(html).toContain('What you can do');
  });

  test('没什么可说时一个字都不多出', () => {
    const html = renderToStaticMarkup(
      <WorkReceiptNote note={{ failure: null, verifiedNumbers: [], unmatchedNumbers: [], unmatchedPaths: [] }} zh />,
    );
    expect(html).toBe('');
  });
});
