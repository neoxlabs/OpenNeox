/**
 * Word rich editing updates run formatting and inserts tables or images after a
 * paragraph. It changes only the required document XML, preserves other package
 * parts, uses word_get_paragraphs ordering, and emits rPr children in schema order.
 */
import JSZip from 'jszip';
import { escapeXml } from './wordOoxml.js';

const W_P_RE = /<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;

/* ───────────── run 级格式 ───────────── */

export interface RunFormat {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** 字体色 hex, 不带 # */
  color?: string;
  /** Word 高亮色名: yellow / green / cyan / magenta / red / blue / lightGray … */
  highlight?: string;
  /** 字号 pt */
  fontSize?: number;
}

const HIGHLIGHTS = new Set(['yellow', 'green', 'cyan', 'magenta', 'blue', 'red', 'darkBlue', 'darkCyan', 'darkGreen',
  'darkMagenta', 'darkRed', 'darkYellow', 'darkGray', 'lightGray', 'black', 'white']);

/** CT_RPr 子元素顺序 (ECMA-376 17.3.2.28) */
const RPR_ORDER = ['rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'outline', 'shadow',
  'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color', 'spacing', 'w', 'kern', 'position', 'sz',
  'szCs', 'highlight', 'u', 'effect', 'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs', 'em', 'lang', 'eastAsianLayout',
  'specVanish', 'oMath', 'rPrChange'];

/** 把 fmt 合并进一个 rPr 的内部 XML, 按 schema 顺序输出 */
export function mergeRunProps(rPrInner: string, fmt: RunFormat): string {
  const children = new Map<string, string>();
  const re = /<w:(\w+)\b[^>]*\/>|<w:(\w+)\b[^>]*>[\s\S]*?<\/w:\2>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rPrInner))) children.set(m[1] ?? m[2], m[0]);
  const set = (k: string, v: string | null) => { if (v === null) children.delete(k); else children.set(k, v); };
  if (fmt.bold !== undefined) { set('b', fmt.bold ? '<w:b/>' : '<w:b w:val="0"/>'); set('bCs', fmt.bold ? '<w:bCs/>' : null); }
  if (fmt.italic !== undefined) { set('i', fmt.italic ? '<w:i/>' : '<w:i w:val="0"/>'); set('iCs', fmt.italic ? '<w:iCs/>' : null); }
  if (fmt.underline !== undefined) set('u', fmt.underline ? '<w:u w:val="single"/>' : '<w:u w:val="none"/>');
  if (fmt.color) set('color', `<w:color w:val="${fmt.color.replace(/^#/, '').toUpperCase()}"/>`);
  if (fmt.highlight) set('highlight', `<w:highlight w:val="${fmt.highlight}"/>`);
  if (fmt.fontSize) {
    const hp = Math.round(fmt.fontSize * 2);
    set('sz', `<w:sz w:val="${hp}"/>`); set('szCs', `<w:szCs w:val="${hp}"/>`);
  }
  const known = RPR_ORDER.filter((k) => children.has(k)).map((k) => children.get(k)!);
  const unknown = [...children.entries()].filter(([k]) => !RPR_ORDER.includes(k)).map(([, v]) => v);
  return [...known, ...unknown].join('');
}

