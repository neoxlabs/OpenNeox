import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rendererRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function walkTsx(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (name.name === 'node_modules' || name.name.startsWith('.')) continue;
    const p = join(dir, name.name);
    if (name.isDirectory()) out.push(...walkTsx(p));
    else if (name.name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/** 同一函数体内, 深度 1 的 `return` 之后又出现 useEnterTransition → 违规 */
function hooksAfterReturn(src: string): number[] {
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
  const lines = stripped.split('\n');
  const bad: number[] = [];
  let depth = 0;
  let seenReturnAtDepth1 = false;
  const declRe = /^(?:export\s+)?(?:const|function)\s+/;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l[0] !== ' ' && l[0] !== '\t' && declRe.test(l)) {
      depth = 0;
      seenReturnAtDepth1 = false;
    }
    if (depth === 1 && /^\s*if\s*\([^;]*\)\s*return\b/.test(l)) seenReturnAtDepth1 = true;
    if (depth === 1 && /^\s*return\s+(null|<)/.test(l)) seenReturnAtDepth1 = true;
    if (seenReturnAtDepth1 && /useEnterTransition\s*\(/.test(l)) bad.push(i + 1);
    depth += (l.match(/\{/g)?.length ?? 0) - (l.match(/\}/g)?.length ?? 0);
  }
  return bad;
}

describe('useEnterTransition 不得放在 early return 之后', () => {
  const files = walkTsx(rendererRoot).filter((p) => {
    const src = readFileSync(p, 'utf8');
    return src.includes('useEnterTransition');
  });

  it('扫到了含 useEnterTransition 的文件', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const p of files) {
    it(p.slice(rendererRoot.length + 1), () => {
      const bad = hooksAfterReturn(readFileSync(p, 'utf8'));
      expect(bad, `useEnterTransition 出现在 early return 之后, 行 ${bad.join(', ')}`).toEqual([]);
    });
  }
});
