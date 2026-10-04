
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { ToolCategory } from '@neoxlabs/kernel/types/permissions.js';
import { getWorkspaceRootFromContext } from '@neoxlabs/kernel/tools/workspaceContext.js';

type ExportFormat = 'markdown' | 'html' | 'txt';

let mammothMod: any = null;
async function getMammoth(): Promise<any> {
  if (!mammothMod) {
    mammothMod = await import('mammoth').then((m: any) => m.default ?? m);
  }
  return mammothMod;
}

export const wordExportTool: Tool = {
  name: 'word_export',
  description: `Convert a .docx to another format and save to disk.

format options:
- 'markdown': mammoth → semantic markdown (LLM-friendly, git diff-able)
- 'html': mammoth → styled HTML
- 'txt': raw extracted text (no formatting)

If save_path omitted, derived from source path (e.g. report.docx → report.md / .html / .txt) in same directory.
overwrite defaults false; set true to clobber existing file.

For **PDF export**: this tool can't do PDF (needs Chromium printToPDF — only via UI ExportMenuButton).
Tell the user "右栏右上角 '导出 ▼ → 导出 PDF'" if they need PDF.

Returns JSON: { ok, file_path, size, format, source }.`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'safe',
  isReadOnly: false,
  permission: { category: ToolCategory.WRITE, allowInAskMode: false },
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'source .docx path' },
      format: { type: 'string', enum: ['markdown', 'html', 'txt'], description: 'output format' },
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

      const extMap = { markdown: '.md', html: '.html', txt: '.txt' } as const;
      const targetExt = extMap[args.format];
      if (!targetExt) return JSON.stringify({ error: `format 必须是 markdown / html / txt, 收到: ${args.format}` });

      let savePath = args.save_path;
      if (!savePath) {
        /* derive: report.docx → report.md (同目录) */
        const base = srcAbs.replace(/\.docx?$/i, '');
        savePath = base + targetExt;
      } else if (!path.isAbsolute(savePath)) {
        savePath = path.join(workspace, savePath);
      }

      if (fs.existsSync(savePath) && !args.overwrite) {
        return JSON.stringify({
          error: `文件已存在: ${savePath}. 设 overwrite=true 覆盖, 或换 save_path.`,
        });
      }

      const buffer = fs.readFileSync(srcAbs);
      const mammoth = await getMammoth();
      let content = '';
      if (args.format === 'markdown') {
        const r = await mammoth.convertToMarkdown({ buffer });
        content = r.value ?? '';
      } else if (args.format === 'html') {
        const r = await mammoth.convertToHtml({ buffer });
        /* 包一层 HTML 让浏览器/邮件客户端正确显示 */
        content = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${path.basename(srcAbs)}</title>
<style>body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;line-height:1.7;max-width:760px;margin:24px auto;padding:0 16px;color:#1a1a1a;}</style>
</head><body>${r.value ?? ''}</body></html>`;
      } else {
        const r = await mammoth.extractRawText({ buffer });
        content = r.value ?? '';
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
      });
    } catch (e: any) {
      return JSON.stringify({ error: e?.message || String(e) });
    }
  },
};
