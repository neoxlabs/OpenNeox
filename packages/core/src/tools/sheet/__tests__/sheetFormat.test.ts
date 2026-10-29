/**
 * O-01 新建表带格式: 加粗 / 底色 / 对齐 / 列宽 / 数字格式。
 *
 * 断言用库读回生成的 .xlsx (JSZip 看 OOXML、SheetJS 看值与列宽), 不看我们自己写的中间态 ——
 * 格式化改的是导出字节, 只有读回才算数。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { sheetNewWorkbookTool, sheetWriteRangeTool, sheetExportFileTool } from '../sheetWriteTools.js';
import { normalizeSheetStyle } from '../sheetXlsxFormat.js';

const call = async (tool: any, args: any) => JSON.parse(String(await tool.function(args)));

async function buildExport(writeArgs: Record<string, unknown>): Promise<{
  file: string; sheetXml: string; stylesXml: string;
}> {
  const { workbook_id } = await call(sheetNewWorkbookTool, {});
  const w = await call(sheetWriteRangeTool, { workbook_id, range: 'A1', ...writeArgs });
  expect(w.error).toBeUndefined();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-sheet-fmt-'));
  const file = path.join(dir, 'report.xlsx');
  const e = await call(sheetExportFileTool, { workbook_id, save_path: file });
  expect(e.error).toBeUndefined();
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  return {
    file,
    sheetXml: await zip.file('xl/worksheets/sheet1.xml')!.async('string'),
    stylesXml: await zip.file('xl/styles.xml')!.async('string'),
  };
}

/** 某个地址的 s 属性 → cellXfs 里那一条 */
function xfOf(sheetXml: string, stylesXml: string, ref: string): string {
  const cell = new RegExp(`<c\\b[^>]*\\br="${ref}"[^>]*>`).exec(sheetXml)?.[0];
  expect(cell, `${ref} 没有单元格`).toBeTruthy();
  const s = /\bs="(\d+)"/.exec(cell!)?.[1];
  expect(s, `${ref} 没有样式索引`).toBeTruthy();
  const xfs = [...stylesXml.matchAll(/<xf\b[\s\S]*?(?:\/>|<\/xf>)/g)].map((m) => m[0]);
  /* cellXfs 里的 xf 在 cellStyleXfs 之后; 用最后一次出现的位置取准确的那组 */
  const cellXfsBlock = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? '';
  const list = [...cellXfsBlock.matchAll(/<xf\b[\s\S]*?(?:\/>|<\/xf>)/g)].map((m) => m[0]);
  expect(list.length).toBeGreaterThan(Number(s));
  expect(xfs.length).toBeGreaterThan(0);
  return list[Number(s)]!;
}

describe('normalizeSheetStyle', () => {
  it('认格式预设与自定义格式串; 不认识的值折成 warning 不静默吞', () => {
    expect(normalizeSheetStyle({ bold: true, bg: '#d9e1f2', align: 'center', num: 'currency' }).style)
      .toEqual({ bold: true, bg: 'D9E1F2', align: 'center', num: 'currency' });
    expect(normalizeSheetStyle({ num: '0.0"%"' }).style.num).toBe('0.0"%"');
    const bad = normalizeSheetStyle({ bg: 'blue', align: 'middle', num: 'money', foo: 1 });
    expect(bad.style).toEqual({});
    expect(bad.warnings.join('\n')).toMatch(/bg/);
    expect(bad.warnings.join('\n')).toMatch(/align/);
    expect(bad.warnings.join('\n')).toMatch(/num/);
    expect(bad.warnings.join('\n')).toMatch(/foo/);
  });
});

