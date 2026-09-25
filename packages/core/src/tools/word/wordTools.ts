
import * as fs from 'node:fs';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { ToolCategory } from '@neoxlabs/kernel/types/permissions.js';
import { getWorkspaceRootFromContext } from '@neoxlabs/kernel/tools/workspaceContext.js';
import {
  loadDocx, saveDocx, extractParagraphs, describeDocx,
  replaceTextEverywhere, replaceParagraphText, insertParagraphAfter, deleteParagraph,
  extractTables, extractTableContent, setTableCell, type CellStyle,
  guardDocxPositionalWrite,
} from './wordOoxml.js';
import { wordExportTool } from './wordExportTool.js';
import { wordToPdfTool } from './wordToPdfTool.js';
import { wordCreateTool } from './wordCreateTool.js';
import { WORD_RICH_TOOLS } from './wordRichTools.js';

/* ============================================================
 * word_describe
 * ============================================================ */
export const wordDescribeTool: Tool = {
  name: 'word_describe',
  description: `Describe a .docx Word document: paragraphs count, headings, characters, words estimate, images, tables.
**Does NOT return full text** — token-cheap structural overview, call first before word_get_paragraphs.

Returns JSON: { paragraphs, headings, characters, words_estimate, images, tables, mtime_ms }.

**Live editing note**: If the .docx is opened in a Word surface, the user can see your edits
in real-time after each tool call. Always re-call this tool when current state matters.`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'safe',
  isReadOnly: true,
  permission: { category: ToolCategory.READ, allowInAskMode: true },
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '.docx file path (absolute or workspace-relative)' },
    },
    required: ['file_path'],
  },
  async function(args: { file_path: string }): Promise<string> {
    try {
      const workspace = getWorkspaceRootFromContext();
      const loaded = await loadDocx(args.file_path, workspace);
      const stats = describeDocx(loaded.documentXml);
      let mtime_ms: number | undefined;
      try { mtime_ms = fs.statSync(loaded.absPath).mtimeMs; } catch { /* ignore */ }
      return JSON.stringify({ source: `file=${loaded.absPath}`, ...stats, mtime_ms });
    } catch (e: any) {
      return JSON.stringify({ error: e?.message || String(e) });
    }
  },
};

/* ============================================================
 * word_get_paragraphs
 * ============================================================ */
export const wordGetParagraphsTool: Tool = {
  name: 'word_get_paragraphs',
  description: `Read paragraphs from a .docx as plain text array, each with heading level.

range: optional [start, end) 0-indexed range to slice; omit to get all paragraphs.
Token-heavy on long docs — use sparingly, prefer word_describe first to know paragraph count.

Returns JSON: { total, returned, paragraphs: [{ index, text, heading }, ...] }
heading: 0 = body text; 1-9 = Heading1..9 style.

**Live editing note**: reads disk fresh; re-call if user is editing in Word surface.`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'safe',
  isReadOnly: true,
  permission: { category: ToolCategory.READ, allowInAskMode: true },
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '.docx file path' },
      range: {
        type: 'array',
        items: { type: 'number' },
        description: '[start, end) 0-indexed paragraph range. Omit for all.',
      },
    },
    required: ['file_path'],
  },
  async function(args: { file_path: string; range?: [number, number] }): Promise<string> {
    try {
      const workspace = getWorkspaceRootFromContext();
      const loaded = await loadDocx(args.file_path, workspace);
      const all = extractParagraphs(loaded.documentXml);
      let slice = all;
      if (Array.isArray(args.range) && args.range.length === 2) {
        const [s, e] = args.range;
        slice = all.slice(Math.max(0, s), Math.min(all.length, e));
      }
      return JSON.stringify({
        source: `file=${loaded.absPath}`,
        total: all.length,
        returned: slice.length,
        paragraphs: slice,
      });
    } catch (e: any) {
      return JSON.stringify({ error: e?.message || String(e) });
    }
  },
};

/* ============================================================
 * word_replace_text
 * ============================================================ */
