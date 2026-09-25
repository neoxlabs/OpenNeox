/**
 * Worktree 隔离 + 自动清理测试 (Team P1)
 *
 * 覆盖: createAgentWorktree 显式 cwd (不 process.chdir) / finishAgentWorktree
 *   自动清理 (无改动删 + 分支删; 有改动保留 + 注记带分支名) /
 *   cleanupWorktree(agentId) Team 合并后强删 / explore isolation=worktree
 *   走 workDirOverride 不污染进程 cwd。
 *
 * 用真实临时 git repo — worktree 行为没法有意义地 mock。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createAgentWorktree,
  finishAgentWorktree,
  registerAgentWorktree,
  cleanupWorktree,
} from '../agentTool.js';
import { createAgenticModeTools } from '../agenticModeTools.js';
import { BackgroundAgentManager } from '../backgroundAgent.js';
import { PermissionManager } from '@neoxlabs/kernel/core/permissions/index.js';
import { ToolPermission } from '@neoxlabs/kernel/types/permissions.js';
import { ShortTermMemory as STM } from '@neoxlabs/kernel/memory/shortterm.js';

let repoDir: string;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 10_000 }).trim();
}

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-wt-test-'));
  git(['init'], repoDir);
  git(['config', 'user.email', 'test@neox.local'], repoDir);
  git(['config', 'user.name', 'neox-test'], repoDir);
  git(['config', 'commit.gpgsign', 'false'], repoDir);
  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'hello');
  git(['add', '.'], repoDir);
  git(['commit', '-m', 'init'], repoDir);
});

afterEach(() => {
  /* worktree 目录建在 gitRoot 的父目录下 (realpath — macOS /var → /private/var) */
  try {
    const real = fs.realpathSync(repoDir);
    const wtParent = path.join(path.dirname(real), `.${path.basename(real)}-worktrees`);
    fs.rmSync(wtParent, { recursive: true, force: true });
  } catch { /* 已被用例自己清掉 */ }
  fs.rmSync(repoDir, { recursive: true, force: true });
});

describe('agent worktree 自动清理', () => {
  it('无改动: finish 删 worktree + 分支, 进程 cwd 全程不变', async () => {
    const cwdBefore = process.cwd();
    const info = await createAgentWorktree(repoDir);
    expect(info).not.toBeNull();
    expect(fs.existsSync(info!.path)).toBe(true);
    expect(process.cwd()).toBe(cwdBefore); // 创建不 chdir
    registerAgentWorktree('Agent-1', info!);

    const note = finishAgentWorktree('Agent-1', info!);
    expect(note).toBe(''); // 无改动 → 无注记
    expect(fs.existsSync(info!.path)).toBe(false); // worktree 已删
    expect(process.cwd()).toBe(cwdBefore); // 清理也不 chdir
    expect(git(['branch', '--list', info!.branch], repoDir)).toBe(''); // 分支已删
    expect(cleanupWorktree('Agent-1')).toBe(false); // 已出注册表
  });

  it('有改动: finish 保留 + 注记带路径和分支名; cleanupWorktree(agentId) 合并后强删', async () => {
    const info = await createAgentWorktree(repoDir);
    expect(info).not.toBeNull();
    registerAgentWorktree('Agent-2', info!);
    fs.writeFileSync(path.join(info!.path, 'result.txt'), 'agent work');

    const note = finishAgentWorktree('Agent-2', info!);
    expect(note).toContain(info!.path);
    expect(note).toContain(info!.branch);
    expect(fs.existsSync(info!.path)).toBe(true); // 保留待合并

    expect(cleanupWorktree('Agent-2')).toBe(true); // Team 合并后调用
    expect(fs.existsSync(info!.path)).toBe(false);
    expect(git(['branch', '--list', info!.branch], repoDir)).toBe('');
    expect(cleanupWorktree('Agent-2')).toBe(false); // 幂等
  });

  it('非 git 目录 → createAgentWorktree 返回 null (降级共享 workspace)', async () => {
    const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-plain-'));
    try {
      expect(await createAgentWorktree(plainDir)).toBeNull();
    } finally {
      fs.rmSync(plainDir, { recursive: true, force: true });
    }
  });
});

describe('explore isolation=worktree (chdir 污染修复)', () => {
  it('worktree 路径走 workDirOverride 传给子会话, 进程 cwd 不变', async () => {
    let capturedWorkDir: string | undefined;
    const runSession = vi.fn(async ({ buildHostConfig }: any) => {
      const cfg = buildHostConfig({}, {});
      capturedWorkDir = cfg.workDir;
      return {
        summary: {
          output: 'ok', totalTokens: 0, durationMs: 1, iterations: 1,
          toolCalls: 0, interrupted: false, failed: false,
        },
        contextUsed: 0,
        providerId: 'test-provider',
      };
    });

    const cwdBefore = process.cwd();
    const tools = createAgenticModeTools({
      orchestrator: { runSession } as any,
      providerId: 'test-provider',
      modelName: 'test-model',
      permissionManager: new PermissionManager({ defaultPermission: ToolPermission.ALLOW }),
      allTools: [],
      workDir: repoDir,
      getParentMemory: () => new STM(),
      backgroundManager: new BackgroundAgentManager(),
    });
    const explore = tools.find(t => t.name === 'explore')!;

    const out = await explore.function({ prompt: 'look around', isolation: 'worktree' });

    expect(process.cwd()).toBe(cwdBefore); // 全程不 chdir — 并发 explore 互不污染
    expect(capturedWorkDir).toBeDefined();
    /* 子会话工作目录 = worktree, 不是主 workspace */
    expect(capturedWorkDir).not.toBe(repoDir);
    expect(capturedWorkDir).toContain('-worktrees');
    /* explore 只读无改动 → worktree 已被自动清理, 输出不带 worktree 注记 */
    expect(out).toBe('ok');
    expect(fs.existsSync(capturedWorkDir!)).toBe(false);
  });
});
