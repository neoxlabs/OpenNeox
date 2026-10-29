/**
 * Renderer-safe path helpers.
 *
 * 重点: UI 展示路径和真实打开路径必须分离。
 * - 展示可以用 Unicode 省略号, 但绝不能把 `…/foo` / `.../foo` 当真实文件路径打开。
 * - 统一 Win / macOS / UNC / 相对路径规范化, 避免各组件各写一套导致点击找不到文件。
 */

import { canonicalWorkspacePath, looksLikeWindowsPath } from '../../shared/workspacePath';

export interface DisplayPathOptions {
  max?: number;
  /** 太长时保留开头几个 path segment. 默认 1。 */
  headSegments?: number;
  /** 太长时保留结尾几个 path segment. 默认 3。 */
  tailSegments?: number;
}

/**
 * 工作区路径判等 (渲染层薄壳)。口径与实现见 ui/shared/workspacePath.ts —— 那是唯一一份,
 * 主进程走 electron/utils/workspaceKey.ts 引同一个函数, 两边不会漂。
 *
 * 只用来判"是不是同一个项目"。展示、打开文件、拖拽排序一律仍用**原始路径** ——
 * 小写化的路径在 macOS 上是打不开的。
 */
let cachedIsWin: boolean | null = null;
const keyCache = new Map<string, string>();

function detectIsWindows(sample: string): boolean {
  if (cachedIsWin !== null) return cachedIsWin;
  const attr = typeof document !== 'undefined'
    ? document.documentElement.getAttribute('data-platform')
    : null;
  if (attr) {
    cachedIsWin = attr === 'win32';
    return cachedIsWin;
  }
  /* 还没挂载: 按路径形状兜底, **不**缓存 —— 免得把兜底结论当成最终答案。 */
  return looksLikeWindowsPath(sample);
}

export function workspaceKey(path: string | null | undefined): string {
  if (!path) return '';
  const raw = String(path);
  const hit = keyCache.get(raw);
  if (hit !== undefined) return hit;
  /* 渲染层拿不到 process.platform; shell 会把真实平台写在 <html data-platform> 上,
   * 拿不到时 (SSR / 单测 / 早于挂载) 退回按路径形状判断。 */
  const isWin = detectIsWindows(raw);
  const out = canonicalWorkspacePath(raw, isWin);
  if (cachedIsWin !== null) {
    if (keyCache.size > 512) keyCache.clear();   /* 上限, 防长会话里无限增长 */
    keyCache.set(raw, out);
  }
  return out;
}

/** 测试用: 清缓存 (平台判定 + 归一结果)。 */
export function __resetWorkspaceKeyCache(): void {
  cachedIsWin = null;
  keyCache.clear();
  filePathKeyCache.clear();
}

const filePathKeyCache = new Map<string, string>();

export function filePathKey(path: string | null | undefined): string {
  if (!path) return '';
  const raw = String(path);
  const hit = filePathKeyCache.get(raw);
  if (hit !== undefined) return hit;
  const isWin = detectIsWindows(raw);
  const out = canonicalWorkspacePath(normalizePath(raw), isWin);
  if (cachedIsWin !== null) {
    if (filePathKeyCache.size > 2048) filePathKeyCache.clear();
    filePathKeyCache.set(raw, out);
  }
  return out;
}

/** 会话里 agent 实际的工作目录: Work 任务文件夹建好了就是它, 否则是会话工作区。
 *  相对路径 (成品预览 / 文件链接) 要按这个拼, 不然 Work 的文件找不到。 */
export function sessionCwd(s: { workspacePath?: string | null; taskDir?: string | null } | null | undefined): string | undefined {
  const t = s?.taskDir;
  if (t && !/[\\/]$/.test(t)) return t;
  return s?.workspacePath || undefined;
}

/** 两个工作区路径是否指向同一个项目。 */
export function sameWorkspace(a: string | null | undefined, b: string | null | undefined): boolean {
  return workspaceKey(a) === workspaceKey(b);
}

export function normalizePathSlashes(path: string): string {
  if (!path) return path;
  let p = String(path).trim().replace(/\\/g, '/');
  /* Windows drive: C://foo -> C:/foo */
  p = p.replace(/^([A-Za-z]:)\/{2,}/, '$1/');
  /* POSIX duplicate slashes: /Users//a -> /Users/a, but keep UNC //server/share. */
  if (p.startsWith('//')) {
    const rest = p.slice(2).replace(/\/{2,}/g, '/');
    p = `//${rest}`;
  } else {
    p = p.replace(/\/{2,}/g, '/');
  }
  return p;
}

export function isPseudoEllipsisPath(path: string): boolean {
  const p = normalizePathSlashes(path);
  return /^(?:\.{3}|…)(?:\/|$)/.test(p) || /\/(?:\.{3}|…)(?:\/|$)/.test(p);
}

export function splitPathAnchor(text: string): { path: string; line?: number } {
  const raw = (text ?? '').trim();
  if (!raw) return { path: raw };

  const hash = /^(.*?)#L(\d+)(?:-L?\d+)?$/.exec(raw);
  if (hash) return { path: hash[1], line: Number(hash[2]) || undefined };

  const colon = /^(.*?):(\d+)(?::\d+)?$/.exec(raw);
  /* 冒号前必须以 `.ext` 结尾 (1~8 位字母数字) —— 盘符 `C:` 前面没有扩展名,
   * `http://host:8080` 的 host 也没有, 两者都不会被误切。 */
  if (colon && /\.[A-Za-z0-9]{1,8}$/.test(colon[1])) {
    return { path: colon[1], line: Number(colon[2]) || undefined };
  }
  return { path: raw };
}

