/**
 * sheet_set_cells —— 原地改用户已有的 .xlsx (公式 / 样式 / 图表 / 透视表都留着)。
 * 实现在 sheetOoxml.ts; 这一层管路径、写盘原子性和写完的回读校验。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { ToolCategory } from '@neoxlabs/kernel/types/permissions.js';
import { getWorkspaceRootFromContext } from '@neoxlabs/kernel/tools/workspaceContext.js';
import { editXlsxBuffer, type CellEdit, type CellChange } from './sheetOoxml.js';
import { SHEET_SAFETY_LIMITS } from './sheetSafety.js';

const MAX_CELLS_PER_CALL = 500;

let xlsxModule: any = null;
async function getXlsx(): Promise<any> {
  if (!xlsxModule) xlsxModule = await import('xlsx').then((m: any) => m.default ?? m);
  return xlsxModule;
}

/**
 * 在盘上的 .xlsx 里原地改一批格: 生成 → 回读校验 → 原子替换。校验不过就抛, 原文件一个字节不动。
 * agent 工具 (sheet_set_cells) 和右栏表格的保存 (surface:patch-xlsx) 共用这一条路。
 */
export async function patchXlsxFile(
  abs: string,
  sheetName: string | undefined,
  edits: CellEdit[],
  opts: { overwriteFormulas?: boolean; savePath?: string } = {},
): Promise<{ sheet: string; changes: CellChange[]; skipped: Array<{ cell: string; reason: string }>; written: boolean; target: string }> {
  const { out, sheet, result } = await editXlsxBuffer(fs.readFileSync(abs), sheetName, edits, {
    overwriteFormulas: opts.overwriteFormulas === true,
  });
  const target = opts.savePath ?? abs;
  if (!out) return { sheet, changes: [], skipped: result.skipped, written: false, target };

  /* sheetStubs: 刚写的公式格只有 <f> 没有缓存值 <v> (Excel 打开时算), 不开 stubs 的话 SheetJS 直接跳过这一格 */
  const XLSX = await getXlsx();
  const wb = XLSX.read(out, { type: 'buffer', cellFormula: true, sheetStubs: true });
  const ws = wb.Sheets[sheet];
  if (!ws) throw new Error('写完回读找不到这个工作表, 已放弃写盘, 原文件没动');
  for (const ch of result.changes) {
    const c = ws[ch.cell];
    let ok: boolean;
    if (ch.after.startsWith('=')) ok = !!c?.f && `=${c.f}` === ch.after;
    else if (ch.after === '') ok = !c || c.v === undefined || c.v === '';
    else if (typeof c?.v === 'boolean') ok = String(c.v).toUpperCase() === ch.after;
    else ok = c !== undefined && String(c.v) === ch.after;
    if (!ok) {
      const got = c?.f ? `=${c.f}` : String(c?.v ?? '');
      throw new Error(`写完回读 ${ch.cell} 得到「${got}」, 应为「${ch.after}」—— 已放弃写盘, 原文件没动`);
    }
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.neox-tmp-${process.pid}`);
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, target);
  return { sheet, changes: result.changes, skipped: result.skipped, written: true, target };
}

function resolvePath(p: string): string {
  const workspace = getWorkspaceRootFromContext() ?? process.env.NEOX_WORKDIR ?? process.cwd();
  return path.isAbsolute(p) ? p : path.join(workspace, p);
}

export const sheetSetCellsTool: Tool = {
  name: 'sheet_set_cells',
  description: `Edit cells **in place** in an existing .xlsx the user already has — keeps formulas, cell styles/number formats, merged cells, conditional formatting, charts, pivot tables, other sheets. Use this (not sheet_new_workbook + export) whenever the user says "改我这份表 / 把 X 改成 Y / 填进这张表".

- cells: [{ cell: "B3", value: "1280.5" }, { cell: "C3", formula: "=B3*1.1" }, { cell: "D3", value: "备注文字" }]
  · value: number-looking strings are written as numbers; set as_text:true to force text; "" clears the cell (style kept)
  · formula: with or without leading "="
- A cell that currently holds a formula is NOT overwritten by a plain value unless overwrite_formulas:true (that would delete the formula). Shared-formula masters / array formulas are always refused.
- Each changed cell keeps its original style. The workbook is flagged to recalculate on open, so dependent formulas update in Excel/WPS.
- Read first with sheet_get_range (include_formulas:true shows which cells are formulas).
- save_as: write to a new path instead of overwriting.

Returns JSON: { ok, file_path, sheet, changes:[{cell,before,after}], skipped:[{cell,reason}] }.`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  permission: { category: ToolCategory.WRITE, allowInAskMode: false },
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '.xlsx / .xlsm path (absolute or workspace-relative)' },
      sheet: { type: 'string', description: 'Sheet name; default = first sheet' },
      cells: {
        type: 'array',
        description: `Cells to set (max ${MAX_CELLS_PER_CALL})`,
        items: {
          type: 'object',
          properties: {
            cell: { type: 'string', description: 'A1 address, e.g. "B3"' },
            value: { type: 'string', description: 'New value. Numbers like "1280.5" are written as numbers. "" clears.' },
            formula: { type: 'string', description: 'Formula, e.g. "=SUM(B2:B9)". Takes precedence over value.' },
            as_text: { type: 'boolean', description: 'Write a number-looking value as text' },
          },
          required: ['cell'],
        },
      },
      overwrite_formulas: { type: 'boolean', description: 'Allow replacing a formula cell with a plain value. Default false.' },
      save_as: { type: 'string', description: 'Optional output path; default overwrites file_path' },
    },
    required: ['file_path', 'cells'],
  },
  async function(args: {
    file_path: string; sheet?: string;
    cells: Array<{ cell: string; value?: unknown; formula?: string; as_text?: boolean }>;
    overwrite_formulas?: boolean; save_as?: string;
  }): Promise<string> {
    try {
      const abs = resolvePath(args.file_path);
      if (!fs.existsSync(abs)) return JSON.stringify({ error: `文件不存在: ${abs}` });
      if (!/\.(xlsx|xlsm)$/i.test(abs)) {
        return JSON.stringify({ error: `只能原地改 .xlsx / .xlsm; ${path.extname(abs)} 请用 sheet_get_range 读 + sheet_new_workbook 另存` });
      }
      const st = fs.statSync(abs);
      if (st.size > SHEET_SAFETY_LIMITS.maxBytes * 4) return JSON.stringify({ error: `文件太大 (${st.size} bytes)` });
      if (!Array.isArray(args.cells) || args.cells.length === 0) return JSON.stringify({ error: 'cells 不能为空' });
      if (args.cells.length > MAX_CELLS_PER_CALL) return JSON.stringify({ error: `一次最多 ${MAX_CELLS_PER_CALL} 格, 分几次调` });

      const edits: CellEdit[] = args.cells.map((c) => ({
        cell: String(c.cell ?? ''),
        value: typeof c.value === 'number' || typeof c.value === 'boolean' || c.value === null ? c.value
          : c.value === undefined ? undefined : String(c.value),
        formula: typeof c.formula === 'string' ? c.formula : undefined,
        asText: c.as_text === true,
      }));

      /* 写之前回读校验 + 原子替换都在 patchXlsxFile 里: 不过关就不落盘, 用户的原表一个字节不动。 */
      const r = await patchXlsxFile(abs, args.sheet, edits, {
        overwriteFormulas: args.overwrite_formulas === true,
        savePath: args.save_as ? resolvePath(args.save_as) : undefined,
      });
      if (!r.written) {
        return JSON.stringify({ ok: false, file_path: abs, sheet: r.sheet, changes: [], skipped: r.skipped, hint: '一格都没改 —— 看 skipped 里的原因' });
      }

      return JSON.stringify({
        ok: true,
        file_path: r.target,
        sheet: r.sheet,
        changes: r.changes,
        skipped: r.skipped,
        recalc_on_open: true,
        hint: '依赖这些格的公式在 Excel/WPS 打开时重算。文件如果正开在 Excel 里, 关掉重开才看得到。',
      });
    } catch (e: any) {
      return JSON.stringify({ error: e?.message || String(e) });
    }
  },
};
