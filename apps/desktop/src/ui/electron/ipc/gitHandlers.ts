/**
 * Git IPC Handlers —— 给 renderer 提供 git 操作能力
 *
 * 直接调用 git CLI（不依赖 runtimeGitTools，那是 agent 专用的）。
 * 面向 VCS Commit Panel 的需求：status / stage / unstage / commit / diff。
 */

import { ipcMain as bridgedIpcMain } from './ipcMainBridged.js';
import { gitStatusHost } from '../services/gitStatusHost.js';
import { type IpcMainInvokeEvent } from 'electron';
import { execFile, type ExecFileOptions } from 'child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { promisify } from 'util';
import { configService } from '@neoxlabs/platform/platform/configService.js';
import { buildProvider } from '@neoxlabs/core/runtime/runtimeBuilder.js';
import { decodeGitBytes } from '../services/gitEncoding.js';
import { storageService } from '../../../platform-electron/storageService.js';
import { DISTRIBUTION } from '@neoxlabs/kernel/platform/distribution.js';

const execFileAsync = promisify(execFile);

const GIT = 'git';
const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB

/* 全局给 git 命令前置 -c core.quotepath=false:
 * git 默认 core.quotepath=true 会把路径里的非 ASCII 字节转成八进制转义 (如 \346\234\215),
 * 中文/日文等文件名在 VCS 面板显示成乱码. 关掉它让 git 直接输出 UTF-8 原文.
 * (execFile encoding:'utf-8' 已按 UTF-8 解码 stdout, Win/mac/Linux 一致.) */
const QUOTEPATH_OFF = ['-c', 'core.quotepath=false'];

/* git:clone / git:init 的 dest 来自 renderer, 一旦 renderer 被 XSS 就等于任意路径
 * mkdirSync + 写盘. 收敛边界: dest 必须在用户 home 之内, 且不得落在凭据类敏感目录
 * (或其内部). 用 path.relative 判定而非 startsWith, 防 "~/NeoxEvil" 这类前缀绕过. */
const GIT_DEST_FORBIDDEN_SUBDIRS = [
  '.ssh', '.aws', '.gnupg', '.config', path.join('Library', 'Keychains'),
  '.neox',
  /* 同理: Electron 的 userData (会话/缓存/IndexedDB 都在这) */
  path.join('Library', 'Application Support', DISTRIBUTION.appName),
];

/** 校验 clone/init 目标目录. 通过返 resolved 绝对路径; 拒绝返 null (调用方回错误). */
function resolveAllowedGitDest(dest: string): string | null {
  const resolved = path.resolve(dest);
  const home = os.homedir();
  const rel = path.relative(home, resolved);
  /* rel === '' 即 dest 是 home 本身 — git init ~ 会把整个 home 变成仓库, 一并拒绝 */
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  for (const sub of GIT_DEST_FORBIDDEN_SUBDIRS) {
    const subRel = path.relative(path.join(home, sub), resolved);
    if (subRel === '' || (!subRel.startsWith('..') && !path.isAbsolute(subRel))) return null;
  }
  return resolved;
}

function registeredProjectRoots(): string[] {
  try {
    const state = storageService.getCachedUIState();
    const primaries = (state?.workspaces || []).map((w: any) => w?.path).filter(Boolean);
    const out = new Set<string>();
    for (const primary of primaries) {
      for (const root of (storageService.getWorkspaceRootsSync(primary) || [])) {
        if (root) out.add(path.resolve(root));
      }
    }
    return [...out];
  } catch {
    return [];
  }
}

/** cwd 是否落在某个已登记工程根之内 (或就是它)。 */
function isInsideRegisteredWorkspace(cwd: string): boolean {
  if (!cwd || typeof cwd !== 'string') return false;
  const resolved = path.resolve(cwd);
  for (const root of registeredProjectRoots()) {
    const rel = path.relative(root, resolved);
    /* rel === '' 表示 cwd 就是这个根本身, 允许 */
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return true;
  }
  return false;
}

/** 破坏性操作的入口守卫 —— 不通过就抛, 让 renderer 拿到明确错误而不是静默生效。 */
function assertDestructiveAllowed(cwd: string, op: string): void {
  if (isInsideRegisteredWorkspace(cwd)) return;
  throw new Error(
    `${op} 被拒绝: ${cwd} 不在任何已登记的 Neox 工程内。`
    + '这类操作不可逆, 只允许作用于你在 Neox 里打开过的工程。',
  );
}

/** 执行 git 命令，返回 stdout */
/** extraEnv: 给 `rebase --continue` 这类会拉起 $EDITOR 的命令用 —— 没有编辑器可交互时
 *  git 会一直等下去, 表现就是这条 IPC 永远不返回。传 GIT_EDITOR=true 让它直接过。 */
async function git(args: string[], cwd: string, extraEnv?: Record<string, string>): Promise<string> {
  const opts: ExecFileOptions = { cwd, maxBuffer: MAX_BUFFER, encoding: 'utf-8' };
  if (extraEnv) opts.env = { ...process.env, ...extraEnv };
  const { stdout } = await execFileAsync(GIT, [...QUOTEPATH_OFF, ...args], opts);
  return stdout as string;
}