export function isClearlyOutsideWorkspace(path: string, workspacePath?: string): boolean {
  if (!path || !workspacePath) return false;
  if (!isAbsPath(path)) return false;              /* 相对路径按定义就是工作区内 */
  const p = normalizePathSlashes(path).replace(/\/+$/, '');
  const root = normalizePathSlashes(workspacePath).replace(/\/+$/, '');
  if (!root) return false;
  return p !== root && !p.startsWith(`${root}/`);
}

export function isAbsPath(path: string): boolean {
  const p = normalizePathSlashes(path);
  return p.startsWith('/') || /^[A-Za-z]:\//.test(p) || p.startsWith('//');
}

function splitPrefix(path: string): { prefix: string; rest: string; absolute: boolean } {
  const p = normalizePathSlashes(path);
  const drive = p.match(/^([A-Za-z]:\/)(.*)$/);
  if (drive) return { prefix: drive[1], rest: drive[2], absolute: true };
  if (p.startsWith('//')) {
    const without = p.slice(2);
    const parts = without.split('/');
    const server = parts.shift() || '';
    const share = parts.shift() || '';
    const prefix = share ? `//${server}/${share}/` : `//${server}`;
    return { prefix, rest: parts.join('/'), absolute: true };
  }
  if (p.startsWith('/')) return { prefix: '/', rest: p.slice(1), absolute: true };
  return { prefix: '', rest: p, absolute: false };
}

/** Normalize slash, duplicate separators, `.` and safe `..` segments. */
export function normalizePath(path: string): string {
  if (!path) return path;
  const { prefix, rest, absolute } = splitPrefix(path);
  const out: string[] = [];
  for (const seg of rest.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(seg);
  }
  const body = out.join('/');
  if (prefix) return body ? `${prefix}${body}` : prefix.replace(/\/$/, '') || '/';
  return body || (absolute ? '/' : '.');
}

export function resolveWorkspacePath(path: string, workspacePath?: string): string {
  if (!path) return path;
  const p = normalizePathSlashes(path);
  /* 省略号路径只是展示文本, 不能当真实路径。 */
  if (isPseudoEllipsisPath(p)) return p;
  if (isAbsPath(p)) return normalizePath(p);
  if (!workspacePath) return normalizePath(p.replace(/^\.\//, ''));
  const ws = normalizePath(workspacePath).replace(/\/+$/, '');
  return normalizePath(`${ws}/${p.replace(/^\.\//, '')}`);
}

export function relativeToWorkspace(path: string, workspacePath?: string): string {
  if (!path) return path;
  const p = normalizePath(path);
  if (!workspacePath) return p;
  const ws = normalizePath(workspacePath).replace(/\/+$/, '');
  const pl = p.toLowerCase();
  const wsl = ws.toLowerCase();
  /* Windows path comparison should be case-insensitive; POSIX same result unless only case differs. */
  if (pl === wsl) return '.';
  if (pl.startsWith(`${wsl}/`)) return p.slice(ws.length + 1);
  return p;
}

function ellipsizePath(path: string, max: number, headSegments: number, tailSegments: number): string {
  if (path.length <= max) return path;
  const p = normalizePathSlashes(path);
  const parts = p.split('/').filter(Boolean);
  if (parts.length <= headSegments + tailSegments) return `…${p.slice(-(max - 1))}`;
  let head = parts.slice(0, headSegments).join('/');
  let tail = parts.slice(-tailSegments).join('/');
  let candidate = `${head}/…/${tail}`;
  while (candidate.length > max && tailSegments > 1) {
    tailSegments -= 1;
    tail = parts.slice(-tailSegments).join('/');
    candidate = `${head}/…/${tail}`;
  }
  if (candidate.length <= max) return candidate;
  const file = parts[parts.length - 1] || p;
  return file.length + 2 <= max ? `…/${file}` : `…${file.slice(-(max - 1))}`;
}

export function displayWorkspacePath(path: string, workspacePath?: string, opts: DisplayPathOptions = {}): string {
  if (!path) return path;
  const max = opts.max ?? 72;
  const headSegments = opts.headSegments ?? 1;
  const tailSegments = opts.tailSegments ?? 3;
  const normalized = isPseudoEllipsisPath(path) ? normalizePathSlashes(path) : resolveWorkspacePath(path, workspacePath);
  const rel = isPseudoEllipsisPath(normalized) ? normalized.replace(/^\.\.\.\//, '…/') : relativeToWorkspace(normalized, workspacePath);
  return ellipsizePath(rel, max, headSegments, tailSegments);
}

export function pathTooltip(path: string, workspacePath?: string): string {
  if (!path) return path;
  const resolved = resolveWorkspacePath(path, workspacePath);
  const rel = relativeToWorkspace(resolved, workspacePath);
  if (rel && rel !== resolved && !isPseudoEllipsisPath(resolved)) return `${rel}\n${resolved}`;
  return resolved;
}
