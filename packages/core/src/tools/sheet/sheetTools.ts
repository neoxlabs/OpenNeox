/**
 * Sheet agent tools (S1 Phase 1).
 *
 *   5 个核心工具 (memory project_neox_sheet_univer_protocol.md 里 14 工具的精简子集):
 *     · sheet_describe       — 结构概览 (sheet 名 / used range / 行列数)
 *     · sheet_get_range      — 读 A1 notation 区域 → markdown table
 *     · sheet_new_workbook   — 创建空 workbook, 返 workbook_id (D4 加)
 *     · sheet_write_range    — 写一片单元格到内存 workbook (D4 加)
 *     · sheet_export_file    — 把内存 workbook 写到磁盘 .xlsx (D4 加)
 *
 *   读类支持两种 source:
 *     1. file_path (绝对路径或 workspace 相对) — 直接读盘 + SheetJS 解析
 *     2. workbook_id (sheetWorkbookStore 内存 workbook) — agent 之前 new_workbook 的
 *
 *   range 用 A1 notation: 'Sheet1!A1:C10' / 'A1:C10' (默认第一个 sheet) / 'Sheet1' (整 sheet)
 *
 *   返结构尽量 markdown 友好, LLM token 经济 — 大表只返 used range 不返全空白行.
 */

import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { ToolCategory } from '@neoxlabs/kernel/types/permissions.js';
import { getWorkbook } from './sheetWorkbookStore.js';
import { getWorkspaceRootFromContext } from '@neoxlabs/kernel/tools/workspaceContext.js';
import { compactDescribeJson } from '../delivery/compactToolReport.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  SAFE_XLSX_FILE_READ_OPTIONS,
  SHEET_SAFETY_LIMITS,
  assertSheetFileSafe,
  boundedSheetRange,
  escapeMarkdownCell,
  safeSheetNames,
  safeSheetTitle,
  sheetRows,
} from './sheetSafety.js';
import { readXlsxFormulas } from './sheetOoxmlRead.js';
import {
  TABLE_FULL_READ_MAX_ROWS,
  TABLE_SUMMARY_THRESHOLD_ROWS,
  buildTableSummaryMarkdown,
} from './sheetTableSummary.js';

/* 懒 import xlsx — 这个包 ~600KB, tools.ts 模块加载时不拖 */
let xlsxModule: any = null;
async function getXlsx(): Promise<any> {
  if (!xlsxModule) {
    xlsxModule = await import('xlsx').then((m: any) => m.default ?? m);
  }
  return xlsxModule;
}

