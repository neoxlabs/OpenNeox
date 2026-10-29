
import * as fs from 'node:fs';
import * as path from 'node:path';
import JSZip from 'jszip';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { ToolCategory } from '@neoxlabs/kernel/types/permissions.js';
import { getWorkspaceRootFromContext } from '@neoxlabs/kernel/tools/workspaceContext.js';
import { escapeXml } from './wordOoxml.js';
import { buildTableXml, insertImage, addHyperlinkRel, buildHyperlinkRun } from './wordRich.js';
import { markNeoxWritten } from '../delivery/deliveryProvenance.js';
import { withOfficeWriteRetry } from '../officeFileLock.js';
import {
  PRESET_HELP, PRESET_IDS, resolvePreset, buildStylesXml, buildNumberingXml, buildSettingsXml, buildFooters,
  buildHeaderXml, buildTocXml, sectPrXml, textWidth, type WordPreset,
} from './wordLayouts.js';

type Align = 'center' | 'right';
type WordBlock =
  | { kind: 'title'; text: string }
  | { kind: 'heading'; text: string; level: number }
  | { kind: 'paragraph'; text: string; align?: Align; style?: 'bullet' | 'numbered' | 'quote' | 'plain' }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'image'; src: string; alt: string }
  | { kind: 'pagebreak' };

/** 跟 wordRich / wordOoxml 的 W_P_RE 同一套 —— 自闭合 `<w:p/>` 算一段, 表格里的段落也算。
 *  插图要按段落编号定位, 这里数错一个, 图就插到别的地方去了 (而且不报错)。 */
const W_P_RE = /<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
const countParagraphs = (xml: string): number => (xml.match(W_P_RE) ?? []).length;

/** 只认 http(s) —— 其它协议原样留字面, 别给 Word 塞个打不开的目标 */
const LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;
const IMAGE_RE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;
/** markdown 表格的分隔行: |---|:--:|--- | */
const TABLE_SEP_RE = /^\|[\s:|-]+\|?$/;
const PAGEBREAK_RE = /^(\\newpage|---\s*pagebreak\s*---|<pagebreak\s*\/?>|\[pagebreak\])$/i;
const ALIGN_RE = /^\[(center|right|居中|靠右|右对齐)\]\s*/i;
/** 编号段: 1. / 1、/ (1) / （1）/ ① —— 原样保留编号文字, 只给悬挂缩进 */
const NUMBERED_RE = /^(\d{1,3}[.、．]|[(（]\d{1,3}[)）]|[①-⑳])\s*\S/;
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

const toAlign = (raw: string): Align => (/right|靠右|右对齐/i.test(raw) ? 'right' : 'center');

const ZH_PUNCT: Record<string, string> = { ',': '，', ';': '；', ':': '：', '!': '！', '?': '？' };
export function zhPunct(text: string): string {
  return text
    .replace(/([一-鿿）”」》])([,;:!?])(?![\d/])/g, (_, a: string, p: string) => a + ZH_PUNCT[p])
    .replace(/([,;:!?])(?=[一-鿿“「《（])/g, (p: string) => ZH_PUNCT[p]!)
    .replace(/(^|[^\]])\(([^()]*[一-鿿][^()]*)\)/g, (m, pre: string, inner: string) => (/https?:\/\//.test(inner) ? m : `${pre}（${inner}）`));
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

  const zh = /[一-鿿]/.test(normalized);
  for (const rawLine of normalized.split('\n')) {
    const line = zh ? zhPunct(rawLine.trim()) : rawLine.trim();

    /* 表格: 连续的 | … | 行聚成一张; 分隔行只是画线, 不进数据 */
    if (/^\|.*\|$/.test(line)) {
      /* 表格格子里的 **加粗** 只去掉星号 (表格走 buildTableXml 整格纯文本, 不拆 run) */
      if (!TABLE_SEP_RE.test(line)) tableBuf.push(splitRow(line).map((c) => c.replace(BOLD_RE, '$1')));
      continue;
    }
    flushTable();

    if (!line) continue;
    if (PAGEBREAK_RE.test(line)) { blocks.push({ kind: 'pagebreak' }); continue; }

    const image = IMAGE_RE.exec(line);
    if (image) {
      blocks.push({ kind: 'image', alt: image[1].trim(), src: image[2].trim() });
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() });
      continue;
    }
    const align = ALIGN_RE.exec(line);
    if (align) {
      blocks.push({ kind: 'paragraph', text: line.slice(align[0].length), align: toAlign(align[1]) });
      continue;
    }
    const bullet = line.match(/^[-*•·]\s+(.+)$/);
    if (bullet) { blocks.push({ kind: 'paragraph', text: bullet[1].trim(), style: 'bullet' }); continue; }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) { blocks.push({ kind: 'paragraph', text: quote[1].trim(), style: 'quote' }); continue; }
    if (NUMBERED_RE.test(line)) { blocks.push({ kind: 'paragraph', text: line, style: 'numbered' }); continue; }
    blocks.push({ kind: 'paragraph', text: line });
  }
  flushTable();

  if (blocks.length === 0) blocks.push({ kind: 'heading', level: 1, text: title || 'Untitled' });

  /* 第一块是一级标题 → 文档大标题 (Title 样式, 居中)。后面没有别的一级标题时, 其余标题整体升一级:
   * 模型最常见的写法是「# 文档名」+「## 一、…」+「### （一）…」, 二级其实是正文的一级。 */
  const first = blocks[0]!;
  if (first.kind === 'heading' && first.level === 1) {
    blocks[0] = { kind: 'title', text: first.text };
    const moreH1 = blocks.some((b, i) => i > 0 && b.kind === 'heading' && b.level === 1);
    if (!moreH1) for (const b of blocks) if (b.kind === 'heading') b.level = Math.max(1, b.level - 1);
  }
  for (const b of blocks) if (b.kind === 'heading') b.level = Math.min(3, b.level);
  return blocks;
}