export const wordReplaceTextTool: Tool = {
  name: 'word_replace_text',
  description: `Global text replace in a .docx — **preserves 100% original formatting** (theme/fonts/styles/images/tables/headers/footers).

Behavior:
- Replaces 'find' → 'replace' in every <w:t> text node independently
- Works for short phrases / single words / numbers
- **Does NOT work** for long strings spanning multiple runs (Word splits text by formatting; "Hello world" with "Hello" bold may be 2 separate runs). If a replacement fails, retry with a shorter unique substring.
- File is modified in place. Use word_describe first to see what's there.

Returns JSON: { ok, file_path, replaced_count }.`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'unsafe', /* 同一文件并发改危险 */
  isReadOnly: false,
  permission: { category: ToolCategory.WRITE, allowInAskMode: false },
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '.docx file path' },
      find: { type: 'string', description: 'Substring to find (must not span runs — keep short)' },
      replace: { type: 'string', description: 'Replacement text (XML auto-escaped)' },
    },
    required: ['file_path', 'find', 'replace'],
  },
  async function(args: { file_path: string; find: string; replace: string }): Promise<string> {
    try {
      if (!args.find) return JSON.stringify({ error: 'find 不能为空' });
      const workspace = getWorkspaceRootFromContext();
      const loaded = await loadDocx(args.file_path, workspace);
      const { newXml, count } = replaceTextEverywhere(loaded.documentXml, args.find, args.replace);
      if (count === 0) {
        return JSON.stringify({
          ok: false,
          file_path: loaded.absPath,
          replaced_count: 0,
          hint: `未找到 "${args.find}". 可能原因: 文本跨 run 切分 (尝试更短的关键词), 或字面不一致 (检查空格 / 全半角 / 大小写).`,
        });
      }
      await saveDocx(loaded, newXml);
      return JSON.stringify({ ok: true, file_path: loaded.absPath, replaced_count: count });
    } catch (e: any) {
      return JSON.stringify({ error: e?.message || String(e) });
    }
  },
};

/* ============================================================
 * word_edit_paragraph
 * ============================================================ */
export const wordEditParagraphTool: Tool = {
  name: 'word_edit_paragraph',
  description: `Replace the entire text of the N-th paragraph (0-indexed) with new text.

**Preserves paragraph-level style** (heading level / alignment / indent) but **loses run-level formatting** (bold/italic/color/font inside the paragraph). Use word_replace_text instead if you only need to change a few words and must keep fine-grained formatting.

Use word_get_paragraphs first to know index → text mapping.

Returns JSON: { ok, file_path, index, new_text }.`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  permission: { category: ToolCategory.WRITE, allowInAskMode: false },
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '.docx file path' },
      index: { type: 'number', description: '0-indexed paragraph number (from word_get_paragraphs)' },
      new_text: { type: 'string', description: 'Replacement text for the whole paragraph' },
    },
    required: ['file_path', 'index', 'new_text'],
  },
  async function(args: { file_path: string; index: number; new_text: string }): Promise<string> {
    try {
      const workspace = getWorkspaceRootFromContext();
      const loaded = await loadDocx(args.file_path, workspace, { asReadEvidence: false });
      /* 按索引写 → 先过一致性守门 (见 guardDocxPositionalWrite): 索引类操作错了
         机械上不可检出, 必须在写之前拦。 */
      const __guard = guardDocxPositionalWrite(loaded.absPath, 'word_edit_paragraph');
      if (__guard) return __guard;
      const { newXml, replaced } = replaceParagraphText(loaded.documentXml, args.index, args.new_text);
      if (!replaced) {
        return JSON.stringify({ error: `段落 index=${args.index} 不存在 (越界). 先调 word_describe 看段落总数.` });
      }
      await saveDocx(loaded, newXml);
      return JSON.stringify({ ok: true, file_path: loaded.absPath, index: args.index, new_text: args.new_text });
    } catch (e: any) {
      return JSON.stringify({ error: e?.message || String(e) });
    }
  },
};

/* ============================================================
 * word_insert_paragraph
 * ============================================================ */
