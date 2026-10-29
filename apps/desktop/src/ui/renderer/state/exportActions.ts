/**
 * exportActions — 文档 surface 导出 helpers.
 *
 *   架构: 任意 → HTML → printToPDF (PDF) / 直接序列化 (md/txt/csv/json/html).
 *   零外部依赖 (Electron 自带 Chromium 给 PDF 渲染), 跨平台.
 *
 *   每个 helper 流程一致:
 *     1. 读源文件 (走 surfaceReadFile base64 或 utf-8)
 *     2. 解析 → 中间表示 (mammoth/SheetJS/pdfjs 各自的输出)
 *     3. 转目标格式
 *     4. saveFileDialog 选保存位置
 *     5. surfaceWriteFile 写盘 (或 exportHtmlToPdf 走 main printToPDF)
 *
 *   错误用 console.error + 简短返回, UI 弹 toast 由调用方决定 (ExportMenuButton).
 */

import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  EXCEL_SAFETY_LIMITS,
  SAFE_XLSX_READ_OPTIONS,
  assertExcelBufferSafe,
  escapeHtml,
  escapeMarkdownCell,
  rowsToSafeObjects,
  safeSheetNames,
  safeSheetTitle,
  sheetCsv,
  sheetHtml,
  sheetRows,
} from '../services/documentParsers/xlsxSafety';

/* ─────────────────────── 通用 helper ─────────────────────── */

interface ExportResult {
  ok: boolean;
  file_path?: string;
  size?: number;
  error?: string;
}

