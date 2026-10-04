/**
 * sheet_export — agent 端 .xlsx/.csv/.tsv 转其他格式 (csv/json/markdown/html) 并写盘.
 *   跟 word_export 同范式. PDF 不在这里 (走 UI ExportMenuButton).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { ToolCategory } from '@neoxlabs/kernel/types/permissions.js';
import { getWorkspaceRootFromContext } from '@neoxlabs/kernel/tools/workspaceContext.js';
import {
  SAFE_XLSX_FILE_READ_OPTIONS,
  assertSheetFileSafe,
  escapeHtml,
  escapeMarkdownCell,
  rowsToSafeObjects,
  safeSheetNames,
  safeSheetTitle,
  sheetCsv,
  sheetHtml,
  sheetRows,
} from './sheetSafety.js';

type ExportFormat = 'csv' | 'json' | 'markdown' | 'html';

let xlsxMod: any = null;
async function getXlsx(): Promise<any> {
  if (!xlsxMod) {
    xlsxMod = await import('xlsx').then((m: any) => m.default ?? m);
  }
  return xlsxMod;
}

/** 工作表 → markdown table 字符串 */
function sheetToMarkdownTable(XLSX: any, ws: any, name: string): string {
  const rows = sheetRows(XLSX, ws);
  if (rows.length === 0) return `## ${safeSheetTitle(name)}\n\n_(empty)_\n`;
  const colCount = Math.max(...rows.map(r => r?.length ?? 0));
  const out: string[] = [`## ${safeSheetTitle(name)}\n`];
  const header = rows[0] ?? [];
  const headerCells = Array.from({ length: colCount }, (_, i) =>
    escapeMarkdownCell(header[i]));
  out.push('| ' + headerCells.join(' | ') + ' |');
  out.push('| ' + headerCells.map(() => '---').join(' | ') + ' |');
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const cells = Array.from({ length: colCount }, (_, i) =>
      escapeMarkdownCell(row[i]));
    out.push('| ' + cells.join(' | ') + ' |');
  }
  out.push('');
  return out.join('\n');
}

export const sheetExportTool: Tool = {
  name: 'sheet_export',
  description: `Convert .xlsx/.csv/.tsv to another format and save to disk.

format options:
- 'csv': first sheet only, comma-separated
- 'json': all sheets → { sheetName: [rows], ... } JSON
- 'markdown': all sheets as ## Name + table blocks (LLM-friendly)
- 'html': all sheets as <h2>+<table>, styled wrapper for browser/email

If save_path omitted, derived from source path (e.g. data.xlsx → data.csv / .json / .md / .html) in same directory.
overwrite defaults false; set true to clobber existing file.

For **PDF export**: this tool can't do PDF (needs Chromium printToPDF — only via UI ExportMenuButton).
Tell the user "右栏右上角 '导出 ▼ → 导出 PDF'" if they need PDF.

Returns JSON: { ok, file_path, size, format, source, sheets_count }.`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'safe',
  isReadOnly: false,
  permission: { category: ToolCategory.WRITE, allowInAskMode: false },
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'source .xlsx/.csv/.tsv path' },
      format: { type: 'string', enum: ['csv', 'json', 'markdown', 'html'], description: 'output format' },
      save_path: { type: 'string', description: 'optional save path; default derive from source' },
      overwrite: { type: 'boolean', description: 'allow clobbering existing file. default false' },
    },
    required: ['file_path', 'format'],
  },
  async function(args: { file_path: string; format: ExportFormat; save_path?: string; overwrite?: boolean }): Promise<string> {
    try {
      const workspace = getWorkspaceRootFromContext() ?? process.env.NEOX_WORKDIR ?? process.cwd();
      const srcAbs = path.isAbsolute(args.file_path) ? args.file_path : path.join(workspace, args.file_path);
      if (!fs.existsSync(srcAbs)) return JSON.stringify({ error: `源文件不存在: ${srcAbs}` });
      assertSheetFileSafe(srcAbs);

      const extMap = { csv: '.csv', json: '.json', markdown: '.md', html: '.html' } as const;
      const targetExt = extMap[args.format];
      if (!targetExt) return JSON.stringify({ error: `format 必须是 csv / json / markdown / html, 收到: ${args.format}` });

      let savePath = args.save_path;
      if (!savePath) {
        const base = srcAbs.replace(/\.(xlsx?|csv|tsv)$/i, '');
        savePath = base + targetExt;
      } else if (!path.isAbsolute(savePath)) {
        savePath = path.join(workspace, savePath);
      }

      if (fs.existsSync(savePath) && !args.overwrite) {
        return JSON.stringify({
          error: `文件已存在: ${savePath}. 设 overwrite=true 覆盖, 或换 save_path.`,
        });
      }

      const XLSX = await getXlsx();
      const wb = XLSX.readFile(srcAbs, SAFE_XLSX_FILE_READ_OPTIONS);
      const sheetNames = safeSheetNames(wb);

      let content = '';
      if (args.format === 'csv') {
        if (sheetNames.length === 0) return JSON.stringify({ error: 'workbook 无 sheet' });
        content = sheetCsv(XLSX, wb.Sheets[sheetNames[0]]);
      } else if (args.format === 'json') {
        const out: Record<string, Array<Record<string, unknown>>> = Object.create(null);
        for (const n of sheetNames) {
          out[safeSheetTitle(n)] = rowsToSafeObjects(sheetRows(XLSX, wb.Sheets[n], { raw: true }));
        }
        content = JSON.stringify(out, null, 2);
      } else if (args.format === 'markdown') {
        const blocks: string[] = [];
        for (const n of sheetNames) {
          blocks.push(sheetToMarkdownTable(XLSX, wb.Sheets[n], n));
        }
        content = blocks.join('\n');
      } else {
        /* html */
        const sections: string[] = [];
        for (const n of sheetNames) {
          const table = sheetHtml(XLSX, wb.Sheets[n]);
          sections.push(`<h2>${escapeHtml(safeSheetTitle(n))}</h2>${table}`);
        }
        content = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(path.basename(srcAbs))}</title>
<style>body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:24px auto;max-width:1100px;padding:0 16px;color:#1a1a1a;}
h2{font-size:20px;margin:1.4em 0 .4em;}
table{width:100%;border-collapse:collapse;margin:.6em 0;font-size:13px;}
th,td{border:1px solid #d4d4d8;padding:6px 10px;text-align:left;vertical-align:top;}
th{background:#f4f4f5;font-weight:600;}</style>
</head><body>${sections.join('\n')}</body></html>`;
      }

      /* 父目录自动建 */
      const parent = path.dirname(savePath);
      if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });

      fs.writeFileSync(savePath, content, 'utf-8');
      const stats = fs.statSync(savePath);
      return JSON.stringify({
        ok: true,
        file_path: savePath,
        size: stats.size,
        format: args.format,
        source: srcAbs,
        sheets_count: Array.isArray(wb.SheetNames) ? wb.SheetNames.length : sheetNames.length,
      });
    } catch (e: any) {
      return JSON.stringify({ error: e?.message || String(e) });
    }
  },
};
