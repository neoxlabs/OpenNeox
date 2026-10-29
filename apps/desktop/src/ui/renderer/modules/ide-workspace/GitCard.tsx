import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { copyToClipboard } from '../../utils/copyToClipboard';
import { createPortal } from 'react-dom';
/* 菜单开在操作发生的那个窗口 (Git 面板可能被拖成了独立窗口) */
import { interactionDoc, interactionWin } from '../../utils/ownerDoc';
import { useI18n } from '../../hooks/useI18n';
import { refreshGitState, subscribeGitStatusChanges } from '../../state/gitStateStore';
import { useGitState } from '../../hooks/useGitState';
import { CappedRows, GitStatusLimitNote } from '../../components/CappedRows';
import { EmptyState } from '../../components/settings-base/EmptyState';
import { confirmAsync, promptAsync } from '../../components/confirmEvents';
import { dispatchPanelToast, dispatchOpFailedFromError } from '../../components/notifyEvents';
import { FileTypeIcon } from '../../components/FileTypeIcon';
import { NeoxIllus } from '../../media/illus';
import { layoutCommitGraph, graphWidth } from './commitGraph';
import { CommitGraphCell, LANE_W } from './CommitGraphCell';
import { CommitDetailPane } from './CommitDetailPane';
import { DiffBody } from './DiffLines';
import { computeCommitDiff, type CommitDiff } from './commitLineDiff';
import { absGitPath, shortDir } from './gitPathFormat';

/** 面板宽到这个数, 历史页就从"行内展开"换成"左列表 + 右详情"两栏 */
const WIDE_AT = 880;

interface GitFileStatus {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  area: 'staged' | 'unstaged' | 'untracked' | 'conflict';
  origPath?: string;
  add?: number;
  del?: number;
}
/** merge / rebase / cherry-pick / revert 做到一半的状态 (主进程 readRepoState) */
interface GitRepoState {
  kind: 'none' | 'merge' | 'rebase' | 'cherry-pick' | 'revert';
  step?: number;
  total?: number;
  onto?: string;
}
interface GitStatusResult {
  branch: string;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
  root?: string;
  unavailableReason?: '' | 'not-a-repo' | 'ignored-by-parent' | 'no-workspace';
  /** 老版本主进程没有这个字段 → 当作 none, 横幅不出现, 不炸 */
  state?: GitRepoState;
  truncated?: boolean;
  untrackedMode?: 'all' | 'normal';
}
interface StashEntry { index: number; message: string; branch?: string; date?: string }
interface GitRemote { name: string; url: string }

/** git remote 的 url → 能在浏览器里打开的网址。
 *
 *  三种写法都要认: `git@github.com:a/b.git` / `ssh://git@host/a/b.git` / `https://host/a/b.git`。
 *  认不出就返回 null —— **不猜**。猜错的后果是把人送到一个不存在的页面, 比不给这个
 *  入口更糟 (自建 gitolite、内网 host 都可能长得像但路由完全不同)。 */
export function remoteWebUrl(raw: string): string | null {
  const url = (raw || '').trim().replace(/\.git$/, '');
  if (!url) return null;
  let m = url.match(/^git@([^:]+):(.+)$/);            // scp 式
  if (m) return `https://${m[1]}/${m[2]}`;
  m = url.match(/^ssh:\/\/(?:[^@]+@)?([^/:]+)(?::\d+)?\/(.+)$/);
  if (m) return `https://${m[1]}/${m[2]}`;
  if (/^https?:\/\//.test(url)) return url;
  return null;
}
/** 远程主机长什么样, 只用来给按钮起名 (GitHub / GitLab / 远程) */
export function remoteHostLabel(raw: string): string {
  const u = remoteWebUrl(raw) || raw;
  if (/github\.com/i.test(u)) return 'GitHub';
  if (/gitlab\b/i.test(u)) return 'GitLab';
  if (/bitbucket\.org/i.test(u)) return 'Bitbucket';
  if (/gitee\.com/i.test(u)) return 'Gitee';
  return '';
}
interface CommitEntry {
  hash: string; shortHash: string; message: string; author: string;
  date: string; dateIso?: string; refs: string;
  /** 父提交 (%P)。老版本 IPC 没有这个字段 → 图退化成一条直线, 不炸。 */
  parents?: string[];
}

/* %D 出来的形如: "HEAD -> main, origin/main, tag: v1.2.0"。
 * 一直有这份数据, 但从来没渲染 —— 于是历史列表里看不出"我现在在哪"、哪条是发布点。
 *
 * 分三类给不同的样子:
 *   head   当前 HEAD 所在 —— 最该一眼看到的
 *   tag    版本标记
 *   branch 其它分支 / 远程分支
 * origin/HEAD 这种指针不显示: 它跟着远程默认分支走, 不是用户关心的位置。 */
function parseRefs(raw: string): Array<{ label: string; kind: 'head' | 'branch' | 'tag' }> {
  if (!raw?.trim()) return [];
  const out: Array<{ label: string; kind: 'head' | 'branch' | 'tag' }> = [];
  for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (part.endsWith('/HEAD')) continue;
    if (part.startsWith('tag: ')) { out.push({ label: part.slice(5), kind: 'tag' }); continue; }
    if (part.startsWith('HEAD -> ')) { out.push({ label: part.slice(8), kind: 'head' }); continue; }
    if (part === 'HEAD') { out.push({ label: 'HEAD', kind: 'head' }); continue; }
    out.push({ label: part, kind: 'branch' });
  }
  return out;
}

/** commits 比 graphRows 长的那一瞬间 (数据刚回来还没重算) 用它兜底, 画一条直线 */
const EMPTY_GRAPH_ROW = {
  lane: 0, width: 1, through: [], forks: [], merges: [], isMerge: false, hasParentLine: true,
} as const;
type CommitFileEntry = { path: string; status: string; add?: number; del?: number };
interface CommitDetail {
  hash: string;
  message: string;
  author: string;
  date: string;
  files: CommitFileEntry[];
}

interface GitRefs { head: string; local: string[]; remote: string[]; tags: string[]; }

const git = () => window.neox as any;

/** 同步按钮忙时的转圈 —— 就地替掉那颗箭头, 所以"哪一个在跑"是看得见的位置信息,
 *  不是别处一行小字。dasharray 留个缺口, 不然匀速转的整圆看着像不动。 */
const SyncSpinner: React.FC = () => (
  <svg className="gc__spin" width="16" height="16" viewBox="0 0 24 24" fill="none"
       stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
    <circle cx="12" cy="12" r="8.5" opacity="0.25" />
    <path d="M20.5 12a8.5 8.5 0 0 0-8.5-8.5" />
  </svg>
);

function gitStatusChar(raw: string): string {
  const ch = (raw || '?').trim().charAt(0).toUpperCase();
  return ch || '?';
}

/** 目录/文件标 — 16 视口 + 浅填, 14px 细线在暗底上会飘、没质感.
 *  状态列: Changes 里几乎全是 M, 每行再挂一颗等于噪音; 只标非常态 (A/D/?/U/R). */
function GitDirMark({ open }: { open: boolean }) {
  return (
    <>
      <svg
        className={`gc__htree-chevron${open ? ' is-open' : ''}`}
        width="8" height="8" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
        aria-hidden
      >
        <polyline points="9 18 15 12 9 6" />
      </svg>
      <svg className="gc__ficon gc__ficon--folder" viewBox="0 0 16 16" width="15" height="15" aria-hidden>
        <path
          d="M2.6 4.4A1.6 1.6 0 0 1 4.2 2.8h2.05c.38 0 .74.16 1 .44l.7.8c.26.28.62.44 1 .44h4.85A1.6 1.6 0 0 1 15.4 6.1v6.3A1.6 1.6 0 0 1 13.8 14H4.2A1.6 1.6 0 0 1 2.6 12.4z"
          fill="currentColor" fillOpacity="0.16"
          stroke="currentColor" strokeWidth="1.15" strokeLinejoin="round"
        />
      </svg>
    </>
  );
}

function GitFileMark({ path }: { path: string }) {
  return <FileTypeIcon path={path} size={15} className="gc__ficon" />;
}

function GitFileMeta({
  status,
  add,
  del,
  hasStat,
}: {
  status: string;
  add: number;
  del: number;
  hasStat: boolean;
}) {
  const ch = gitStatusChar(status);
  const cls = ch === '?' ? '?' : ch.toLowerCase();
  const showLetter = ch !== 'M';
  const showAdd = hasStat && add > 0;
  const showDel = hasStat && del > 0;
  if (!showLetter && !showAdd && !showDel) return null;
  /* .gc__fmeta 是固定两列的 grid (数字 | 字母) —— 两格都得**存在**, 否则少一格的行
   * 会把数字列往右顶, 一列看下去又变回锯齿。所以这两个 span 一律渲染, 只是没内容。
   * (M 不显示字母: 一列里几乎全是 M, 每行挂一颗等于噪音。) */
  return (
    <span className="gc__fmeta">
      <span className="gc__hfile-stat" aria-label={`${showAdd ? `+${add}` : ''} ${showDel ? `−${del}` : ''}`.trim()}>
        <span className={showAdd ? 'gc__hfile-add' : 'gc__hfile-zero'}>{showAdd ? `+${add}` : ''}</span>
        <span className={showDel ? 'gc__hfile-del' : 'gc__hfile-zero'}>{showDel ? `−${del}` : ''}</span>
      </span>
      <span className={showLetter ? `gc__fch gc__fch--${cls}` : 'gc__fch'} title={showLetter ? ch : undefined}>
        {showLetter ? ch : ''}
      </span>
    </span>
  );
}


type PathTreeNode<T> =
  | { kind: 'dir'; name: string; fullPath: string; children: PathTreeNode<T>[] }
  | { kind: 'file'; name: string; fullPath: string; file: T };

/** 按路径拼文件夹树，并把单子目录链压成 `a/b/c` 一行（窄栏友好） */
function buildFilePathTree<T extends { path: string }>(files: T[]): PathTreeNode<T>[] {
  /* 建树期只存这两种: 目录用可变 kids(Map), 叶子直接就是最终形态.
   * 不能写成 `MutableDir | PathTreeNode<T>` —— PathTreeNode 的 dir 变体带的是
   * children 不是 kids, 会让 finalize 里的 n.kids 取不到 (TS2339). */
  type MutableLeaf = Extract<PathTreeNode<T>, { kind: 'file' }>;
  type MutableDir = { kind: 'dir'; name: string; fullPath: string; kids: Map<string, MutableDir | MutableLeaf> };
  const root: MutableDir = { kind: 'dir', name: '', fullPath: '', kids: new Map() };

  for (const file of files) {
    const parts = file.path.split(/[/\\]/).filter(Boolean);
    if (parts.length === 0) continue;
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const isLeaf = i === parts.length - 1;
      const fullPath = parts.slice(0, i + 1).join('/');
      if (isLeaf) {
        cur.kids.set(part, { kind: 'file', name: part, fullPath, file });
        continue;
      }
      let next = cur.kids.get(part);
      if (!next || next.kind !== 'dir') {
        next = { kind: 'dir', name: part, fullPath, kids: new Map() };
        cur.kids.set(part, next);
      }
      cur = next as MutableDir;
    }
  }

  const finalize = (kids: Map<string, MutableDir | MutableLeaf>): PathTreeNode<T>[] => {
    const dirs: PathTreeNode<T>[] = [];
    const leafs: PathTreeNode<T>[] = [];
    for (const n of kids.values()) {
      if (n.kind === 'file') {
        leafs.push(n);
        continue;
      }
      let node: PathTreeNode<T> = { kind: 'dir', name: n.name, fullPath: n.fullPath, children: finalize(n.kids) };
      while (node.kind === 'dir' && node.children.length === 1 && node.children[0]!.kind === 'dir') {
        const only = node.children[0] as Extract<PathTreeNode<T>, { kind: 'dir' }>;
        node = {
          kind: 'dir',
          name: `${node.name}/${only.name}`,
          fullPath: only.fullPath,
          children: only.children,
        };
      }
      dirs.push(node);
    }
    const byName = (a: PathTreeNode<T>, b: PathTreeNode<T>) => a.name.localeCompare(b.name);
    dirs.sort(byName);
    leafs.sort(byName);
    return [...dirs, ...leafs];
  };

  return finalize(root.kids);
}

type CommitTreeNode = PathTreeNode<CommitFileEntry>;
function buildCommitFileTree(files: CommitFileEntry[]): CommitTreeNode[] {
  return buildFilePathTree(files);
}

function openFileInEditor(wp: string, fp: string) {
  window.dispatchEvent(new CustomEvent('neox:editor:open-file', { detail: { path: absGitPath(wp, fp) } }));
}

