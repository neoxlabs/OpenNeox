/**
 * xlsxInspect — 交付前查 .xlsx 的结构性毛病 (work O-22)。
 *
 * 只查「打开就是坏」的那几类, 不做业务判断:
 *   1. error_value  — 格子里是 #REF! / #VALUE! / #DIV/0! ... ; 公式本身带 #REF! (删行删列之后的典型产物)
 *   2. empty_sheet  — 整本表没有任何内容 (error), 或者多 sheet 里某张 sheet 是空的 (warn)
 *   3. missing_image— 图片引用了包里不存在的零件, 或者外链图片的文件已经不在了
 *   4. broken_link  — 超链接 / 外部链接指向的文件不存在, 或内部跳转的 sheet 不存在
 *   5. missing_part — 包里该有的零件缺了 (worksheet / drawing)
 *
 * 为什么用 OOXML 而不是 SheetJS: 这四类毛病都在包结构上, 而且 SheetJS 社区版读不了
 * 外部链接与 drawing 关系表。包结构这一层我们已经有 listSheets / readSharedStrings 那套工具。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { listSheets, unescapeXml } from './sheetOoxml.js';
import {
  finalizeReport,
  isLocalLinkTarget,
  parseRelationships,
  resolvePartPath,
  type OfficeInspectReport,
  type OfficeIssue,
} from '../delivery/officeInspectTypes.js';

/** Excel 的七种错误值 + 新版动态数组的两种。 */
const ERROR_CODES = new Set(['#REF!', '#VALUE!', '#DIV/0!', '#N/A', '#NAME?', '#NUM!', '#NULL!', '#SPILL!', '#CALC!']);

