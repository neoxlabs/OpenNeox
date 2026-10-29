/**
 * read_document(fileId) — 按 file_id 读用户上传文档的解析后 markdown.
 *
 * 配合 Composer 拖拽/粘贴/选文件上传文档 (PDF/Word/Excel/PPT 等) 流程:
 *   1. 客户端解析后 (NeoxCloud 或本地 parser), 拿到 fileId (sha256) + markdown
 *   2. markdown 写本地缓存 ~/.neox/documents/<fileId>.md
 *   3. attachment.fileId 带进 user message metadata
 *   4. prepareTaskInput 在 prompt 拼: "[已上传文档 file_id=xyz, N 字符] 用 read_document 工具读"
 *   5. agent 看到 → 调本工具拿 markdown → 看内容
 *
 * 设计哲学:
 *   · 不把全文塞 user message — 多轮对话不重发, 省 token 99%+
 *   · agent 自主决定要不要读 (问 "几页?" 时甚至不用 read)
 *   · 本地缓存 fs 读毫秒级, 不走网络
 *   · cache miss (用户清缓存) — 直接报错让用户重新上传; 不 fallback NeoxCloud
 *     (后续 v3 可加 fallback, 当前 v2 简化)
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { estimateTokens } from '@neoxlabs/kernel';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';
import { LONG_DOC_FIRST_READ_TOKEN_BUDGET, LONG_DOC_OUTLINE_TRIGGER_TOKENS, buildCharDocOutline, parseDocAnchor } from './smart-read/longDoc.js';

const CACHE_DIR = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'documents');

interface ReadDocumentArgs {
  /** sha256 hex (64 chars) — 由 user message metadata 的 attachment.fileId 给到 */
  file_id: string;
  /** 从第几个字符开始读 (分页), 缺省 0 */
  offset?: number;
  /** 长文档大纲里的锚点, 如 "#c12000-20000" (与 offset 等价) */
  anchor?: string;
}

const PAGE_CHARS = 8000;

function isValidFileId(s: unknown): s is string {
  return typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
}

export const readDocumentTool: Tool = {
  name: 'read_document',
  aliases: ['ReadDocument', 'read_attachment', 'fetch_document'],
  /* 来源分级 (kernel/core/trust): 拖进来的 PDF / Word 是最常见的注入载体 —— 用户上传 ≠ 用户写的 */
  provenance: 'external',
  provenanceRef: (args) => (typeof args?.file_id === 'string' ? `document ${String(args.file_id).slice(0, 8)}` : undefined),
  description: `Read the parsed markdown content of a document the user uploaded (PDF / Word / Excel / PPT / CSV / TSV).

When the user attaches a document via drag-drop / paste / file picker in Composer, the parsed content lives in a local cache identified by file_id (sha256). The user message metadata will list attached docs as "[已上传文档: filename.pdf (file_id=xyz, N chars)]". Call this tool with that file_id to read the actual markdown.

Use when:
- User explicitly references the document ("总结这个 PDF" / "Excel 第 3 行是啥")
- You need the document content to answer

Don't call when:
- User question is unrelated to the doc (just metadata "几页?" can be answered from prompt directly)
- You already read it this turn (cache result mentally, don't repeat)

Long documents come back one page (${PAGE_CHARS} chars) at a time: if \`next_offset\` is present, call again with \`offset: next_offset\` to read the next page. Keep going until there is no \`next_offset\` when you need the whole text (translation, full summary).

Long documents also include an \`outline\` on the first read (one line per section with an anchor like \`#c12000-20000\`); pass that anchor back as \`anchor\` to jump straight to a section.

Returns: { markdown (this page), chars (whole document), offset, next_offset?, outline? }. Errors if cache miss (user must re-upload).`,
  group: 'read',
  resultType: 'contextual',
  parallelSafety: 'safe',
  isReadOnly: true,

  parameters: {
    type: 'object',
    properties: {
      file_id: {
        type: 'string',
        description: 'sha256 hex (64 chars) from user message metadata attachment list',
      },
      offset: {
        type: 'number',
        description: `Character offset to start reading from (default 0). Use the next_offset from the previous call to read the next ${PAGE_CHARS}-char page.`,
      },
      anchor: {
        type: 'string',
        description: 'Section anchor from the outline, e.g. "#c12000-20000" (equivalent to offset=12000).',
      },
    },
    required: ['file_id'],
  },

  async function(args: ReadDocumentArgs): Promise<string> {
    if (!isValidFileId(args.file_id)) {
      return JSON.stringify({
        status: 'error',
        error: 'Invalid file_id (must be 64-char sha256 hex). Take it verbatim from the user message metadata attachment list.',
      });
    }
    const p = path.join(CACHE_DIR, `${args.file_id}.md`);
    try {
      const markdown = await fs.readFile(p, 'utf-8');
      const anchor = parseDocAnchor(args.anchor);
      const offset = anchor?.kind === 'char'
        ? Math.max(0, Math.min(markdown.length, anchor.start))
        : Math.max(0, Math.min(markdown.length, Math.floor(Number(args.offset) || 0)));
      /* 锚点给的是区间, 但单次仍按 PAGE_CHARS 封顶 (与 offset 路径一致) */
      const limit = anchor?.kind === 'char'
        ? Math.max(1, Math.min(PAGE_CHARS, anchor.end - anchor.start + 1))
        : PAGE_CHARS;
      const end = Math.min(markdown.length, offset + limit);
      const page = markdown.slice(offset, end);
      /* 长文档首读带大纲 (H-12): 锚点 / 显式 offset 回查时不再重复给, 省上下文。 */
      const outline = !anchor && !args.offset && estimateTokens(markdown) > LONG_DOC_OUTLINE_TRIGGER_TOKENS
        ? buildCharDocOutline(args.file_id, markdown, Math.max(
          // 大纲 + 这一页一起算在首次读的 8K 预算里
          800,
          LONG_DOC_FIRST_READ_TOKEN_BUDGET - estimateTokens(page),
        ))
        : undefined;
      return JSON.stringify({
        status: 'success',
        file_id: args.file_id,
        chars: markdown.length,
        offset,
        ...(end < markdown.length ? { next_offset: end } : {}),
        ...(outline ? { outline: outline.segments } : {}),
        markdown: page,
      });
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        return JSON.stringify({
          status: 'error',
          file_id: args.file_id,
          error: 'Document cache miss — user may have cleared cache or this fileId is invalid. Ask user to re-upload the document.',
        });
      }
      return JSON.stringify({
        status: 'error',
        file_id: args.file_id,
        error: String(err?.message ?? err),
      });
    }
  },
};
