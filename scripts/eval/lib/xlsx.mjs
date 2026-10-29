/**
 * 极简 xlsx 读取器 (ZIP + OOXML), 只为本目录的判分服务。
 *
 * 为什么自己写: 工作区没有 exceljs/xlsx 依赖, 判分脚本不该为读一个单元格去装包。
 * 支持: sharedStrings / inlineStr / 数字 / 布尔 / 公式文本。不支持 zip64。
 */
import * as fs from 'node:fs';
import * as zlib from 'node:zlib';

function decodeXml(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, '&');
}

function stripTags(text) {
  return decodeXml(String(text).replace(/<[^>]*>/g, ''));
}

function findEndOfCentralDirectory(buf) {
  const minOffset = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= minOffset; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function readEntries(buf) {
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd < 0) throw new Error('不是有效的 xlsx (缺少 zip 目录)');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.set(name, { method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readEntry(buf, entry) {
  if (buf.readUInt32LE(entry.localOffset) !== 0x04034b50) throw new Error('zip local header 损坏');
  const nameLength = buf.readUInt16LE(entry.localOffset + 26);
  const extraLength = buf.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const data = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data.toString('utf8');
  if (entry.method === 8) return zlib.inflateRawSync(data).toString('utf8');
  throw new Error(`不支持的 zip 压缩方式: ${entry.method}`);
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) => {
    const joined = [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])).join('');
    return joined;
  });
}

function parseCells(xml, sharedStrings) {
  const cells = new Map();
  for (const match of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = match[1];
    const inner = match[2] ?? '';
    const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
    if (!ref) continue;
    const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? 'n';
    const styleIndex = Number(/\bs="(\d+)"/.exec(attrs)?.[1] ?? 0);
    const formulaMatch = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(inner);
    const formula = formulaMatch ? decodeXml(formulaMatch[1]) : null;
    const inlineMatch = /<is>([\s\S]*?)<\/is>/.exec(inner);
    const valueMatch = /<v>([\s\S]*?)<\/v>/.exec(inner);
    let value = null;
    if (inlineMatch) value = stripTags(inlineMatch[1]);
    else if (valueMatch) {
      const raw = decodeXml(valueMatch[1]);
      if (type === 's') value = sharedStrings[Number(raw)] ?? null;
      else if (type === 'b') value = raw === '1';
      else if (type === 'str' || type === 'e') value = raw;
      else value = raw === '' ? null : Number(raw);
    }
    cells.set(ref, { value, formula, type, styleIndex });
  }
  return cells;
}

/** 内建数字格式编号 → 格式串 (判分只关心几个常见预设) */
const BUILTIN_NUM_FMTS = {
  0: 'General',
  1: '0',
  2: '0.00',
  3: '#,##0',
  4: '#,##0.00',
  9: '0%',
  10: '0.00%',
  14: 'yyyy-mm-dd',
  20: 'hh:mm',
};

function blockBody(xml, tag) {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(xml);
  return match ? match[1] : '';
}

/** 读 xl/styles.xml: 字体加粗 / 填充色 / 数字格式 / cellXfs 映射 */
function parseStyles(xml) {
  if (!xml) return null;
  const numFmts = new Map();
  for (const match of xml.matchAll(/<numFmt\b([^>]*)\/>/g)) {
    const id = Number(/\bnumFmtId="(\d+)"/.exec(match[1])?.[1]);
    const code = decodeXml(/\bformatCode="([^"]*)"/.exec(match[1])?.[1] ?? '');
    if (Number.isFinite(id)) numFmts.set(id, code);
  }
  const fonts = [...blockBody(xml, 'fonts').matchAll(/<font\b[^>]*>([\s\S]*?)<\/font>/g)].map((match) => ({
    bold: /<b\b[^>]*\/?>/.test(match[1]),
  }));
  const fills = [...blockBody(xml, 'fills').matchAll(/<fill\b[^>]*>([\s\S]*?)<\/fill>/g)].map((match) => ({
    pattern: /patternType="([^"]+)"/.exec(match[1])?.[1] ?? null,
    fgColor: /\bfgColor\b[^>]*\brgb="([0-9A-Fa-f]{6,8})"/.exec(match[1])?.[1] ?? null,
    indexed: Number(/\bfgColor\b[^>]*\bindexed="(\d+)"/.exec(match[1])?.[1] ?? NaN),
  }));
  const cellXfs = [...blockBody(xml, 'cellXfs').matchAll(/<xf\b([^>]*?)(?:\/>|>([\s\S]*?)<\/xf>)/g)].map((match) => {
    const attrs = match[1];
    const inner = match[2] ?? '';
    return {
      numFmtId: Number(/\bnumFmtId="(\d+)"/.exec(attrs)?.[1] ?? 0),
      fontId: Number(/\bfontId="(\d+)"/.exec(attrs)?.[1] ?? 0),
      fillId: Number(/\bfillId="(\d+)"/.exec(attrs)?.[1] ?? 0),
      align: /\bhorizontal="([^"]+)"/.exec(inner)?.[1] ?? null,
    };
  });
  return { numFmts, fonts, fills, cellXfs };
}

