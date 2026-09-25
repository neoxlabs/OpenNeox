import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
  mergeRunProps, validateRunFormat, formatTextInDocument, insertTableAfter, imageSize, insertImage, textWidthTwips,
} from '../wordRich.js';

const DOC = `<w:document xmlns:w="w"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>周报</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">本周营收 </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>1,280</w:t></w:r><w:r><w:t xml:space="preserve"> 万元, 风险: 交付延期</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:t>第二段</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>tab 后</w:t></w:r></w:p>
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800"/></w:sectPr>
</w:body></w:document>`;

describe('mergeRunProps', () => {
  it('按 schema 顺序排, 覆盖同名, 保留原有的', () => {
    expect(mergeRunProps('<w:sz w:val="20"/><w:rFonts w:ascii="Arial"/><w:i/>', { bold: true, color: 'c00000', fontSize: 14 }))
      .toBe('<w:rFonts w:ascii="Arial"/><w:b/><w:bCs/><w:i/><w:color w:val="C00000"/><w:sz w:val="28"/><w:szCs w:val="28"/>');
    expect(mergeRunProps('<w:b/><w:bCs/>', { bold: false })).toBe('<w:b w:val="0"/>');
  });
  it('参数校验', () => {
    expect(validateRunFormat({})).toMatch(/至少/);
    expect(validateRunFormat({ color: 'red' })).toMatch(/hex/);
    expect(validateRunFormat({ highlight: 'purple' })).toMatch(/highlight/);
    expect(validateRunFormat({ bold: true })).toBeNull();
  });
});

describe('formatTextInDocument', () => {
  it('单 run 内一截: 切成 前/中/后 三段, 只有中间加格式', () => {
    const r = formatTextInDocument(DOC, '交付延期', { bold: true, color: 'C00000' });
    expect(r.count).toBe(1);
    expect(r.newXml).toContain('<w:t xml:space="preserve"> 万元, 风险: </w:t></w:r><w:r><w:rPr><w:b/><w:bCs/><w:color w:val="C00000"/></w:rPr><w:t xml:space="preserve">交付延期</w:t></w:r>');
  });
  it('跨 run: 每个被覆盖的片段各自合并格式, 原有斜体保留', () => {
    const r = formatTextInDocument(DOC, '营收 1,280', { bold: true });
    expect(r.count).toBe(1);
    expect(r.newXml).toContain('<w:t xml:space="preserve">本周</w:t></w:r><w:r><w:rPr><w:b/><w:bCs/></w:rPr><w:t xml:space="preserve">营收 </w:t>');
    expect(r.newXml).toContain('<w:rPr><w:b/><w:bCs/><w:i/></w:rPr><w:t xml:space="preserve">1,280</w:t>');
  });
  it('不跨 tab; 限定段落; 找不到返回 0', () => {
    expect(formatTextInDocument(DOC, '第二段tab 后', { bold: true }).count).toBe(0);
    expect(formatTextInDocument(DOC, 'tab 后', { italic: true }).count).toBe(1);
    expect(formatTextInDocument(DOC, '周报', { bold: true }, { paragraphIndex: 1 }).count).toBe(0);
    expect(formatTextInDocument(DOC, '周报', { bold: true }, { paragraphIndex: 0 }).count).toBe(1);
  });
});

describe('insertTableAfter', () => {
  it('插在段后, 表后补空段, 表头加粗底色并跨页重复, 列宽按正文宽', () => {
    const r = insertTableAfter(DOC, 1, [['区域', '营收'], ['华东', '620']]);
    expect(r.error).toBeUndefined();
    const at = r.newXml.indexOf('<w:tbl><w:tblPr>');
    expect(at).toBeGreaterThan(r.newXml.indexOf('交付延期'));
    expect(r.newXml).toContain('<w:trPr><w:tblHeader/></w:trPr>');
    expect(r.newXml).toContain('<w:gridCol w:w="4153"/>');
    expect(r.newXml).toContain('</w:tbl><w:p/>');
    expect(textWidthTwips(DOC)).toBe(8306);
  });
  it('目标段在表格里 / 不存在 → 拒绝', () => {
    expect(insertTableAfter(DOC, 2, [['x']]).error).toMatch(/表格单元格/);
    expect(insertTableAfter(DOC, 99, [['x']]).error).toMatch(/不存在/);
  });
});

/* 最小 PNG: 签名 + IHDR (宽 400 高 200) */
function fakePng(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const dv = new DataView(b.buffer); dv.setUint32(16, w); dv.setUint32(20, h);
  return b;
}

describe('图片', () => {
  it('读 PNG / GIF 尺寸, 不认识的返回 null', () => {
    expect(imageSize(fakePng(400, 200))).toEqual({ width: 400, height: 200, ext: 'png' });
    expect(imageSize(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x10, 0, 0x08, 0, 0]))).toEqual({ width: 16, height: 8, ext: 'gif' });
    expect(imageSize(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it('插图: 媒体文件 + 新 rId + content type + 补命名空间 + 保持比例 + 图注', async () => {
    const zip = new JSZip();
    zip.file('word/_rels/document.xml.rels', '<Relationships><Relationship Id="rId1" Type="x/styles" Target="styles.xml"/><Relationship Id="rId7" Type="x/theme" Target="theme/theme1.xml"/></Relationships>');
    zip.file('[Content_Types].xml', '<Types><Default Extension="xml" ContentType="application/xml"/></Types>');
    const r = await insertImage(zip, DOC, 0, fakePng(400, 200), { caption: '图 1 营收趋势' });
    expect(r.error).toBeUndefined();
    expect(zip.file('word/media/neox_image1.png')).not.toBeNull();
    expect(await zip.file('word/_rels/document.xml.rels')!.async('string')).toContain('Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/neox_image1.png"');
    expect(await zip.file('[Content_Types].xml')!.async('string')).toContain('<Default Extension="png" ContentType="image/png"/>');
    expect(r.newXml).toContain('xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"');
    expect(r.newXml).toContain('<wp:extent cx="3810000" cy="1905000"/>');
    expect(r.newXml).toContain('<a:blip r:embed="rId8"/>');
    expect(r.newXml).toContain('图 1 营收趋势');
    expect(r.widthCm).toBe(10.6);
    /* 太宽的图压到正文宽 */
    const big = await insertImage(new JSZip(), DOC, 0, fakePng(4000, 1000));
    /* 正文宽 8306 twips = 14.65 cm, 四舍五入到 0.1 */
    expect(big.widthCm).toBe(14.7);
  });
});
