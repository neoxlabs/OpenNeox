import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const R = join(__dirname, '..', '..');
const FILES = [
  'components/ErrorCard.tsx',
  'components/Markdown.tsx',
  'app/NeoxShellHost.tsx',
];
const CJK = /[一-鿿]/;

function stripKeepLines(s: string): string {
  const blank = (m: string) => '\n'.repeat((m.match(/\n/g) ?? []).length);
  return s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/^\s*\/\/.*$/gm, '');
}

function bareChinese(rel: string): string[] {
  const s = stripKeepLines(readFileSync(join(R, rel), 'utf8'));
  const hits: string[] = [];
  const lines = s.split('\n');
  /* 三元可能写在外层 (message: mvZh ? (<>中文…</>) : (<>English…</>)), 那时中文虽然
   * "裸"在 JSX 里但其实是对的。所以命中后回看**同行 + 前 4 行**有没有语言分支条件;
   * 有就放过。第一版没这一步, 把这种正确写法报成了 bug。 */
  const guarded = (lineNo: number) =>
    lines.slice(Math.max(0, lineNo - 5), lineNo)
      .some(l => /\b\w*[zZ]h\b\s*[?&]/.test(l) || /language\s*===\s*'zh'/.test(l));
  /* JSX 裸文本: >…中文…< 中间不含 { } (含 {} 的就是走表达式, 由分支判断) */
  for (const m of s.matchAll(/>([^<>{}]*[一-鿿][^<>{}]*)</g)) {
    const t = m[1].trim();
    if (!t || t.length > 60) continue;
    const lineNo = s.slice(0, m.index ?? 0).split('\n').length;
    if (guarded(lineNo)) continue;
    hits.push(`${rel}:${lineNo} 「${t.slice(0, 40)}」`);
  }
  /* 属性里的裸中文字符串 */
  for (const m of s.matchAll(/\b(title|placeholder|aria-label)\s*=\s*(?:"([^"]*)"|\{\s*'([^']*)'\s*\})/g)) {
    const v = m[2] ?? m[3] ?? '';
    if (!CJK.test(v)) continue;
    hits.push(`${rel}:${s.slice(0, m.index ?? 0).split('\n').length} ${m[1]}="${v.slice(0, 34)}"`);
  }
  return hits;
}

describe('主链路文案 i18n', () => {
  it('测试指着的文件都存在且非空 (路径自检)', () => {
    for (const f of FILES) expect(readFileSync(join(R, f), 'utf8').length).toBeGreaterThan(500);
  });

  it('这几个文件里没有裸中文', () => {
    const bad = FILES.flatMap(bareChinese);
    expect(bad, `英文界面下这里会冒中文, 要走 isZh 分支: ${bad.join(' / ')}`).toEqual([]);
  });
});