function openDiffInEditor(wp: string, fp: string, orig: string, mod: string) {
  const name = fp.split('/').pop() || fp;
  const ext = fp.split('.').pop()?.toLowerCase();
  const langMap: Record<string, string> = { ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact', json: 'json', md: 'markdown', css: 'css', py: 'python', go: 'go', rs: 'rust', dart: 'dart', vue: 'vue', html: 'html', yaml: 'yaml', yml: 'yaml' };
  window.dispatchEvent(new CustomEvent('neox:editor:open-diff', {
    detail: { title: name, originalContent: orig, modifiedContent: mod, originalLabel: `a/${fp}`, modifiedLabel: `b/${fp}`, language: ext ? langMap[ext] : undefined },
  }));
}

interface Props {
  workspacePath: string;
  /* 打开方式可注入 —— IDE 模式默认派 'neox:editor:open-file' / 'neox:editor:open-diff'
   * 给中间的编辑器; Agent 模式 (Git Surface) 没有那个编辑器, 需要落到 surface 上。
   * 不传就是原来的 IDE 行为, 一个字节都没变。 */
  onOpenFile?: (path: string) => void;
  onOpenDiff?: (path: string, original: string, modified: string, staged?: boolean) => void;
}
type Section = 'changes' | 'history';

export const GitCard: React.FC<Props> = ({ workspacePath, onOpenFile, onOpenDiff }) => {
  const { isZh } = useI18n();
  /* 注入优先, 否则退回 IDE 的编辑器事件 */
  const openFile = useCallback(
    (wp: string, fp: string) => (onOpenFile ? onOpenFile(fp) : openFileInEditor(wp, fp)),
    [onOpenFile],
  );
  const openDiff = useCallback(
    (wp: string, fp: string, orig: string, mod: string, staged?: boolean) =>
      (onOpenDiff ? onOpenDiff(fp, orig, mod, staged) : openDiffInEditor(wp, fp, orig, mod)),
    [onOpenDiff],
  );
  const gitState = useGitState(workspacePath || undefined);
  const status = gitState.status as GitStatusResult | null;
  const [commits, setCommits] = useState<CommitEntry[]>([]);
  const [gitRefs, setGitRefs] = useState<GitRefs>({ head: '', local: [], remote: [], tags: [] });
  const [section, setSection] = useState<Section>('changes');
  const [commitMsg, setCommitMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [expandedCommit, setExpandedCommit] = useState<string | null>(null);
  const [commitFiles, setCommitFiles] = useState<CommitFileEntry[]>([]);
  /* 面板够宽 → 历史页走"左列表 + 右详情"两栏 (用户要的"右侧直接显示代码对比和提交人信息")。
   * 用 ResizeObserver 量**自己**而不是 window: 这个组件既可能占满主区 (1100px),
   * 也可能挂在 500 多 px 的右栏里, 窗口宽度说明不了它有多宽。 */
  const rootRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      /* 迟滞 40px: 正好卡在阈值上拖窗口时不会来回跳版式 */
      setWide((prev) => (prev ? w >= WIDE_AT - 40 : w >= WIDE_AT));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [collapsedCommitDirs, setCollapsedCommitDirs] = useState<Set<string>>(() => new Set());
  const commitFileTree = useMemo(() => buildCommitFileTree(commitFiles), [commitFiles]);

  const toggleCommitDir = useCallback((fullPath: string) => {
    setCollapsedCommitDirs((prev) => {
      const next = new Set(prev);
      if (next.has(fullPath)) next.delete(fullPath);
      else next.add(fullPath);
      return next;
    });
  }, []);

  // branch dropdown
  const [branchOpen, setBranchOpen] = useState(false);
  const [branchSearch, setBranchSearch] = useState('');
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const branchRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!branchOpen) return;
    const close = (e: MouseEvent) => { if (branchRef.current && !branchRef.current.contains(e.target as Node)) setBranchOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [branchOpen]);

  // stash drawer
  const [stashOpen, setStashOpen] = useState(false);
  const stashMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!stashOpen) return;
    const close = (e: MouseEvent) => { if (stashMenuRef.current && !stashMenuRef.current.contains(e.target as Node)) setStashOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [stashOpen]);

  // actions menu
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!actionsOpen) return;
    const close = (e: MouseEvent) => { if (actionsMenuRef.current && !actionsMenuRef.current.contains(e.target as Node)) setActionsOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [actionsOpen]);

  // context menu
  /* History 里"某个提交内的某个文件"的右键菜单 —— 跟 Changes 那份是两套数据 (它带 commit hash),
   * 所以单独一份 state, 不复用 ctxMenu。 */
  const [commitCtx, setCommitCtx] = useState<{ x: number; y: number; hash: string; path: string } | null>(null);
  const [rowCtx, setRowCtx] = useState<{ x: number; y: number; c: CommitEntry } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; file: GitFileStatus } | null>(null);
  const ctxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ctxMenu) return;
    const close = (e: MouseEvent) => { if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) setCtxMenu(null); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [ctxMenu]);

  const [stashes, setStashes] = useState<StashEntry[]>([]);
  const [remotes, setRemotes] = useState<GitRemote[]>([]);
  const PAGE = 50;
  const AUTO_LOAD_MAX = 500;
  const [logLimit, setLogLimit] = useState(PAGE);
  const [hasMoreCommits, setHasMoreCommits] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  /** 提交历史 / refs / 储藏 / 远程 —— 仓库状态变化时 (推送) 和做完操作后刷 */
  const refreshHistory = useCallback(async () => {
    if (!workspacePath) return;
    try {
      const [h, r, st, rm] = await Promise.all([
        git().gitLogDetailed(workspacePath, logLimit),
        git().gitRefs(workspacePath).catch(() => null),
        git().gitStashList?.(workspacePath).catch(() => []) ?? [],
        /* 老版本主进程没有 git:remote-list → 拿不到就是空数组, 菜单里显示"还没连远程" */
        git().gitRemoteList?.(workspacePath).catch(() => []) ?? [],
      ]);
      setRemotes(rm ?? []);
      const log = h ?? [];
      setCommits(log); if (r) setGitRefs(r); setStashes(st ?? []);
      /* 回来的比要的少 = 已经到仓库开头了 */
      setHasMoreCommits(log.length >= logLimit);
    } catch { /* ignore */ }
    finally { setLoadingMore(false); }
  }, [workspacePath, logLimit]);

  /** 做完 git 操作后调: 状态强制重算 (经推送回到 gitState, 进而触发 refreshHistory) */
  const refresh = useCallback(async () => {
    if (!workspacePath) return;
    await Promise.all([refreshGitState(workspacePath), refreshHistory()]);
  }, [workspacePath, refreshHistory]);

  /* 滚到底自动多取一页。用 IntersectionObserver 盯着列表末尾那颗哨兵, 不监听 scroll
   * 事件 —— scroll 每帧都烧一次, 而这件事只在"末尾进入视野"那一瞬间需要。 */
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = moreRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    /* 到上限就不再自动取 —— 下面那颗按钮还能手动继续 */
    if (logLimit >= AUTO_LOAD_MAX) return;
    const io = new IntersectionObserver((entries) => {
      if (!entries[0]?.isIntersecting) return;
      setLoadingMore((busyNow) => {
        if (busyNow) return busyNow;
        setLogLimit((n) => n + PAGE);
        return true;
      });
    }, { rootMargin: '240px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMoreCommits, section, logLimit]);

  useEffect(() => { void refreshHistory(); }, [refreshHistory]);
  useEffect(() => {
    if (!workspacePath) return;
    return subscribeGitStatusChanges(workspacePath, () => { void refreshHistory(); });
  }, [workspacePath, refreshHistory]);

  const conflicts = useMemo(() => status?.files.filter((f) => f.area === 'conflict') ?? [], [status]);
  const staged = useMemo(() => status?.files.filter((f) => f.area === 'staged') ?? [], [status]);
  const unstaged = useMemo(
    () => status?.files.filter((f) => f.area !== 'staged' && f.area !== 'conflict') ?? [],
    [status],
  );
  const totalChanges = status?.files.length ?? 0;
  const repoState = status?.state?.kind && status.state.kind !== 'none' ? status.state : null;

  const [query, setQuery] = useState('');
  useEffect(() => { setQuery(''); }, [section]);
  const q = query.trim().toLowerCase();

  const filterFiles = useCallback(
    (list: GitFileStatus[]) => (q ? list.filter((f) => f.path.toLowerCase().includes(q)) : list),
    [q],
  );
  const shownStaged = useMemo(() => filterFiles(staged), [filterFiles, staged]);
  const shownUnstaged = useMemo(() => filterFiles(unstaged), [filterFiles, unstaged]);
  const shownCommits = useMemo(() => {
    if (!q) return commits;
    return commits.filter((c) =>
      c.message.toLowerCase().includes(q)
      || c.author.toLowerCase().includes(q)
      || c.hash.toLowerCase().startsWith(q)
      || c.refs.toLowerCase().includes(q));
  }, [commits, q]);

  const graphRows = useMemo(() => {
    /* 用**过滤后**的那一页算图: 图和列表必须逐行对齐, 拿全量算就会错位一整列。
     * 过滤掉的提交造成的父子断链, layoutCommitGraph 当作"父在本页之外"处理, 不炸。 */
    const src = shownCommits;
    const hasParents = src.some((c) => Array.isArray(c.parents));
    const input = hasParents
      ? src.map((c) => ({ hash: c.hash, parents: c.parents ?? [] }))
      : src.map((c, i) => ({ hash: c.hash, parents: src[i + 1] ? [src[i + 1]!.hash] : [] }));
    return layoutCommitGraph(input);
  }, [shownCommits]);
  const graphCols = useMemo(() => graphWidth(graphRows), [graphRows]);
  /* 作者只在多人仓库才占一列 —— 单人仓库里每行同一个名字, 那不是信息是噪音,
   * 而且它抢的是提交消息的宽度。判据看这一页里有几个不同的作者。 */
  const showAuthors = useMemo(
    () => new Set(commits.map((c) => c.author).filter(Boolean)).size > 1,
    [commits],
  );

  const branch = status?.branch || '...';
  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;
  /* porcelain path 相对仓库根; 子目录工作区必须用 root 拼绝对路径 */
  const gitRoot = status?.root || workspacePath;
  const toAbs = useCallback((fp: string) => absGitPath(gitRoot, fp), [gitRoot]);
  const unavailableReason = status?.unavailableReason || '';
  const unavailableMsg = unavailableReason === 'ignored-by-parent'
    ? (isZh
      ? '当前项目在父仓库的 .gitignore 里，Git 面板不展示父仓库记录，避免串项目。'
      : 'This project is ignored by a parent git repo. Git panel won’t show the parent’s history.')
    : unavailableReason === 'not-a-repo'
      ? (isZh ? '当前项目还不是 git 仓库。' : 'This project is not a git repository.')
      : unavailableReason === 'no-workspace'
        ? (isZh ? '还没有打开项目 —— 先在左侧打开一个项目, Git 面板就跟着它走。'
                : 'No project open yet — open one on the left and the Git panel follows it.')
        : '';


  const run = useCallback(async (label: string, fn: () => Promise<any>) => {
    setBusy(label); setError('');
    try { await fn(); await refresh(); } catch (e: any) { setError(e?.message || (isZh ? `${label} 失败` : `${label} failed`)); }
    finally { setBusy(''); }
  }, [refresh, isZh]);

  const doGitInit = useCallback(async () => {
    if (!workspacePath) return;
    const ok = await confirmAsync({
      title: isZh ? '在这个项目里初始化 git 仓库?' : 'Initialize a git repository here?',
      message: workspacePath,
      description: isZh
        ? '会在项目根目录创建 .git。已有的文件不动，初始化后它们会显示为「未暂存」。'
        : 'Creates .git in the project root. Existing files are untouched and will show up as unstaged.',
      confirmLabel: isZh ? '初始化' : 'Initialize',
    });
    if (!ok) return;
    await run(isZh ? '初始化仓库...' : 'Initializing...', async () => {
      const res = await git().gitInit(workspacePath);
      /* 主进程那边把失败包成 { ok:false, error } 返回, 不抛 —— 不看这个字段的话
       * "destination outside allowed directories" 会被当成成功, 面板刷完还是老样子。 */
      if (res && res.ok === false) throw new Error(String(res.error || 'git init failed'));
    });
  }, [workspacePath, isZh, run]);

  const [syncBusy, setSyncBusy] = useState<'' | 'pull' | 'push' | 'fetch'>('');
  const doPush = useCallback(async () => {
    if (syncBusy) return;
    const upstream = gitRefs.remote.find((r) => r.endsWith(`/${branch}`));
    const target = upstream || `origin/${branch}`;
    const ok = await confirmAsync({
      title: isZh ? '推送' : 'Push',
      message: isZh
        ? `把 ${branch} 推到 ${target}${ahead > 0 ? `，${ahead} 个提交` : ''}。`
        : `Push ${branch} to ${target}${ahead > 0 ? ` — ${ahead} commit(s)` : ''}.`,
      description: upstream
        ? undefined
        : (isZh ? '这个分支还没有对应的远程分支，推送时会新建一个。' : 'This branch has no upstream yet; pushing creates one.'),
      confirmLabel: isZh ? '推送' : 'Push',
    });
    if (!ok) return;
    setSyncBusy('push');
    setError('');
    try {
      const r = await git().gitPush(workspacePath);
      if (r && r.ok === false) throw new Error(r.error);
      dispatchPanelToast(
        isZh ? `已推送到 ${target}` : `Pushed to ${target}`,
        'success',
      );
      await refresh();
    } catch (e: any) {
      dispatchOpFailedFromError(isZh ? '推送' : 'Push', e, isZh ? '推送失败' : 'Push failed');
    } finally { setSyncBusy(''); }
  }, [syncBusy, workspacePath, branch, ahead, gitRefs.remote, refresh, isZh]);

  const doPull = useCallback(async () => {
    if (syncBusy) return;
    setSyncBusy('pull');
    setError('');
    const before = commits[0]?.hash;
    try {
      await git().gitPull(workspacePath);
      const after = await git().gitLogDetailed(workspacePath, 1).catch(() => null);
      const moved = after?.[0]?.hash && after[0].hash !== before;
      dispatchPanelToast(
        moved
          ? (isZh ? '已拉取，本地更新到最新' : 'Pulled — local is up to date')
          : (isZh ? '已经是最新的，没有新提交' : 'Already up to date'),
        'success',
      );
      await refresh();
    } catch (e: any) {
      dispatchOpFailedFromError(isZh ? '拉取' : 'Pull', e, isZh ? '拉取失败' : 'Pull failed');
    } finally { setSyncBusy(''); }
  }, [syncBusy, workspacePath, commits, refresh, isZh]);

  const doFetch = useCallback(async () => {
    if (syncBusy) return;
    setSyncBusy('fetch');
    try {
      await git().gitFetch(workspacePath);
      await refresh();
      dispatchPanelToast(isZh ? '已获取远程最新状态' : 'Fetched from remote', 'success');
    } catch (e: any) {
      dispatchOpFailedFromError(isZh ? '获取远程' : 'Fetch', e, isZh ? '获取失败' : 'Fetch failed');
    } finally { setSyncBusy(''); }
  }, [syncBusy, workspacePath, refresh, isZh]);

  /* amend —— 主流客户端都有的一颗, 而 gitCommit 的第三个参数早就支持了, 一直没接。
   * 修的是最常见那种懊恼: 刚提交完发现少写一句 / 漏带一个文件。
   * 勾上之后暂存区可以是空的 (只改说明也算 amend), 所以下面的 canCommit 要分开判。 */
  const [amend, setAmend] = useState(false);
  /* 勾上 amend 时把上一次的说明填进来 —— 十有八九是要在它基础上改, 而不是重写 */
  const toggleAmend = useCallback(() => {
    setAmend((on) => {
      const next = !on;
      if (next && !commitMsg.trim() && commits[0]) setCommitMsg(commits[0].message);
      return next;
    });
  }, [commitMsg, commits]);
  /* 提交完清空并退出 amend —— 留着勾会让下一次提交悄悄改掉刚做的这条 */
  const canCommit = !!commitMsg.trim() && (amend || staged.length > 0) && !busy;

  const doCommit = useCallback(async (thenPush = false) => {
    if (!canCommit) return;
    if (amend) {
      const ok = await confirmAsync({
        title: isZh ? '改写上一次提交' : 'Amend last commit',
        message: commits[0]?.message.split('\n')[0] ?? '',
        description: isZh
          ? '上一次提交会被这次替换掉（hash 变）。已经推送过的提交慎改：别人拉过就对不上了。'
          : 'The previous commit is replaced (new hash). Careful if it was already pushed.',
        variant: 'danger',
        confirmLabel: isZh ? '改写' : 'Amend',
      });
      if (!ok) return;
    }
    await run(isZh ? '提交中...' : 'Committing...', async () => {
      await git().gitCommit(workspacePath, commitMsg.trim(), amend);
      setCommitMsg('');
      setAmend(false);
    });
    if (thenPush) await doPush();
  }, [canCommit, amend, commits, commitMsg, workspacePath, run, isZh, doPush]);
  const doStageAll = useCallback(() => run(isZh ? '暂存中...' : 'Staging...', () => git().gitStageAll(workspacePath)), [workspacePath, run, isZh]);
  const doStash = useCallback(() => run(isZh ? '储藏中...' : 'Stashing...', () => git().gitStash(workspacePath)), [workspacePath, run, isZh]);
  const doCheckout = useCallback((ref: string) => { setBranchOpen(false); return run(isZh ? `切换 ${ref}...` : `Checking out ${ref}...`, () => git().gitCheckout(workspacePath, ref)); }, [workspacePath, run, isZh]);

  const doOpContinue = useCallback(() =>
    run(isZh ? '继续...' : 'Continuing...', () => git().gitOpContinue(workspacePath)),
    [workspacePath, run, isZh]);
  const doOpSkip = useCallback(() =>
    run(isZh ? '跳过这条...' : 'Skipping...', () => git().gitOpSkip(workspacePath)),
    [workspacePath, run, isZh]);
  const doOpAbort = useCallback(async (label: string) => {
    const ok = await confirmAsync({
      title: isZh ? `中止${label}` : `Abort ${label}`,
      message: isZh
        ? '工作区会回到这次操作开始之前的样子，已经解决的冲突会丢掉。'
        : 'The working tree goes back to how it was before this operation. Conflicts you already resolved are lost.',
      variant: 'danger',
      confirmLabel: isZh ? '中止' : 'Abort',
    });
    if (!ok) return;
    await run(isZh ? '中止中...' : 'Aborting...', () => git().gitOpAbort(workspacePath));
  }, [workspacePath, run, isZh]);
  /* 连远程 / 改远程地址。名字固定用 origin (第一个远程) —— 让人先想个远程名是纯负担,
   * 而 origin 是所有 git 教程和工具的默认约定。已有多个远程时改的是被点的那一个。 */
  const doRemoteAdd = useCallback(async () => {
    const url = await promptAsync({
      title: isZh ? '连接远程仓库' : 'Connect a remote',
      message: isZh
        ? '粘贴仓库地址。GitHub / GitLab / 自建都行；HTTPS 和 SSH 两种写法都认。'
        : 'Paste the repository URL. GitHub / GitLab / self-hosted; HTTPS or SSH both work.',
      placeholder: 'https://github.com/you/repo.git',
      confirmLabel: isZh ? '连接' : 'Connect',
    });
    if (!url?.trim()) return;
    await run(isZh ? '连接远程...' : 'Connecting remote...', async () => {
      await git().gitRemoteAdd(workspacePath, 'origin', url.trim());
      /* 连上之后立刻 fetch 一次 —— 否则界面上还是"没有远程分支", 像没连上 */
      try { await git().gitFetch(workspacePath); } catch {}
    });
  }, [workspacePath, run, isZh]);
  const doRemoteEdit = useCallback(async (rm: GitRemote) => {
    const url = await promptAsync({
      title: isZh ? `改 ${rm.name} 的地址` : `Edit ${rm.name} URL`,
      message: rm.url,
      defaultValue: rm.url,
      placeholder: 'https://github.com/you/repo.git',
      confirmLabel: isZh ? '保存' : 'Save',
    });
    if (!url?.trim() || url.trim() === rm.url) return;
    await run(isZh ? '更新远程地址...' : 'Updating remote...', () =>
      git().gitRemoteSetUrl(workspacePath, rm.name, url.trim()));
  }, [workspacePath, run, isZh]);

  const [branchMenu, setBranchMenu] = useState<
    { x: number; y: number; name: string; kind: 'local' | 'remote'; div?: { ahead: number; behind: number } | null } | null
  >(null);
  const openBranchMenu = useCallback((e: React.MouseEvent, name: string, kind: 'local' | 'remote') => {
    const rowEl = (e.currentTarget as HTMLElement).closest('.gc__branch-row') as HTMLElement | null;
    const panel = (e.currentTarget as HTMLElement).closest('.gc__branch-menu') as HTMLElement | null;
    const r = (rowEl ?? (e.currentTarget as HTMLElement)).getBoundingClientRect();
    const left = (panel?.getBoundingClientRect().right ?? r.right) + 10;
    setBranchMenu({ x: Math.round(left), y: Math.round(r.top - 6), name, kind, div: undefined });
    /* 领先/落后是异步查的, 拿到再补进去 —— 菜单不等它, 先开出来 */
    void (async () => {
      try {
        const d = await git().gitBranchDivergence?.(workspacePath, name, gitRefs.head || branch);
        setBranchMenu((m) => (m && m.name === name ? { ...m, div: d ?? null } : m));
      } catch { setBranchMenu((m) => (m && m.name === name ? { ...m, div: null } : m)); }
    })();
  }, [workspacePath, gitRefs.head, branch]);
  useEffect(() => {
    if (!branchMenu) return;
    const close = () => setBranchMenu(null);
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') setBranchMenu(null); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', onKey); };
  }, [branchMenu]);

  const HOVER_IN = 180;
  const HOVER_OUT = 260;
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearHoverTimer = useCallback(() => {
    if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null; }
  }, []);
  useEffect(() => clearHoverTimer, [clearHoverTimer]);
  const onBranchHover = useCallback((e: React.MouseEvent, name: string, kind: 'local' | 'remote') => {
    clearHoverTimer();
    /* React 的合成事件对象会被回收, 定时器里读不到 —— 先把要用的取出来 */
    const el = e.currentTarget as HTMLElement;
    hoverTimer.current = setTimeout(() => {
      openBranchMenu({ currentTarget: el } as unknown as React.MouseEvent, name, kind);
    }, HOVER_IN);
  }, [clearHoverTimer, openBranchMenu]);
  const onBranchLeave = useCallback(() => {
    clearHoverTimer();
    hoverTimer.current = setTimeout(() => setBranchMenu(null), HOVER_OUT);
  }, [clearHoverTimer]);

  const doRenameBranch = useCallback(async (name: string) => {
    const next = await promptAsync({
      title: isZh ? '重命名分支' : 'Rename branch',
      message: name,
      defaultValue: name,
      confirmLabel: isZh ? '重命名' : 'Rename',
    });
    if (!next?.trim() || next.trim() === name) return;
    await run(isZh ? '重命名分支...' : 'Renaming...', () => git().gitRenameBranch(workspacePath, name, next.trim()));
  }, [workspacePath, run, isZh]);

  const doDeleteBranch = useCallback(async (name: string) => {
    const ok = await confirmAsync({
      title: isZh ? `删除分支 ${name}` : `Delete branch ${name}`,
      message: isZh
        ? '只删本地这一份，远程上的同名分支不动。没合并过的提交会变成"够不着"的状态。'
        : 'Deletes the local branch only; the remote one stays. Unmerged commits become unreachable.',
      variant: 'danger',
      confirmLabel: isZh ? '删除' : 'Delete',
    });
    if (!ok) return;
    await run(isZh ? '删除分支...' : 'Deleting...', () => git().gitDeleteBranch(workspacePath, name, false));
  }, [workspacePath, run, isZh]);

  const doBranchFrom = useCallback(async (from: string) => {
    const name = await promptAsync({
      title: isZh ? '从这个分支新建' : 'New branch from here',
      message: isZh ? `起点：${from}` : `Starting from ${from}`,
      placeholder: isZh ? '新分支名' : 'Branch name',
      confirmLabel: isZh ? '创建并切换' : 'Create & switch',
    });
    if (!name?.trim()) return;
    await run(isZh ? '创建分支...' : 'Creating branch...', async () => {
      await git().gitCreateBranch(workspacePath, name.trim(), from);
      await git().gitCheckout(workspacePath, name.trim());
    });
  }, [workspacePath, run, isZh]);

  const doResolveWith = useCallback((fp: string, side: 'ours' | 'theirs') =>
    run(isZh ? '解决冲突...' : 'Resolving...', () => git().gitResolveWith(workspacePath, fp, side)),
    [workspacePath, run, isZh]);

  /* 分支下拉里的合并/变基 —— 入口一直没有, 而这俩是分支面板上最常做的两件事。
   * 都以"当前分支"为主语: 合并 = 把选中的分支并进来; 变基 = 把当前分支挪到选中的上面。 */
  const doMergeInto = useCallback(async (branchName: string) => {
    setBranchOpen(false);
    const ok = await confirmAsync({
      title: isZh ? `合并 ${branchName}` : `Merge ${branchName}`,
      message: isZh
        ? `把 ${branchName} 合并进当前分支 ${branch}。有冲突会停下来等你处理。`
        : `Merge ${branchName} into ${branch}. It stops on conflicts for you to resolve.`,
      confirmLabel: isZh ? '合并' : 'Merge',
    });
    if (!ok) return;
    await run(isZh ? `合并 ${branchName}...` : `Merging ${branchName}...`, () => git().gitMerge(workspacePath, branchName));
  }, [workspacePath, run, isZh, branch]);
  const doRebaseOnto = useCallback(async (branchName: string) => {
    setBranchOpen(false);
    const ok = await confirmAsync({
      title: isZh ? `变基到 ${branchName}` : `Rebase onto ${branchName}`,
      message: isZh
        ? `把当前分支 ${branch} 的提交重新接到 ${branchName} 上面。提交会被重写（hash 变），已推送过的分支慎用。`
        : `Replay ${branch}'s commits on top of ${branchName}. Commits get rewritten (new hashes) — careful on a branch you already pushed.`,
      variant: 'danger',
      confirmLabel: isZh ? '变基' : 'Rebase',
    });
    if (!ok) return;
    await run(isZh ? `变基到 ${branchName}...` : `Rebasing onto ${branchName}...`, () => git().gitRebase(workspacePath, branchName));
  }, [workspacePath, run, isZh, branch]);

  const doCreateBranch = useCallback(async () => {
    const name = newBranchName.trim();
    if (!name || !!busy || !workspacePath) return;
    setBranchOpen(false);
    setCreatingBranch(false);
    setNewBranchName('');
    await run(
      isZh ? `创建分支 ${name}…` : `Creating branch ${name}…`,
      async () => {
        await git().gitCreateBranch(workspacePath, name, 'HEAD');
        await git().gitCheckout(workspacePath, name);
      },
    );
  }, [newBranchName, busy, workspacePath, run, isZh]);

  const doToggleStage = useCallback(async (f: GitFileStatus) => {
    try { if (f.area === 'staged') await git().gitUnstage(workspacePath, [f.path]); else await git().gitStage(workspacePath, [f.path]); await refresh(); } catch {}
  }, [workspacePath, refresh]);
  const doDiscard = useCallback(async (f: GitFileStatus) => {
    try { await git().gitDiscardFile(workspacePath, f.path, f.area === 'untracked' ? 'untracked' : 'tracked'); await refresh(); } catch {}
  }, [workspacePath, refresh]);

  const [pickedChange, setPickedChange] = useState('');
  const [changeDiff, setChangeDiff] = useState<CommitDiff | null>(null);
  const [changeLoading, setChangeLoading] = useState(false);
  const changeReq = useRef(0);
  const pickChange = useCallback(async (f: GitFileStatus) => {
    setPickedChange(f.path);
    setChangeLoading(true);
    const id = ++changeReq.current;
    try {
      /* 对照面是 HEAD 里的那一版; 未跟踪文件在 HEAD 里不存在 → 空串, 于是整份都算新增 */
      let original = '';
      if (f.area !== 'untracked') {
        try { original = await git().gitFileAtCommit(workspacePath, 'HEAD', f.path); } catch {}
      }
      let modified = '';
      try { const r = await git().readFile(absGitPath(gitRoot, f.path)); modified = r?.content ?? r ?? ''; } catch {}
      if (changeReq.current !== id) return;
      setChangeDiff(computeCommitDiff(original, modified));
    } catch {
      if (changeReq.current === id) setChangeDiff(null);
    } finally {
      if (changeReq.current === id) setChangeLoading(false);
    }
  }, [workspacePath, gitRoot]);
  const pickedFile = useMemo(
    () => status?.files.find((f) => f.path === pickedChange) ?? null,
    [status, pickedChange],
  );

  /* 选中的文件被提交/放弃之后就不在列表里了, 右栏跟着清掉 —— 否则会一直显示
   * 一个已经不存在的改动, 而且它的 diff 还是旧的。 */
  useEffect(() => {
    if (!pickedChange) return;
    if (!status?.files.some((f) => f.path === pickedChange)) {
      setPickedChange(''); setChangeDiff(null);
    }
  }, [status, pickedChange]);

  const openFileDiff = useCallback(async (f: GitFileStatus) => {
    try {
      let orig = ''; try { orig = await git().gitFileAtCommit(workspacePath, 'HEAD', f.path); } catch {}
      let mod = ''; try { const r = await (window.neox as any).readFile(toAbs(f.path)); mod = r?.content ?? r ?? ''; } catch {}
      /* onOpenDiff 仍传仓库相对路径 — gitDiffFile(cwd, path) 认的是这种 */
      openDiff(workspacePath, f.path, orig, mod, f.area === 'staged');
    } catch { openFile(workspacePath, toAbs(f.path)); }
  }, [workspacePath, openDiff, openFile, toAbs]);

  const openCommitFileDiff = useCallback(async (hash: string, fp: string) => {
    try {
      let orig = ''; try { orig = await git().gitFileAtCommit(workspacePath, `${hash}~1`, fp); } catch {}
      let mod = ''; try { mod = await git().gitFileAtCommit(workspacePath, hash, fp); } catch {}
      openDiff(workspacePath, fp, orig, mod);
    } catch { openFile(workspacePath, toAbs(fp)); }
  }, [workspacePath, openDiff, openFile, toAbs]);

  /* 宽版式下点一行是**选中** (右边换详情), 窄版式下才是就地展开 ——
   * 宽的时候再折叠一层内联列表就是把详情栏晾在那儿。 */
  const toggleCommitExpand = useCallback(async (hash: string) => {
    if (!wide && expandedCommit === hash) { setExpandedCommit(null); setCommitFiles([]); return; }
    if (expandedCommit === hash) return;
    setExpandedCommit(hash);
    setCommitFiles([]);
    setCollapsedCommitDirs(new Set());
    try { const d: CommitDetail = await git().gitShowCommit(workspacePath, hash); setCommitFiles(d.files ?? []); } catch { setCommitFiles([]); }
  }, [expandedCommit, workspacePath, wide]);

  /* 进历史页第一眼不该是一句"左边点一条提交" —— 右边那半屏 (这台上 643px) 全空着,
   * 而 99% 的情况下用户想看的就是最新那条。宽版式下自动选中第一条, 窄版式不动
   * (窄的时候选中 = 就地展开, 会顶着列表撑开一大块, 那不是用户要的第一眼)。 */
  useEffect(() => {
    if (section !== 'history' || !wide) return;
    if (expandedCommit || commits.length === 0) return;
    void toggleCommitExpand(commits[0].hash);
  }, [section, wide, expandedCommit, commits, toggleCommitExpand]);

  const loadCommitFile = useCallback(
    async (hash: string, fp: string): Promise<{ original: string; modified: string }> => {
      let original = ''; try { original = await git().gitFileAtCommit(workspacePath, `${hash}~1`, fp); } catch {}
      let modified = ''; try { modified = await git().gitFileAtCommit(workspacePath, hash, fp); } catch {}
      return { original, modified };
    },
    [workspacePath],
  );

  const flatChangeFiles = useMemo(() => {
    const byPath = (a: GitFileStatus, b: GitFileStatus) => a.path.localeCompare(b.path);
    return [...[...staged].sort(byPath), ...[...unstaged].sort(byPath)];
  }, [staged, unstaged]);

  /* 跟历史页一个道理: 宽版式下右边那半屏不该拿一句"点左边一个文件"占着。
   * 只在还没选过时自动选第一个 —— 用户手动清空选择的情况这里不会覆盖 (清空只发生在
   * 选中的文件消失时, 那时列表也变了, 重新落到第一个正是想要的)。 */
  useEffect(() => {
    if (section !== 'changes' || !wide) return;
    if (pickedChange || flatChangeFiles.length === 0) return;
    void pickChange(flatChangeFiles[0]!);
  }, [section, wide, pickedChange, flatChangeFiles, pickChange]);

  const onListKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const step = e.key === 'ArrowDown' ? 1 : -1;
    if (section === 'history') {
      if (commits.length === 0) return;
      const cur = commits.findIndex((c) => c.hash === expandedCommit);
      /* 还没选过时: 下键从第一条开始, 上键从最后一条 —— 比一律跳到 0 更符合方向 */
      const next = cur < 0 ? (step > 0 ? 0 : commits.length - 1) : cur + step;
      if (next < 0 || next >= commits.length) return;
      e.preventDefault();
      void toggleCommitExpand(commits[next]!.hash);
      return;
    }
    if (flatChangeFiles.length === 0) return;
    const cur = flatChangeFiles.findIndex((f) => f.path === pickedChange);
    const next = cur < 0 ? (step > 0 ? 0 : flatChangeFiles.length - 1) : cur + step;
    if (next < 0 || next >= flatChangeFiles.length) return;
    e.preventDefault();
    void pickChange(flatChangeFiles[next]!);
  }, [section, commits, expandedCommit, toggleCommitExpand, flatChangeFiles, pickedChange, pickChange]);

  /* 键盘选中的那一行要自己滚进视野 —— 否则按到第 20 条时选中态还在屏幕外,
   * 看着像"按了没反应"。block:'nearest' 是关键: 用 'center' 的话每按一下整列都在动。 */
  const listRef = useRef<HTMLDivElement>(null);
  const selKey = section === 'history' ? expandedCommit : pickedChange;
  useEffect(() => {
    if (!selKey) return;
    const el = listRef.current?.querySelector('.is-sel, .is-expanded');
    el?.scrollIntoView({ block: 'nearest' });
  }, [selKey, section]);

  /* 提交级操作 —— 都会改工作树/历史。确认和输入走仓库统一的 confirmAsync / promptAsync
   * (components/confirmEvents), 不用原生 confirm/prompt: 原生框不跟主题、在 Electron 里
   * 会锁住整个渲染进程, 而且 check:native-dialogs 这条闸本来就拦着。 */
  const doRevert = useCallback(async (hash: string) => {
    const ok = await confirmAsync({
      title: isZh ? '撤销这次提交' : 'Revert this commit',
      message: isZh
        ? `会在当前分支上新建一条把 ${hash.slice(0, 9)} 反过来的提交。历史里那条不会消失。`
        : `Creates a new commit on this branch that undoes ${hash.slice(0, 9)}. The original stays in history.`,
      variant: 'danger',
      confirmLabel: isZh ? '撤销' : 'Revert',
    });
    if (!ok) return;
    await run(isZh ? '撤销提交...' : 'Reverting...', () => git().gitRevert(workspacePath, hash));
  }, [workspacePath, run, isZh]);
  const doCherryPick = useCallback((hash: string) =>
    run(isZh ? '拣选提交...' : 'Cherry-picking...', () => git().gitCherryPick(workspacePath, hash)),
    [workspacePath, run, isZh]);
  const doResetTo = useCallback(async (hash: string, mode: 'mixed' | 'hard') => {
    const hard = mode === 'hard';
    const ok = await confirmAsync({
      title: hard
        ? (isZh ? '重置到这里并丢弃改动' : 'Reset here and discard changes')
        : (isZh ? '把分支重置到这里' : 'Reset branch to here'),
      message: isZh
        ? (hard
          ? `分支指回 ${hash.slice(0, 9)}，并且把工作区的文件也一起还原。未提交的改动会全部丢掉，这一步不可撤销。`
          : `分支指回 ${hash.slice(0, 9)}。这之后的提交离开分支，但工作区的文件一个都不动，改动会变成"未暂存"留给你。`)
        : (hard
          ? `Moves the branch back to ${hash.slice(0, 9)} and restores the files too. Uncommitted changes are lost — cannot be undone.`
          : `Moves the branch back to ${hash.slice(0, 9)}. Later commits leave the branch, but your files stay exactly as they are.`),
      variant: 'danger',
      confirmLabel: isZh ? '重置' : 'Reset',
    });
    if (!ok) return;
    await run(isZh ? '重置中...' : 'Resetting...', () => git().gitResetTo(workspacePath, hash, mode));
  }, [workspacePath, run, isZh]);

  const doUndoLastCommit = useCallback(async () => {
    const last = commits[0];
    if (!last) return;
    const ok = await confirmAsync({
      title: isZh ? '撤销上一次提交' : 'Undo last commit',
      message: last.message.split('\n')[0],
      description: isZh
        ? '提交会被取消，里面的改动原样回到「已暂存」，改完再提交一次就行。文件不会丢。'
        : 'The commit is undone; its changes go back to “staged” untouched. Nothing is lost.',
      confirmLabel: isZh ? '撤销' : 'Undo',
    });
    if (!ok) return;
    await run(isZh ? '撤销提交...' : 'Undoing...', () => git().gitResetTo(workspacePath, 'HEAD~1', 'soft'));
  }, [commits, workspacePath, run, isZh]);
  const doBranchAt = useCallback(async (hash: string) => {
    const name = await promptAsync({
      title: isZh ? '新建分支' : 'New branch',
      message: isZh ? `起点：${hash.slice(0, 9)}` : `From ${hash.slice(0, 9)}`,
      placeholder: isZh ? '分支名' : 'Branch name',
      confirmLabel: isZh ? '创建并切换' : 'Create & switch',
    });
    if (!name?.trim()) return;
    await run(isZh ? '创建分支...' : 'Creating branch...', async () => {
      await git().gitCreateBranch(workspacePath, name.trim(), hash);
      await git().gitCheckout(workspacePath, name.trim());
    });
  }, [workspacePath, run, isZh]);
  const doTagAt = useCallback(async (hash: string) => {
    const name = await promptAsync({
      title: isZh ? '打标签' : 'Create tag',
      message: isZh ? `标在：${hash.slice(0, 9)}` : `On ${hash.slice(0, 9)}`,
      placeholder: isZh ? '标签名，例如 v1.2.0' : 'Tag name, e.g. v1.2.0',
      confirmLabel: isZh ? '创建' : 'Create',
    });
    if (!name?.trim()) return;
    await run(isZh ? '打标签...' : 'Tagging...', () => git().gitCreateTag(workspacePath, name.trim(), hash));
  }, [workspacePath, run, isZh]);

  /* 点别处 / 按 Esc 关掉提交文件菜单 —— Changes 那份已有 ctxRef 的 outside-click,
   * 这份是新加的, 补上同样的行为。 */
  useEffect(() => {
    if (!commitCtx && !rowCtx) return;
    const close = () => { setCommitCtx(null); setRowCtx(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', onKey); };
  }, [commitCtx, rowCtx]);

  const handleCtxAction = useCallback(async (action: string) => {
    if (!ctxMenu) return; const f = ctxMenu.file; setCtxMenu(null);
    switch (action) {
      case 'stage': await doToggleStage(f); break; case 'discard': await doDiscard(f); break;
      case 'diff': await openFileDiff(f); break; case 'open': openFile(workspacePath, toAbs(f.path)); break;
      case 'copy-path': void copyToClipboard(f.path); break;
      case 'copy-abs': void copyToClipboard(toAbs(f.path)); break;
    }
  }, [ctxMenu, doToggleStage, doDiscard, openFileDiff, openFile, workspacePath, toAbs]);

  // branch dropdown filter
  const filteredLocal = useMemo(() => {
    const q = branchSearch.toLowerCase();
    return gitRefs.local.filter((b) => !q || b.toLowerCase().includes(q));
  }, [gitRefs.local, branchSearch]);
  const filteredRemote = useMemo(() => {
    const q = branchSearch.toLowerCase();
    return gitRefs.remote.filter((b) => !q || b.toLowerCase().includes(q));
  }, [gitRefs.remote, branchSearch]);

  const tabRow = (
    <div className="gc__tabrow">
      <div className="gc__tabs">
        <button className={`gc__tab${section === 'changes' ? ' is-active' : ''}`} onClick={() => setSection('changes')}>
          {isZh ? '改动' : 'Changes'}{totalChanges > 0 && <span className="gc__tab-count">{totalChanges}</span>}
        </button>
        <button className={`gc__tab${section === 'history' ? ' is-active' : ''}`} onClick={() => setSection('history')}>{isZh ? '历史' : 'History'}</button>
      </div>

          <label className={`gc__search${query ? ' has-value' : ''}`}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" aria-hidden>
              <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
            </svg>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setQuery(''); } }}
              placeholder={section === 'changes'
                ? (isZh ? '过滤文件' : 'Filter files')
                : (isZh ? '搜提交 / 作者 / hash' : 'Search commits')}
              aria-label={isZh ? '过滤' : 'Filter'}
            />
            {query && (
              <button type="button" className="gc__search-x" onClick={() => setQuery('')}
                      title={isZh ? '清空 (Esc)' : 'Clear (Esc)'} aria-label={isZh ? '清空' : 'Clear'}>×</button>
            )}
          </label>
    </div>
  );

  return (
    <div className={`gc${wide ? ' is-wide' : ''}`} ref={rootRef}>
      {/* Row 1: branch selector + pull/push + toolbar */}
      <div className="gc__toolbar">
        <div className="gc__branch-wrap" ref={branchRef}>
          <button className="gc__branch-btn" onClick={() => {
            setBranchOpen(!branchOpen);
            setBranchSearch('');
            setCreatingBranch(false);
            setNewBranchName('');
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M13 6h3a2 2 0 0 1 2 2v7" /><line x1="6" y1="9" x2="6" y2="21" /></svg>
            <span>{branch}</span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {branchOpen && (
            <div className="gc__branch-menu">
              {!creatingBranch && (
                <input
                  className="gc__branch-search"
                  placeholder={isZh ? '搜索分支...' : 'Search branches...'}
                  value={branchSearch}
                  onChange={(e) => setBranchSearch(e.target.value)}
                  autoFocus
                />
              )}
              {!creatingBranch && filteredLocal.length > 0 && (
                <>
                  <div className="gc__branch-section">{isZh ? '本地分支' : 'Local branches'}</div>
                  {filteredLocal.map((b) => (
                    <div
                      key={b}
                      className={`gc__branch-row${b === gitRefs.head ? ' is-current' : ''}${branchMenu?.name === b ? ' is-open' : ''}`}
                      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); clearHoverTimer(); openBranchMenu(e, b, 'local'); }}
                      onMouseEnter={(e) => onBranchHover(e, b, 'local')}
                      onMouseLeave={onBranchLeave}
                    >
                      <button className={`gc__branch-item${b === gitRefs.head ? ' is-current' : ''}`} onClick={() => doCheckout(b)}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M13 6h3a2 2 0 0 1 2 2v7" /><line x1="6" y1="9" x2="6" y2="21" /></svg>
                        <span>{b}</span>
                        {b === gitRefs.head && <span className="gc__branch-check">✓</span>}
                      </button>
                      <button
                        className="gc__branch-more"
                        title={isZh ? '这个分支能做什么' : 'Branch actions'}
                        aria-label={isZh ? '分支操作' : 'Branch actions'}
                        onClick={(e) => { e.stopPropagation(); clearHoverTimer(); openBranchMenu(e, b, 'local'); }}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
                      </button>
                    </div>
                  ))}
                </>
              )}
              {!creatingBranch && filteredRemote.length > 0 && (
                <>
                  <div className="gc__branch-section">{isZh ? '远程分支' : 'Remote branches'}</div>
                  {filteredRemote.map((b) => (
                    <div
                      key={b}
                      className={`gc__branch-row${branchMenu?.name === b ? ' is-open' : ''}`}
                      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); clearHoverTimer(); openBranchMenu(e, b, 'remote'); }}
                      onMouseEnter={(e) => onBranchHover(e, b, 'remote')}
                      onMouseLeave={onBranchLeave}
                    >
                      <button className="gc__branch-item" onClick={() => doCheckout(b)}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10" /></svg>
                        <span>{b}</span>
                      </button>
                      <button
                        className="gc__branch-more"
                        title={isZh ? '这个远程分支能做什么' : 'Remote branch actions'}
                        aria-label={isZh ? '分支操作' : 'Branch actions'}
                        onClick={(e) => { e.stopPropagation(); clearHoverTimer(); openBranchMenu(e, b, 'remote'); }}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
                      </button>
                    </div>
                  ))}
                </>
              )}
              {creatingBranch ? (
                <div className="gc__branch-create">
                  <input
                    className="gc__branch-create-input"
                    placeholder={isZh ? '新分支名，回车创建并切换' : 'Branch name, Enter to create & switch'}
                    value={newBranchName}
                    onChange={(e) => setNewBranchName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); void doCreateBranch(); }
                      if (e.key === 'Escape') { e.preventDefault(); setCreatingBranch(false); setNewBranchName(''); }
                    }}
                    autoFocus
                    disabled={!!busy}
                  />
                  <div className="gc__branch-create-actions">
                    <button
                      type="button"
                      className="gc__branch-item gc__branch-item--action"
                      onClick={() => void doCreateBranch()}
                      disabled={!!busy || !newBranchName.trim()}
                    >{isZh ? '创建并切换' : 'Create & switch'}</button>
                    <button
                      type="button"
                      className="gc__branch-item"
                      onClick={() => { setCreatingBranch(false); setNewBranchName(''); }}
                      disabled={!!busy}
                    >{isZh ? '取消' : 'Cancel'}</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="gc__branch-sep" />
                  <button
                    type="button"
                    className="gc__branch-item gc__branch-item--action"
                    onClick={() => setCreatingBranch(true)}
                    disabled={!!busy}
                  >{isZh ? '+ 新建分支...' : '+ New branch...'}</button>
                </>
              )}
            </div>
          )}
        </div>

        <div className="gc__toolbar-right">
          {!unavailableMsg && (
          <div className="gc__actions-wrap" ref={stashMenuRef}>
            <button
              className={`gc__tbtn${stashes.length > 0 ? ' has-count' : ''}`}
              onClick={() => setStashOpen((v) => !v)}
              title={stashes.length > 0
                ? (isZh ? `储藏 · ${stashes.length} 条` : `Stash · ${stashes.length}`)
                : (isZh ? '储藏当前改动' : 'Stash changes')}
              aria-label={isZh ? '储藏' : 'Stash'}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 8h18v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M3 8 5 3h14l2 5" /><path d="M10 12h4" />
              </svg>
              {stashes.length > 0 && <span className="gc__tbtn-n">{stashes.length}</span>}
            </button>
            {stashOpen && (
              <div className="gc__actions-menu gc__stash-menu">
                <button
                  className="gc__actions-item gc__actions-item--accent"
                  onClick={() => { setStashOpen(false); void doStash(); }}
                  disabled={totalChanges === 0}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14" /><path d="M5 12h14" /></svg>
                  {isZh ? '把当前改动存起来' : 'Stash current changes'}
                </button>
                {stashes.length > 0 && <div className="gc__actions-sep" />}
                {stashes.length === 0 && (
                  <div className="gc__stash-empty">{isZh ? '储藏栈是空的' : 'Stash stack is empty'}</div>
                )}
                {stashes.map((s) => (
                  <div key={s.index} className="gc__stash-row">
                    <span className="gc__stash-msg" title={s.message}>{s.message}</span>
                    <button
                      className="gc__stash-act"
                      title={isZh ? '取回并从栈里删掉' : 'Pop (apply and drop)'}
                      onClick={() => { setStashOpen(false); void run(isZh ? '弹出储藏...' : 'Popping...', () => git().gitStashPop(workspacePath, s.index)); }}
                    >{isZh ? '弹出' : 'Pop'}</button>
                    <button
                      className="gc__stash-act"
                      title={isZh ? '取回但留在栈里' : 'Apply but keep in stack'}
                      onClick={() => { setStashOpen(false); void run(isZh ? '应用储藏...' : 'Applying...', () => git().gitStashApply(workspacePath, s.index)); }}
                    >{isZh ? '应用' : 'Apply'}</button>
                    <button
                      className="gc__stash-act gc__stash-act--danger"
                      title={isZh ? '从栈里删掉 (不可撤销)' : 'Drop (cannot be undone)'}
                      onClick={async () => {
                        setStashOpen(false);
                        const ok = await confirmAsync({
                          title: isZh ? '删掉这条储藏' : 'Drop this stash',
                          message: s.message,
                          variant: 'danger',
                          confirmLabel: isZh ? '删掉' : 'Drop',
                        });
                        if (ok) void run(isZh ? '删除储藏...' : 'Dropping...', () => git().gitStashDrop(workspacePath, s.index));
                      }}
                    >×</button>
                  </div>
                ))}
              </div>
            )}
          </div>
          )}
          {!unavailableMsg && (
          <div className="gc__sync" role="group" aria-label={isZh ? '同步' : 'Sync'}>
            <button
              className={`gc__sync-btn${behind > 0 ? ' has-count' : ''}${syncBusy === 'pull' ? ' is-busy' : ''}`}
              onClick={() => void doPull()}
              disabled={!!syncBusy}
              title={behind > 0
                ? (isZh ? `拉取 · 远程比本地多 ${behind} 个提交` : `Pull · ${behind} commit(s) behind`)
                : (isZh ? '从远程拉取最新提交' : 'Pull the latest commits')}
              aria-label={isZh ? '拉取' : 'Pull'}
            >
              {syncBusy === 'pull'
                ? <SyncSpinner />
                : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12" /><path d="m6.5 10.5 5.5 5.5 5.5-5.5" /><path d="M5 20h14" /></svg>}
              <span className="gc__sync-label">
                {syncBusy === 'pull' ? (isZh ? '拉取中' : 'Pulling') : (isZh ? '拉取' : 'Pull')}
              </span>
              {behind > 0 && syncBusy !== 'pull' && <span className="gc__sync-n">{behind}</span>}
            </button>
            <span className="gc__sync-div" aria-hidden />
            <button
              className={`gc__sync-btn${ahead > 0 ? ' has-count is-primary' : ''}${syncBusy === 'push' ? ' is-busy' : ''}`}
              onClick={() => void doPush()}
              disabled={!!syncBusy}
              title={ahead > 0
                ? (isZh ? `推送 · 本地比远程多 ${ahead} 个提交` : `Push · ${ahead} commit(s) ahead`)
                : (isZh ? '把本地提交推到远程' : 'Push local commits to the remote')}
              aria-label={isZh ? '推送' : 'Push'}
            >
              {syncBusy === 'push'
                ? <SyncSpinner />
                : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round"><path d="M12 21V9" /><path d="m6.5 13.5 5.5-5.5 5.5 5.5" /><path d="M5 4h14" /></svg>}
              <span className="gc__sync-label">
                {syncBusy === 'push' ? (isZh ? '推送中' : 'Pushing') : (isZh ? '推送' : 'Push')}
              </span>
              {ahead > 0 && syncBusy !== 'push' && <span className="gc__sync-n">{ahead}</span>}
            </button>
          </div>
          )}
          {!unavailableMsg && (
          <div className="gc__actions-wrap" ref={actionsMenuRef}>
            <button className="gc__tbtn" onClick={() => setActionsOpen(!actionsOpen)} title={isZh ? '更多操作' : 'More actions'} aria-label={isZh ? '更多操作' : 'More actions'}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.2" fill="currentColor" stroke="none" /><circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none" /></svg>
            </button>
            {actionsOpen && (
              <div className="gc__actions-menu gc__actions-menu--all">
                <div className="gc__actions-title">{isZh ? '同步' : 'Sync'}</div>
                <button className="gc__actions-item" onClick={() => { setActionsOpen(false); doPull(); }} disabled={!!busy}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12" /><path d="m6.5 10.5 5.5 5.5 5.5-5.5" /><path d="M5 20h14" /></svg>
                  {isZh ? '拉取 (Pull)' : 'Pull'}
                  {behind > 0 && <span className="gc__actions-n">{behind}</span>}
                </button>
                <button className="gc__actions-item" onClick={() => { setActionsOpen(false); doPush(); }} disabled={!!busy}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 21V9" /><path d="m6.5 13.5 5.5-5.5 5.5 5.5" /><path d="M5 4h14" /></svg>
                  {isZh ? '推送 (Push)' : 'Push'}
                  {ahead > 0 && <span className="gc__actions-n">{ahead}</span>}
                </button>
                <button className="gc__actions-item" onClick={() => { setActionsOpen(false); doFetch(); }} disabled={!!busy}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
                  {isZh ? '获取远程 (Fetch)' : 'Fetch'}
                </button>

                <div className="gc__actions-sep" />
                <div className="gc__actions-title">{isZh ? '远程' : 'Remote'}</div>
                {remotes.length === 0 && (
                  <button className="gc__actions-item gc__actions-item--accent" onClick={() => { setActionsOpen(false); void doRemoteAdd(); }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18" /></svg>
                    {isZh ? '连接远程仓库…' : 'Connect a remote…'}
                  </button>
                )}
                {remotes.map((rm) => {
                  const web = remoteWebUrl(rm.url);
                  const host = remoteHostLabel(rm.url);
                  return (
                    <React.Fragment key={rm.name}>
                      <button
                        className="gc__actions-item"
                        disabled={!web}
                        title={web || rm.url}
                        onClick={() => { setActionsOpen(false); if (web) window.open(web, '_blank', 'noopener'); }}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 4h6v6" /><path d="M20 4 10 14" /><path d="M18 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" /></svg>
                        {web
                          ? (isZh ? `在 ${host || '浏览器'} 里打开` : `Open on ${host || 'the web'}`)
                          : (isZh ? '这个远程打不开网页' : 'No web URL for this remote')}
                      </button>
                      <button className="gc__actions-item" onClick={() => { setActionsOpen(false); void doRemoteEdit(rm); }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
                        {isZh ? `改 ${rm.name} 的地址…` : `Edit ${rm.name} URL…`}
                      </button>
                    </React.Fragment>
                  );
                })}

                <div className="gc__actions-sep" />
                <div className="gc__actions-title">{isZh ? '分支' : 'Branch'}</div>
                <button className="gc__actions-item" onClick={() => { setActionsOpen(false); setBranchOpen(true); setCreatingBranch(true); }} disabled={!!busy}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M13 6h3a2 2 0 0 1 2 2v7" /><line x1="6" y1="9" x2="6" y2="21" /></svg>
                  {isZh ? '新建分支…' : 'New branch…'}
                </button>
                <button className="gc__actions-item" onClick={() => { setActionsOpen(false); setBranchOpen(true); }} disabled={!!busy}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 6h11" /><path d="m16 3 3 3-3 3" /><path d="M16 18H5" /><path d="m8 21-3-3 3-3" /></svg>
                  {isZh ? '切换 / 合并 / 变基…' : 'Switch / merge / rebase…'}
                </button>

                {/* 打标签和撤销提交都是**对提交**做的事, 不是分支操作 —— 原来挤在"分支"
                  * 那一组里, 想撤销上一次提交的人不会往"分支"底下找。 */}
                <div className="gc__actions-sep" />
                <div className="gc__actions-title">{isZh ? '提交' : 'Commit'}</div>
                <button className="gc__actions-item" onClick={() => { setActionsOpen(false); void doTagAt('HEAD'); }} disabled={!!busy}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.6 13.4 12 4.8V2H4v8h2.8l8.6 8.6a2 2 0 0 0 2.8 0l2.4-2.4a2 2 0 0 0 0-2.8z" /><circle cx="7.5" cy="6.5" r="1" /></svg>
                  {isZh ? '给当前提交打标签…' : 'Tag current commit…'}
                </button>
                <button className="gc__actions-item" onClick={() => { setActionsOpen(false); void doUndoLastCommit(); }} disabled={!!busy || commits.length === 0}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7v6h6" /><path d="M3.5 13a9 9 0 1 0 2.2-9.3L3 7" /></svg>
                  {isZh ? '撤销上一次提交' : 'Undo last commit'}
                </button>

                <div className="gc__actions-sep" />
                <div className="gc__actions-title">{isZh ? '暂存区' : 'Staging'}</div>
                <button className="gc__actions-item" onClick={() => { setActionsOpen(false); doStageAll(); }} disabled={unstaged.length === 0}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                  {isZh ? '暂存全部' : 'Stage all'}
                </button>
                <button className="gc__actions-item" onClick={() => { setActionsOpen(false); void run(isZh ? '取消暂存...' : 'Unstaging...', () => git().gitUnstageAll(workspacePath)); }} disabled={staged.length === 0}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="5" y1="12" x2="19" y2="12" /></svg>
                  {isZh ? '取消全部暂存' : 'Unstage all'}
                </button>

                <div className="gc__actions-sep" />
                <div className="gc__actions-title">{isZh ? '储藏' : 'Stash'}</div>
                <button className="gc__actions-item" onClick={() => { setActionsOpen(false); void doStash(); }} disabled={totalChanges === 0}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8h18v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M3 8 5 3h14l2 5" /><path d="M10 12h4" /></svg>
                  {isZh ? '把当前改动存起来' : 'Stash current changes'}
                </button>
                <button className="gc__actions-item" onClick={() => { setActionsOpen(false); setStashOpen(true); }} disabled={stashes.length === 0}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V3" /><path d="m5 12 7 7 7-7" /></svg>
                  {isZh ? '打开储藏栈' : 'Open stash stack'}
                  {stashes.length > 0 && <span className="gc__actions-n">{stashes.length}</span>}
                </button>

                <div className="gc__actions-sep" />
                <button className="gc__actions-item gc__actions-item--danger" onClick={async () => {
                  setActionsOpen(false);
                  const ok = await confirmAsync({
                    title: isZh ? '放弃所有未提交的改动' : 'Discard all uncommitted changes',
                    message: isZh
                      ? `工作区里 ${totalChanges} 个文件的改动会全部丢掉，这一步不可撤销。`
                      : `All changes in ${totalChanges} file(s) are thrown away. This cannot be undone.`,
                    variant: 'danger',
                    confirmLabel: isZh ? '放弃' : 'Discard',
                  });
                  if (ok) void run(isZh ? '放弃所有更改...' : 'Discarding all changes...', () => git().gitDiscardWorktree(workspacePath));
                }} disabled={totalChanges === 0}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg>
                  {isZh ? '放弃所有更改' : 'Discard all changes'}
                </button>
              </div>
            )}
          </div>
          )}
        </div>
      </div>


      {repoState && (() => {
        const label = repoState.kind === 'merge' ? (isZh ? '合并' : 'merge')
          : repoState.kind === 'rebase' ? (isZh ? '变基' : 'rebase')
          : repoState.kind === 'cherry-pick' ? (isZh ? '拣选' : 'cherry-pick')
          : (isZh ? '撤销提交' : 'revert');
        const prog = repoState.total ? ` ${repoState.step ?? '?'}/${repoState.total}` : '';
        const onto = repoState.onto ? (isZh ? `（${repoState.onto}）` : ` (${repoState.onto})`) : '';
        const nConflict = conflicts.length;
        return (
          <div className={`gc__opbar${nConflict > 0 ? ' has-conflict' : ''}`} role="status">
            <span className="gc__opbar-dot" aria-hidden />
            <span className="gc__opbar-text">
              <strong>{isZh ? `正在${label}${prog}${onto}` : `${label}${prog} in progress${onto}`}</strong>
              <span className="gc__opbar-sub">
                {nConflict > 0
                  ? (isZh ? `${nConflict} 个文件有冲突，解决后点「继续」` : `${nConflict} file(s) conflict — resolve, then Continue`)
                  : (isZh ? '冲突都解决了，可以继续' : 'No conflicts left — you can continue')}
              </span>
            </span>
            <button className="gc__opbar-btn gc__opbar-btn--go" onClick={doOpContinue}
                    disabled={!!busy || nConflict > 0}
                    title={nConflict > 0
                      ? (isZh ? '还有冲突没解决' : 'Conflicts still unresolved')
                      : (isZh ? '继续这次操作' : 'Continue')}>
              {isZh ? '继续' : 'Continue'}
            </button>
            {(repoState.kind === 'rebase' || repoState.kind === 'cherry-pick') && (
              <button className="gc__opbar-btn" onClick={doOpSkip} disabled={!!busy}
                      title={isZh ? '跳过当前这条提交' : 'Skip this commit'}>
                {isZh ? '跳过' : 'Skip'}
              </button>
            )}
            <button className="gc__opbar-btn gc__opbar-btn--stop" onClick={() => void doOpAbort(label)} disabled={!!busy}>
              {isZh ? '中止' : 'Abort'}
            </button>
          </div>
        );
      })()}

      {error && <div className="gc__toast gc__toast--err">{error}<button className="gc__toast-x" onClick={() => setError('')}>×</button></div>}
      {busy && <div className="gc__toast">{busy}</div>}

      {/* 右键菜单必须 portal 到 body。
        *
        *  它是 position:fixed + left/top = 鼠标的视口坐标, 但 Agent 模式下右栏的祖先
        *  .neox-shell__right-mode-pane 带 transform + contain:content —— 这会把 fixed 的
        *  参照系从视口改成那个面板。于是 left:1051 实际落在 x=2072, 而窗口宽只有 1700,
        *  菜单整个飞到屏幕外, 表现为"右键没有任何反应"。(IDE 模式下该祖先不在链上,
        *  所以同一份代码在 IDE 里一直是好的, 只有 Surface 里坏。)
        *
        *  portal 到 body 后就不再有被 transform 污染的祖先; 顺带把坐标夹在视口内,
        *  在靠右/靠下边缘点右键时菜单也不会有一半在外面。 */}
      {ctxMenu && createPortal(
        <div
          ref={ctxRef}
          className="gc__ctx"
          style={{
            left: Math.min(ctxMenu.x, Math.max(8, interactionWin().innerWidth - 196)),
            top: Math.min(ctxMenu.y, Math.max(8, interactionWin().innerHeight - 220)),
          }}
        >
          <button className="gc__ctx-item" onClick={() => handleCtxAction('diff')}>{isZh ? '查看差异' : 'View diff'}</button>
          <button className="gc__ctx-item" onClick={() => handleCtxAction('open')}>{isZh ? '打开文件' : 'Open file'}</button>
          <div className="gc__ctx-sep" />
          <button className="gc__ctx-item" onClick={() => handleCtxAction('stage')}>{ctxMenu.file.area === 'staged' ? (isZh ? '取消暂存' : 'Unstage') : (isZh ? '暂存文件' : 'Stage file')}</button>
          {ctxMenu.file.area !== 'staged' && <button className="gc__ctx-item gc__ctx-item--danger" onClick={() => handleCtxAction('discard')}>{isZh ? '放弃更改' : 'Discard changes'}</button>}
          <div className="gc__ctx-sep" />
          <button className="gc__ctx-item" onClick={() => handleCtxAction('copy-path')}>{isZh ? '复制相对路径' : 'Copy relative path'}</button>
          <button className="gc__ctx-item" onClick={() => handleCtxAction('copy-abs')}>{isZh ? '复制绝对路径' : 'Copy absolute path'}</button>
        </div>,
        interactionDoc().body,
      )}

      {/* 提交内文件的右键菜单 —— 同样 portal 到 body (见上方 fixed 参照系的说明) */}
      {commitCtx && createPortal(
        <div
          className="gc__ctx"
          style={{
            left: Math.min(commitCtx.x, Math.max(8, interactionWin().innerWidth - 196)),
            top: Math.min(commitCtx.y, Math.max(8, interactionWin().innerHeight - 180)),
          }}
          onMouseLeave={() => setCommitCtx(null)}
        >
          <button className="gc__ctx-item" onClick={() => { const c = commitCtx; setCommitCtx(null); void openCommitFileDiff(c.hash, c.path); }}>
            {isZh ? '查看这次提交的改动' : 'View change in this commit'}
          </button>
          <button className="gc__ctx-item" onClick={() => { const c = commitCtx; setCommitCtx(null); openFile(workspacePath, toAbs(c.path)); }}>
            {isZh ? '打开当前版本' : 'Open current version'}
          </button>
          <div className="gc__ctx-sep" />
          <button className="gc__ctx-item" onClick={() => { const c = commitCtx; setCommitCtx(null); void copyToClipboard(c.path); }}>
            {isZh ? '复制相对路径' : 'Copy relative path'}
          </button>
          <button className="gc__ctx-item" onClick={() => { const c = commitCtx; setCommitCtx(null); void copyToClipboard(toAbs(c.path)); }}>
            {isZh ? '复制绝对路径' : 'Copy absolute path'}
          </button>
          <button className="gc__ctx-item" onClick={() => { const c = commitCtx; setCommitCtx(null); void copyToClipboard(c.hash); }}>
            {isZh ? '复制提交 hash' : 'Copy commit hash'}
          </button>
        </div>,
        interactionDoc().body,
      )}

      {/* 分支的二级菜单 —— portal 到 body (跟其它菜单同一个理由: Surface 里祖先带
        * transform, position:fixed 的参照系会被改掉, 菜单会飞到屏幕外)。 */}
      {branchMenu && createPortal(
        <div
          className="gc__ctx gc__branch-menu2"
          style={{
            left: Math.min(branchMenu.x, Math.max(8, interactionWin().innerWidth - 236)),
            top: Math.min(branchMenu.y, Math.max(8, interactionWin().innerHeight - 300)),
          }}
          onMouseDown={(e) => e.stopPropagation()}
          /* 鼠标走进菜单 = 还想用它, 取消那个待关闭的定时器 */
          onMouseEnter={clearHoverTimer}
          onMouseLeave={onBranchLeave}
        >
          <div className="gc__ctx-head" title={branchMenu.name}>{branchMenu.name}</div>
          {/* 领先/落后 —— 决定"该合并还是该变基"最需要的一句话, 而它此前根本不显示。
            * div === undefined 是"还在查", null 是"没有可比的基准", 两者说的不是一回事。 */}
          {branchMenu.div !== null && branchMenu.name !== (gitRefs.head || branch) && (
            <div className="gc__branch-div">
              {branchMenu.div === undefined
                ? (isZh ? '比对中…' : 'Comparing…')
                : (branchMenu.div.ahead === 0 && branchMenu.div.behind === 0
                  ? (isZh ? '跟当前分支一致' : 'Same as current branch')
                  : (isZh
                    ? `相对 ${gitRefs.head || branch}：领先 ${branchMenu.div.ahead} · 落后 ${branchMenu.div.behind}`
                    : `vs ${gitRefs.head || branch}: ${branchMenu.div.ahead} ahead · ${branchMenu.div.behind} behind`))}
            </div>
          )}
          <div className="gc__ctx-sep" />
          {branchMenu.name !== (gitRefs.head || branch) && (
            <button className="gc__ctx-item" onClick={() => { const n = branchMenu.name; setBranchMenu(null); doCheckout(n); }}>
              {isZh ? '切换到这个分支' : 'Switch to this branch'}
            </button>
          )}
          <button className="gc__ctx-item" onClick={() => { const n = branchMenu.name; setBranchMenu(null); void doBranchFrom(n); }}>
            {isZh ? '从这里新建分支…' : 'New branch from here…'}
          </button>
          {branchMenu.name !== (gitRefs.head || branch) && (
            <>
              <div className="gc__ctx-sep" />
              <button className="gc__ctx-item" onClick={() => { const n = branchMenu.name; setBranchMenu(null); void doMergeInto(n); }}>
                {isZh ? `合并进 ${gitRefs.head || branch}` : `Merge into ${gitRefs.head || branch}`}
              </button>
              <button className="gc__ctx-item" onClick={() => { const n = branchMenu.name; setBranchMenu(null); void doRebaseOnto(n); }}>
                {isZh ? '把当前分支变基到这里' : 'Rebase current branch onto this'}
              </button>
            </>
          )}
          <div className="gc__ctx-sep" />
          <button className="gc__ctx-item" onClick={() => { const n = branchMenu.name; setBranchMenu(null); void copyToClipboard(n); }}>
            {isZh ? '复制分支名' : 'Copy branch name'}
          </button>
          {branchMenu.kind === 'local' && (
            <button className="gc__ctx-item" onClick={() => { const n = branchMenu.name; setBranchMenu(null); void doRenameBranch(n); }}>
              {isZh ? '重命名…' : 'Rename…'}
            </button>
          )}
          {branchMenu.kind === 'local' && branchMenu.name !== (gitRefs.head || branch) && (
            <button className="gc__ctx-item gc__ctx-item--danger" onClick={() => { const n = branchMenu.name; setBranchMenu(null); void doDeleteBranch(n); }}>
              {isZh ? '删除这个分支' : 'Delete this branch'}
            </button>
          )}
        </div>,
        interactionDoc().body,
      )}

      {rowCtx && createPortal(
        <div
          className="gc__ctx"
          style={{
            left: Math.min(rowCtx.x, Math.max(8, interactionWin().innerWidth - 232)),
            top: Math.min(rowCtx.y, Math.max(8, interactionWin().innerHeight - 300)),
          }}
        >
          <div className="gc__ctx-head" title={rowCtx.c.message}>{rowCtx.c.shortHash} · {rowCtx.c.message}</div>
          <div className="gc__ctx-sep" />
          <button className="gc__ctx-item" onClick={() => { const h = rowCtx.c.hash; setRowCtx(null); void doCherryPick(h); }}>
            {isZh ? '拣选到当前分支 (Cherry-pick)' : 'Cherry-pick onto current branch'}
          </button>
          <button className="gc__ctx-item" onClick={() => { const h = rowCtx.c.hash; setRowCtx(null); void doBranchAt(h); }}>
            {isZh ? '从这里新建分支…' : 'New branch from here…'}
          </button>
          <button className="gc__ctx-item" onClick={() => { const h = rowCtx.c.hash; setRowCtx(null); void doTagAt(h); }}>
            {isZh ? '在这里打标签…' : 'Tag this commit…'}
          </button>
          <div className="gc__ctx-sep" />
          <button className="gc__ctx-item" onClick={() => { const c = rowCtx.c; setRowCtx(null); void copyToClipboard(c.hash); }}>
            {isZh ? '复制提交 hash' : 'Copy commit hash'}
          </button>
          <button className="gc__ctx-item" onClick={() => { const c = rowCtx.c; setRowCtx(null); void copyToClipboard(c.message); }}>
            {isZh ? '复制提交说明' : 'Copy commit message'}
          </button>
          <div className="gc__ctx-sep" />
          <button className="gc__ctx-item gc__ctx-item--danger" onClick={() => { const h = rowCtx.c.hash; setRowCtx(null); void doRevert(h); }}>
            {isZh ? '撤销这次提交 (Revert)' : 'Revert this commit'}
          </button>
          <button className="gc__ctx-item" onClick={() => { const h = rowCtx.c.hash; setRowCtx(null); void doResetTo(h, 'mixed'); }}>
            {isZh ? '重置到这里（保留改动）…' : 'Reset here (keep changes)…'}
          </button>
          <button className="gc__ctx-item gc__ctx-item--danger" onClick={() => { const h = rowCtx.c.hash; setRowCtx(null); void doResetTo(h, 'hard'); }}>
            {isZh ? '重置到这里并丢弃改动…' : 'Reset here and discard changes…'}
          </button>
        </div>,
        interactionDoc().body,
      )}

      {unavailableMsg && (
        <EmptyState
          className="gc__empty-state"
          icon={null}
          art={NeoxIllus.git}
          title={unavailableReason === 'not-a-repo'
            ? (isZh ? '还不是 git 仓库' : 'Not a git repository')
            : unavailableReason === 'no-workspace'
              ? (isZh ? '还没有打开项目' : 'No project open')
              : (isZh ? 'Git 面板不展示这个项目' : 'Git panel is off for this project')}
          desc={unavailableMsg}
          actions={unavailableReason === 'not-a-repo' ? (
            <button
              type="button"
              /* 跟 GitSurfaceViewer 的「选择项目」同一颗 —— 空态里的主操作在这个产品里
               * 就是 nx-btn--sm --primary。别用 .gc__fgroup-action: 那是分组标题行右端的
               * 无框文字链 (还带 margin-left:auto), 摆到居中空态里既不像按钮也会被推到右边。 */
              className="nx-btn nx-btn--sm nx-btn--primary"
              disabled={!!busy || !workspacePath}
              onClick={() => void doGitInit()}
            >
              {busy === (isZh ? '初始化仓库...' : 'Initializing...')
                ? (isZh ? '初始化中…' : 'Initializing…')
                : (isZh ? '初始化 git 仓库' : 'Initialize repository')}
            </button>
          ) : undefined}
        />
      )}

      {section === 'changes' && !unavailableMsg && (
      <div className={`gc__hist${wide && totalChanges > 0 ? ' is-split' : ''}`}>
        <div className="gc__hlist" ref={listRef} tabIndex={0} onKeyDown={onListKeyDown}>
        {tabRow}
        <div className="gc__scroll">
          <GitStatusLimitNote truncated={status?.truncated} untrackedMode={status?.untrackedMode} />
          {conflicts.length > 0 && (
            <div className="gc__fgroup gc__fgroup--conflict">
              <div className="gc__fgroup-head">
                <span>{isZh ? '冲突' : 'Conflicts'}</span>
                <span className="gc__fgroup-count">{conflicts.length}</span>
              </div>
              {[...conflicts].sort((a, b) => PATH_COLLATOR.compare(a.path, b.path)).map((file) => {
                const parts = file.path.split(/[/\\]/).filter(Boolean);
                const name = parts[parts.length - 1] ?? file.path;
                return (
                  <div
                    key={`conflict:${file.path}`}
                    className={`gc__frow gc__frow--conflict${pickedChange === file.path ? ' is-sel' : ''}`}
                    title={file.path}
                    onClick={() => (wide ? void pickChange(file) : void openFileDiff(file))}
                    onDoubleClick={() => void openFileDiff(file)}
                    onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, file }); }}
                  >
                    <GitFileMark path={file.path} />
                    <span className="gc__fname">{name}</span>
                    <span className="gc__fpath">{shortDir(parts.slice(0, -1))}</span>
                    <span className="gc__fresolve">
                      <button
                        className="gc__fbtn gc__fbtn--wide"
                        onClick={(e) => { e.stopPropagation(); void doResolveWith(file.path, 'ours'); }}
                        title={isZh ? '这个文件用我这边的版本' : 'Take my version for this file'}
                      >{isZh ? '用我的' : 'Ours'}</button>
                      <button
                        className="gc__fbtn gc__fbtn--wide"
                        onClick={(e) => { e.stopPropagation(); void doResolveWith(file.path, 'theirs'); }}
                        title={isZh ? '这个文件用对面的版本' : 'Take their version for this file'}
                      >{isZh ? '用他们的' : 'Theirs'}</button>
                      <button
                        className="gc__fbtn"
                        onClick={(e) => { e.stopPropagation(); void doToggleStage(file); }}
                        title={isZh ? '我已经手动改好了，标记为已解决' : 'I fixed it by hand — mark resolved'}
                      >✓</button>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          {shownStaged.length > 0 && (
            <div className="gc__fgroup">
              <div className="gc__fgroup-head">
                <span>{isZh ? '已暂存' : 'Staged'}</span>
                <span className="gc__fgroup-count">{shownStaged.length}</span>
                <button
                  type="button"
                  className="gc__fgroup-act"
                  onClick={() => void run(isZh ? '取消暂存...' : 'Unstaging...', () => git().gitUnstageAll(workspacePath))}
                  title={isZh ? '全部取消暂存' : 'Unstage all'}
                  aria-label={isZh ? '全部取消暂存' : 'Unstage all'}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><line x1="5" y1="12" x2="19" y2="12" /></svg>
                </button>
              </div>
              <ChangesFileList
                files={shownStaged}
                onToggle={doToggleStage}
                onDiscard={doDiscard}
                /* 宽版式: 单击 = 在右栏预览; 双击才开成真正的编辑器 tab。
                 * 窄版式没有右栏, 单击维持原来的"开 diff tab"。 */
                onClick={wide ? pickChange : openFileDiff}
                onDoubleClick={openFileDiff}
                selectedPath={wide ? pickedChange : ''}
                onContextMenu={(e, f) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, file: f }); }}
              />
            </div>
          )}
          {shownUnstaged.length > 0 && (
            <div className="gc__fgroup">
              <div className="gc__fgroup-head">
                <span>{isZh ? '未暂存' : 'Changes'}</span>
                <span className="gc__fgroup-count">{shownUnstaged.length}</span>
                <button
                  type="button"
                  className="gc__fgroup-act"
                  onClick={doStageAll}
                  title={isZh ? '全部暂存' : 'Stage all'}
                  aria-label={isZh ? '全部暂存' : 'Stage all'}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                </button>
              </div>
              <ChangesFileList
                files={shownUnstaged}
                onToggle={doToggleStage}
                onDiscard={doDiscard}
                /* 宽版式: 单击 = 在右栏预览; 双击才开成真正的编辑器 tab。
                 * 窄版式没有右栏, 单击维持原来的"开 diff tab"。 */
                onClick={wide ? pickChange : openFileDiff}
                onDoubleClick={openFileDiff}
                selectedPath={wide ? pickedChange : ''}
                onContextMenu={(e, f) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, file: f }); }}
              />
            </div>
          )}
          {/* 同上: 过滤后一个不剩 ≠ 工作区干净 */}
          {totalChanges > 0 && conflicts.length === 0 && shownStaged.length === 0 && shownUnstaged.length === 0 && (
            <div className="gc__nores">
              {/* 「筛完了没剩下」跟「工作区干净」是两种空, 换了插画才分得开:
                * clean 是空托盘 (做完了), nomatch 是放大镜压在一叠卡上 (东西在, 你没捞着)。 */}
              <img className="gc__nores-art" src={NeoxIllus.nomatch} alt="" aria-hidden draggable={false} />
              {isZh ? `没有匹配「${query}」的文件` : `No files match “${query}”`}
              <button className="gc__nores-x" onClick={() => setQuery('')}>{isZh ? '清空过滤' : 'Clear filter'}</button>
            </div>
          )}
          {totalChanges === 0 && (
            <EmptyState
              className="gc__empty-state"
              icon={null}
              art={NeoxIllus.clean}
              title={isZh ? '工作区干净' : 'Working tree clean'}
              desc={isZh ? '没有未提交的改动' : 'Nothing to commit'}
            />
          )}
        </div>

        {totalChanges > 0 && (
          <div className="gc__commit">
            <textarea
              className="gc__commit-input"
              placeholder={isZh ? '提交说明…' : 'Commit message…'}
              value={commitMsg}
              rows={2}
              onChange={(e) => setCommitMsg(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void doCommit(false); }
              }}
            />
            <div className="gc__commit-foot">
              {!amend && staged.length === 0 && unstaged.length > 0 ? (
                <button
                  type="button"
                  className="gc__commit-status gc__commit-status--act"
                  onClick={doStageAll}
                  disabled={!!busy}
                >
                  {isZh ? `暂存全部 ${unstaged.length} 个文件` : `Stage all ${unstaged.length} files`}
                </button>
              ) : (
                <span className="gc__commit-status">
                  {amend
                    ? (isZh ? '改写上一次提交' : 'Amending last commit')
                    : staged.length === 0
                      ? (isZh ? '还没暂存文件' : 'Nothing staged')
                      : (isZh ? `${staged.length} 个文件已暂存` : `${staged.length} staged`)}
                </span>
              )}
              {/* amend —— gitCommit 的第三个参数早就支持, 一直没有入口。
                * 做成一颗小开关而不是菜单项: 它是"这一次提交怎么算"的修饰词,
                * 就该待在你写说明的地方, 而不是隔着一个菜单。 */}
              <button
                type="button"
                className={`gc__commit-amend${amend ? ' is-on' : ''}`}
                onClick={toggleAmend}
                disabled={commits.length === 0 || !!busy}
                title={isZh
                  ? '把这次的改动并进上一条提交，而不是新建一条（会改写它的 hash）'
                  : 'Fold this into the previous commit instead of creating a new one (rewrites its hash)'}
                aria-pressed={amend}
              >
                {isZh ? '改上一条' : 'Amend'}
              </button>
              {/* 提交 + 提交并推送 —— 主按钮带一颗下拉。
                * "提交完顺手推上去"是最高频的下一步, 而它此前要再跑一趟工具栏。 */}
              <span className="gc__commit-split">
                <button
                  type="button"
                  className="gc__commit-btn"
                  onClick={() => void doCommit(false)}
                  disabled={!canCommit}
                  title={busy
                    ? (isZh ? '正在执行 git 操作' : 'Git is busy')
                    : !commitMsg.trim()
                      ? (isZh ? '先写一句提交说明' : 'Write a commit message first')
                      : (!amend && staged.length === 0)
                        ? (isZh ? '先把要提交的文件暂存 (点文件右侧的 +)' : 'Stage files first (+ on a file)')
                        : (isZh ? '提交 (⌘↵)' : 'Commit (⌘↵)')}
                >
                  {isZh ? '提交' : 'Commit'}
                </button>
                <button
                  type="button"
                  className="gc__commit-btn gc__commit-btn--more"
                  onClick={() => void doCommit(true)}
                  disabled={!canCommit}
                  title={isZh ? '提交并推送到远程' : 'Commit and push'}
                  aria-label={isZh ? '提交并推送' : 'Commit and push'}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5" /><path d="m6 11 6-6 6 6" /></svg>
                </button>
              </span>
            </div>
          </div>
        )}
        </div>

        {wide && totalChanges > 0 && (
          <div className="gc__hdetail">
            <div className="gcd">
              <div className="gcd__diff-wrap">
                {pickedFile && (
                  <div className="gcd__diff-head">
                    <span className="gcd__diff-path" title={pickedFile.path}>{pickedFile.path}</span>
                    <button
                      type="button"
                      className="gcd__act"
                      onClick={() => void doToggleStage(pickedFile)}
                      title={pickedFile.area === 'staged' ? (isZh ? '取消暂存' : 'Unstage') : (isZh ? '暂存这个文件' : 'Stage this file')}
                    >
                      {pickedFile.area === 'staged' ? (isZh ? '取消暂存' : 'Unstage') : (isZh ? '暂存' : 'Stage')}
                    </button>
                    <button
                      type="button"
                      className="gcd__act"
                      onClick={() => openFile(workspacePath, toAbs(pickedFile.path))}
                      title={isZh ? '在编辑器里打开' : 'Open in editor'}
                    >
                      {isZh ? '打开' : 'Open'}
                    </button>
                    {pickedFile.area !== 'staged' && (
                      <button
                        type="button"
                        className="gcd__act gcd__act--danger"
                        onClick={() => void doDiscard(pickedFile)}
                        title={isZh ? '放弃这个文件的改动（不可撤销）' : 'Discard changes (cannot be undone)'}
                      >
                        {isZh ? '放弃' : 'Discard'}
                      </button>
                    )}
                  </div>
                )}
                <DiffBody
                  diff={changeDiff}
                  loading={changeLoading}
                  path={pickedChange}
                  status={pickedFile ? (pickedFile.area === 'staged' ? pickedFile.indexStatus : pickedFile.worktreeStatus) : ''}
                  idleHint={isZh ? '点左边一个文件，看它改了什么' : 'Pick a file on the left to see its changes'}
                />
              </div>
            </div>
          </div>
        )}
      </div>
      )}

      {section === 'history' && !unavailableMsg && (
        <div className={`gc__hist${wide ? ' is-split' : ''}`}>
          {/* 历史页的左栏没有提交卡, 但结构跟改动页保持一致 (hlist 是竖 flex,
            * 里面一个滚动区) —— 两处共用 .gc__hlist 的宽度和分栏线规则。 */}
          <div className="gc__hlist" ref={listRef} tabIndex={0} onKeyDown={onListKeyDown}>{tabRow}<div className="gc__scroll">
            {/* 这个才是真空态 (仓库里一条提交都没有), 给插画。 */}
            {/* 过滤后一条不剩 ≠ 仓库没有提交。两句话必须分开说, 否则搜了个不存在的词
              * 会得到"这个仓库还没有任何提交记录"—— 一句在这个语境下是假的话。 */}
            {shownCommits.length === 0 && commits.length > 0 && (
              <div className="gc__nores">
                <img className="gc__nores-art" src={NeoxIllus.nomatch} alt="" aria-hidden draggable={false} />
                {isZh ? `没有匹配「${query}」的提交` : `No commits match “${query}”`}
                <button className="gc__nores-x" onClick={() => setQuery('')}>{isZh ? '清空过滤' : 'Clear filter'}</button>
              </div>
            )}
            {shownCommits.length === 0 && commits.length === 0 && (
              <EmptyState
                className="gc__empty-state"
                icon={null}
                art={NeoxIllus.git}
                title={isZh ? '还没有提交' : 'No commits yet'}
                desc={isZh ? '这个仓库还没有任何提交记录' : 'This repository has no commit history yet'}
              />
            )}
            {shownCommits.map((c, i) => (
              <div
                key={c.hash}
                className={`gc__hitem${expandedCommit === c.hash ? (wide ? ' is-sel' : ' is-expanded') : ''}`}
                /* 图区宽度是动态的 (分支多就宽) —— 标题行的左内边距和展开列表的缩进
                 * 都按它算, CSS 自己算不出来, 从这儿传下去。 */
                style={{ ['--gc-graph-w' as string]: `${graphCols * LANE_W}px` }}
                onContextMenu={(e) => { e.preventDefault(); setRowCtx({ x: e.clientX, y: e.clientY, c }); }}
              >
                {/* 分支图 —— 绝对定位铺满这一条的高度, 所以展开时线也不断 (见 CommitGraphCell) */}
                <CommitGraphCell row={graphRows[i] ?? EMPTY_GRAPH_ROW} width={graphCols} />
                <div className="gc__hitem-row" onClick={() => toggleCommitExpand(c.hash)}>
                  <div className="gc__hitem-body">
                    <div className="gc__hitem-line">
                      {/* refs (HEAD / 分支 / tag) —— 后端一直在给 %D, 但从来没渲染过。
                        * 没有它就看不出"我现在在哪儿"、哪条是发布点。 */}
                      {parseRefs(c.refs).map((r) => (
                        <span key={r.label} className={`gc__ref gc__ref--${r.kind}`}>{r.label}</span>
                      ))}
                      <span className="gc__hitem-msg" title={c.message}>{c.message}</span>
                    </div>
                    {/* 元数据降级成一行淡色小字, 不再是"第二行同等重量的内容"。
                      * 作者只在**多人仓库**才显示 —— 单人仓库里每条都写同一个名字是纯噪音,
                      * 它占掉的是本来该给提交消息的宽度。 */}
                    <span className="gc__hitem-meta">
                      <span className="gc__hitem-hash">{c.shortHash}</span>
                      {showAuthors && <span className="gc__hitem-author">{c.author}</span>}
                      <span className="gc__hitem-date" title={c.dateIso || c.date}>{fmtDate(c.dateIso || c.date, isZh)}</span>
                    </span>
                  </div>
                </div>
                {!wide && expandedCommit === c.hash && commitFiles.length > 0 && (
                  <div className="gc__hfiles">
                    <CommitFileTree
                      nodes={commitFileTree}
                      depth={0}
                      collapsedDirs={collapsedCommitDirs}
                      onToggleDir={toggleCommitDir}
                      onOpenFile={(fp) => openCommitFileDiff(c.hash, fp)}
                      onContextMenu={(e, fp) => { e.preventDefault(); setCommitCtx({ x: e.clientX, y: e.clientY, hash: c.hash, path: fp }); }}
                    />
                  </div>
                )}
              </div>
            ))}
            {/* 滚动加载的哨兵 —— 进入视野就多取一页 (见上面的 IntersectionObserver)。
              * 过滤中不挂: 那时列表是"整页里匹配的那些", 再往下取只会取到更多不匹配的,
              * 用户看到的还是同一批, 像卡住了。 */}
            {!q && commits.length > 0 && hasMoreCommits && (
              <div className="gc__more" ref={moreRef}>
                {logLimit >= AUTO_LOAD_MAX ? (
                  /* 到上限之后改成手动 —— 列表没有虚拟化, 不让它无声地一直涨下去。
                    * 顺带提一句搜索: 翻到第 500 条以后的人多半在找特定的东西。 */
                  <>
                    <button
                      type="button"
                      className="gc__more-btn"
                      onClick={() => { setLoadingMore(true); setLogLimit((n) => n + PAGE); }}
                      disabled={loadingMore}
                    >
                      {loadingMore
                        ? (isZh ? '加载中…' : 'Loading…')
                        : (isZh ? `再加载 ${PAGE} 条` : `Load ${PAGE} more`)}
                    </button>
                    <div className="gc__more-hint">
                      {isZh
                        ? `已显示 ${commits.length} 条 · 找特定提交用上面的搜索更快`
                        : `${commits.length} shown · searching above is faster for a specific commit`}
                    </div>
                  </>
                ) : (isZh ? '加载更多…' : 'Loading more…')}
              </div>
            )}
            {!q && commits.length > 0 && !hasMoreCommits && (
              <div className="gc__more gc__more--end">
                {isZh ? `到头了 · 共 ${commits.length} 条` : `End · ${commits.length} commits`}
              </div>
            )}
          </div></div>

          {wide && commits.length > 0 && (
            <div className="gc__hdetail">
              <CommitDetailPane
                commit={commits.find((c) => c.hash === expandedCommit) ?? null}
                files={commitFiles}
                loadFile={loadCommitFile}
                onOpenInEditor={(fp) => openFile(workspacePath, toAbs(fp))}
                onFileContextMenu={(e, fp) => {
                  e.preventDefault();
                  if (!expandedCommit) return;
                  setCommitCtx({ x: e.clientX, y: e.clientY, hash: expandedCommit, path: fp });
                }}
                emptyHint={isZh ? '左边点一条提交' : 'Pick a commit on the left'}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const CommitFileTree: React.FC<{
  nodes: CommitTreeNode[];
  depth: number;
  collapsedDirs: Set<string>;
  onToggleDir: (fullPath: string) => void;
  onOpenFile: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, path: string) => void;
}> = ({ nodes, depth, collapsedDirs, onToggleDir, onOpenFile, onContextMenu }) => (
  <>
    {nodes.map((node) => {
      const pad = { paddingLeft: `${8 + depth * 12}px` };
      if (node.kind === 'dir') {
        const collapsed = collapsedDirs.has(node.fullPath);
        return (
          <div key={`d:${node.fullPath}`}>
            <button
              type="button"
              className="gc__htree-dir"
              style={pad}
              title={node.fullPath}
              onClick={(e) => { e.stopPropagation(); onToggleDir(node.fullPath); }}
            >
              <GitDirMark open={!collapsed} />
              <span className="gc__htree-dirname">{node.name}</span>
            </button>
            {!collapsed && (
              <CommitFileTree
                nodes={node.children}
                depth={depth + 1}
                collapsedDirs={collapsedDirs}
                onToggleDir={onToggleDir}
                onOpenFile={onOpenFile}
                onContextMenu={onContextMenu}
              />
            )}
          </div>
        );
      }
      const f = node.file;
      const hasStat = typeof f.add === 'number' || typeof f.del === 'number';
      const add = f.add ?? 0;
      const del = f.del ?? 0;
      return (
        <div
          key={`f:${node.fullPath}`}
          className="gc__hfile"
          style={pad}
          title={f.path}
          onClick={() => onOpenFile(f.path)}
          onContextMenu={(e) => onContextMenu(e, f.path)}
        >
          <GitFileMark path={f.path} />
          <span className="gc__hfile-name">{node.name}</span>
          <GitFileMeta status={f.status} add={add} del={del} hasStat={hasStat} />
        </div>
      );
    })}
  </>
);

const ChangesFileList: React.FC<{
  files: GitFileStatus[];
  onToggle: (f: GitFileStatus) => void;
  onDiscard: (f: GitFileStatus) => void;
  onClick: (f: GitFileStatus) => void;
  onDoubleClick?: (f: GitFileStatus) => void;
  /** 宽版式下右栏正在看的那个文件 —— 空串就是没有选中态 */
  selectedPath?: string;
  onContextMenu?: (e: React.MouseEvent, f: GitFileStatus) => void;
}> = ({ files, onToggle, onDiscard, onClick, onDoubleClick, selectedPath, onContextMenu }) => {
  const { isZh } = useI18n();
  const sorted = useMemo(
    () => [...files].sort((a, b) => PATH_COLLATOR.compare(a.path, b.path)),
    [files],
  );
  return (
    <>
      {/* 分批渲染: 几千条改动一次铺开是几万个节点 (见 CappedRows) */}
      <CappedRows items={sorted} render={(file) => {
        const parts = file.path.split(/[/\\]/).filter(Boolean);
        const name = parts[parts.length - 1] ?? file.path;
        const dir = shortDir(parts.slice(0, -1));
        const ch = file.area === 'staged' ? file.indexStatus : (file.worktreeStatus || '?');
        const hasStat = typeof file.add === 'number' || typeof file.del === 'number';
        return (
          <div
            key={`${file.area}:${file.path}`}
            className={`gc__frow${selectedPath === file.path ? ' is-sel' : ''}`}
            title={file.path}
            onClick={() => onClick(file)}
            onDoubleClick={() => onDoubleClick?.(file)}
            onContextMenu={(e) => onContextMenu?.(e, file)}
          >
            <GitFileMark path={file.path} />
            <span className="gc__fname">{name}</span>
            {/* 路径格**一律渲染**, 哪怕是空的 —— .gc__frow 是五格 grid,
              * 少一格的行 (仓库根目录下的文件) 会把后面所有列往左顶, 整列又变锯齿。 */}
            <span className="gc__fpath">{dir}</span>
            <GitFileMeta status={ch} add={file.add ?? 0} del={file.del ?? 0} hasStat={hasStat} />
            <span className="gc__fbtns">
              <button
                className="gc__fbtn"
                onClick={(e) => { e.stopPropagation(); onToggle(file); }}
                title={file.area === 'staged' ? (isZh ? '取消暂存' : 'Unstage') : (isZh ? '暂存这个文件' : 'Stage')}
              >
                {file.area === 'staged' ? '−' : '+'}
              </button>
              {file.area !== 'staged' && (
                <button
                  className="gc__fbtn gc__fbtn--x"
                  onClick={(e) => { e.stopPropagation(); onDiscard(file); }}
                  title={isZh ? `放弃 ${name} 的改动 (不可撤销)` : `Discard changes in ${name} (cannot be undone)`}
                >
                  ×
                </button>
              )}
            </span>
          </div>
        );
      }} />
    </>
  );
};

/* localeCompare 每次比较都现建排序规则, 几千条排序要几十毫秒; 复用一个 Collator 顺序不变 */
const PATH_COLLATOR = new Intl.Collator();

function fmtDate(d: string, isZh: boolean): string {
  try {
    const t = new Date(d).getTime();
    if (!Number.isFinite(t)) return d;
    const ms = Date.now() - t;
    if (ms < 60_000) return isZh ? '刚刚' : 'just now';
    if (ms < 3600_000) return isZh ? `${Math.floor(ms / 60_000)}分钟前` : `${Math.floor(ms / 60_000)}m ago`;
    if (ms < 86400_000) return isZh ? `${Math.floor(ms / 3600_000)}小时前` : `${Math.floor(ms / 3600_000)}h ago`;
    if (ms < 604800_000) return isZh ? `${Math.floor(ms / 86400_000)}天前` : `${Math.floor(ms / 86400_000)}d ago`;
    return new Date(d).toLocaleDateString();
  } catch { return d; }
}

export default GitCard;
