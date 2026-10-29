
import { execFile, spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import * as path from 'node:path';
import * as fs from 'node:fs';

// ────────────────────────────── Types ──────────────────────────────

export interface GitFileStatus {
  path: string;
  /** X = index status, Y = worktree status (git status --porcelain=v1) */
  indexStatus: string;
  worktreeStatus: string;
  /** 'staged' | 'unstaged' | 'untracked' | 'conflict' */
  area: 'staged' | 'unstaged' | 'untracked' | 'conflict';
  /** 原始路径（rename 场景） */
  origPath?: string;
  /** 相对对应 area 的 +/− 行数 (diff --numstat / 未跟踪文件行数) */
  add?: number;
  del?: number;
}

/** merge / rebase / cherry-pick / revert 这类"做到一半"的状态 */
export interface GitRepoState {
  kind: 'none' | 'merge' | 'rebase' | 'cherry-pick' | 'revert';
  /** rebase 才有: 正在处理第几步 / 共几步 */
  step?: number;
  total?: number;
  /** rebase 的目标分支名 (rebase-merge/head-name), 用来把提示写成人话 */
  onto?: string;
}

export type GitUnavailableReason = '' | 'not-a-repo' | 'ignored-by-parent' | 'no-workspace';

export interface GitStatusResult {
  branch: string;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
  root: string;
  /** 当前 cwd 不能当作「本项目的 git」时给 UI 提示.
   *  ignored-by-parent: 落在父仓 .gitignore 里 (如 .tmp-test/lab), 却被 git 爬到父仓. */
  unavailableReason?: GitUnavailableReason;
  state?: GitRepoState;
  /** 改动条目超过上限被截断 —— UI 必须明说, 不许假装这就是全部 */
  truncated?: boolean;
  /** 'normal' = 条目太多, 未跟踪目录被折叠成一条 (路径以 / 结尾) */
  untrackedMode?: 'all' | 'normal';
  /** 单调递增; 渲染层按它判断增量能不能接上 */
  version?: number;
}

/** 推给渲染层的增量: 除 files 外的全部字段 + 文件的增删改 */
export type GitStatusSummary = Omit<GitStatusResult, 'files'> & { fileCount: number };

export interface GitStatusDelta {
  upserts: GitFileStatus[];
  /** fileKey() */
  removes: string[];
}

export interface GitStatusChangedPayload {
  cwds: string[];
  root: string;
  version: number;
  prevVersion: number;
  summary: GitStatusSummary;
  delta: GitStatusDelta;
}

// ────────────────────────────── git exec ──────────────────────────────

const GIT = 'git';
/* 路径里的非 ASCII 不转义 —— 见 gitHandlers 顶部同名说明 */
export const QUOTEPATH_OFF = ['-c', 'core.quotepath=false'];
export const READ_ONLY_GIT_ENV = { GIT_OPTIONAL_LOCKS: '0' };
export const STATUS_ENTRY_LIMIT = 10_000;
const MAX_BUFFER = 64 * 1024 * 1024;

function gitRead(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      GIT,
      [...QUOTEPATH_OFF, ...args],
      { cwd, maxBuffer: MAX_BUFFER, encoding: 'utf-8', env: { ...process.env, ...READ_ONLY_GIT_ENV }, windowsHide: true, signal },
      (err, stdout) => (err ? reject(err) : resolve(stdout as string)),
    );
  });
}

// ────────────────────────────── Parsers ──────────────────────────────

/**
 * 反转义 git 输出的带引号路径.
 * 即便 quotepath=false, 含 " / \ / 控制字符的路径 git 仍会用双引号包起来并 C 风格转义.
 * 这里把 "..." 形式解开: 八进制 \NNN 按字节收集后整体 UTF-8 解码, 常见转义 \t\n\r\\\" 等也还原.
 * 不带引号的路径原样返回.
 */
