
import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/* 剥注释再判 —— 注释里会**引用**旧写法说明当初为什么改, 那不算"还在用"。
 * (轮次 49 已经栽过一次, 这里直接照做) */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const VIEWER = stripComments(
  fs.readFileSync(path.resolve(HERE, '../FilesSurfaceViewer.tsx'), 'utf8'),
);
const CSS = fs.readFileSync(path.resolve(HERE, '../../surface.css'), 'utf8');

describe('文件树宽度', () => {
  test('不许把"强行撑宽、盖掉用户拖出来的值"那套机制搬回来', () => {
    expect(VIEWER, '又出现了 Math.max(treeWidth, <常数>) —— 这正是 2026-08-20 那个 bug')
      .not.toMatch(/Math\.max\(treeWidth,\s*\d+\)/);
  });

  test('CSS 上限收到 <= 40%, 保证代码至少留 60%', () => {
    const m = /\.sfc-files__tree--overlay\s*\{[\s\S]*?max-width:\s*min\(\s*\d+px\s*,\s*(\d+)%\s*\)/.exec(CSS);
    expect(m, '找不到 overlay 的 max-width').toBeTruthy();
    expect(Number(m![1])).toBeLessThanOrEqual(40);
  });

  test('上限仍有绝对值封顶, 别在超宽屏上摊成一整条', () => {
    expect(CSS).toMatch(/\.sfc-files__tree--overlay[\s\S]*?max-width:\s*min\(\s*300px/);
  });
});
