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
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  SAFE_XLSX_FILE_READ_OPTIONS,
  SHEET_SAFETY_LIMITS,
  assertSheetFileSafe,
  escapeMarkdownCell,
  safeSheetNames,
  safeSheetTitle,
  sheetRows,
} from './sheetSafety.js';

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

/** 把 SheetJS sheet → markdown table (每行 = | a | b | c |). 限 50 列 / 1000 行防爆 token. */
function sheetToMarkdownTable(XLSX: any, ws: any, rangeStr?: string): string {
  const MAX_COLS = 50;
  const MAX_ROWS = 1000;
  let range = rangeStr;
  if (rangeStr) {
    try {
      const decoded = XLSX.utils.decode_range(rangeStr);
      decoded.e.r = Math.min(decoded.e.r, decoded.s.r + SHEET_SAFETY_LIMITS.maxRows - 1);
      decoded.e.c = Math.min(decoded.e.c, decoded.s.c + SHEET_SAFETY_LIMITS.maxColumns - 1);
      range = XLSX.utils.encode_range(decoded);
    } catch {
      range = rangeStr;
    }
  }
  const rows = sheetRows(XLSX, ws, { range });
  if (rows.length === 0) return '(empty)';

  const truncCols = rows.some(r => r && r.length > MAX_COLS);
  const truncRows = rows.length > MAX_ROWS;
  const slicedRows = truncRows ? rows.slice(0, MAX_ROWS) : rows;
  const slicedColCount = Math.min(MAX_COLS, Math.max(...slicedRows.map(r => r?.length ?? 0)));

  const out: string[] = [];
  /* 头行 = 第 1 行实际数据 (不另造列名, 让 LLM 看到 user 的原表头) */
  const header = slicedRows[0] ?? [];
  const headerCells = Array.from({ length: slicedColCount }, (_, i) => escapeMarkdownCell(header[i]));
  out.push('| ' + headerCells.join(' | ') + ' |');
  out.push('| ' + headerCells.map(() => '---').join(' | ') + ' |');
  for (let r = 1; r < slicedRows.length; r++) {
    const row = slicedRows[r] ?? [];
    const cells = Array.from({ length: slicedColCount }, (_, i) => escapeMarkdownCell(row[i]));
    out.push('| ' + cells.join(' | ') + ' |');
  }
  if (truncCols || truncRows) {
    out.push('');
    out.push(`> ⚠ truncated to ${slicedColCount} cols × ${slicedRows.length} rows (orig: ${rows[0]?.length ?? 0} cols × ${rows.length} rows). 用 range 参数 (e.g. \`Sheet1!A1:Z100\`) 缩范围.`);
  }
  return out.join('\n');
}

/** 共用: 拿到 SheetJS workbook 实例 — 要么从内存 store, 要么从 file_path 读盘. */
async function resolveWorkbook(opts: { file_path?: string; workbook_id?: string; withFormulas?: boolean }): Promise<{ wb: any; sourceLabel: string } | { error: string }> {
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
      /* 公式默认不读 (省 token); sheet_get_range include_formulas 时读 —— 原地改之前得知道哪些格是公式 */
      const wb = XLSX.readFile(abs, opts.withFormulas ? { ...SAFE_XLSX_FILE_READ_OPTIONS, cellFormula: true, sheetStubs: true } : SAFE_XLSX_FILE_READ_OPTIONS);
      return { wb, sourceLabel: `file=${abs}` };
    } catch (e: any) {
      return { error: `读 ${abs} 失败: ${e?.message ?? String(e)}` };
    }
  }
  return { error: '必须提供 file_path 或 workbook_id 之一' };
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
    return JSON.stringify({ source: sourceLabel, total_sheets: allSheetCount, sheets, mtime_ms });
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

Token-heavy on big sheets — auto-truncated to 50 cols × 1000 rows; use explicit range to read more or different windows.

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
      include_formulas: { type: 'boolean', description: 'Also list which cells in the range are formulas (e.g. "B9: =SUM(B2:B8)"). Use before sheet_set_cells so you do not overwrite formulas.' },
    },
    required: [],
  },
  async function(args: { file_path?: string; workbook_id?: string; range?: string; include_formulas?: boolean }): Promise<string> {
    const r = await resolveWorkbook({ ...args, withFormulas: args.include_formulas === true });
    if ('error' in r) return JSON.stringify({ error: r.error });
    const { wb, sourceLabel } = r;
    const XLSX = await getXlsx();
    const parsed = parseA1Notation(args.range ?? '');
    const sheetName = parsed.sheet ?? safeSheetNames(wb, 1)[0];
    if (!sheetName) return JSON.stringify({ error: 'workbook 没有 sheet' });
    const ws = wb.Sheets[sheetName];
    if (!ws) return JSON.stringify({ error: `sheet "${sheetName}" 不存在. 可用 sheets: ${wb.SheetNames.join(', ')}` });

    const md = sheetToMarkdownTable(XLSX, ws, parsed.range);
    let formulas = '';
    if (args.include_formulas) {
      const bounds = parsed.range ? XLSX.utils.decode_range(parsed.range) : (ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null);
      const list: string[] = [];
      for (const key of Object.keys(ws)) {
        if (key.startsWith('!') || !ws[key]?.f) continue;
        const a = XLSX.utils.decode_cell(key);
        if (bounds && (a.r < bounds.s.r || a.r > bounds.e.r || a.c < bounds.s.c || a.c > bounds.e.c)) continue;
        list.push(`${key}: =${ws[key].f}`);
      }
      formulas = list.length
        ? `\n\nFormulas (${list.length}${list.length > 200 ? ', first 200' : ''}) — sheet_set_cells will refuse to overwrite these with plain values:\n${list.slice(0, 200).join('\n')}`
        : '\n\nFormulas: none in this range';
    }
    return `${sourceLabel} · sheet="${sheetName}"${parsed.range ? ` · range=${parsed.range}` : ''}\n\n${md}${formulas}`;
  },
};
