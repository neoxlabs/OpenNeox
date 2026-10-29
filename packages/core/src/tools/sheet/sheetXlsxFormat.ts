import JSZip from 'jszip';
import { colToNumber, escapeXml, numberToCol, parseCellRef, unescapeXml } from './sheetOoxml.js';

/** 一个格子要的格式。字段都可缺省。 */
export interface SheetCellStyle {
  bold?: boolean;
  /** RRGGBB 或 #RRGGBB */
  bg?: string;
  align?: 'left' | 'center' | 'right';
  /** 预设名 (thousands/integer/percent/currency/date) 或 Excel 格式串 */
  num?: string;
}

/** 对工作表中某个矩形区域套一种格式。行列 1 起, 含端点。 */
export interface SheetStyleRequest {
  sheet: string;
  r1: number;
  c1: number;
  r2: number;
  c2: number;
  style: SheetCellStyle;
  /** 区域里的空格也补出来 (底色 / 边框这类"看得见"的格式需要) */
  fillBlanks?: boolean;
}

export interface ApplySheetStylesResult {
  /** null = 没有任何格子被改到 */
  out: Buffer | null;
  /** 被套上格式的单元格数 (含新建的空格) */
  applied: number;
  /** 每个请求实际生效的 cellXfs 索引 (排查用) */
  xfIndexes: number[];
  warnings: string[];
}

/** 数字格式预设。id 是 Excel 内建编号 (0 = 需要写自定义 numFmt)。 */
const NUM_PRESETS: Record<string, { id: number; code?: string; label: string }> = {
  thousands: { id: 4, label: '#,##0.00 (千分位)' },   /* Excel 的 "逗号样式" */
  integer: { id: 3, label: '#,##0' },
  percent: { id: 10, label: '0.00%' },
  currency: { id: 0, code: '"¥"#,##0.00', label: '货币 ¥' },
  date: { id: 0, code: 'yyyy-mm-dd', label: '日期 yyyy-mm-dd' },
};

/**
 * 校验并规范化 agent 给的 style。不认识的键/值不静默吞掉 —— 折成 warnings 让调用方写进回执。
 */
export function normalizeSheetStyle(raw: unknown): { style: SheetCellStyle; warnings: string[] } {
  const warnings: string[] = [];
  const style: SheetCellStyle = {};
  if (raw == null) return { style, warnings };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { style, warnings: ['style 必须是一个对象, 例如 {bold:true, bg:"D9E1F2", align:"center"}'] };
  }
  const o = raw as Record<string, unknown>;

  if (o.bold !== undefined) {
    if (typeof o.bold === 'boolean') style.bold = o.bold;
    else warnings.push(`style.bold 要 true/false, 收到 ${JSON.stringify(o.bold)}`);
  }
  if (o.bg !== undefined) {
    const hex = typeof o.bg === 'string' ? o.bg.trim().replace(/^#/, '') : '';
    if (/^[0-9a-fA-F]{6}$/.test(hex)) style.bg = hex.toUpperCase();
    else warnings.push(`style.bg 要 6 位十六进制颜色 (如 "D9E1F2" 或 "#D9E1F2"), 收到 ${JSON.stringify(o.bg)}`);
  }
  if (o.align !== undefined) {
    if (o.align === 'left' || o.align === 'center' || o.align === 'right') style.align = o.align;
    else warnings.push(`style.align 只能是 left / center / right, 收到 ${JSON.stringify(o.align)}`);
  }
  if (o.num !== undefined) {
    const num = typeof o.num === 'string' ? o.num.trim() : '';
    if (!num) warnings.push('style.num 给了空串, 忽略');
    else if (NUM_PRESETS[num]) style.num = num;
    else if (num.length <= 64 && isFormatCode(num)) style.num = num;
    else warnings.push(`style.num 不认识: ${JSON.stringify(o.num)} —— 可用 ${Object.keys(NUM_PRESETS).join('/')} 或直接给 Excel 格式串`);
  }
  for (const k of Object.keys(o)) {
    if (!['bold', 'bg', 'align', 'num'].includes(k)) warnings.push(`style.${k} 不支持 (只认 bold/bg/align/num)`);
  }
  return { style, warnings };
}

/* ───────────── styles.xml 读写 ───────────── */

