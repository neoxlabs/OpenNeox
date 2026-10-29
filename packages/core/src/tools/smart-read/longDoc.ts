/**
 * 长文档分段摘要 + 引用锚点 (work-master-plan H-12)
 *
 * 问题: 100 页 PDF 一次塞满上下文, 后面全部失忆。
 * 做法: 首次整读长文档时只回"大纲"——每段一行位置 + 开头一句, 每段带锚点;
 *       正文按 `readfile(path, anchor="#p5-8")` / `read_document(file_id, anchor="#c12000-20000")` 回查。
 *
 * 这里只有纯函数 (无 I/O / 无模型调用), 抽取式摘要: 取每段第一行有意义文字当标题,
 * 跨页重复的页眉/页脚自动跳过; 段数按 8K token 预算成倍合并, 保证首读增量不超预算。
 *
 * 锚点格式:
 *   #p12 / #p12-15     PDF 页码
 *   #L120-239          readfile 行号
 *   #c12000-20000      read_document 字符偏移
 */

import { estimateTokens } from '@neoxlabs/kernel';

/** 首次整读长文档的上下文预算 (H-12 验收: ≤8K) */
export const LONG_DOC_FIRST_READ_TOKEN_BUDGET = 8000;
/** 超过这个 token 才值得给大纲 —— 短文档整读更省事 */
export const LONG_DOC_OUTLINE_TRIGGER_TOKENS = 4000;
/** readfile 只对文档类扩展名做大纲拦截; 代码文件保持原样 */
const DOC_LIKE_EXT = /\.(md|markdown|mdx|txt|rst|org|adoc)$/i;

export type DocAnchorKind = 'page' | 'line' | 'char';

export interface DocAnchor {
  kind: DocAnchorKind;
  start: number;
  end: number;
}

export interface OutlineUnit {
  start: number;
  end: number;
  heading: string;
  chars: number;
}

export interface OutlineSegment {
  anchor: string;
  label: string;
  heading: string;
  chars: number;
}

export interface DocOutline {
  /** 渲染好的大纲正文 (已压进 token 预算) */
  text: string;
  segments: OutlineSegment[];
}

/** `#p12-15` / `p12` / `#L120-239` / `#c12000-20000` → 锚点; 认不出返回 null */
export function parseDocAnchor(raw: unknown): DocAnchor | null {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().match(/^#?([plc])(\d+)(?:\s*-\s*[plc]?(\d+))?$/i);
  if (!m) return null;
  const kind: DocAnchorKind = m[1].toLowerCase() === 'p'
    ? 'page'
    : m[1].toLowerCase() === 'l' ? 'line' : 'char';
  const start = parseInt(m[2], 10);
  const end = m[3] ? parseInt(m[3], 10) : start;
  if (!Number.isFinite(start) || start < 0) return null;
  const [lo, hi] = start <= end ? [start, end] : [end, start];
  return { kind, start: lo, end: hi };
}

export function isDocLikePath(filePath: string): boolean {
  return DOC_LIKE_EXT.test(filePath);
}

function anchorLabel(kind: DocAnchorKind, start: number, end: number): string {
  const prefix = kind === 'page' ? 'p' : kind === 'line' ? 'L' : 'c';
  return start === end ? `${prefix}${start}` : `${prefix}${start}-${end}`;
}

function positionLabel(kind: DocAnchorKind, start: number, end: number): string {
  if (kind === 'page') return start === end ? `p.${start}` : `pp.${start}-${end}`;
  if (kind === 'line') return start === end ? `L${start}` : `L${start}-${end}`;
  return `chars ${start}-${end}`;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function cleanLine(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** 页码 / 分隔线 / 纯标点不算标题 */
function isNoiseLine(line: string): boolean {
  if (line.length < 2) return true;
  if (!/[\p{L}\p{N}]/u.test(line)) return true;
  if (/^(第\s*\d+\s*页|\d+\s*\/\s*\d+|page\s+\d+)$/i.test(line)) return true;
  return false;
}

function meaningfulLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const line = cleanLine(raw);
    if (!isNoiseLine(line)) out.push(line);
    if (out.length >= 12) break;
  }
  return out;
}

/**
 * 一段的标题: 第一行有意义文字; 跨页重复的行 (页眉/页脚/书名) 跳过 ——
 * 否则 100 页的大纲会变成 100 行一模一样的书名。
 */
function pickHeading(text: string, repeated: ReadonlySet<string>): string {
  const lines = meaningfulLines(text);
  const unique = lines.find((line) => !repeated.has(line));
  const picked = unique ?? lines[0];
  return picked ? truncate(picked, 80) : '(空白)';
}

function countRepeatedHeadings(pageTexts: string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const page of pageTexts) {
    const first = meaningfulLines(page)[0];
    if (!first) continue;
    counts.set(first, (counts.get(first) ?? 0) + 1);
  }
  const threshold = Math.max(3, Math.floor(pageTexts.length * 0.3));
  const repeated = new Set<string>();
  for (const [line, count] of counts) {
    if (count >= threshold) repeated.add(line);
  }
  return repeated;
}

