/**
 * Sheet write tools (S1 Phase 1 后三件):
 *   · sheet_new_workbook   — 创建空 workbook (内存), 返 workbook_id
 *   · sheet_write_range    — 写一片单元格到内存 workbook (A1 notation 起点 + 2D 数据)
 *   · sheet_export_file    — 把内存 workbook 写到磁盘 .xlsx (workspace 相对路径或绝对)
 *
 * 读写 + new + export 凑齐 LLM-driven Excel 生成全流程:
 *   1. agent 调 sheet_new_workbook → 拿 workbook_id
 *   2. agent 用 LLM 推理 / 算数据, 多轮调 sheet_write_range 填表
 *   3. agent 调 sheet_export_file 写到 user workspace, 触发 SheetSurfaceViewer
 *
 * 写策略: data 是 2D 数组, 第一行不强制为 header — agent 自由决策.
 *         range 用 A1 起点 (e.g. 'Sheet1!A1' / 'A1') 不要 end —
 *         end 自动从 data 尺寸推. 这样 agent 不用算 'A1:G50' 这种边界,
 *         省 token + 少错.
 */

import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { ToolCategory } from '@neoxlabs/kernel/types/permissions.js';
import { createWorkbook, getWorkbook } from './sheetWorkbookStore.js';
import { getWorkspaceRootFromContext } from '@neoxlabs/kernel/tools/workspaceContext.js';
import * as path from 'node:path';
import * as fs from 'node:fs';

/* 复用 sheetTools 里的 lazy xlsx — 但避免循环依赖, 这里独立 lazy. */
let xlsxModule: any = null;
async function getXlsx(): Promise<any> {
  if (!xlsxModule) {
    xlsxModule = await import('xlsx').then((m: any) => m.default ?? m);
  }
  return xlsxModule;
}

/** 解析 A1 起点: 'Sheet1!A1' → {sheet, cell:'A1'}; 'A1' → {cell:'A1'}; 'Sheet1' 不允许(必须有 cell). */
function parseA1Anchor(input: string): { sheet?: string; cell: string } | { error: string } {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return { error: 'range 不能为空, 至少给一个起点 cell (e.g. "A1" 或 "Sheet1!A1")' };
  const bang = trimmed.indexOf('!');
  let sheet: string | undefined;
  let cell: string;
  if (bang < 0) {
    cell = trimmed;
  } else {
    sheet = trimmed.slice(0, bang).replace(/^['"]|['"]$/g, '');
    cell = trimmed.slice(bang + 1);
  }
  /* cell 必须是单 cell 形如 A1 / AB12, 不接受 A1:B2 range — end 由 data 形状定 */
  if (!/^[A-Z]+\d+$/i.test(cell)) {
    return { error: `range 必须是单 cell 起点 (如 "A1" / "Sheet1!B5"), 不接受 "${cell}" 这种 range 形式` };
  }
  return { sheet, cell };
}

/* ============================================================
 * sheet_new_workbook
 * ============================================================ */
export const sheetNewWorkbookTool: Tool = {
  name: 'sheet_new_workbook',
  description: `Create a new empty in-memory workbook, returns workbook_id (TTL 1h, max 50 workbooks).
After this, use sheet_write_range to fill cells, then sheet_export_file to save to disk.

Optional 'name' is just a label for UI / list_workbooks; the actual file name is decided at sheet_export_file save_path time.`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'safe',
  isReadOnly: false,
  permission: { category: ToolCategory.WRITE, allowInAskMode: false },
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Optional label for this workbook (e.g. "monthly-report.xlsx"). Default: "untitled.xlsx"' },
      first_sheet_name: { type: 'string', description: 'Name of the first sheet. Default: "Sheet1"' },
    },
    required: [],
  },
  async function(args: { name?: string; first_sheet_name?: string }): Promise<string> {
    const XLSX = await getXlsx();
    const wb = XLSX.utils.book_new();
    /* SheetJS 要至少 1 个 sheet 才能 writeFile, 提前塞一个空 sheet */
    const sheetName = args.first_sheet_name?.trim() || 'Sheet1';
    const emptyWs = XLSX.utils.aoa_to_sheet([[]]);
    XLSX.utils.book_append_sheet(wb, emptyWs, sheetName);
    const id = createWorkbook(args.name?.trim() || 'untitled.xlsx', wb);
    return JSON.stringify({
      workbook_id: id,
      name: args.name?.trim() || 'untitled.xlsx',
      first_sheet: sheetName,
      hint: '下一步: sheet_write_range({workbook_id, range:"Sheet1!A1", data:[["header1","header2"],["v1","v2"]]}) 写数据, 然后 sheet_export_file 写盘.',
    });
  },
};

