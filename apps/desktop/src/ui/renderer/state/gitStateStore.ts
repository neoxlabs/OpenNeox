
import { filePathKey } from '../utils/pathUtils';

export interface GitFileStatus {
  path: string;
  area: 'staged' | 'unstaged' | 'untracked' | 'conflict';
  indexStatus: string;
  worktreeStatus: string;
  origPath?: string;
  add?: number;
  del?: number;
}

export interface GitRepoOpState {
  kind: 'none' | 'merge' | 'rebase' | 'cherry-pick' | 'revert';
  step?: number;
  total?: number;
  onto?: string;
}

/** 主进程 git:status 的完整形状 */
export interface GitStatusView {
  branch: string;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
  root: string;
  unavailableReason?: '' | 'not-a-repo' | 'ignored-by-parent' | 'no-workspace';
  state?: GitRepoOpState;
  /** 条目超过上限被截断 —— UI 必须明说 */
  truncated?: boolean;
  /** 'normal' = 条目太多, 未跟踪目录被折叠成一条 (路径以 / 结尾) */
  untrackedMode?: 'all' | 'normal';
  version?: number;
}

export interface GitState {
  /** 是否 git 仓库 (没拿到 branch 就当不是) */
  isGitRepo: boolean;
  branch: string;
  ahead: number;
  behind: number;
  /** 有任何 staged/unstaged/untracked 改动 */
  dirty: boolean;
  files: GitFileStatus[];
  lastFetchAt: number;
  /** 拿到过第一份状态 (区分 "还没拉" 和 "拉过但不是 git") */
  loaded: boolean;
  /** 完整状态 (提交面板 / GitCard 要 root / state / truncated) —— 没拿到前是 null */
  status: GitStatusView | null;
  /** 取状态失败的原因 (worker 故障等) —— 上屏, 不假装"不是仓库" */
  error: string;
}

const EMPTY: GitState = {
  isGitRepo: false,
  branch: '',
  ahead: 0,
  behind: 0,
  dirty: false,
  files: [],
  lastFetchAt: 0,
  loaded: false,
  status: null,
  error: '',
};

interface ChangedPayload {
  cwds: string[];
  root: string;
  version: number;
  prevVersion: number;
  summary: Omit<GitStatusView, 'files'> & { fileCount: number };
  delta: { upserts: GitFileStatus[]; removes: string[] };
}

type Badge = string;

interface Entry {
  cwd: string;
  state: GitState;
  version: number;
  /** fileKey → file */
  files: Map<string, GitFileStatus>;
  /** filePathKey(绝对路径) → 角标字符 */
  badges: Map<string, Badge>;
  badgeListeners: Map<string, Set<() => void>>;
  subscribers: Set<(s: GitState) => void>;
  changeListeners: Set<() => void>;
  retainers: number;
  subscribed: Promise<void> | null;
  onVisible: (() => void) | null;
}

const entries = new Map<string, Entry>();

function fileKey(f: Pick<GitFileStatus, 'area' | 'path'>): string {
  return `${f.area}\0${f.path}`;
}

function badgeOf(f: GitFileStatus): Badge {
  if (f.area === 'conflict') return 'C';
  if (f.area === 'untracked') return 'U';
  return (f.worktreeStatus || '').trim() || (f.indexStatus || '').trim() || 'M';
}

function absKey(root: string, relPath: string): string {
  const rel = relPath.endsWith('/') ? relPath.slice(0, -1) : relPath;
  return filePathKey(`${root}/${rel}`);
}

function neoxApi(): any {
  return typeof window !== 'undefined' ? (window as any).neox : undefined;
}

/* ── 主进程推送: 全局只挂一个监听, 按 cwd 分发 ── */
let pushUnsub: (() => void) | null = null;

function ensurePushListener(): void {
  if (pushUnsub) return;
  const neox = neoxApi();
  if (typeof neox?.onGitStatusChanged !== 'function') return;
  pushUnsub = neox.onGitStatusChanged((payload: ChangedPayload) => {
    for (const cwd of payload?.cwds ?? []) {
      const e = entries.get(cwd);
      if (e) applyChange(e, payload);
    }
  }) ?? null;
}

function releasePushListenerIfIdle(): void {
  if (entries.size > 0 || !pushUnsub) return;
  try { pushUnsub(); } catch { /* ignore */ }
  pushUnsub = null;
}

/* ── 模型更新 ── */

function sortFiles(files: Iterable<GitFileStatus>): GitFileStatus[] {
  /* git 自己按路径字节序输出; 增量合并后按同一规则排, 列表顺序跟整份拉取时一致 */
  return [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.area < b.area ? -1 : a.area > b.area ? 1 : 0));
}

