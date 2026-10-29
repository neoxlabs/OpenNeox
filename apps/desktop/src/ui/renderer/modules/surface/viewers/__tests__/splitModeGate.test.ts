
import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAW = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../CodeSurfaceViewer.tsx'),
  'utf8',
);
/* 剥掉注释再判 —— 注释里会**引用**旧文案说明当初为什么改, 那不算"还在用" */
const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('分栏档的闸', () => {
  test('side-by-side 只在 canRenderDiff 为真时才 push 进模式列表', () => {
    const m = /if \(canRenderDiff\) \{[\s\S]{0,400}?\}/.exec(SRC)?.[0] ?? '';
    expect(m, '找不到 canRenderDiff 闸').toBeTruthy();
    expect(m).toMatch(/'side-by-side'/);
  });

  test('模式列表的 base 初值里不许再无条件带 side-by-side', () => {
    const base = /const base: Array<\[DiffViewMode, string, string\]> = \[[\s\S]{0,200}?\];/.exec(SRC)?.[0] ?? '';
    expect(base, '找不到 base 初值').toBeTruthy();
    expect(base, 'base 初值里仍无条件塞了 side-by-side').not.toMatch(/side-by-side/);
  });

  test('不再对"没有改动"的文件说「改动被截断」', () => {
    /* 这句只在 canRenderDiff 为假时才出现过 —— 而那恰恰是"压根没有 diff"的情况。
     * 判的是剥注释后的代码: 注释里引用旧文案是在讲历史, 不算还在用。 */
    expect(SRC).not.toMatch(/改动被截断/);
  });

  test('渲染判据本身没被动 —— 闸的是入口, 不是行为', () => {
    expect(SRC).toMatch(/isSideBySideMode = canRenderDiff && diffViewMode === 'side-by-side'/);
  });
});
