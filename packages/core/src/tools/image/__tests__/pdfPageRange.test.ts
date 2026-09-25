/**
 * PDF 页码区间 —— 交给 poppler 的区间必须永远合法。
 *
 * 回归场景: 1 页的 PDF, 模型要 pages="2-4" → pdftoppm -f 2 -l 4 直接报错,
 * 界面出红色错误卡。resolvePdfPageRange 是文本/图片两条通道共用的唯一解析处。
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolvePdfPageRange, readPdfAsImages, extractPdfText } from '../imageProcessor.js';

describe('resolvePdfPageRange', () => {
  it('起始页超出总页数 → 不给区间, 给一句可照改的说明', () => {
    const r = resolvePdfPageRange('2-4', 1, 20);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('pages="1"');
  });

  it('结束页超出 → 夹到总页数', () => {
    expect(resolvePdfPageRange('2-40', 5, 20)).toEqual({ ok: true, firstPage: 2, lastPage: 5 });
  });

  it('倒序 → 交换; 0 页 → 从 1 起', () => {
    expect(resolvePdfPageRange('4-2', 10, 20)).toEqual({ ok: true, firstPage: 2, lastPage: 4 });
    expect(resolvePdfPageRange('0-3', 10, 20)).toEqual({ ok: true, firstPage: 1, lastPage: 3 });
  });

  it('未指定 / 写法看不懂 → 从第 1 页读到上限', () => {
    expect(resolvePdfPageRange(undefined, 50, 20)).toEqual({ ok: true, firstPage: 1, lastPage: 20 });
    expect(resolvePdfPageRange('abc', 3, 20)).toEqual({ ok: true, firstPage: 1, lastPage: 3 });
  });

  it('总页数未知 (0) → 不做越界判断, 只受单次上限约束', () => {
    expect(resolvePdfPageRange('5-100', 0, 20)).toEqual({ ok: true, firstPage: 5, lastPage: 24 });
  });

  it('任何输入都满足 1 ≤ first ≤ last ≤ total', () => {
    const inputs = [undefined, '', '1', '3', '9-1', '2-2', '0', '7-99', ' 2 - 3 ', 'x-y'];
    for (const total of [1, 2, 3, 30]) {
      for (const p of inputs) {
        const r = resolvePdfPageRange(p, total, 20);
        if (!r.ok) continue;
        expect(r.firstPage).toBeGreaterThanOrEqual(1);
        expect(r.lastPage).toBeGreaterThanOrEqual(r.firstPage);
        expect(r.lastPage).toBeLessThanOrEqual(total);
      }
    }
  });
});

/* 真跑 poppler —— 机器上没装就跳过 */
const hasPoppler = (() => { try { execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();

describe.skipIf(!hasPoppler)('单页 PDF 请求越界页 (真 poppler)', () => {
  const minimalPdf = [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj',
    'trailer<</Root 1 0 R>>',
    '%%EOF',
  ].join('\n');

  it('图片/文本通道都不再抛 poppler 错误, 而是标记越界', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-pdf-range-'));
    const file = path.join(dir, 'one.pdf');
    fs.writeFileSync(file, minimalPdf);
    try {
      const img = await readPdfAsImages(file, { pages: '2-4' });
      expect(img.pageRangeOutOfBounds).toBe(true);
      expect(img.error).not.toMatch(/pdftoppm|Wrong page range/);
      const txt = await extractPdfText(file, { pages: '2-4' });
      expect(txt.pageRangeOutOfBounds).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
