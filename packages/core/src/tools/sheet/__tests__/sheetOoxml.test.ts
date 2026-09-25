/**
 * sheetOoxml —— 原地改 .xlsx: 样式/公式/其它零件不动, 只动要改的格。
 * fixture 用 JSZip 现造一份最小但结构完整的 xlsx (含 calcChain / sharedStrings / 两个 sheet / 图表零件)。
 */
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import {
  parseCellRef, colToNumber, numberToCol, setCellsInSheetXml, ensureFullCalcOnLoad, editXlsxBuffer, listSheets, readSharedStrings,
} from '../sheetOoxml.js';

const SHEET1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B4"/><sheetData>
<row r="1" spans="1:2"><c r="A1" s="1" t="s"><v>0</v></c><c r="B1" s="1" t="s"><v>1</v></c></row>
<row r="2" spans="1:2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="2"><v>100</v></c></row>
<row r="3" spans="1:2"><c r="A3" t="s"><v>3</v></c><c r="B3" s="2"><v>200</v></c></row>
<row r="4" spans="1:2"><c r="A4" t="s"><v>4</v></c><c r="B4" s="3"><f>SUM(B2:B3)</f><v>300</v></c></row>
</sheetData><mergeCells count="1"><mergeCell ref="A6:B6"/></mergeCells></worksheet>`;

const SHEET2 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1"><f>Data!B4*2</f><v>600</v></c></row>
<row r="2"><c r="A2"><f t="shared" ref="A2:A4" si="0">Data!B2+1</f><v>101</v></c></row>
<row r="3"><c r="A3"><f t="shared" si="0"/><v>201</v></c></row>
</sheetData></worksheet>`;