/** 像不像 Excel 格式串: 有数字/文本占位符, 或者是日期时间 token (yyyy / mm / dd …) */
function isFormatCode(s: string): boolean {
  return /[0#?@]/.test(s) || /\b(y{2,4}|m{1,4}|d{1,4}|h{1,2}|s{1,2})\b/i.test(s);
}

const BLOCK_RE_CACHE = new Map<string, RegExp>();
function blockRe(tag: string): RegExp {
  let re = BLOCK_RE_CACHE.get(tag);
  if (!re) {
    re = new RegExp(`<${tag}\\b([^>]*?)(\\/>|>([\\s\\S]*?)<\\/${tag}>)`);
    BLOCK_RE_CACHE.set(tag, re);
  }
  return re;
}

/** 把 child 追加到 styles.xml 的某个块 (fonts / fills / numFmts / cellXfs) 末尾, 并维护 count */
function appendToBlock(xml: string, tag: string, childXml: string): string {
  const re = blockRe(tag);
  const m = re.exec(xml);
  if (!m) throw new Error(`styles.xml 里没有 <${tag}> 块 —— 不是常规的 xlsx 样式表`);
  const attrs = m[1] ?? '';
  if (m[2] === '/>') {
    /* 自闭合的空块 → 展开 */
    const open = `<${tag}${attrs.replace(/\s*count="\d+"/, '')} count="1">`;
    return xml.slice(0, m.index) + open + childXml + `</${tag}>` + xml.slice(m.index + m[0].length);
  }
  const body = m[3] ?? '';
  const nextCount = countChildren(body, tag) + 1;
  const open = `<${tag}${setCount(attrs, nextCount)}>`;
  const end = m.index + m[0].length - `</${tag}>`.length;
  return xml.slice(0, m.index) + open + body + childXml + `</${tag}>` + xml.slice(end + `</${tag}>`.length);
}

function countChildren(body: string, tag: string): number {
  const re = new RegExp(`<${tag}\\b`, 'g');
  return (body.match(re) ?? []).length;
}

function setCount(attrs: string, n: number): string {
  return /\bcount="\d+"/.test(attrs)
    ? attrs.replace(/\bcount="\d+"/, `count="${n}"`)
    : `${attrs} count="${n}"`;
}

function blockBody(xml: string, tag: string): string {
  const m = blockRe(tag).exec(xml);
  if (!m) throw new Error(`styles.xml 里没有 <${tag}> 块`);
  return m[3] ?? '';
}

/** numFmt id 不能撞: 从 164 起找第一个没被用的 */
function nextCustomNumFmtId(xml: string): number {
  let max = 163;
  for (const m of xml.matchAll(/<numFmt\b[^>]*\bnumFmtId="(\d+)"/g)) {
    const id = Number(m[1]);
    if (Number.isFinite(id) && id > max) max = id;
  }
  return max + 1;
}

/** 找到 (或新建) 一个 numFmt, 返回 id */
function ensureNumFmt(xml: string, code: string): { xml: string; id: number } {
  const codeAttr = escapeXml(code);
  const existing = new RegExp(`<numFmt\\b[^>]*\\bformatCode="${escapeRegExp(codeAttr)}"[^>]*\\bnumFmtId="(\\d+)"`).exec(xml)
    ?? new RegExp(`<numFmt\\b[^>]*\\bnumFmtId="(\\d+)"[^>]*\\bformatCode="${escapeRegExp(codeAttr)}"`).exec(xml);
  if (existing) return { xml, id: Number(existing[1]) };
  const id = nextCustomNumFmtId(xml);
  return { xml: appendToBlock(xml, 'numFmts', `<numFmt numFmtId="${id}" formatCode="${codeAttr}"/>`), id };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 找到一个加粗字体; 没有就从 0 号字体克隆一个加 <b/> 的 */
function ensureBoldFont(xml: string): { xml: string; id: number } {
  const fonts = blockBody(xml, 'fonts');
  const parts = splitElements(fonts, 'font');
  const idx = parts.findIndex((p) => /<b\s*\/>|<b\s+val="(1|true)"/i.test(p));
  if (idx >= 0) return { xml, id: idx };
  const base = parts[0] ?? '<font><sz val="11"/></font>';
  const bold = base
    .replace(/<b\b[^>]*\/>/gi, '')
    .replace(/^<font\b([^>]*)>/, '<font$1><b/>');
  return { xml: appendToBlock(xml, 'fonts', bold), id: parts.length };
}

/** 找到一个同色的实心填充; 没有就追加 */
function ensureFill(xml: string, rgb: string): { xml: string; id: number } {
  const fills = blockBody(xml, 'fills');
  const parts = splitElements(fills, 'fill');
  const target = rgb.toUpperCase();
  const idx = parts.findIndex((p) => new RegExp(`<fgColor\\b[^>]*\\brgb="(?:FF)?${target}"`, 'i').test(p));
  if (idx >= 0) return { xml, id: idx };
  const fill = `<fill><patternFill patternType="solid"><fgColor rgb="FF${target}"/><bgColor indexed="64"/></patternFill></fill>`;
  return { xml: appendToBlock(xml, 'fills', fill), id: parts.length };
}

/** 把 <tag .../> 或 <tag ...>...</tag> 序列切开 (同标签不嵌套) */
function splitElements(body: string, tag: string): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*\\/>|<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'g');
  return body.match(re) ?? [];
}

