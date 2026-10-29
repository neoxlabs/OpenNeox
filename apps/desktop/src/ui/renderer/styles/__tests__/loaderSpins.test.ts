import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');

function walk(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '__tests__') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (ext.test(e)) out.push(p);
  }
  return out;
}
const CSS_FILES = walk(ROOT, /\.css$/);
const allCss = CSS_FILES.map((f) => strip(readFileSync(f, 'utf8'))).join('\n');

describe('转圈', () => {
  it('Icons.Loader 自己带着旋转的类', () => {
    const src = strip(readFileSync(join(ROOT, 'components', 'Icons.tsx'), 'utf8'));
    const m = /Loader:\s*\(\)\s*=>\s*\(\s*<svg([^>]*)>/.exec(src);
    expect(m, '找不到 Icons.Loader 的 svg 开标签, 闸失效了').toBeTruthy();
    expect(m![1], 'Loader 不带 .neox-spin 就是个冻住的转圈').toMatch(/className="[^"]*\bneox-spin\b/);
  });

  it('.neox-spin 有且只有一处定义, 且真的转', () => {
    // 只数**设置 animation 简写**的那种; prefers-reduced-motion 里的
    // animation-duration 覆盖是合理的第二处, 不算重复定义。
    const defs = [...allCss.matchAll(/\.neox-spin\s*\{([^}]*)\}/g)]
      .filter((m) => /animation:\s/.test(m[1]));
    expect(defs.length, '旋转只许一处真相源').toBe(1);
    expect(defs[0][1]).toMatch(/animation:\s*neox-spin/);
  });

  it('@keyframes neox-spin 全仓只有一份', () => {
    const n = [...allCss.matchAll(/@keyframes\s+neox-spin\b/g)].length;
    expect(n, 'CSS 全走 @import 打进同一 bundle, keyframes 是全局的 —— 同名多份是谁在后面谁赢').toBe(1);
  });

  it('包裹层不许再转一次 (否则父子叠成两倍速)', () => {
    const doubled: string[] = [];
    for (const f of CSS_FILES) {
      const css = strip(readFileSync(f, 'utf8'));
      for (const cls of ['tree-loading-spinner', 'cp-ai-spin', 'gl-loading', 'settings-loading']) {
        const m = new RegExp(`\\.${cls}[^{]*\\{([^}]*)\\}`, 'g');
        for (const hit of css.matchAll(m)) {
          if (/animation:[^;]*spin/.test(hit[1])) doubled.push(`${f.replace(ROOT, '')} .${cls}`);
        }
      }
    }
    expect(doubled, `这些包裹层里的 Icons.Loader 会转两遍: ${doubled.join(' / ')}`).toEqual([]);
  });
});