async function fixture(): Promise<Buffer> {
  const z = new JSZip();
  z.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/></Types>`);
  z.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  z.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Summary &amp; 汇总" sheetId="2" r:id="rId2"/></sheets><definedNames><definedName name="Total">Data!$B$4</definedName></definedNames><calcPr calcId="191029"/></workbook>`);
  z.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/></Relationships>`);
  z.file('xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="5" uniqueCount="5"><si><t>项目</t></si><si><t>金额</t></si><si><t>一月</t></si><si><r><t>二</t></r><r><rPr><b/></rPr><t>月</t></r></si><si><t>合计</t></si></sst>`);
  z.file('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts><fonts count="2"><font><sz val="11"/></font><font><b/><sz val="11"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="4"><xf/><xf fontId="1" applyFont="1"/><xf numFmtId="164" applyNumberFormat="1"/><xf numFmtId="164" fontId="1" applyNumberFormat="1" applyFont="1"/></cellXfs></styleSheet>`);
  z.file('xl/calcChain.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><c r="B4" i="1"/><c r="A1" i="2"/></calcChain>`);
  z.file('xl/worksheets/sheet1.xml', SHEET1);
  z.file('xl/worksheets/sheet2.xml', SHEET2);
  z.file('xl/charts/chart1.xml', '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"/>');
  return z.generateAsync({ type: 'nodebuffer' });
}

describe('坐标', () => {
  it('列字母 ↔ 数字, 地址规范化', () => {
    expect(colToNumber('A')).toBe(1);
    expect(colToNumber('AA')).toBe(27);
    expect(numberToCol(703)).toBe('AAA');
    expect(parseCellRef('$b$3')).toEqual({ col: 2, row: 3, ref: 'B3' });
    expect(parseCellRef('3B')).toBeNull();
  });
});

describe('setCellsInSheetXml', () => {
  it('改数保样式; 公式格不动; 新列按顺序插进行里', () => {
    const r = setCellsInSheetXml(SHEET1, [{ cell: 'B2', value: '150' }, { cell: 'C2', value: '备注 & <x>' }]);
    expect(r.xml).toContain('<c r="B2" s="2"><v>150</v></c>');
    expect(r.xml).toMatch(/<c r="B2"[^>]*>.*<\/c><c r="C2" t="inlineStr"><is><t>备注 &amp; &lt;x&gt;<\/t><\/is><\/c><\/row>/);
    expect(r.xml).toContain('<f>SUM(B2:B3)</f>');
    expect(r.formulasTouched).toBe(false);
    expect(r.changes[0]).toEqual({ cell: 'B2', before: '100', after: '150' });
    expect(r.xml).toContain('<dimension ref="A1:C4"/>');
    expect(r.xml).toContain('<mergeCell ref="A6:B6"/>');
  });

  it('公式格默认不许写成值; 显式允许才写', () => {
    const r1 = setCellsInSheetXml(SHEET1, [{ cell: 'B4', value: '999' }]);
    expect(r1.changes).toHaveLength(0);
    expect(r1.skipped[0].reason).toMatch(/公式/);
    const r2 = setCellsInSheetXml(SHEET1, [{ cell: 'B4', value: '999' }], { overwriteFormulas: true });
    expect(r2.xml).toContain('<c r="B4" s="3"><v>999</v></c>');
    expect(r2.formulasTouched).toBe(true);
  });

  it('写公式 / 新行按行号插 / 清空保样式 / 布尔', () => {
    const r = setCellsInSheetXml(SHEET1, [
      { cell: 'B5', formula: '=B4*1.1' },
      { cell: 'A10', value: true },
      { cell: 'B3', value: '' },
    ]);
    expect(r.xml).toContain('<row r="5"><c r="B5"><f>B4*1.1</f></c></row>');
    expect(r.xml.indexOf('<row r="5">')).toBeGreaterThan(r.xml.indexOf('<row r="4"'));
    expect(r.xml).toContain('<row r="10"><c r="A10" t="b"><v>1</v></c></row>');
    expect(r.xml).toContain('<c r="B3" s="2"/>');
    expect(r.formulasTouched).toBe(true);
  });

  it('共享公式主格 / 数组公式永远拒', () => {
    const r = setCellsInSheetXml(SHEET2, [{ cell: 'A2', formula: '=1' }], { overwriteFormulas: true });
    expect(r.changes).toHaveLength(0);
    expect(r.skipped[0].reason).toMatch(/共享公式/);
  });

  it('before 能读出共享字符串 (富文本多段拼起来); 文本里的空格和 & 原样保留', () => {
    const shared = readSharedStrings('<sst><si><t>项目</t></si><si><t>金额</t></si><si><t>一月</t></si><si><r><t>二</t></r><r><rPr><b/></rPr><t>月</t></r></si></sst>');
    expect(shared[3]).toBe('二月');
    const r = setCellsInSheetXml(SHEET1, [{ cell: 'A3', value: '三 月 & Co' }], { sharedStrings: shared });
    expect(r.changes[0]).toEqual({ cell: 'A3', before: '二月', after: '三 月 & Co' });
    expect(r.xml).toContain('<t>三 月 &amp; Co</t>');
  });
});

describe('workbook 级', () => {
  it('fullCalcOnLoad: 已有 calcPr 加属性, 没有就按 schema 顺序插', () => {
    expect(ensureFullCalcOnLoad('<workbook><sheets/><calcPr calcId="1"/></workbook>')).toContain('<calcPr fullCalcOnLoad="1" calcId="1"/>');
    expect(ensureFullCalcOnLoad('<workbook><sheets/><definedNames/><extLst/></workbook>')).toBe('<workbook><sheets/><definedNames/><calcPr fullCalcOnLoad="1"/><extLst/></workbook>');
  });

  it('sheet 名 (含转义) → 包内路径', async () => {
    const z = await JSZip.loadAsync(await fixture());
    const sheets = listSheets(await z.file('xl/workbook.xml')!.async('string'), await z.file('xl/_rels/workbook.xml.rels')!.async('string'));
    expect(sheets).toEqual([{ name: 'Data', path: 'xl/worksheets/sheet1.xml' }, { name: 'Summary & 汇总', path: 'xl/worksheets/sheet2.xml' }]);
  });
});

describe('editXlsxBuffer 端到端', () => {
  it('只改值: 其它零件原样, calcChain 留着, SheetJS 读得出新值和原公式', async () => {
    const src = await fixture();
    const { out, result } = await editXlsxBuffer(src, 'Data', [{ cell: 'B2', value: 150 }]);
    expect(result.changes).toHaveLength(1);
    const z0 = await JSZip.loadAsync(src); const z1 = await JSZip.loadAsync(out!);
    for (const p of ['xl/styles.xml', 'xl/sharedStrings.xml', 'xl/worksheets/sheet2.xml', 'xl/charts/chart1.xml', 'xl/calcChain.xml']) {
      expect(await z1.file(p)!.async('string')).toBe(await z0.file(p)!.async('string'));
    }
    expect(await z1.file('xl/workbook.xml')!.async('string')).toContain('fullCalcOnLoad="1"');
    expect(await z1.file('xl/workbook.xml')!.async('string')).toContain('<definedName name="Total">');
    const wb = XLSX.read(out!, { type: 'buffer', cellFormula: true });
    expect(wb.Sheets.Data.B2.v).toBe(150);
    expect(wb.Sheets.Data.B4.f).toBe('SUM(B2:B3)');
  });

  it('动了公式: calcChain 连关系和 content type 一起删', async () => {
    const { out } = await editXlsxBuffer(await fixture(), undefined, [{ cell: 'C4', formula: 'B4/2' }]);
    const z = await JSZip.loadAsync(out!);
    expect(z.file('xl/calcChain.xml')).toBeNull();
    expect(await z.file('xl/_rels/workbook.xml.rels')!.async('string')).not.toContain('calcChain');
    expect(await z.file('[Content_Types].xml')!.async('string')).not.toContain('calcChain');
    /* 新写的公式格没有缓存值 (打开时算), SheetJS 要 sheetStubs 才读得到 */
    expect(XLSX.read(out!, { type: 'buffer', cellFormula: true, sheetStubs: true }).Sheets.Data.C4.f).toBe('B4/2');
  });

  it('全被拒 → 不产出新包; sheet 名不存在 → 报错列出可用的', async () => {
    const r = await editXlsxBuffer(await fixture(), 'Data', [{ cell: 'B4', value: 1 }]);
    expect(r.out).toBeNull();
    await expect(editXlsxBuffer(await fixture(), 'Nope', [{ cell: 'A1', value: 1 }])).rejects.toThrow(/Data, Summary & 汇总/);
  });
});
