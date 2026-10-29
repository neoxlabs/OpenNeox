/**
 * docxInspect — 交付前查 .docx 的结构性毛病 (work O-22)。
 *
 * xlsx 那边四类问题是「错误值 / 空页 / 图片缺失 / 断链」; docx 没有错误值, 所以这里查:
 *   1. blank_page     — 两个分页符之间没有任何内容 (打印出来就是一张白纸)
 *   2. empty_document — 正文完全为空 (只有样式 / 空段落)
 *   3. missing_image  — 图片关系指向的零件不在包里, 或外链图片文件已经没了
 *   4. broken_link    — 超链接指向的文件不存在, 或内部跳转锚点不存在
 *
 * 纯字符串 + 正则, 与 wordOoxml.ts 同一取舍: 覆盖 Word / WPS / Google Docs / mammoth 导出的常规结构,
 * 认不出的结构跳过, 不猜。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import {
  finalizeReport,
  isLocalLinkTarget,
  parseRelationships,
  resolvePartPath,
  type OfficeInspectReport,
  type OfficeIssue,
} from '../delivery/officeInspectTypes.js';

function attrsOf(tagOpen: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tagOpen.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

const PAGE_BREAK_RE = /<w:br\b[^>]*\bw:type="page"[^>]*\/>/g;
const VISUAL_RE = /<w:drawing\b|<w:pict\b|<w:tbl\b|<w:object\b|<mc:AlternateContent\b/;

/** 这一段里有没有肉眼可见的内容 (文字 / 图 / 表)。 */
function hasVisibleContent(segment: string): boolean {
  if (VISUAL_RE.test(segment)) return true;
  for (const m of segment.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)) {
    if (m[1].replace(/&[a-z#0-9]+;/gi, 'x').trim()) return true;
  }
  return false;
}

function localTargetPath(docDir: string, rel: { target: string; targetMode?: string }): string | null {
  if (rel.targetMode !== 'External') return null;
  if (!isLocalLinkTarget(rel.target)) return null;
  if (/^file:/i.test(rel.target)) {
    try {
      return fileURLToPath(rel.target);
    } catch {
      return null;
    }
  }
  return path.resolve(docDir, rel.target);
}

/** 包内所有带图片 / 超链接的正文零件: document.xml 以及 header / footer。 */
function bodyPartsOf(zip: JSZip): string[] {
  return Object.keys(zip.files).filter((p) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(p));
}

export async function inspectDocxStructure(absPath: string): Promise<OfficeInspectReport> {
  const zip = await JSZip.loadAsync(fs.readFileSync(absPath));
  const docXml = await zip.file('word/document.xml')?.async('string');
  if (docXml === undefined) throw new Error('不是 .docx (缺 word/document.xml)');

  const docDir = path.dirname(absPath);
  const issues: OfficeIssue[] = [];
  const stats: Record<string, number> = { images: 0, pageBreaks: 0, paragraphs: 0 };

  /* ── 空页 / 空文档 ──────────────────────────────────────────────────── */
  const bodyMatch = /<w:body>([\s\S]*)<\/w:body>/.exec(docXml);
  const body = bodyMatch ? bodyMatch[1] : docXml;
  stats.paragraphs = [...body.matchAll(/<w:p\b[^>]*>/g)].length;

  const segments: string[] = [];
  let cursor = 0;
  PAGE_BREAK_RE.lastIndex = 0;
  let pb: RegExpExecArray | null;
  while ((pb = PAGE_BREAK_RE.exec(body))) {
    segments.push(body.slice(cursor, pb.index));
    cursor = pb.index + pb[0].length;
    stats.pageBreaks++;
  }
  segments.push(body.slice(cursor));

  if (!hasVisibleContent(body)) {
    issues.push({
      severity: 'error', kind: 'empty_document', location: 'word/document.xml',
      detail: '正文没有任何文字、表格或图片 —— 交付出去就是一份空白文档',
    });
  } else {
    for (let i = 0; i < segments.length - 1; i++) {
      if (!hasVisibleContent(segments[i])) {
        issues.push({
          severity: 'error', kind: 'blank_page', location: `第 ${i + 1} 页`,
          detail: '这一页在两处分页符之间没有任何内容, 打印/导出 PDF 时会是一张白纸',
        });
      }
    }
  }

  /* ── 图片 / 超链接: 逐零件查关系表 ─────────────────────────────────── */
  for (const partPath of bodyPartsOf(zip)) {
    const partXml = await zip.file(partPath)?.async('string');
    if (partXml === undefined) continue;
    const partDir = path.posix.dirname(partPath);
    const relsPath = `${partDir}/_rels/${path.posix.basename(partPath)}.rels`;
    const rels = parseRelationships(await zip.file(relsPath)?.async('string'));
    const relById = new Map(rels.map((r) => [r.id, r]));

    /* 图片 */
    for (const m of partXml.matchAll(/<(?:a:)?blip\b[^>]*>|<v:imagedata\b[^>]*>/g)) {
      const attrs = attrsOf(m[0]);
      const embed = attrs['r:embed'] ?? attrs['r:id'] ?? Object.entries(attrs).find(([k]) => /:(embed|id)$/.test(k))?.[1];
      const link = attrs['r:link'];
      if (!embed && !link) continue;
      stats.images++;
      if (embed) {
        const rel = relById.get(embed);
        const targetPart = rel ? resolvePartPath(partDir, rel.target) : null;
        if (!rel || !targetPart || !zip.file(targetPart)) {
          issues.push({
            severity: 'error', kind: 'missing_image', location: partPath,
            detail: `图片引用 ${embed} 指向的零件${targetPart ? ` ${targetPart}` : ''}不在包里`,
          });
        }
      } else if (link) {
        const rel = relById.get(link);
        const abs = rel ? localTargetPath(docDir, rel) : null;
        if (!abs || !fs.existsSync(abs)) {
          issues.push({
            severity: 'error', kind: 'missing_image', location: partPath,
            detail: `外链图片指向的文件不存在: ${abs ?? rel?.target ?? link}`,
          });
        }
      }
    }

    /* 超链接 */
    const bookmarks = new Set<string>();
    for (const b of partXml.matchAll(/<w:bookmarkStart\b[^>]*>/g)) {
      const name = attrsOf(b[0])['w:name'];
      if (name) bookmarks.add(name);
    }
    for (const h of partXml.matchAll(/<w:hyperlink\b[^>]*>/g)) {
      const attrs = attrsOf(h[0]);
      const rid = attrs['r:id'] ?? Object.entries(attrs).find(([k]) => /:id$/.test(k))?.[1];
      if (rid) {
        const rel = relById.get(rid);
        const abs = rel ? localTargetPath(docDir, rel) : null;
        if (abs && !fs.existsSync(abs)) {
          issues.push({
            severity: 'error', kind: 'broken_link', location: partPath,
            detail: `超链接指向的文件不存在: ${abs}`,
          });
        }
      }
      const anchor = attrs['w:anchor'];
      if (anchor && !bookmarks.has(anchor)) {
        issues.push({
          severity: 'error', kind: 'broken_link', location: partPath,
          detail: `内部跳转锚点「${anchor}」在文档里不存在`,
        });
      }
    }
  }

  return finalizeReport('docx', absPath, issues, stats);
}
