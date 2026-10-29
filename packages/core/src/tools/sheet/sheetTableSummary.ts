
import { escapeMarkdownCell, sheetRows } from './sheetSafety.js';

/** 超过这个行数就默认给摘要; 全量需显式参数。 */
export const TABLE_SUMMARY_THRESHOLD_ROWS = 2000;

/** `full: true` 时一次最多读这么多行 (再大就按段读)。 */
export const TABLE_FULL_READ_MAX_ROWS = 20000;

const HEAD_ROWS = 12;
const TAIL_ROWS = 5;
const STRIDED_ROWS = 8;
const MAX_SUMMARY_COLS = 12;
const MAX_SAMPLE_VALUE_CHARS = 40;

export interface TableSummaryOptions {
  /** SheetJS 模块实例 (延迟 import 的那个) */
  XLSX: any;
  ws: any;
  sheetName: string;
  /** 生效范围 (A1 notation, 不含 sheet 名); undefined = 整个 used range */
  range?: string;
  totalRows: number;
  totalCols: number;
  formulaCount?: number;
}

/** 均匀抽样的行下标 (0-based), 升序去重: 头 HEAD_ROWS + 均匀 STRIDED_ROWS + 尾 TAIL_ROWS。 */
export function sampleRowIndices(totalRows: number): number[] {
  if (totalRows <= 0) return [];
  const picked = new Set<number>();
  for (let i = 0; i < Math.min(HEAD_ROWS, totalRows); i++) picked.add(i);
  for (let k = 1; k <= STRIDED_ROWS; k++) {
    const i = Math.floor((k * (totalRows - 1)) / (STRIDED_ROWS + 1));
    if (i >= 0 && i < totalRows) picked.add(i);
  }
  for (let i = Math.max(0, totalRows - TAIL_ROWS); i < totalRows; i++) picked.add(i);
  return [...picked].sort((a, b) => a - b);
}

export function buildTableSummaryMarkdown(opts: TableSummaryOptions): string {
  const { XLSX, ws, sheetName, range, totalRows, totalCols } = opts;
  const ref = range ?? (typeof ws?.['!ref'] === 'string' ? ws['!ref'] : undefined);
  const rows: any[][] = ref ? sheetRows(XLSX, ws, { range: ref }) : [];

  const colCount = Math.max(1, Math.min(totalCols, MAX_SUMMARY_COLS));
  const headerRow = rows[0] ?? [];
  const header = Array.from({ length: colCount }, (_, i) => {
    const raw = headerRow[i];
    const text = raw === '' || raw === null || raw === undefined ? '' : String(raw);
    return text ? escapeMarkdownCell(text) : `列${i + 1}`;
  });

  /* 非空计数 + 取值样例: 一遍扫完, 大表也只多一次线性遍历。 */
  const nonEmpty = new Array<number>(colCount).fill(0);
  const samples = Array.from({ length: colCount }, () => new Set<string>());
  for (const row of rows) {
    for (let c = 0; c < colCount; c++) {
      const v = row?.[c];
      if (v === '' || v === null || v === undefined) continue;
      nonEmpty[c]++;
      if (samples[c].size < 3) {
        const text = String(v).replace(/\s+/g, ' ').trim().slice(0, MAX_SAMPLE_VALUE_CHARS);
        if (text) samples[c].add(text);
      }
    }
  }

  const indices = sampleRowIndices(rows.length);
  const skipped = Math.max(0, rows.length - indices.length);

  const out: string[] = [];
  out.push(`▸ 大表摘要 · sheet="${sheetName}" · 共 ${totalRows} 行 × ${totalCols} 列 (阈值 ${TABLE_SUMMARY_THRESHOLD_ROWS} 行, 本次未返回全量数据)`);
  out.push(`▸ 表头 (前 ${colCount} 列): ${header.join(' | ')}`);
  out.push(`▸ 非空统计 (含表头): ${header.map((h, i) => `${h} ${nonEmpty[i]}/${totalRows}`).join(' · ')}`);
  const valueHints = header
    .map((h, i) => (samples[i].size ? `${h}: ${[...samples[i]].join(', ')}` : ''))
    .filter(Boolean);
  if (valueHints.length) out.push(`▸ 取值样例: ${valueHints.join(' · ')}`);
  if (opts.formulaCount) out.push(`▸ 公式格: ${opts.formulaCount} 个 (完整清单见文末)`);

  out.push('');
  out.push(`抽样 ${indices.length} 行 (行号 = 表内实际行号, 中间跳过 ${skipped} 行):`);
  out.push('| 行 | ' + header.join(' | ') + ' |');
  out.push('| --- | ' + header.map(() => '---').join(' | ') + ' |');
  for (const i of indices) {
    const row = rows[i] ?? [];
    const cells = Array.from({ length: colCount }, (_, c) => escapeMarkdownCell(row[c]));
    out.push(`| ${i + 1} | ${cells.join(' | ')} |`);
  }

  out.push('');
  out.push('怎么读全量 / 读指定段:');
  out.push(`- 读某一段: range="${sheetName}!A1001:${columnLetter(colCount)}2000" (一次 ≤${TABLE_SUMMARY_THRESHOLD_ROWS} 行最省 token, 行号照上表)`);
  out.push(`- 读全部: full=true (最多 ${TABLE_FULL_READ_MAX_ROWS} 行; 大表本身仍然很大, 优先按段读)`);
  return out.join('\n');
}

/** 1-based 列号 → A1 列字母 (1→A, 27→AA)。 */
export function columnLetter(col: number): string {
  let n = Math.max(1, Math.floor(col));
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}
