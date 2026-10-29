/**
 * 工作区路径判等 —— Node 侧绑定 (主进程 / platform-electron)。
 *
 * 判等口径的**唯一实现**在 ./workspacePath.ts, 这里只负责两件本地化的事:
 *   1. 从 process.platform 拿真实平台 (渲染层拿不到, 走它自己的绑定)
 *   2. 相对路径先 resolve 成绝对路径, 否则 './proj' 与 '/x/proj' 判不出相等
 *
 * 与 ProjectManager.normalizeWorkspacePath 的分工:
 *   那个是**注册用**规范化 —— 走 realpath, 碰磁盘, 结果当 Map key 存起来。
 *   这个是**比较用**的轻量 key —— 纯字符串, 可以在每条消息这种热路径上调。
 *   两者只在"win32 下大小写不敏感"这一点上必须口径一致。
 */
import { resolve } from 'node:path';
import { canonicalWorkspacePath } from './workspacePath.js';

export function workspaceKey(workspacePath: string | null | undefined): string {
  if (!workspacePath) return '';
  let p = String(workspacePath);
  try { p = resolve(p); } catch { /* 非法路径就按原样比 */ }
  return canonicalWorkspacePath(p, process.platform === 'win32');
}

/** 两个工作区路径是否指向同一个项目。 */
export function sameWorkspace(a: string | null | undefined, b: string | null | undefined): boolean {
  return workspaceKey(a) === workspaceKey(b);
}

export function dedupeByWorkspacePath<T>(
  items: readonly T[] | null | undefined,
  getPath: (item: T) => string | null | undefined,
  pick: (existing: T, candidate: T) => T,
): T[] {
  if (!Array.isArray(items) || items.length === 0) return [];
  const byKey = new Map<string, T>();
  for (const item of items) {
    const p = getPath(item);
    if (!p) continue;
    const k = workspaceKey(p);
    const prev = byKey.get(k);
    byKey.set(k, prev === undefined ? item : pick(prev, item));
  }
  return [...byKey.values()];
}

/** 一串路径按判等 key 去重, 保留**第一次出现的原始写法** (显示和打开都要用它)。 */
export function dedupeWorkspacePaths(paths: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (!p) continue;
    const k = workspaceKey(p);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

/**
 * 以工作区路径为键的 Record —— 把键统一成判等 key, 同一项目的多个键合并成一个。
 *
 *   ui:workspaceMeta (自定义名) / ui:workspaceRoots (多根) / ui:recentFiles (最近文件)
 *   三张表都是 Record<路径, 值>, 键用的是写入时手上那个原始写法。Windows 上同一个项目
 *   换个写法就取不到值, 表现为: 自定义的项目名突然没了、多根工作区退回单根、
 *   最近文件列表空掉 —— 而且旧键还留在库里, 越攒越多。
 *
 *   读取时 rekey 一次: 键归一, 撞键的用 merge 合并。写入统一用 workspaceKey 当键,
 *   于是库里的旧键在下一次写入时自然被干净的版本覆盖, 不需要迁移脚本。
 *   注意**键只用于判等**, 值里存的路径仍是原始写法 (roots 要拿去打开文件)。
 */
export function rekeyByWorkspacePath<V>(
  map: Record<string, V> | null | undefined,
  merge: (existing: V, candidate: V) => V,
): Record<string, V> {
  if (!map || typeof map !== 'object') return {};
  const out: Record<string, V> = {};
  for (const [rawKey, value] of Object.entries(map)) {
    if (!rawKey) continue;
    const k = workspaceKey(rawKey);
    out[k] = k in out ? merge(out[k], value) : value;
  }
  return out;
}
