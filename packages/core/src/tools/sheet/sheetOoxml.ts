/**
 * sheetOoxml edits an existing .xlsx in place.
 *
 * The implementation edits only the targeted cell XML inside the zip package,
 * 其余字节原样留在包里 —— 样式表、图表、透视缓存、定义名、别的 sheet 一概不碰。
 *
 * ─── 规则 ───────────────────────────────────────────────────────────────────
 *  · 保留单元格的样式 (s 属性): 改数不改格式。
 *  · 公式单元格默认**不许**被写成值 (那等于把公式删了), 要显式 overwrite_formulas。
 *    共享公式的主单元格 / 数组公式永远拒: 改了它, 挂在它下面的一片单元格全坏。
 *  · 写完置 workbook calcPr fullCalcOnLoad=1: 依赖这些格的公式缓存值已过期, 打开时重算。
 *  · 动过公式就删 calcChain (Excel 发现链里的格不再是公式会报"已修复")。
 *  · 文本一律写成 inlineStr, 不改 sharedStrings (改它要重排索引, 牵一发动全身)。
 *
 * 纯字符串 + 正则, 不引 DOM 解析器 —— 跟 wordOoxml 同一取舍; 覆盖 Excel / WPS / openpyxl /
 * Numbers exports. Unknown structures such as rows or cells without r
 * attributes return an error instead of being guessed.
 */
import JSZip from 'jszip';

export interface CellEdit {
  /** A1 形式, 如 "B3" */
  cell: string;
  /** 数字 / 文本 / 布尔 / 空 (null 或 "" = 清空, 保留样式) */
  value?: string | number | boolean | null;
  /** 公式, 带不带开头的 = 都行 */
  formula?: string;
  /** 数字样子的字符串也按文本写 */
  asText?: boolean;
}

export interface CellChange {
  cell: string;
  before: string;
  after: string;
}

export interface SetCellsResult {
  xml: string;
  changes: CellChange[];
  skipped: Array<{ cell: string; reason: string }>;
  /** 写了公式或覆盖了公式 → 要删 calcChain */
  formulasTouched: boolean;
}

export interface SheetEntry {
  name: string;
  /** 包内路径, 如 xl/worksheets/sheet1.xml */
  path: string;
}

/* ───────────── 坐标 ───────────── */

export function colToNumber(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

export function numberToCol(n: number): string {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function parseCellRef(ref: string): { col: number; row: number; ref: string } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(ref.trim());
  if (!m) return null;
  const col = colToNumber(m[1]);
  const row = Number(m[2]);
  if (col < 1 || col > 16384 || row < 1 || row > 1048576) return null;
  return { col, row, ref: `${numberToCol(col)}${row}` };
}

/* ───────────── XML 小工具 ───────────── */

export function escapeXml(s: string): string {
  return s
    /* XML 1.0 不许的控制字符直接去掉, 否则整个包打不开 */
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

function attrs(tagOpen: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tagOpen))) out[m[1]] = m[2];
  return out;
}

/* ───────────── workbook: sheet 名 → 包内路径 ───────────── */

export function listSheets(workbookXml: string, relsXml: string): SheetEntry[] {
  const targets = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const a = attrs(m[0]);
    if (a.Id && a.Target) targets.set(a.Id, a.Target);
  }
  const out: SheetEntry[] = [];
  for (const m of workbookXml.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const a = attrs(m[0]);
    const rid = a['r:id'] ?? Object.entries(a).find(([k]) => /:id$/.test(k))?.[1];
    const target = rid ? targets.get(rid) : undefined;
    if (!a.name || !target) continue;
    const p = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    out.push({ name: unescapeXml(a.name), path: p });
  }
  return out;
}

export function readSharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  const out: string[] = [];
  for (const si of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    /* 富文本 <r><t>..</t></r> 多段拼起来; 注音 <rPh> 里的 <t> 不算 */
    const body = si[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
    out.push([...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unescapeXml(t[1])).join(''));
  }
  return out;
}

/* ───────────── 单元格 ───────────── */

interface ParsedCell { raw: string; open: string; body: string; col: number; ref: string }

