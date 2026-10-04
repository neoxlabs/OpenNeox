
import * as fs from 'node:fs';
import * as path from 'node:path';
import JSZip from 'jszip';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { ToolCategory } from '@neoxlabs/kernel/types/permissions.js';
import { getWorkspaceRootFromContext } from '@neoxlabs/kernel/tools/workspaceContext.js';
import { escapeXml } from './wordOoxml.js';
import { buildTableXml, insertImage, addHyperlinkRel, buildHyperlinkRun } from './wordRich.js';

type WordBlock =
  | { kind: 'heading'; text: string; level: number }
  | { kind: 'paragraph'; text: string }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'image'; src: string; alt: string };

/** 跟 wordRich / wordOoxml 的 W_P_RE 同一套 —— 自闭合 `<w:p/>` 算一段, 表格里的段落也算。
 *  插图要按段落编号定位, 这里数错一个, 图就插到别的地方去了 (而且不报错)。 */
const W_P_RE = /<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
const countParagraphs = (xml: string): number => (xml.match(W_P_RE) ?? []).length;

/** 只认 http(s) —— 其它协议原样留字面, 别给 Word 塞个打不开的目标 */
const LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;
const IMAGE_RE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;
/** markdown 表格的分隔行: |---|:--:|--- | */
const TABLE_SEP_RE = /^\|[\s:|-]+\|?$/;
/** 单图上限 —— 跟 word_insert_image 同一口径 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function safeTitle(raw: string | undefined, fallback: string): string {
  const title = (raw || '').trim() || fallback;
  return title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').slice(0, 80) || fallback;
}

function normalizeSavePath(savePath: string, workspace: string): string {
  const withExt = /\.docx$/i.test(savePath) ? savePath : `${savePath}.docx`;
  return path.isAbsolute(withExt) ? withExt : path.join(workspace, withExt);
}

function splitRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').map((c) => c.trim());
}

function parseBlocks(content: string, title?: string): WordBlock[] {
  const blocks: WordBlock[] = [];
  const normalized = content.replace(/\r\n?/g, '\n');
  let tableBuf: string[][] = [];

  const flushTable = () => {
    if (tableBuf.length > 0) {
      blocks.push({ kind: 'table', rows: tableBuf });
      tableBuf = [];
    }
  };

  for (const rawLine of normalized.split('\n')) {
    const line = rawLine.trim();

    /* 表格: 连续的 | … | 行聚成一张; 分隔行只是画线, 不进数据 */
    if (/^\|.*\|$/.test(line)) {
      if (!TABLE_SEP_RE.test(line)) tableBuf.push(splitRow(line));
      continue;
    }
    flushTable();

    if (!line) continue;

    const image = IMAGE_RE.exec(line);
    if (image) {
      blocks.push({ kind: 'image', alt: image[1].trim(), src: image[2].trim() });
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      blocks.push({ kind: 'heading', level: Math.min(3, heading[1].length), text: heading[2].trim() });
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      blocks.push({ kind: 'paragraph', text: `• ${bullet[1].trim()}` });
      continue;
    }
    blocks.push({ kind: 'paragraph', text: line });
  }
  flushTable();

  if (blocks.length === 0) blocks.push({ kind: 'heading', level: 1, text: title || 'Untitled' });
  return blocks;
}

/** 收集正文里所有 http(s) 链接 (去重) —— 要先给它们分配 rId 才能写正文 */
function collectLinks(blocks: WordBlock[]): string[] {
  const urls = new Set<string>();
  for (const b of blocks) {
    if (b.kind !== 'heading' && b.kind !== 'paragraph') continue;
    for (const m of b.text.matchAll(LINK_RE)) urls.add(m[2]);
  }
  return [...urls];
}

