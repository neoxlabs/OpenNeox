/**
 * Word OOXML 操作 — .docx 解 zip + 改 word/document.xml + 重压.
 *
 *   .docx 是 zip 包, 主体在 word/document.xml. 通过 jszip 解出 → 修改 xml 字符串 → 重压.
 *   这样能**保留原 docx 100% 格式** (主题/字体/页边距/样式/图片/表格/页眉页脚 都不动).
 *
 *   操作粒度限制 (简单 regex + 字符串, 没引入 DOM 解析器):
 *     - 整个 <w:t> 内部文本替换 OK
 *     - 跨 <w:t> 长字符串替换需要先 normalize, 这里不做 (描述里告诉 agent 短词替换最稳)
 *     - 段落 (w:p) 增删改 OK, 但 run 级格式 (字体/加粗/颜色) 会丢失, agent 描述里说明
 *
 *   注: Word 把字符按 "格式相同的 run" 切分, 同一句话部分加粗会被切成多个 <w:t>.
 *   全局替换"hello" 都行, "Hello World" 跨 run 时找不到.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import JSZip from 'jszip';
import { recordOpaqueDocRead, checkCoherence, bumpWorkspaceEpoch } from '../smart-read/readLedger.js';

const DOC_XML_PATH = 'word/document.xml';

export interface LoadedDocx {
  zip: JSZip;
  documentXml: string;
  absPath: string;
}

/** 读 .docx 文件 → 解 zip → 提 document.xml 字符串. 失败抛 Error. */
export async function loadDocx(
  filePath: string,
  workspaceRoot?: string,
  /** Read operations record load evidence; mutating operations pass false so their
   * preparatory load cannot satisfy positional-write guards. */
  opts?: { asReadEvidence?: boolean },
): Promise<LoadedDocx> {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot ?? process.cwd(), filePath);
  if (!fs.existsSync(abs)) throw new Error(`文件不存在: ${abs}`);
  const buf = fs.readFileSync(abs);
  const zip = await JSZip.loadAsync(buf);
  const docFile = zip.file(DOC_XML_PATH);
  if (!docFile) throw new Error(`${abs} 不是有效 .docx (缺 ${DOC_XML_PATH})`);
  const documentXml = await docFile.async('string');
  /* 登记版本戳 —— 读类工具的 load 自动成为"读证据"来源, 不需要逐个工具去加。
     写类工具传 asReadEvidence:false, 否则会给自己造证据把守门废掉 (见上面参数注释)。 */
  if (opts?.asReadEvidence !== false) {
    try {
      const st = fs.statSync(abs);
      recordOpaqueDocRead(abs, st.mtimeMs, st.size);
    } catch { /* stat 失败不影响读 */ }
  }
  return { zip, documentXml, absPath: abs };
}

/**
 * 按位置写 .docx 之前的一致性守门。
 *
 * word_edit_paragraph / insert / delete / set_cell 全是**按索引**操作 ——
 * index 5 永远"有效", 只是文件变过之后它指向的已经是别的段落。这类错误
 * **机械上不可检出**, 所以必须在写之前用版本戳拦住 (对照 edit 的内容寻址:
 * old_string 对不上会明确失败, 所以那边可以放开快路径不设门禁)。
 *
 * 返回 null = 放行; 返回字符串 = 已经是给模型的 JSON 报错。
 */
