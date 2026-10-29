
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';

// ==================== Worktree State ====================

interface WorktreeSession {
  worktreePath: string;
  worktreeBranch: string;
  originalCwd: string;
  sessionId: string;
  createdAt: number;
}

let currentWorktreeSession: WorktreeSession | null = null;

export function getCurrentWorktreeSession(): WorktreeSession | null {
  return currentWorktreeSession;
}

export function isInWorktree(): boolean {
  return currentWorktreeSession !== null;
}

// Callback for notifying UI of worktree changes
let onWorktreeChange: ((session: WorktreeSession | null) => void) | null = null;
export function setWorktreeChangeCallback(callback: ((session: WorktreeSession | null) => void) | null): void {
  onWorktreeChange = callback;
}

// ==================== Git Helpers ====================

function execGit(args: string[], cwd?: string): string {
  try {
    return execFileSync('git', args, {
      cwd: cwd || process.cwd(),
      encoding: 'utf-8',
      timeout: 30_000,
    }).trim();
  } catch (error: any) {
    throw new Error(`git ${args.join(' ')} failed: ${error.message}`);
  }
}

function findGitRoot(cwd?: string): string | null {
  try {
    return execGit(['rev-parse', '--show-toplevel'], cwd);
  } catch {
    return null;
  }
}

function validateSlug(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name);
}

function generateWorktreePath(gitRoot: string, slug: string): string {
  // Place worktrees in a sibling directory
  const parentDir = path.dirname(gitRoot);
  const repoName = path.basename(gitRoot);
  return path.join(parentDir, `.${repoName}-worktrees`, slug);
}

function countWorktreeChanges(worktreePath: string): { files: number; commits: number } | null {
  try {
    const statusOutput = execGit(['status', '--porcelain'], worktreePath);
    const files = statusOutput ? statusOutput.split('\n').filter(l => l.trim()).length : 0;

    // Count commits ahead of main branch
    let commits = 0;
    try {
      const mainBranch = execGit(['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], worktreePath).replace('origin/', '');
      const countOutput = execGit(['rev-list', '--count', `${mainBranch}..HEAD`], worktreePath);
      commits = parseInt(countOutput, 10) || 0;
    } catch {
      // Can't determine commit count - that's ok
    }

    return { files, commits };
  } catch {
    return null;
  }
}

// ==================== Tool Definitions ====================

export const enterWorktreeTool: Tool = {
  name: 'enter_worktree',
  description: 'Create an isolated git worktree for making changes without affecting the main working directory. The worktree gets its own branch and working copy. Use this when you want to experiment with changes safely or work on parallel tasks.',
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'unsafe',
  isReadOnly: false,

  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Worktree name (alphanumeric, dots, underscores, dashes; max 64 chars). Used as branch suffix.',
      },
    },
  },

  async function(args: any): Promise<string> {
    // Check not already in worktree
    if (currentWorktreeSession) {
      return JSON.stringify({
        error: 'Already in a worktree',
        worktreePath: currentWorktreeSession.worktreePath,
        worktreeBranch: currentWorktreeSession.worktreeBranch,
      });
    }

    // Find git root
    const gitRoot = findGitRoot();
    if (!gitRoot) {
      return JSON.stringify({ error: 'Not in a git repository' });
    }

    // Generate slug
    const slug = args.name || `neox-${Date.now().toString(36)}`;
    if (!validateSlug(slug)) {
      return JSON.stringify({
        error: 'Invalid worktree name. Use alphanumeric, dots, underscores, dashes (max 64 chars).',
      });
    }

    const branchName = `neox-worktree/${slug}`;
    const worktreePath = generateWorktreePath(gitRoot, slug);

    // Create worktree
    try {
      // Ensure parent directory exists
      const worktreeParent = path.dirname(worktreePath);
      if (!fs.existsSync(worktreeParent)) {
        fs.mkdirSync(worktreeParent, { recursive: true });
      }

      // Create worktree with new branch
      execGit(['worktree', 'add', '-b', branchName, worktreePath], gitRoot);

      // Save state
      const originalCwd = process.cwd();
      currentWorktreeSession = {
        worktreePath,
        worktreeBranch: branchName,
        originalCwd,
        sessionId: slug,
        createdAt: Date.now(),
      };

      // Switch working directory
      process.chdir(worktreePath);

      if (onWorktreeChange) {
        onWorktreeChange(currentWorktreeSession);
      }

      return JSON.stringify({
        worktreePath,
        worktreeBranch: branchName,
        message: `Created worktree at ${worktreePath} on branch ${branchName}. Working directory changed.`,
      });
    } catch (error: any) {
      return JSON.stringify({
        error: `Failed to create worktree: ${error.message}`,
      });
    }
  },
};

export const exitWorktreeTool: Tool = {
  name: 'exit_worktree',
  description: 'Exit the current git worktree. Choose to keep the worktree and branch for later, or remove them entirely. If removing with uncommitted changes, you must explicitly set discard_changes to true.',
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'unsafe',
  isReadOnly: false,

  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['keep', 'remove'],
        description: 'Whether to keep the worktree for later or remove it entirely',
      },
      discard_changes: {
        type: 'boolean',
        description: 'Required true to remove a worktree with uncommitted changes',
      },
    },
    required: ['action'],
  },

  async function(args: any): Promise<string> {
    const { action, discard_changes = false } = args;

    if (!currentWorktreeSession) {
      return JSON.stringify({ error: 'Not in a worktree' });
    }

    const session = currentWorktreeSession;
    const { worktreePath, worktreeBranch, originalCwd } = session;

    if (action === 'remove') {
      // Check for uncommitted changes
      const changes = countWorktreeChanges(worktreePath);
      if (changes && (changes.files > 0 || changes.commits > 0) && !discard_changes) {
        return JSON.stringify({
          error: 'Worktree has uncommitted changes or unpushed commits',
          files: changes.files,
          commits: changes.commits,
          hint: 'Set discard_changes=true to force removal, or use action="keep" to preserve the worktree',
        });
      }

      // Restore original directory first
      process.chdir(originalCwd);

      // Remove worktree
      try {
        const gitRoot = findGitRoot(originalCwd);
        if (gitRoot) {
          execGit(['worktree', 'remove', worktreePath, '--force'], gitRoot);
          // Delete the branch too
          try {
            execGit(['branch', '-D', worktreeBranch], gitRoot);
          } catch {
            // Branch deletion is non-fatal
          }
        }
      } catch {
        // Manual cleanup
        try {
          fs.rmSync(worktreePath, { recursive: true, force: true });
        } catch {
          // Best effort
        }
      }

      currentWorktreeSession = null;
      if (onWorktreeChange) onWorktreeChange(null);

      return JSON.stringify({
        action: 'remove',
        originalCwd,
        worktreePath,
        worktreeBranch,
        discardedFiles: changes?.files || 0,
        discardedCommits: changes?.commits || 0,
        message: `Removed worktree at ${worktreePath}. Returned to ${originalCwd}.`,
      });
    }

    // action === 'keep'
    process.chdir(originalCwd);
    currentWorktreeSession = null;
    if (onWorktreeChange) onWorktreeChange(null);

    return JSON.stringify({
      action: 'keep',
      originalCwd,
      worktreePath,
      worktreeBranch,
      message: `Kept worktree at ${worktreePath} on branch ${worktreeBranch}. Returned to ${originalCwd}. You can resume later with enter_worktree.`,
    });
  },
};
