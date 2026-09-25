import fs from 'fs/promises';
import path from 'path';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { ToolCategory } from '@neoxlabs/kernel/types/permissions.js';
import { createContextualResult, createEphemeralResult } from '@neoxlabs/kernel/core/types/toolResult.js';
import { withNeoxCoAuthor } from '../../runtime/gitCoAuthor.js';

type RunCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
};

type RunCommandFn = (
  command: string,
  args: string[],
  cwd: string,
  options?: { signal?: AbortSignal; timeoutMs?: number }
) => Promise<RunCommandResult>;

type ResolveWorkspacePathFn = (requestedPath?: string) => string;
type GetWorkspaceRootFn = () => string;
type GetGitRepoRootFn = (
  cwd: string,
  signal?: AbortSignal
) => Promise<{ repoRoot?: string | null; error?: string }>;

type CreateRuntimeGitToolsDeps = {
  resolveWorkspacePath: ResolveWorkspacePathFn;
  getWorkspaceRoot: GetWorkspaceRootFn;
  getGitRepoRoot: GetGitRepoRootFn;
  runCommand: RunCommandFn;
};

export function createRuntimeGitTools({
  resolveWorkspacePath,
  getGitRepoRoot,
  runCommand,
}: CreateRuntimeGitToolsDeps): {
  gitStatus: Tool;
  gitDiff: Tool;
  gitBlame: Tool;
  gitBranchList: Tool;
  gitBranch: Tool;
  gitCommit: Tool;
} {
  const gitStatus: Tool = {
    name: 'git_status',
    description: 'Show git status (short by default)',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path inside the repo (default: workspace root)',
        },
        short: {
          type: 'boolean',
          description: 'Use short format (default: true)',
        },
      },
    },
    permission: {
      category: ToolCategory.READ,
      allowInAskMode: true,
    },
    async function({ path: targetPath = '.', short = true }) {
      const cwd = resolveWorkspacePath(targetPath);
      const { repoRoot, error } = await getGitRepoRoot(cwd);
      if (!repoRoot) {
        /* "非 git 仓库"是合法状态, 不是 error — 用户在普通目录跑 git_status 是正常事.
         * 返 success + 明确说明, 让模型不要把这种 expected condition 报告成"内部错误". */
        return JSON.stringify(createContextualResult(
          'git_status',
          'success',
          'Not a git repository',
          `(${cwd} is not inside a git repository — nothing to show)`,
          { metadata: { reason: 'not_a_git_repo', cwd } }
        ));
      }

      const args = ['status'];
      if (short) {
        args.push('-sb');
      }
      const result = await runCommand('git', args, repoRoot);
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();

      if (result.exitCode !== 0) {
        return JSON.stringify(createContextualResult(
          'git_status',
          'error',
          'git status failed',
          output || undefined,
          { error: output || 'git status failed' }
        ));
      }

      return JSON.stringify(createContextualResult(
        'git_status',
        'success',
        output ? 'git status ok' : 'git status clean',
        output || '✓ clean'
      ));
    },
  };

  const gitDiff: Tool = {
    name: 'git_diff',
    description: 'Show git diff',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path inside the repo (default: workspace root)',
        },
        staged: {
          type: 'boolean',
          description: 'Show staged diff (default: false)',
        },
        file_path: {
          type: 'string',
          description: 'Limit diff to a specific file (must be a file, not a directory or repo root; omit to diff the whole repo)',
        },
      },
    },
    permission: {
      category: ToolCategory.READ,
      allowInAskMode: true,
    },
    async function({ path: targetPath = '.', staged = false, file_path }) {
      const cwd = resolveWorkspacePath(targetPath);
      const { repoRoot, error } = await getGitRepoRoot(cwd);
      if (!repoRoot) {
        /* 非 git 仓库 = 合法状态 (不是错误). success + 说明, 避免模型误报"内部错误". */
        return JSON.stringify(createContextualResult(
          'git_diff',
          'success',
          'Not a git repository',
          `(${cwd} is not inside a git repository — no diff to show)`,
          { metadata: { reason: 'not_a_git_repo', cwd } }
        ));
      }

      const args = ['diff'];
      if (staged) {
        args.push('--staged');
      }
      if (file_path) {
        const fileAbs = resolveWorkspacePath(file_path);
        const relPath = path.relative(repoRoot, fileAbs);
        if (relPath.startsWith('..') || path.isAbsolute(relPath)) {
          return JSON.stringify(createContextualResult(
            'git_diff',
            'error',
            'File is not tracked by any git repository',
            `(${fileAbs} lies outside ${repoRoot} — git has no history for it)`,
            { error: 'file outside repo', precondition: true }
          ));
        }
        if (relPath !== '') {
          args.push('--', relPath);
        }
      }

      const result = await runCommand('git', args, repoRoot);
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
      if (result.exitCode !== 0) {
        return JSON.stringify(createContextualResult(
          'git_diff',
          'error',
          'git diff failed',
          output || undefined,
          { error: output || 'git diff failed' }
        ));
      }

      return JSON.stringify(createContextualResult(
        'git_diff',
        'success',
        output ? 'git diff ok' : 'no diff',
        output || ''
      ));
    },
  };

  const gitBlame: Tool = {
    name: 'git_blame',
    description: 'Show git blame for a file',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'File path to blame (required)',
        },
        start_line: {
          type: 'number',
          description: 'Start line (1-based)',
        },
        end_line: {
          type: 'number',
          description: 'End line (1-based)',
        },
      },
      required: ['file_path'],
    },
    permission: {
      category: ToolCategory.READ,
      allowInAskMode: true,
    },
    async function({ file_path, start_line, end_line }) {
      if (!file_path) {
        return JSON.stringify(createContextualResult(
          'git_blame',
          'error',
          'git blame failed: file_path is required',
          undefined,
          { error: 'file_path is required' }
        ));
      }
      const requested = resolveWorkspacePath(file_path);
      const fileAbs = await fs.realpath(requested).catch(() => requested);

      const { repoRoot, error } = await getGitRepoRoot(path.dirname(fileAbs));
      if (!repoRoot) {
        /* 非 git 仓库 = 合法状态. success + 说明, 不报"内部错误". */
        return JSON.stringify(createContextualResult(
          'git_blame',
          'success',
          'Not a git repository',
          `(${fileAbs} is not inside a git repository — no blame to show)`,
          { metadata: { reason: 'not_a_git_repo', file: fileAbs } }
        ));
      }

      const range = (start_line && end_line) ? `${start_line},${end_line}` : undefined;
      const relPath = path.relative(repoRoot, fileAbs);
      if (relPath.startsWith('..') || path.isAbsolute(relPath)) {
        return JSON.stringify(createContextualResult(
          'git_blame',
          'error',
          'File is not tracked by any git repository',
          `(${fileAbs} lies outside ${repoRoot} — no blame history exists)`,
          { error: 'file outside repo', precondition: true }
        ));
      }
      const args = ['blame', '--', relPath];
      if (range) {
        args.splice(1, 0, `-L`, range);
      }

      const result = await runCommand('git', args, repoRoot);
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
      if (result.exitCode !== 0) {
        return JSON.stringify(createContextualResult(
          'git_blame',
          'error',
          'git blame failed',
          output || undefined,
          { error: output || 'git blame failed' }
        ));
      }

      return JSON.stringify(createContextualResult(
        'git_blame',
        'success',
        'git blame ok',
        output || ''
      ));
    },
  };

  const gitBranchList: Tool = {
    name: 'git_branch_list',
    description: 'List git branches',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path inside the repo (default: workspace root)',
        },
        all: {
          type: 'boolean',
          description: 'Include remote branches (default: false)',
        },
      },
    },
    permission: {
      category: ToolCategory.READ,
      allowInAskMode: true,
    },
    async function({ path: targetPath = '.', all = false }) {
      const cwd = resolveWorkspacePath(targetPath);
      const { repoRoot, error } = await getGitRepoRoot(cwd);
      if (!repoRoot) {
        /* 非 git 仓库 = 合法状态. success + 说明, 不报"内部错误". */
        return JSON.stringify(createContextualResult(
          'git_branch_list',
          'success',
          'Not a git repository',
          `(${cwd} is not inside a git repository — no branches to list)`,
          { metadata: { reason: 'not_a_git_repo', cwd } }
        ));
      }

      const args = ['branch', '--list'];
      if (all) {
        args.push('--all');
      }
      const result = await runCommand('git', args, repoRoot);
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
      if (result.exitCode !== 0) {
        return JSON.stringify(createContextualResult(
          'git_branch_list',
          'error',
          'git branch failed',
          output || undefined,
          { error: output || 'git branch failed' }
        ));
      }

      let displayOutput = output;
      let summary = 'git branches';
      if (!displayOutput) {
        const headResult = await runCommand('git', ['symbolic-ref', '--short', 'HEAD'], repoRoot);
        const currentBranch = [headResult.stdout, headResult.stderr].filter(Boolean).join('\n').trim();
        if (headResult.exitCode === 0 && currentBranch) {
          displayOutput = `* ${currentBranch} (current, no commits yet)`;
          summary = 'git branches (no commits yet)';
        } else {
          displayOutput = '(no branches found)';
          summary = 'git branches empty';
        }
      }

      return JSON.stringify(createContextualResult(
        'git_branch_list',
        'success',
        summary,
        displayOutput
      ));
    },
  };

  const gitBranch: Tool = {
    name: 'git_branch',
    description: 'Create a git branch',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Branch name to create',
        },
        checkout: {
          type: 'boolean',
          description: 'Checkout after creation (default: false)',
        },
        path: {
          type: 'string',
          description: 'Path inside the target repo (default: workspace root). Use it when the repo is not the workspace itself.',
        },
      },
      required: ['name'],
    },
    permission: {
      category: ToolCategory.WRITE,
      allowInAskMode: false,
    },
    async function({ name, checkout = false, path: targetPath }) {
      const workspaceRoot = resolveWorkspacePath(typeof targetPath === 'string' ? targetPath : '.');
      const { repoRoot } = await getGitRepoRoot(workspaceRoot);
      if (!repoRoot) {
        return JSON.stringify(createEphemeralResult(
          'git_branch',
          'error',
          `This workspace is not a git repository — run \`git init\` in ${workspaceRoot} first if you want version control`,
          { error: 'not_a_git_repo', precondition: true, metadata: { reason: 'not_a_git_repo', cwd: workspaceRoot } }
        ));
      }

      if (!name) {
        return JSON.stringify(createEphemeralResult(
          'git_branch',
          'error',
          'Branch name is required (use git_branch_list to list branches)',
          { error: 'name is required' }
        ));
      }

      const safeName = typeof name === 'string' ? name.trim() : '';
      const validName = /^[A-Za-z0-9._\\/-]+$/.test(safeName);
      if (!safeName || !validName || safeName.includes('..') || safeName.startsWith('/') || safeName.endsWith('/')) {
        return JSON.stringify(createEphemeralResult(
          'git_branch',
          'error',
          'Invalid branch name',
          { error: 'Invalid branch name' }
        ));
      }

      const createArgs = ['branch', safeName];
      const createResult = await runCommand('git', createArgs, repoRoot);
      if (createResult.exitCode !== 0) {
        const errorOutput = [createResult.stdout, createResult.stderr].filter(Boolean).join('\n').trim();
        return JSON.stringify(createEphemeralResult(
          'git_branch',
          'error',
          'Failed to create branch',
          { error: errorOutput || 'Failed to create branch' }
        ));
      }

      if (checkout) {
        const checkoutResult = await runCommand('git', ['checkout', safeName], repoRoot);
        if (checkoutResult.exitCode !== 0) {
          const errorOutput = [checkoutResult.stdout, checkoutResult.stderr].filter(Boolean).join('\n').trim();
          return JSON.stringify(createEphemeralResult(
            'git_branch',
            'error',
            'Branch created but checkout failed',
            { error: errorOutput || 'Checkout failed' }
          ));
        }
      }

      return JSON.stringify(createEphemeralResult(
        'git_branch',
        'success',
        checkout ? `Branch created and checked out: ${safeName}` : `Branch created: ${safeName}`,
        { metadata: { branch: safeName, checkout } }
      ));
    },
  };

  const gitCommit: Tool = {
    name: 'git_commit',
    description: 'Create a git commit',
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Commit message',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files to stage before committing (relative to path, or absolute). Prefer this over add_all — it commits exactly what you changed.',
        },
        add_all: {
          type: 'boolean',
          description: 'Run git add -A before commit (default: false). Stages EVERYTHING in the repo, including untracked files you did not touch — only use it when that is really what you want.',
        },
        path: {
          type: 'string',
          description: 'Path inside the target repo (default: workspace root). Use it when the repo is not the workspace itself.',
        },
      },
      required: ['message'],
    },
    permission: {
      category: ToolCategory.WRITE,
      allowInAskMode: false,
    },
    async function({ message, add_all = false, files, path: targetPath }) {
      const workspaceRoot = resolveWorkspacePath(typeof targetPath === 'string' ? targetPath : '.');
      const { repoRoot } = await getGitRepoRoot(workspaceRoot);
      if (!repoRoot) {
        return JSON.stringify(createEphemeralResult(
          'git_commit',
          'error',
          `This workspace is not a git repository — nothing to commit into (run \`git init\` in ${workspaceRoot} first)`,
          { error: 'not_a_git_repo', precondition: true, metadata: { reason: 'not_a_git_repo', cwd: workspaceRoot } }
        ));
      }

      const msg = typeof message === 'string' ? message.trim() : '';
      if (!msg || msg.length < 3) {
        return JSON.stringify(createEphemeralResult(
          'git_commit',
          'error',
          'Commit message is too short',
          { error: 'Commit message is too short' }
        ));
      }

      /* 只暂存点名的文件 —— 相对路径按 path 参数所在目录解析, 所以命令在 workspaceRoot 跑
       * 而不是 repoRoot; git 从子目录执行 add/commit 完全没问题。 */
      const fileList = Array.isArray(files) ? files.map(f => String(f).trim()).filter(Boolean) : [];
      if (fileList.length > 0) {
        const addResult = await runCommand('git', ['add', '--', ...fileList], workspaceRoot);
        if (addResult.exitCode !== 0) {
          const errorOutput = [addResult.stdout, addResult.stderr].filter(Boolean).join('\n').trim();
          return JSON.stringify(createEphemeralResult(
            'git_commit',
            'error',
            'git add failed',
            { error: errorOutput || 'git add failed', metadata: { files: fileList } }
          ));
        }
      } else if (add_all) {
        const addResult = await runCommand('git', ['add', '-A'], repoRoot);
        if (addResult.exitCode !== 0) {
          const errorOutput = [addResult.stdout, addResult.stderr].filter(Boolean).join('\n').trim();
          return JSON.stringify(createEphemeralResult(
            'git_commit',
            'error',
            'git add -A failed',
            { error: errorOutput || 'git add failed' }
          ));
        }
      }

      const commitResult = await runCommand('git', ['commit', '-m', withNeoxCoAuthor(msg)], repoRoot);
      if (commitResult.exitCode !== 0) {
        const errorOutput = [commitResult.stdout, commitResult.stderr].filter(Boolean).join('\n').trim();
        return JSON.stringify(createEphemeralResult(
          'git_commit',
          'error',
          'git commit failed',
          { error: errorOutput || 'git commit failed' }
        ));
      }

      return JSON.stringify(createEphemeralResult(
        'git_commit',
        'success',
        `Commit created: ${msg}`,
        { metadata: { message: msg } }
      ));
    },
  };

  return {
    gitStatus,
    gitDiff,
    gitBlame,
    gitBranchList,
    gitBranch,
    gitCommit,
  };
}
