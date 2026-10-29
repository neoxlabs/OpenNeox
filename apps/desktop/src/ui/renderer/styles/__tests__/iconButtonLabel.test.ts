import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');   // renderer/

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '__tests__') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(e) && !/\.test\.tsx$/.test(e)) out.push(p);
  }
  return out;
}

/* 开标签的收尾 `>` 要按花括号深度找 —— onClick={() => ...} 里的 `=>` 会把
 * /<button[\s\S]*?>/ 提前截断 (侧栏那条闸的第一版就栽在这)。 */
function tagEnd(s: string, i: number): number {
  let d = 0;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '{') d++;
    else if (c === '}') d--;
    else if (c === '>' && d === 0) return i;
  }
  return -1;
}

function scan(): string[] {
  const bad: string[] = [];
  for (const f of walk(ROOT)) {
    const s = readFileSync(f, 'utf8');
    for (const m of s.matchAll(/<button\b/g)) {
      const st = m.index ?? 0;
      const e = tagEnd(s, st + 7);
      if (e < 0 || s[e - 1] === '/') continue;
      const attrs = s.slice(st, e);
      if (/\b(title|aria-label|aria-labelledby)\s*=/.test(attrs)) continue;
      const close = s.indexOf('</button>', e);
      if (close < 0 || close - e > 600) continue;
      const inner = s.slice(e + 1, close);
      /* 有没有可读文字: 裸文本 / 含引号的 JSX 表达式 / 变量插值 都算有 */
      const bare = inner.replace(/\{[\s\S]*?\}/g, '').replace(/<[^>]*>/g, '').trim();
      const exprs = [...inner.matchAll(/\{([^{}]*)\}/g)].map(x => x[1]);
      const hasText = !!bare
        || exprs.some(x => /['"`]/.test(x))
        || exprs.some(x => /^\s*[\w.?[\]]+\s*$/.test(x));
      if (hasText) continue;
      if (!/<(Icon|Svg|[A-Z]\w*Icon|svg|img)/.test(inner)) continue;
      bad.push(`${f.slice(ROOT.length)}:${s.slice(0, st).split('\n').length}`);
    }
  }
  return bad;
}

describe('纯图标按钮', () => {
  it('测试确实扫到了按钮 (自检) —— 扫不到会让下面那条假绿', () => {
    let n = 0;
    for (const f of walk(ROOT)) n += (readFileSync(f, 'utf8').match(/<button\b/g) ?? []).length;
    expect(n).toBeGreaterThan(300);
  });

  it('每个纯图标按钮都有 title 或 aria-label', () => {
    const bad = scan();
    expect(bad, `这些按钮只有一个图标, 悬停没说明、读屏读不出: ${bad.join(' / ')}`).toEqual([]);
  });
});
