
import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const VIEWER = stripComments(fs.readFileSync(path.resolve(HERE, '../CodeSurfaceViewer.tsx'), 'utf8'));
const OPTIONS = stripComments(
  fs.readFileSync(path.resolve(HERE, '../../../editor/engine/options.ts'), 'utf8'),
);

describe('右栏代码 surface 密度', () => {
  test('字号不超过 options.ts 的默认 —— 右栏比 IDE 窄, 不该更大', () => {
    const dft = Number(/fontSize:\s*params\.fontSize \?\? (\d+)/.exec(OPTIONS)?.[1]);
    expect(dft).toBeGreaterThan(0);
    const used = [...VIEWER.matchAll(/fontSize:\s*(\d+)/g)].map((m) => Number(m[1]));
    expect(used.length, '找不到 fontSize').toBeGreaterThan(0);
    for (const f of used) expect(f, `右栏用了 ${f}px, 大于默认 ${dft}px`).toBeLessThanOrEqual(dft);
  });

  test('行号槽不按七位数预留 —— 那是 999 万行的文件才需要的', () => {
    const m = [...VIEWER.matchAll(/lineNumbersMinChars:\s*(\d+)/g)].map((x) => Number(x[1]));
    expect(m.length).toBeGreaterThan(0);
    for (const n of m) expect(n, `lineNumbersMinChars=${n} 太宽`).toBeLessThanOrEqual(4);
  });

  test('行高跟着字号一起收, 别留 24px 这种松的', () => {
    const m = [...VIEWER.matchAll(/lineHeight:[^,\n]*?(\d\d)/g)].map((x) => Number(x[1]));
    for (const h of m) expect(h).toBeLessThanOrEqual(22);
  });
});
