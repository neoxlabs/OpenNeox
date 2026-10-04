import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { getDescendantPids, isPidAlive } from '@neoxlabs/platform/platform/processTree.js';

/** spawn 一个 shell 子进程 + 它再 fork 一个 sleep 孙进程, 用来测进程树枚举. */
function spawnTreeFixture(): { root: ChildProcess; rootPid: number } {
  /* 用 bash -c 起两层: 当前 shell 是 root, sleep 100 是孙 (& 后台 + 父进程 wait). */
  const root = spawn('bash', ['-c', 'sleep 100 & wait'], {
    detached: false,
    stdio: 'ignore',
  });
  return { root, rootPid: root.pid! };
}

describe('processTree', () => {
  let fixture: ReturnType<typeof spawnTreeFixture> | null = null;

  afterEach(() => {
    if (fixture) {
      try { fixture.root.kill('SIGKILL'); } catch { /* ignore */ }
      fixture = null;
    }
  });

  it('isPidAlive returns true for current process', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('isPidAlive returns false for clearly dead pid', () => {
    /* pid=1 是 init, 一定活. 用一个不可能存在的 pid 测死. */
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(999_999_999)).toBe(false);
  });

  it('getDescendantPids returns empty for non-existent pid', () => {
    expect(getDescendantPids(999_999_999)).toEqual([]);
    expect(getDescendantPids(0)).toEqual([]);
    expect(getDescendantPids(-1)).toEqual([]);
  });

  it('getDescendantPids finds the sleep grandchild of bash -c parent', async () => {
    if (process.platform === 'win32') return; /* unix-only */

    fixture = spawnTreeFixture();
    /* 等一下子让 bash 起 sleep 子进程 */
    await new Promise(r => setTimeout(r, 200));

    const descendants = getDescendantPids(fixture.rootPid);
    /* bash -c 通常会有 1 个 sleep 子. 不严格断言数量 (shell 实现差异), 但至少 ≥ 1. */
    expect(descendants.length).toBeGreaterThanOrEqual(1);
    /* 每个子孙 pid 都应该活着 */
    for (const pid of descendants) {
      expect(isPidAlive(pid)).toBe(true);
    }
    /* root 不应该出现在子孙列表里 */
    expect(descendants).not.toContain(fixture.rootPid);
  }, 5000);
});