/** 收集正文里所有 http(s) 链接 (去重) —— 要先给它们分配 rId 才能写正文 */
function collectLinks(blocks: WordBlock[]): string[] {
  const urls = new Set<string>();
  for (const b of blocks) {
    if (b.kind !== 'heading' && b.kind !== 'paragraph' && b.kind !== 'title') continue;
    for (const m of b.text.matchAll(LINK_RE)) urls.add(m[2]);
  }
  return [...urls];
}

const BOLD_RE = /\*\*(.+?)\*\*/g;

/** 普通文字 → run; 里面的 **加粗** 变成真的粗体 run (10-15 QA: 周报里「**汇报人：**」星号原样进了 Word) */
function textRuns(text: string, rPr: string): string[] {
  const boldPr = !rPr ? '<w:rPr><w:b/></w:rPr>' : rPr.includes('<w:b/>') ? rPr : rPr.replace('<w:rPr>', '<w:rPr><w:b/>');
  const out: string[] = [];
  let last = 0;
  for (const m of text.matchAll(BOLD_RE)) {
    const at = m.index!;
    if (at > last) out.push(`<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(text.slice(last, at))}</w:t></w:r>`);
    out.push(`<w:r>${boldPr}<w:t xml:space="preserve">${escapeXml(m[1])}</w:t></w:r>`);
    last = at + m[0].length;
  }
  if (last < text.length) out.push(`<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(text.slice(last))}</w:t></w:r>`);
  return out;
}

/** 把一段文字切成 run: 普通文字 (含 **加粗**) + 超链接。链接没登记到 rId 就退回字面文本。 */
function runsFor(text: string, rPr: string, linkIds: Map<string, string>): string {
  const out: string[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK_RE)) {
    const [full, label, url] = m;
    const at = m.index!;
    if (at > last) out.push(...textRuns(text.slice(last, at), rPr));
    const rId = linkIds.get(url);
    out.push(rId
      ? buildHyperlinkRun(rId, label)
      : `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(full)}</w:t></w:r>`);
    last = at + full.length;
  }
  if (last < text.length) out.push(...textRuns(text.slice(last), rPr));
  return out.join('') || `<w:r>${rPr}<w:t xml:space="preserve"></w:t></w:r>`;
}

interface RenderCtx { preset: WordPreset; linkIds: Map<string, string>; anchors: Map<WordBlock, string>; bookmarkId: number }

