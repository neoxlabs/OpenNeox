import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { ToolCategory } from '@neoxlabs/kernel/types/permissions.js';
import { getWorkspaceRootFromContext } from '@neoxlabs/kernel/tools/workspaceContext.js';
import { loadDocx, saveDocx, guardDocxPositionalWrite } from './wordOoxml.js';
import { formatTextInDocument, validateRunFormat, insertTableAfter, insertImage, type RunFormat } from './wordRich.js';

export const wordFormatTextTool: Tool = {
  name: 'word_format_text',
  description: `Make specific text in a .docx bold / italic / underlined / colored / highlighted / resized — in the body, not just tables. Everything else in the paragraph keeps its formatting.

- find: exact text (may span formatting runs within a paragraph; not across tabs/line breaks/images)
- paragraph_index: optional, limit to one paragraph (from word_get_paragraphs); default all paragraphs
- bold / italic / underline: boolean (false removes)
- color: hex like "C00000"; highlight: yellow / green / cyan / magenta / red / blue / lightGray …; font_size: pt

Returns JSON: { ok, file_path, count }.`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  permission: { category: ToolCategory.WRITE, allowInAskMode: false },
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '.docx path' },
      find: { type: 'string', description: 'Exact text to format' },
      paragraph_index: { type: 'number', description: 'Optional 0-based paragraph index' },
      bold: { type: 'boolean' },
      italic: { type: 'boolean' },
      underline: { type: 'boolean' },
      color: { type: 'string', description: 'Font color hex without #, e.g. "C00000"' },
      highlight: { type: 'string', description: 'Highlight color name, e.g. "yellow"' },
      font_size: { type: 'number', description: 'Font size in pt' },
    },
    required: ['file_path', 'find'],
  },
  async function(args: {
    file_path: string; find: string; paragraph_index?: number;
    bold?: boolean; italic?: boolean; underline?: boolean; color?: string; highlight?: string; font_size?: number;
  }): Promise<string> {
    try {
      const fmt: RunFormat = { bold: args.bold, italic: args.italic, underline: args.underline, color: args.color, highlight: args.highlight, fontSize: args.font_size };
      const bad = validateRunFormat(fmt);
      if (bad) return JSON.stringify({ error: bad });
      const loaded = await loadDocx(args.file_path, getWorkspaceRootFromContext(), { asReadEvidence: false });
      const { newXml, count } = formatTextInDocument(loaded.documentXml, args.find, fmt, { paragraphIndex: args.paragraph_index });
      if (count === 0) {
        return JSON.stringify({ ok: false, file_path: loaded.absPath, count: 0, hint: `没找到「${args.find}」—— 用 word_get_paragraphs 看原文 (跨 tab/换行的文字不能一次选中)` });
      }
      await saveDocx(loaded, newXml);
      return JSON.stringify({ ok: true, file_path: loaded.absPath, count });
    } catch (e: any) {
      return JSON.stringify({ error: e?.message || String(e) });
    }
  },
};

