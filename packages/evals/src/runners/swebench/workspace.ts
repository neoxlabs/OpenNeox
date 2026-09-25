/**
 * SWE-bench workspace 准备 + 收尾.
 *
 *   每个 task 需要一个隔离的工作目录, 上面是目标 repo 在 base_commit 时的状态.
 *   策略:
 *     · 全局缓存目录 ~/.neox-evals/repos-cache/<owner>__<repo>/  (整 repo 共享 .git)
 *     · 每个 task 用 git worktree 在 ~/.neox-evals/runs/<run_id>/<instance_id>/ 拉一份
 *       checkout 到 base_commit. worktree 比 clone 几十倍快, 仅占 working tree 的盘.
 *   做完 task → git diff HEAD 抽 patch, 再 worktree remove 清掉.
 *
 *   重复跑同任务: cache 命中只跑一次 fetch; worktree remove 后下次 add 是秒级.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { execa } from 'execa';
import type { SweBenchTask } from './types.js';

export interface WorkspaceLayout {
  /** 整 repo 缓存 (含 .git), e.g. ~/.neox-evals/repos-cache/astropy__astropy */
  cacheDir: string;
  /** task 专用工作目录 (worktree), e.g. ~/.neox-evals/runs/<run>/<instance_id> */
  workDir: string;
  /** 用于本次 run 的 root, 便于一次性清理 */
  runRoot: string;
}

interface PrepareOptions {
  /** run 标识 — 同一次 evals 多任务共享 runRoot, 失败/中断后可整体清理 */
  runId: string;
  /** 自定义 cache root; 默认 ~/.neox-evals/ */
  evalsHome?: string;
  /** 自定义 git binary 路径, 默认 'git' */
  gitPath?: string;
  /** clone/fetch 默认走的 base url, 默认 https://github.com/. 国内可改 https://gitcode.com/ 等镜像 */
  githubBase?: string;
}

function defaultEvalsHome(): string {
  return path.join(os.homedir(), '.neox-evals');
}

function repoCacheName(repo: string): string {
  /* "astropy/astropy" → "astropy__astropy" — 跟 SWE-bench instance_id 前缀的命名风格一致, 文件系统安全 */
  return repo.replace(/\//g, '__');
}

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function ensureRepoCache(
  repo: string,
  cacheDir: string,
  opts: { gitPath: string; githubBase: string },
): Promise<void> {
  if (await exists(path.join(cacheDir, '.git'))) {
    /* 已有缓存 → 拉一下最新 (确保有 base_commit 这个 SHA) */
    process.stderr.write(`[swebench-workspace] fetch existing cache ${cacheDir}\n`);
    await execa(opts.gitPath, ['fetch', '--all', '--quiet'], { cwd: cacheDir, reject: false, timeout: 300_000 });
    return;
  }
  /* 首次 clone — 用 --bare 还是 --filter? --bare 不能 worktree; --filter=blob:none 是浅 blob, 大幅减少传输,
   * worktree add 时 checkout 才真拉 blob. SWE-bench 单 repo 200-500MB → 用 blob:none 省 80%. */
  const url = `${opts.githubBase.replace(/\/$/, '')}/${repo}.git`;
  process.stderr.write(`[swebench-workspace] cloning ${url} → ${cacheDir} (blobless)\n`);
  await fs.mkdir(path.dirname(cacheDir), { recursive: true });
  await execa(opts.gitPath, ['clone', '--filter=blob:none', '--quiet', url, cacheDir], { timeout: 900_000 });
}

export async function prepareTaskWorkspace(
  task: SweBenchTask,
  opts: PrepareOptions,
): Promise<WorkspaceLayout> {
  const evalsHome = opts.evalsHome ?? defaultEvalsHome();
  const gitPath = opts.gitPath ?? 'git';
  const githubBase = opts.githubBase ?? 'https://github.com';

  const cacheDir = path.join(evalsHome, 'repos-cache', repoCacheName(task.repo));
  const runRoot  = path.join(evalsHome, 'runs', opts.runId);
  const workDir  = path.join(runRoot, task.instance_id);

  await ensureRepoCache(task.repo, cacheDir, { gitPath, githubBase });

  /* 复用路径前先移除已有 worktree，确保任务从干净的 base commit 开始。 */
  if (await exists(workDir)) {
    await execa(gitPath, ['worktree', 'remove', '--force', workDir], { cwd: cacheDir, reject: false });
    await fs.rm(workDir, { recursive: true, force: true });
  }

  await fs.mkdir(runRoot, { recursive: true });
  /* worktree add -f (force) + detach (不创建 branch, 纯 detached HEAD), 直接 checkout base_commit */
  process.stderr.write(`[swebench-workspace] worktree add ${task.instance_id} @ ${task.base_commit.slice(0, 8)}\n`);
  await execa(gitPath, ['worktree', 'add', '--detach', '--force', workDir, task.base_commit], {
    cwd: cacheDir,
    timeout: 300_000,
  });

  return { cacheDir, workDir, runRoot };
}

/**
 * agent 跑完后, 抽出工作区相对 base_commit 的 diff —— 就是它的 "model patch".
 * 走 `git diff HEAD` (worktree 是 detached HEAD at base_commit, 所以 HEAD = base_commit).
 */
export async function extractTaskPatch(
  layout: WorkspaceLayout,
  opts: { gitPath?: string } = {},
): Promise<string> {
  const gitPath = opts.gitPath ?? 'git';
  /* 关键: --binary 保留二进制, --no-color, --no-ext-diff 防外部 diff 工具污染 */
  const result = await execa(
    gitPath,
    ['diff', '--no-color', '--no-ext-diff', '--binary', 'HEAD'],
    { cwd: layout.workDir, maxBuffer: 50 * 1024 * 1024, reject: false },
  );
  if (result.exitCode !== 0 && !result.stdout) {
    throw new Error(`git diff failed: ${result.stderr || result.exitCode}`);
  }
  return result.stdout;
}

/** worktree 收尾 — 删 worktree 目录 + 让缓存里 git 知道它没了 (不然下次 add 报 already exists) */
export async function cleanupTaskWorkspace(
  layout: WorkspaceLayout,
  opts: { gitPath?: string } = {},
): Promise<void> {
  const gitPath = opts.gitPath ?? 'git';
  await execa(gitPath, ['worktree', 'remove', '--force', layout.workDir], { cwd: layout.cacheDir, reject: false });
  /* 防御性: worktree remove 没删干净就硬删 */
  if (await exists(layout.workDir)) {
    await fs.rm(layout.workDir, { recursive: true, force: true });
  }
}
