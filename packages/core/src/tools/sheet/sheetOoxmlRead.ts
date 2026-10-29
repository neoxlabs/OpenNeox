import * as fs from 'node:fs';
import JSZip from 'jszip';
import { listSheets, colToNumber, numberToCol, parseCellRef, unescapeXml } from './sheetOoxml.js';

export interface SheetFormula {
  /** A1 地址, 如 "B4" */
  cell: string;
  /** 公式文本, 不带开头的 "=" */
  formula: string;
  /** 从属于共享公式 (主公式在别的格), 公式已按行列偏移平移 */
  shared?: boolean;
}

export interface SheetFormulas {
  name: string;
  /** 包内路径, 如 xl/worksheets/sheet1.xml */
  path: string;
  formulas: SheetFormula[];
}

interface RawFormula {
  ref: string;
  /** <f> 上的属性 (t / ref / si) */
  attrs: Record<string, string>;
  text: string;
}

const CELL_RE = /<c\b([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g;

function attrsOf(tagOpen: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tagOpen))) out[m[1]] = m[2];
  return out;
}

/**
 * 把公式里的相对引用按行列偏移平移 (共享公式从属格用)。
 * 绝对引用 ($A$1) 不动; 引号里的字符串不动; 后面紧跟 "(" 的当成函数名跳过。
 */
export function translateFormula(
  formula: string,
  from: { row: number; col: number },
  to: { row: number; col: number },
): string {
  const dRow = to.row - from.row;
  const dCol = to.col - from.col;
  if (dRow === 0 && dCol === 0) return formula;

  /* 引号里的内容原样保留 (公式里出现形如 "A1" 的字符串时不能被当成引用改掉) */
  return formula
    .split(/("[^"]*")/)
    .map((part, idx) => {
      if (idx % 2 === 1) return part;
      return part.replace(
        /(?<![A-Za-z0-9_.$])(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})/g,
        (whole, cAbs: string, col: string, rAbs: string, row: string, offset: number, src: string) => {
          /* 函数名 (SUM / LOG10 之类) 后面紧跟 "(" 的, 不是单元格引用 */
          if (src[offset + whole.length] === '(') return whole;
          const colNum = colToNumber(col);
          if (colNum < 1 || colNum > 16384) return whole;
          const newCol = cAbs ? colNum : colNum + dCol;
          const newRow = rAbs ? Number(row) : Number(row) + dRow;
          if (newCol < 1 || newCol > 16384 || newRow < 1 || newRow > 1048576) return '#REF!';
          return `${cAbs}${numberToCol(newCol)}${rAbs}${newRow}`;
        },
      );
    })
    .join('');
}

/**
 * 解析一份 worksheet XML 里的公式。纯函数, 可单测。
 * 共享公式的从属格会按主公式平移展开 (标 shared: true)。
 */
export function parseSheetFormulas(sheetXml: string): SheetFormula[] {
  const raw: RawFormula[] = [];
  const sdOpen = /<sheetData\b[^>]*>/.exec(sheetXml);
  const sdClose = sheetXml.indexOf('</sheetData>');
  if (!sdOpen || sdClose < 0) return [];
  const body = sheetXml.slice(sdOpen.index + sdOpen[0].length, sdClose);

  CELL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CELL_RE.exec(body))) {
    const cellAttrs = attrsOf(`<c ${m[1]}>`);
    if (!cellAttrs.r) continue;
    const cellBody = m[2] === '/>' ? '' : (m[3] ?? '');
    const fFull = /<f\b([^>]*)>([\s\S]*?)<\/f>/.exec(cellBody);
    const fEmpty = fFull ? null : /<f\b([^>]*)\/>/.exec(cellBody);
    if (!fFull && !fEmpty) continue;
    const fAttrs = attrsOf(`<f ${fFull ? fFull[1] : fEmpty![1]}>`);
    raw.push({ ref: cellAttrs.r, attrs: fAttrs, text: fFull ? unescapeXml(fFull[2]) : '' });
  }

  /* 共享公式主格: si → { ref, formula } */
  const masters = new Map<string, { ref: string; formula: string }>();
  for (const r of raw) {
    if (r.attrs.t === 'shared' && r.text) masters.set(r.attrs.si ?? '0', { ref: r.ref, formula: r.text });
  }

  const out: SheetFormula[] = [];
  for (const r of raw) {
    const isShared = r.attrs.t === 'shared';
    if (!r.text) {
      /* 从属格: 只有 <f t="shared" si="n"/> —— 用主公式平移 */
      if (!isShared) continue;
      const master = masters.get(r.attrs.si ?? '0');
      if (!master) continue;
      const from = parseCellRef(master.ref);
      const to = parseCellRef(r.ref);
      if (!from || !to) continue;
      out.push({
        cell: to.ref,
        formula: translateFormula(master.formula, { row: from.row, col: from.col }, { row: to.row, col: to.col }),
        shared: true,
      });
      continue;
    }
    /* 主格 (带公式体) 与普通公式一视同仁; shared 只标「从属格」—— 那种格文件里没有公式体,
     * 是这里按主公式平移算出来的, 调用方需要知道它可能不是 Excel 里看到的最终文本 */
    out.push({ cell: r.ref, formula: r.text });
  }
  return out;
}

/**
 * 读一份 .xlsx / .xlsm 里所有工作表的公式。不是 zip / 缺 workbook 零件就抛 (调用方决定怎么退)。
 */
export async function readXlsxFormulas(absPath: string): Promise<SheetFormulas[]> {
  const zip = await JSZip.loadAsync(fs.readFileSync(absPath));
  const wbXml = await zip.file('xl/workbook.xml')?.async('string');
  const relsXml = await zip.file('xl/_rels/workbook.xml.rels')?.async('string');
  if (!wbXml || !relsXml) throw new Error('不是 .xlsx (缺 xl/workbook.xml)');

  const out: SheetFormulas[] = [];
  for (const sheet of listSheets(wbXml, relsXml)) {
    const sheetXml = await zip.file(sheet.path)?.async('string');
    if (!sheetXml) continue;
    out.push({ name: sheet.name, path: sheet.path, formulas: parseSheetFormulas(sheetXml) });
  }
  return out;
}
