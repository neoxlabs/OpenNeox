/**
 * 长文档分段摘要 + 引用锚点 (work-master-plan H-12) —— 纯函数部分。
 *
 * 验收: 100 页 PDF 首次读取的上下文增量 ≤8K token, 且能按锚点回查。
 * 这里不走 poppler: 用 extractPdfText 同款分页标记造文本, 直接验证大纲/锚点/预算。
 */
import { describe, it, expect } from 'vitest';
import { estimateTokens } from '@neoxlabs/kernel';
import {
  LONG_DOC_FIRST_READ_TOKEN_BUDGET,
  buildCharDocOutline,
  buildDocOutline,
  buildPdfDocOutline,
  buildTextOutlineUnits,
  buildPdfOutlineUnits,
  parseDocAnchor,
  splitPdfPages,
} from '../longDoc.js';

const PAGE_MARKER = '\n\n──── (下一页) ────\n\n';

function pageText(page: number, bodyChars = 900): string {
  return `第 ${page} 章 章节标题 ${page}\n${'正文内容测试数据。'.repeat(Math.ceil(bodyChars / 9))}`;
}

function makePdfText(pages: number): string {
  return Array.from({ length: pages }, (_, i) => pageText(i + 1)).join(PAGE_MARKER);
}

describe('parseDocAnchor', () => {
  it('认页码 / 行号 / 字符偏移三种锚点', () => {
    expect(parseDocAnchor('#p12-15')).toEqual({ kind: 'page', start: 12, end: 15 });
    expect(parseDocAnchor('p7')).toEqual({ kind: 'page', start: 7, end: 7 });
    expect(parseDocAnchor('#L120-239')).toEqual({ kind: 'line', start: 120, end: 239 });
    expect(parseDocAnchor('c12000-20000')).toEqual({ kind: 'char', start: 12000, end: 20000 });
  });

  it('倒序交换, 认不出的返回 null', () => {
    expect(parseDocAnchor('#p9-3')).toEqual({ kind: 'page', start: 3, end: 9 });
    expect(parseDocAnchor('')).toBeNull();
    expect(parseDocAnchor('12')).toBeNull();
    expect(parseDocAnchor('p')).toBeNull();
    expect(parseDocAnchor(undefined)).toBeNull();
  });

  it('大纲里的每个锚点都能解析回来, 并且覆盖全书', () => {
    const outline = buildPdfDocOutline('book.pdf', {
      text: makePdfText(100),
      firstPage: 1,
      lastPage: 100,
      totalPages: 100,
    });
    expect(outline.segments.length).toBeGreaterThan(1);
    const covered: number[] = [];
    for (const segment of outline.segments) {
      const anchor = parseDocAnchor(segment.anchor);
      expect(anchor?.kind).toBe('page');
      for (let p = anchor!.start; p <= anchor!.end; p++) covered.push(p);
    }
    expect(covered[0]).toBe(1);
    expect(covered[covered.length - 1]).toBe(100);
    // 连续无空洞
    expect(new Set(covered).size).toBe(100);
  });
});