export function unquoteGitPath(p: string): string {
  if (p.length < 2 || p[0] !== '"' || p[p.length - 1] !== '"') return p;
  const inner = p.slice(1, -1);
  const bytes: number[] = [];
  const escMap: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '\\') {
      const next = inner[i + 1];
      const octMatch = inner.slice(i + 1, i + 4).match(/^[0-7]{1,3}/);
      if (octMatch) {
        bytes.push(parseInt(octMatch[0], 8) & 0xff);
        i += octMatch[0].length;
      } else if (next !== undefined) {
        bytes.push(escMap[next] ?? next.charCodeAt(0));
        i += 1;
      }
    } else {
      for (const b of Buffer.from(c, 'utf-8')) bytes.push(b);
    }
  }
  return Buffer.from(bytes).toString('utf-8');
}

/** 解析 `git diff --numstat` / `diff-tree --numstat`；rename 统一落到新路径 */
export function parseNumstat(raw: string): Map<string, { add: number; del: number }> {
  const stats = new Map<string, { add: number; del: number }>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const addStr = parts[0]!;
    const delStr = parts[1]!;
    let p = unquoteGitPath(parts.slice(2).join('\t'));
    if (!p) continue;
    if (p.includes(' => ')) {
      /* git 的 rename 有两种写法:
       *     src/old.ts => src/new.ts          无公共前缀
       *     src/{old => new}/file.ts          公共前缀被压缩进大括号
       * 大括号**可能带前缀也可能带后缀**, 不一定在行首。 */
      const brace = p.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
      if (brace) p = `${brace[1]}${brace[3]}${brace[4]}`.replace(/\/{2,}/g, '/');
      else p = p.slice(p.lastIndexOf(' => ') + 4);
    }
    const add = addStr === '-' ? 0 : (parseInt(addStr, 10) || 0);
    const del = delStr === '-' ? 0 : (parseInt(delStr, 10) || 0);
    stats.set(p, { add, del });
  }
  return stats;
}

/** 解析 `git diff --numstat -z`: 普通 `add\tdel\tpath\0`; rename `add\tdel\t\0from\0to\0` (落到新路径) */
export function parseNumstatZ(raw: string): Map<string, { add: number; del: number }> {
  const stats = new Map<string, { add: number; del: number }>();
  const tok = raw.split('\0');
  for (let i = 0; i < tok.length; i++) {
    const t = tok[i]!;
    if (!t) continue;
    const m = t.match(/^(-|\d+)\t(-|\d+)\t(.*)$/s);
    if (!m) continue;
    let p = m[3]!;
    if (p === '') { p = tok[i + 2] ?? ''; i += 2; }
    if (!p) continue;
    stats.set(p, { add: m[1] === '-' ? 0 : Number(m[1]), del: m[2] === '-' ? 0 : Number(m[2]) });
  }
  return stats;
}

/** `## main...origin/main [ahead 1, behind 2]` */
export function parseBranchHeader(header: string): { branch: string; ahead: number; behind: number } {
  const line = header.startsWith('## ') ? header.slice(3) : header;
  let branch: string;
  const noCommits = line.match(/^(?:No commits yet on|Initial commit on) (.+)$/);
  if (noCommits) branch = noCommits[1]!;
  else {
    const dotIdx = line.indexOf('...');
    branch = dotIdx >= 0 ? line.slice(0, dotIdx) : line.split(' ')[0]!;
  }
  const ahead = Number(line.match(/ahead (\d+)/)?.[1] ?? 0);
  const behind = Number(line.match(/behind (\d+)/)?.[1] ?? 0);
  return { branch, ahead, behind };
}

/** 一条 porcelain 记录 → 0~2 个 GitFileStatus (同时有暂存和未暂存改动时拆两条) */
export function classifyEntry(X: string, Y: string, filePath: string, origPath: string | undefined, out: GitFileStatus[]): void {
  if (X === '?' && Y === '?') {
    out.push({ path: filePath, indexStatus: X, worktreeStatus: Y, area: 'untracked' });
  } else if (X === 'U' || Y === 'U' || (X === 'A' && Y === 'A') || (X === 'D' && Y === 'D')) {
    out.push({ path: filePath, indexStatus: X, worktreeStatus: Y, area: 'conflict', origPath });
  } else {
    if (X !== ' ' && X !== '?') out.push({ path: filePath, indexStatus: X, worktreeStatus: ' ', area: 'staged', origPath });
    if (Y !== ' ' && Y !== '?') out.push({ path: filePath, indexStatus: ' ', worktreeStatus: Y, area: 'unstaged', origPath });
  }
}

