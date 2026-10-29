
export type WordPresetId =
  | 'report' | 'gov' | 'lesson' | 'exam' | 'academic' | 'contract' | 'notice' | 'resume' | 'business';

interface Font { ea: string; latin: string }
interface Lvl { font: Font; size: number; bold?: boolean; align?: 'center' | 'left'; indentChars?: number; color?: string; before?: number; after?: number; border?: boolean }

export interface WordPreset {
  id: WordPresetId;
  label: string;
  /** 页边距 twip: 上 右 下 左 */
  margin: [number, number, number, number];
  title: Lvl;
  h1: Lvl; h2: Lvl; h3: Lvl;
  body: Lvl & { line: number; lineRule: 'auto' | 'exact'; after?: number };
  /** 页码样式 */
  pageNum: 'center-of' | 'gov-outer' | 'page-of-right' | 'dash-center' | 'none';
  tableHeadFill: string;
  tableFontSize: number;
  /** 是否默认带目录 (调用方 toc 参数优先) */
  toc?: boolean;
}

const SONG: Font = { ea: '宋体', latin: 'Times New Roman' };
const HEI: Font = { ea: '黑体', latin: 'Times New Roman' };
const KAI: Font = { ea: '楷体', latin: 'Times New Roman' };
const FANG: Font = { ea: '仿宋_GB2312', latin: 'Times New Roman' };
const XBS: Font = { ea: '方正小标宋简体', latin: 'Times New Roman' };
const YAHEI: Font = { ea: '微软雅黑', latin: 'Arial' };
const CALIBRI: Font = { ea: '微软雅黑', latin: 'Calibri' };
const CALIBRI_L: Font = { ea: '微软雅黑', latin: 'Calibri Light' };

const NORMAL_MARGIN: [number, number, number, number] = [1440, 1800, 1440, 1800];