/** pdftotext 的换页分隔符 (见 extractPdfText) → 每页文本 */
export function splitPdfPages(text: string): string[] {
  return text.split(/\n*────\s*\(下一页\)\s*────\n*/).map((page) => page.trim());
}

export function buildPdfOutlineUnits(
  text: string,
  options: { firstPage: number },
): OutlineUnit[] {
  const pages = splitPdfPages(text);
  const repeated = countRepeatedHeadings(pages);
  return pages.map((page, index) => ({
    start: options.firstPage + index,
    end: options.firstPage + index,
    heading: pickHeading(page, repeated),
    chars: page.length,
  }));
}

const MARKDOWN_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
/** 一个章节超过这么多行就再切块, 否则 3000 行的一章在大纲里只有一行, 定位不到内容 */
const MAX_SECTION_LINES = 200;

export function buildTextOutlineUnits(
  text: string,
  options?: { maxSectionLines?: number },
): OutlineUnit[] {
  const maxSectionLines = options?.maxSectionLines ?? MAX_SECTION_LINES;
  const lines = text.split('\n');
  const headings: Array<{ line: number; title: string }> = [];
  lines.forEach((line, index) => {
    const m = line.match(MARKDOWN_HEADING);
    if (m) headings.push({ line: index, title: cleanLine(m[2]) });
  });

  const blocks: Array<{ startLine: number; endLine: number; heading: string }> = [];
  if (headings.length >= 2) {
    if (headings[0].line > 0) {
      blocks.push({ startLine: 0, endLine: headings[0].line - 1, heading: '（前言）' });
    }
    headings.forEach((heading, index) => {
      const endLine = index + 1 < headings.length ? headings[index + 1].line - 1 : lines.length - 1;
      blocks.push({ startLine: heading.line, endLine, heading: heading.title });
    });
  } else {
    for (let start = 0; start < lines.length; start += maxSectionLines) {
      const end = Math.min(lines.length - 1, start + maxSectionLines - 1);
      const heading = meaningfulLines(lines.slice(start, end + 1).join('\n'))[0] ?? '（空白）';
      blocks.push({ startLine: start, endLine: end, heading: truncate(heading, 80) });
    }
  }

  const units: OutlineUnit[] = [];
  for (const block of blocks) {
    const span = block.endLine - block.startLine + 1;
    if (span <= maxSectionLines) {
      units.push({
        start: block.startLine + 1,
        end: block.endLine + 1,
        heading: block.heading,
        chars: lines.slice(block.startLine, block.endLine + 1).join('\n').length,
      });
      continue;
    }
    for (let start = block.startLine; start <= block.endLine; start += maxSectionLines) {
      const end = Math.min(block.endLine, start + maxSectionLines - 1);
      units.push({
        start: start + 1,
        end: end + 1,
        heading: start === block.startLine ? block.heading : `${block.heading}（续）`,
        chars: lines.slice(start, end + 1).join('\n').length,
      });
    }
  }
  return units;
}

