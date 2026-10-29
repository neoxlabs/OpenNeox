import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const UI_ROOT = join(__dirname, '..', '..', '..');   // src/ui

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    /* 必须排掉 __tests__ —— 本文件里 `b.token === '--neox-fg-tertiary'` 是个字符串字面量,
     * 会被下面"applyPack 映射表"那条规则当成 token 定义, 于是闸把自己喂饱了:
     * 我把 neox.css 里的定义整行删掉做变异验证, 三条测试**全绿**。自指假绿。 */
    if (e === 'node_modules' || e === '__tests__') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(css|ts|tsx|html)$/.test(e)) out.push(p);
  }
  return out;
}

function scan() {
  const files = walk(UI_ROOT);
  const srcs = new Map<string, string>();
  for (const f of files) srcs.set(f, readFileSync(f, 'utf8'));

  const defined = new Set<string>();
  for (const s of srcs.values()) {
    for (const m of s.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]);
    /* applyPack.ts 的映射表里 token 名是字符串字面量, 那也算定义 */
    for (const m of s.matchAll(/['"](--[\w-]+)['"]/g)) defined.add(m[1]);
  }

  const broken: Array<{ token: string; file: string }> = [];
  for (const [f, s] of srcs) {
    for (const m of s.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) {   // 无兜底
      if (defined.has(m[1])) continue;
      broken.push({ token: m[1], file: f.slice(UI_ROOT.length) });
    }
  }
  return { defined, broken };
}

const BASELINE = 126;   // 只许减不许加

describe('CSS token 引用', () => {
  it('测试确实扫到了东西 (自检) —— 扫不到会让下面两条假绿', () => {
    const { defined } = scan();
    expect(defined.size).toBeGreaterThan(900);
    expect(defined.has('--neox-fg-primary')).toBe(true);
  });

  it('已经修好的 token 不许再变回未定义', () => {
    const { broken } = scan();
    const regressed = broken.filter(b =>
      b.token === '--neox-fg-tertiary' || b.token === '--neox-ease-spring');
    expect(regressed.map(b => `${b.token} @ ${b.file}`),
      '这两个 token 已经在 theme-tokens/neox.css 里定义过了').toEqual([]);
  });

  it('无兜底的未定义引用只许减不许加', () => {
    const { broken } = scan();
    const byToken = new Map<string, number>();
    for (const b of broken) byToken.set(b.token, (byToken.get(b.token) ?? 0) + 1);
    const detail = [...byToken].sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${t}×${n}`).join(' ');
    expect(broken.length,
      `新增了引用未定义 token 且无兜底的声明 —— 它们在浏览器里直接作废。` +
      `要么定义那个 token, 要么写兜底值。当前: ${detail}`).toBeLessThanOrEqual(BASELINE);
  });
});
