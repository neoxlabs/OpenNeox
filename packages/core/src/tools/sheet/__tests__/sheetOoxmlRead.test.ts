/**
 * work O-04: 读旧表统一走 OOXML 保公式。
 *
 * 三条验收:
 *   1. 公式读取率 100% —— 普通公式 / 共享公式的从属格 / 只有 <f> 没有缓存值的格, 一个都不能漏;
 *   2. 旧路径删除 —— SAFE_XLSX_FILE_READ_OPTIONS 里不再有 cellFormula:false;
 *   3. 读出来的显示效果不下降 —— 有缓存值的格在 markdown 表里仍然是那个值 (不是公式文本)。
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { parseSheetFormulas, readXlsxFormulas, translateFormula } from '../sheetOoxmlRead.js';
import { SAFE_XLSX_FILE_READ_OPTIONS } from '../sheetSafety.js';
import { sheetGetRangeTool } from '../sheetTools.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ooxml-read-'));
afterAll(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

/** 用 JSZip 手搓一个最小 .xlsx —— 这样才能造出「只有 <f> 没有 <v>」的格。 */
async function makeMinimalXlsx(sheetXml: string): Promise<Buffer> {
  const zip = new JSZip();
  /* [Content_Types].xml + 包级 rels 必须给: SheetJS 靠它们认包类型 (缺了报 Unsupported ZIP file) */
  zip.file('[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    + '</Types>');
  zip.file('_rels/.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
    + 'Target="xl/workbook.xml"/></Relationships>');
  zip.file('xl/workbook.xml',
    '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
    + 'Target="worksheets/sheet1.xml"/></Relationships>');
  zip.file('xl/worksheets/sheet1.xml', sheetXml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

const SHEET_HEAD = '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';

describe('translateFormula (共享公式从属格平移)', () => {
  it('相对引用按行列偏移平移, 绝对引用不动', () => {
    expect(translateFormula('B2*C2', { row: 2, col: 2 }, { row: 5, col: 2 })).toBe('B5*C5');
    expect(translateFormula('$B$2*C2', { row: 2, col: 2 }, { row: 4, col: 3 })).toBe('$B$2*D4');
    /* 列也平移: B(2) + 2 = D, 行不动 (B$2 的行是绝对的) */
    expect(translateFormula('$B2+B$2', { row: 2, col: 2 }, { row: 3, col: 4 })).toBe('$B3+D$2');
  });

  it('函数名不当成引用; 引号里的内容不动', () => {
    expect(translateFormula('SUM(B1:B2)', { row: 1, col: 2 }, { row: 4, col: 2 })).toBe('SUM(B4:B5)');
    expect(translateFormula('LOG10(A1)', { row: 1, col: 1 }, { row: 2, col: 1 })).toBe('LOG10(A2)');
    expect(translateFormula('IF(A1="A1","A1",A1)', { row: 1, col: 1 }, { row: 2, col: 1 }))
      .toBe('IF(A2="A1","A1",A2)');
  });

  it('平移出界变 #REF!', () => {
    expect(translateFormula('A1', { row: 2, col: 1 }, { row: 1, col: 1 })).toBe('#REF!');
  });
});

describe('parseSheetFormulas', () => {
  it('普通公式 / 共享公式主格与从属格 / 无缓存值的公式格都能拿到', () => {
    const xml = SHEET_HEAD
      + '<row r="2"><c r="B2"><v>100</v></c><c r="C2"><v>2</v></c>'
      /* 共享公式: 主格在 D2 (带 ref 与公式体), 从属格 D3/D4 只有 si */
      + '<c r="D2"><f t="shared" ref="D2:D4" si="0">B2*C2</f><v>200</v></c></row>'
      + '<row r="3"><c r="B3"><v>200</v></c><c r="C3"><v>3</v></c>'
      + '<c r="D3"><f t="shared" si="0"/><v>600</v></c></row>'
      + '<row r="4"><c r="D4"><f t="shared" si="0"/></c></row>'
      + '<row r="5"><c r="B5"><v>300</v></c><c r="C5"><f>SUM(B2:B4)</f></c></row>'
      + '</sheetData></worksheet>';
    const formulas = parseSheetFormulas(xml);
    const map = new Map(formulas.map((f) => [f.cell, f.formula]));

    expect(map.get('D2')).toBe('B2*C2');
    expect(map.get('D3')).toBe('B3*C3');
    expect(map.get('D4')).toBe('B4*C4');
    expect(map.get('C5')).toBe('SUM(B2:B4)');
    expect(formulas.filter((f) => f.shared).map((f) => f.cell)).toEqual(['D3', 'D4']);
  });

  it('没有 sheetData 时返回空数组', () => {
    expect(parseSheetFormulas('<worksheet/>')).toEqual([]);
  });
});

describe('读表路径: 公式一律带上, 显示值不变', () => {
  it('旧路径已删: 读选项里不再有 cellFormula', () => {
    expect('cellFormula' in SAFE_XLSX_FILE_READ_OPTIONS).toBe(false);
  });

  it('readXlsxFormulas 读 SheetJS 生成的表 (含缓存值)', async () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['月份', '金额'],
      ['1月', 100],
      ['2月', 200],
      ['合计', null],
    ]);
    ws.B4 = { t: 'n', f: 'SUM(B2:B3)', v: 300 };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const file = path.join(tmpRoot, 'formula.xlsx');
    XLSX.writeFile(wb, file, { bookType: 'xlsx' });

    const sheets = await readXlsxFormulas(file);
    expect(sheets).toHaveLength(1);
    expect(sheets[0].name).toBe('Sheet1');
    expect(sheets[0].formulas).toEqual([{ cell: 'B4', formula: 'SUM(B2:B3)' }]);
  });

  it('readXlsxFormulas 能读到只有 <f> 没有缓存值的格', async () => {
    const file = path.join(tmpRoot, 'nocache.xlsx');
    fs.writeFileSync(file, await makeMinimalXlsx(
      SHEET_HEAD + '<row r="2"><c r="B2"><f>1+1</f></c></row></sheetData></worksheet>',
    ));
    const sheets = await readXlsxFormulas(file);
    expect(sheets[0].formulas).toEqual([{ cell: 'B2', formula: '1+1' }]);
  });

  it('sheet_get_range: 表格里仍是缓存值, 底部列出公式 (不传 include_formulas 也有)', async () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['月份', '金额'],
      ['1月', 100],
      ['2月', 200],
      ['合计', null],
    ]);
    ws.B4 = { t: 'n', f: 'SUM(B2:B3)', v: 300 };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const file = path.join(tmpRoot, 'range.xlsx');
    XLSX.writeFile(wb, file, { bookType: 'xlsx' });

    const out = await (sheetGetRangeTool as any).function({ file_path: file });
    /* 值照旧 (输出没退) */
    expect(out).toContain('| 合计 | 300 |');
    /* 公式必须列出来 */
    expect(out).toContain('Formulas (1)');
    expect(out).toContain('B4: =SUM(B2:B3)   (cached: 300)');
  });

  it('sheet_get_range: 没缓存值的公式格在表格里显示 =公式 而不是空', async () => {
    const file = path.join(tmpRoot, 'nocache-range.xlsx');
    fs.writeFileSync(file, await makeMinimalXlsx(
      SHEET_HEAD
      + '<row r="1"><c r="A1" t="inlineStr"><is><t>合计</t></is></c>'
      + '<c r="B1"><f>1+2</f></c></row>'
      + '</sheetData></worksheet>',
    ));
    const out = await (sheetGetRangeTool as any).function({ file_path: file });
    expect(out).toContain('=1+2');
    expect(out).toContain('B1: =1+2');
  });

  it('没有公式的表: 输出不带 Formulas 段 (跟改动前一致)', async () => {
    const ws = XLSX.utils.aoa_to_sheet([['a', 'b'], [1, 2]]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const file = path.join(tmpRoot, 'plain.xlsx');
    XLSX.writeFile(wb, file, { bookType: 'xlsx' });

    const out = await (sheetGetRangeTool as any).function({ file_path: file });
    expect(out).not.toContain('Formulas');
    expect(out).toContain('| 1 | 2 |');
  });
});
