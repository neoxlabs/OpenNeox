/**
 * LargeFileRegistry —— 主进程里所有打开的 FileAdapter 注册表.
 *
 * IPC 架构:
 *   Renderer   open(path)        → registry.open()     → handle id
 *   Renderer   readLines(id,...) → registry.get(id).readLines
 *   Renderer   close(id)         → registry.close(id)
 *
 * 生命周期保险:
 *   - 每个 renderer 窗口有自己的 id 集合 (owner 绑 senderFrameId)
 *   - 窗口 closed → 主动清掉它所有的 adapter
 *   - 闲置 IDLE_TIMEOUT_MS 后自动 close, 避免 renderer 忘关时 fd 泄漏
 *   - 全局总 adapter 数上限 MAX_OPEN_ADAPTERS, 超出时 LRU 清
 *
 * 对应 IntelliJ 的 `LargeFileEditorProvider` + Editor lifecycle 管理.
 */

import { randomUUID } from 'crypto';
import { FileAdapter, type FileAdapterMeta, type LargeFileEncoding } from './fileAdapter.js';

/** 闲置超过这么久自动关 fd (10 分钟). */
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
/** 全局同时打开的 adapter 数上限. */
const MAX_OPEN_ADAPTERS = 32;

interface Entry {
  handle: string;
  adapter: FileAdapter;
  ownerKey: string;
  meta: FileAdapterMeta;
}

export class LargeFileRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly ownerIndex = new Map<string, Set<string>>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.sweepTimer = setInterval(() => this.sweepIdle(), 60 * 1000);
    // 让进程退出时不被 timer 卡住
    if (typeof (this.sweepTimer as any).unref === 'function') {
      (this.sweepTimer as any).unref();
    }
  }

  async open(path: string, ownerKey: string): Promise<{ handle: string; meta: FileAdapterMeta }> {
    // 同一个 owner 重复开同路径 → 复用
    const existing = this.findByOwnerAndPath(ownerKey, path);
    if (existing) {
      existing.adapter.touch();
      return { handle: existing.handle, meta: existing.meta };
    }

    // 全局容量到顶 → LRU 淘汰最旧的一个 (优先淘汰跨 owner 的)
    if (this.entries.size >= MAX_OPEN_ADAPTERS) {
      this.evictLru();
    }

    const adapter = new FileAdapter(path);
    const meta = await adapter.init();
    const handle = randomUUID();
    const entry: Entry = { handle, adapter, ownerKey, meta };
    this.entries.set(handle, entry);
    let ownerSet = this.ownerIndex.get(ownerKey);
    if (!ownerSet) {
      ownerSet = new Set();
      this.ownerIndex.set(ownerKey, ownerSet);
    }
    ownerSet.add(handle);
    return { handle, meta };
  }

  async readLines(handle: string, from: number, to: number): Promise<string[] | null> {
    const entry = this.entries.get(handle);
    if (!entry) return null;
    try {
      return await entry.adapter.readLines(from, to);
    } catch (err) {
      console.error('[LargeFileRegistry] readLines failed', err);
      return null;
    }
  }

  /**
   * 切换 handle 的编码. 返回新 meta; handle 不存在返回 null.
   */
  async setEncoding(handle: string, encoding: LargeFileEncoding): Promise<FileAdapterMeta | null> {
    const entry = this.entries.get(handle);
    if (!entry) return null;
    try {
      const meta = await entry.adapter.setEncoding(encoding);
      entry.meta = meta;
      return meta;
    } catch (err) {
      console.error('[LargeFileRegistry] setEncoding failed', err);
      return null;
    }
  }

  async close(handle: string): Promise<boolean> {
    const entry = this.entries.get(handle);
    if (!entry) return false;
    await entry.adapter.close();
    this.entries.delete(handle);
    this.ownerIndex.get(entry.ownerKey)?.delete(handle);
    return true;
  }

  /**
   * 关闭某个 owner 拥有的所有 adapter. 窗口关闭时调.
   */
  async closeOwner(ownerKey: string): Promise<void> {
    const set = this.ownerIndex.get(ownerKey);
    if (!set) return;
    const handles = [...set];
    this.ownerIndex.delete(ownerKey);
    await Promise.all(handles.map((h) => this.close(h)));
  }

  /**
   * 关闭所有 owner 前缀匹配 `prefix` 的 adapter.
   *
   * 典型用法: webContents 销毁时传 "{id}:" 作为前缀, 连同所有 frame 一起关.
   */
  async closeByOwnerPrefix(prefix: string): Promise<void> {
    const matchedOwners: string[] = [];
    for (const key of this.ownerIndex.keys()) {
      if (key.startsWith(prefix)) matchedOwners.push(key);
    }
    for (const key of matchedOwners) {
      await this.closeOwner(key);
    }
  }

  metaOf(handle: string): FileAdapterMeta | null {
    return this.entries.get(handle)?.meta ?? null;
  }

  size(): number {
    return this.entries.size;
  }

  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    // 同步关所有 —— 进程退出路径, 允许 fire-and-forget
    for (const [, entry] of this.entries) {
      entry.adapter.close().catch(() => { /* ignore */ });
    }
    this.entries.clear();
    this.ownerIndex.clear();
  }

  // --------------------------------------------------------------------------

  private findByOwnerAndPath(ownerKey: string, path: string): Entry | undefined {
    const set = this.ownerIndex.get(ownerKey);
    if (!set) return undefined;
    for (const h of set) {
      const e = this.entries.get(h);
      if (e && e.adapter.path === path) return e;
    }
    return undefined;
  }

  private evictLru(): void {
    let oldest: Entry | undefined;
    let oldestIdle = -1;
    for (const entry of this.entries.values()) {
      const idle = entry.adapter.idleFor();
      if (idle > oldestIdle) {
        oldestIdle = idle;
        oldest = entry;
      }
    }
    if (oldest) {
      this.close(oldest.handle).catch(() => { /* ignore */ });
    }
  }

  private sweepIdle(): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.adapter.idleFor() > IDLE_TIMEOUT_MS) {
        this.close(entry.handle).catch(() => { /* ignore */ });
      }
    }
  }
}

// ============================================================================
// 单例
// ============================================================================

let _registry: LargeFileRegistry | null = null;

export function getLargeFileRegistry(): LargeFileRegistry {
  if (!_registry) _registry = new LargeFileRegistry();
  return _registry;
}