const CELL_RE = /<c\b([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g;

function attrsOf(tagOpen: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tagOpen.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

interface SheetScan {
  cellCount: number;
  /** 有内容的格 (值 / 内联文本 / 公式) */
  contentCount: number;
  errors: Array<{ ref: string; code: string }>;
  formulaErrors: Array<{ ref: string; formula: string }>;
}

function scanSheet(sheetXml: string): SheetScan {
  const scan: SheetScan = { cellCount: 0, contentCount: 0, errors: [], formulaErrors: [] };
  const sdOpen = /<sheetData\b[^>]*>/.exec(sheetXml);
  const sdClose = sheetXml.indexOf('</sheetData>');
  if (!sdOpen || sdClose < 0) return scan;
  const body = sheetXml.slice(sdOpen.index + sdOpen[0].length, sdClose);

  CELL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CELL_RE.exec(body))) {
    scan.cellCount++;
    const attrs = attrsOf(`<c ${m[1]}>`);
    const ref = attrs.r ?? '?';
    const cellBody = m[2] === '/>' ? '' : (m[3] ?? '');
    const formula = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(cellBody)?.[1];
    const value = /<v>([\s\S]*?)<\/v>/.exec(cellBody)?.[1];

    if (attrs.t === 'e') {
      const code = unescapeXml(value ?? '').trim();
      scan.errors.push({ ref, code: code || '#ERR' });
      continue;
    }
    if (formula !== undefined && /#REF!|#VALUE!|#DIV\/0!|#NAME\?|#NUM!|#NULL!/i.test(formula)) {
      scan.formulaErrors.push({ ref, formula: unescapeXml(formula).trim() });
    }
    const inlineText = /<is>[\s\S]*?<t\b[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/.exec(cellBody)?.[1];
    const hasContent = (value !== undefined && value.trim() !== '')
      || (inlineText !== undefined && inlineText.trim() !== '')
      || formula !== undefined;
    if (hasContent) scan.contentCount++;
  }
  return scan;
}

/** 把一个 Relationship 的 Target 解成盘上的绝对路径; 非本地链接返回 null。 */
function localTargetPath(workbookDir: string, rel: { target: string; targetMode?: string }): string | null {
  if (rel.targetMode !== 'External') return null;
  if (!isLocalLinkTarget(rel.target)) return null;
  if (/^file:/i.test(rel.target)) {
    try {
      return fileURLToPath(rel.target);
    } catch {
      return null;
    }
  }
  return path.resolve(workbookDir, rel.target);
}

export async function inspectXlsxStructure(absPath: string): Promise<OfficeInspectReport> {
  const zip = await JSZip.loadAsync(fs.readFileSync(absPath));
  const wbXml = await zip.file('xl/workbook.xml')?.async('string');
  const wbRelsXml = await zip.file('xl/_rels/workbook.xml.rels')?.async('string');
  if (!wbXml || !wbRelsXml) throw new Error('不是 .xlsx (缺 xl/workbook.xml)');

  const workbookDir = path.dirname(absPath);
  const sheets = listSheets(wbXml, wbRelsXml);
  const issues: OfficeIssue[] = [];
  const stats: Record<string, number> = { sheets: sheets.length, cells: 0, images: 0 };

  if (sheets.length === 0) {
    issues.push({ severity: 'error', kind: 'missing_part', location: 'xl/workbook.xml', detail: '工作簿里一张工作表都没有' });
    return finalizeReport('xlsx', absPath, issues, stats);
  }

  /* ── 逐 sheet: 错误值 / 空页 ─────────────────────────────────────────── */
  const sheetNames = new Set(sheets.map((s) => s.name));
  const perSheetContent: Array<{ name: string; content: number }> = [];

  for (const sheet of sheets) {
    const sheetXml = await zip.file(sheet.path)?.async('string');
    if (sheetXml === undefined) {
      issues.push({
        severity: 'error', kind: 'missing_part', location: sheet.path,
        detail: `工作表「${sheet.name}」的零件不在包里 —— Excel 打开会报修复`,
      });
      perSheetContent.push({ name: sheet.name, content: 0 });
      continue;
    }
    const scan = scanSheet(sheetXml);
    stats.cells += scan.cellCount;
    perSheetContent.push({ name: sheet.name, content: scan.contentCount });

    for (const e of scan.errors.slice(0, 50)) {
      issues.push({
        severity: 'error', kind: 'error_value', location: `${sheet.name}!${e.ref}`,
        detail: `单元格是错误值 ${e.code}${ERROR_CODES.has(e.code.toUpperCase()) ? '' : ' (不认识的错误码, 也当错误值)'}`,
      });
    }
    if (scan.errors.length > 50) {
      issues.push({
        severity: 'error', kind: 'error_value', location: sheet.name,
        detail: `还有 ${scan.errors.length - 50} 个错误值格未逐条列出`,
      });
    }
    for (const f of scan.formulaErrors.slice(0, 20)) {
      issues.push({
        severity: 'error', kind: 'error_value', location: `${sheet.name}!${f.ref}`,
        detail: `公式本身已经坏了: =${f.formula}`,
      });
    }
  }

  /* 整本空白 = 空页; 多 sheet 里单独一张空 sheet 只提示 (模型目前没有删 sheet 的工具, 拦了没法修) */
  const totalContent = perSheetContent.reduce((n, s) => n + s.content, 0);
  if (totalContent === 0) {
    issues.push({
      severity: 'error', kind: 'empty_sheet', location: '整个工作簿',
      detail: `${sheets.length} 张工作表全部是空的 —— 交付出去就是一份空白表`,
    });
  } else if (sheets.length > 1) {
    for (const s of perSheetContent) {
      if (s.content === 0) {
        issues.push({
          severity: 'warn', kind: 'empty_sheet', location: s.name,
          detail: '这张 sheet 是空的 (打开工作簿时可能正好停在它上面)',
        });
      }
    }
  }

  /* ── 图片: drawing 关系表里指向的媒体零件必须真的在包里 ──────────────── */
  for (const entry of Object.keys(zip.files)) {
    if (!/^xl\/drawings\/[^/]+\.xml$/.test(entry)) continue;
    const drawingXml = await zip.file(entry)?.async('string');
    if (!drawingXml) continue;
    const relsPath = `xl/drawings/_rels/${path.posix.basename(entry)}.rels`;
    const rels = parseRelationships(await zip.file(relsPath)?.async('string'));
    const relById = new Map(rels.map((r) => [r.id, r]));

    for (const m of drawingXml.matchAll(/<(?:a:)?blip\b[^>]*>/g)) {
      const attrs = attrsOf(m[0]);
      const embed = attrs['r:embed'] ?? Object.entries(attrs).find(([k]) => /:embed$/.test(k))?.[1];
      const link = attrs['r:link'] ?? Object.entries(attrs).find(([k]) => /:link$/.test(k))?.[1];
      stats.images++;
      if (embed) {
        const rel = relById.get(embed);
        const partPath = rel ? resolvePartPath('xl/drawings', rel.target) : null;
        if (!rel || !partPath || !zip.file(partPath)) {
          issues.push({
            severity: 'error', kind: 'missing_image', location: entry,
            detail: `图片引用 r:embed="${embed}" 指向的零件${partPath ? ` ${partPath}` : ''}不在包里`,
          });
        }
      } else if (link) {
        const rel = relById.get(link);
        const abs = rel ? localTargetPath(workbookDir, rel) : null;
        if (!abs || !fs.existsSync(abs)) {
          issues.push({
            severity: 'error', kind: 'missing_image', location: entry,
            detail: `外链图片指向的文件不存在: ${abs ?? rel?.target ?? link}`,
          });
        }
      }
    }
  }

  /* ── 断链: 外部链接工作簿 / 超链接 / 内部跳转 ──────────────────────── */
  for (const entry of Object.keys(zip.files)) {
    const m = /^xl\/externalLinks\/([^/]+)\.xml$/.exec(entry);
    if (!m) continue;
    const rels = parseRelationships(await zip.file(`xl/externalLinks/_rels/${m[1]}.xml.rels`)?.async('string'));
    for (const rel of rels) {
      const abs = localTargetPath(workbookDir, rel);
      if (abs && !fs.existsSync(abs)) {
        issues.push({
          severity: 'error', kind: 'broken_link', location: entry,
          detail: `外部链接指向的工作簿不存在: ${abs}`,
        });
      }
    }
  }

  for (const sheet of sheets) {
    const sheetRelsPath = `xl/worksheets/_rels/${path.posix.basename(sheet.path)}.rels`;
    const rels = parseRelationships(await zip.file(sheetRelsPath)?.async('string'));
    for (const rel of rels) {
      if (!/\/hyperlink$/.test(rel.type)) continue;
      const abs = localTargetPath(workbookDir, rel);
      if (abs && !fs.existsSync(abs)) {
        issues.push({
          severity: 'error', kind: 'broken_link', location: sheet.name,
          detail: `超链接指向的文件不存在: ${abs}`,
        });
      }
    }
    const sheetXml = await zip.file(sheet.path)?.async('string');
    if (!sheetXml) continue;
    for (const h of sheetXml.matchAll(/<hyperlink\b[^>]*>/g)) {
      const attrs = attrsOf(h[0]);
      const location = attrs.location;
      if (!location) continue;
      const targetSheet = location.split('!')[0].replace(/^'|'$/g, '');
      if (targetSheet && !sheetNames.has(targetSheet)) {
        issues.push({
          severity: 'error', kind: 'broken_link', location: sheet.name,
          detail: `内部跳转指向不存在的工作表「${targetSheet}」(location="${location}")`,
        });
      }
    }
  }

  return finalizeReport('xlsx', absPath, issues, stats);
}
