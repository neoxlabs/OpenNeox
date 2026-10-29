import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { peekDocxText } from '../docxFastPeek';

async function makeDocx(paragraphs: string[]): Promise<ArrayBuffer> {
  const body = paragraphs
    .map((text) => `<w:p><w:r><w:t>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`)
    .join('');
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('word/document.xml', xml);
  return zip.generateAsync({ type: 'arraybuffer' });
}

describe('peekDocxText', () => {
  it('抽出开头的正文段落', async () => {
    const buf = await makeDocx(['第一段', '第二段', '']);
    const lines = await peekDocxText(buf);
    expect(lines).toEqual(['第一段', '第二段']);
  });

  it('按 maxParagraphs 截断', async () => {
    const buf = await makeDocx(['a', 'b', 'c', 'd', 'e']);
    const lines = await peekDocxText(buf, { maxParagraphs: 3 });
    expect(lines).toEqual(['a', 'b', 'c']);
  });

  it('解开 XML 实体', async () => {
    /* makeDocx 负责转义, 这里传原文 */
    const buf = await makeDocx(['a & b <c>']);
    expect(await peekDocxText(buf)).toEqual(['a & b <c>']);
  });

  it('不是 zip / 没有 document.xml 时返回空数组, 不抛错', async () => {
    expect(await peekDocxText(new ArrayBuffer(16))).toEqual([]);
    const zip = new JSZip();
    zip.file('word/styles.xml', '<styles/>');
    const buf = await zip.generateAsync({ type: 'arraybuffer' });
    expect(await peekDocxText(buf)).toEqual([]);
  });
});