export function guardDocxPositionalWrite(absPath: string, toolName: string): string | null {
  let st: { mtimeMs: number; size: number };
  try {
    const s = fs.statSync(absPath);
    st = { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null; // stat 不了就别拦, 让底层报真实错误
  }
  const coh = checkCoherence(absPath, st.mtimeMs, st.size);
  if (coh.state === 'fresh') return null;
  if (coh.state === 'unread') {
    return JSON.stringify({
      ok: false,
      error: 'document_not_read',
      file_path: absPath,
      hint: `${toolName} 是按段落/单元格**索引**操作的, 而本会话还没读过这个文档 —— 索引来源不明。`
        + ` 先调 word_get_paragraphs (或 word_describe / word_get_tables) 拿到 index → 内容的对应关系再写。`,
    });
  }
  return JSON.stringify({
    ok: false,
    error: 'stale_document',
    file_path: absPath,
    hint: `这个文档在你读过之后被改动过 (用户在 Word 里编辑 / 另一个工具动过它)。`
      + ` 按索引写会落到**错误的段落**上而且不会报错, 所以这里拦下来 ——`
      + ` 请重新调 word_get_paragraphs 拿当前的 index → 内容对应关系, 再写。`,
  });
}

/** 把改过的 documentXml 写回 zip 重打包到磁盘. */
export async function saveDocx(loaded: LoadedDocx, newDocumentXml: string, savePath?: string): Promise<string> {
  loaded.zip.file(DOC_XML_PATH, newDocumentXml);
  const out = await loaded.zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const target = savePath ?? loaded.absPath;
  fs.writeFileSync(target, out);
  /* 写后刷新版本戳 —— 否则"改完接着改"第二次就会被自己的上一次写判成 stale。
     (跟 editFileTool 写后 refreshReadsAfterWrite 是同一个道理。) */
  try {
    const st = fs.statSync(target);
    recordOpaqueDocRead(target, st.mtimeMs, st.size);
    bumpWorkspaceEpoch();          // 文件内容变了 → 搜索缓存作废
  } catch { /* ignore */ }
  return target;
}

/** XML 转义 — agent 给的文本含 < > & 等要 escape, 否则破坏 XML 结构. */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** XML 反转义 — 读取 <w:t> 内部时用. */
export function unescapeXml(s: string): string {
  return s
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

const W_T_RE = /<w:t(\s[^>]*)?>([^<]*)<\/w:t>/g;
const W_P_RE = /<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;

export interface ParagraphInfo {
  index: number;
  text: string;
  /** Heading 级别 (1-9) 或 0 (普通段落). 从 w:pStyle val="Heading{N}" 读. */
  heading: number;
}

/** 抽出所有段落 (w:p) 的纯文本 + heading 级别. */
export function extractParagraphs(documentXml: string): ParagraphInfo[] {
  const paragraphs: ParagraphInfo[] = [];
  let m: RegExpExecArray | null;
  let idx = 0;
  const re = new RegExp(W_P_RE.source, 'g');
  while ((m = re.exec(documentXml)) !== null) {
    const pXml = m[0];
    /* 抽段落内所有 w:t 拼接成纯文本 */
    const texts: string[] = [];
    let tm: RegExpExecArray | null;
    const tRe = new RegExp(W_T_RE.source, 'g');
    while ((tm = tRe.exec(pXml)) !== null) {
      texts.push(unescapeXml(tm[2] ?? ''));
    }
    const text = texts.join('');
    /* heading level: <w:pStyle w:val="Heading1"/> */
    let heading = 0;
    const hMatch = pXml.match(/<w:pStyle\s+w:val="Heading(\d)"\s*\/>/);
    if (hMatch) heading = Number(hMatch[1]);
    paragraphs.push({ index: idx++, text, heading });
  }
  return paragraphs;
}

/** 统计 — 段落/字数(西文 word 边界 + 中文逐字)/图片/表格. */
export function describeDocx(documentXml: string): {
  paragraphs: number;
  headings: number;
  characters: number;
  words_estimate: number;
  images: number;
  tables: number;
} {
  const paragraphs = extractParagraphs(documentXml);
  const allText = paragraphs.map(p => p.text).join('\n');
  /* 字符数 (含中英) — 不算 whitespace */
  const characters = allText.replace(/\s/g, '').length;
  /* 词数估算: 中文逐字 + 英文按 \b\w+\b */
  const enWords = (allText.match(/\b[\w-]+\b/g) ?? []).length;
  const cnChars = (allText.match(/[一-鿿]/g) ?? []).length;
  const words_estimate = enWords + cnChars;
  /* image: <w:drawing> 或 <w:pict>; table: <w:tbl> */
  const images = (documentXml.match(/<w:drawing\b/g) ?? []).length
               + (documentXml.match(/<w:pict\b/g) ?? []).length;
  const tables = (documentXml.match(/<w:tbl\b/g) ?? []).length;
  const headings = paragraphs.filter(p => p.heading > 0).length;
  return { paragraphs: paragraphs.length, headings, characters, words_estimate, images, tables };
}

/** 全局文本替换 — 对每个 <w:t> 内部独立做 substring replace.
 *  注: 长字符串可能跨 run 找不到 (Word 切 run 时按格式断), 由 agent 用更短的关键词重试.
 *  返替换次数. */
export function replaceTextEverywhere(documentXml: string, find: string, replace: string): { newXml: string; count: number } {
  if (!find) return { newXml: documentXml, count: 0 };
  let count = 0;
  const findEscaped = escapeXml(find);
  const replaceEscaped = escapeXml(replace);
  const newXml = documentXml.replace(W_T_RE, (full, attrs, body) => {
    if (!body || body.indexOf(findEscaped) < 0) return full;
    /* split + join 累加次数 */
    const parts = body.split(findEscaped);
    if (parts.length <= 1) return full;
    count += parts.length - 1;
    const newBody = parts.join(replaceEscaped);
    return `<w:t${attrs ?? ''}>${newBody}</w:t>`;
  });
  return { newXml, count };
}

/** Replace one paragraph's text while preserving paragraph properties and the first
 * run's character properties. Mixed run formatting is normalized to that first style. */
export function replaceParagraphText(documentXml: string, paragraphIndex: number, newText: string): { newXml: string; replaced: boolean } {
  let idx = 0;
  let replaced = false;
  const newXml = documentXml.replace(W_P_RE, (pXml) => {
    if (idx++ !== paragraphIndex) return pXml;
    replaced = true;
    /* 抽出 w:pPr (含段落格式), 删掉所有 w:r, 新塞一个 w:r + w:t */
    const pPrMatch = pXml.match(/<w:pPr>[\s\S]*?<\/w:pPr>/);
    const pPr = pPrMatch ? pPrMatch[0] : '';
    /* 5.10: 抽第一个 run 的 rPr 复用 — 保段落基础格式 (粗体/斜体/字体/颜色 等). */
    const firstRPrMatch = pXml.match(/<w:r\b[^>]*>\s*<w:rPr>([\s\S]*?)<\/w:rPr>/);
    const rPrXml = firstRPrMatch ? `<w:rPr>${firstRPrMatch[1]}</w:rPr>` : '';
    /* xml:space="preserve" 保留前后空格 */
    const newRun = `<w:r>${rPrXml}<w:t xml:space="preserve">${escapeXml(newText)}</w:t></w:r>`;
    /* p 开标签 + pPr + new run + 闭标签 */
    const openMatch = pXml.match(/^<w:p\b[^>]*>/);
    const open = openMatch ? openMatch[0] : '<w:p>';
    return `${open}${pPr}${newRun}</w:p>`;
  });
  return { newXml, replaced };
}

/** 在第 afterIndex 段之后插入新段落 (普通文本, 无样式).
 *  afterIndex = -1 时插到最前; afterIndex >= paragraphs.length-1 时追加到最后. */
export function insertParagraphAfter(documentXml: string, afterIndex: number, newText: string): { newXml: string; inserted: boolean } {
  const newParaXml = `<w:p><w:r><w:t xml:space="preserve">${escapeXml(newText)}</w:t></w:r></w:p>`;
  let idx = 0;
  let inserted = false;
  /* afterIndex = -1: 在第一个 w:p 之前插 */
  if (afterIndex < 0) {
    const newXml = documentXml.replace(W_P_RE, (pXml) => {
      if (inserted) return pXml;
      inserted = true;
      return `${newParaXml}${pXml}`;
    });
    return { newXml, inserted };
  }
  const newXml = documentXml.replace(W_P_RE, (pXml) => {
    if (idx++ === afterIndex) {
      inserted = true;
      return `${pXml}${newParaXml}`;
    }
    return pXml;
  });
  /* afterIndex 超出范围 — 追加到 body 闭合前 */
  if (!inserted) {
    const bodyClose = newXml.lastIndexOf('</w:body>');
    if (bodyClose >= 0) {
      return {
        newXml: newXml.slice(0, bodyClose) + newParaXml + newXml.slice(bodyClose),
        inserted: true,
      };
    }
  }
  return { newXml, inserted };
}

/* ═══════════════════════ Word 表格操作 ═══════════════════════
 * Word 表格 XML 结构:
 *   <w:tbl>                  表格容器
 *     <w:tblPr>...</w:tblPr> 表格属性 (边框 / 宽度 / 对齐)
 *     <w:tblGrid>...</w:tblGrid> 列宽
 *     <w:tr>                 行
 *       <w:trPr>...</w:trPr>  行属性
 *       <w:tc>               单元格
 *         <w:tcPr>...</w:tcPr> 单元格属性 (宽度 / 底色 / 边框 / 对齐)
 *         <w:p>...</w:p>     段落 (text 在这里)
 *       </w:tc>
 *     </w:tr>
 *   </w:tbl>
 *
 * 嵌套表格 (表里有表) MVP 不支持 — 用 non-greedy regex 抓最外层即可应付 90% 场景.
 */

/* w:tbl 配上 non-greedy + 跟踪嵌套深度比较麻烦, 用 simple 非嵌套 regex MVP. */
const W_TBL_RE = /<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>/g;
const W_TR_RE = /<w:tr\b[^>]*>[\s\S]*?<\/w:tr>/g;
const W_TC_RE = /<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g;

export interface TableSummary {
  index: number;
  rows: number;
  cols: number;
}

/** 扫描所有表格, 返每个 {index, rows, cols}. */
export function extractTables(documentXml: string): TableSummary[] {
  const tables: TableSummary[] = [];
  const tblMatches = documentXml.match(W_TBL_RE) ?? [];
  for (let i = 0; i < tblMatches.length; i++) {
    const tblXml = tblMatches[i];
    const trMatches = tblXml.match(W_TR_RE) ?? [];
    const rows = trMatches.length;
    /* 列数取第一行 tc 个数 (假设规则矩阵) */
    let cols = 0;
    const firstRow = trMatches[0];
    if (firstRow) {
      const tcMatches = firstRow.match(W_TC_RE) ?? [];
      cols = tcMatches.length;
    }
    tables.push({ index: i, rows, cols });
  }
  return tables;
}

/** 拿单元格里的纯文本 — 把所有 w:t 拼接. */
function extractCellText(tcXml: string): string {
  const tRe = new RegExp(W_T_RE.source, 'g');
  const parts: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = tRe.exec(tcXml)) !== null) {
    parts.push(unescapeXml(m[2] ?? ''));
  }
  return parts.join('');
}