export const WORD_PRESETS: Record<WordPresetId, WordPreset> = {
  /* 通用: 工作报告 / 方案 / 总结 / 周报 / 手册 / 说明书 */
  report: {
    id: 'report', label: '通用报告', margin: NORMAL_MARGIN,
    title: { font: HEI, size: 44, bold: true, align: 'center', after: 240 },
    h1: { font: HEI, size: 32, before: 360, after: 160 },
    h2: { font: KAI, size: 28, bold: true, before: 240, after: 120 },
    h3: { font: SONG, size: 24, bold: true, before: 160, after: 80 },
    body: { font: SONG, size: 24, line: 360, lineRule: 'auto', indentChars: 2, after: 0 },
    pageNum: 'center-of', tableHeadFill: 'DCE6F2', tableFontSize: 21,
  },
  /* 党政机关公文 GB/T 9704-2012: 通知 / 请示 / 报告 / 函 / 纪要 —— 版心 156×225mm, 每页 22 行每行 28 字 */
  gov: {
    id: 'gov', label: '党政公文', margin: [2098, 1474, 1984, 1588],
    title: { font: XBS, size: 44, align: 'center', after: 560 },
    h1: { font: HEI, size: 32, indentChars: 2 },
    h2: { font: KAI, size: 32, indentChars: 2 },
    h3: { font: FANG, size: 32, bold: true, indentChars: 2 },
    body: { font: FANG, size: 32, line: 579, lineRule: 'exact', indentChars: 2, after: 0 },
    pageNum: 'gov-outer', tableHeadFill: 'F2F2F2', tableFontSize: 24,
  },
  /* 教案 / 教学设计 / 说课稿 / 听课记录 / 班会方案 */
  lesson: {
    id: 'lesson', label: '教案', margin: NORMAL_MARGIN,
    title: { font: HEI, size: 36, bold: true, align: 'center', after: 240 },
    h1: { font: HEI, size: 28, before: 280, after: 120 },
    h2: { font: SONG, size: 24, bold: true, before: 160, after: 80 },
    h3: { font: KAI, size: 24, before: 120, after: 60 },
    body: { font: SONG, size: 24, line: 360, lineRule: 'auto', indentChars: 2, after: 0 },
    pageNum: 'center-of', tableHeadFill: 'E2EFDA', tableFontSize: 21,
  },
  /* 试卷 / 练习 / 学案 / 作业单 —— 字小、行紧、题号不缩进 */
  exam: {
    id: 'exam', label: '试卷', margin: [1134, 1134, 1134, 1134],
    title: { font: HEI, size: 36, bold: true, align: 'center', after: 120 },
    h1: { font: HEI, size: 24, before: 200, after: 80 },
    h2: { font: SONG, size: 21, bold: true, before: 100, after: 40 },
    h3: { font: SONG, size: 21, bold: true },
    body: { font: SONG, size: 21, line: 300, lineRule: 'auto', indentChars: 0, after: 40 },
    pageNum: 'center-of', tableHeadFill: 'F2F2F2', tableFontSize: 21,
  },
  /* 论文 / 课题报告 / 开题报告 / 调研报告 (学术) */
  academic: {
    id: 'academic', label: '论文', margin: [1440, 1440, 1440, 1700],
    title: { font: HEI, size: 36, bold: true, align: 'center', after: 360 },
    h1: { font: HEI, size: 30, before: 360, after: 200 },
    h2: { font: HEI, size: 28, before: 240, after: 120 },
    h3: { font: HEI, size: 24, before: 160, after: 80 },
    body: { font: SONG, size: 24, line: 400, lineRule: 'exact', indentChars: 2, after: 0 },
    pageNum: 'dash-center', tableHeadFill: 'F2F2F2', tableFontSize: 21, toc: true,
  },
  /* 合同 / 协议 / 章程 / 制度 —— 条款式 */
  contract: {
    id: 'contract', label: '合同', margin: NORMAL_MARGIN,
    title: { font: HEI, size: 44, bold: true, align: 'center', after: 360 },
    h1: { font: HEI, size: 24, before: 200, after: 80 },
    h2: { font: SONG, size: 24, bold: true, before: 120, after: 60 },
    h3: { font: SONG, size: 24, bold: true },
    body: { font: SONG, size: 24, line: 360, lineRule: 'auto', indentChars: 2, after: 0 },
    pageNum: 'center-of', tableHeadFill: 'F2F2F2', tableFontSize: 24,
  },
  /* 通知 / 邀请函 / 倡议书 / 申请书 / 证明 / 感谢信 —— 单页信函, 落款靠右 */
  notice: {
    id: 'notice', label: '通知信函', margin: [1700, 1600, 1700, 1600],
    title: { font: HEI, size: 40, bold: true, align: 'center', after: 400 },
    h1: { font: HEI, size: 28, before: 200, after: 100 },
    h2: { font: SONG, size: 28, bold: true },
    h3: { font: SONG, size: 28, bold: true },
    body: { font: SONG, size: 28, line: 440, lineRule: 'exact', indentChars: 2, after: 0 },
    pageNum: 'none', tableHeadFill: 'F2F2F2', tableFontSize: 24,
  },
  /* 简历 —— 紧凑、无缩进、分区标题带下划线 */
  resume: {
    id: 'resume', label: '简历', margin: [900, 1000, 900, 1000],
    title: { font: YAHEI, size: 44, bold: true, align: 'left', after: 60 },
    h1: { font: YAHEI, size: 24, bold: true, color: '1F4E79', before: 200, after: 80, border: true },
    h2: { font: YAHEI, size: 21, bold: true, before: 80, after: 20 },
    h3: { font: YAHEI, size: 21, bold: true },
    body: { font: YAHEI, size: 19, line: 288, lineRule: 'auto', indentChars: 0, after: 20 },
    pageNum: 'none', tableHeadFill: 'DEEAF6', tableFontSize: 19,
  },
  /* 海外 / 英文: business report, memo, proposal, cover letter */
  business: {
    id: 'business', label: 'Business (EN)', margin: [1440, 1440, 1440, 1440],
    title: { font: CALIBRI_L, size: 52, align: 'left', color: '1F3864', after: 200 },
    h1: { font: CALIBRI_L, size: 32, color: '2F5496', before: 360, after: 120 },
    h2: { font: CALIBRI_L, size: 26, color: '2F5496', before: 240, after: 80 },
    h3: { font: CALIBRI, size: 24, bold: true, color: '1F3864', before: 160, after: 60 },
    body: { font: CALIBRI, size: 22, line: 276, lineRule: 'auto', indentChars: 0, after: 160 },
    pageNum: 'page-of-right', tableHeadFill: 'D9E2F3', tableFontSize: 20,
  },
};