function blockXml(block: WordBlock, ctx: RenderCtx): string {
  const { preset: p, linkIds } = ctx;
  if (block.kind === 'table') {
    return buildTableXml(block.rows, {
      widthTwips: textWidth(p), headFill: p.tableHeadFill, fontSize: p.tableFontSize,
      cellPPr: '<w:pPr><w:spacing w:before="40" w:after="40" w:line="260" w:lineRule="auto"/><w:ind w:firstLine="0"/></w:pPr>',
    });
  }
  if (block.kind === 'image') return '';   /* 图片走 insertImage, 不在这里出 XML */
  if (block.kind === 'pagebreak') return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  if (block.kind === 'title') {
    return `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr>${runsFor(block.text, '', linkIds)}</w:p>`;
  }
  if (block.kind === 'heading') {
    const anchor = ctx.anchors.get(block);
    const id = ctx.bookmarkId++;
    const bm = anchor ? [`<w:bookmarkStart w:id="${id}" w:name="${anchor}"/>`, `<w:bookmarkEnd w:id="${id}"/>`] : ['', ''];
    return `<w:p><w:pPr><w:pStyle w:val="Heading${block.level}"/></w:pPr>${bm[0]}${runsFor(block.text, '', linkIds)}${bm[1]}</w:p>`;
  }
  const pPr = block.style === 'bullet'
    ? '<w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>'
    /* 编号段 (1. / （1）) 跟正文同一缩进: 中文文档的习惯; 试卷正文不缩进, 题号行和选项行才对得齐 */
    : block.style === 'numbered' ? ''
      : block.style === 'quote' ? '<w:pPr><w:pStyle w:val="Quote"/></w:pPr>'
        : block.align ? `<w:pPr><w:ind w:firstLine="0"/><w:jc w:val="${block.align}"/></w:pPr>` : '';
  return `<w:p>${pPr}${runsFor(block.text, '', linkIds)}</w:p>`;
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
  preset?: string;
  toc?: boolean;
  header?: string;
}): Promise<CreateDocxResult> {
  const zip = new JSZip();
  const now = new Date().toISOString();
  const title = escapeXml(opts.title);
  const author = escapeXml(opts.author || 'Neox');
  const preset = resolvePreset(opts.preset);
  const blocks = parseBlocks(opts.content, opts.title);
  const warnings: string[] = [];
  const footers = buildFooters(preset);
  const zh = /[一-鿿]/.test(opts.content);

  const parts: Array<{ name: string; type: string; rel: string; id: string; xml: string }> = [
    { name: 'styles.xml', type: 'wordprocessingml.styles+xml', rel: 'styles', id: 'rIdNxStyles', xml: buildStylesXml(preset) },
    { name: 'numbering.xml', type: 'wordprocessingml.numbering+xml', rel: 'numbering', id: 'rIdNxNumbering', xml: buildNumberingXml(preset) },
    { name: 'settings.xml', type: 'wordprocessingml.settings+xml', rel: 'settings', id: 'rIdNxSettings', xml: '' },
  ];
  if (footers) parts.push({ name: 'footer1.xml', type: 'wordprocessingml.footer+xml', rel: 'footer', id: 'rIdNxFooter', xml: footers.main });
  if (footers?.even) parts.push({ name: 'footer2.xml', type: 'wordprocessingml.footer+xml', rel: 'footer', id: 'rIdNxFooterEven', xml: footers.even });
  if (opts.header?.trim()) parts.push({ name: 'header1.xml', type: 'wordprocessingml.header+xml', rel: 'header', id: 'rIdNxHeader', xml: buildHeaderXml(opts.header.trim(), escapeXml) });

  /* 目录: 调用方 toc 优先, 没说就看版式 (论文默认带); 标题少于 3 个不出, 一张纸的东西不需要目录 */
  const headings = blocks.filter((b): b is Extract<WordBlock, { kind: 'heading' }> => b.kind === 'heading');
  const wantToc = (opts.toc ?? preset.toc ?? false) && headings.length >= 3;
  const anchors = new Map<WordBlock, string>();
  if (wantToc) headings.forEach((h, i) => anchors.set(h, `_Toc_nx_${i + 1}`));
  const settings = parts.find((x) => x.name === 'settings.xml')!;
  settings.xml = buildSettingsXml({ updateFields: wantToc, evenOdd: !!footers?.even });

  const ooxml = 'application/vnd.openxmlformats-officedocument.';
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="${ooxml}wordprocessingml.document.main+xml"/>
${parts.map((x) => `  <Override PartName="/word/${x.name}" ContentType="${ooxml}${x.type}"/>`).join('\n')}
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="${ooxml}extended-properties+xml"/>
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
  const word = zip.folder('word')!;
  for (const x of parts) word.file(x.name, x.xml);
  /* 版式部件的关系先写死 (id 带 Nx 前缀, 不跟 addHyperlinkRel / insertImage 自增的 rIdN 撞) */
  word.folder('_rels')?.file('document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${parts.map((x) => `<Relationship Id="${x.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${x.rel}" Target="${x.name}"/>`).join('')}</Relationships>`);

  /* 超链接先登记, 才知道正文里该写哪个 rId */
  const linkIds = new Map<string, string>();
  for (const url of collectLinks(blocks)) linkIds.set(url, await addHyperlinkRel(zip, url));

  /* 生成正文, 同时记下每张图该插在第几段之后。
   * 段落编号用 W_P_RE 现算 —— 表格单元格里的段落和表尾那个自闭合 `<w:p/>` 都算数。 */
  const ctx: RenderCtx = { preset, linkIds, anchors, bookmarkId: 1 };
  const tocXml = wantToc ? buildTocXml(headings.map((h) => ({ level: h.level, text: h.text.replace(BOLD_RE, '$1'), anchor: anchors.get(h)! })), escapeXml, zh) : '';
  const pending: Array<{ afterIndex: number; src: string; alt: string }> = [];
  let body = '';
  let tocPlaced = !tocXml;
  for (const b of blocks) {
    if (!tocPlaced && b.kind !== 'title' && !(b.kind === 'paragraph' && b.align)) {
      /* 目录放在大标题和紧跟着的居中 / 靠右副标题之后, 另起一页开始正文 */
      body += tocXml + '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
      tocPlaced = true;
    }
    if (b.kind === 'image') {
      pending.push({ afterIndex: countParagraphs(body) - 1, src: b.src, alt: b.alt });
      continue;
    }
    body += blockXml(b, ctx);
  }

  /* xmlns:r 在根上先声明好 —— 超链接 / 页脚引用要用它 */
  let documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${body}
    ${sectPrXml(preset, {
      footer: footers ? 'rIdNxFooter' : undefined,
      footerEven: footers?.even ? 'rIdNxFooterEven' : undefined,
      header: opts.header?.trim() ? 'rIdNxHeader' : undefined,
    })}
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

  word.file('document.xml', documentXml);
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
  description: `Create a finished, properly typeset .docx in ONE call (Chinese fonts, real heading styles, bullets, page numbers, optional TOC/header). This is the whole job — do NOT write python-docx scripts, do NOT convert to PDF to count pages, do NOT re-create the file to tweak layout. For domain conventions (教案 / 试卷 / 公文 / 合同 / 简历 / 论文…) load the word-doc-writer skill first.

preset (pick by what the user is making; default report):
${PRESET_HELP}

Content syntax (Markdown-ish):
- First line \`# 标题\` becomes the centered document title; then \`##\` = 一级标题, \`###\` = 二级, \`####\` = 三级
- \`-\` bullets (real Word bullets); \`1.\` / \`1、\` / \`（1）\` numbered lines keep their numbers with hanging indent
- \`> text\` = shaded note box; \`[center] text\` / \`[right] text\` = alignment (落款、日期用 [right])
- Markdown tables (\`| a | b |\`, the \`|---|\` row is ignored; first row = shaded header)
- \`![caption](path.png)\` images; \`[text](https://…)\` links; \`**bold**\`; a line \`\\newpage\` = page break

Returns JSON: { ok, file_path, preset, size, paragraphs, tables, images, links, warnings }.`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'safe',
  isReadOnly: false,
  permission: { category: ToolCategory.WRITE, allowInAskMode: false },
  parameters: {
    type: 'object',
    properties: {
      save_path: { type: 'string', description: 'target .docx path, absolute or workspace-relative' },
      content: { type: 'string', description: 'document content in the syntax above' },
      title: { type: 'string', description: 'optional document metadata title' },
      preset: { type: 'string', enum: PRESET_IDS, description: 'layout preset, see description (default report)' },
      toc: { type: 'boolean', description: 'insert a table of contents after the title (default: only academic). Needs ≥3 headings' },
      header: { type: 'string', description: 'optional running header text, e.g. 公司名 / 课程名 / 文档名' },
      overwrite: { type: 'boolean', description: 'allow clobbering existing file. default false' },
    },
    required: ['save_path', 'content'],
  },
  async function(args: { save_path: string; content: string; title?: string; preset?: string; toc?: boolean; header?: string; overwrite?: boolean }): Promise<string> {
    try {
      const workspace = getWorkspaceRootFromContext() ?? process.env.NEOX_WORKDIR ?? process.cwd();
      const outPath = normalizeSavePath(args.save_path, workspace);
      if (fs.existsSync(outPath) && !args.overwrite) {
        return JSON.stringify({ error: `文件已存在: ${outPath}. 设 overwrite=true 覆盖, 或换 save_path.` });
      }
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      const fallbackTitle = path.basename(outPath).replace(/\.docx$/i, '') || 'Document';
      const title = safeTitle(args.title, fallbackTitle);
      const preset = resolvePreset(args.preset);
      const built = await createDocxBuffer({
        title, content: args.content, workspace, outDir: path.dirname(outPath),
        preset: preset.id, toc: args.toc, header: preset.id === 'gov' ? undefined : args.header,
      });
      await withOfficeWriteRetry(outPath, () => fs.writeFileSync(outPath, built.buffer));
      /* 登记「本次进程写过它」—— 交付闸门 (open_surface) 据此决定要不要强制结构自检 (work O-22) */
      markNeoxWritten(outPath);
      const stats = fs.statSync(outPath);
      return JSON.stringify({
        ok: true,
        file_path: outPath,
        preset: preset.id,
        size: stats.size,
        paragraphs: built.paragraphs,
        tables: built.tables,
        images: built.images,
        links: built.links,
        ...(built.warnings.length ? { warnings: built.warnings } : {}),
        next: 'Done — open it for the user (open_surface). No PDF / page-count check needed.',
      });
    } catch (e: any) {
      return JSON.stringify({ error: e?.message || String(e) });
    }
  },
};