/** `git status --porcelain=v1 -z -b` 的流式解析器: feed 任意切片, 超过 limit 条返回 false */
export class PorcelainZParser {
  header = '';
  readonly files: GitFileStatus[] = [];
  entries = 0;
  private buf = '';
  private expectOrig: GitFileStatus[] | null = null;

  constructor(private readonly limit: number) {}

  /** 返回 false = 已超限, 调用方应当掐掉进程 */
  feed(chunk: string): boolean {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf('\0')) >= 0) {
      const tok = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (!this.token(tok)) return false;
    }
    return true;
  }

  private token(tok: string): boolean {
    if (this.expectOrig) {
      for (const f of this.expectOrig) f.origPath = tok;
      this.expectOrig = null;
      return true;
    }
    if (!this.header && this.entries === 0 && tok.startsWith('## ')) { this.header = tok; return true; }
    if (tok.length < 4) return true;
    if (this.entries >= this.limit) return false;
    this.entries++;
    const X = tok[0]!;
    const Y = tok[1]!;
    const before = this.files.length;
    classifyEntry(X, Y, tok.slice(3), undefined, this.files);
    if (X === 'R' || X === 'C' || Y === 'R' || Y === 'C') this.expectOrig = this.files.slice(before);
    return true;
  }
}

// ────────────────────────────── Scope / repo state ──────────────────────────────

export async function checkScopeUnderRoot(absCwd: string, absRoot: string): Promise<{
  ok: boolean;
  root: string;
  reason: '' | 'not-a-repo' | 'ignored-by-parent';
}> {
  if (absRoot === absCwd) return { ok: true, root: absRoot, reason: '' };
  /* 工作区是父仓的子路径 — 若整棵被 ignore, 不算本项目的仓库 */
  try {
    await gitRead(['check-ignore', '-q', '--', absCwd], absRoot);
    /* exit 0 → 被 ignore */
    return { ok: false, root: '', reason: 'ignored-by-parent' };
  } catch {
    /* exit 1 → 未被 ignore (合法 monorepo 包目录); 其它错误放行走 scoped git */
    return { ok: true, root: absRoot, reason: '' };
  }
}

/** 判断 cwd 对「本项目 Git 面板」是否可用.
 *  git 会沿目录向上找 .git —— 子目录工作区若被父仓 ignore, 仍会命中父仓,
 *  于是右栏 Git 显示完全另一个项目的 history (2026-08 用户回放 heavy-ux-lab). */
export async function resolveGitScope(cwd: string): Promise<{
  ok: boolean;
  root: string;
  reason: '' | 'not-a-repo' | 'ignored-by-parent';
}> {
  const absCwd = path.resolve(cwd);
  let root = '';
  try {
    root = (await gitRead(['rev-parse', '--show-toplevel'], absCwd)).trim();
  } catch {
    return { ok: false, root: '', reason: 'not-a-repo' };
  }
  if (!root) return { ok: false, root: '', reason: 'not-a-repo' };
  return checkScopeUnderRoot(absCwd, path.resolve(root));
}

export async function readRepoState(cwd: string, knownGitDir?: string): Promise<GitRepoState> {
  try {
    const gitDir = knownGitDir || (await gitRead(['rev-parse', '--absolute-git-dir'], cwd)).trim();
    if (!gitDir) return { kind: 'none' };
    const has = (p: string) => fs.existsSync(path.join(gitDir, p));
    const readNum = (p: string): number | undefined => {
      try {
        const n = Number(fs.readFileSync(path.join(gitDir, p), 'utf-8').trim());
        return Number.isFinite(n) ? n : undefined;
      } catch { return undefined; }
    };
    const readStr = (p: string): string | undefined => {
      try { return fs.readFileSync(path.join(gitDir, p), 'utf-8').trim() || undefined; }
      catch { return undefined; }
    };
    if (has('rebase-merge')) {
      return {
        kind: 'rebase',
        step: readNum('rebase-merge/msgnum'),
        total: readNum('rebase-merge/end'),
        onto: readStr('rebase-merge/head-name')?.replace(/^refs\/heads\//, ''),
      };
    }
    if (has('rebase-apply')) {
      return { kind: 'rebase', step: readNum('rebase-apply/next'), total: readNum('rebase-apply/last') };
    }
    if (has('CHERRY_PICK_HEAD')) return { kind: 'cherry-pick' };
    if (has('REVERT_HEAD')) return { kind: 'revert' };
    if (has('MERGE_HEAD')) return { kind: 'merge' };
    return { kind: 'none' };
  } catch {
    return { kind: 'none' };
  }
}

export function emptyStatus(reason: GitUnavailableReason = 'not-a-repo'): GitStatusResult {
  return { branch: '', ahead: 0, behind: 0, files: [], root: '', unavailableReason: reason };
}

// ────────────────────────────── Untracked line counts ──────────────────────────────

/** 文本行数 (含 NUL 视为二进制 → null) */
export function countLinesInBuffer(buf: Buffer): number | null {
  if (buf.includes(0)) return null;
  if (buf.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) lines += 1;
  }
  if (buf[buf.length - 1] === 0x0a) lines -= 1;
  return lines;
}

