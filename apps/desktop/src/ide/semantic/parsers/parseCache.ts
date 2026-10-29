/**
 * ParseCache —— 按 (path, hash) 缓存 ParseResult 的 LRU 缓存层.
 *
 * 语义
 * ----
 * - key = `${path}\u0000${hash}` —— path + content hash 共同定位一次解析
 * - value = 整个 ParseResult (symbols + usages + diagnostics)
 * - LRU: 容量上限, 淘汰最久未访问
 * - invalidate(path): 清掉该 path 的所有版本(hash 相关 entry)
 *
 * 定位
 * ----
 * 这是给 Parser 的外部包装层, 对 parser 实现透明. 当前 SemanticService 已
 * 通过 SymbolStore.getFile().hash 短路掉 "内容相同不重新 parse" 场景, 所以
 * ParseCache 不与主路径冲突. 它的主要价值是:
 *   1. 给非 SemanticService 的 parse 调用方 (outline preview / hover preview
 *      / 未来 inline refactor 等) 提供零成本复用
 *   2. SemanticService dispose 后再创建时, 如果 hash 匹配可跳过 parse
 *   3. 测试路径可以直接注入预 cached 结果
 *
 * 线程
 * ----
 * Cache 跟 Parser 一样是单线程使用 (Node 主进程或一个 Worker). 不加锁,
 * 不做并发 dedupe (如果需要 "多并发请求同一 key 只 parse 一次" 语义, 调用方
 * 自己用 Map<key, Promise> 做 inflight 去重, cache 只负责已完成结果).
 */

import type { ParseResult } from './Parser.js';

export interface ParseCacheOptions {
  /** 最大缓存条目数. 默认 200. */
  maxEntries?: number;
  /** 可选 TTL (ms). 超过则 miss. 默认 Infinity. */
  ttlMs?: number;
  /** 测试注入用. */
  now?: () => number;
}

interface Entry {
  key: string;
  path: string;
  hash: string;
  result: ParseResult;
  insertedAt: number;
}

export class ParseCache {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  // 用 Map 的插入顺序做 LRU: 命中时 delete+set 把条目移到末尾, 末尾=最近使用.
  private readonly entries = new Map<string, Entry>();

  constructor(options: ParseCacheOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 200);
    this.ttlMs = options.ttlMs ?? Infinity;
    this.now = options.now ?? Date.now;
  }

  /** 命中返回缓存的 ParseResult; 未命中返回 undefined. */
  get(path: string, hash: string): ParseResult | undefined {
    const key = buildKey(path, hash);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.isExpired(entry)) {
      this.entries.delete(key);
      return undefined;
    }
    // LRU touch
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.result;
  }

  /** 写入 —— 覆盖同 key, 新的在末尾 (最近使用). 超容量淘汰最旧. */
  set(path: string, hash: string, result: ParseResult): void {
    const key = buildKey(path, hash);
    // 已存在 → 删了再 insert, 确保末尾
    this.entries.delete(key);
    this.entries.set(key, {
      key,
      path,
      hash,
      result,
      insertedAt: this.now(),
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }

  /** 清掉给定 path 的所有 hash 版本. */
  invalidate(path: string): number {
    let removed = 0;
    for (const entry of Array.from(this.entries.values())) {
      if (entry.path === path) {
        this.entries.delete(entry.key);
        removed += 1;
      }
    }
    return removed;
  }

  /** 完全清空. */
  clear(): void {
    this.entries.clear();
  }

  /** 诊断: 当前条目数. */
  size(): number {
    return this.entries.size;
  }

  /** 诊断: 列出当前 cache 的 (path, hash) 对, 按最旧→最新顺序. */
  snapshot(): Array<{ path: string; hash: string; insertedAt: number }> {
    return Array.from(this.entries.values()).map((e) => ({
      path: e.path,
      hash: e.hash,
      insertedAt: e.insertedAt,
    }));
  }

  private isExpired(entry: Entry): boolean {
    if (this.ttlMs === Infinity) return false;
    return this.now() - entry.insertedAt > this.ttlMs;
  }
}

function buildKey(path: string, hash: string): string {
  return `${path}\u0000${hash}`;
}