/* ============================================================
 * sheet_write_range
 * ============================================================ */
export const sheetWriteRangeTool: Tool = {
  name: 'sheet_write_range',
  description: `Write a 2D block of cells to an in-memory workbook starting at an anchor cell.

range = anchor cell only (A1 notation): 'Sheet1!A1' or 'A1' (defaults to first sheet).
       **Do NOT** give A1:C10 — end is computed from data shape.

data = 2D array. Inner arrays are rows; cells are string | number | boolean | null.
       Mixed types OK; nulls write blank. A string starting with "=" is written as a real
       formula (e.g. "=B2-C2", "=SUM(B2:B4)") — Excel calculates it when the file opens.

If the named sheet doesn't exist it is auto-created.
Overwrites any cells in the target rect; cells outside the rect are untouched.`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'unsafe', /* 同一 workbook 并发写危险, 标 unsafe 不并行 */
  isReadOnly: false,
  permission: { category: ToolCategory.WRITE, allowInAskMode: false },
  parameters: {
    type: 'object',
    properties: {
      workbook_id: { type: 'string', description: 'In-memory workbook id from sheet_new_workbook' },
      range: { type: 'string', description: 'Anchor cell (A1 notation): "Sheet1!A1" or "A1" for first sheet' },
      data: {
        type: 'array',
        description: '2D array of cell values. Each inner array is a row.',
        items: { type: 'array', items: {} },
      },
    },
    required: ['workbook_id', 'range', 'data'],
  },
  async function(args: { workbook_id: string; range: string; data: any[][] }): Promise<string> {
    if (!args.workbook_id) return JSON.stringify({ error: 'workbook_id 必填' });
    if (!Array.isArray(args.data) || args.data.length === 0) {
      return JSON.stringify({ error: 'data 必须是非空 2D 数组' });
    }
    if (!args.data.every(row => Array.isArray(row))) {
      return JSON.stringify({ error: 'data 每一行必须是数组' });
    }

    const stored = getWorkbook(args.workbook_id);
    if (!stored) return JSON.stringify({ error: `workbook_id "${args.workbook_id}" 不存在或已过期 (TTL 1h)` });

    const anchor = parseA1Anchor(args.range);
    if ('error' in anchor) return JSON.stringify({ error: anchor.error });

    const XLSX = await getXlsx();
    const wb = stored.wb;
    const sheetName = anchor.sheet ?? wb.SheetNames[0];
    if (!sheetName) return JSON.stringify({ error: 'workbook 没有任何 sheet — 这不应该发生' });

    /* sheet 不存在自动建 — agent 友好, 不用单独 add_sheet 工具 */
    if (!wb.Sheets[sheetName]) {
      const newWs = XLSX.utils.aoa_to_sheet([[]]);
      XLSX.utils.book_append_sheet(wb, newWs, sheetName);
    }
    const ws = wb.Sheets[sheetName];

    /* sheet_add_aoa 把 2D 数组从 origin 起点写入, 自动扩 !ref */
    XLSX.utils.sheet_add_aoa(ws, args.data, { origin: anchor.cell });

    const rows = args.data.length;
    const cols = Math.max(...args.data.map(r => r.length));

    let formulas = 0;
    const origin = XLSX.utils.decode_cell(anchor.cell);
    args.data.forEach((row, r) => row.forEach((v, c) => {
      if (typeof v !== 'string' || !/^=\S/.test(v.trim())) return;
      const addr = XLSX.utils.encode_cell({ r: origin.r + r, c: origin.c + c });
      ws[addr] = { t: 'n', f: v.trim().slice(1) };
      formulas += 1;
    }));
    return JSON.stringify({
      ok: true,
      workbook_id: args.workbook_id,
      sheet: sheetName,
      anchor: anchor.cell,
      wrote: { rows, cols },
      ...(formulas ? { formulas } : {}),
      used_range: ws['!ref'] ?? '',
    });
  },
};

