
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { ToolCategory } from '@neoxlabs/kernel/types/permissions.js';
import { createContextualResult, createSummarizedResult } from '@neoxlabs/kernel/core/types/toolResult.js';
import { getWorkspaceRootFromContext } from '@neoxlabs/kernel/tools/workspaceContext.js';
import { getPdfExporter } from '../export/pdfExporterRegistry.js';
import { wrapForPrint } from '../export/printHtml.js';

let mammothMod: any = null;
async function getMammoth(): Promise<any> {
  if (!mammothMod) mammothMod = await import('mammoth').then((m: any) => m.default ?? m);
  return mammothMod;
}

function resolveSavePath(raw: string | undefined, sourceAbs: string, workspace: string): { path?: string; error?: string } {
  const target = raw?.trim()
    ? (path.isAbsolute(raw) ? raw : path.join(workspace, raw))
    : sourceAbs.replace(/\.docx$/i, '.pdf');
  const withExt = /\.pdf$/i.test(target) ? target : `${target}.pdf`;
  const rel = path.relative(workspace, withExt);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { error: `只能导出到工作区内: ${withExt} 在 ${workspace} 之外` };
  }
  return { path: withExt };
}

export const wordToPdfTool: Tool = {
  name: 'word_to_pdf',
  /* 打印要起一个隐藏窗口渲染, 大文档慢; 30s 是 worker 反向 RPC 的硬超时, 这里留足余量 */
  timeoutMs: 120_000,
  description: `Export a .docx to PDF.

Runs the document through Chromium's printToPDF on the host, so images and hyperlinks survive into the PDF.
Only available when the desktop app is running (the CLI has no Chromium) — it will tell you so instead of failing silently.

save_path defaults to the source path with .pdf, and must stay inside the workspace.

Returns JSON: { ok, file_path, size, source }.`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'safe',
  isReadOnly: false,
  permission: { category: ToolCategory.WRITE, allowInAskMode: false },
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'source .docx path, absolute or workspace-relative' },
      save_path: { type: 'string', description: 'optional target .pdf path (workspace-relative or absolute inside workspace)' },
      landscape: { type: 'boolean', description: 'landscape orientation. default false' },
      overwrite: { type: 'boolean', description: 'allow clobbering existing file. default false' },
    },
    required: ['file_path'],
  },
  async function(args: { file_path: string; save_path?: string; landscape?: boolean; overwrite?: boolean }): Promise<string> {
    const fail = (msg: string, precondition = false) => JSON.stringify(
      createSummarizedResult('word_to_pdf', 'error', precondition ? 'PDF 导出不可用' : 'PDF 导出失败',
        { error: msg, ...(precondition ? { precondition: true } : {}) }),
    );

    const exporter = getPdfExporter();
    if (!exporter) {
      return fail(
        '当前宿主没有 PDF 能力 (需要桌面应用的 Chromium)。'
        + '在 CLI 里请改用 word_export 导成 markdown/html; 或者让用户在桌面端右栏点「导出 ▼ → 导出 PDF」。',
        true,
      );
    }

    try {
      const workspace = getWorkspaceRootFromContext() ?? process.env.NEOX_WORKDIR ?? process.cwd();
      const srcAbs = path.isAbsolute(args.file_path) ? args.file_path : path.join(workspace, args.file_path);
      if (!fs.existsSync(srcAbs)) return fail(`找不到源文件: ${srcAbs}`);
      if (!/\.docx$/i.test(srcAbs)) return fail(`只支持 .docx: ${srcAbs}`);

      const resolved = resolveSavePath(args.save_path, srcAbs, workspace);
      if (resolved.error) return fail(resolved.error);
      const outPath = resolved.path!;
      if (fs.existsSync(outPath) && !args.overwrite) {
        return fail(`文件已存在: ${outPath}. 设 overwrite=true 覆盖, 或换 save_path.`);
      }

      const mammoth = await getMammoth();
      const { value: bodyHtml } = await mammoth.convertToHtml({ path: srcAbs });
      const html = wrapForPrint({ title: path.basename(srcAbs, '.docx'), bodyHtml });

      const r = await exporter({ html, savePath: outPath, landscape: args.landscape });
      if (!r.success) return fail(r.error || 'printToPDF 失败');

      return JSON.stringify(createContextualResult(
        'word_to_pdf', 'success',
        `已导出 ${path.basename(outPath)} (${Math.round((r.size ?? 0) / 1024)} KB)`,
        `源文件: ${srcAbs}\nPDF: ${outPath}\n大小: ${r.size} 字节`,
        { metadata: { ok: true, file_path: outPath, size: r.size, source: srcAbs } },
      ));
    } catch (e: any) {
      return fail(e?.message || String(e));
    }
  },
};