function ensureXf(
  xml: string,
  spec: { numFmtId: number; fontId: number; fillId: number; align?: string },
): { xml: string; id: number } {
  const xfs = blockBody(xml, 'cellXfs');
  const parts = splitElements(xfs, 'xf');
  /* 只认我们自己建出来的那几种组合 (agent 新工作簿里本来就只有 1 个默认 xf) */
  const key = `${spec.numFmtId}|${spec.fontId}|${spec.fillId}|${spec.align ?? ''}`;
  const idx = parts.findIndex((p) => xfKey(p) === key);
  if (idx >= 0) return { xml, id: idx };

  const applies = [
    spec.fontId > 0 ? 'applyFont="1"' : '',
    spec.fillId > 0 ? 'applyFill="1"' : '',
    spec.numFmtId > 0 ? 'applyNumberFormat="1"' : '',
    spec.align ? 'applyAlignment="1"' : '',
  ].filter(Boolean).join(' ');
  const alignment = spec.align
    ? `<alignment horizontal="${spec.align}" vertical="center"/>`
    : '';
  const xf = alignment
    ? `<xf numFmtId="${spec.numFmtId}" fontId="${spec.fontId}" fillId="${spec.fillId}" borderId="0" xfId="0"${applies ? ` ${applies}` : ''}>${alignment}</xf>`
    : `<xf numFmtId="${spec.numFmtId}" fontId="${spec.fontId}" fillId="${spec.fillId}" borderId="0" xfId="0"${applies ? ` ${applies}` : ''}/>`;
  return { xml: appendToBlock(xml, 'cellXfs', xf), id: parts.length };
}

function xfKey(xfXml: string): string {
  const attrs = /^<xf\b([^>]*?)\/?>/.exec(xfXml)?.[1] ?? '';
  const num = /\bnumFmtId="(\d+)"/.exec(attrs)?.[1] ?? '0';
  const font = /\bfontId="(\d+)"/.exec(attrs)?.[1] ?? '0';
  const fill = /\bfillId="(\d+)"/.exec(attrs)?.[1] ?? '0';
  const align = /\balignment\b[^>]*\bhorizontal="([^"]+)"/.exec(xfXml)?.[1] ?? '';
  return `${num}|${font}|${fill}|${align}`;
}

/** 一段 style → cellXfs 索引 (同一份 styles.xml 里复用) */
function styleToXfIndex(stylesXml: string, style: SheetCellStyle): { xml: string; id: number } {
  let xml = stylesXml;
  let numFmtId = 0;
  if (style.num) {
    const preset = NUM_PRESETS[style.num];
    if (preset?.id) numFmtId = preset.id;
    else {
      const r = ensureNumFmt(xml, preset?.code ?? style.num);
      xml = r.xml; numFmtId = r.id;
    }
  }
  let fontId = 0;
  if (style.bold) { const r = ensureBoldFont(xml); xml = r.xml; fontId = r.id; }
  let fillId = 0;
  if (style.bg) { const r = ensureFill(xml, style.bg); xml = r.xml; fillId = r.id; }
  const r = ensureXf(xml, { numFmtId, fontId, fillId, align: style.align });
  return { xml: r.xml, id: r.id };
}

/* ───────────── worksheet: 给已有 <c> 挂 s ───────────── */

function setCellStyleAttr(tagAttrs: string, styleIdx: number): string {
  const cleaned = tagAttrs.replace(/\s*\bs="\d+"/g, '');
  return `${cleaned} s="${styleIdx}"`;
}

/**
 * 给 worksheet XML 里落在任一请求矩形内的单元格挂样式。
 * 只改已存在的 `<c>`; 空格的补建由 ensureBlankCells 负责。
 */