const CELL_RE = /<c\b([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g;
const ROW_RE = /<row\b([^>]*?)(\/>|>([\s\S]*?)<\/row>)/g;

function describeExisting(cell: ParsedCell | undefined, shared: string[]): string {
  if (!cell) return '';
  const f = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(cell.body);
  if (f) return `=${unescapeXml(f[1])}`;
  if (/<f\b[^>]*\/>/.test(cell.body)) return '=(共享公式)';
  const t = attrs(cell.open).t;
  if (t === 'inlineStr') {
    return [...cell.body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1])).join('');
  }
  const v = /<v>([\s\S]*?)<\/v>/.exec(cell.body)?.[1];
  if (v === undefined) return '';
  if (t === 's') return shared[Number(v)] ?? '';
  if (t === 'b') return v === '1' ? 'TRUE' : 'FALSE';
  return unescapeXml(v);
}

function buildCell(ref: string, styleAttr: string, edit: CellEdit): { xml: string; after: string; isFormula: boolean } {
  const s = styleAttr ? ` s="${styleAttr}"` : '';
  if (typeof edit.formula === 'string' && edit.formula.trim()) {
    const f = edit.formula.trim().replace(/^=/, '');
    return { xml: `<c r="${ref}"${s}><f>${escapeXml(f)}</f></c>`, after: `=${f}`, isFormula: true };
  }
  const v = edit.value;
  if (v === null || v === undefined || v === '') {
    return { xml: `<c r="${ref}"${s}/>`, after: '', isFormula: false };
  }
  if (typeof v === 'boolean') {
    return { xml: `<c r="${ref}"${s} t="b"><v>${v ? 1 : 0}</v></c>`, after: v ? 'TRUE' : 'FALSE', isFormula: false };
  }
  if (typeof v === 'number' || (!edit.asText && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v.trim()))) {
    const n = typeof v === 'number' ? v : Number(v.trim());
    if (!Number.isFinite(n)) throw new Error(`${ref}: 不是有限数字 (${String(v)})`);
    return { xml: `<c r="${ref}"${s}><v>${String(n)}</v></c>`, after: String(n), isFormula: false };
  }
  const text = String(v);
  const preserve = /^\s|\s$|\n/.test(text) ? ' xml:space="preserve"' : '';
  return { xml: `<c r="${ref}"${s} t="inlineStr"><is><t${preserve}>${escapeXml(text)}</t></is></c>`, after: text, isFormula: false };
}

/**
 * 在一个 worksheet XML 上改一批单元格。纯函数, 可单测。
 */