/** 解析 A1 notation: 'Sheet1!A1:C10' → {sheet:'Sheet1', range:'A1:C10'}; 'A1:C10' → {range}; 'Sheet1' → {sheet} */
function parseA1Notation(input: string): { sheet?: string; range?: string } {
  const trimmed = input.trim();
  if (!trimmed) return {};
  const bang = trimmed.indexOf('!');
  if (bang < 0) {
    /* 没 ! — 要么纯 range (A1:B2) 要么纯 sheet 名 */
    if (/^[A-Z]+\d+(:[A-Z]+\d+)?$/i.test(trimmed)) return { range: trimmed };
    return { sheet: trimmed };
  }
  const sheet = trimmed.slice(0, bang).replace(/^['"]|['"]$/g, '');
  const range = trimmed.slice(bang + 1);
  return { sheet, range };
}

/**
 * 把 SheetJS sheet → markdown table (每行 = | a | b | c |). 限 50 列 / 1000 行防爆 token.
 *
 * formulas: 单元格 → 公式文本。只用于**没有缓存值**的公式格 (Excel 打开才计算的那种) ——
 * 有缓存值时照旧显示值, 输出跟改动前一致; 没值时显示 `=公式`, 免得模型把空格当成没内容。
 */
function sheetToMarkdownTable(
  XLSX: any,
  ws: any,
  rangeStr?: string,
  formulas?: Map<string, string>,
  opts?: { maxRows?: number },
): string {
  const MAX_COLS = 50;
  const MAX_ROWS = opts?.maxRows ?? 1000;
  let range = rangeStr;
  if (rangeStr) {
    try {
      const decoded = XLSX.utils.decode_range(rangeStr);
      decoded.e.r = Math.min(decoded.e.r, decoded.s.r + MAX_ROWS - 1);
      decoded.e.c = Math.min(decoded.e.c, decoded.s.c + SHEET_SAFETY_LIMITS.maxColumns - 1);
      range = XLSX.utils.encode_range(decoded);
    } catch {
      range = rangeStr;
    }
  }
  const rows = sheetRows(XLSX, ws, { range });
  if (rows.length === 0) return '(empty)';

  /* 表里第一格的实际地址 —— 算公式格地址要用 (range 不一定是 A1 起) */
  const effRange = range ?? boundedSheetRange(XLSX, ws);
  const start = effRange ? XLSX.utils.decode_range(effRange).s : { r: 0, c: 0 };

  const truncCols = rows.some(r => r && r.length > MAX_COLS);
  const truncRows = rows.length > MAX_ROWS;
  const slicedRows = truncRows ? rows.slice(0, MAX_ROWS) : rows;
  const slicedColCount = Math.min(MAX_COLS, Math.max(...slicedRows.map(r => r?.length ?? 0)));

  const cellText = (rowIndex: number, colIndex: number, value: unknown): string => {
    const empty = value === '' || value === null || value === undefined;
    if (empty && formulas?.size) {
      const ref = XLSX.utils.encode_cell({ r: start.r + rowIndex, c: start.c + colIndex });
      const f = formulas.get(ref);
      if (f) return escapeMarkdownCell(`=${f}`);
    }
    return escapeMarkdownCell(value);
  };

  const out: string[] = [];
  /* 头行 = 第 1 行实际数据 (不另造列名, 让 LLM 看到 user 的原表头) */
  const header = slicedRows[0] ?? [];
  const headerCells = Array.from({ length: slicedColCount }, (_, i) => cellText(0, i, header[i]));
  out.push('| ' + headerCells.join(' | ') + ' |');
  out.push('| ' + headerCells.map(() => '---').join(' | ') + ' |');
  for (let r = 1; r < slicedRows.length; r++) {
    const row = slicedRows[r] ?? [];
    const cells = Array.from({ length: slicedColCount }, (_, i) => cellText(r, i, row[i]));
    out.push('| ' + cells.join(' | ') + ' |');
  }
  if (truncCols || truncRows) {
    out.push('');
    out.push(`> ⚠ truncated to ${slicedColCount} cols × ${slicedRows.length} rows (orig: ${rows[0]?.length ?? 0} cols × ${rows.length} rows). 用 range 参数 (e.g. \`Sheet1!A1:Z100\`) 缩范围.`);
  }
  return out.join('\n');
}

/** 共用: 拿到 SheetJS workbook 实例 — 要么从内存 store, 要么从 file_path 读盘. */
async function resolveWorkbook(opts: { file_path?: string; workbook_id?: string }): Promise<{ wb: any; sourceLabel: string; absPath?: string } | { error: string }> {
  if (opts.workbook_id) {
    const w = getWorkbook(opts.workbook_id);
    if (!w) return { error: `workbook_id "${opts.workbook_id}" 不存在或已过期 (TTL 1h)` };
    return { wb: w.wb, sourceLabel: `workbook_id=${opts.workbook_id} (${w.name})` };
  }
  if (opts.file_path) {
    const workspace = getWorkspaceRootFromContext() ?? process.env.NEOX_WORKDIR ?? process.cwd();
    const abs = path.isAbsolute(opts.file_path) ? opts.file_path : path.join(workspace, opts.file_path);
    if (!fs.existsSync(abs)) return { error: `文件不存在: ${abs}` };
    try {
      assertSheetFileSafe(abs);
      const XLSX = await getXlsx();
      /* 公式一律读 (work O-04): 老路径 cellFormula:false 已删 —— 读表不能把公式读成死数。
       * sheetStubs 让「只有公式、还没有缓存值」的格也留在表里, 否则它会被整格跳过、列跟着错位。 */
      const wb = XLSX.readFile(abs, { ...SAFE_XLSX_FILE_READ_OPTIONS, cellFormula: true, sheetStubs: true });
      return { wb, sourceLabel: `file=${abs}`, absPath: abs };
    } catch (e: any) {
      return { error: `读 ${abs} 失败: ${e?.message ?? String(e)}` };
    }
  }
  return { error: '必须提供 file_path 或 workbook_id 之一' };
}

/**
 * 这个工作表里哪些格是公式 (格地址 → 公式文本)。
 *
 * 优先走 OOXML (sheetOoxmlRead.ts): 共享公式的从属格、没有缓存值的公式格都能拿到;
 * 文件不是 zip (老 .xls / .csv) 或解析失败时退回 SheetJS 自己带的 `cell.f`。
 */
async function collectSheetFormulas(absPath: string | undefined, ws: any, sheetName: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (absPath && /\.(xlsx|xlsm)$/i.test(absPath)) {
    try {
      const sheets = await readXlsxFormulas(absPath);
      const hit = sheets.find((s) => s.name === sheetName);
      if (hit && hit.formulas.length) {
        for (const f of hit.formulas) out.set(f.cell, f.formula);
        return out;
      }
    } catch { /* 读不了就退回 SheetJS 的 f */ }
  }
  if (ws) {
    for (const key of Object.keys(ws)) {
      if (!key.startsWith('!') && ws[key]?.f) out.set(key, String(ws[key].f));
    }
  }
  return out;
}

/* ============================================================
 * sheet_describe
 * ============================================================ */
export const sheetDescribeTool: Tool = {
  name: 'sheet_describe',
  description: `Describe an Excel workbook: list sheet names, each sheet's used range + row/col counts. **Does NOT read data** — token-cheap structural overview, call this first before sheet_get_range to know what you are dealing with.

Input source (one of):
- file_path: absolute or workspace-relative path to .xlsx/.xls/.csv/.tsv
- workbook_id: id from sheet_new_workbook (in-memory workbook)

Returns JSON: { sheets: [{name, used_range, rows, cols}, ...], total_sheets, mtime_ms? }.

**Live editing note**: If the file is opened in a Sheet surface, the user can edit cells directly
and changes are auto-saved to disk within ~300ms. Always re-call this tool when you need
current state — don't trust prior readings. Use mtime_ms to detect changes between calls.`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'safe',
  isReadOnly: true,
  permission: { category: ToolCategory.READ, allowInAskMode: true },
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '.xlsx/.xls/.csv/.tsv path (absolute or workspace-relative)' },
      workbook_id: { type: 'string', description: 'In-memory workbook id from sheet_new_workbook' },
    },
    required: [],
  },
  async function(args: { file_path?: string; workbook_id?: string }): Promise<string> {
    const r = await resolveWorkbook(args);
    if ('error' in r) return JSON.stringify({ error: r.error });
    const { wb, sourceLabel } = r;
    const XLSX = await getXlsx();
    const allSheetCount = Array.isArray(wb.SheetNames) ? wb.SheetNames.length : 0;
    const sheets = safeSheetNames(wb).map((name: string) => {
      const ws = wb.Sheets[name];
      const usedRange = ws['!ref'] || '';
      let rows = 0, cols = 0;
      if (usedRange) {
        const decoded = XLSX.utils.decode_range(usedRange);
        rows = decoded.e.r - decoded.s.r + 1;
        cols = decoded.e.c - decoded.s.c + 1;
      }
      return { name: safeSheetTitle(name), used_range: usedRange, rows, cols };
    });
    /* mtime — 让 LLM 能跨轮比对"文件有没有动过", 比当前内容比对省 token. file source 才有. */
    let mtime_ms: number | undefined;
    if (args.file_path) {
      try {
        const workspace = getWorkspaceRootFromContext() ?? process.env.NEOX_WORKDIR ?? process.cwd();
        const abs = path.isAbsolute(args.file_path) ? args.file_path : path.join(workspace, args.file_path);
        mtime_ms = fs.statSync(abs).mtimeMs;
      } catch { /* ignore — describe 已经成功就别因 stat 失败而报错 */ }
    }
    /* work:H-19 — describe 是「结构概览」, 正常情况下只有一两百字节。几十个 sheet 的
     * 工作簿会超出返回预算, 这时按名字截断并写清总数, 不要整段灌进 context。 */
    return compactDescribeJson({ source: sourceLabel, total_sheets: allSheetCount, sheets, mtime_ms });
  },
};