/* +N 只是装饰数字: 未跟踪文件多到几百个时 (通常是忘了 ignore 的产物目录) 不值得为它读几千个文件 */
const UNTRACKED_LINECOUNT_MAX_FILES = 300;
const UNTRACKED_LINECOUNT_MAX_BYTES = 1_500_000;
const UNTRACKED_LINECOUNT_CONCURRENCY = 8;
const LINECOUNT_CACHE_MAX = 4000;
const lineCountCache = new Map<string, { mtimeMs: number; size: number; lines: number | null }>();

async function countTextFileLines(absPath: string): Promise<number | null> {
  try {
    const st = await fs.promises.stat(absPath);
    if (!st.isFile() || st.size > UNTRACKED_LINECOUNT_MAX_BYTES) return null;
    const hit = lineCountCache.get(absPath);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.lines;
    const lines = countLinesInBuffer(await fs.promises.readFile(absPath));
    if (lineCountCache.size >= LINECOUNT_CACHE_MAX) lineCountCache.clear();
    lineCountCache.set(absPath, { mtimeMs: st.mtimeMs, size: st.size, lines });
    return lines;
  } catch {
    return null;
  }
}

async function fillUntrackedLineCounts(root: string, files: GitFileStatus[]): Promise<void> {
  const targets = files.filter((f) => f.area === 'untracked' && f.add === undefined && !f.path.endsWith('/'));
  if (targets.length === 0 || targets.length > UNTRACKED_LINECOUNT_MAX_FILES) return;
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const f = targets[next++]!;
      const n = await countTextFileLines(path.join(root, f.path));
      if (n != null) { f.add = n; f.del = 0; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(UNTRACKED_LINECOUNT_CONCURRENCY, targets.length) }, worker));
}

// ────────────────────────────── Compute ──────────────────────────────

export interface GitStatusComputedResult {
  value: GitStatusResult;
  root: string;
  metaDirs: string[];
}

/** 流式跑 status; 超过 limit 条就掐掉进程并标 truncated */
function runStatusZ(cwd: string, untracked: 'all' | 'normal', limit: number): Promise<PorcelainZParser & { truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const parser = new PorcelainZParser(limit) as PorcelainZParser & { truncated: boolean };
    parser.truncated = false;
    const child = spawn(
      GIT,
      [...QUOTEPATH_OFF, 'status', '--porcelain=v1', '-z', '-b', `--untracked-files=${untracked}`, '--', '.'],
      { cwd, env: { ...process.env, ...READ_ONLY_GIT_ENV }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const decoder = new StringDecoder('utf8');
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      if (parser.truncated) return;
      if (!parser.feed(decoder.write(chunk))) {
        parser.truncated = true;
        child.kill();
      }
    });
    child.stderr.on('data', (c: Buffer) => { if (stderr.length < 4000) stderr += c.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (parser.truncated) { resolve(parser); return; }
      parser.feed(decoder.end());
      if (code === 0) resolve(parser);
      else reject(new Error(`git status exited ${code}: ${stderr.trim()}`));
    });
  });
}