export function setCellsInSheetXml(
  sheetXml: string,
  edits: CellEdit[],
  opts: { overwriteFormulas?: boolean; sharedStrings?: string[] } = {},
): SetCellsResult {
  const shared = opts.sharedStrings ?? [];
  const changes: CellChange[] = [];
  const skipped: Array<{ cell: string; reason: string }> = [];
  let formulasTouched = false;

  let xml = sheetXml.replace(/<sheetData\s*\/>/, '<sheetData></sheetData>');
  const sdOpen = /<sheetData\b[^>]*>/.exec(xml);
  const sdClose = xml.indexOf('</sheetData>');
  if (!sdOpen || sdClose < 0) throw new Error('工作表里找不到 <sheetData> —— 不是常规的 worksheet 结构');
  const head = xml.slice(0, sdOpen.index + sdOpen[0].length);
  const tail = xml.slice(sdClose);
  let data = xml.slice(sdOpen.index + sdOpen[0].length, sdClose);

  /* 同一格给了两次, 以最后一次为准 */
  const byRef = new Map<string, { col: number; row: number; ref: string; edit: CellEdit }>();
  for (const e of edits) {
    const p = parseCellRef(String(e.cell ?? ''));
    if (!p) { skipped.push({ cell: String(e.cell), reason: '不是合法的单元格地址 (要 A1 形式)' }); continue; }
    byRef.set(p.ref, { ...p, edit: e });
  }
  const byRow = new Map<number, Array<{ col: number; ref: string; edit: CellEdit }>>();
  for (const v of byRef.values()) {
    const list = byRow.get(v.row) ?? [];
    list.push(v);
    byRow.set(v.row, list);
  }

  let maxRow = 0; let maxCol = 0;

  for (const [rowNum, rowEdits] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) {
    /* 找这一行 */
    let rowMatch: RegExpExecArray | null = null;
    let insertAt = data.length;
    ROW_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ROW_RE.exec(data))) {
      const r = attrs(`<row ${m[1]}>`).r;
      if (!r) throw new Error('有的行没有 r 属性 (行号) —— 这种结构不支持原地改, 用 sheet_new_workbook 另存');
      const rn = Number(r);
      if (rn === rowNum) { rowMatch = m; break; }
      if (rn > rowNum) { insertAt = m.index; break; }
    }

    let rowOpen: string; let rowBody: string; let rowStart: number; let rowEnd: number;
    if (rowMatch) {
      rowOpen = `<row${rowMatch[1]}>`;
      rowBody = rowMatch[2] === '/>' ? '' : (rowMatch[3] ?? '');
      rowStart = rowMatch.index; rowEnd = rowMatch.index + rowMatch[0].length;
    } else {
      rowOpen = `<row r="${rowNum}">`;
      rowBody = '';
      rowStart = insertAt; rowEnd = insertAt;
    }

    /* 这一行现有的格 */
    const cells: ParsedCell[] = [];
    CELL_RE.lastIndex = 0;
    let cm: RegExpExecArray | null;
    while ((cm = CELL_RE.exec(rowBody))) {
      const a = attrs(`<c ${cm[1]}>`);
      const p = a.r ? parseCellRef(a.r) : null;
      if (!p) throw new Error(`第 ${rowNum} 行有没有地址 (r 属性) 的单元格 —— 这种结构不支持原地改`);
      cells.push({ raw: cm[0], open: `<c ${cm[1]}>`, body: cm[2] === '/>' ? '' : (cm[3] ?? ''), col: p.col, ref: p.ref });
    }

    for (const e of rowEdits.sort((a, b) => a.col - b.col)) {
      const idx = cells.findIndex((c) => c.col === e.col);
      const existing = idx >= 0 ? cells[idx] : undefined;
      if (existing) {
        const fTag = /<f\b[^>]*>/.exec(existing.body)?.[0] ?? /<f\b[^>]*\/>/.exec(existing.body)?.[0];
        if (fTag) {
          const fa = attrs(fTag);
          if ((fa.t === 'shared' && fa.ref) || fa.t === 'array') {
            skipped.push({ cell: e.ref, reason: `这是${fa.t === 'array' ? '数组公式' : '共享公式的主单元格'} (管着 ${fa.ref ?? '一片'} 的公式), 改了会连带弄坏一片, 不改` });
            continue;
          }
          const writingFormula = typeof e.edit.formula === 'string' && e.edit.formula.trim();
          if (!writingFormula && !opts.overwriteFormulas) {
            skipped.push({ cell: e.ref, reason: `这格是公式 (${describeExisting(existing, shared)}), 写成值等于删掉公式; 真要这么做传 overwrite_formulas: true` });
            continue;
          }
          formulasTouched = true;
        }
      }
      const style = existing ? (attrs(existing.open).s ?? '') : (/\bs="(\d+)"/.exec(rowOpen)?.[1] && /\bcustomFormat="1"/.test(rowOpen) ? /\bs="(\d+)"/.exec(rowOpen)![1] : '');
      const built = buildCell(e.ref, style, e.edit);
      if (built.isFormula) formulasTouched = true;
      const before = describeExisting(existing, shared);
      const next: ParsedCell = { raw: built.xml, open: '', body: '', col: e.col, ref: e.ref };
      if (idx >= 0) cells[idx] = next;
      else {
        const pos = cells.findIndex((c) => c.col > e.col);
        if (pos < 0) cells.push(next); else cells.splice(pos, 0, next);
      }
      changes.push({ cell: e.ref, before, after: built.after });
      maxRow = Math.max(maxRow, rowNum); maxCol = Math.max(maxCol, e.col);
    }

    /* spans="1:3" 是行内列范围的提示, 新格可能越界 —— 去掉让 Excel 自己算, 比算错安全 */
    const newOpen = rowOpen.replace(/\sspans="[^"]*"/, '');
    const newRow = `${newOpen}${cells.map((c) => c.raw).join('')}</row>`;
    data = data.slice(0, rowStart) + newRow + data.slice(rowEnd);
  }

  xml = head + data + tail;

  /* dimension 要罩住新写的格, 否则有的读取端只看 dimension 就漏数据 */
  if (maxRow > 0) {
    xml = xml.replace(/<dimension\b[^>]*\bref="([^"]*)"[^>]*\/>/, (whole, ref: string) => {
      const [a, b] = ref.split(':');
      const pa = parseCellRef(a); const pb = parseCellRef(b ?? a);
      if (!pa || !pb) return whole;
      const r2 = Math.max(pb.row, maxRow); const c2 = Math.max(pb.col, maxCol);
      return whole.replace(ref, `${pa.ref}:${numberToCol(c2)}${r2}`);
    });
  }

  return { xml, changes, skipped, formulasTouched };
}