/** 执行 git 命令，返回原始 stdout Buffer (给"文件内容"通道用, 后续 decodeGitBytes 探测编码) */
async function gitBuffer(args: string[], cwd: string): Promise<Buffer> {
  const opts: ExecFileOptions = { cwd, maxBuffer: MAX_BUFFER, encoding: 'buffer' };
  const { stdout } = await execFileAsync(GIT, [...QUOTEPATH_OFF, ...args], opts);
  return stdout as unknown as Buffer;
}

/** 执行 git，返回按文件内容编码解码后的字符串 (diff 正文 / git show 内容) */
async function gitContent(args: string[], cwd: string): Promise<string> {
  return decodeGitBytes(await gitBuffer(args, cwd));
}

/* 解析函数 / 类型 / 状态计算都在 ../git/gitStatusCore (worker 线程也要用, 那边不能带
 * configService 这类主进程依赖)。这里重新导出, 老的 import 路径和测试不用改。 */
export { unquoteGitPath, parseNumstat, countLinesInBuffer } from '../git/gitStatusCore.js';
export type { GitFileStatus, GitStatusResult, GitRepoState } from '../git/gitStatusCore.js';
import {
  unquoteGitPath,
  parseNumstat,
  resolveGitScope,
  readRepoState,
  emptyStatus,
  type GitStatusResult,
} from '../git/gitStatusCore.js';

/** 只读的 git:* 通道。其余通道 (stage / commit / checkout / pull …) 跑完一律让状态缓存失效:
 *  用白名单列"只读"而不是列"会写", 新加的写操作忘了登记时宁可多算一次, 也不给旧状态。 */
const READ_ONLY_GIT_CHANNELS = new Set([
  'git:status', 'git:diff-file', 'git:log', 'git:current-branch', 'git:log-detailed',
  'git:show-commit', 'git:file-at-commit', 'git:diff-commits', 'git:remote-list',
  'git:branch-divergence', 'git:clean-preview', 'git:generate-commit-msg', 'git:refs',
  'git:stash-list', 'git:status-subscribe', 'git:status-unsubscribe', 'git:status-revalidate',
]);

// ────────────────────────────── Register ──────────────────────────────