describe('sheet_write_range 格式 → 导出的 .xlsx', () => {
  it('表头加粗 + 底色, 数据列千分位, 列宽都落到 XML 里, 值不变', async () => {
    const { file, sheetXml, stylesXml } = await buildExport({
      data: [['区域', '营收'], ['华东', 1234567.5], ['华南', 890000]],
      header: { bold: true, bg: 'D9E1F2', align: 'center' },
      style: { num: 'thousands' },
      col_widths: [22, 16],
    });

    /* 表头: 加粗字体 + 实心底色 + 居中 */
    const headXf = xfOf(sheetXml, stylesXml, 'A1');
    const headFont = Number(/\bfontId="(\d+)"/.exec(headXf)![1]);
    const headFill = Number(/\bfillId="(\d+)"/.exec(headXf)![1]);
    expect(headFont).toBeGreaterThan(0);
    expect(headFill).toBeGreaterThan(0);
    expect(headXf).toContain('horizontal="center"');
    const fonts = /<fonts\b[^>]*>([\s\S]*?)<\/fonts>/.exec(stylesXml)![1];
    expect(fonts).toMatch(/<b\/>/);
    const fills = /<fills\b[^>]*>([\s\S]*?)<\/fills>/.exec(stylesXml)![1];
    expect(fills).toContain('rgb="FFD9E1F2"');

    /* 数据区: 千分位 (内建 numFmtId 4 = #,##0.00) */
    expect(xfOf(sheetXml, stylesXml, 'B2')).toContain('numFmtId="4"');
    expect(xfOf(sheetXml, stylesXml, 'B3')).toContain('numFmtId="4"');

    /* 列宽 */
    expect(sheetXml).toMatch(/<col min="1" max="1" width="2[0-9.]+" customWidth="1"\/>/);
    expect(sheetXml).toMatch(/<col min="2" max="2" width="1[0-9.]+" customWidth="1"\/>/);

    /* 值读回不变 (格式不该动数据) */
    const wb = XLSX.read(fs.readFileSync(file), { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]!]!;
    expect(ws.B2!.v).toBe(1234567.5);
    expect(ws.A2!.v).toBe('华东');
  });

  it('百分比 / 货币 / 日期三种数字格式各自写出正确的 numFmt', async () => {
    const percent = await buildExport({
      data: [['占比'], [0.256]], style: { num: 'percent' },
    });
    expect(xfOf(percent.sheetXml, percent.stylesXml, 'A2')).toContain('numFmtId="10"');

    const money = await buildExport({
      data: [['金额'], [1999]], style: { num: 'currency' },
    });
    const moneyXf = xfOf(money.sheetXml, money.stylesXml, 'A2');
    const moneyId = Number(/\bnumFmtId="(\d+)"/.exec(moneyXf)![1]);
    expect(moneyId).toBeGreaterThanOrEqual(164);
    expect(money.stylesXml).toMatch(/<numFmt numFmtId="\d+" formatCode="&quot;¥&quot;#,##0\.00"\/>/);

    const date = await buildExport({
      data: [['日期'], [45292]], style: { num: 'date' },
    });
    expect(date.stylesXml).toContain('yyyy-mm-dd');
    expect(xfOf(date.sheetXml, date.stylesXml, 'A2')).toMatch(/numFmtId="1[6-9]\d"/);
  });

  it('区域里的空格也补出底色 (整片色块不留洞)', async () => {
    const { sheetXml, stylesXml } = await buildExport({
      data: [['合计', null, null], [null, 100, 200]],
      style: { bg: 'FFF2CC' },
    });
    /* B1 / C1 原本没有 <c>, 补成带样式的空格 */
    expect(sheetXml).toMatch(/<c r="B1" s="\d+"\/>/);
    expect(sheetXml).toMatch(/<c r="C1" s="\d+"\/>/);
    expect(xfOf(sheetXml, stylesXml, 'B1')).toBeTruthy();
  });

  it('不给格式时不动样式表 (默认表格仍然只有一份 cellXfs)', async () => {
    const { stylesXml } = await buildExport({ data: [['a'], [1]] });
    const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)![1];
    expect((cellXfs.match(/<xf\b/g) ?? []).length).toBe(1);
  });
});