/* ───────────── workbook 级收尾 ───────────── */

/** 置 calcPr fullCalcOnLoad="1": 依赖被改格的公式缓存值已经过期, 让 Excel/WPS 打开时重算 */
export function ensureFullCalcOnLoad(workbookXml: string): string {
  const calc = /<calcPr\b[^>]*\/?>/.exec(workbookXml);
  if (calc) {
    const tag = calc[0];
    const nextTag = /\bfullCalcOnLoad="[^"]*"/.test(tag)
      ? tag.replace(/\bfullCalcOnLoad="[^"]*"/, 'fullCalcOnLoad="1"')
      : tag.replace(/^<calcPr\b/, '<calcPr fullCalcOnLoad="1"');
    return workbookXml.replace(tag, nextTag);
  }
  /* schema 顺序: calcPr 在 definedNames 之后、下面这些之前 */
  const after = /<(oleSize|customWorkbookViews|pivotCaches|smartTagPr|smartTagTypes|webPublishing|fileRecoveryPr|webPublishObjects|extLst)\b/.exec(workbookXml);
  const at = after ? after.index : workbookXml.lastIndexOf('</workbook>');
  if (at < 0) return workbookXml;
  return workbookXml.slice(0, at) + '<calcPr fullCalcOnLoad="1"/>' + workbookXml.slice(at);
}

/** 删 calcChain (零件 + workbook 关系 + content type), Excel 打开时自己重建 */
export async function removeCalcChain(zip: JSZip): Promise<void> {
  if (!zip.file('xl/calcChain.xml')) return;
  zip.remove('xl/calcChain.xml');
  const relsPath = 'xl/_rels/workbook.xml.rels';
  const rels = await zip.file(relsPath)?.async('string');
  if (rels) zip.file(relsPath, rels.replace(/<Relationship\b[^>]*Type="[^"]*\/calcChain"[^>]*\/>/g, ''));
  const ct = await zip.file('[Content_Types].xml')?.async('string');
  if (ct) zip.file('[Content_Types].xml', ct.replace(/<Override\b[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/g, ''));
}

/**
 * 在一份 .xlsx 的字节上改单元格, 返回新字节。不碰磁盘 (写盘/校验在工具层)。
 */
export async function editXlsxBuffer(
  buf: Buffer,
  sheetName: string | undefined,
  edits: CellEdit[],
  opts: { overwriteFormulas?: boolean } = {},
): Promise<{ out: Buffer | null; sheet: string; sheets: string[]; result: SetCellsResult }> {
  const zip = await JSZip.loadAsync(buf);
  const wbXml = await zip.file('xl/workbook.xml')?.async('string');
  const relsXml = await zip.file('xl/_rels/workbook.xml.rels')?.async('string');
  if (!wbXml || !relsXml) throw new Error('不是 .xlsx (缺 xl/workbook.xml) —— .xls / .csv 不能原地改');
  const sheets = listSheets(wbXml, relsXml);
  if (sheets.length === 0) throw new Error('workbook 里没有工作表');
  const target = sheetName ? sheets.find((s) => s.name === sheetName) : sheets[0];
  if (!target) throw new Error(`没有叫「${sheetName}」的工作表; 有: ${sheets.map((s) => s.name).join(', ')}`);
  const sheetXml = await zip.file(target.path)?.async('string');
  if (!sheetXml) throw new Error(`工作表零件缺失: ${target.path}`);
  const shared = readSharedStrings((await zip.file('xl/sharedStrings.xml')?.async('string')) ?? null);

  const result = setCellsInSheetXml(sheetXml, edits, { overwriteFormulas: opts.overwriteFormulas, sharedStrings: shared });
  if (result.changes.length === 0) return { out: null, sheet: target.name, sheets: sheets.map((s) => s.name), result };

  zip.file(target.path, result.xml);
  zip.file('xl/workbook.xml', ensureFullCalcOnLoad(wbXml));
  if (result.formulasTouched) await removeCalcChain(zip);
  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return { out, sheet: target.name, sheets: sheets.map((s) => s.name), result };
}