/** 读 file 为 base64 ArrayBuffer */
async function readAsArrayBuffer(filePath: string): Promise<ArrayBuffer> {
  const api = (window as any).neox;
  const reader = api?.surfaceReadFile;
  if (!reader) throw new Error('surfaceReadFile 不可用');
  const result = await reader(filePath, { encoding: 'base64' });
  if (result?.success === false) throw new Error(result.error || 'read failed');
  const base64 = typeof result === 'string' ? result : (result?.content ?? '');
  if (!base64) throw new Error('文件为空');
  const bin = atob(base64);
  const buf = new ArrayBuffer(bin.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
  return buf;
}

/** saveFileDialog wrapper, 返用户选的路径或 null */
async function pickSavePath(opts: {
  defaultName: string;
  defaultDir?: string;
  filter: { name: string; extensions: string[] };
}): Promise<string | null> {
  const api = (window as any).neox;
  const fn = api?.saveFileDialog;
  if (!fn) return null;
  const defaultPath = opts.defaultDir
    ? `${opts.defaultDir.replace(/\/$/, '')}/${opts.defaultName}`
    : opts.defaultName;
  const picked = await fn({
    title: `导出 ${opts.filter.name}`,
    defaultPath,
    filters: [opts.filter, { name: 'All Files', extensions: ['*'] }],
  });
  return picked || null;
}

/** 写文本文件 (utf-8) */
async function writeTextFile(savePath: string, content: string): Promise<ExportResult> {
  const api = (window as any).neox;
  const fn = api?.surfaceWriteFile;
  if (!fn) return { ok: false, error: 'surfaceWriteFile 不可用' };
  const result = await fn(savePath, content, { encoding: 'utf-8' });
  if (result?.success === false) return { ok: false, error: result.error };
  return { ok: true, file_path: savePath, size: result?.size };
}

/** 写二进制文件 (base64 内容) — 5.12 XLSX 导出用. surfaceWriteFile 接受 encoding=base64. */
async function writeBase64File(savePath: string, base64: string): Promise<ExportResult> {
  const api = (window as any).neox;
  const fn = api?.surfaceWriteFile;
  if (!fn) return { ok: false, error: 'surfaceWriteFile 不可用' };
  const result = await fn(savePath, base64, { encoding: 'base64' });
  if (result?.success === false) return { ok: false, error: result.error };
  return { ok: true, file_path: savePath, size: result?.size };
}

/** HTML → PDF (走 main printToPDF). preload 签名: (html, savePath, options?). */
async function writeHtmlAsPdf(savePath: string, html: string): Promise<ExportResult> {
  const api = (window as any).neox;
  const fn = api?.exportHtmlToPdf;
  if (!fn) return { ok: false, error: 'exportHtmlToPdf bridge 不可用' };
  const result = await fn(html, savePath);
  if (result?.success === false) return { ok: false, error: result.error };
  return { ok: true, file_path: savePath, size: result?.size };
}

/** 装一段 print-safe CSS 给所有 HTML 导出用 — 中文字体 + 合理排版 */
function wrapForPrint(bodyHtml: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  @page { margin: 1.2cm; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei",
                 "Hiragino Sans GB", "Source Han Sans SC", sans-serif;
    font-size: 14px;
    line-height: 1.7;
    color: #1a1a1a;
    margin: 0;
    padding: 0;
  }
  h1, h2, h3, h4, h5, h6 { font-weight: 600; margin: 1.2em 0 0.5em; line-height: 1.3; }
  h1 { font-size: 24px; }
  h2 { font-size: 20px; }
  h3 { font-size: 17px; }
  p { margin: 0.6em 0; }
  ul, ol { padding-left: 1.6em; margin: 0.6em 0; }
  a { color: #6366f1; text-decoration: underline; }
  table { width: 100%; border-collapse: collapse; margin: 1em 0; font-size: 13px; }
  th, td { border: 1px solid #d4d4d8; padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: #f4f4f5; font-weight: 600; }
  img { max-width: 100%; height: auto; }
  blockquote {
    border-left: 3px solid #6366f1;
    padding: 4px 0 4px 12px;
    margin: 1em 0;
    color: #525252;
  }
  code { font-family: "JetBrains Mono", monospace; font-size: 0.9em;
         background: #f4f4f5; padding: 1px 5px; border-radius: 3px; }
  pre { background: #f4f4f5; padding: 12px; border-radius: 6px; overflow-x: auto; }
</style>
</head>
<body>${bodyHtml}</body>
</html>`;
}

/* ═══════════════════════ DOCX 导出 ═══════════════════════ */

let mammothMod: any = null;
async function loadMammoth() {
  if (!mammothMod) {
    // @ts-ignore — mammoth.browser.js 无类型声明
    mammothMod = await import('mammoth/mammoth.browser.js').then((m: any) => m.default ?? m);
  }
  return mammothMod;
}

export async function exportDocxToHtml(srcPath: string, workspacePath?: string): Promise<ExportResult> {
  try {
    const fileName = srcPath.split(/[/\\]/).pop()?.replace(/\.docx?$/i, '') ?? 'untitled';
    const savePath = await pickSavePath({
      defaultName: `${fileName}.html`,
      defaultDir: workspacePath,
      filter: { name: 'HTML', extensions: ['html'] },
    });
    if (!savePath) return { ok: false, error: 'cancelled' };
    const arrayBuffer = await readAsArrayBuffer(srcPath);
    const mammoth = await loadMammoth();
    const r = await mammoth.convertToHtml({ arrayBuffer });
    const wrapped = wrapForPrint(r.value ?? '', fileName);
    return await writeTextFile(savePath, wrapped);
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export async function exportDocxToMarkdown(srcPath: string, workspacePath?: string): Promise<ExportResult> {
  try {
    const fileName = srcPath.split(/[/\\]/).pop()?.replace(/\.docx?$/i, '') ?? 'untitled';
    const savePath = await pickSavePath({
      defaultName: `${fileName}.md`,
      defaultDir: workspacePath,
      filter: { name: 'Markdown', extensions: ['md'] },
    });
    if (!savePath) return { ok: false, error: 'cancelled' };
    const arrayBuffer = await readAsArrayBuffer(srcPath);
    const mammoth = await loadMammoth();
    const r = await mammoth.convertToMarkdown({ arrayBuffer });
    return await writeTextFile(savePath, r.value ?? '');
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export async function exportDocxToTxt(srcPath: string, workspacePath?: string): Promise<ExportResult> {
  try {
    const fileName = srcPath.split(/[/\\]/).pop()?.replace(/\.docx?$/i, '') ?? 'untitled';
    const savePath = await pickSavePath({
      defaultName: `${fileName}.txt`,
      defaultDir: workspacePath,
      filter: { name: 'Plain Text', extensions: ['txt'] },
    });
    if (!savePath) return { ok: false, error: 'cancelled' };
    const arrayBuffer = await readAsArrayBuffer(srcPath);
    const mammoth = await loadMammoth();
    const r = await mammoth.extractRawText({ arrayBuffer });
    return await writeTextFile(savePath, r.value ?? '');
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export async function exportDocxToPdf(srcPath: string, workspacePath?: string): Promise<ExportResult> {
  try {
    const fileName = srcPath.split(/[/\\]/).pop()?.replace(/\.docx?$/i, '') ?? 'untitled';
    const savePath = await pickSavePath({
      defaultName: `${fileName}.pdf`,
      defaultDir: workspacePath,
      filter: { name: 'PDF', extensions: ['pdf'] },
    });
    if (!savePath) return { ok: false, error: 'cancelled' };
    const arrayBuffer = await readAsArrayBuffer(srcPath);
    const mammoth = await loadMammoth();
    const r = await mammoth.convertToHtml({ arrayBuffer });
    const wrapped = wrapForPrint(r.value ?? '', fileName);
    return await writeHtmlAsPdf(savePath, wrapped);
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/* ═══════════════════════ XLSX/CSV 导出 ═══════════════════════ */

let xlsxMod: any = null;
async function loadXlsx() {
  if (!xlsxMod) {
    xlsxMod = await import('xlsx').then((m: any) => m.default ?? m);
  }
  return xlsxMod;
}

/** SheetJS workbook → 二维数组 (取 active sheet) */
async function loadXlsxWorkbook(srcPath: string) {
  const arrayBuffer = await readAsArrayBuffer(srcPath);
  assertExcelBufferSafe(arrayBuffer, 'Sheet export input');
  const XLSX = await loadXlsx();
  return { XLSX, wb: XLSX.read(arrayBuffer, SAFE_XLSX_READ_OPTIONS) };
}

export async function exportSheetToXlsx(srcPath: string, workspacePath?: string): Promise<ExportResult> {
  try {
    const fileName = srcPath.split(/[/\\]/).pop()?.replace(/\.(xlsx?|csv|tsv)$/i, '') ?? 'untitled';
    const savePath = await pickSavePath({
      defaultName: `${fileName}.xlsx`,
      defaultDir: workspacePath,
      filter: { name: 'Excel', extensions: ['xlsx'] },
    });
    if (!savePath) return { ok: false, error: 'cancelled' };
    if (/\.xls[xm]$/i.test(srcPath)) {
      const bytes = new Uint8Array(await readAsArrayBuffer(srcPath));
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return await writeBase64File(savePath, btoa(bin));
    }
    const { XLSX, wb } = await loadXlsxWorkbook(srcPath);
    const base64: string = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
    return await writeBase64File(savePath, base64);
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export async function exportSheetToCsv(srcPath: string, workspacePath?: string): Promise<ExportResult> {
  try {
    const fileName = srcPath.split(/[/\\]/).pop()?.replace(/\.(xlsx?|csv|tsv)$/i, '') ?? 'untitled';
    const savePath = await pickSavePath({
      defaultName: `${fileName}.csv`,
      defaultDir: workspacePath,
      filter: { name: 'CSV', extensions: ['csv'] },
    });
    if (!savePath) return { ok: false, error: 'cancelled' };
    const { XLSX, wb } = await loadXlsxWorkbook(srcPath);
    const firstName = safeSheetNames(wb, 1)[0];
    if (!firstName) return { ok: false, error: 'workbook has no sheets' };
    const firstSheet = wb.Sheets[firstName];
    const csv = sheetCsv(XLSX, firstSheet);
    return await writeTextFile(savePath, csv);
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export async function exportSheetToJson(srcPath: string, workspacePath?: string): Promise<ExportResult> {
  try {
    const fileName = srcPath.split(/[/\\]/).pop()?.replace(/\.(xlsx?|csv|tsv)$/i, '') ?? 'untitled';
    const savePath = await pickSavePath({
      defaultName: `${fileName}.json`,
      defaultDir: workspacePath,
      filter: { name: 'JSON', extensions: ['json'] },
    });
    if (!savePath) return { ok: false, error: 'cancelled' };
    const { XLSX, wb } = await loadXlsxWorkbook(srcPath);
    /* 多 sheet → { sheetName: [rows] } */
    const out: Record<string, Array<Record<string, unknown>>> = Object.create(null);
    for (const name of safeSheetNames(wb)) {
      const rows = sheetRows(XLSX, wb.Sheets[name], {
        maxRows: EXCEL_SAFETY_LIMITS.maxPreviewRows,
        maxColumns: EXCEL_SAFETY_LIMITS.maxColumns,
        raw: true,
      });
      out[safeSheetTitle(name)] = rowsToSafeObjects(rows);
    }
    return await writeTextFile(savePath, JSON.stringify(out, null, 2));
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export async function exportSheetToHtml(srcPath: string, workspacePath?: string): Promise<ExportResult> {
  try {
    const fileName = srcPath.split(/[/\\]/).pop()?.replace(/\.(xlsx?|csv|tsv)$/i, '') ?? 'untitled';
    const savePath = await pickSavePath({
      defaultName: `${fileName}.html`,
      defaultDir: workspacePath,
      filter: { name: 'HTML', extensions: ['html'] },
    });
    if (!savePath) return { ok: false, error: 'cancelled' };
    const { XLSX, wb } = await loadXlsxWorkbook(srcPath);
    /* 多 sheet 各转一个 table, 拼合 */
    const sections: string[] = [];
    for (const name of safeSheetNames(wb)) {
      const table = sheetHtml(XLSX, wb.Sheets[name]);
      sections.push(`<h2>${escapeHtml(safeSheetTitle(name))}</h2>${table}`);
    }
    return await writeTextFile(savePath, wrapForPrint(sections.join('\n'), fileName));
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export async function exportSheetToMarkdown(srcPath: string, workspacePath?: string): Promise<ExportResult> {
  try {
    const fileName = srcPath.split(/[/\\]/).pop()?.replace(/\.(xlsx?|csv|tsv)$/i, '') ?? 'untitled';
    const savePath = await pickSavePath({
      defaultName: `${fileName}.md`,
      defaultDir: workspacePath,
      filter: { name: 'Markdown', extensions: ['md'] },
    });
    if (!savePath) return { ok: false, error: 'cancelled' };
    const { XLSX, wb } = await loadXlsxWorkbook(srcPath);
    const blocks: string[] = [];
    for (const name of safeSheetNames(wb)) {
      blocks.push(`## ${safeSheetTitle(name)}\n`);
      const rows = sheetRows(XLSX, wb.Sheets[name], {
        maxRows: EXCEL_SAFETY_LIMITS.maxMarkdownRows,
        maxColumns: EXCEL_SAFETY_LIMITS.maxColumns,
      });
      if (rows.length === 0) { blocks.push('_(empty)_\n'); continue; }
      const colCount = Math.max(...rows.map(r => r.length));
      const header = rows[0] ?? [];
      const headerCells = Array.from({ length: colCount }, (_, i) =>
        escapeMarkdownCell(header[i]));
      blocks.push('| ' + headerCells.join(' | ') + ' |');
      blocks.push('| ' + headerCells.map(() => '---').join(' | ') + ' |');
      for (let r = 1; r < rows.length; r++) {
        const row = rows[r] ?? [];
        const cells = Array.from({ length: colCount }, (_, i) =>
          escapeMarkdownCell(row[i]));
        blocks.push('| ' + cells.join(' | ') + ' |');
      }
      blocks.push('');
    }
    return await writeTextFile(savePath, blocks.join('\n'));
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export async function exportSheetToPdf(srcPath: string, workspacePath?: string): Promise<ExportResult> {
  try {
    const fileName = srcPath.split(/[/\\]/).pop()?.replace(/\.(xlsx?|csv|tsv)$/i, '') ?? 'untitled';
    const savePath = await pickSavePath({
      defaultName: `${fileName}.pdf`,
      defaultDir: workspacePath,
      filter: { name: 'PDF', extensions: ['pdf'] },
    });
    if (!savePath) return { ok: false, error: 'cancelled' };
    const { XLSX, wb } = await loadXlsxWorkbook(srcPath);
    const sections: string[] = [];
    for (const name of safeSheetNames(wb)) {
      const table = sheetHtml(XLSX, wb.Sheets[name]);
      sections.push(`<h2>${escapeHtml(safeSheetTitle(name))}</h2>${table}`);
    }
    const wrapped = wrapForPrint(sections.join('\n'), fileName);
    return await writeHtmlAsPdf(savePath, wrapped);
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/* ═══════════════════════ PDF 导出 ═══════════════════════ */

/* pdfjs-dist 懒加载 — 静态 import 会把 ~1MB 的 pdfjs 拉进首屏 main chunk (exportActions
 * 被 SurfacePanel 静态引用)。`?url` 静态导入只是资源 URL 字符串, 保留;
 * worker 注意事项见 PdfSurfaceViewer.tsx。 */
let pdfjsPromise: Promise<any> | null = null;
function loadPdfjs(): Promise<any> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const mod: any = await import('pdfjs-dist');
      mod.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      return mod;
    })();
  }
  return pdfjsPromise;
}

/** PDF → 纯文本数组 (每页一段) */
async function pdfToTextPages(srcPath: string): Promise<string[]> {
  const pdfjs = await loadPdfjs();
  const arrayBuffer = await readAsArrayBuffer(srcPath);
  const data = new Uint8Array(arrayBuffer);
  const doc = await (pdfjs as any).getDocument({ data }).promise;
  const pages: string[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      /* items 按 y 大致排序; 简单按 transform[5] 分行 */
      let lastY: number | null = null;
      const parts: string[] = [];
      for (const it of content.items as any[]) {
        const str = it.str ?? '';
        const y = Array.isArray(it.transform) ? it.transform[5] : null;
        if (lastY != null && y != null && Math.abs(y - lastY) > 2) parts.push('\n');
        parts.push(str);
        if (y != null) lastY = y;
      }
      pages.push(parts.join(''));
      page.cleanup();
    }
  } finally {
    try { await doc.destroy(); } catch { /* ignore */ }
  }
  return pages;
}

export async function exportPdfToMarkdown(srcPath: string, workspacePath?: string): Promise<ExportResult> {
  try {
    const fileName = srcPath.split(/[/\\]/).pop()?.replace(/\.pdf$/i, '') ?? 'untitled';
    const savePath = await pickSavePath({
      defaultName: `${fileName}.md`,
      defaultDir: workspacePath,
      filter: { name: 'Markdown', extensions: ['md'] },
    });
    if (!savePath) return { ok: false, error: 'cancelled' };
    const pages = await pdfToTextPages(srcPath);
    const md = pages.map((p, i) => `## Page ${i + 1}\n\n${p.trim()}`).join('\n\n');
    return await writeTextFile(savePath, md);
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}
