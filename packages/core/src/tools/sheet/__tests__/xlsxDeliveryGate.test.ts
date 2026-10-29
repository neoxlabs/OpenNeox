/**
 * work O-22: xlsx 交付结构闸门。
 *
 * 四类必须拦的问题 + 两种不该拦的情形:
 *   拦: 错误值 (#REF!) / 整本空白 / 图片零件缺失 / 断链 (外部链接工作簿 & 内部跳转 sheet)
 *   不拦: 用户自己带进来的文件 (不是本次进程写的) / 自检跑不了时明确说不可用
 */
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import JSZip from 'jszip';
import { inspectXlsxStructure } from '../xlsxInspect.js';
import { inspectOfficeForDelivery, officeFormatForSurfaceKind, describeOfficeVerdict } from '../../delivery/officeDeliveryGate.js';
import { markNeoxWritten, resetNeoxWrittenRegistry } from '../../delivery/deliveryProvenance.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xlsx-gate-'));
afterAll(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });
beforeEach(() => resetNeoxWrittenRegistry());

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

interface ExtraFiles { [part: string]: string }

/** 造一个最小但结构完整的 .xlsx。extra 用来塞 drawing / externalLink 等零件。 */
async function makeXlsx(opts: {
  sheets?: Array<{ name: string; sheetXml: string }>;
  extra?: ExtraFiles;
}): Promise<Buffer> {
  const sheets = opts.sheets ?? [{ name: 'Sheet1', sheetXml: `<worksheet xmlns="${NS}"><sheetData/></worksheet>` }];
  const zip = new JSZip();
  zip.file('[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
    + '</Types>');
  zip.file('_rels/.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + `<Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file('xl/workbook.xml',
    `<?xml version="1.0"?><workbook xmlns="${NS}" xmlns:r="${R}"><sheets>`
    + sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
    + '</sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${R}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + '</Relationships>');
  sheets.forEach((s, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, s.sheetXml));
  for (const [part, content] of Object.entries(opts.extra ?? {})) zip.file(part, content);
  return zip.generateAsync({ type: 'nodebuffer' });
}

const sheetWith = (body: string) => `<worksheet xmlns="${NS}"><sheetData>${body}</sheetData></worksheet>`;

describe('inspectXlsxStructure: 四类必拦问题', () => {
  it('错误值: t="e" 的格 (#REF! / #DIV/0!) 和带 #REF! 的公式都报出来', async () => {
    const file = path.join(tmpRoot, 'errors.xlsx');
    fs.writeFileSync(file, await makeXlsx({
      sheets: [{
        name: '数据',
        sheetXml: sheetWith(
          '<row r="2"><c r="B2"><v>1</v></c><c r="C2" t="e"><v>#REF!</v></c></row>'
          + '<row r="3"><c r="B3" t="e"><v>#DIV/0!</v></c><c r="C3"><f>#REF!+1</f><v>0</v></c></row>',
        ),
      }],
    }));
    const report = await inspectXlsxStructure(file);
    expect(report.ok).toBe(false);
    const errs = report.issues.filter((i) => i.kind === 'error_value' && i.severity === 'error');
    expect(errs.map((e) => e.location)).toEqual(expect.arrayContaining(['数据!C2', '数据!B3', '数据!C3']));
    expect(report.mustFixCount).toBeGreaterThanOrEqual(3);
  });

  it('空页: 整本没有任何内容 → error', async () => {
    const file = path.join(tmpRoot, 'empty.xlsx');
    fs.writeFileSync(file, await makeXlsx({
      sheets: [
        { name: 'Sheet1', sheetXml: sheetWith('') },
        { name: 'Sheet2', sheetXml: sheetWith('<row r="1"><c r="A1"><v>1</v></c></row>') },
      ],
    }));
    const report = await inspectXlsxStructure(file);
    const empty = report.issues.filter((i) => i.kind === 'empty_sheet');
    /* 一张空 sheet 在有多内容 sheet 时只 warn, 不拦 */
    expect(empty).toHaveLength(1);
    expect(empty[0].severity).toBe('warn');
    expect(report.ok).toBe(true);

    const allEmpty = path.join(tmpRoot, 'all-empty.xlsx');
    fs.writeFileSync(allEmpty, await makeXlsx({ sheets: [{ name: 'Sheet1', sheetXml: sheetWith('') }] }));
    const report2 = await inspectXlsxStructure(allEmpty);
    expect(report2.issues.some((i) => i.kind === 'empty_sheet' && i.severity === 'error')).toBe(true);
    expect(report2.ok).toBe(false);
  });

  it('图片缺失: drawing 引用的媒体零件不在包里 → error', async () => {
    const file = path.join(tmpRoot, 'image-missing.xlsx');
    fs.writeFileSync(file, await makeXlsx({
      extra: {
        'xl/drawings/drawing1.xml':
          `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" `
          + `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${R}">`
          + '<xdr:twoCellAnchor><xdr:pic><xdr:blipFill><a:blip r:embed="rId2"/></xdr:blipFill></xdr:pic></xdr:twoCellAnchor>'
          + '</xdr:wsDr>',
        'xl/drawings/_rels/drawing1.xml.rels':
          '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
          + `<Relationship Id="rId2" Type="${R}/image" Target="../media/image1.png"/></Relationships>`,
      },
    }));
    const report = await inspectXlsxStructure(file);
    const imgs = report.issues.filter((i) => i.kind === 'missing_image');
    expect(imgs).toHaveLength(1);
    expect(imgs[0].detail).toContain('xl/media/image1.png');
    expect(report.ok).toBe(false);
  });

  it('图片存在时不报 (同一份 drawing, 媒体零件补上)', async () => {
    const file = path.join(tmpRoot, 'image-ok.xlsx');
    fs.writeFileSync(file, await makeXlsx({
      extra: {
        'xl/drawings/drawing1.xml':
          `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" `
          + `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${R}">`
          + '<xdr:twoCellAnchor><xdr:pic><xdr:blipFill><a:blip r:embed="rId2"/></xdr:blipFill></xdr:pic></xdr:twoCellAnchor>'
          + '</xdr:wsDr>',
        'xl/drawings/_rels/drawing1.xml.rels':
          '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
          + `<Relationship Id="rId2" Type="${R}/image" Target="../media/image1.png"/></Relationships>`,
        'xl/media/image1.png': 'not-a-real-png-but-present',
      },
    }));
    const report = await inspectXlsxStructure(file);
    expect(report.issues.filter((i) => i.kind === 'missing_image')).toHaveLength(0);
    expect(report.stats.images).toBe(1);
  });

  it('断链: 外部链接工作簿不存在 / 内部跳转指向不存在的 sheet', async () => {
    const file = path.join(tmpRoot, 'links.xlsx');
    fs.writeFileSync(file, await makeXlsx({
      sheets: [{
        name: 'Sheet1',
        sheetXml: sheetWith('<row r="1"><c r="A1"><v>1</v></c></row>')
          .replace('</worksheet>', '<hyperlinks><hyperlink ref="A1" location="Ghost!A1"/></hyperlinks></worksheet>'),
      }],
      extra: {
        'xl/externalLinks/externalLink1.xml': '<?xml version="1.0"?><externalLink/>',
        'xl/externalLinks/_rels/externalLink1.xml.rels':
          '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
          + `<Relationship Id="rId1" Type="${R}/externalLinkPath" Target="missing-source.xlsx" TargetMode="External"/></Relationships>`,
      },
    }));
    const report = await inspectXlsxStructure(file);
    const links = report.issues.filter((i) => i.kind === 'broken_link');
    expect(links.length).toBe(2);
    expect(links.some((l) => l.detail.includes('missing-source.xlsx'))).toBe(true);
    expect(links.some((l) => l.detail.includes('Ghost'))).toBe(true);
  });
});

describe('交付闸门裁决 (provenance + 自检失败)', () => {
  it('officeFormatForSurfaceKind: sheet→xlsx, docx→docx, 其它不归闸门管', () => {
    expect(officeFormatForSurfaceKind('sheet')).toBe('xlsx');
    expect(officeFormatForSurfaceKind('docx')).toBe('docx');
    expect(officeFormatForSurfaceKind('pptx')).toBe(null);
    expect(officeFormatForSurfaceKind('markdown')).toBe(null);
  });

  it('我们写的文件 + 有问题 → blocked', async () => {
    const file = path.join(tmpRoot, 'ours-bad.xlsx');
    fs.writeFileSync(file, await makeXlsx({
      sheets: [{ name: 'Sheet1', sheetXml: sheetWith('<row r="1"><c r="A1" t="e"><v>#VALUE!</v></c></row>') }],
    }));
    markNeoxWritten(file);
    const verdict = await inspectOfficeForDelivery('xlsx', file);
    expect(verdict.status).toBe('blocked');
    if (verdict.status === 'blocked') expect(verdict.report.mustFixCount).toBeGreaterThan(0);
  });

  it('我们写的文件 + 干净 → pass (回执里带 selfCheck)', async () => {
    const file = path.join(tmpRoot, 'ours-ok.xlsx');
    fs.writeFileSync(file, await makeXlsx({
      sheets: [{ name: 'Sheet1', sheetXml: sheetWith('<row r="1"><c r="A1"><v>1</v></c></row>') }],
    }));
    markNeoxWritten(file);
    const verdict = await inspectOfficeForDelivery('xlsx', file);
    expect(verdict.status).toBe('pass');
    const receipt = describeOfficeVerdict(verdict) as any;
    expect(receipt.selfCheck.available).toBe(true);
    expect(receipt.selfCheck.passed).toBe(true);
  });

  it('用户自己带进来的坏文件 → external, 不拦', async () => {
    const file = path.join(tmpRoot, 'user-bad.xlsx');
    fs.writeFileSync(file, await makeXlsx({
      sheets: [{ name: 'Sheet1', sheetXml: sheetWith('<row r="1"><c r="A1" t="e"><v>#REF!</v></c></row>') }],
    }));
    /* 没 markNeoxWritten → 外部文件 */
    const verdict = await inspectOfficeForDelivery('xlsx', file);
    expect(verdict.status).toBe('external');
    if (verdict.status === 'external') expect(verdict.report.mustFixCount).toBeGreaterThan(0);
  });

  it('写完之后被外部改过 (mtime 变了) → 不再当我们写的', async () => {
    const file = path.join(tmpRoot, 'touched-later.xlsx');
    fs.writeFileSync(file, await makeXlsx({
      sheets: [{ name: 'Sheet1', sheetXml: sheetWith('<row r="1"><c r="A1" t="e"><v>#REF!</v></c></row>') }],
    }));
    markNeoxWritten(file);
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    const verdict = await inspectOfficeForDelivery('xlsx', file);
    expect(verdict.status).toBe('external');
  });

  it('文件不存在 → unavailable, 回执明确说没验证', async () => {
    const verdict = await inspectOfficeForDelivery('xlsx', path.join(tmpRoot, 'nope.xlsx'));
    expect(verdict.status).toBe('unavailable');
    const receipt = describeOfficeVerdict(verdict) as any;
    expect(receipt.selfCheck.available).toBe(false);
    expect(receipt.selfCheck.agentInstruction).toContain('禁止声称已验证');
  });

  it('不是 xlsx 的文件 → unavailable (不抛给上层)', async () => {
    const file = path.join(tmpRoot, 'not-zip.xlsx');
    fs.writeFileSync(file, 'hello');
    markNeoxWritten(file);
    const verdict = await inspectOfficeForDelivery('xlsx', file);
    expect(verdict.status).toBe('unavailable');
  });
});
