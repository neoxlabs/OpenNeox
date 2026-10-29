/**
 * execute_shell accepts an explicit cwd so commands can target workspace
 * subdirectories without embedding redundant cd prefixes.
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { resolveShellCwd } from '../shellCwd.js';

async function withDirs(fn: (root: string, sub: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-shell-cwd-'));
  const sub = path.join(root, 'packages', 'app');
  await fs.mkdir(sub, { recursive: true });
  try {
    await fn(root, sub);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe('resolveShellCwd', () => {
  it('不传 → 工作区根目录 (老行为零变化)', async () => {
    await withDirs(async (root) => {
      expect(resolveShellCwd(undefined, root)).toEqual({ dir: root });
      expect(resolveShellCwd('', root)).toEqual({ dir: root });
      expect(resolveShellCwd('   ', root)).toEqual({ dir: root });
    });
  });

  it('相对路径 → 相对工作区根目录', async () => {
    await withDirs(async (root, sub) => {
      expect(resolveShellCwd('packages/app', root).dir).toBe(sub);
      expect(resolveShellCwd('./packages/app', root).dir).toBe(sub);
    });
  });

  it('绝对路径原样用 (agent 有时确实要去 /tmp 跑脚本)', async () => {
    await withDirs(async (root, sub) => {
      expect(resolveShellCwd(sub, root).dir).toBe(sub);
    });
  });

  it('目录不存在 / 不是目录 → 报错, 不静默跑到别处', async () => {
    await withDirs(async (root) => {
      const missing = resolveShellCwd('packages/nope', root);
      expect(missing.error).toContain('cwd 不存在');
      expect(missing.dir).toBe(root);              /* 兜底值是根目录, 但调用方看到 error 就不执行 */

      const file = path.join(root, 'a.txt');
      await fs.writeFile(file, 'x');
      const notDir = resolveShellCwd('a.txt', root);
      expect(notDir.error).toContain('不是目录');
    });
  });
});