export const wordInsertParagraphTool: Tool = {
  name: 'word_insert_paragraph',
  description: `Insert a new paragraph after the given index (0-indexed). New paragraph is plain text with no style.

after_index = -1: insert at the very beginning.
after_index >= total: append to end.

Returns JSON: { ok, file_path, after_index, new_text }.`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  permission: { category: ToolCategory.WRITE, allowInAskMode: false },
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '.docx file path' },
      after_index: { type: 'number', description: '0-indexed: insert after this paragraph. -1 = at start.' },
      new_text: { type: 'string', description: 'Paragraph text content (XML auto-escaped)' },
    },
    required: ['file_path', 'after_index', 'new_text'],
  },
  async function(args: { file_path: string; after_index: number; new_text: string }): Promise<string> {
    try {
      const workspace = getWorkspaceRootFromContext();
      const loaded = await loadDocx(args.file_path, workspace, { asReadEvidence: false });
      /* 按索引写 → 先过一致性守门 (见 guardDocxPositionalWrite): 索引类操作错了
         机械上不可检出, 必须在写之前拦。 */
      const __guard = guardDocxPositionalWrite(loaded.absPath, 'word_insert_paragraph');
      if (__guard) return __guard;
      const { newXml, inserted } = insertParagraphAfter(loaded.documentXml, args.after_index, args.new_text);
      if (!inserted) {
        return JSON.stringify({ error: '插入失败 (文档可能没有任何段落)' });
      }
      await saveDocx(loaded, newXml);
      return JSON.stringify({ ok: true, file_path: loaded.absPath, after_index: args.after_index, new_text: args.new_text });
    } catch (e: any) {
      return JSON.stringify({ error: e?.message || String(e) });
    }
  },
};

/* ============================================================
 * word_delete_paragraph
 * ============================================================ */
export const wordDeleteParagraphTool: Tool = {
  name: 'word_delete_paragraph',
  description: `Delete the N-th paragraph (0-indexed). Other paragraphs' indices shift down.

Returns JSON: { ok, file_path, index }.`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  permission: { category: ToolCategory.WRITE, allowInAskMode: false },
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '.docx file path' },
      index: { type: 'number', description: '0-indexed paragraph to delete' },
    },
    required: ['file_path', 'index'],
  },
  async function(args: { file_path: string; index: number }): Promise<string> {
    try {
      const workspace = getWorkspaceRootFromContext();
      const loaded = await loadDocx(args.file_path, workspace, { asReadEvidence: false });
      /* 按索引写 → 先过一致性守门 (见 guardDocxPositionalWrite): 索引类操作错了
         机械上不可检出, 必须在写之前拦。 */
      const __guard = guardDocxPositionalWrite(loaded.absPath, 'word_delete_paragraph');
      if (__guard) return __guard;
      const { newXml, deleted } = deleteParagraph(loaded.documentXml, args.index);
      if (!deleted) {
        return JSON.stringify({ error: `段落 index=${args.index} 不存在 (越界)` });
      }
      await saveDocx(loaded, newXml);
      return JSON.stringify({ ok: true, file_path: loaded.absPath, index: args.index });
    } catch (e: any) {
      return JSON.stringify({ error: e?.message || String(e) });
    }
  },
};

/* ============================================================
 * word_get_tables — 列出文档里所有表格
 * ============================================================ */
export const wordGetTablesTool: Tool = {
  name: 'word_get_tables',
  description: `List all tables in a .docx with dimensions (rows × cols).

Returns JSON: { source, total, tables: [{ index, rows, cols }, ...] }.

Use this first before word_get_table / word_set_cell to find target table_index.
Nested tables (table inside table) are not supported — only top-level tables counted.`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'safe',
  isReadOnly: true,
  permission: { category: ToolCategory.READ, allowInAskMode: true },
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '.docx file path' },
    },
    required: ['file_path'],
  },
  async function(args: { file_path: string }): Promise<string> {
    try {
      const workspace = getWorkspaceRootFromContext();
      const loaded = await loadDocx(args.file_path, workspace);
      const tables = extractTables(loaded.documentXml);
      return JSON.stringify({ source: `file=${loaded.absPath}`, total: tables.length, tables });
    } catch (e: any) {
      return JSON.stringify({ error: e?.message || String(e) });
    }
  },
};

/* ============================================================
 * word_get_table — 拿单个表完整内容 (2D 数组)
 * ============================================================ */
export const wordGetTableTool: Tool = {
  name: 'word_get_table',
  description: `Get a single table's contents as a 2D string array.

Returns JSON: { source, table_index, rows, cols, content: [[...], ...] }.

Use word_get_tables first to know the table_index (0-based).`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'safe',
  isReadOnly: true,
  permission: { category: ToolCategory.READ, allowInAskMode: true },
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '.docx file path' },
      table_index: { type: 'number', description: '0-indexed table number (from word_get_tables)' },
    },
    required: ['file_path', 'table_index'],
  },
  async function(args: { file_path: string; table_index: number }): Promise<string> {
    try {
      const workspace = getWorkspaceRootFromContext();
      const loaded = await loadDocx(args.file_path, workspace);
      const content = extractTableContent(loaded.documentXml, args.table_index);
      if (content === null) {
        return JSON.stringify({ error: `表格 index=${args.table_index} 不存在. 先调 word_get_tables 看总数.` });
      }
      const rows = content.length;
      const cols = Math.max(0, ...content.map(r => r.length));
      return JSON.stringify({
        source: `file=${loaded.absPath}`,
        table_index: args.table_index,
        rows, cols, content,
      });
    } catch (e: any) {
      return JSON.stringify({ error: e?.message || String(e) });
    }
  },
};