export const PRESET_IDS = Object.keys(WORD_PRESETS) as WordPresetId[];

export function resolvePreset(id: string | undefined): WordPreset {
  return WORD_PRESETS[(id ?? '') as WordPresetId] ?? WORD_PRESETS.report;
}

/* ───────────── 部件 ───────────── */

const rFonts = (f: Font) => `<w:rFonts w:ascii="${f.latin}" w:hAnsi="${f.latin}" w:eastAsia="${f.ea}" w:cs="${f.latin}"/>`;
const indentTw = (chars: number | undefined, size: number) => (chars ? Math.round(chars * size * 10) : 0);

function rPrOf(l: Lvl): string {
  return `<w:rPr>${rFonts(l.font)}${l.bold ? '<w:b/><w:bCs/>' : ''}${l.color ? `<w:color w:val="${l.color}"/>` : ''}<w:sz w:val="${l.size}"/><w:szCs w:val="${l.size}"/></w:rPr>`;
}
/** 段落属性, 子元素按 OOXML 顺序: keepNext keepLines pBdr spacing ind jc outlineLvl。
 *  缩进总是显式写 (0 也写) —— 不写就继承 Normal 的首行缩进, 标题会跟着缩两字。 */
function pPrOf(l: Lvl, o: { keep?: boolean; line?: string; outline?: number } = {}): string {
  const border = l.border ? '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="2" w:color="9DB2CF"/></w:pBdr>' : '';
  return `<w:pPr>${o.keep ? '<w:keepNext/><w:keepLines/>' : ''}${border}<w:spacing w:before="${l.before ?? 0}" w:after="${l.after ?? 0}"${o.line ?? ''}/><w:ind w:firstLine="${indentTw(l.indentChars, l.size)}"/>${l.align ? `<w:jc w:val="${l.align}"/>` : ''}${o.outline !== undefined ? `<w:outlineLvl w:val="${o.outline}"/>` : ''}</w:pPr>`;
}

export function buildStylesXml(p: WordPreset): string {
  const b = p.body;
  const bodyInd = b.indentChars ? `<w:ind w:firstLine="${indentTw(b.indentChars, b.size)}"/>` : '';
  /* 公文正文是固定行距, 标题字号跟正文一样大时沿用; 比正文大的 (大标题) 改回单倍, 不然字被裁掉一截 */
  const lineFor = (l: Lvl) => (b.lineRule === 'exact' && l.size <= b.size ? ` w:line="${b.line}" w:lineRule="exact"` : ' w:line="240" w:lineRule="auto"');
  const heading = (id: string, name: string, l: Lvl, lvl: number) =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>${pPrOf(l, { keep: true, line: lineFor(l), outline: lvl })}${rPrOf(l)}</w:style>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>${rFonts(b.font)}<w:sz w:val="${b.size}"/><w:szCs w:val="${b.size}"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="${b.after ?? 0}" w:line="${b.line}" w:lineRule="${b.lineRule}"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:jc w:val="both"/>${bodyInd}</w:pPr>${rPrOf(b)}</w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>${pPrOf(p.title, { line: lineFor(p.title) })}${rPrOf(p.title)}</w:style>
${heading('Heading1', 'heading 1', p.h1, 0)}
${heading('Heading2', 'heading 2', p.h2, 1)}
${heading('Heading3', 'heading 3', p.h3, 2)}
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="${b.indentChars ? indentTw(2, b.size) + 240 : 420}" w:hanging="240" w:firstLine="0"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="BFBFBF"/></w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="F7F7F7"/><w:ind w:left="240" w:right="240" w:firstLine="0"/><w:spacing w:before="120" w:after="120"/></w:pPr><w:rPr><w:color w:val="595959"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="TOCHeading"><w:name w:val="TOC Heading"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:ind w:firstLine="0"/><w:spacing w:before="240" w:after="240"/></w:pPr><w:rPr>${rFonts(p.h1.font)}<w:b/><w:sz w:val="${p.h1.size}"/></w:rPr></w:style>
${[1, 2, 3].map((n) => `<w:style w:type="paragraph" w:styleId="TOC${n}"><w:name w:val="toc ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="${textWidth(p)}"/></w:tabs><w:spacing w:after="60"/><w:ind w:left="${(n - 1) * 420}" w:firstLine="0"/></w:pPr></w:style>`).join('\n')}
<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:firstLine="0"/><w:spacing w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="18"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Header"><w:name w:val="header"/><w:basedOn w:val="Normal"/><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="1" w:color="A6A6A6"/></w:pBdr><w:jc w:val="right"/><w:ind w:firstLine="0"/><w:spacing w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:color w:val="7F7F7F"/><w:sz w:val="18"/></w:rPr></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;
}

