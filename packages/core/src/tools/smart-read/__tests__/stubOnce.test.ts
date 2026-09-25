/**
 * readfile 重读一律给正文 —— 「未变化」短答已下线。
 *
 *   The read ledger remains for edit content addressing, coherence checks, and search
 *   registration, while every read result continues to include the requested content.
 *
 *   这个文件锁住的就是"不许再回短答"这条线。
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { createSmartReadTools } from '../tools.js';

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-read-nostub-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function readfileTool(workspaceDir: string) {
  const tool = createSmartReadTools(workspaceDir).find(t => t.name === 'readfile');
  if (!tool) throw new Error('readfile tool not found');
  return tool;
}

describe('readfile 重读不再回「未变化」', () => {
  it('同一个文件连读四次, 每次都给正文', async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, 'a.ts');
      const body = Array.from({ length: 200 }, (_, i) => `const line${i} = ${i};`).join('\n') + '\n';
      await fs.writeFile(file, body, 'utf8');
      const tool = readfileTool(dir);
      const call = () => tool.function({ path: file } as any, {} as any) as Promise<string>;

      for (let i = 0; i < 4; i++) {
        const out = await call();
        expect(out).not.toMatch(/未变化/);
        expect(out).toContain('const line7 = 7;');
      }
    });
  });

  it('同一段原样再要 (大段也一样) → 正文', async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, 'big.log');
      await fs.writeFile(file, Array.from({ length: 3000 }, (_, i) => `row ${i + 1} payload`).join('\n') + '\n', 'utf8');
      const tool = readfileTool(dir);
      const range = { path: file, start_line: 1000, num_lines: 400 };

      const first = await tool.function(range as any, {} as any) as string;
      expect(first).toContain('row 1000 payload');
      const again = await tool.function(range as any, {} as any) as string;
      expect(again).not.toMatch(/未变化/);
      expect(again).toContain('row 1000 payload');
    });
  });

  it('整读过之后要其中一段 → 正文 (覆盖式命中也不短路)', async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, 'pricing.js');
      await fs.writeFile(file, Array.from({ length: 941 }, (_, i) => `export const rule${i + 1} = ${i + 1};`).join('\n') + '\n', 'utf8');
      const tool = readfileTool(dir);
      await tool.function({ path: file } as any, {} as any);

      const small = await tool.function({ path: file, start_line: 515, num_lines: 30 } as any, {} as any) as string;
      expect(small).not.toMatch(/未变化/);
      expect(small).toContain('export const rule520 = 520;');
    });
  });

  it('文件变了 → 给的是新内容', async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, 'b.ts');
      await fs.writeFile(file, 'export const v = 1;\n', 'utf8');
      const tool = readfileTool(dir);
      const call = () => tool.function({ path: file } as any, {} as any) as Promise<string>;

      await call();
      await fs.writeFile(file, 'export const v = 2;\nexport const w = 3;\n', 'utf8');
      const after = await call();
      expect(after).toContain('export const w = 3;');
    });
  });
});

/* The ledger records the delivered line range rather than treating a budget-limited
 * prefix as a full-file read, so later edit and refresh checks use valid coverage. */
describe('readfile 只交出前一段时不能记成整读', () => {
  it('大文件无参读 → 再要远处区间 / read_all 都给正文', async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, 'big.log');
      const body = Array.from({ length: 3000 }, (_, i) => `row ${i + 1} payload`).join('\n') + '\n';
      await fs.writeFile(file, body, 'utf8');
      const tool = readfileTool(dir);

      const first = await tool.function({ path: file } as any, {} as any) as string;
      expect(first).toContain('row 1 payload');
      expect(first).not.toContain('row 2500 payload');

      const far = await tool.function({ path: file, start_line: 2500, num_lines: 10 } as any, {} as any) as string;
      expect(far).toContain('row 2500 payload');

      const all = await tool.function({ path: file, read_all: true } as any, {} as any) as string;
      expect(all).toContain('row 300 payload');   /* read_all 有预算上限, 但必须比第一次给得多 */
    });
  });

  it('≤2000 行先整读、超预算缩成分段 → 被丢弃的整读不进账', async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, 'pricing.js');
      /* 行要够长, 让整读超出 25k token 整文件预算, 逼出"缩成分段重试"那条路 */
      const body = Array.from({ length: 940 }, (_, i) => `// rule ${i + 1}: ${'x'.repeat(150)}`).join('\n') + '\n';
      await fs.writeFile(file, body, 'utf8');
      const tool = readfileTool(dir);

      const first = await tool.function({ path: file } as any, {} as any) as string;
      expect(first).not.toContain('rule 600:');

      const far = await tool.function({ path: file, start_line: 600, num_lines: 20 } as any, {} as any) as string;
      expect(far).toContain('rule 600:');
    });
  });
});

/* Whole-file reads deliver the complete file within the token budget instead of using
 * the generic character limit. */
describe('readfile 整文件读按 token 预算给全', () => {
  it('941 行 / 3 万字符的源码 → 一次给到最后一行, 不提示 read_all', async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, 'pricing.js');
      const body = Array.from({ length: 941 }, (_, i) => `export const rule${i + 1} = ${i + 1}; // tier`).join('\n') + '\n';
      await fs.writeFile(file, body, 'utf8');
      const tool = readfileTool(dir);
      const out = await tool.function({ path: file } as any, {} as any) as string;
      expect(out).toContain('export const rule941 = 941;');
      expect(out).not.toMatch(/read_all=true/);
    });
  });

  it('带范围的读不受影响: 显式 max_output_chars 照截', async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, 'a.js');
      const body = Array.from({ length: 900 }, (_, i) => `const v${i + 1} = ${'y'.repeat(40)};`).join('\n') + '\n';
      await fs.writeFile(file, body, 'utf8');
      const tool = readfileTool(dir);
      const capped = await tool.function({ path: file, max_output_chars: 3000 } as any, {} as any) as string;
      expect(capped).not.toContain('const v900 =');
    });
  });
});

/* paths=[...] 一次读多个 : 并行不依赖模型意愿。每个文件仍走单文件路径 (账本照旧登记)。 */
describe('readfile paths=[...] 一次读多个', () => {
  it('分段返回, 各自进读账本, 超过 8 个截断并提示', async () => {
    await withTempDir(async (dir) => {
      const names = Array.from({ length: 9 }, (_, i) => `f${i}.ts`);
      for (const n of names) await fs.writeFile(path.join(dir, n), `export const ${n.replace('.ts', '')} = 1;\n`, 'utf8');
      const tool = readfileTool(dir);
      const out = await tool.function({ paths: names.map(n => path.join(dir, n)) } as any, {} as any) as string;
      expect(out).toContain('══════ ' + path.join(dir, 'f0.ts'));
      expect(out).toContain('export const f7 = 1;');
      expect(out).not.toContain('export const f8 = 1;');
      expect(out).toContain('还有 1 个文件没读');
      /* 第二次读 f0 → 照旧给正文 */
      const again = await tool.function({ path: path.join(dir, 'f0.ts') } as any, {} as any) as string;
      expect(again).not.toMatch(/未变化/);
      expect(again).toContain('export const f0 = 1;');
    });
  });
});