/** 拿一个表的完整 2D 内容. */
export function extractTableContent(documentXml: string, tableIndex: number): string[][] | null {
  const tblMatches = documentXml.match(W_TBL_RE) ?? [];
  const tblXml = tblMatches[tableIndex];
  if (!tblXml) return null;
  const trMatches = tblXml.match(W_TR_RE) ?? [];
  const out: string[][] = [];
  for (const trXml of trMatches) {
    const tcMatches = trXml.match(W_TC_RE) ?? [];
    out.push(tcMatches.map(extractCellText));
  }
  return out;
}

/** 单元格样式 — agent 工具暴露的最小子集. */
export interface CellStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** 字体色, hex 不带 # (如 "FF0000") */
  color?: string;
  /** 单元格底色, hex 不带 # (如 "DDDDDD") */
  bgColor?: string;
  /** 字号 pt (转 half-point 内部存 *2). 12 = 12pt */
  fontSize?: number;
  /** 段落对齐 */
  align?: 'left' | 'center' | 'right' | 'justify';
}

/** style → w:rPr 内 XML (字体级样式) */
function buildRunProps(style: CellStyle | undefined): string {
  if (!style) return '';
  const parts: string[] = [];
  if (style.bold) parts.push('<w:b/>');
  if (style.italic) parts.push('<w:i/>');
  if (style.underline) parts.push('<w:u w:val="single"/>');
  if (style.color) parts.push(`<w:color w:val="${style.color.replace(/^#/, '')}"/>`);
  if (style.fontSize) parts.push(`<w:sz w:val="${Math.round(style.fontSize * 2)}"/>`);
  if (parts.length === 0) return '';
  return `<w:rPr>${parts.join('')}</w:rPr>`;
}