/** read_document 的 markdown 缓存按字符偏移分块 (与它的 offset 参数对齐) */
export function buildCharOutlineUnits(
  markdown: string,
  options?: { maxBlockChars?: number },
): OutlineUnit[] {
  const maxBlockChars = options?.maxBlockChars ?? 12000;
  const headings: Array<{ offset: number; title: string }> = [];
  const regex = /^#{1,6}\s+(.+?)\s*#*\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    headings.push({ offset: match.index, title: cleanLine(match[1]) });
  }

  const blocks: Array<{ start: number; end: number; heading: string }> = [];
  if (headings.length >= 2) {
    if (headings[0].offset > 0) {
      blocks.push({ start: 0, end: headings[0].offset - 1, heading: '（前言）' });
    }
    headings.forEach((heading, index) => {
      const end = index + 1 < headings.length ? headings[index + 1].offset - 1 : markdown.length - 1;
      blocks.push({ start: heading.offset, end, heading: heading.title });
    });
  } else {
    for (let start = 0; start < markdown.length; start += maxBlockChars) {
      const end = Math.min(markdown.length - 1, start + maxBlockChars - 1);
      const heading = meaningfulLines(markdown.slice(start, end + 1))[0] ?? '（空白）';
      blocks.push({ start, end, heading: truncate(heading, 80) });
    }
  }

  const units: OutlineUnit[] = [];
  for (const block of blocks) {
    const span = block.end - block.start + 1;
    if (span <= maxBlockChars) {
      units.push({
        start: block.start,
        end: block.end,
        heading: block.heading,
        chars: span,
      });
      continue;
    }
    for (let start = block.start; start <= block.end; start += maxBlockChars) {
      const end = Math.min(block.end, start + maxBlockChars - 1);
      units.push({
        start,
        end,
        heading: start === block.start ? block.heading : `${block.heading}（续）`,
        chars: end - start + 1,
      });
    }
  }
  return units;
}

/** 相邻 units 合并成一段, 段数随 groupSize 成倍减少 (用来把大纲压进预算) */
export function groupOutlineUnits(units: OutlineUnit[], groupSize: number): OutlineUnit[] {
  const size = Math.max(1, Math.floor(groupSize));
  const grouped: OutlineUnit[] = [];
  for (let i = 0; i < units.length; i += size) {
    const slice = units.slice(i, i + size);
    const first = slice[0];
    const last = slice[slice.length - 1];
    grouped.push({
      start: first.start,
      end: last.end,
      heading: first.heading,
      chars: slice.reduce((sum, unit) => sum + unit.chars, 0),
    });
  }
  return grouped;
}

export interface DocOutlineOptions {
  /** 显示用的文件名 */
  displayPath: string;
  kind: DocAnchorKind;
  units: OutlineUnit[];
  /** 全文总字数 (units.chars 可能只覆盖部分) */
  totalChars: number;
  /** PDF 总页数; 文本给行数 */
  totalUnits?: number;
  /** 读正文的调用样例, 例如 readfile(path="x.pdf", anchor="#p1-4") */
  readHint: string;
  /** 单位名称: '页' / '行' / '字' */
  unitName: string;
  note?: string;
  budgetTokens?: number;
}

function formatChars(chars: number): string {
  if (chars >= 1_000_000) return `${(chars / 1_000_000).toFixed(1)}M`;
  if (chars >= 1000) return `${(chars / 1000).toFixed(1)}K`;
  return String(chars);
}

function renderSegments(segments: OutlineSegment[]): string {
  const rows = segments.map((segment) =>
    `${segment.anchor.padEnd(14)} ${segment.label.padEnd(14)} ${formatChars(segment.chars).padStart(6)}  ${segment.heading}`);
  return rows.join('\n');
}

