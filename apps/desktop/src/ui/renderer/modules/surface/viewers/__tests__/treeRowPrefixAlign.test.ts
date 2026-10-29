
import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const CSS = fs.readFileSync(
  path.resolve(__dirname, '../../../../styles/editor-core/workspace-editor/shell-files.css'),
  'utf8',
);

/** 取某个选择器的规则体 (剥掉注释, 免得注释里引用的旧值把断言骗过去) */
function block(selector: string): string {
  const i = CSS.indexOf(selector);
  expect(i, `找不到选择器 ${selector}`).toBeGreaterThan(-1);
  const body = CSS.slice(CSS.indexOf('{', i) + 1, CSS.indexOf('}', i));
  return body.replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('文件树行前缀对齐', () => {
  test('文件行不再补 chevron 宽度的空位', () => {
    expect(block('.file-tree-item.file::before')).toMatch(/content:\s*none/);
  });

  test('.file-icon 左右都不带 margin (间距归行的 gap 一处管)', () => {
    const b = block('.file-icon {');
    expect(b).toMatch(/margin-left:\s*0(px)?\s*;/);
    expect(b).toMatch(/margin-right:\s*0(px)?\s*;/);
  });

  test('前缀两边同宽: .file-icon 与 .tree-arrow 都是 16px', () => {
    expect(block('.file-icon {')).toMatch(/width:\s*16px/);
    expect(block('.tree-arrow {')).toMatch(/width:\s*16px/);
  });
});