export const wordInsertTableTool: Tool = {
  name: 'word_insert_table',
  description: `Insert a new table into a .docx after a paragraph. Bordered, full text width, equal columns; first row is a bold shaded header that repeats on each page (header:false to disable).

- after_paragraph: 0-based paragraph index from word_get_paragraphs (-1 = at the very top). Must be outside existing tables.
- rows: 2D array of strings, e.g. [["区域","营收"],["华东","620"]]; "\\n" inside a cell makes a line break
Then use word_set_cell to style individual cells if needed.

Returns JSON: { ok, file_path, rows, cols }.`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  permission: { category: ToolCategory.WRITE, allowInAskMode: false },
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '.docx path' },
      after_paragraph: { type: 'number', description: '0-based paragraph index; -1 = top of document' },
      rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: '2D array of cell texts' },
      header: { type: 'boolean', description: 'First row as header (default true)' },
    },
    required: ['file_path', 'after_paragraph', 'rows'],
  },
  async function(args: { file_path: string; after_paragraph: number; rows: unknown; header?: boolean }): Promise<string> {
    try {
      const rows = Array.isArray(args.rows) ? (args.rows as unknown[]).map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '')) : [String(r ?? '')])) : [];
      if (!rows.length) return JSON.stringify({ error: 'rows 不能为空' });
      if (rows.length > 500 || Math.max(...rows.map((r) => r.length)) > 30) return JSON.stringify({ error: '表太大 (最多 500 行 30 列)' });
      const loaded = await loadDocx(args.file_path, getWorkspaceRootFromContext(), { asReadEvidence: false });
      const guard = guardDocxPositionalWrite(loaded.absPath, 'word_insert_table');
      if (guard) return guard;
      const r = insertTableAfter(loaded.documentXml, Number(args.after_paragraph), rows, { header: args.header });
      if (r.error) return JSON.stringify({ error: r.error });
      await saveDocx(loaded, r.newXml);
      return JSON.stringify({ ok: true, file_path: loaded.absPath, rows: rows.length, cols: Math.max(...rows.map((x) => x.length)) });
    } catch (e: any) {
      return JSON.stringify({ error: e?.message || String(e) });
    }
  },
};

export const wordInsertImageTool: Tool = {
  name: 'word_insert_image',
  description: `Insert an image (PNG / JPEG / GIF file) into a .docx after a paragraph, centered, keeping aspect ratio; optional caption line under it.

- image_path: local image file (e.g. a chart you exported, a screenshot, generate_image output)
- after_paragraph: 0-based paragraph index from word_get_paragraphs (-1 = top). Must be outside existing tables.
- width_cm: optional; default = natural size, capped to the page text width

Returns JSON: { ok, file_path, width_cm, height_cm }.`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  permission: { category: ToolCategory.WRITE, allowInAskMode: false },
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '.docx path' },
      image_path: { type: 'string', description: 'PNG / JPEG / GIF path' },
      after_paragraph: { type: 'number', description: '0-based paragraph index; -1 = top of document' },
      width_cm: { type: 'number', description: 'Display width in cm (optional)' },
      caption: { type: 'string', description: 'Optional caption under the image' },
    },
    required: ['file_path', 'image_path', 'after_paragraph'],
  },
  async function(args: { file_path: string; image_path: string; after_paragraph: number; width_cm?: number; caption?: string }): Promise<string> {
    try {
      const workspace = getWorkspaceRootFromContext();
      const imgAbs = path.isAbsolute(args.image_path) ? args.image_path : path.join(workspace ?? process.cwd(), args.image_path);
      if (!fs.existsSync(imgAbs)) return JSON.stringify({ error: `图片不存在: ${imgAbs}` });
      if (fs.statSync(imgAbs).size > 20 * 1024 * 1024) return JSON.stringify({ error: '图片太大 (>20MB)' });
      const loaded = await loadDocx(args.file_path, workspace, { asReadEvidence: false });
      const guard = guardDocxPositionalWrite(loaded.absPath, 'word_insert_image');
      if (guard) return guard;
      const r = await insertImage(loaded.zip, loaded.documentXml, Number(args.after_paragraph), new Uint8Array(fs.readFileSync(imgAbs)), {
        widthCm: typeof args.width_cm === 'number' && args.width_cm > 0 ? args.width_cm : undefined,
        caption: args.caption,
        name: path.basename(imgAbs),
      });
      if (r.error) return JSON.stringify({ error: r.error });
      await saveDocx(loaded, r.newXml);
      return JSON.stringify({ ok: true, file_path: loaded.absPath, width_cm: r.widthCm, height_cm: r.heightCm });
    } catch (e: any) {
      return JSON.stringify({ error: e?.message || String(e) });
    }
  },
};

export const WORD_RICH_TOOLS: Tool[] = [wordFormatTextTool, wordInsertTableTool, wordInsertImageTool];
