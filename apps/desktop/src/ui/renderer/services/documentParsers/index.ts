/**
 * 客户端本地文档解析 — 不调 NeoxCloud, 完全在 renderer 进程跑.
 *
 * 跟 NeoxCloud apps/control-plane/src/modules/document/parsers/ 镜像同逻辑,
 * 输出相同 { fileId, markdown, summary, metadata } 结构, 让 documentParseClient
 * 的 "云" 和 "本地" 两条路径可互换.
 *
 * 限制 (vs 云端):
 *   · PDF: 只支持含文字层的 PDF (扫描 PDF 抽不出 text — 切云端 Docmind)
 *   · 没有 OCR
 *   · 表格抽取质量比专业 Docmind 差
 *   · 但: 0 网络 / 0 NeoxCloud 调用 / 隐私 100% 本地
 *
 * 切换由 documentParseClient.getDocumentParseMode() 决定:
 *   - 'local' (默认): 走本地
 *   - 'cloud': 走 NeoxCloud
 */

import { parsePdfLocal } from './pdfParser';
import { parseWordLocal } from './wordParser';
import { parseExcelLocal } from './excelParser';
import { parsePptxLocal } from './pptxParser';

const MAX_OUTPUT_CHARS = 200 * 1024;

export interface LocalParseResult {
  fileId: string;
  markdown: string;
  summary: string;
  metadata: {
    pages?: number;
    sheets?: number;
    chars: number;
    channel: string;
    truncated: boolean;
    durationMs: number;
    cached: false;       // 本地解析每次都重算, 没缓存命中概念 (但本地缓存在 documentCacheHandlers 写)
  };
}

function extOf(filename: string): string {
  const idx = filename.lastIndexOf('.');
  if (idx < 0) return '';
  return filename.slice(idx + 1).toLowerCase();
}

/** Web Crypto API 计算 sha256 — 跟服务端 sha256Of 输出一致. */
async function sha256OfBuffer(buffer: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function parseDocumentLocally(file: File): Promise<LocalParseResult> {
  const startedAt = Date.now();
  const ext = extOf(file.name);
  const buffer = await file.arrayBuffer();
  const fileId = await sha256OfBuffer(buffer);

  let markdown = '';
  let pages: number | undefined;
  let sheets: number | undefined;
  let channel = '';

  try {
    if (ext === 'pdf') {
      const r = await parsePdfLocal(buffer);
      markdown = r.markdown;
      pages = r.pages;
      channel = 'local-pdfjs';
    } else if (ext === 'docx' || ext === 'doc') {
      const r = await parseWordLocal(buffer);
      markdown = r.markdown;
      channel = 'local-mammoth';
    } else if (ext === 'xlsx' || ext === 'xls' || ext === 'csv' || ext === 'tsv') {
      const r = await parseExcelLocal(buffer);
      markdown = r.markdown;
      sheets = r.sheets;
      channel = 'local-xlsx';
    } else if (ext === 'pptx') {
      const r = await parsePptxLocal(buffer);
      markdown = r.markdown;
      pages = r.pages;
      channel = 'local-pptx';
    } else if (ext === 'txt' || ext === 'md') {
      markdown = new TextDecoder('utf-8').decode(buffer);
      channel = 'local-plain';
    } else {
      throw new Error(`Local parser doesn't support .${ext} — switch to cloud mode or use a supported format`);
    }
  } catch (err: any) {
    throw new Error(`Local parse failed (${channel || ext}): ${err?.message || String(err)}`);
  }

  /* 截断逻辑跟服务端 document.ts 同 */
  const truncated = markdown.length > MAX_OUTPUT_CHARS;
  if (truncated) {
    markdown = markdown.slice(0, MAX_OUTPUT_CHARS) +
      `\n\n_..文档过长, 已截断前 ${MAX_OUTPUT_CHARS} 字符 (原始 ${markdown.length} 字符)_`;
  }

  return {
    fileId,
    markdown,
    summary: markdown.slice(0, 200),
    metadata: {
      pages,
      sheets,
      chars: markdown.length,
      channel,
      truncated,
      durationMs: Date.now() - startedAt,
      cached: false,
    },
  };
}

export function isLocallyParseable(file: File): boolean {
  const ext = extOf(file.name);
  return ['pdf', 'docx', 'doc', 'xlsx', 'xls', 'csv', 'tsv', 'pptx', 'txt', 'md'].includes(ext);
}