function rebuildBadgesFor(e: Entry, root: string, paths: Iterable<string>, changed: Set<string>): void {
  /* 同一路径可能同时有 staged + unstaged 两条: 按"工作区优先"重新合成这一个角标 */
  const byPath = new Map<string, GitFileStatus[]>();
  const wanted = new Set(paths);
  for (const f of e.files.values()) {
    if (!wanted.has(f.path)) continue;
    const list = byPath.get(f.path) ?? [];
    list.push(f);
    byPath.set(f.path, list);
  }
  for (const p of wanted) {
    const k = absKey(root, p);
    const list = byPath.get(p);
    let next: Badge | undefined;
    if (list?.length) {
      const pick = list.find((f) => f.area === 'conflict') ?? list.find((f) => f.area === 'unstaged')
        ?? list.find((f) => f.area === 'untracked') ?? list[0]!;
      next = badgeOf(pick);
    }
    if (e.badges.get(k) !== next) {
      if (next === undefined) e.badges.delete(k);
      else e.badges.set(k, next);
      changed.add(k);
    }
  }
}

function notifyBadges(e: Entry, keys: Set<string>): void {
  for (const k of keys) {
    const ls = e.badgeListeners.get(k);
    if (!ls) continue;
    for (const fn of ls) { try { fn(); } catch { /* ignore */ } }
  }
}

function publish(e: Entry, view: GitStatusView, files: GitFileStatus[]): void {
  e.state = {
    isGitRepo: !!view.branch,
    branch: view.branch || '',
    ahead: view.ahead || 0,
    behind: view.behind || 0,
    dirty: files.length > 0,
    files,
    lastFetchAt: Date.now(),
    loaded: true,
    status: { ...view, files },
    error: '',
  };
  for (const fn of e.subscribers) { try { fn(e.state); } catch { /* listener error 不影响其它 */ } }
  for (const fn of e.changeListeners) { try { fn(); } catch { /* ignore */ } }
}

function applySnapshot(e: Entry, snap: GitStatusView): void {
  const version = snap.version ?? 0;
  if (e.state.loaded && version !== 0 && version <= e.version) return;
  const oldRoot = e.state.status?.root ?? '';
  const oldPaths = new Set([...e.files.values()].map((f) => f.path));
  e.version = version;
  e.files = new Map(snap.files.map((f) => [fileKey(f), f]));
  const changed = new Set<string>();
  if (oldRoot !== snap.root) {
    for (const k of e.badges.keys()) changed.add(k);
    e.badges.clear();
    rebuildBadgesFor(e, snap.root, snap.files.map((f) => f.path), changed);
  } else {
    for (const f of snap.files) oldPaths.add(f.path);
    rebuildBadgesFor(e, snap.root, oldPaths, changed);
  }
  publish(e, snap, sortFiles(e.files.values()));
  notifyBadges(e, changed);
}

function applyChange(e: Entry, p: ChangedPayload): void {
  if (p.version <= e.version) return;               /* 已经拿到更新的整份了 */
  if (p.prevVersion !== e.version) {
    /* 中间漏了一跳 (订阅刚建立 / worker 重建): 增量接不上, 重拿整份 */
    void resnapshot(e);
    return;
  }
  const root = p.summary.root;
  const touched = new Set<string>();
  for (const k of p.delta.removes) {
    const f = e.files.get(k);
    if (f) { touched.add(f.path); e.files.delete(k); }
  }
  for (const f of p.delta.upserts) {
    e.files.set(fileKey(f), f);
    touched.add(f.path);
  }
  e.version = p.version;
  const changed = new Set<string>();
  if ((e.state.status?.root ?? '') !== root) {
    for (const k of e.badges.keys()) changed.add(k);
    e.badges.clear();
    rebuildBadgesFor(e, root, [...e.files.values()].map((f) => f.path), changed);
  } else {
    rebuildBadgesFor(e, root, touched, changed);
  }
  const { fileCount: _n, ...summary } = p.summary;
  publish(e, { ...summary, version: p.version, files: [] }, sortFiles(e.files.values()));
  notifyBadges(e, changed);
}

async function resnapshot(e: Entry): Promise<void> {
  const neox = neoxApi();
  try {
    const snap: GitStatusView = await neox.gitStatus(e.cwd);
    if (entries.get(e.cwd) === e) applySnapshot(e, snap);
  } catch (err) {
    setError(e, err);
  }
}

function setError(e: Entry, err: unknown): void {
  e.state = { ...e.state, loaded: true, error: String((err as Error)?.message ?? err) };
  for (const fn of e.subscribers) { try { fn(e.state); } catch { /* ignore */ } }
}

/* ── 生命周期 ── */