export function validateRunFormat(fmt: RunFormat): string | null {
  if (fmt.color && !/^#?[0-9a-fA-F]{6}$/.test(fmt.color)) return `color 要 6 位 hex (如 C00000), 收到 ${fmt.color}`;
  if (fmt.highlight && !HIGHLIGHTS.has(fmt.highlight)) return `highlight 只能是 ${[...HIGHLIGHTS].join('/')}`;
  if (fmt.fontSize !== undefined && !(fmt.fontSize >= 1 && fmt.fontSize <= 400)) return 'fontSize 要在 1~400 pt';
  if (Object.values(fmt).every((v) => v === undefined)) return '至少给一种格式 (bold/italic/underline/color/highlight/fontSize)';
  return null;
}

interface RunPiece { kind: 'text'; rPr: string; text: string; openTag: string }
interface OpaquePiece { kind: 'opaque'; xml: string }
type Piece = RunPiece | OpaquePiece;

/** 段落内部 → run 序列。只有 "rPr + 单个 w:t" 的 run 算可切的文字 run; 含 tab/br/图/域的 run 原样当屏障 */
function splitRuns(pInner: string): { head: string; pieces: Piece[]; tail: string } {
  const runRe = /<w:r\b[^>]*>[\s\S]*?<\/w:r>|<w:r\b[^>]*\/>/g;
  const pieces: Piece[] = [];
  let first = -1; let last = 0; let m: RegExpExecArray | null;
  while ((m = runRe.exec(pInner))) {
    if (first < 0) first = m.index;
    else if (m.index > last) pieces.push({ kind: 'opaque', xml: pInner.slice(last, m.index) });
    const run = m[0];
    const open = /^<w:r\b[^>]*>/.exec(run)?.[0] ?? '<w:r>';
    const body = run.slice(open.length, run.length - '</w:r>'.length);
    const rPr = /^\s*<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(body);
    const rest = rPr ? body.slice(rPr[0].length) : body;
    const t = /^\s*<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>\s*$/.exec(rest);
    if (t && !run.endsWith('/>')) {
      pieces.push({ kind: 'text', rPr: rPr ? rPr[1] : '', text: t[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'), openTag: open });
    } else {
      pieces.push({ kind: 'opaque', xml: run });
    }
    last = m.index + run.length;
  }
  if (first < 0) return { head: pInner, pieces: [], tail: '' };
  return { head: pInner.slice(0, first), pieces, tail: pInner.slice(last) };
}

function runXml(p: RunPiece): string {
  if (!p.text) return '';
  const rPr = p.rPr ? `<w:rPr>${p.rPr}</w:rPr>` : '';
  return `${p.openTag}${rPr}<w:t xml:space="preserve">${escapeXml(p.text)}</w:t></w:r>`;
}

/**
 * 把 find 这几个字设成 fmt (可跨 run, 不跨 tab/换行/图片)。paragraphIndex 给了就只动那一段。
 * 命中处的 run 被切开: 前半 / 命中 (合并格式) / 后半, 各自保留原 rPr。
 */
export function formatTextInDocument(documentXml: string, find: string, fmt: RunFormat, opts: { paragraphIndex?: number } = {}): { newXml: string; count: number } {
  if (!find) return { newXml: documentXml, count: 0 };
  let count = 0; let idx = -1;
  const newXml = documentXml.replace(W_P_RE, (pXml) => {
    idx++;
    if (opts.paragraphIndex !== undefined && idx !== opts.paragraphIndex) return pXml;
    if (pXml.endsWith('/>')) return pXml;
    const open = /^<w:p\b[^>]*>/.exec(pXml)![0];
    const inner = pXml.slice(open.length, pXml.length - '</w:p>'.length);
    const { head, pieces, tail } = splitRuns(inner);
    if (!pieces.some((p) => p.kind === 'text' && p.text)) return pXml;

    /* 按屏障切成若干段, 每段内部拼文字找 find */
    const out: Piece[] = [];
    let seg: RunPiece[] = [];
    let touched = false;
    const flush = () => {
      if (!seg.length) return;
      const full = seg.map((s) => s.text).join('');
      const hits: Array<[number, number]> = [];
      for (let at = full.indexOf(find); at >= 0; at = full.indexOf(find, at + find.length)) hits.push([at, at + find.length]);
      if (!hits.length) { out.push(...seg); seg = []; return; }
      touched = true; count += hits.length;
      let pos = 0;
      for (const r of seg) {
        const s = pos; const e = pos + r.text.length; pos = e;
        /* 这个 run 与各命中区间的切点 */
        const cuts = new Set<number>([s, e]);
        for (const [a, b] of hits) { if (a > s && a < e) cuts.add(a); if (b > s && b < e) cuts.add(b); }
        const pts = [...cuts].sort((x, y) => x - y);
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i]; const b = pts[i + 1];
          const inHit = hits.some(([x, y]) => a >= x && b <= y);
          out.push({ kind: 'text', openTag: r.openTag, text: r.text.slice(a - s, b - s), rPr: inHit ? mergeRunProps(r.rPr, fmt) : r.rPr });
        }
      }
      seg = [];
    };
    for (const p of pieces) {
      if (p.kind === 'text') seg.push(p);
      else { flush(); out.push(p); }
    }
    flush();
    if (!touched) return pXml;
    return `${open}${head}${out.map((p) => (p.kind === 'text' ? runXml(p) : p.xml)).join('')}${tail}</w:p>`;
  });
  return { newXml, count };
}

/* ───────────── 插段落级块 (表 / 图) ───────────── */

/** 第 afterIndex 段的结束位置; 在表格单元格里返回 inTable=true (那里插块会让单元格结构非法) */
function locateParagraph(documentXml: string, afterIndex: number): { end: number; inTable: boolean } | null {
  const tbls: Array<[number, number]> = [];
  for (const m of documentXml.matchAll(/<w:tbl\b[\s\S]*?<\/w:tbl>/g)) tbls.push([m.index!, m.index! + m[0].length]);
  let idx = 0;
  for (const m of documentXml.matchAll(W_P_RE)) {
    if (idx++ === afterIndex) {
      const start = m.index!;
      return { end: start + m[0].length, inTable: tbls.some(([a, b]) => start > a && start < b) };
    }
  }
  return null;
}

function insertBlockAfter(documentXml: string, afterIndex: number, blockXml: string): { newXml: string; error?: string } {
  if (afterIndex < 0) {
    const bodyOpen = /<w:body>/.exec(documentXml);
    if (!bodyOpen) return { newXml: documentXml, error: '找不到 <w:body>' };
    const at = bodyOpen.index + bodyOpen[0].length;
    return { newXml: documentXml.slice(0, at) + blockXml + documentXml.slice(at) };
  }
  const loc = locateParagraph(documentXml, afterIndex);
  if (!loc) return { newXml: documentXml, error: `第 ${afterIndex} 段不存在, 先调 word_get_paragraphs 看编号` };
  if (loc.inTable) return { newXml: documentXml, error: `第 ${afterIndex} 段在表格单元格里, 不能在那里插; 换一个表格外的段落编号` };
  return { newXml: documentXml.slice(0, loc.end) + blockXml + documentXml.slice(loc.end) };
}

/** 页面正文宽度 (twips): 从 sectPr 的 pgSz - 左右 pgMar 算; 读不到按 A4 默认边距 */
export function textWidthTwips(documentXml: string): number {
  const pgW = Number(/<w:pgSz\b[^>]*w:w="(\d+)"/.exec(documentXml)?.[1] ?? 11906);
  const left = Number(/<w:pgMar\b[^>]*w:left="(\d+)"/.exec(documentXml)?.[1] ?? 1800);
  const right = Number(/<w:pgMar\b[^>]*w:right="(\d+)"/.exec(documentXml)?.[1] ?? 1800);
  return Math.max(2000, pgW - left - right);
}

/**
 * 给 docx 注册一个**外部**超链接关系, 返回 rId。
 *
 *  `TargetMode="External"` 一个字都不能少 —— 缺了 Word 会把这个 URL 当**包内部件**去找,
 * 打开时报"无法读取的内容", 而且报错完全不指向链接。
 *
 * rId 分配沿用 insertImage 那套: 扫现有 rels 里最大的 rIdN 再 +1, 不假设初始有几个。
 */
export async function addHyperlinkRel(zip: JSZip, url: string): Promise<string> {
  const relsPath = 'word/_rels/document.xml.rels';
  const rels = (await zip.file(relsPath)?.async('string'))
    ?? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  const maxRid = Math.max(0, ...[...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1])));
  const rId = `rId${maxRid + 1}`;
  const rel = `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(url)}" TargetMode="External"/>`;
  zip.file(relsPath, rels.replace('</Relationships>', `${rel}</Relationships>`));
  return rId;
}

