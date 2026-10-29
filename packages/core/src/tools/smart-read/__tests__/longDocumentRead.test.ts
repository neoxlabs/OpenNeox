/**
 * readfile 首读长文档 → 大纲 + 锚点回查 (work-master-plan H-12)。
 *
 * 覆盖两条真实读取路径:
 *   · .md 文档: 首读 >4K token 时只给章节大纲, anchor="#L…" 再取正文
 *   · PDF 文本层: 首读给分段大纲 (≤8K token), anchor="#p…" 取页
 * 显式 pages / read_all / max_output_chars 必须保持原行为 —— 大纲不能顶掉用户点名要的正文。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { estimateTokens } from '@neoxlabs/kernel';
import { createSmartReadTools } from '../tools.js';
import { LONG_DOC_FIRST_READ_TOKEN_BUDGET } from '../longDoc.js';

let dir: string;

function tool() {
  const t = createSmartReadTools(dir).find((candidate) => candidate.name === 'readfile');
  if (!t) throw new Error('readfile tool not found');
  return t;
}

async function read(args: Record<string, unknown>): Promise<string> {
  return await tool().function(args as any, {} as any) as string;
}

function makeLongMarkdown(): string {
  const lines: string[] = [];
  for (let section = 1; section <= 6; section++) {
    lines.push(`# 第 ${section} 章 主题 ${section}`);
    lines.push('');
    for (let i = 0; i < 220; i++) {
      lines.push(`第 ${section} 章第 ${i + 1} 行: ${'这是一段用于填充长度的说明文字。'.repeat(2)}`);
    }
  }
  return lines.join('\n');
}

/* 手写多页 PDF (Helvetica + 每页一段文本), 不依赖外部生成库; 机器没装 poppler 就跳过 PDF 用例 */
function makePdf(pageTexts: string[]): Buffer {
  const objects: string[] = [];
  const fontObj = 3 + pageTexts.length * 2;
  objects[1] = '<</Type/Catalog/Pages 2 0 R>>';
  objects[2] = `<</Type/Pages/Kids[${pageTexts.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}]/Count ${pageTexts.length}>>`;
  pageTexts.forEach((text, i) => {
    const pageObj = 3 + i * 2;
    const contentObj = pageObj + 1;
    /* 一行写太长会跑出页面, poppler 只抽出可见部分 —— 按 60 字符折行写 */
    const lines = text.match(/.{1,60}/g) ?? [''];
    const stream = lines
      .map((line, lineIndex) =>
        `BT /F1 10 Tf 40 ${790 - lineIndex * 12} Td (${line.replace(/[()\\]/g, '\\$&')}) Tj ET`)
      .join('\n');
    objects[pageObj] = `<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</Font<</F1 ${fontObj} 0 R>>>>/Contents ${contentObj} 0 R>>`;
    objects[contentObj] = `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`;
  });
  objects[fontObj] = '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>';

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i++) {
    if (!objects[i]) continue;
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) {
    out += `${String(offsets[i] ?? 0).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<</Size ${objects.length}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const hasPoppler = (() => {
  try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-longdoc-'));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('readfile 长 markdown 首读', () => {
  it('首读给大纲 (≤8K token), 不带全文', async () => {
    const file = path.join(dir, 'handbook.md');
    const md = makeLongMarkdown();
    fs.writeFileSync(file, md, 'utf8');
    expect(estimateTokens(md)).toBeGreaterThan(4000);

    const out = await read({ path: file });
    expect(out).toContain('[长文档大纲]');
    expect(out).toContain('#L');
    expect(estimateTokens(out)).toBeLessThanOrEqual(LONG_DOC_FIRST_READ_TOKEN_BUDGET);
    expect(out).not.toContain('第 6 章第 220 行');
  });

  it('按锚点回查, 拿到的是真实正文行', async () => {
    const file = path.join(dir, 'handbook.md');
    const out = await read({ path: file, anchor: '#L1-40' });
    expect(out).toContain('--- 内容（带行号，便于阅读）---');
    expect(out).toContain('第 1 章第 1 行');
    expect(out).not.toContain('[长文档大纲]');
    const range = out.match(/显示: 第 (\d+)-(\d+) 行/);
    expect(range?.[1]).toBe('1');
    expect(Number(range?.[2])).toBeGreaterThanOrEqual(40);
  });

  it('read_all=true / 显式 max_output_chars 仍按原样返回正文', async () => {
    const file = path.join(dir, 'handbook.md');
    const all = await read({ path: file, read_all: true });
    expect(all).not.toContain('[长文档大纲]');
    expect(all).toContain('第 1 章第 1 行');

    const limited = await read({ path: file, max_output_chars: 2000 });
    expect(limited).not.toContain('[长文档大纲]');
  });

  it('短文档不被大纲拦截', async () => {
    const file = path.join(dir, 'short.md');
    fs.writeFileSync(file, '# 标题\n只有几行。\n', 'utf8');
    const out = await read({ path: file });
    expect(out).not.toContain('[长文档大纲]');
    expect(out).toContain('只有几行。');
  });
});

describe.skipIf(!hasPoppler)('readfile 长 PDF 首读', () => {
  const pdfPath = () => path.join(dir, 'report.pdf');
  const pageBody = (i: number) => `Chapter ${i + 1} heading ` + `detail sentence number ${i + 1}. `.repeat(120);

  beforeAll(() => {
    fs.writeFileSync(pdfPath(), makePdf(Array.from({ length: 8 }, (_, i) => pageBody(i))));
  });

  it('首读返回分段大纲, 带可回查的 #p 锚点 (≤8K token)', async () => {
    const out = await read({ path: pdfPath() });
    expect(out).toContain('[长文档大纲]');
    expect(out).toMatch(/#p\d+/);
    expect(out).toContain('共 8 页');
    expect(estimateTokens(out)).toBeLessThanOrEqual(LONG_DOC_FIRST_READ_TOKEN_BUDGET);
    expect(out).not.toContain('detail sentence number 8. detail sentence number 8.');
  });

  it('anchor="#p3-4" 回查只返回第 3-4 页正文', async () => {
    const out = await read({ path: pdfPath(), anchor: '#p3-4' });
    expect(out).toContain('[PDF 文本层]');
    expect(out).toContain('Chapter 3 heading');
    expect(out).toContain('Chapter 4 heading');
    expect(out).not.toContain('Chapter 2 heading');
    expect(out).not.toContain('Chapter 5 heading');
  });

  it('显式 pages 保持原行为, 不给大纲', async () => {
    const out = await read({ path: pdfPath(), pages: '1' });
    expect(out).not.toContain('[长文档大纲]');
    expect(out).toContain('Chapter 1 heading');
  });
});
