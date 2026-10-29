import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, '../CodePreviewPane.tsx'), 'utf8');

describe('SvgPreview', () => {
  const block = src.slice(src.indexOf('const SvgPreview'), src.indexOf('/* ──', src.indexOf('const SvgPreview')));

  it('不再把文件内容 innerHTML 进来', () => {
    expect(block).not.toMatch(/dangerouslySetInnerHTML/);
  });

  it('走 <img data:image/svg+xml> —— 图片上下文不执行脚本', () => {
    expect(block).toMatch(/data:image\/svg\+xml;charset=utf-8,\$\{encodeURIComponent\(content\)\}/);
  });

  it('整个文件里也不许再出现拿 content 直接注入的写法', () => {
    /* 其余几处 dangerouslySetInnerHTML 注的是**我们自己生成/自带**的 SVG
       (mermaid securityLevel:'strict' 的产物、打包进来的图标), 跟文件内容无关。 */
    expect(src).not.toMatch(/dangerouslySetInnerHTML=\{\{\s*__html:\s*content\s*\}\}/);
  });
});
