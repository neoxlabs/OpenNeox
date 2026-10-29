/**
 * work O-22 契约回归: open_surface 真的接上了 xlsx / docx 交付结构闸门。
 *
 * 直接调工具 (跟 todoContract.test.ts 同一套调法), 验三件事:
 *   1. 本次进程写出来的坏文件 → 工具层就拦, 不落 tab, 把问题清单回给模型;
 *   2. 本次进程写出来的干净文件 → 放行, 且回执里 selfCheck.passed === true;
 *   3. 用户自己带进来的坏文件 → 放行 (selfCheck.passed === null), 只附报告。
 */
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import JSZip from 'jszip';
import { openSurfaceTool } from '../openSurfaceTool.js';
import { SURFACE_MARKER } from '../surfaceTypes.js';
import { markNeoxWritten, resetNeoxWrittenRegistry } from '../../delivery/deliveryProvenance.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'office-gate-contract-'));
afterAll(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });
beforeEach(() => resetNeoxWrittenRegistry());

const call = async (tool: any, args: any): Promise<any> => JSON.parse(await tool.function(args));

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

async function writeXlsx(file: string, sheetBody: string): Promise<void> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    + '</Types>');
  zip.file('_rels/.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + `<Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file('xl/workbook.xml',
    `<?xml version="1.0"?><workbook xmlns="${NS}" xmlns:r="${R}"><sheets>`
    + '<sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + `<Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`);
  zip.file('xl/worksheets/sheet1.xml', `<worksheet xmlns="${NS}"><sheetData>${sheetBody}</sheetData></worksheet>`);
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
}

async function writeDocx(file: string, body: string): Promise<void> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>');
  zip.file('_rels/.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + `<Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/document.xml',
    `<?xml version="1.0"?><w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}</w:body></w:document>`);
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
}

const para = (t: string) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;

describe('open_surface · xlsx 交付闸门', () => {
  it('我们写的坏表 (#REF!) → 工具层拦截, 不落 tab', async () => {
    const file = path.join(tmpRoot, 'bad.xlsx');
    await writeXlsx(file, '<row r="1"><c r="A1" t="e"><v>#REF!</v></c></row>');
    markNeoxWritten(file);
    const r = await call(openSurfaceTool, { kind: 'sheet', source: { type: 'file', path: file } });
    expect(r.error).toContain('交付闸门拦截');
    expect(r.mustFixCount).toBeGreaterThan(0);
    expect(r.next).toContain('open_surface');
    expect(r[SURFACE_MARKER]).toBeUndefined();
  });

  it('我们写的干净表 → 放行, 回执 selfCheck.passed=true', async () => {
    const file = path.join(tmpRoot, 'ok.xlsx');
    await writeXlsx(file, '<row r="1"><c r="A1"><v>1</v></c></row>');
    markNeoxWritten(file);
    const r = await call(openSurfaceTool, { kind: 'sheet', source: { type: 'file', path: file } });
    expect(r[SURFACE_MARKER]).toBe(true);
    expect(r.selfCheck.available).toBe(true);
    expect(r.selfCheck.passed).toBe(true);
    expect(r.selfCheck.format).toBe('xlsx');
  });

  it('用户带进来的坏表 → 不拦, 只附报告 (passed=null)', async () => {
    const file = path.join(tmpRoot, 'user-bad.xlsx');
    await writeXlsx(file, '<row r="1"><c r="A1" t="e"><v>#VALUE!</v></c></row>');
    const r = await call(openSurfaceTool, { kind: 'sheet', source: { type: 'file', path: file } });
    expect(r[SURFACE_MARKER]).toBe(true);
    expect(r.selfCheck.passed).toBe(null);
    expect(r.selfCheck.mustFixCount).toBeGreaterThan(0);
  });
});

describe('open_surface · docx 交付闸门', () => {
  it('我们写的空页文档 → 工具层拦截', async () => {
    const file = path.join(tmpRoot, 'blank.docx');
    await writeDocx(file, para('一') + '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' + '<w:p/>'
      + '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' + para('三'));
    markNeoxWritten(file);
    const r = await call(openSurfaceTool, { kind: 'docx', source: { type: 'file', path: file } });
    expect(r.error).toContain('交付闸门拦截');
    /* work:H-19 — issues 现在是「一行一条、带定位」的字符串, 不再是对象数组 */
    expect(r.issues.some((i: string) => i.includes('blank_page'))).toBe(true);
    expect(r.issues.join('\n')).toMatch(/第 \d+ 页/);
    expect(r[SURFACE_MARKER]).toBeUndefined();
  });

  it('我们写的干净文档 → 放行', async () => {
    const file = path.join(tmpRoot, 'clean.docx');
    await writeDocx(file, para('标题') + para('正文'));
    markNeoxWritten(file);
    const r = await call(openSurfaceTool, { kind: 'docx', source: { type: 'file', path: file } });
    expect(r[SURFACE_MARKER]).toBe(true);
    expect(r.selfCheck.passed).toBe(true);
    expect(r.selfCheck.format).toBe('docx');
  });
});
