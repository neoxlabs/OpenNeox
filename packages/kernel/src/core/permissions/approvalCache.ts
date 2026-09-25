/**
 * Cache an approved command, working directory, and sandbox profile within a session.
 *
 * Entries are bounded and session-scoped so a later request can reuse the
 * decision without sharing approvals across sessions.
 */

import { createHash } from 'crypto';
import { currentSessionScopeId } from '../sessionScope.js';

export type ApprovalDecision = 'approved' | 'denied';

export interface ApprovalKey {
  command: string;
  cwd: string;
  /** 可选:沙盒策略标识 (strict/moderate/permissive/none) */
  profile?: string;
  /** 会话桶。不传则取当前 SessionScope —— 见下方 hashKey 的说明。 */
  scope?: string;
}

interface CacheEntry {
  key: string;
  decision: ApprovalDecision;
  /** 属于哪个会话 —— 按会话清理时要用 */
  scope: string;
  /** 最后命中时间(LRU)*/
  lastAccess: number;
  /** 批准时间 */
  grantedAt: number;
}

/* key 补上会话维度。
 *   文件头一直写着"session 内免重复审批", 但 key 只有 (command, cwd, profile), 缓存又是
 *   进程单例 —— 会话 A 批准过的 `rm -rf ./dist`, 会话 B 直接免问。说的和做的不是一回事。
 *   不传 scope 时取当前 SessionScope, 所以 CLI / 单会话行为不变。 */
function scopeOf(key: ApprovalKey): string {
  return key.scope ?? currentSessionScopeId();
}

function hashKey(key: ApprovalKey): string {
  return createHash('sha256')
    .update(key.command)
    .update('\x00')
    .update(key.cwd)
    .update('\x00')
    .update(key.profile ?? '')
    .update('\x00')
    .update(scopeOf(key))
    .digest('hex');
}

export class ApprovalCache {
  private entries = new Map<string, CacheEntry>();
  private readonly cap: number;
  /** TTL(ms):缺省 2 小时 — 避免长期 session 让"很久以前"的批准仍然有效 */
  private readonly ttlMs: number;

  constructor(cap = 64, ttlMs = 2 * 60 * 60 * 1000) {
    this.cap = cap;
    this.ttlMs = ttlMs;
  }

  /** 查缓存。命中且未过期 → 返回 decision;否则返回 undefined */
  get(key: ApprovalKey): ApprovalDecision | undefined {
    const h = hashKey(key);
    const e = this.entries.get(h);
    if (!e) return undefined;
    if (Date.now() - e.grantedAt > this.ttlMs) {
      this.entries.delete(h);
      return undefined;
    }
    e.lastAccess = Date.now();
    return e.decision;
  }

  /** 记住一次审批决定 */
  set(key: ApprovalKey, decision: ApprovalDecision): void {
    const h = hashKey(key);
    const now = Date.now();
    this.entries.set(h, { key: h, decision, scope: scopeOf(key), lastAccess: now, grantedAt: now });
    this.evictIfNeeded();
  }

  /** 显式清除某个 key(用于撤销批准)*/
  delete(key: ApprovalKey): boolean {
    return this.entries.delete(hashKey(key));
  }

  /** 清空所有(用于"重置沙箱"命令)*/
  clear(): void {
    this.entries.clear();
  }

  /** 只清一个会话的批准记录 —— 某个会话切到 manual / 结束时用, 别连累别的会话。 */
  clearScope(scope: string = currentSessionScopeId()): number {
    let removed = 0;
    for (const [h, e] of this.entries) {
      if (e.scope === scope) {
        this.entries.delete(h);
        removed++;
      }
    }
    return removed;
  }

  size(): number {
    return this.entries.size;
  }

  private evictIfNeeded(): void {
    if (this.entries.size <= this.cap) return;
    // LRU:按 lastAccess 排序,删最旧的
    const sorted = [...this.entries.values()].sort((a, b) => a.lastAccess - b.lastAccess);
    const toDelete = this.entries.size - this.cap;
    for (let i = 0; i < toDelete; i++) {
      this.entries.delete(sorted[i]!.key);
    }
  }
}

// ─── singleton ───
let globalCache: ApprovalCache | null = null;
export function getApprovalCache(): ApprovalCache {
  if (!globalCache) globalCache = new ApprovalCache();
  return globalCache;
}

export function __resetApprovalCacheForTest(): void {
  globalCache = null;
}