/** 把一段文字切成 run: 普通文字 + 超链接。链接没登记到 rId 就退回字面文本。 */
function runsFor(text: string, rPr: string, linkIds: Map<string, string>): string {
  const out: string[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK_RE)) {
    const [full, label, url] = m;
    const at = m.index!;
    if (at > last) out.push(`<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(text.slice(last, at))}</w:t></w:r>`);
    const rId = linkIds.get(url);
    out.push(rId
      ? buildHyperlinkRun(rId, label)
      : `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(full)}</w:t></w:r>`);
    last = at + full.length;
  }
  if (last < text.length) out.push(`<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(text.slice(last))}</w:t></w:r>`);
  return out.join('') || `<w:r>${rPr}<w:t xml:space="preserve"></w:t></w:r>`;
}

function blockXml(block: WordBlock, linkIds: Map<string, string>, widthTwips: number): string {
  if (block.kind === 'table') {
    return buildTableXml(block.rows, { widthTwips });
  }
  if (block.kind === 'image') return '';   /* 图片走 insertImage, 不在这里出 XML */
  if (block.kind === 'heading') {
    const level = Math.max(1, Math.min(3, block.level));
    const size = level === 1 ? 32 : level === 2 ? 28 : 24;
    const rPr = `<w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr>`;
    return `<w:p><w:pPr><w:spacing w:before="280" w:after="120"/><w:outlineLvl w:val="${level - 1}"/></w:pPr>${runsFor(block.text, rPr, linkIds)}</w:p>`;
  }
  return `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr>${runsFor(block.text, '<w:rPr><w:sz w:val="22"/></w:rPr>', linkIds)}</w:p>`;
}

export interface CreateDocxResult {
  buffer: Buffer;
  paragraphs: number;
  tables: number;
  images: number;
  links: number;
  warnings: string[];
}

