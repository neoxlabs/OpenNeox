import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rendererCopy = resolve(here, '../pptxText.ts');
const coreSource = resolve(here, '../../../../../../../../packages/core/src/tools/pptx/pptxText.ts');

describe('pptxText 渲染端副本', () => {
  /* 没有 PPT 引擎的公开树里 core 那份不导出, 没有对照对象 */
  it.skipIf(!existsSync(coreSource))('跟 core 的 pptxText.ts 逐字一致', () => {
    const a = readFileSync(rendererCopy, 'utf8');
    const b = readFileSync(coreSource, 'utf8');
    expect(b.length).toBeGreaterThan(1000);
    expect(a).toBe(b);
  });
});
