import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createShowTreeTool } from '../showTreeTool.js';

/**
 * show_tree 输出上限 (LOOP-01): 超出预算按目录聚合 (目录名 + 文件数), 不截半行。
 */

describe('show_tree 输出预算', () => {
  let dir: string;
  const buildTool = () => createShowTreeTool({
    resolveWorkspacePath: () => dir,
    formatDisplayPath: (p) => path.basename(p),
  });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-show-tree-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('小目录: 与改动前逐字一致 (前缀 / 顺序 / 大小格式)', async () => {
    await fs.mkdir(path.join(dir, 'src'));
    await fs.writeFile(path.join(dir, 'src', 'a.ts'), 'hello!');
    await fs.writeFile(path.join(dir, 'b.md'), 'abc');

    const out = await buildTool().function({ directory: '.' });

    const expected = [
      `${path.basename(dir)}/`,
      '',
      '├── src/',
      '│   └── a.ts (6B)',
      '└── b.md (3B)',
    ].join('\n');
    expect(out).toBe(expected);
  });

  it('大目录 (node_modules 900 个文件) → 不超 12K, 且按目录聚合', async () => {
    const heavy = path.join(dir, 'node_modules');
    await fs.mkdir(heavy);
    for (let i = 0; i < 900; i++) {
      await fs.writeFile(path.join(heavy, `f${i}.js`), 'x');
    }
    await fs.mkdir(path.join(dir, 'src'));
    await fs.writeFile(path.join(dir, 'src', 'index.ts'), 'export {};');

    const out = await buildTool().function({ directory: '.' });

    expect(out.length).toBeLessThanOrEqual(12_000);
    expect(out).toContain('已按目录聚合');
    expect(out).toContain('node_modules/ (');
    /* 不要截掉半行: 每一行都得是完整的条目或提示 */
    for (const line of out.split('\n')) {
      expect(line.endsWith(')') || line.endsWith('/') || line.includes('已按目录聚合') || line === '')
        .toBe(true);
    }
  });

  it('上限随模型窗口放宽: 1M 窗口下同一个目录给出完整明细', async () => {
    const heavy = path.join(dir, 'node_modules');
    await fs.mkdir(heavy);
    for (let i = 0; i < 300; i++) {
      await fs.writeFile(path.join(heavy, `f${i}.js`), 'x');
    }

    const out = await buildTool().function({ directory: '.' }, { modelMaxInputTokens: 1_000_000 });

    expect(out.length).toBeLessThanOrEqual(60_000);
    expect(out).not.toContain('已按目录聚合');
    expect(out).toContain('f299.js (1B)');
  });
});