/**
 * 超链接 run。**不能用 `rStyle w:val="Hyperlink"`** —— word_create 生成的文档没有
 * styles.xml, 引用一个不存在的样式 Word 会当无格式渲染, 链接看起来跟正文一样。
 * 所以蓝色下划线写成直接格式。
 */
export function buildHyperlinkRun(rId: string, text: string): string {
  return `<w:hyperlink r:id="${rId}"><w:r><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/><w:sz w:val="22"/></w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:hyperlink>`;
}

export function buildTableXml(rows: string[][], opts: { header?: boolean; widthTwips: number }): string {
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const colW = Math.floor(opts.widthTwips / cols);
  const border = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/>`;
  const tblPr = `<w:tblPr><w:tblW w:w="${colW * cols}" w:type="dxa"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>`;
  const grid = `<w:tblGrid>${Array.from({ length: cols }, () => `<w:gridCol w:w="${colW}"/>`).join('')}</w:tblGrid>`;
  const trs = rows.map((r, ri) => {
    const isHead = opts.header !== false && ri === 0 && rows.length > 1;
    const trPr = isHead ? '<w:trPr><w:tblHeader/></w:trPr>' : '';
    const tcs = Array.from({ length: cols }, (_, ci) => {
      const text = String(r[ci] ?? '');
      const shd = isHead ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' : '';
      const rPr = isHead ? '<w:rPr><w:b/><w:bCs/></w:rPr>' : '';
      const runs = text.split('\n').map((line, li) => `${li ? '<w:r><w:br/></w:r>' : ''}<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>`).join('');
      return `<w:tc><w:tcPr><w:tcW w:w="${colW}" w:type="dxa"/>${shd}</w:tcPr><w:p>${runs}</w:p></w:tc>`;
    }).join('');
    return `<w:tr>${trPr}${tcs}</w:tr>`;
  }).join('');
  /* 表后跟一个空段: 连着插两张表 / 表在文档末尾时, Word 要求表后有段落 */
  return `<w:tbl>${tblPr}${grid}${trs}</w:tbl><w:p/>`;
}

export function insertTableAfter(documentXml: string, afterIndex: number, rows: string[][], opts: { header?: boolean } = {}): { newXml: string; error?: string } {
  if (!rows.length) return { newXml: documentXml, error: 'rows 不能为空' };
  return insertBlockAfter(documentXml, afterIndex, buildTableXml(rows, { header: opts.header, widthTwips: textWidthTwips(documentXml) }));
}

/* ───────────── 图片 ───────────── */

export function imageSize(buf: Uint8Array): { width: number; height: number; ext: 'png' | 'jpeg' | 'gif' } | null {
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return { width: dv.getUint32(16), height: dv.getUint32(20), ext: 'png' };
  }
  if (buf.length > 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: buf[6] | (buf[7] << 8), height: buf[8] | (buf[9] << 8), ext: 'gif' };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = (buf[i + 2] << 8) | buf[i + 3];
      /* SOF0..SOF15 (除 DHT C4 / JPG C8 / DAC CC) 带尺寸 */
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: (buf[i + 5] << 8) | buf[i + 6], width: (buf[i + 7] << 8) | buf[i + 8], ext: 'jpeg' };
      }
      i += 2 + len;
    }
  }
  return null;
}

const EMU_PER_PX = 9525;      /* 96 dpi */
const EMU_PER_TWIP = 635;

export function buildImageParagraph(opts: { rId: string; docPrId: number; name: string; cx: number; cy: number }): string {
  const { rId, docPrId, name, cx, cy } = opts;
  const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
  return `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">`
    + `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${docPrId}" name="${escapeXml(name)}"/>`
    + `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${A}" noChangeAspect="1"/></wp:cNvGraphicFramePr>`
    + `<a:graphic xmlns:a="${A}"><a:graphicData uri="${PIC}"><pic:pic xmlns:pic="${PIC}">`
    + `<pic:nvPicPr><pic:cNvPr id="0" name="${escapeXml(name)}"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
    + `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

/**
 * 在 docx zip 里插一张图: 媒体文件 + 关系 + content type + 段落。返回新的 document.xml (zip 里的其它零件已就地改好)。
 * widthCm 不给 = 原尺寸 (96dpi), 但不超过正文宽。
 */
export async function insertImage(
  zip: JSZip,
  documentXml: string,
  afterIndex: number,
  image: Uint8Array,
  opts: { widthCm?: number; caption?: string; name?: string } = {},
): Promise<{ newXml: string; error?: string; widthCm?: number; heightCm?: number }> {
  const size = imageSize(image);
  if (!size || !size.width || !size.height) return { newXml: documentXml, error: '只支持 PNG / JPEG / GIF (读不到图片尺寸)' };
  const maxCx = textWidthTwips(documentXml) * EMU_PER_TWIP;
  let cx = opts.widthCm ? Math.round(opts.widthCm * 360000) : size.width * EMU_PER_PX;
  if (cx > maxCx) cx = maxCx;
  const cy = Math.round(cx * (size.height / size.width));

  const relsPath = 'word/_rels/document.xml.rels';
  const rels = (await zip.file(relsPath)?.async('string')) ?? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  const maxRid = Math.max(0, ...[...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1])));
  const rId = `rId${maxRid + 1}`;
  let n = 1; while (zip.file(`word/media/neox_image${n}.${size.ext}`)) n++;
  const media = `media/neox_image${n}.${size.ext}`;
  zip.file(`word/${media}`, image);
  zip.file(relsPath, rels.replace('</Relationships>',
    `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${media}"/></Relationships>`));
  const ctPath = '[Content_Types].xml';
  const ct = await zip.file(ctPath)?.async('string');
  if (ct && !new RegExp(`<Default\\b[^>]*Extension="${size.ext}"`, 'i').test(ct)) {
    zip.file(ctPath, ct.replace('</Types>', `<Default Extension="${size.ext}" ContentType="image/${size.ext}"/></Types>`));
  }

  let xml = documentXml;
  /* 图片段落要用 wp: / r: 前缀; 个别生成器的根元素没声明, 补上 */
  xml = xml.replace(/<w:document\b([^>]*)>/, (whole, attrsStr: string) => {
    let a = attrsStr;
    if (!/xmlns:wp=/.test(a)) a += ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
    if (!/xmlns:r=/.test(a)) a += ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    return `<w:document${a}>`;
  });
  const docPrId = Math.max(0, ...[...xml.matchAll(/<wp:docPr\b[^>]*\bid="(\d+)"/g)].map((m) => Number(m[1]))) + 1;
  let block = buildImageParagraph({ rId, docPrId, name: opts.name ?? `图片 ${docPrId}`, cx, cy });
  if (opts.caption) {
    block += `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:i/><w:color w:val="595959"/><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${escapeXml(opts.caption)}</w:t></w:r></w:p>`;
  }
  const r = insertBlockAfter(xml, afterIndex, block);
  if (r.error) return { newXml: documentXml, error: r.error };
  return { newXml: r.newXml, widthCm: Math.round((cx / 360000) * 10) / 10, heightCm: Math.round((cy / 360000) * 10) / 10 };
}