/* ============================================================
 * sheet_get_range
 * ============================================================ */
export const sheetGetRangeTool: Tool = {
  name: 'sheet_get_range',
  description: `Read a range from a sheet, return markdown table. A1 notation.

range examples:
- 'Sheet1!A1:C10'  — explicit sheet + range
- 'A1:C10'         — first sheet, given range
- 'Sheet1'         — entire used range of named sheet
- (omit range)     — first sheet's entire used range

Handles .xlsx/.xls/.csv/.tsv. Token-heavy on big sheets: a range over 2000 rows returns a **summary + sampled rows** (header, row/col counts, per-column non-empty stats, value samples, real row numbers) instead of the data. Read the full range only when you really need it by passing full=true (up to 20000 rows); otherwise use an explicit range to read one window at a time. Small ranges are still auto-truncated to 50 cols × 1000 rows.

Every formula in the range is listed at the bottom as \`B4: =SUM(B2:B3)   (cached: 300)\`. A formula cell shows its
cached value in the table; if the file has no cached value yet it shows \`=formula\` instead. Check that list before
sheet_set_cells — plain values are refused on formula cells unless you pass overwrite_formulas:true.

**Live editing note**: Reads disk fresh every call. If the file is opened in a Sheet surface,
the user may be editing cells right now — always re-call this tool when current data matters,
do NOT reuse prior tool results across turns.`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'safe',
  isReadOnly: true,
  permission: { category: ToolCategory.READ, allowInAskMode: true },
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '.xlsx path; provide this OR workbook_id' },
      workbook_id: { type: 'string', description: 'In-memory workbook id; provide this OR file_path' },
      range: { type: 'string', description: 'A1 notation: Sheet1!A1:C10 / A1:C10 / Sheet1 (entire sheet) / omit for first sheet' },
      full: { type: 'boolean', description: `Read the whole range even when it has more than ${TABLE_SUMMARY_THRESHOLD_ROWS} rows (default: return a summary + sampled rows instead). Up to ${TABLE_FULL_READ_MAX_ROWS} rows.` },
      include_formulas: { type: 'boolean', description: 'Deprecated — formulas are now always listed (work O-04). Kept for compatibility; passing it changes nothing.' },
    },
    required: [],
  },
  async function(args: { file_path?: string; workbook_id?: string; range?: string; full?: boolean; include_formulas?: boolean }): Promise<string> {
    const r = await resolveWorkbook(args);
    if ('error' in r) return JSON.stringify({ error: r.error });
    const { wb, sourceLabel, absPath } = r;
    const XLSX = await getXlsx();
    const parsed = parseA1Notation(args.range ?? '');
    const sheetName = parsed.sheet ?? safeSheetNames(wb, 1)[0];
    if (!sheetName) return JSON.stringify({ error: 'workbook 没有 sheet' });
    const ws = wb.Sheets[sheetName];
    if (!ws) return JSON.stringify({ error: `sheet "${sheetName}" 不存在. 可用 sheets: ${wb.SheetNames.join(', ')}` });

    const formulaMap = await collectSheetFormulas(absPath, ws, sheetName);

    /* 大表默认摘要 + 抽样 (work H-13): >2000 行不返回全量, 全量必须 full=true。
     * 行数按「生效范围」算 —— 显式 range 也要走这条, 否则 range 一给就等于绕过摘要。 */
    const effectiveRef = parsed.range ?? (typeof ws['!ref'] === 'string' ? ws['!ref'] : '');
    let spanRows = 0;
    let spanCols = 0;
    if (effectiveRef) {
      try {
        const decoded = XLSX.utils.decode_range(effectiveRef);
        spanRows = decoded.e.r - decoded.s.r + 1;
        spanCols = decoded.e.c - decoded.s.c + 1;
      } catch { /* 解析不了就当小表, 走原来的路径 */ }
    }
    if (args.full !== true && spanRows > TABLE_SUMMARY_THRESHOLD_ROWS) {
      const summary = buildTableSummaryMarkdown({
        XLSX, ws, sheetName, range: effectiveRef || undefined, totalRows: spanRows, totalCols: spanCols,
        formulaCount: formulaMap.size,
      });
      return `${sourceLabel} · sheet="${sheetName}"${parsed.range ? ` · range=${parsed.range}` : ''}\n\n${summary}`;
    }

    /* full=true 时放宽到 20000 行; 否则保持原来的 1000 行硬截断。
     * 没给 range 时必须自己造一个放宽后的范围 —— sheetRows 的默认范围还是 1000 行。 */
    const fullRead = args.full === true;
    const readRange = parsed.range
      ?? (fullRead ? boundedSheetRange(XLSX, ws, TABLE_FULL_READ_MAX_ROWS, 50) : undefined);
    const md = sheetToMarkdownTable(
      XLSX, ws, readRange, formulaMap,
      fullRead ? { maxRows: TABLE_FULL_READ_MAX_ROWS } : undefined,
    );

    /* 公式清单一直给 (work O-04): 不传 include_formulas 也有, 模型才知道哪些格不能拿值去盖。 */
    let formulas = '';
    if (formulaMap.size) {
      const bounds = parsed.range ? XLSX.utils.decode_range(parsed.range) : (ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null);
      const list: string[] = [];
      for (const [ref, f] of [...formulaMap.entries()].sort((a, b) => {
        const pa = XLSX.utils.decode_cell(a[0]); const pb = XLSX.utils.decode_cell(b[0]);
        return pa.r - pb.r || pa.c - pb.c;
      })) {
        const a = XLSX.utils.decode_cell(ref);
        if (bounds && (a.r < bounds.s.r || a.r > bounds.e.r || a.c < bounds.s.c || a.c > bounds.e.c)) continue;
        const cached = ws[ref]?.v;
        list.push(`${ref}: =${f}${cached === undefined ? '' : `   (cached: ${String(cached)})`}`);
      }
      if (list.length) {
        formulas = `\n\nFormulas (${list.length}${list.length > 200 ? ', first 200' : ''}) — these cells hold formulas, not values; sheet_set_cells refuses to overwrite them with plain values (pass overwrite_formulas:true to do it anyway):\n${list.slice(0, 200).join('\n')}`;
      }
    }
    return `${sourceLabel} · sheet="${sheetName}"${parsed.range ? ` · range=${parsed.range}` : ''}\n\n${md}${formulas}`;
  },
};