export function styleSheetXml(
  sheetXml: string,
  spans: Array<{ r1: number; c1: number; r2: number; c2: number; xf: number }>,
): { xml: string; applied: number } {
  if (spans.length === 0) return { xml: sheetXml, applied: 0 };
  let applied = 0;
  const xml = sheetXml.replace(/<c\b([^>]*?)(\/>|>)/g, (whole, attrs: string, close: string) => {
    const ref = /\br="([^"]+)"/.exec(attrs)?.[1];
    if (!ref) return whole;
    const p = parseCellRef(ref);
    if (!p) return whole;
    let xf: number | undefined;
    for (const s of spans) {
      if (p.row >= s.r1 && p.row <= s.r2 && p.col >= s.c1 && p.col <= s.c2) xf = s.xf;
    }
    if (xf === undefined) return whole;
    applied += 1;
    return `<c${setCellStyleAttr(attrs, xf)}${close}`;
  });
  return { xml, applied };
}

const ROW_RE = /<row\b([^>]*?)(\/>|>([\s\S]*?)<\/row>)/g;
const CELL_RE = /<c\b([^>]*?)(\/>|>[\s\S]*?<\/c>)/g;

/**
 * 区域里的空格补成带样式的空 `<c>` (底色、边框这类格式落在空格上才看得出整片色块)。
 * 只用于 fillBlanks 的请求。
 */
export function ensureBlankCells(
  sheetXml: string,
  spans: Array<{ r1: number; c1: number; r2: number; c2: number; xf: number }>,
): { xml: string; created: number } {
  if (spans.length === 0) return { xml: sheetXml, created: 0 };

  const sdOpen = /<sheetData\b[^>]*>/.exec(sheetXml);
  const sdClose = sheetXml.indexOf('</sheetData>');
  if (!sdOpen || sdClose < 0) return { xml: sheetXml, created: 0 };
  const head = sheetXml.slice(0, sdOpen.index + sdOpen[0].length);
  const body = sheetXml.slice(sdOpen.index + sdOpen[0].length, sdClose);
  const tail = sheetXml.slice(sdClose);

  interface Row { r: number; open: string; cells: Array<{ col: number; raw: string }> }
  const rows: Row[] = [];
  ROW_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ROW_RE.exec(body))) {
    const attrs = m[1] ?? '';
    const rNum = Number(/\br="(\d+)"/.exec(attrs)?.[1] ?? 0);
    if (!rNum) continue;
    const selfClosing = m[2] === '/';
    const inner = selfClosing ? '' : (m[3] ?? '');
    const cells: Array<{ col: number; raw: string }> = [];
    CELL_RE.lastIndex = 0;
    let cm: RegExpExecArray | null;
    while ((cm = CELL_RE.exec(inner))) {
      const ref = /\br="([^"]+)"/.exec(cm[1] ?? '')?.[1];
      const p = ref ? parseCellRef(ref) : null;
      if (!p) continue;
      cells.push({ col: p.col, raw: cm[0] });
    }
    rows.push({ r: rNum, open: `<row${selfClosing ? attrs.replace(/\/$/, '') : attrs}>`, cells });
  }
  if (rows.length === 0) return { xml: sheetXml, created: 0 };

  const byRow = new Map(rows.map((r) => [r.r, r]));
  let created = 0;

  for (const s of spans) {
    for (let r = s.r1; r <= s.r2; r++) {
      let row = byRow.get(r);
      if (!row) {
        row = { r, open: `<row r="${r}">`, cells: [] };
        byRow.set(r, row);
        rows.push(row);
      }
      for (let c = s.c1; c <= s.c2; c++) {
        if (row.cells.some((x) => x.col === c)) continue;
        row.cells.push({ col: c, raw: `<c r="${numberToCol(c)}${r}" s="${s.xf}"/>` });
        created += 1;
      }
      row.cells.sort((a, b) => a.col - b.col);
    }
  }
  if (created === 0) return { xml: sheetXml, created: 0 };

  const out = rows
    .sort((a, b) => a.r - b.r)
    .map((row) => {
      /* spans 是列范围提示, 新格可能越界 —— 去掉让 Excel 自己算, 跟 sheetOoxml 同一取舍 */
      const open = row.open.replace(/\s+spans="[^"]*"/, '').replace(/\/>$/, '>');
      return `${open}${row.cells.map((c) => c.raw).join('')}</row>`;
    })
    .join('');
  return { xml: head + out + tail, created };
}

/* ───────────── 入口: 在一份 .xlsx 字节上套格式 ───────────── */

