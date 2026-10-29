
import type JSZipType from 'jszip';

const MAX_PARAGRAPHS = 40;
const MAX_CHARS = 1800;

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m] ?? m);
}

/** 从一个 <w:p> 片段里抽出所有 <w:t> 文本。 */
function paragraphText(paragraphXml: string): string {
  const runs = paragraphXml.match(/<w:t\b[^>]*>[\s\S]*?<\/w:t>/g);
  if (!runs) return '';
  let out = '';
  for (const run of runs) {
    const inner = run.replace(/^<w:t\b[^>]*>/, '').replace(/<\/w:t>$/, '');
    out += decodeEntities(inner);
  }
  /* <w:tab/> 与换行统一成空格, 保持单行可读 */
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * 读 docx 正文开头。失败（不是 zip / 没有 document.xml）返回空数组,
 * 调用方当作"没有快速预览"即可, 不影响正式渲染。
 */
export async function peekDocxText(
  buffer: ArrayBuffer,
  opts: { maxParagraphs?: number; maxChars?: number } = {},
): Promise<string[]> {
  const maxParagraphs = opts.maxParagraphs ?? MAX_PARAGRAPHS;
  const maxChars = opts.maxChars ?? MAX_CHARS;
  try {
    /* 动态 import: 只有真要看 docx 时才把 jszip 拉进来, 不拖累 renderer 首包 */
    const JSZip = (await import('jszip')).default as typeof JSZipType;
    const zip = await JSZip.loadAsync(buffer, { checkCRC32: false });
    const entry = zip.file('word/document.xml');
    if (!entry) return [];
    const xml = await entry.async('string');
    const paragraphs: string[] = [];
    let used = 0;
    /* 按顺序扫 <w:p>, 拿到够用的段落就停 —— 不解析整棵 XML 树 */
    const re = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(xml)) !== null) {
      const text = paragraphText(match[1]);
      if (!text) continue;
      paragraphs.push(text);
      used += text.length;
      if (paragraphs.length >= maxParagraphs || used >= maxChars) break;
    }
    return paragraphs;
  } catch {
    return [];
  }
}
