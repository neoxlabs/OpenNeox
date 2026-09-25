/**
 * Search accepts the natural plural `patterns` alias.
 *
 * The alias is normalized to the same keyword list as pattern, query,
 * keywords, and queries.
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { createRuntimeSearchTool } from '../runtimeSearchTool.js';

async function withWorkspace(fn: (dir: string, tool: ReturnType<typeof createRuntimeSearchTool>) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-search-alias-'));
  try {
    await fs.writeFile(path.join(dir, 'pet.ts'), 'export const 宠物 = "alpha";\n', 'utf8');
    await fs.writeFile(path.join(dir, 'other.ts'), 'export const unrelated = 1;\n', 'utf8');
    const tool = createRuntimeSearchTool({
      resolveWorkspacePath: (p?: string) => (p ? path.resolve(dir, p) : dir),
      formatDisplayPath: (p: string) => path.relative(dir, p) || '.',
      getWorkspaceRoot: () => dir,
      /* 不让它找到 ripgrep —— 单测不依赖外部二进制, 走 JS 兜底那条路 */
      runCommand: (async () => { throw new Error('no rg in test'); }) as any,
      logger: { info() {}, warn() {}, debug() {}, error() {} } as any,
    } as any);
    await fn(dir, tool);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/* search 没有 JS 兜底: 拿不到 ripgrep 就报 "ripgrep not available"。
 * 所以判据是**参数有没有被收下** —— 修复前这里是 "no query provided" (查询都没组起来),
 * 修复后走到了执行阶段。不依赖本机装没装 rg。 */
describe('search patterns[] 别名', () => {
  it('patterns 当 keywords 用 —— 不再卡在 "no query provided"', async () => {
    await withWorkspace(async (dir, tool) => {
      const out = String(await tool.function({ patterns: ['alpha', '宠物'], path: dir } as any, {} as any));
      expect(out).not.toContain('no query provided');
      expect(out).toMatch(/ripgrep|matches|搜索/);
    });
  });

  it('keywords 和 patterns 同时给 → 合并, 同样不报缺查询', async () => {
    await withWorkspace(async (dir, tool) => {
      const out = String(await tool.function({ keywords: ['alpha'], patterns: ['alpha', 'unrelated'], path: dir } as any, {} as any));
      expect(out).not.toContain('no query provided');
    });
  });

  it('一个都不给才报缺查询', async () => {
    await withWorkspace(async (dir, tool) => {
      const out = String(await tool.function({ path: dir } as any, {} as any));
      expect(out).toContain('no query provided');
    });
  });
});