/** 真正算一次状态。所有 git 进程并行起; 超限时中止 numstat。 */
export async function computeGitStatus(cwd: string, limit = STATUS_ENTRY_LIMIT): Promise<GitStatusComputedResult> {
  const none = (reason: '' | 'not-a-repo' | 'ignored-by-parent'): GitStatusComputedResult =>
    ({ value: emptyStatus(reason), root: '', metaDirs: [] });
  const absCwd = path.resolve(cwd);
  /* 一次 rev-parse 拿齐 根 / gitDir / commonDir */
  let top = '';
  let gitDir = '';
  let commonDir = '';
  try {
    const out = await gitRead(['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], absCwd);
    [top = '', gitDir = '', commonDir = ''] = out.split(/\r?\n/).map((s) => s.trim());
  } catch {
    return none('not-a-repo');
  }
  if (!top) return none('not-a-repo');
  const scope = await checkScopeUnderRoot(absCwd, path.resolve(top));
  if (!scope.ok) return none(scope.reason);

  const numstatAbort = new AbortController();
  const numstat = (cached: boolean) =>
    gitRead(cached ? ['diff', '--cached', '--numstat', '-z', '--', '.'] : ['diff-files', '--numstat', '-z', '--', '.'], absCwd, numstatAbort.signal)
      .catch(() => '');
  const [first, unstagedRaw, stagedRaw, state] = await Promise.all([
    runStatusZ(absCwd, 'all', limit).then((r) => { if (r.truncated) numstatAbort.abort(); return r; }),
    numstat(false),
    numstat(true),
    readRepoState(absCwd, gitDir),
  ]);

  let status = first;
  let untrackedMode: 'all' | 'normal' = 'all';
  if (first.truncated) {
    /* 超限几乎总是一个没 ignore 的大目录: 折叠未跟踪目录再算一次 */
    status = await runStatusZ(absCwd, 'normal', limit);
    untrackedMode = 'normal';
  }

  const result: GitStatusResult = {
    ...parseBranchHeader(status.header),
    files: status.files,
    root: scope.root,
    unavailableReason: '',
    state,
    truncated: status.truncated,
    untrackedMode,
  };
  if (!first.truncated) {
    const unstagedStats = parseNumstatZ(unstagedRaw);
    const stagedStats = parseNumstatZ(stagedRaw);
    for (const f of result.files) {
      const map = f.area === 'staged' ? stagedStats : unstagedStats;
      const st = map.get(f.path) || (f.origPath ? map.get(f.origPath) : undefined);
      if (st) { f.add = st.add; f.del = st.del; }
    }
    await fillUntrackedLineCounts(scope.root, result.files);
  }

  const metaDirs = [...new Set([gitDir, commonDir && path.resolve(absCwd, commonDir)].filter(Boolean))];
  return { value: result, root: scope.root, metaDirs };
}

// ────────────────────────────── Signature / delta ──────────────────────────────

export function fileKey(f: Pick<GitFileStatus, 'area' | 'path'>): string {
  return `${f.area}\0${f.path}`;
}

function fileSig(f: GitFileStatus): string {
  return `${f.indexStatus}${f.worktreeStatus}<${f.origPath ?? ''}>${f.add ?? ''},${f.del ?? ''}`;
}

export function summaryOf(r: GitStatusResult): GitStatusSummary {
  const { files, ...rest } = r;
  return { ...rest, fileCount: files.length };
}

/** 签名: 用户看得见的全部 (不含 version) —— 变了才推送 */
export function gitStatusSignature(r: GitStatusResult): string {
  const st = r.state;
  return [
    r.unavailableReason ?? '', r.root, r.branch, r.ahead, r.behind, r.truncated ? 1 : 0, r.untrackedMode ?? '',
    st ? `${st.kind}:${st.step ?? ''}/${st.total ?? ''}:${st.onto ?? ''}` : '',
    r.files.map((f) => `${fileKey(f)}${fileSig(f)}`).join('\n'),
  ].join('|');
}

export function diffGitFiles(prev: GitFileStatus[], next: GitFileStatus[]): GitStatusDelta {
  const before = new Map<string, GitFileStatus>();
  for (const f of prev) before.set(fileKey(f), f);
  const upserts: GitFileStatus[] = [];
  for (const f of next) {
    const k = fileKey(f);
    const old = before.get(k);
    if (!old || fileSig(old) !== fileSig(f)) upserts.push(f);
    before.delete(k);
  }
  return { upserts, removes: [...before.keys()] };
}
