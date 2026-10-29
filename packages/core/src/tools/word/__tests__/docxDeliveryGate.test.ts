/**
 * work O-22: docx 交付结构闸门。
 *
 * 四类必拦: 空页 (分页符之间无内容) / 空文档 / 图片缺失 / 断链 (外链文件、内部锚点)
 * 加: 干净文档 pass、外部文件不拦、非 docx → unavailable
 */
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import JSZip from 'jszip';
import { inspectDocxStructure } from '../docxInspect.js';
import { inspectOfficeForDelivery, describeOfficeVerdict } from '../../delivery/officeDeliveryGate.js';
import { markNeoxWritten, resetNeoxWrittenRegistry } from '../../delivery/deliveryProvenance.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-gate-'));
afterAll(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });
beforeEach(() => resetNeoxWrittenRegistry());

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

async function makeDocx(opts: { body: string; extra?: Record<string, string>; rels?: string }): Promise<Buffer> {
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
    `<?xml version="1.0"?><w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">`
    + `<w:body>${opts.body}</w:body></w:document>`);
  if (opts.rels) zip.file('word/_rels/document.xml.rels', opts.rels);
  for (const [part, content] of Object.entries(opts.extra ?? {})) zip.file(part, content);
  return zip.generateAsync({ type: 'nodebuffer' });
}

const para = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const PAGE_BREAK = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';

describe('inspectDocxStructure: 四类必拦问题', () => {
  it('空页: 两处分页符之间没有任何内容 → error', async () => {
    const file = path.join(tmpRoot, 'blank-page.docx');
    fs.writeFileSync(file, await makeDocx({
      body: para('第一页') + PAGE_BREAK + '<w:p/>' + PAGE_BREAK + para('第三页'),
    }));
    const report = await inspectDocxStructure(file);
    const blanks = report.issues.filter((i) => i.kind === 'blank_page');
    expect(blanks).toHaveLength(1);
    expect(blanks[0].location).toBe('第 2 页');
    expect(report.ok).toBe(false);
  });

  it('空文档: 正文完全为空 → error', async () => {
    const file = path.join(tmpRoot, 'empty.docx');
    fs.writeFileSync(file, await makeDocx({ body: '<w:p/><w:p/>' }));
    const report = await inspectDocxStructure(file);
    expect(report.issues.some((i) => i.kind === 'empty_document' && i.severity === 'error')).toBe(true);
    expect(report.ok).toBe(false);
  });

  it('图片缺失: blip 指向的零件不在包里 → error', async () => {
    const file = path.join(tmpRoot, 'img-missing.docx');
    fs.writeFileSync(file, await makeDocx({
      body: para('看图') + '<w:p><w:r><w:drawing><a:blip r:embed="rId9"/></w:drawing></w:r></w:p>',
      rels: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + `<Relationship Id="rId9" Type="${R}/image" Target="media/image1.png"/></Relationships>`,
    }));
    const report = await inspectDocxStructure(file);
    const imgs = report.issues.filter((i) => i.kind === 'missing_image');
    expect(imgs).toHaveLength(1);
    expect(imgs[0].detail).toContain('word/media/image1.png');
    expect(report.ok).toBe(false);
  });

  it('图片存在时不报', async () => {
    const file = path.join(tmpRoot, 'img-ok.docx');
    fs.writeFileSync(file, await makeDocx({
      body: para('看图') + '<w:p><w:r><w:drawing><a:blip r:embed="rId9"/></w:drawing></w:r></w:p>',
      rels: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + `<Relationship Id="rId9" Type="${R}/image" Target="media/image1.png"/></Relationships>`,
      extra: { 'word/media/image1.png': 'x' },
    }));
    const report = await inspectDocxStructure(file);
    expect(report.issues.filter((i) => i.kind === 'missing_image')).toHaveLength(0);
    expect(report.stats.images).toBe(1);
  });

  it('断链: 外链文件不存在 + 内部锚点不存在', async () => {
    const file = path.join(tmpRoot, 'links.docx');
    fs.writeFileSync(file, await makeDocx({
      body: para('正文')
        + '<w:p><w:hyperlink r:id="rId7"><w:r><w:t>外链</w:t></w:r></w:hyperlink></w:p>'
        + '<w:p><w:hyperlink w:anchor="nowhere"><w:r><w:t>内部</w:t></w:r></w:hyperlink></w:p>',
      rels: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + `<Relationship Id="rId7" Type="${R}/hyperlink" Target="missing.pdf" TargetMode="External"/></Relationships>`,
    }));
    const report = await inspectDocxStructure(file);
    const links = report.issues.filter((i) => i.kind === 'broken_link');
    expect(links.length).toBe(2);
    expect(links.some((l) => l.detail.includes('missing.pdf'))).toBe(true);
    expect(links.some((l) => l.detail.includes('nowhere'))).toBe(true);
  });

  it('内部锚点存在时不报', async () => {
    const file = path.join(tmpRoot, 'anchor-ok.docx');
    fs.writeFileSync(file, await makeDocx({
      body: para('正文')
        + '<w:p><w:bookmarkStart w:id="1" w:name="here"/><w:bookmarkEnd w:id="1"/></w:p>'
        + '<w:p><w:hyperlink w:anchor="here"><w:r><w:t>跳转</w:t></w:r></w:hyperlink></w:p>',
    }));
    const report = await inspectDocxStructure(file);
    expect(report.issues.filter((i) => i.kind === 'broken_link')).toHaveLength(0);
  });

  it('干净的文档 → ok', async () => {
    const file = path.join(tmpRoot, 'clean.docx');
    fs.writeFileSync(file, await makeDocx({ body: para('标题') + para('正文一段') }));
    const report = await inspectDocxStructure(file);
    expect(report.ok).toBe(true);
    expect(report.mustFixCount).toBe(0);
  });
});

describe('docx 交付闸门裁决', () => {
  it('我们写的 + 空页 → blocked, 回执含问题清单', async () => {
    const file = path.join(tmpRoot, 'ours-blank.docx');
    fs.writeFileSync(file, await makeDocx({ body: para('一') + PAGE_BREAK + '<w:p/>' + PAGE_BREAK + para('三') }));
    markNeoxWritten(file);
    const verdict = await inspectOfficeForDelivery('docx', file);
    expect(verdict.status).toBe('blocked');
    const receipt = describeOfficeVerdict(verdict) as any;
    expect(receipt.selfCheck.passed).toBe(false);
  });

  it('外部坏文件 → external 不拦', async () => {
    const file = path.join(tmpRoot, 'user-blank.docx');
    fs.writeFileSync(file, await makeDocx({ body: '<w:p/>' }));
    const verdict = await inspectOfficeForDelivery('docx', file);
    expect(verdict.status).toBe('external');
  });

  it('非 docx → unavailable', async () => {
    const file = path.join(tmpRoot, 'junk.docx');
    fs.writeFileSync(file, 'junk');
    const verdict = await inspectOfficeForDelivery('docx', file);
    expect(verdict.status).toBe('unavailable');
  });
});