/* ============================================================
 * sheet_export_file
 * ============================================================ */
export const sheetExportFileTool: Tool = {
  name: 'sheet_export_file',
  description: `Persist an in-memory workbook to disk as .xlsx (or .csv if path ends .csv — exports first sheet only).

save_path = absolute or workspace-relative. Parent dir is created if missing.
overwrite = false (default) refuses to clobber existing file; set true to replace.

After export, the file can be opened in the right-pane SheetSurfaceViewer by the user (drag/click).
The in-memory workbook stays in store (still usable by id) until TTL or explicit delete.`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  permission: { category: ToolCategory.WRITE, allowInAskMode: false },
  parameters: {
    type: 'object',
    properties: {
      workbook_id: { type: 'string', description: 'In-memory workbook id' },
      save_path: { type: 'string', description: 'Output path: absolute or workspace-relative; .xlsx (default) or .csv' },
      overwrite: { type: 'boolean', description: 'Allow overwriting an existing file. Default false.' },
    },
    required: ['workbook_id', 'save_path'],
  },
  async function(args: { workbook_id: string; save_path: string; overwrite?: boolean }): Promise<string> {
    if (!args.workbook_id) return JSON.stringify({ error: 'workbook_id 必填' });
    if (!args.save_path) return JSON.stringify({ error: 'save_path 必填' });

    const stored = getWorkbook(args.workbook_id);
    if (!stored) return JSON.stringify({ error: `workbook_id "${args.workbook_id}" 不存在或已过期 (TTL 1h)` });

    const workspace = getWorkspaceRootFromContext() ?? process.env.NEOX_WORKDIR ?? process.cwd();
    const abs = path.isAbsolute(args.save_path) ? args.save_path : path.join(workspace, args.save_path);

    if (fs.existsSync(abs) && !args.overwrite) {
      return JSON.stringify({ error: `文件已存在: ${abs}. 设 overwrite=true 覆盖, 或换 save_path.` });
    }

    /* 父目录自动建 — agent 不用先调 create_directory */
    const parent = path.dirname(abs);
    if (!fs.existsSync(parent)) {
      try { fs.mkdirSync(parent, { recursive: true }); }
      catch (e: any) { return JSON.stringify({ error: `创建父目录失败 ${parent}: ${e?.message ?? String(e)}` }); }
    }

    try {
      const XLSX = await getXlsx();
      const ext = path.extname(abs).toLowerCase();
      /* csv: SheetJS writeFile 自动按扩展名走 csv 格式, 但只导第一个 sheet */
      const bookType = ext === '.csv' ? 'csv' : ext === '.xls' ? 'xls' : 'xlsx';
      XLSX.writeFile(stored.wb, abs, { bookType: bookType as any });
      const stat = fs.statSync(abs);
      return JSON.stringify({
        ok: true,
        file_path: abs,
        size_bytes: stat.size,
        format: bookType,
        sheets: stored.wb.SheetNames,
        hint: ext === '.csv' && stored.wb.SheetNames.length > 1
          ? `⚠ workbook 有 ${stored.wb.SheetNames.length} 个 sheet 但 csv 只导出了第一个 (${stored.wb.SheetNames[0]}). 用 .xlsx 保留全部.`
          : undefined,
      });
    } catch (e: any) {
      return JSON.stringify({ error: `写文件失败 ${abs}: ${e?.message ?? String(e)}` });
    }
  },
};
