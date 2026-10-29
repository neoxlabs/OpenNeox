import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDERER = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOKEN_VALUE = '44px';

function walkCss(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkCss(p, out);
    else if (name.endsWith('.css')) out.push(p.replace(/\\/g, '/'));
  }
  return out;
}
const files = walkCss(RENDERER);
/* 剥注释 —— 上面这段说明和被测文件的注释里都逐字引着这些写法 */
const bodies = files.map(f => ({ f, css: readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ') }));

describe('--neox-topbar-height 单一真相', () => {
  it('自检: 确实扫到了引用 (否则下面全是空集平凡通过)', () => {
    const n = bodies.reduce((a, b) => a + (b.css.match(/var\(--neox-topbar-height/g) ?? []).length, 0);
    expect(n).toBeGreaterThan(10);
  });

  it('token 本身是 44px, 且只定义一次', () => {
    const defs: string[] = [];
    for (const { css } of bodies) {
      for (const m of css.matchAll(/--neox-topbar-height\s*:\s*([^;}]+)/g)) defs.push(m[1].trim());
    }
    expect(defs).toEqual([TOKEN_VALUE]);
  });

  it('每一处 var() 都必须带兜底 —— 尤其 grid-template-rows, 缺了会让整条声明作废', () => {
    const bare: string[] = [];
    for (const { f, css } of bodies) {
      for (const m of css.matchAll(/var\(\s*--neox-topbar-height\s*\)/g)) {
        const line = css.slice(0, m.index).split('\n').length;
        bare.push(`${f.split('/').slice(-2).join('/')}:${line}`);
      }
    }
    expect(bare, `这些引用没写兜底, 变量一旦解析不出来整条声明作废:\n${bare.join('\n')}`).toEqual([]);
  });

  it('所有兜底值都等于 token 值 —— 不许 44/48/56 各写各的', () => {
    const odd: string[] = [];
    for (const { f, css } of bodies) {
      for (const m of css.matchAll(/var\(\s*--neox-topbar-height\s*,\s*([^)]+)\)/g)) {
        if (m[1].trim() !== TOKEN_VALUE) {
          odd.push(`${f.split('/').slice(-2).join('/')} → ${m[1].trim()}`);
        }
      }
    }
    expect(odd, `兜底值跟 token (${TOKEN_VALUE}) 不一致:\n${odd.join('\n')}`).toEqual([]);
  });
});