export async function applySheetStyles(
  buf: Buffer,
  requests: SheetStyleRequest[],
): Promise<ApplySheetStylesResult> {
  if (!requests.length) return { out: null, applied: 0, xfIndexes: [], warnings: [] };

  const zip = await JSZip.loadAsync(buf);
  const wbXml = await zip.file('xl/workbook.xml')?.async('string');
  const relsXml = await zip.file('xl/_rels/workbook.xml.rels')?.async('string');
  const stylesFile = zip.file('xl/styles.xml');
  if (!wbXml || !relsXml) throw new Error('不是 .xlsx (缺 xl/workbook.xml)');
  if (!stylesFile) throw new Error('xlsx 里没有 xl/styles.xml, 没法写格式');

  const sheetTargets = new Map<string, string>();
  for (const rm of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const a = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
    const attrs: Record<string, string> = {};
    let am: RegExpExecArray | null;
    while ((am = a.exec(rm[0]))) attrs[am[1]] = am[2];
    if (attrs.Id && /\/worksheet$/.test(attrs.Type ?? '')) {
      sheetTargets.set(attrs.Id, attrs.Target ?? '');
    }
  }
  const sheetPaths = new Map<string, string>();
  for (const sm of wbXml.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const name = /\bname="([^"]*)"/.exec(sm[0])?.[1];
    const rid = /\br:id="([^"]*)"/.exec(sm[0])?.[1];
    if (!name || !rid) continue;
    const target = sheetTargets.get(rid);
    if (!target) continue;
    sheetPaths.set(
      unescapeXml(name),
      target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`,
    );
  }

  let stylesXml = await stylesFile.async('string');
  const warnings: string[] = [];
  const xfIndexes: number[] = [];

  /* 按 sheet 归组, 每个请求先算出 xf 索引。不在库里的 sheet 名如实报, 不静默跳。 */
  const bySheet = new Map<string, Array<{ r1: number; c1: number; r2: number; c2: number; xf: number; fillBlanks?: boolean }>>();
  for (const req of requests) {
    const path = sheetPaths.get(req.sheet);
    if (!path) {
      warnings.push(`没有叫「${req.sheet}」的工作表, 格式没套上 (有: ${[...sheetPaths.keys()].join(', ')})`);
      continue;
    }
    const hasContent = req.style.bold || req.style.bg || req.style.align || req.style.num;
    if (!hasContent) continue;
    const r = styleToXfIndex(stylesXml, req.style);
    stylesXml = r.xml;
    xfIndexes.push(r.id);
    const list = bySheet.get(path) ?? [];
    list.push({
      r1: Math.max(1, req.r1), c1: Math.max(1, req.c1),
      r2: Math.max(1, req.r2), c2: Math.max(1, req.c2),
      xf: r.id,
      /* 纯字形/数字格式落在空格上没有意义, 只有底色值得补出空格 */
      fillBlanks: req.fillBlanks === true && !!req.style.bg,
    });
    bySheet.set(path, list);
  }
  if (bySheet.size === 0) return { out: null, applied: 0, xfIndexes, warnings };

  let applied = 0;
  for (const [path, spans] of bySheet) {
    const sheetXml = await zip.file(path)?.async('string');
    if (!sheetXml) {
      warnings.push(`工作表零件缺失: ${path}`);
      continue;
    }
    const styled = styleSheetXml(sheetXml, spans);
    let next = styled.xml;
    applied += styled.applied;
    const blanks = ensureBlankCells(next, spans.filter((s) => s.fillBlanks));
    next = blanks.xml;
    if (next !== sheetXml) zip.file(path, next);
  }
  zip.file('xl/styles.xml', stylesXml);

  const out = await zip.generateAsync({
    type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 },
  });
  return { out, applied, xfIndexes, warnings };
}

/** 给调用方 (工具) 用: 把 0 基的行列矩形转成 1 基请求 */
export function rectRequest(
  sheet: string,
  origin: { r: number; c: number },
  rows: number,
  cols: number,
  style: SheetCellStyle,
  fillBlanks = false,
): SheetStyleRequest {
  return {
    sheet,
    r1: origin.r + 1,
    c1: origin.c + 1,
    r2: origin.r + rows,
    c2: origin.c + cols,
    style,
    fillBlanks,
  };
}

/** 列宽: SheetJS 的 wch (字符宽) → '!cols' 数组下标是 0 基列号 */
export function applyColumnWidths(ws: any, startCol: number, widths: number[]): number {
  let applied = 0;
  const cols: any[] = Array.isArray(ws['!cols']) ? ws['!cols'] : [];
  widths.forEach((w, i) => {
    if (!(typeof w === 'number' && w > 0 && w <= 255)) return;
    const idx = startCol + i;
    cols[idx] = { ...(cols[idx] ?? {}), wch: w };
    applied += 1;
  });
  for (let i = 0; i < cols.length; i++) if (!cols[i]) cols[i] = {};
  ws['!cols'] = cols;
  return applied;
}

/** 只给测试/调试用: 读出一份 xlsx 里某格的 style 索引 */
export { colToNumber };