function acquire(cwd: string): Entry {
  let e = entries.get(cwd);
  if (!e) {
    e = {
      cwd, state: { ...EMPTY }, version: 0, files: new Map(), badges: new Map(), badgeListeners: new Map(),
      subscribers: new Set(), changeListeners: new Set(), retainers: 0, subscribed: null, onVisible: null,
    };
    entries.set(cwd, e);
  }
  e.retainers++;
  if (e.retainers === 1) activate(e);
  return e;
}

function activate(e: Entry): void {
  const neox = neoxApi();
  ensurePushListener();
  if (typeof neox?.gitStatusSubscribe !== 'function') {
    setError(e, 'git status API unavailable in this host');
    return;
  }
  e.subscribed = Promise.resolve(neox.gitStatusSubscribe(e.cwd)).then(
    (snap: GitStatusView) => { if (entries.get(e.cwd) === e) applySnapshot(e, snap); },
    (err: unknown) => { if (entries.get(e.cwd) === e) setError(e, err); },
  );
  if (typeof document !== 'undefined') {
    /* 回到前台: 让主进程按缓存 TTL 复核一次 (被忽略目录里的改动这类事件漏网的情况) */
    e.onVisible = () => {
      if (!document.hidden) void neox.gitStatusRevalidate?.(e.cwd, false)?.catch?.(() => { /* 推送会带来结果 */ });
    };
    document.addEventListener('visibilitychange', e.onVisible);
  }
}

function releaseEntry(e: Entry): void {
  e.retainers = Math.max(0, e.retainers - 1);
  if (e.retainers > 0) return;
  if (e.onVisible && typeof document !== 'undefined') document.removeEventListener('visibilitychange', e.onVisible);
  e.onVisible = null;
  entries.delete(e.cwd);
  const neox = neoxApi();
  const cwd = e.cwd;
  /* 等订阅真的建立了再退, 否则主进程那边的计数会先减后加 */
  void Promise.resolve(e.subscribed).finally(() => { void neox?.gitStatusUnsubscribe?.(cwd)?.catch?.(() => { /* ignore */ }); });
  releasePushListenerIfIdle();
}

/* ── 对外 API ── */

/** 订阅 chip 级状态 (含完整 status); 返回退订函数 */
export function subscribeGitState(cwd: string, fn: (s: GitState) => void): () => void {
  if (!cwd) { fn({ ...EMPTY, loaded: true }); return () => {}; }
  const e = acquire(cwd);
  e.subscribers.add(fn);
  fn(e.state);
  return () => {
    e.subscribers.delete(fn);
    releaseEntry(e);
  };
}

/** 订阅"这个仓库的状态刚变了"(增量已应用之后触发) —— 给需要跟着刷别的数据的 (GitCard 的提交历史) */
export function subscribeGitStatusChanges(cwd: string, fn: () => void): () => void {
  if (!cwd) return () => {};
  const e = acquire(cwd);
  e.changeListeners.add(fn);
  return () => {
    e.changeListeners.delete(fn);
    releaseEntry(e);
  };
}

/** 只保持订阅, 不接收状态 (文件树: 父组件不该因 git 变化重渲, 由各行按路径订阅角标) */
export function retainGitRepo(cwd: string): () => void {
  if (!cwd) return () => {};
  const e = acquire(cwd);
  return () => releaseEntry(e);
}

/** 某个绝对路径的角标 (M/A/D/U/C/R…); 没有就 undefined。配合 subscribeGitBadge 用 useSyncExternalStore */
export function getGitBadge(cwd: string, absPath: string): string | undefined {
  const e = entries.get(cwd);
  return e ? e.badges.get(filePathKey(absPath)) : undefined;
}

export function subscribeGitBadge(cwd: string, absPath: string, fn: () => void): () => void {
  if (!cwd) return () => {};
  const e = acquire(cwd);
  const k = filePathKey(absPath);
  let ls = e.badgeListeners.get(k);
  if (!ls) { ls = new Set(); e.badgeListeners.set(k, ls); }
  ls.add(fn);
  return () => {
    ls!.delete(fn);
    if (ls!.size === 0) e.badgeListeners.delete(k);
    releaseEntry(e);
  };
}

/** 主动刷新 — 切完分支 / commit 完调它: 主进程强制重算, 变化走增量推送。 */
export async function refreshGitState(cwd: string): Promise<void> {
  if (!cwd) return;
  const neox = neoxApi();
  await neox?.gitStatusRevalidate?.(cwd, true);
}

/** 拿当前缓存值 (不订阅, 不触发拉取) — popover 一次性读用. */
export function peekGitState(cwd: string): GitState {
  return entries.get(cwd)?.state ?? { ...EMPTY };
}