function parseCols(xml) {
  const cols = [];
  for (const match of xml.matchAll(/<col\b([^>]*)\/?>/g)) {
    const min = Number(/\bmin="(\d+)"/.exec(match[1])?.[1] ?? 0);
    const max = Number(/\bmax="(\d+)"/.exec(match[1])?.[1] ?? 0);
    const width = Number(/\bwidth="([\d.]+)"/.exec(match[1])?.[1] ?? 0);
    if (min > 0 && width > 0) cols.push({ min, max: max || min, width });
  }
  return cols;
}

/** 解析单元格最终生效的格式 (加粗 / 填充 / 数字格式串 / 列宽) */
export function cellStyle(sheet, ref) {
  const cell = sheet?.cells?.get(ref);
  const index = cell?.styleIndex ?? 0;
  const xf = sheet?.styles?.cellXfs?.[index] ?? null;
  if (!xf) return { bold: false, fill: null, numFmtId: 0, numFmt: null, align: null, styleIndex: index };
  const font = sheet.styles.fonts?.[xf.fontId] ?? null;
  const fill = sheet.styles.fills?.[xf.fillId] ?? null;
  const numFmt = sheet.styles.numFmts?.get?.(xf.numFmtId) ?? BUILTIN_NUM_FMTS[xf.numFmtId] ?? null;
  return {
    bold: Boolean(font?.bold),
    fill: fill?.pattern === 'solid' ? fill.fgColor : null,
    numFmtId: xf.numFmtId,
    numFmt,
    align: xf.align,
    styleIndex: index,
  };
}

/** 某列的宽度 (chars), 没有设置返回 null */
export function columnWidth(sheet, columnIndex) {
  const col = (sheet?.cols ?? []).find((item) => columnIndex + 1 >= item.min && columnIndex + 1 <= item.max);
  return col ? col.width : null;
}

function resolveTarget(target) {
  if (!target) return '';
  if (target.startsWith('/')) return target.slice(1);
  if (target.startsWith('xl/')) return target;
  return `xl/${target}`;
}

/**
 * @param {string} file
 * @returns {{ sheets: { name: string, cells: Map<string, {value: any, formula: string|null, type: string}> }[] }}
 */
export function readXlsx(file) {
  const buf = fs.readFileSync(file);
  const entries = readEntries(buf);
  const read = (name) => (entries.has(name) ? readEntry(buf, entries.get(name)) : null);

  const sharedStrings = parseSharedStrings(read('xl/sharedStrings.xml'));
  const styles = parseStyles(read('xl/styles.xml'));
  const workbookXml = read('xl/workbook.xml') ?? '';
  const relsXml = read('xl/_rels/workbook.xml.rels') ?? '';
  const rels = new Map();
  for (const match of relsXml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = /\bId="([^"]+)"/.exec(match[1])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(match[1])?.[1];
    if (id && target) rels.set(id, resolveTarget(target));
  }

  const sheets = [];
  for (const match of workbookXml.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const attrs = match[1];
    const name = decodeXml(/\bname="([^"]*)"/.exec(attrs)?.[1] ?? '');
    const relId = /\br:id="([^"]+)"/.exec(attrs)?.[1];
    const target = rels.get(relId);
    const xml = target ? read(target) : null;
    if (!xml) continue;
    sheets.push({ name, cells: parseCells(xml, sharedStrings), styles, cols: parseCols(xml) });
  }

  if (!sheets.length) {
    // 有些写入器省掉 workbook 关系表 —— 退化成按文件名顺序读
    const sheetFiles = [...entries.keys()]
      .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    for (const [index, name] of sheetFiles.entries()) {
      const xml = readEntry(buf, entries.get(name));
      sheets.push({ name: `Sheet${index + 1}`, cells: parseCells(xml, sharedStrings), styles, cols: parseCols(xml) });
    }
  }

  return { sheets };
}

export function cellText(cell) {
  if (!cell) return '';
  if (typeof cell.value === 'string') return cell.value.trim();
  if (typeof cell.value === 'number') return String(cell.value);
  if (cell.value === null || cell.value === undefined) return '';
  return String(cell.value);
}