describe('buildPdfDocOutline', () => {
  it('100 页 PDF 首读大纲 ≤8K token', () => {
    const text = makePdfText(100);
    const outline = buildPdfDocOutline('book.pdf', {
      text,
      firstPage: 1,
      lastPage: 100,
      totalPages: 100,
    });
    expect(estimateTokens(outline.text)).toBeLessThanOrEqual(LONG_DOC_FIRST_READ_TOKEN_BUDGET);
    expect(estimateTokens(outline.text)).toBeLessThan(estimateTokens(text));
    expect(outline.text).toContain('[长文档大纲] book.pdf');
    expect(outline.text).toContain('#p1-');
    expect(outline.text).toContain('共 100 页');
  });

  it('短文档段数少, 长文档自动合并段以守住预算', () => {
    const short = buildPdfDocOutline('s.pdf', {
      text: makePdfText(10), firstPage: 1, lastPage: 10, totalPages: 10,
    });
    expect(short.segments.length).toBeLessThanOrEqual(10);
    const long = buildPdfDocOutline('l.pdf', {
      text: makePdfText(400), firstPage: 1, lastPage: 400, totalPages: 400,
    });
    expect(estimateTokens(long.text)).toBeLessThanOrEqual(LONG_DOC_FIRST_READ_TOKEN_BUDGET);
    expect(long.segments.length).toBeLessThanOrEqual(400);
  });

  it('跨页重复的页眉不当标题, 取每页第一行真正内容', () => {
    const pages = Array.from({ length: 40 }, (_, i) =>
      `ACME 公司内部资料\n第 ${i + 1} 章 财务概览\n${'明细数据。'.repeat(100)}`);
    const text = pages.join(PAGE_MARKER);
    expect(splitPdfPages(text)).toHaveLength(40);
    const units = buildPdfOutlineUnits(text, { firstPage: 1 });
    expect(units[0].heading).toContain('第 1 章');
    expect(units[10].heading).toContain('第 11 章');
    expect(units.every((u) => !u.heading.includes('ACME'))).toBe(true);
  });

  it('尊重起始页: 从第 61 页读的文本, 锚点也从 61 开始', () => {
    const text = Array.from({ length: 10 }, (_, i) => pageText(61 + i)).join(PAGE_MARKER);
    const units = buildPdfOutlineUnits(text, { firstPage: 61 });
    expect(units[0].start).toBe(61);
    expect(units[9].end).toBe(70);
  });

  it('只抓到前 300 页时, 大纲明确说明覆盖范围 (别让模型以为看完了全书)', () => {
    const outline = buildPdfDocOutline('big.pdf', {
      text: makePdfText(10),
      firstPage: 1,
      lastPage: 300,
      totalPages: 520,
    });
    expect(outline.text).toContain('大纲覆盖第 1-300 页');
    expect(outline.text).toContain('其余 220 页');
    expect(outline.text).toContain('共 520 页');
  });
});

describe('文本 / 字符大纲', () => {
  it('markdown 标题成为锚点, 位置覆盖所有行', () => {
    const md = [
      '# 第一章', ...Array.from({ length: 30 }, () => '正文。'),
      '## 1.1 小节', ...Array.from({ length: 30 }, () => '小节正文。'),
      '## 1.2 小节', ...Array.from({ length: 30 }, () => '更多正文。'),
    ].join('\n');
    const units = buildTextOutlineUnits(md);
    expect(units[0].heading).toContain('第一章');
    expect(units[1].heading).toContain('1.1');
    expect(units[units.length - 1].end).toBe(md.split('\n').length);
    const outline = buildDocOutline({
      displayPath: 'notes.md',
      kind: 'line',
      units,
      totalChars: md.length,
      totalUnits: md.split('\n').length,
      unitName: '行',
      readHint: 'readfile(path="notes.md", anchor="#L1-200")',
    });
    expect(outline.text).toContain('#L');
  });

  it('无标题的长文本按块切, 不会整篇一行', () => {
    const text = Array.from({ length: 1200 }, (_, i) => `第 ${i} 行内容`).join('\n');
    const units = buildTextOutlineUnits(text);
    expect(units.length).toBeGreaterThan(1);
    expect(units[units.length - 1].end).toBe(1200);
  });

  it('read_document 的字符大纲: 锚点是字符区间且能覆盖全文', () => {
    const md = `# 摘要\n${'甲'.repeat(15000)}\n## 方法\n${'乙'.repeat(15000)}\n## 结论\n${'丙'.repeat(15000)}`;
    const outline = buildCharDocOutline('doc.md', md);
    expect(estimateTokens(JSON.stringify(outline.segments))).toBeLessThanOrEqual(LONG_DOC_FIRST_READ_TOKEN_BUDGET);
    const anchors = outline.segments.map((s) => parseDocAnchor(s.anchor)!);
    expect(anchors[0].start).toBe(0);
    expect(anchors[anchors.length - 1].end).toBe(md.length - 1);
    for (let i = 1; i < anchors.length; i++) {
      expect(anchors[i].start).toBe(anchors[i - 1].end + 1);
    }
  });
});
