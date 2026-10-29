import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ide = readFileSync(resolve(HERE, '../ide-workspace.css'), 'utf8');
const md = readFileSync(resolve(HERE, '../../../styles/editor-core/text-ui/markdown-message.css'), 'utf8');

describe('Markdown 预览的阅读留白', () => {
  it('surface 有留白', () => {
    expect(md).toMatch(/\.markdown-preview-surface \{\s*\n\s*padding: 24px 32px 56px;/);
  });
  it('正文有阅读宽度上限', () => {
    const i = md.indexOf('.markdown-preview-surface .markdown-content {');
    expect(md.slice(i, md.indexOf('}', i))).toMatch(/max-width:\s*76ch/);
  });
});

describe('ide-workspace.css 里不许有小于 10px 的字', () => {
  /* 阶梯最小档就是 10px (--neox-fs-xxs)。9px 曾在 ide-workspace.css 里有 14 处,
     recent 列表的时间/路径、区块计数角标都是 —— 小到要凑近看。 */
  it('没有 9px 及以下', () => {
    expect(ide).not.toMatch(/font-size:\s*[0-9](\.\d+)?px/);
  });
});
