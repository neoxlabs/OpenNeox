import { describe, expect, it, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ShadowGitCheckpoint } from '../checkpoint/ShadowGitCheckpoint.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

describe('checkpoint volume budget (real shadow git)', () => {
  const root = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'checkpoints');
  const workspaces: string[] = [];

  afterAll(async () => {
    for (const ws of workspaces) {
      await fs.rm(ws, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('超过 5 MB 的文件不进基线, 小文件照常快照', async () => {
    const before = new Set(await fs.readdir(root).catch(() => [] as string[]));
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-volbudget-'));
    workspaces.push(ws);

    await fs.writeFile(path.join(ws, 'a.txt'), 'alpha\n');
    await fs.writeFile(path.join(ws, 'big.bin'), Buffer.alloc(6 * 1024 * 1024, 7));

    const cp = new ShadowGitCheckpoint();
    await cp.init(ws);
    expect(cp.isInitialized()).toBe(true);

    // 基线: 只应把 a.txt 收进去, 6 MB 的 big.bin 被跳过
    await cp.startWatching('s1', 0);

    const after = await fs.readdir(root);
    const repoName = after.find((name) => !before.has(name));
    expect(repoName).toBeTruthy();
    const gitDir = path.join(root, repoName!);

    const tree = execFileSync(
      'git',
      ['--git-dir', gitDir, 'ls-tree', '-r', 'HEAD', '--name-only'],
      { encoding: 'utf-8' },
    );
    expect(tree).toContain('a.txt');
    expect(tree).not.toContain('big.bin');

    /* 第二轮 (改文件 → createCheckpoint) 依赖 chokidar 的事件时序, 单测里会 flaky,
     * 跟本仓既有约定一致: 异步 watcher 时序不进单测。这里只钉住基线预算 ——
     * 那才是把 C 盘吃满的那条路径。 */

    await cp.stopWatching();
    await cp.destroy().catch(() => {});
  }, 60_000);
});
