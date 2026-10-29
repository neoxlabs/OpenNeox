import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const UI = join(__dirname, '..', '..', '..');   // src/ui

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '__tests__') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const FILES = walk(UI);

/** 所有 CSS 来源: .css 文件 + index.html 的 <style> + TSX 里内联的 <style>{`…`}</style> */
function allCssText(): string {
  const parts: string[] = [];
  for (const f of FILES) {
    if (/\.css$/.test(f)) { parts.push(readFileSync(f, 'utf8')); continue; }
    if (/\.(html|tsx)$/.test(f)) {
      const s = readFileSync(f, 'utf8');
      for (const m of s.matchAll(/<style[^>]*>\{?`?([\s\S]*?)`?\}?<\/style>/g)) parts.push(m[1]);
    }
  }
  return parts.join('\n');
}

/** fallback={…} 的花括号配对取值 */
function fallbacks(): Array<{ file: string; line: number; value: string }> {
  const out: Array<{ file: string; line: number; value: string }> = [];
  for (const f of FILES) {
    if (!/\.tsx$/.test(f)) continue;
    const s = readFileSync(f, 'utf8');
    for (const m of s.matchAll(/fallback\s*=\s*\{/g)) {
      let i = (m.index ?? 0) + m[0].length - 1, d = 0;
      for (; i < s.length; i++) {
        if (s[i] === '{') d++;
        else if (s[i] === '}') { d--; if (d === 0) break; }
      }
      out.push({
        file: f.slice(UI.length),
        line: s.slice(0, m.index ?? 0).split('\n').length,
        value: s.slice((m.index ?? 0) + m[0].length, i).replace(/\s+/g, ' ').trim(),
      });
    }
  }
  return out;
}

const NULL_FALLBACK_BASELINE = 9;

describe('Suspense fallback', () => {
  it('测试确实扫到了 fallback 和 CSS (自检)', () => {
    expect(fallbacks().length).toBeGreaterThan(10);
    expect(allCssText().length).toBeGreaterThan(100_000);
  });

  it('fallback 里用到的 class 都真有样式', () => {
    const css = allCssText();
    const bad: string[] = [];
    for (const fb of fallbacks()) {
      /* fallback 常被抽成组件 (<PageLoading />), 那时表达式里没有 className ——
       * 闸必须跟进一层去组件定义里取, 否则一抽组件就失明。
       * 第一版就是这样: 我把 .neox-page-loading 的 CSS 整条删掉做变异验证, 闸照绿。 */
      let text = fb.value;
      const comp = fb.value.match(/^<([A-Z]\w+)\s*\/>$/);
      if (comp) {
        const src = readFileSync(join(UI, fb.file), 'utf8');
        const at = src.search(new RegExp('(const|function)\\s+' + comp[1] + '\\b'));
        if (at >= 0) text = src.slice(at, at + 800);
      }
      for (const m of text.matchAll(/className\s*=\s*"([^"]+)"/g)) {
        for (const c of m[1].split(/\s+/).filter(Boolean)) {
          /* 选择器里出现过就算 —— 只看花括号前的部分, 免得把声明值里的字符串算进去 */
          const re = new RegExp('\\.' + c.replace(/[-[\]/{}()*+?.\\^$|]/g, '\\$&') + '(?![\\w-])');
          if (!re.test(css)) bad.push(`${fb.file}:${fb.line} .${c}`);
        }
      }
    }
    expect(bad,
      'Suspense 的 fallback 挂了个没有任何样式的 class —— chunk 未到时用户看到的是一片空白: '
      + bad.join(' / ')).toEqual([]);
  });

  it('fallback={null} 只许减不许加', () => {
    const nulls = fallbacks().filter(f => f.value === 'null');
    expect(nulls.length,
      `新增了 fallback={null}。chunk 慢时用户点了没任何反应 —— 页面级的请用 <PageLoading />。`
      + `当前: ${nulls.map(n => n.file + ':' + n.line).join(' / ')}`).toBeLessThanOrEqual(NULL_FALLBACK_BASELINE);
  });
});