export function registerGitIpcHandlers(): void {
  /* 本函数内的 ipcMain.handle 都走这层: 写操作结束 (成功或失败都算, 失败也可能改了一半) 后
   * 让同仓的状态缓存 hard 失效。第一个参数是 cwd 的约定所有 git:* 通道一致。 */
  const ipcMain = {
    handle(channel: string, fn: (e: IpcMainInvokeEvent, ...args: any[]) => any): void {
      if (READ_ONLY_GIT_CHANNELS.has(channel)) { bridgedIpcMain.handle(channel, fn as any); return; }
      bridgedIpcMain.handle(channel, (async (e: IpcMainInvokeEvent, ...args: any[]) => {
        try {
          return await fn(e, ...args);
        } finally {
          if (typeof args[0] === 'string' && args[0]) gitStatusHost.invalidate(args[0]);
        }
      }) as any);
    },
  };

  /** git status —— 计算在 gitStatusWorker 线程里 (流式 -z / 超限折叠 / 签名缓存, 见 gitStatusCore)。
   *  路径相对仓库根; pathspec `.` 把列表限在 cwd 子树。
   *  若 cwd 被父仓 ignore → 当作「本项目无 git」, 绝不展示父仓 history.
   *
   *  一次性读取用这个 (如 @git 上下文)。持续显示状态的界面走 git:status-subscribe + 增量推送。
   *  opts.fresh 强制重算 (用户刚切完分支 / 提交). */
  ipcMain.handle('git:status', async (_e, cwd: string, opts?: { fresh?: boolean }): Promise<GitStatusResult> => {
    if (!cwd || typeof cwd !== 'string') return emptyStatus('no-workspace');
    return gitStatusHost.get(cwd, !!opts?.fresh);
  });

  /** 界面开始持续看某个仓库: 返回完整状态, 之后状态变化以 'git:status-changed' 增量推给这个窗口 */
  ipcMain.handle('git:status-subscribe', async (e, cwd: string): Promise<GitStatusResult> => {
    if (!cwd || typeof cwd !== 'string') return emptyStatus('no-workspace');
    return gitStatusHost.subscribe(e.sender.id, e.sender, cwd);
  });

  ipcMain.handle('git:status-unsubscribe', async (e, cwd: string): Promise<void> => {
    if (!cwd || typeof cwd !== 'string') return;
    gitStatusHost.unsubscribe(e.sender.id, cwd);
  });

  /** 复核 (窗口回到前台 / 用户刚做完 git 操作): 有变化走增量推送, 不回传整份状态 */
  ipcMain.handle('git:status-revalidate', async (_e, cwd: string, fresh?: boolean): Promise<void> => {
    if (!cwd || typeof cwd !== 'string') return;
    await gitStatusHost.revalidate(cwd, !!fresh);
  });

  /** git add <paths> */
  ipcMain.handle('git:stage', async (_e, cwd: string, paths: string[]): Promise<void> => {
    if (paths.length === 0) return;
    await git(['add', '--', ...paths], cwd);
  });

  /** git reset HEAD <paths> (unstage) */
  ipcMain.handle('git:unstage', async (_e, cwd: string, paths: string[]): Promise<void> => {
    if (paths.length === 0) return;
    await git(['reset', 'HEAD', '--', ...paths], cwd);
  });

  /** git stage all */
  ipcMain.handle('git:stage-all', async (_e, cwd: string): Promise<void> => {
    await git(['add', '-A'], cwd);
  });

  /** git unstage all */
  ipcMain.handle('git:unstage-all', async (_e, cwd: string): Promise<void> => {
    await git(['reset', 'HEAD'], cwd);
  });

  /** git commit -m <message> */
  ipcMain.handle(
    'git:commit',
    async (_e, cwd: string, message: string, amend = false): Promise<{ hash: string; summary: string }> => {
      const args = ['commit', '-m', message];
      if (amend) args.push('--amend');
      const out = await git(args, cwd);
      // 解析 commit hash
      const match = out.match(/\[[\w/.-]+ ([a-f0-9]+)\]/);
      return { hash: match?.[1] || '', summary: out.trim().split('\n')[0] };
    },
  );

  /** git diff (单个文件，staged 或 unstaged) */
  ipcMain.handle(
    'git:diff-file',
    async (_e, cwd: string, filePath: string, staged: boolean): Promise<string> => {
      const args = ['diff'];
      if (staged) args.push('--cached');
      args.push('--', filePath);
      try {
        return await gitContent(args, cwd);
      } catch {
        return '';
      }
    },
  );

  /** git log --oneline -n <count> */
  ipcMain.handle(
    'git:log',
    async (_e, cwd: string, count = 20): Promise<Array<{ hash: string; message: string }>> => {
      try {
        const raw = await git(['log', `--oneline`, `-n`, String(count)], cwd);
        return raw
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const spaceIdx = line.indexOf(' ');
            return { hash: line.slice(0, spaceIdx), message: line.slice(spaceIdx + 1) };
          });
      } catch {
        return [];
      }
    },
  );

  /** git branch --show-current */
  ipcMain.handle('git:current-branch', async (_e, cwd: string): Promise<string> => {
    try {
      return (await git(['branch', '--show-current'], cwd)).trim();
    } catch {
      return '';
    }
  });

  /** git log 详细版 — 含作者、日期、refs */
  ipcMain.handle(
    'git:log-detailed',
    async (_e, cwd: string, count = 100): Promise<Array<{
      hash: string; shortHash: string; message: string;
      author: string; date: string; dateIso: string; refs: string;
      /** 父提交全 hash。0 个 = 根提交, 1 个 = 普通, ≥2 个 = merge。分支图靠它连线。 */
      parents: string[];
    }>> => {
      try {
        if (!cwd) return [];
        const scope = await resolveGitScope(cwd);
        if (!scope.ok) return [];
        const SEP = '‡';
        const fmt = [`%H`, `%h`, `%s`, `%an`, `%ar`, `%aI`, `%D`, `%P`].join(SEP);
        const raw = await git(['log', '--topo-order', `--format=${fmt}`, `-n`, String(count)], cwd);
        return raw.trim().split('\n').filter(Boolean).map((line) => {
          const [hash, shortHash, message, author, date, dateIso, refs, parents] = line.split(SEP);
          return {
            hash, shortHash, message, author, date,
            dateIso: dateIso || '', refs: refs || '',
            parents: (parents || '').trim() ? (parents as string).trim().split(/\s+/) : [],
          };
        });
      } catch {
        return [];
      }
    },
  );

  /** git show — commit 改动文件列表 (含 +/− 行数, History 行只显文件名) */
  ipcMain.handle(
    'git:show-commit',
    async (_e, cwd: string, hash: string): Promise<{
      hash: string; message: string; author: string; date: string;
      files: Array<{ path: string; status: string; add?: number; del?: number }>;
    }> => {
      try {
        if (!cwd) return { hash, message: '', author: '', date: '', files: [] };
        const scope = await resolveGitScope(cwd);
        if (!scope.ok) return { hash, message: '', author: '', date: '', files: [] };

        const SEP = '‡';
        const fmt = [`%H`, `%s`, `%an`, `%ai`].join(SEP);
        const header = await git(['log', '-1', `--format=${fmt}`, hash], cwd);
        const [h, message, author, date] = header.trim().split(SEP);

        /* name-status → M/A/D/R; numstat → +/− 行数 */
        const [statusRaw, numRaw] = await Promise.all([
          git(['diff-tree', '--no-commit-id', '-r', '--name-status', hash], cwd),
          git(['diff-tree', '--no-commit-id', '-r', '--numstat', hash], cwd),
        ]);

        const stats = parseNumstat(numRaw);
        const files: Array<{ path: string; status: string; add?: number; del?: number }> = [];
        for (const line of statusRaw.split('\n')) {
          if (!line.trim()) continue;
          const tab = line.indexOf('\t');
          if (tab < 0) continue;
          const status = line.slice(0, tab).trim().charAt(0) || 'M';
          let pathPart = line.slice(tab + 1);
          /* rename: R100\told\tnew — 展示新路径 */
          const arrowTab = pathPart.indexOf('\t');
          if (arrowTab >= 0) pathPart = pathPart.slice(arrowTab + 1);
          const filePath = unquoteGitPath(pathPart);
          if (!filePath) continue;
          const st = stats.get(filePath);
          files.push({
            path: filePath,
            status,
            add: st?.add,
            del: st?.del,
          });
        }
        return { hash: h, message, author, date, files };
      } catch {
        return { hash, message: '', author: '', date: '', files: [] };
      }
    },
  );

  /** git show <hash>:<path> — 获取某 commit 的文件内容 */
  ipcMain.handle(
    'git:file-at-commit',
    async (_e, cwd: string, hash: string, filePath: string): Promise<string> => {
      try {
        return await gitContent(['show', `${hash}:${filePath}`], cwd);
      } catch {
        return '';
      }
    },
  );

  /** git diff <hash1> <hash2> -- <path> — 两个 commit 间的 diff */
  ipcMain.handle(
    'git:diff-commits',
    async (_e, cwd: string, hash: string, filePath: string): Promise<{ original: string; modified: string }> => {
      try {
        // parent commit
        const original = await gitContent(['show', `${hash}^:${filePath}`], cwd).catch(() => '');
        const modified = await gitContent(['show', `${hash}:${filePath}`], cwd).catch(() => '');
        return { original, modified };
      } catch {
        return { original: '', modified: '' };
      }
    },
  );

  /** git cherry-pick */
  ipcMain.handle('git:cherry-pick', async (_e, cwd: string, hash: string): Promise<string> => {
    return (await git(['cherry-pick', hash], cwd)).trim();
  });

  ipcMain.handle(
    'git:remote-list',
    async (_e, cwd: string): Promise<Array<{ name: string; url: string }>> => {
      try {
        const out = (await git(['remote', '-v'], cwd)).trim();
        if (!out) return [];
        const seen = new Map<string, string>();
        for (const line of out.split('\n')) {
          /* "origin\thttps://…(fetch)" —— 只取 fetch 那条, push 的通常一样 */
          const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
          if (m && m[3] === 'fetch') seen.set(m[1]!, m[2]!);
        }
        return [...seen].map(([name, url]) => ({ name, url }));
      } catch {
        return [];
      }
    },
  );
  ipcMain.handle('git:remote-add', async (_e, cwd: string, name: string, url: string): Promise<string> => {
    return (await git(['remote', 'add', name, url], cwd)).trim();
  });
  ipcMain.handle('git:remote-set-url', async (_e, cwd: string, name: string, url: string): Promise<string> => {
    return (await git(['remote', 'set-url', name, url], cwd)).trim();
  });
  ipcMain.handle('git:remote-remove', async (_e, cwd: string, name: string): Promise<string> => {
    return (await git(['remote', 'remove', name], cwd)).trim();
  });

  /** git branch -m <old> <new> —— 分支菜单里"重命名"用。
   *  改当前分支时 git 自己就能处理 (不需要先切走)。 */
  ipcMain.handle('git:rename-branch', async (_e, cwd: string, oldName: string, newName: string): Promise<string> => {
    return (await git(['branch', '-m', oldName, newName], cwd)).trim();
  });

  /** 一个分支相对另一个分支领先/落后多少 —— 分支菜单里显示"落后 3 / 领先 1"。
   *  没有可比的上游 (本地独立分支) 时返回 null, UI 就不显示这一行, 不猜。 */
  ipcMain.handle(
    'git:branch-divergence',
    async (_e, cwd: string, branchName: string, baseName: string): Promise<{ ahead: number; behind: number } | null> => {
      try {
        const out = (await git(['rev-list', '--left-right', '--count', `${baseName}...${branchName}`], cwd)).trim();
        const [behind, ahead] = out.split(/\s+/).map(Number);
        if (!Number.isFinite(behind) || !Number.isFinite(ahead)) return null;
        return { ahead, behind };
      } catch {
        return null;
      }
    },
  );

  ipcMain.handle('git:op-abort', async (_e, cwd: string): Promise<string> => {
    const st = await readRepoState(cwd);
    switch (st.kind) {
      case 'rebase': return (await git(['rebase', '--abort'], cwd)).trim();
      case 'merge': return (await git(['merge', '--abort'], cwd)).trim();
      case 'cherry-pick': return (await git(['cherry-pick', '--abort'], cwd)).trim();
      case 'revert': return (await git(['revert', '--abort'], cwd)).trim();
      default: return '';
    }
  });

  ipcMain.handle('git:op-continue', async (_e, cwd: string): Promise<string> => {
    const st = await readRepoState(cwd);
    /* --no-edit: 不然 git 会拉起 $EDITOR 等人写提交说明, 而这里没有终端可交互,
     * 表现就是这条 IPC 永远不返回。 */
    switch (st.kind) {
      case 'rebase': return (await git(['rebase', '--continue'], cwd, { GIT_EDITOR: 'true' })).trim();
      case 'merge': return (await git(['commit', '--no-edit'], cwd)).trim();
      case 'cherry-pick': return (await git(['cherry-pick', '--continue'], cwd, { GIT_EDITOR: 'true' })).trim();
      case 'revert': return (await git(['revert', '--continue'], cwd, { GIT_EDITOR: 'true' })).trim();
      default: return '';
    }
  });

  /** rebase 专属: 跳过当前这条提交 */
  ipcMain.handle('git:op-skip', async (_e, cwd: string): Promise<string> => {
    const st = await readRepoState(cwd);
    if (st.kind === 'rebase') return (await git(['rebase', '--skip'], cwd)).trim();
    if (st.kind === 'cherry-pick') return (await git(['cherry-pick', '--skip'], cwd)).trim();
    return '';
  });

  /** 冲突文件按"要哪一边"一键解决: ours = 我这边, theirs = 对面那边。
   *  解完直接 add —— "选了一边"在语义上就等于"这个文件我定了", 再逼用户手点一次暂存
   *  只是多一步。 */
  ipcMain.handle(
    'git:resolve-with',
    async (_e, cwd: string, filePath: string, side: 'ours' | 'theirs'): Promise<void> => {
      await git(['checkout', side === 'ours' ? '--ours' : '--theirs', '--', filePath], cwd);
      await git(['add', '--', filePath], cwd);
    },
  );

  /** git checkout <hash> */
  ipcMain.handle('git:checkout', async (_e, cwd: string, ref: string): Promise<string> => {
    return (await git(['checkout', ref], cwd)).trim();
  });

  /** git revert <hash> --no-edit */
  ipcMain.handle('git:revert', async (_e, cwd: string, hash: string): Promise<string> => {
    return (await git(['revert', '--no-edit', hash], cwd)).trim();
  });

  /** git reset --hard <hash> */
  ipcMain.handle(
    'git:reset-to',
    async (_e, cwd: string, hash: string, mode: 'soft' | 'mixed' | 'hard' = 'mixed'): Promise<string> => {
      if (mode === 'hard') assertDestructiveAllowed(cwd, 'git reset --hard');
      return (await git(['reset', `--${mode}`, hash], cwd)).trim();
    },
  );

  /** git branch <name> <hash> */
  ipcMain.handle('git:create-branch', async (_e, cwd: string, name: string, startPoint: string): Promise<string> => {
    return (await git(['branch', name, startPoint], cwd)).trim();
  });

  /** git stash push -u -m <msg> — 切分支前防呆用 */
  ipcMain.handle('git:stash', async (_e, cwd: string, message?: string): Promise<string> => {
    const args = ['stash', 'push', '-u'];
    if (message) args.push('-m', message);
    return (await git(args, cwd)).trim();
  });

  /** git checkout -- . + git clean -fd — 丢弃 worktree 改动 (切分支前防呆 discard 选项) */
  ipcMain.handle('git:clean-preview', async (_e, cwd: string): Promise<string[]> => {
    try {
      const out = await git(['clean', '-nd'], cwd);
      return out.split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('Would remove '))
        .map((l) => l.slice('Would remove '.length).trim())
        .filter(Boolean);
    } catch {
      /* 列不出来时返回空 —— 调用方会据此提示"无法确认", 而不是假装没有 */
      return [];
    }
  });

  ipcMain.handle('git:discard-worktree', async (_e, cwd: string): Promise<string> => {
    assertDestructiveAllowed(cwd, 'git discard worktree');
    /* 两步: 1) 还原 tracked 文件 2) 清掉 untracked. 任一失败也继续, 拿到最大限度 clean. */
    let out = '';
    try { out += (await git(['checkout', '--', '.'], cwd)).trim(); } catch { /* no-op */ }
    try { out += (await git(['clean', '-fd'], cwd)).trim(); } catch { /* no-op */ }
    return out || 'ok';
  });

  /** git restore <path> (或 git checkout -- <path>) — 单文件 worktree 还原.
   *   untracked 文件改用 rm 直接物理删除 (restore 对 untracked 无效).
   *   调用方需要先判断 area, 然后传 area 让这里走对的分支. */
  ipcMain.handle(
    'git:discard-file',
    async (_e, cwd: string, filePath: string, area: 'tracked' | 'untracked'): Promise<string> => {
      assertDestructiveAllowed(cwd, 'git discard file');
      if (area === 'untracked') {
        /* untracked → 物理删除 (clean -f -- <path>); 比直接 fs.unlink 更稳, 走 git 自己的安全网 */
        return (await git(['clean', '-f', '--', filePath], cwd)).trim() || 'removed';
      }
      /* tracked → restore (新版 git) 或 checkout -- (兼容旧版) */
      try {
        return (await git(['restore', '--worktree', '--staged', '--', filePath], cwd)).trim() || 'restored';
      } catch {
        return (await git(['checkout', 'HEAD', '--', filePath], cwd)).trim() || 'restored';
      }
    },
  );

  /** 给项目 .gitignore 追加一行规则.
   *   · 自动给文件加换行符;
   *   · 已有相同规则就不重复追加 (idempotent);
   *   · workspace 根没 .gitignore 就创建. */
  ipcMain.handle(
    'git:append-gitignore',
    async (_e, cwd: string, patterns: string | string[]): Promise<{ added: string[]; skipped: string[] }> => {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const gitignorePath = path.join(cwd, '.gitignore');
      const lines = Array.isArray(patterns) ? patterns : [patterns];
      let existing = '';
      try { existing = await fs.readFile(gitignorePath, 'utf-8'); } catch { /* missing → 当空文件处理 */ }
      const existingSet = new Set(existing.split('\n').map((l) => l.trim()).filter(Boolean));
      const added: string[] = [];
      const skipped: string[] = [];
      const newLines: string[] = [];
      for (const raw of lines) {
        const line = String(raw || '').trim();
        if (!line) continue;
        if (existingSet.has(line)) {
          skipped.push(line);
          continue;
        }
        added.push(line);
        newLines.push(line);
      }
      if (newLines.length > 0) {
        const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
        const block = sep + (existing.length > 0 ? '\n# Added by Neox\n' : '# .gitignore — managed by Neox\n') + newLines.join('\n') + '\n';
        await fs.appendFile(gitignorePath, block, 'utf-8');
      }
      return { added, skipped };
    },
  );

  /** git tag <name> <hash> */
  ipcMain.handle('git:create-tag', async (_e, cwd: string, name: string, hash: string): Promise<string> => {
    return (await git(['tag', name, hash], cwd)).trim();
  });

  /** git push — 推送到远端. 返回结构化结果, 失败有错码让 UI 给针对性提示.
   *   入参: cwd; opts={ remote?, branch?, setUpstream? } 或 legacy (cwd, remote, branch) — 后者会按对象拼.
   *   注: 旧 caller (GitLogPanel) 直接 await 返回字符串期望成功; 这里成功返 stdout, 失败 throw 兼容旧行为.
   *       新 caller (CommitPanel commit-and-push) 用 { ok, stdout, error, code } 直查. */
  ipcMain.handle('git:push', async (
    _e,
    cwd: string,
    arg2?: string | { remote?: string; branch?: string; setUpstream?: boolean },
    arg3?: string,
  ): Promise<{ ok: true; stdout: string } | { ok: false; error: string; code?: string }> => {
    const opts: { remote?: string; branch?: string; setUpstream?: boolean } =
      typeof arg2 === 'string'
        ? { remote: arg2, branch: arg3 }
        : (arg2 ?? {});
    try {
      const remotes = await git(['remote'], cwd).catch(() => '');
      if (!remotes.trim()) {
        return { ok: false, error: '没有配置远端仓库 (origin), 请先 git remote add origin <url>', code: 'NO_REMOTE' };
      }
      const args = ['push'];
      if (opts.setUpstream) args.push('--set-upstream');
      if (opts.remote) args.push(opts.remote);
      if (opts.branch) args.push(opts.branch);
      const out = await git(args, cwd);
      return { ok: true, stdout: out.trim() };
    } catch (err: any) {
      const stderr = String(err?.stderr ?? err?.message ?? err);
      let code: string | undefined;
      if (/no upstream branch/i.test(stderr)) code = 'NO_UPSTREAM';
      else if (/authentication failed|could not read|permission denied/i.test(stderr)) code = 'AUTH_FAILED';
      else if (/rejected.*non-fast-forward/i.test(stderr)) code = 'NON_FAST_FORWARD';
      else if (/network|could not resolve/i.test(stderr)) code = 'NETWORK';
      return { ok: false, error: stderr.trim() || 'git push 失败', code };
    }
  });

  /** git pull */
  ipcMain.handle('git:pull', async (_e, cwd: string, remote = 'origin', branch?: string): Promise<{ success: boolean; output: string }> => {
    try {
      const args = ['pull', remote];
      if (branch) args.push(branch);
      const output = (await git(args, cwd)).trim();
      return { success: true, output };
    } catch (e: any) {
      return { success: false, output: e?.message ?? String(e) };
    }
  });

  /** git branch -a + tags — 返回分支和标签列表 */
  ipcMain.handle(
    'git:refs',
    async (_e, cwd: string): Promise<{
      head: string;
      local: string[];
      remote: string[];
      tags: string[];
    }> => {
      try {
        if (!cwd) return { head: '', local: [], remote: [], tags: [] };
        const scope = await resolveGitScope(cwd);
        if (!scope.ok) return { head: '', local: [], remote: [], tags: [] };
        const head = (await git(['branch', '--show-current'], cwd)).trim();
        const branchRaw = await git(['branch', '-a', '--no-color'], cwd);
        const local: string[] = [];
        const remote: string[] = [];
        for (const line of branchRaw.split('\n')) {
          const name = line.replace(/^\*?\s+/, '').trim();
          if (!name || name.includes('->')) continue;
          if (name.startsWith('remotes/')) {
            remote.push(name.replace('remotes/', ''));
          } else {
            local.push(name);
          }
        }
        let tags: string[] = [];
        try {
          const tagRaw = await git(['tag', '--sort=-creatordate'], cwd);
          tags = tagRaw.trim().split('\n').filter(Boolean);
        } catch { /* no tags */ }
        return { head, local, remote, tags };
      } catch {
        return { head: '', local: [], remote: [], tags: [] };
      }
    },
  );

  // ──────────────────────────────────────────────────────────────────────
  // AI Commit Message Generation
  // Uses Neox's own LLMProvider stack (buildProvider + chatStreamed).
  // Streams chunks to renderer via:
  //   'git:commit-msg:chunk' / 'git:commit-msg:done' / 'git:commit-msg:error'
  // ──────────────────────────────────────────────────────────────────────

  /** Truncate diff to keep token count sane (≈ 6 KB) */
  function truncateDiff(diff: string, maxBytes = 6000): string {
    if (diff.length <= maxBytes) return diff;
    const truncated = diff.slice(0, maxBytes);
    const lastNewline = truncated.lastIndexOf('\n');
    return (lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated) +
      `\n\n... [diff truncated, ${diff.length - maxBytes} bytes omitted] ...`;
  }

  ipcMain.handle(
    'git:generate-commit-msg',
    async (event: IpcMainInvokeEvent, cwd: string, paths?: string[]): Promise<void> => {
      const send = (channel: string, data: unknown) => {
        try { event?.sender.send(channel, data); } catch { /* window closed */ }
      };

      try {
        const selectedPaths = Array.isArray(paths)
          ? paths.map((value) => String(value || '').trim()).filter(Boolean)
          : [];
        const statusArgs = [
          'status',
          '--porcelain=v1',
          '--untracked-files=all',
          ...(selectedPaths.length > 0 ? ['--', ...selectedPaths] : []),
        ];
        const statusRaw = await git(statusArgs, cwd).catch(() => '');
        const selectedStatusLines = statusRaw.split('\n').filter(Boolean);
        const scopedArgs = selectedPaths.length > 0 ? ['--', ...selectedPaths] : [];
        const untrackedNullPath = process.platform === 'win32' ? 'NUL' : '/dev/null';
        const untrackedPaths = selectedStatusLines
          .filter((line) => line.startsWith('?? '))
          .map((line) => unquoteGitPath(line.slice(3)));

        const [stagedDiff, unstagedDiff, untrackedDiffs] = await Promise.all([
          gitContent(['diff', '--cached', ...scopedArgs], cwd).catch(() => ''),
          gitContent(['diff', ...scopedArgs], cwd).catch(() => ''),
          Promise.all(
            untrackedPaths.map((filePath) =>
              gitContent(['diff', '--no-index', '--', untrackedNullPath, filePath], cwd).catch(() => ''),
            ),
          ),
        ]);

        const diff = [stagedDiff, unstagedDiff, ...untrackedDiffs]
          .map((part) => part.trim())
          .filter(Boolean)
          .join('\n\n');
        if (!diff) {
          send('git:commit-msg:error', 'No changes to generate commit message for');
          return;
        }

        const fileList = selectedStatusLines
          .map((line) => line.slice(0, 2).trim() + ' ' + line.slice(3))
          .join('\n');

        const prompt = `You are an expert software engineer. Generate a concise git commit message.

## Changed Files
${fileList}

## Diff
\`\`\`diff
${truncateDiff(diff)}
\`\`\`

## Rules
- Conventional Commits: type(scope): description
- Types: feat, fix, refactor, style, docs, test, chore, perf, build
- Subject ≤72 chars, imperative mood, no period
- Optional body: blank line + 2-4 bullet points for significant changes
- Output ONLY the commit message, no markdown fences

Examples:
feat(editor): add image viewer for binary file preview
fix(vcs): prevent double-staging when checklist is empty`;

        // 2. Get Neox's configured provider via configService → buildProvider
        const providerEntry = configService.getDefaultProviderEntry();
        if (!providerEntry) {
          send('git:commit-msg:error', 'No LLM provider configured');
          return;
        }

        const model =
          providerEntry.lastSelectedModel ||
          providerEntry.defaultModel ||
          providerEntry.models[0]?.name;

        if (!model) {
          send('git:commit-msg:error', 'No model selected in provider');
          return;
        }

        // 3. Build the LLM provider (handles all protocols: Anthropic, OpenAI, GLM, Gemini…)
        const { llmProvider } = buildProvider({
          provider: providerEntry,
          model,
          sessionId: 'commit-msg-gen',
          runtimeMode: 'default',
        });

        // 4. Stream via Neox's own chatStreamed — protocol differences handled internally
        const messages = [{ role: 'user' as const, content: prompt }];
        const stream = llmProvider.chatStreamed(messages, {
          model,
          disableSystemPrompt: true,
        });

        // chatStreamed yields OpenAI-compatible chunks (Anthropic adapter converts internally)
        // Text lives in chunk.choices[0].delta.content
        for await (const chunk of stream) {
          const text = chunk?.choices?.[0]?.delta?.content;
          if (text) send('git:commit-msg:chunk', text);
        }

        send('git:commit-msg:done', null);
      } catch (err: any) {
        send('git:commit-msg:error', err?.message ?? String(err));
      }
    },
  );

  /** git clone <url> <dest> — 克隆仓库到本地目录. 用 stream 输出进度. */
  ipcMain.handle(
    'git:clone',
    async (event: IpcMainInvokeEvent, opts: { url: string; dest: string }):
      Promise<{ ok: true; path: string } | { ok: false; error: string; code?: string }> => {
      const { url, dest } = opts;
      if (!url?.trim() || !dest?.trim()) {
        return { ok: false, error: 'url + dest required', code: 'BAD_ARGS' };
      }
      /* 边界校验 — dest 必须在 home 内且避开敏感目录, 归一化后再落盘 */
      const safeDest = resolveAllowedGitDest(dest);
      if (!safeDest) {
        return { ok: false, error: 'destination outside allowed directories', code: 'DEST_FORBIDDEN' };
      }
      const fs = await import('node:fs');
      try {
        /* 目标目录已存在且非空 → 拒绝, 防止意外覆盖. */
        if (fs.existsSync(safeDest)) {
          const entries = fs.readdirSync(safeDest).filter(n => !n.startsWith('.'));
          if (entries.length > 0) {
            return { ok: false, error: `目标目录非空: ${safeDest}`, code: 'DEST_NOT_EMPTY' };
          }
        } else {
          fs.mkdirSync(safeDest, { recursive: true });
        }
        /* 用 spawn 拿到 stderr 流, push 进度给 renderer (git clone 进度走 stderr). */
        const { spawn } = await import('node:child_process');
        const send = (channel: string, payload: unknown) => {
          if (!event?.sender.isDestroyed()) event?.sender.send(channel, payload);
        };
        const child = spawn(GIT, ['clone', '--progress', url, safeDest], { cwd: path.dirname(safeDest) });
        let stderrBuf = '';
        child.stderr.on('data', (chunk: Buffer) => {
          const s = chunk.toString('utf-8');
          stderrBuf += s;
          send('git:clone:progress', s);
        });
        return await new Promise((resolve) => {
          child.on('error', (err) => resolve({ ok: false, error: String(err.message ?? err), code: 'SPAWN_FAILED' }));
          child.on('exit', (codeExit) => {
            if (codeExit === 0) {
              resolve({ ok: true, path: safeDest });
            } else {
              let code: string | undefined;
              if (/authentication failed|permission denied/i.test(stderrBuf)) code = 'AUTH_FAILED';
              else if (/not found|repository.*does not exist/i.test(stderrBuf)) code = 'NOT_FOUND';
              else if (/could not resolve|network/i.test(stderrBuf)) code = 'NETWORK';
              resolve({ ok: false, error: stderrBuf.trim() || `git clone 退出码 ${codeExit}`, code });
            }
          });
        });
      } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err), code: 'UNKNOWN' };
      }
    },
  );

  /** git init <dest> — 在指定目录创建 git 仓库. "新建工作区" 选空目录时静默初始化. */
  ipcMain.handle(
    'git:init',
    async (_e, dest: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      /* 跟 git:clone 同款边界 — init 会在 dest 下写 .git, 同样是任意写盘面 */
      const safeDest = dest?.trim() ? resolveAllowedGitDest(dest) : null;
      if (!safeDest) {
        return { ok: false, error: 'destination outside allowed directories' };
      }
      try {
        await git(['init'], safeDest);
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    },
  );

  /* ============================================================
   * 补充 git 能力 — branch delete / fetch / merge / rebase / stash list+pop
   * ============================================================ */

  ipcMain.handle('git:delete-branch', async (_e, cwd: string, name: string, force = false): Promise<string> => {
    return (await git(['branch', force ? '-D' : '-d', name], cwd)).trim();
  });

  ipcMain.handle('git:fetch', async (_e, cwd: string, remote = 'origin', prune = false): Promise<string> => {
    const args = ['fetch', remote];
    if (prune) args.push('--prune');
    return (await git(args, cwd)).trim();
  });

  ipcMain.handle('git:merge', async (_e, cwd: string, branch: string, noFf = false): Promise<string> => {
    const args = ['merge', branch];
    if (noFf) args.push('--no-ff');
    return (await git(args, cwd)).trim();
  });

  ipcMain.handle('git:rebase', async (_e, cwd: string, onto: string): Promise<string> => {
    return (await git(['rebase', onto], cwd)).trim();
  });

  ipcMain.handle('git:rebase-abort', async (_e, cwd: string): Promise<string> => {
    return (await git(['rebase', '--abort'], cwd)).trim();
  });

  ipcMain.handle('git:rebase-continue', async (_e, cwd: string): Promise<string> => {
    return (await git(['rebase', '--continue'], cwd)).trim();
  });

  ipcMain.handle('git:stash-list', async (_e, cwd: string): Promise<Array<{ index: number; message: string }>> => {
    const out = (await git(['stash', 'list', '--format=%gd||%s'], cwd)).trim();
    if (!out) return [];
    return out.split('\n').map((line) => {
      const [ref, ...rest] = line.split('||');
      const idx = parseInt(ref.replace('stash@{', '').replace('}', ''), 10);
      return { index: isNaN(idx) ? 0 : idx, message: rest.join('||') };
    });
  });

  ipcMain.handle('git:stash-pop', async (_e, cwd: string, index = 0): Promise<string> => {
    return (await git(['stash', 'pop', `stash@{${index}}`], cwd)).trim();
  });

  ipcMain.handle('git:stash-apply', async (_e, cwd: string, index = 0): Promise<string> => {
    return (await git(['stash', 'apply', `stash@{${index}}`], cwd)).trim();
  });

  ipcMain.handle('git:stash-drop', async (_e, cwd: string, index = 0): Promise<string> => {
    return (await git(['stash', 'drop', `stash@{${index}}`], cwd)).trim();
  });
}
