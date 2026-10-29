/**
 * Excel (xlsx/xls/csv/tsv) 本地解析 — 用 SheetJS xlsx (browser-compatible).
 *
 * 对应 NeoxCloud 的 excelParser, 逻辑完全镜像 (SheetJS 跨平台同包).
 * 多 sheet 间用 ## sheet name 标题分隔, 单 sheet 超 1000 行截断.
 */

import {
  EXCEL_SAFETY_LIMITS,
  SAFE_XLSX_READ_OPTIONS,
  assertExcelBufferSafe,
  escapeMarkdownCell,
  safeSheetNames,
  safeSheetTitle,
  sheetRows,
} from './xlsxSafety';

let xlsxPromise: Promise<any> | null = null;

async function getXlsx(): Promise<any> {
  if (!xlsxPromise) {
    xlsxPromise = import('xlsx').then((m: any) => m.default ?? m);
  }
  return xlsxPromise;
}

const MAX_ROWS_PER_SHEET = 1000;

function arrayToMarkdownTable(rows: any[][]): string {
  if (rows.length === 0) return '_(空 sheet)_';
  const truncated = rows.length > MAX_ROWS_PER_SHEET;
  const usable = truncated ? rows.slice(0, MAX_ROWS_PER_SHEET) : rows;
  const maxCols = Math.max(...usable.map(r => r.length));
  const norm = usable.map(r => {
    const out: string[] = [];
    for (let i = 0; i < maxCols; i++) {
      const v = r[i];
      out.push(v === undefined || v === null ? '' : escapeMarkdownCell(v));
    }
    return out;
  });
  const header = norm[0];
  const body = norm.slice(1);
  const lines: string[] = [];
  lines.push(`| ${header.join(' | ')} |`);
  lines.push(`| ${header.map(() => '---').join(' | ')} |`);
  for (const row of body) lines.push(`| ${row.join(' | ')} |`);
  if (truncated) {
    lines.push('');
    lines.push(`_..${rows.length - MAX_ROWS_PER_SHEET} 行已省略 (单 sheet 上限 ${MAX_ROWS_PER_SHEET} 行)_`);
  }
  return lines.join('\n');
}

export async function parseExcelLocal(buffer: ArrayBuffer): Promise<{ markdown: string; sheets: number }> {
  assertExcelBufferSafe(buffer, 'Excel parser input');
  const XLSX = await getXlsx();
  const workbook = XLSX.read(new Uint8Array(buffer), SAFE_XLSX_READ_OPTIONS);
  const allSheetCount = Array.isArray(workbook.SheetNames) ? workbook.SheetNames.length : 0;
  const sheetNames = safeSheetNames(workbook);
  const sections: string[] = [];
  for (const name of sheetNames) {
    const sheet = workbook.Sheets[name];
    const rows = sheetRows(XLSX, sheet, {
      maxRows: EXCEL_SAFETY_LIMITS.maxMarkdownRows,
      maxColumns: EXCEL_SAFETY_LIMITS.maxColumns,
    });
    sections.push(`## ${safeSheetTitle(name)}\n\n${arrayToMarkdownTable(rows)}`);
  }
  if (allSheetCount > sheetNames.length) {
    sections.push(`_..${allSheetCount - sheetNames.length} sheets omitted (limit ${EXCEL_SAFETY_LIMITS.maxSheets})_`);
  }
  return {
    markdown: sections.join('\n\n'),
    sheets: allSheetCount,
  };
}
