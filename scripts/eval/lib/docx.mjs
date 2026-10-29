/**
 * 从 .docx 里读段落与标题 (判分用, 无第三方依赖)。
 *
 * 标题有两种写法, 都要认:
 *   · <w:pStyle w:val="Heading2"/>       —— Word 另存的文档
 *   · <w:outlineLvl w:val="1"/>          —— word_create 生成的文档 (它不写 pStyle, 用大纲级别)
 * 只认 pStyle 会把 word_create 的标题全判成正文。
 */
import { openZip } from './zip.mjs';

const W_P_RE = /<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
const W_T_RE = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;

export function decodeXml(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, '&');
}

function headingLevel(paragraphXml) {
  const style = /<w:pStyle\s+w:val="([^"]+)"/.exec(paragraphXml)?.[1] ?? '';
  const named = /^Heading\s*(\d)$/i.exec(style);
  if (named) return Number(named[1]);
  if (/^Title$/i.test(style)) return 1;
  const outline = /<w:outlineLvl\s+w:val="(\d+)"/.exec(paragraphXml)?.[1];
  if (outline !== undefined) {
    const level = Number(outline) + 1;
    return level >= 1 && level <= 9 ? level : 0;
  }
  return 0;
}

/** @returns {{ paragraphs: { text: string, heading: number }[], headings: { text: string, level: number }[] }} */
export function parseDocxXml(xml) {
  const paragraphs = [];
  for (const match of String(xml).matchAll(W_P_RE)) {
    const paragraphXml = match[0];
    const text = [...paragraphXml.matchAll(W_T_RE)].map((m) => decodeXml(m[1])).join('');
    paragraphs.push({ text, heading: headingLevel(paragraphXml) });
  }
  return {
    paragraphs,
    headings: paragraphs.filter((p) => p.heading > 0).map((p) => ({ text: p.text, level: p.heading })),
  };
}

export function readDocx(file) {
  const zip = openZip(file);
  const xml = zip.text('word/document.xml');
  if (!xml) throw new Error('docx 里没有 word/document.xml');
  return parseDocxXml(xml);
}