/** 项目符号 (•) 一个列表定义, numId=1 */
export function buildNumberingXml(p: WordPreset): string {
  const left = p.body.indentChars ? indentTw(2, p.body.size) + 240 : 420;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${left}" w:hanging="240"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/></w:rPr></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;
}

export function buildSettingsXml(opts: { updateFields: boolean; evenOdd: boolean }): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${opts.updateFields ? '<w:updateFields w:val="true"/>' : ''}${opts.evenOdd ? '<w:evenAndOddHeaders/>' : ''}<w:defaultTabStop w:val="420"/><w:characterSpacingControl w:val="compressPunctuation"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;
}

const FLD = (instr: string, rPr: string) =>
  `<w:r>${rPr}<w:fldChar w:fldCharType="begin"/></w:r><w:r>${rPr}<w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r><w:r>${rPr}<w:fldChar w:fldCharType="separate"/></w:r><w:r>${rPr}<w:t>1</w:t></w:r><w:r>${rPr}<w:fldChar w:fldCharType="end"/></w:r>`;
const T = (s: string, rPr: string) => `<w:r>${rPr}<w:t xml:space="preserve">${s}</w:t></w:r>`;
const FTR_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** 页脚: 返回 { default, even? } 两份 footer XML (公文单页靠右、双页靠左) */
export function buildFooters(p: WordPreset): { main: string; even?: string } | null {
  const ftr = (jc: string, inner: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${FTR_NS}><w:p><w:pPr><w:pStyle w:val="Footer"/><w:jc w:val="${jc}"/></w:pPr>${inner}</w:p></w:ftr>`;
  const r = '<w:rPr><w:sz w:val="18"/></w:rPr>';
  switch (p.pageNum) {
    case 'none': return null;
    case 'center-of': return { main: ftr('center', `${T('第 ', r)}${FLD('PAGE', r)}${T(' 页 共 ', r)}${FLD('NUMPAGES', r)}${T(' 页', r)}`) };
    case 'dash-center': return { main: ftr('center', `${T('— ', r)}${FLD('PAGE', r)}${T(' —', r)}`) };
    case 'page-of-right': return { main: ftr('right', `${T('Page ', r)}${FLD('PAGE', r)}${T(' of ', r)}${FLD('NUMPAGES', r)}`) };
    case 'gov-outer': {
      /* GB/T 9704: 4 号半角宋体阿拉伯数字, 两边一字线, 单页居右空一字, 双页居左空一字 */
      const g = '<w:rPr><w:rFonts w:ascii="宋体" w:hAnsi="宋体" w:eastAsia="宋体"/><w:sz w:val="28"/></w:rPr>';
      const num = `${T('— ', g)}${FLD('PAGE', g)}${T(' —', g)}`;
      const side = (jc: string, ind: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${FTR_NS}><w:p><w:pPr><w:pStyle w:val="Footer"/><w:jc w:val="${jc}"/><w:ind ${ind}/></w:pPr>${num}</w:p></w:ftr>`;
      return { main: side('right', 'w:right="320"'), even: side('left', 'w:left="320"') };
    }
  }
}

