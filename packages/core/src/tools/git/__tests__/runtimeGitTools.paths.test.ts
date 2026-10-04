/** Git tools resolve repository paths and support repositories nested in the workspace. */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { createRuntimeGitTools } from '../runtimeGitTools.js';
import { getGitRepoRoot, runCommand } from '../commandRunner.js';

async function withRepo(fn: (dir: string, real: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-git-paths-'));
  const real = await fs.realpath(dir);
  try {
    await runCommand('git', ['init', '-q', '-b', 'main'], dir);
    await runCommand('git', ['config', 'user.email', 't@t'], dir);
    await runCommand('git', ['config', 'user.name', 't'], dir);
    await fs.writeFile(path.join(dir, 'a.txt'), 'hello\n');
    await runCommand('git', ['add', '-A'], dir);
    await runCommand('git', ['commit', '-q', '-m', 'init'], dir);
    await fn(dir, real);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function tools(workspaceRoot: string) {
  return createRuntimeGitTools({
    resolveWorkspacePath: (p?: string) => (!p || p === '.' ? workspaceRoot : path.resolve(workspaceRoot, p)),    getWorkspaceRoot: () => workspaceRoot,
    getGitRepoRoot: (cwd) => getGitRepoRoot(cwd),
    runCommand: (c, a, cwd, o) => runCommand(c, a, cwd, o),
  });
}

describe('git 工具的路径口径', () => {
  it('git_blame: 通过符号链接别名路径 (macOS /tmp, /var) 也能对上真实仓库', async () => {
    await withRepo(async (dir, real) => {
      if (dir === real) return; /* 这台机器 tmp 不是符号链接, 现象造不出来 */
      const out = JSON.parse(await tools(dir).gitBlame.function({ file_path: path.join(dir, 'a.txt') } as any, {} as any));
      expect(out.status).toBe('success');
      expect(String(out.content)).toContain('hello');
    });
  });

  it('git_commit: files 只暂存点名的文件, 未跟踪的旁人不带上', async () => {
    await withRepo(async (dir) => {
      await fs.writeFile(path.join(dir, 'a.txt'), 'changed\n');
      await fs.writeFile(path.join(dir, 'stray.txt'), 'untracked\n');
      const out = JSON.parse(await tools(dir).gitCommit.function({ message: 'only a', files: ['a.txt'] } as any, {} as any));
      expect(out.status).toBe('success');
      const status = await runCommand('git', ['status', '--porcelain'], dir);
      expect(status.stdout.trim()).toBe('?? stray.txt');
    });
  });

  it('git_branch / git_commit: path 参数指向工作区里的另一个仓库', async () => {
    await withRepo(async (dir) => {
      const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-git-ws-'));
      try {
        const t = tools(ws);
        const branch = JSON.parse(await t.gitBranch.function({ name: 'feat/x', path: dir } as any, {} as any));
        expect(branch.status).toBe('success');
        expect((await runCommand('git', ['branch', '--list', 'feat/x'], dir)).stdout).toContain('feat/x');

        await fs.writeFile(path.join(dir, 'b.txt'), 'b\n');
        const commit = JSON.parse(await t.gitCommit.function({ message: 'add b', files: ['b.txt'], path: dir } as any, {} as any));
        expect(commit.status).toBe('success');
        expect((await runCommand('git', ['log', '--oneline', '-1'], dir)).stdout).toContain('add b');
      } finally {
        await fs.rm(ws, { recursive: true, force: true });
      }
    });
  });
});