function resolveImagePath(src: string, outDir: string, workspace: string): string | null {
  if (path.isAbsolute(src)) return fs.existsSync(src) ? src : null;
  for (const base of [outDir, workspace]) {
    const p = path.join(base, src);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function createDocxBuffer(opts: {
  title: string;
  content: string;
  author?: string;
  workspace: string;
  outDir: string;
}): Promise<CreateDocxResult> {
  const zip = new JSZip();
  const now = new Date().toISOString();
  const title = escapeXml(opts.title);
  const author = escapeXml(opts.author || 'Neox');
  const blocks = parseBlocks(opts.content, opts.title);
  const warnings: string[] = [];

  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`);
  zip.folder('_rels')?.file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`);
  zip.folder('docProps')?.file('core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${title}</dc:title>
  <dc:creator>${author}</dc:creator>
  <cp:lastModifiedBy>${author}</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`);
  zip.folder('docProps')?.file('app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Neox</Application>
</Properties>`);
  /* 先建空的 document rels —— addHyperlinkRel / insertImage 都往这里追加 */
  zip.folder('word')?.folder('_rels')?.file('document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`);

  /* 超链接先登记, 才知道正文里该写哪个 rId */
  const linkIds = new Map<string, string>();
  for (const url of collectLinks(blocks)) linkIds.set(url, await addHyperlinkRel(zip, url));

  /* A4 (11906) - 左右各 1440 = 9026 twips。sectPr 是下面写死的, 所以这里是常量而不是量出来的。 */
  const widthTwips = 11906 - 1440 - 1440;

  /* 生成正文, 同时记下每张图该插在第几段之后。
   * 段落编号用 W_P_RE 现算 —— 表格单元格里的段落和表尾那个自闭合 `<w:p/>` 都算数。 */
  const pending: Array<{ afterIndex: number; src: string; alt: string }> = [];
  let body = '';
  for (const b of blocks) {
    if (b.kind === 'image') {
      pending.push({ afterIndex: countParagraphs(body) - 1, src: b.src, alt: b.alt });
      continue;
    }
    body += blockXml(b, linkIds, widthTwips);
  }

  /* xmlns:r 在根上先声明好 —— 超链接要用它, 而 insertImage 的补丁只在有图时才跑;
   * 只有超链接没有图的文档会因此缺命名空间, Word 直接报文件损坏。 */
  let documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${body}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  /* 图片**倒序**插入: 先插后面的, 前面那些段落编号才不会被顶掉 */
  let inserted = 0;
  for (let i = pending.length - 1; i >= 0; i--) {
    const img = pending[i];
    const abs = resolveImagePath(img.src, opts.outDir, opts.workspace);
    if (!abs) {
      warnings.push(`读不到图片 ${img.src} (在文档目录和工作区都没找到)`);
      continue;
    }
    try {
      const stat = fs.statSync(abs);
      if (stat.size > MAX_IMAGE_BYTES) {
        warnings.push(`图片过大跳过 (${Math.round(stat.size / 1024 / 1024)}MB > 20MB): ${img.src}`);
        continue;
      }
      const buf = new Uint8Array(fs.readFileSync(abs));
      const r = await insertImage(zip, documentXml, img.afterIndex, buf, {
        caption: img.alt || undefined,
        name: path.basename(abs),
      });
      if (r.error) { warnings.push(`插图失败 ${img.src}: ${r.error}`); continue; }
      documentXml = r.newXml;
      inserted++;
    } catch (e: any) {
      warnings.push(`读不到图片 ${img.src}: ${e?.message ?? e}`);
    }
  }

  zip.folder('word')?.file('document.xml', documentXml);
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return {
    buffer,
    paragraphs: countParagraphs(documentXml),
    tables: blocks.filter((b) => b.kind === 'table').length,
    images: inserted,
    links: linkIds.size,
    warnings,
  };
}

export const wordCreateTool: Tool = {
  name: 'word_create',
  description: `Create a real .docx Word document from plain text or Markdown-ish content.

Use this when the user asks to create/generate a Word file. Do NOT write plain text to a .docx path.

Supported syntax (everything else becomes a plain paragraph):
- \`#\`/\`##\`/\`###\` headings, \`-\` bullets
- Markdown tables: consecutive \`| a | b |\` lines (the \`|---|\` separator row is ignored)
- Images: \`![caption](path.png)\` on its own line — path is workspace-relative or absolute, PNG/JPEG/GIF, <20MB. The caption becomes a real Word caption.
- Links: \`[text](https://…)\` inline — becomes a real clickable Word hyperlink.

Everything is written in one pass, so you do NOT need word_insert_table / word_insert_image afterwards (those need the file to be read first and would cost extra round trips).

Returns JSON: { ok, file_path, size, paragraphs, tables, images, links, warnings }.`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'safe',
  isReadOnly: false,
  permission: { category: ToolCategory.WRITE, allowInAskMode: false },
  parameters: {
    type: 'object',
    properties: {
      save_path: { type: 'string', description: 'target .docx path, absolute or workspace-relative' },
      content: { type: 'string', description: 'document content: headings, bullets, markdown tables, ![img](path), [text](url)' },
      title: { type: 'string', description: 'optional document title and metadata title' },
      overwrite: { type: 'boolean', description: 'allow clobbering existing file. default false' },
    },
    required: ['save_path', 'content'],
  },
  async function(args: { save_path: string; content: string; title?: string; overwrite?: boolean }): Promise<string> {
    try {
      const workspace = getWorkspaceRootFromContext() ?? process.env.NEOX_WORKDIR ?? process.cwd();
      const outPath = normalizeSavePath(args.save_path, workspace);
      if (fs.existsSync(outPath) && !args.overwrite) {
        return JSON.stringify({ error: `文件已存在: ${outPath}. 设 overwrite=true 覆盖, 或换 save_path.` });
      }
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      const fallbackTitle = path.basename(outPath).replace(/\.docx$/i, '') || 'Document';
      const title = safeTitle(args.title, fallbackTitle);
      const built = await createDocxBuffer({
        title, content: args.content, workspace, outDir: path.dirname(outPath),
      });
      fs.writeFileSync(outPath, built.buffer);
      const stats = fs.statSync(outPath);
      return JSON.stringify({
        ok: true,
        file_path: outPath,
        size: stats.size,
        paragraphs: built.paragraphs,
        tables: built.tables,
        images: built.images,
        links: built.links,
        ...(built.warnings.length ? { warnings: built.warnings } : {}),
      });
    } catch (e: any) {
      return JSON.stringify({ error: e?.message || String(e) });
    }
  },
};