/* ============================================================
 * word_set_cell — 改单元格内容 + 样式
 * ============================================================ */
export const wordSetCellTool: Tool = {
  name: 'word_set_cell',
  description: `Set a table cell's text (and optional style). Preserves cell-level tcPr (width/borders).

Coordinate: (table_index, row, col) all 0-indexed. Use word_get_tables / word_get_table to discover.

Style is optional. Subset supported (汇报场景常用):
- bold / italic / underline: boolean
- color: hex string like "FF0000" (no #)  — font color
- bgColor: hex string like "DDDDDD"        — cell background fill
- fontSize: number in pt (e.g. 14 = 14pt)
- align: 'left' | 'center' | 'right' | 'justify'

Note: setting cell text replaces all runs in the cell — run-level formatting (font/bold/italic) of
the original text is lost (style param overrides). Cell-level tcPr (width/borders/shd) preserved.

Returns JSON: { ok, file_path, table_index, row, col }.`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  permission: { category: ToolCategory.WRITE, allowInAskMode: false },
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '.docx file path' },
      table_index: { type: 'number', description: '0-indexed table number' },
      row: { type: 'number', description: '0-indexed row in the table' },
      col: { type: 'number', description: '0-indexed column in the table' },
      text: { type: 'string', description: 'Cell text content (XML auto-escaped)' },
      style: {
        type: 'object',
        description: 'Optional cell styling',
        properties: {
          bold: { type: 'boolean' },
          italic: { type: 'boolean' },
          underline: { type: 'boolean' },
          color: { type: 'string', description: 'hex without # (e.g. "FF0000")' },
          bgColor: { type: 'string', description: 'hex without # (e.g. "DDDDDD")' },
          fontSize: { type: 'number', description: 'point size (e.g. 14)' },
          align: { type: 'string', enum: ['left', 'center', 'right', 'justify'] },
        },
      },
    },
    required: ['file_path', 'table_index', 'row', 'col', 'text'],
  },
  async function(args: {
    file_path: string; table_index: number; row: number; col: number;
    text: string; style?: CellStyle;
  }): Promise<string> {
    try {
      const workspace = getWorkspaceRootFromContext();
      const loaded = await loadDocx(args.file_path, workspace, { asReadEvidence: false });
      /* 按索引写 → 先过一致性守门 (见 guardDocxPositionalWrite): 索引类操作错了
         机械上不可检出, 必须在写之前拦。 */
      const __guard = guardDocxPositionalWrite(loaded.absPath, 'word_set_cell');
      if (__guard) return __guard;
      const { newXml, changed } = setTableCell(
        loaded.documentXml,
        args.table_index, args.row, args.col,
        args.text, args.style,
      );
      if (!changed) {
        return JSON.stringify({
          error: `单元格 [${args.table_index}/${args.row}/${args.col}] 不存在 (越界). 先调 word_get_table 看维度.`,
        });
      }
      await saveDocx(loaded, newXml);
      return JSON.stringify({
        ok: true,
        file_path: loaded.absPath,
        table_index: args.table_index,
        row: args.row, col: args.col,
        text: args.text,
        ...(args.style && { style: args.style }),
      });
    } catch (e: any) {
      return JSON.stringify({ error: e?.message || String(e) });
    }
  },
};

/** 所有 word 工具集合 — runtimeTools.ts 把它进 toolMap, ALWAYS_ACTIVE 不加, wordPack 列名. */
export const ALL_WORD_TOOLS: Tool[] = [
  wordCreateTool,
  wordDescribeTool,
  wordGetParagraphsTool,
  wordReplaceTextTool,
  wordEditParagraphTool,
  wordInsertParagraphTool,
  wordDeleteParagraphTool,
  wordGetTablesTool,
  wordGetTableTool,
  wordSetCellTool,
  ...WORD_RICH_TOOLS,
  wordExportTool,
  wordToPdfTool,
];

export const WORD_TOOL_NAMES: string[] = ALL_WORD_TOOLS.map(t => t.name);