export function buildHeaderXml(text: string, esc: (s: string) => string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${FTR_NS}><w:p><w:pPr><w:pStyle w:val="Header"/></w:pPr><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p></w:hdr>`;
}

/** 版心宽 (twip): A4 宽 11906 - 左右边距 */
export function textWidth(p: WordPreset): number {
  return 11906 - p.margin[1] - p.margin[3];
}

export function sectPrXml(p: WordPreset, refs: { footer?: string; footerEven?: string; header?: string }): string {
  const [top, right, bottom, left] = p.margin;
  const refsXml = [
    refs.header ? `<w:headerReference w:type="default" r:id="${refs.header}"/>` : '',
    refs.footer ? `<w:footerReference w:type="default" r:id="${refs.footer}"/>` : '',
    refs.footerEven ? `<w:footerReference w:type="even" r:id="${refs.footerEven}"/>` : '',
  ].join('');
  /* 公文: 每页 22 行 (docGrid linePitch = 579)。其它版式不要网格 —— 行会吸附到网格, 1.5 倍行距看着像双倍 */
  const grid = p.id === 'gov' ? '<w:docGrid w:type="lines" w:linePitch="579" w:charSpace="0"/>' : '';
  return `<w:sectPr>${refsXml}<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="${top}" w:right="${right}" w:bottom="${bottom}" w:left="${left}" w:header="851" w:footer="992" w:gutter="0"/>${grid}</w:sectPr>`;
}

/** 目录: 真 TOC 域 (Word / WPS 打开时按 settings.updateFields 刷新页码), 先放好条目, 预览里就能看到 */
export function buildTocXml(headings: Array<{ level: number; text: string; anchor: string }>, esc: (s: string) => string, zh: boolean): string {
  if (!headings.length) return '';
  const head = `<w:p><w:pPr><w:pStyle w:val="TOCHeading"/></w:pPr><w:r><w:t>${zh ? '目　录' : 'Contents'}</w:t></w:r></w:p>`;
  const items = headings.map((h, i) => {
    const begin = i === 0 ? '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>' : '';
    /* 先放的条目不带页码和点线 (页码要排版后才知道); Word 打开按 updateFields 刷新成带点线和页码的真目录 */
    return `<w:p><w:pPr><w:pStyle w:val="TOC${h.level}"/></w:pPr>${begin}<w:hyperlink w:anchor="${h.anchor}" w:history="1"><w:r><w:t xml:space="preserve">${esc(h.text)}</w:t></w:r></w:hyperlink></w:p>`;
  }).join('');
  const end = '<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>';
  return head + items + end;
}

/** 给 word_create 工具说明用的一行一个版式 */
export const PRESET_HELP = [
  'report — 通用报告 / 方案 / 总结 / 周报 / 手册 (黑体标题, 宋体小四, 1.5 倍行距, 首行缩进)',
  'gov — 党政公文 GB/T 9704 (小标宋标题, 仿宋三号正文, 一级黑体「一、」二级楷体「（一）」, 每页 22 行)',
  'lesson — 教案 / 教学设计 / 说课稿 / 班会方案',
  'exam — 试卷 / 练习 / 作业单 (五号字, 行紧, 不缩进)',
  'academic — 论文 / 开题报告 / 课题报告 (默认带目录)',
  'contract — 合同 / 协议 / 制度 (条款式)',
  'notice — 通知 / 邀请函 / 申请书 / 证明 / 感谢信 (单页信函, 落款用 [right])',
  'resume — 简历 (紧凑, 分区标题带下划线)',
  'business — English business report / memo / proposal / cover letter',
].join('\n');
