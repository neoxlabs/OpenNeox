/**
 * MemoryFileSystemProvider —— 内存中的虚拟文件系统.
 *
 * 用途:
 *   1. 未保存 draft: 用户新建 untitled 文件, 写入 `memory:draft-1` URI
 *   2. 嵌入语言 scratch: HTML 里抽出的 JS 片段 → `memory:embedded/<hash>.js`
 *   3. 测试夹具: 不碰磁盘, 纯 Map 操作, 毫秒级
 *
 * path 约定:
 *   - path 是该 provider 内部的唯一 key, 任意字符串 (通常是 id 或虚拟路径)
 *   - `memory:draft-1` 和 `memory:///draft-1` 都能存取同一 buffer (path 标准化
 *     会去 leading `/`)
 */

import type {
  FileSystemProvider,
  ProviderReadResult,
  ProviderWriteResult,
  ProviderStatResult,
  ProviderListResult,
  ProviderDeleteResult,
  ProviderWatchEvent,
} from '../fileSystemProvider.js';
import type { VfsUri } from '../uri.js';

interface MemEntry {
  content: string;
  size: number;
  mtime: number;
}

type WatchListener = (event: ProviderWatchEvent) => void;

export class MemoryFileSystemProvider implements FileSystemProvider {
  readonly label = 'memory';

  private readonly store = new Map<string, MemEntry>();
  private readonly watchers = new Map<string, Set<WatchListener>>();

  async readFile(uri: VfsUri): Promise<ProviderReadResult> {
    const key = keyOf(uri);
    const entry = this.store.get(key);
    if (!entry) return { success: false, error: `memory: no buffer at "${key}"` };
    return { success: true, content: entry.content };
  }

  async writeFile(uri: VfsUri, content: string): Promise<ProviderWriteResult> {
    const key = keyOf(uri);
    const existed = this.store.has(key);
    const entry: MemEntry = {
      content,
      size: content.length,
      mtime: Date.now(),
    };
    this.store.set(key, entry);
    this.fireWatch({ type: existed ? 'changed' : 'created', uri });
    return { success: true };
  }

  async stat(uri: VfsUri): Promise<ProviderStatResult> {
    const key = keyOf(uri);
    const entry = this.store.get(key);
    if (!entry) return { success: false, error: `memory: no buffer at "${key}"` };
    return {
      success: true,
      stat: { type: 'file', size: entry.size, mtime: entry.mtime },
    };
  }

  async list(_uri: VfsUri): Promise<ProviderListResult> {
    // Memory provider 没有层级目录概念; 列出所有 key 作为平铺文件.
    // 若调用方传的 uri.path 非空, 只返回 path 前缀匹配的条目.
    const prefix = normalizePath(_uri.path);
    const entries: Array<{ name: string; type: 'file' | 'directory' }> = [];
    for (const key of this.store.keys()) {
      if (prefix && !key.startsWith(prefix)) continue;
      entries.push({ name: key, type: 'file' });
    }
    return { success: true, entries };
  }

  async delete(uri: VfsUri): Promise<ProviderDeleteResult> {
    const key = keyOf(uri);
    const existed = this.store.delete(key);
    if (existed) this.fireWatch({ type: 'deleted', uri });
    return { success: existed, error: existed ? undefined : `memory: no buffer at "${key}"` };
  }

  watch(uri: VfsUri, listener: WatchListener): () => void {
    const key = keyOf(uri);
    let set = this.watchers.get(key);
    if (!set) {
      set = new Set();
      this.watchers.set(key, set);
    }
    set.add(listener);
    return () => {
      const s = this.watchers.get(key);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) this.watchers.delete(key);
    };
  }

  dispose(): void {
    this.store.clear();
    this.watchers.clear();
  }

  /** Provider-specific helpers —— 测试 / CLI 用. */
  has(uri: VfsUri): boolean { return this.store.has(keyOf(uri)); }
  size(): number { return this.store.size; }

  private fireWatch(event: ProviderWatchEvent): void {
    const key = keyOf(event.uri);
    const set = this.watchers.get(key);
    if (!set) return;
    for (const listener of Array.from(set)) {
      try { listener(event); } catch { /* swallow */ }
    }
  }
}

function keyOf(uri: VfsUri): string {
  return normalizePath(uri.path);
}

function normalizePath(p: string): string {
  return p.replace(/^\/+/, '');
}