/**
 * 生成大纲, 并保证渲染结果不超过预算:
 * groupSize 依次 1/2/4/8…, 段数减半直到放得下; 最坏合并成一段 (标题 + 摘要), 一定放得下。
 */
export function buildDocOutline(options: DocOutlineOptions): DocOutline {
  const budget = options.budgetTokens ?? LONG_DOC_FIRST_READ_TOKEN_BUDGET;
  const header = [
    `[长文档大纲] ${options.displayPath} · 共 ${options.totalUnits ?? '?'} ${options.unitName} · 全文约 ${formatChars(options.totalChars)} 字`,
    `首读只给分段摘要, 正文按锚点取: ${options.readHint}`,
    ...(options.note ? [options.note] : []),
    '',
    `${'锚点'.padEnd(14)} ${'位置'.padEnd(14)} ${'字数'.padStart(6)}  开头`,
  ].join('\n');

  let groupSize = 1;
  let segments: OutlineSegment[] = [];
  let rendered = '';
  for (;;) {
    const grouped = groupOutlineUnits(options.units, groupSize);
    segments = grouped.map((unit) => ({
      anchor: `#${anchorLabel(options.kind, unit.start, unit.end)}`,
      label: positionLabel(options.kind, unit.start, unit.end),
      heading: unit.heading,
      chars: unit.chars,
    }));
    rendered = [
      header,
      renderSegments(segments),
      '',
      `共 ${segments.length} 段。读完一段后按下一段的锚点继续; 要全文可显式传范围参数。`,
    ].join('\n');
    if (estimateTokens(rendered) <= budget || groupSize >= Math.max(1, options.units.length)) break;
    groupSize *= 2;
  }

  return { text: rendered, segments };
}

/** readfile 的 PDF 文本通道首读 */
export function buildPdfDocOutline(
  displayPath: string,
  args: { text: string; firstPage: number; lastPage: number; totalPages: number },
  budgetTokens?: number,
): DocOutline {
  const units = buildPdfOutlineUnits(args.text, { firstPage: args.firstPage });
  return buildDocOutline({
    displayPath,
    kind: 'page',
    units,
    totalChars: args.text.length,
    totalUnits: args.totalPages,
    unitName: '页',
    readHint: `readfile(path="${displayPath}", anchor="#p${args.firstPage}-${Math.min(args.firstPage + 1, args.lastPage)}")`,
    ...(args.lastPage < args.totalPages
      ? { note: `大纲覆盖第 ${args.firstPage}-${args.lastPage} 页; 其余 ${args.totalPages - args.lastPage} 页用 pages="${args.lastPage + 1}-…" 读。` }
      : {}),
    ...(budgetTokens === undefined ? {} : { budgetTokens }),
  });
}

/** readfile 的 .md/.txt 文档首读 */
export function buildTextDocOutline(
  displayPath: string,
  text: string,
  budgetTokens?: number,
): DocOutline {
  const units = buildTextOutlineUnits(text);
  const lineCount = text.split('\n').length;
  return buildDocOutline({
    displayPath,
    kind: 'line',
    units,
    totalChars: text.length,
    totalUnits: lineCount,
    unitName: '行',
    readHint: `readfile(path="${displayPath}", anchor="#L1-200")`,
    ...(budgetTokens === undefined ? {} : { budgetTokens }),
  });
}

/** read_document 首读 */
export function buildCharDocOutline(
  displayPath: string,
  markdown: string,
  budgetTokens?: number,
): DocOutline {
  const units = buildCharOutlineUnits(markdown);
  return buildDocOutline({
    displayPath,
    kind: 'char',
    units,
    totalChars: markdown.length,
    totalUnits: undefined,
    unitName: '字符块',
    readHint: `read_document(file_id="…", anchor="#c0-8000")`,
    ...(budgetTokens === undefined ? {} : { budgetTokens }),
  });
}