/** style → w:pPr 内 XML (段落级 align) */
function buildParaProps(style: CellStyle | undefined): string {
  if (!style?.align) return '';
  return `<w:pPr><w:jc w:val="${style.align}"/></w:pPr>`;
}

/** style.bgColor → 注入到 tcPr 的 w:shd. 已存在 shd 则替换. */
function injectCellBgColor(tcXml: string, bgColor: string | undefined): string {
  if (!bgColor) return tcXml;
  const shd = `<w:shd w:val="clear" w:color="auto" w:fill="${bgColor.replace(/^#/, '')}"/>`;
  /* 已有 w:shd → 替换; 没有 → 注入到 tcPr 末 */
  if (/<w:shd\b[^>]*\/>/.test(tcXml)) {
    return tcXml.replace(/<w:shd\b[^>]*\/>/, shd);
  }
  /* 有 tcPr → 注入末; 没 tcPr → 创建 */
  if (/<w:tcPr>[\s\S]*?<\/w:tcPr>/.test(tcXml)) {
    return tcXml.replace(/<\/w:tcPr>/, `${shd}</w:tcPr>`);
  }
  /* 没 tcPr — 在 w:tc 开标签后塞 */
  return tcXml.replace(/^(<w:tc\b[^>]*>)/, `$1<w:tcPr>${shd}</w:tcPr>`);
}

