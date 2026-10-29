/**
 * 从 .pptx 里读每一页的文字与标题 (判分用, 无第三方依赖)。
 *
 * 页序按 slideN.xml 的数字顺序。标题取标题占位符 (ph type=title/ctrTitle) 的文字;
 * 模板没写占位符类型时退回该页第一段非空文字 —— 判分只要「这一页有标题」,
 * 不关心它是哪个模板画出来的。
 */
import { openZip } from './zip.mjs';
import { decodeXml } from './docx.mjs';

const A_T_RE = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g;
const SP_RE = /<p:sp\b[\s\S]*?<\/p:sp>/g;

function shapeText(shapeXml) {
  return [...shapeXml.matchAll(A_T_RE)].map((m) => decodeXml(m[1])).join('');
}

function parseSlide(xml, index) {
  const texts = [];
  let title = '';
  for (const match of String(xml).matchAll(SP_RE)) {
    const shapeXml = match[0];
    const text = shapeText(shapeXml).trim();
    if (text) texts.push(text);
    if (!title) {
      const phType = /<p:ph\b[^>]*\btype="([^"]+)"/.exec(shapeXml)?.[1] ?? '';
      if (phType === 'title' || phType === 'ctrTitle') title = text;
    }
  }
  if (!title) title = texts[0] ?? '';
  return { index, title, texts, text: texts.join(' ') };
}

/** @returns {{ slides: { index: number, title: string, texts: string[], text: string }[] }} */
export function readPptx(file) {
  const zip = openZip(file);
  const names = zip.names
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)[1]) - Number(/(\d+)\.xml$/.exec(b)[1]));
  const slides = names.map((name, index) => parseSlide(zip.text(name), index + 1));
  if (!slides.length) throw new Error('pptx 里没有任何幻灯片');
  return { slides };
}
