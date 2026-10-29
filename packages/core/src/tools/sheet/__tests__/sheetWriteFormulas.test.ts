import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import JSZip from 'jszip';
import { sheetNewWorkbookTool, sheetWriteRangeTool, sheetExportFileTool } from '../sheetWriteTools.js';

const call = async (tool: any, args: any) => JSON.parse(String(await tool.function(args)));

describe('sheet_write_range 写公式', () => {
  it('= 开头的字符串导出后是 <f>, 普通文本和数字不受影响', async () => {
    const { workbook_id } = await call(sheetNewWorkbookTool, {});
    const w = await call(sheetWriteRangeTool, {
      workbook_id, range: 'A1',
      data: [['月份', '收入', '成本', '利润'], ['7月', 100, 80, '=B2-C2'], ['合计', '=SUM(B2:B2)', '=SUM(C2:C2)', '=SUM(D2:D2)']],
    });
    expect(w.formulas).toBe(4);
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neox-sheet-')), 't.xlsx');
    const e = await call(sheetExportFileTool, { workbook_id, save_path: out });
    expect(e.error).toBeUndefined();
    const zip = await JSZip.loadAsync(fs.readFileSync(out));
    const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    expect(xml).toContain('<f>B2-C2</f>');
    expect(xml).toContain('<f>SUM(B2:B2)</f>');
    expect(xml).not.toContain('=B2-C2');
  });
});