/** 改单元格内容 (+ 样式). 保留 tcPr 其他属性, 整段 p 内容替换. */
export function setTableCell(
  documentXml: string,
  tableIndex: number,
  row: number,
  col: number,
  text: string,
  style?: CellStyle,
): { newXml: string; changed: boolean } {
  let tblIdx = 0;
  let changed = false;
  const newXml = documentXml.replace(W_TBL_RE, (tblXml) => {
    if (tblIdx++ !== tableIndex) return tblXml;
    /* 进表 — 找第 row 行 */
    let trIdx = 0;
    const newTbl = tblXml.replace(W_TR_RE, (trXml) => {
      if (trIdx++ !== row) return trXml;
      /* 进行 — 找第 col 单元格 */
      let tcIdx = 0;
      const newTr = trXml.replace(W_TC_RE, (tcXml) => {
        if (tcIdx++ !== col) return tcXml;
        /* 1) 先处理 bgColor (改 tcPr) */
        let nextTc = injectCellBgColor(tcXml, style?.bgColor);
        /* 2) 抽出 tcPr (保留) — 没 tcPr 也行 */
        const tcPrMatch = nextTc.match(/<w:tcPr>[\s\S]*?<\/w:tcPr>/);
        const tcPr = tcPrMatch ? tcPrMatch[0] : '';
        /* 3) 构造新段落: pPr (对齐) + r (rPr 样式 + t 文本) */
        const rPr = buildRunProps(style);
        const pPr = buildParaProps(style);
        const newPara = `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
        /* 4) 重组: tc 开标签 + tcPr + 新 para + tc 闭标签 */
        changed = true;
        const openMatch = nextTc.match(/^<w:tc\b[^>]*>/);
        const open = openMatch ? openMatch[0] : '<w:tc>';
        return `${open}${tcPr}${newPara}</w:tc>`;
      });
      return newTr;
    });
    return newTbl;
  });
  return { newXml, changed };
}

/** 删除第 index 段. */
export function deleteParagraph(documentXml: string, paragraphIndex: number): { newXml: string; deleted: boolean } {
  let idx = 0;
  let deleted = false;
  const newXml = documentXml.replace(W_P_RE, (pXml) => {
    if (idx++ === paragraphIndex) {
      deleted = true;
      return '';
    }
    return pXml;
  });
  return { newXml, deleted };
}
