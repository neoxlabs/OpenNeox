
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

// ─── 类型 ───

export interface WorktreeInfo {
  /** worktree 路径 */
  path: string;
  /** 分支名 */
  branch: string;
  /** 基于哪个 commit 创建 */
  baseCommit: string;
  /** 创建时间 */
  createdAt: number;
  /** 关联的 agent ID */
  agentId?: string;
}

export interface WorktreeResult {
  /** worktree 路径（如果有修改保留了） */
  worktreePath?: string;
  /** 分支名（如果有修改保留了） */
  branch?: string;
  /** 是否有修改 */
  hasChanges: boolean;
  /** 修改的文件列表 */
  changedFiles: string[];
}

// ─── 常量 ───

const WORKTREE_PREFIX = '.neox-tree-';
const WORKTREE_BRANCH_PREFIX = 'neox/agent/';

// ─── 核心函数 ───

/**
 * 创建 worktree — 为 agent 提供隔离的文件空间
 *
 * @param workDir 主工作目录（必须是 git repo）
 * @param agentId agent 标识（用于命名分支）
 * @returns WorktreeInfo 或 null（如果不在 git repo 中）
 */
export function createWorktree(workDir: string, agentId: string): WorktreeInfo | null {
  // 检查是否是 git repo
  if (!isGitRepo(workDir)) {
    cliLogger.warn('WORKTREE', `${workDir} is not a git repository, skipping worktree`);
    return null;
  }

  const shortId = randomUUID().slice(0, 8);
  const branch = `${WORKTREE_BRANCH_PREFIX}${agentId}-${shortId}`;
  const worktreePath = path.join(
    path.dirname(workDir),
    `${WORKTREE_PREFIX}${agentId}-${shortId}`,
  );

  try {
    // 获取当前 HEAD commit
    const baseCommit = execSync('git rev-parse HEAD', {
      cwd: workDir,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();

    // 创建 worktree + 新分支
    execSync(`git worktree add -b "${branch}" "${worktreePath}"`, {
      cwd: workDir,
      encoding: 'utf-8',
      timeout: 10000,
      stdio: 'pipe',
    });

    cliLogger.info('WORKTREE', `Created: ${worktreePath} (branch: ${branch})`);

    return {
      path: worktreePath,
      branch,
      baseCommit,
      createdAt: Date.now(),
      agentId,
    };
  } catch (err: any) {
    cliLogger.error('WORKTREE', `Failed to create worktree: ${err.message}`);
    return null;
  }
}

/**
 * 清理 worktree — 无修改自动删除，有修改保留
 *
 * @returns WorktreeResult 包含修改信息
 */
export function cleanupWorktree(info: WorktreeInfo, workDir: string): WorktreeResult {
  try {
    // 检查是否有未提交的修改
    const status = execSync('git status --porcelain', {
      cwd: info.path,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();

    const changedFiles = status
      ? status.split('\n').map(line => line.slice(3).trim()).filter(Boolean)
      : [];

    const hasChanges = changedFiles.length > 0;

    if (!hasChanges) {
      // 无修改 — 删除 worktree 和分支
      removeWorktree(info, workDir);
      cliLogger.info('WORKTREE', `Cleaned up (no changes): ${info.path}`);
      return { hasChanges: false, changedFiles: [] };
    }

    // 有修改 — 自动提交并保留
    try {
      execSync('git add -A', { cwd: info.path, timeout: 5000, stdio: 'pipe' });
      execSync(`git commit -m "Agent ${info.agentId || 'unknown'} work result"`, {
        cwd: info.path,
        timeout: 10000,
        stdio: 'pipe',
      });
    } catch {
      // commit 可能失败（如空提交）
    }

    cliLogger.info('WORKTREE',
      `Preserved (${changedFiles.length} changes): ${info.path} on branch ${info.branch}`);

    return {
      worktreePath: info.path,
      branch: info.branch,
      hasChanges: true,
      changedFiles,
    };
  } catch (err: any) {
    cliLogger.error('WORKTREE', `Cleanup failed: ${err.message}`);
    return { hasChanges: false, changedFiles: [] };
  }
}

/**
 * 强制删除 worktree（失败回滚场景）
 */
export function removeWorktree(info: WorktreeInfo, workDir: string): void {
  try {
    execSync(`git worktree remove "${info.path}" --force`, {
      cwd: workDir,
      timeout: 10000,
      stdio: 'pipe',
    });
  } catch {
    // 如果 git worktree remove 失败，直接删目录
    try {
      fs.rmSync(info.path, { recursive: true, force: true });
      execSync('git worktree prune', { cwd: workDir, timeout: 5000, stdio: 'pipe' });
    } catch { /* ignore */ }
  }

  // 删除分支
  try {
    execSync(`git branch -D "${info.branch}"`, {
      cwd: workDir,
      timeout: 5000,
      stdio: 'pipe',
    });
  } catch { /* branch may already be gone */ }
}

/**
 * 列出当前活跃的 neox worktree
 */
export function listWorktrees(workDir: string): WorktreeInfo[] {
  try {
    const output = execSync('git worktree list --porcelain', {
      cwd: workDir,
      encoding: 'utf-8',
      timeout: 5000,
    });

    const worktrees: WorktreeInfo[] = [];
    const blocks = output.split('\n\n').filter(Boolean);

    for (const block of blocks) {
      const lines = block.split('\n');
      const wtPath = lines.find(l => l.startsWith('worktree '))?.slice(9);
      const branch = lines.find(l => l.startsWith('branch '))?.slice(7);

      if (wtPath && branch?.includes(WORKTREE_BRANCH_PREFIX)) {
        worktrees.push({
          path: wtPath,
          branch: branch.replace('refs/heads/', ''),
          baseCommit: '',
          createdAt: 0,
        });
      }
    }

    return worktrees;
  } catch {
    return [];
  }
}

/**
 * 清理所有 stale neox worktree（启动时调用）
 */
export function pruneStaleWorktrees(workDir: string): number {
  const worktrees = listWorktrees(workDir);
  let pruned = 0;
  for (const wt of worktrees) {
    // 检查 worktree 目录是否还存在
    if (!fs.existsSync(wt.path)) {
      try {
        execSync('git worktree prune', { cwd: workDir, timeout: 5000, stdio: 'pipe' });
        pruned++;
      } catch { /* ignore */ }
    }
  }
  return pruned;
}

/**
 * 构建 worktree 通知文本（给 agent 的上下文）
 */
export function buildWorktreeNotice(info: WorktreeInfo, parentWorkDir: string): string {
  return [
    '## Worktree Isolation Notice',
    '',
    `You are operating in an isolated git worktree at: ${info.path}`,
    `Your branch: ${info.branch}`,
    `Parent workspace: ${parentWorkDir}`,
    '',
    'Important:',
    '- File paths in your instructions refer to the parent workspace.',
    '- Translate them to your worktree root when reading/writing.',
    '- Your changes are on a separate branch and will NOT affect the main branch.',
    '- If your task fails, your changes will be discarded.',
    '- If your task succeeds, your changes can be reviewed and merged.',
  ].join('\n');
}

// ─── 工具 ───

function isGitRepo(dir: string): boolean {
  try {
    execSync('git rev-parse --git-dir', {
      cwd: dir,
      timeout: 3000,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}
