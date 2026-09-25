
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

interface CacheSnapshot {
  cacheRead: number;
  cacheCreation: number;
  promptTokens: number;
  timestamp: number;
  scenario?: string;
  agentName?: string;
  configuredToolCount?: number;
}

/** sessionId::model → 上一轮 snapshot. session 切 model 时各自独立追踪. */
const cacheHistory = new Map<string, CacheSnapshot>();

/** 跌幅阈值: 必须同时满足 (避免小流量场景误报) */
const DROP_PCT = 0.05;     // 5%
const DROP_ABS = 2000;     // 2K tokens

/** GC: 总记录数 > 此值时清 24h 以上旧条目, 防内存膨胀 */
const GC_THRESHOLD = 5000;
const GC_RETENTION_MS = 24 * 3600_000;

export interface CacheSnapshotInput {
  sessionId: string;
  model: string;
  cacheRead?: number;
  cacheCreation?: number;
  promptTokens: number;
  scenario?: string;
  agentName?: string;
  configuredToolCount?: number;
}

export function recordCacheSnapshot(opts: CacheSnapshotInput): void {
  const cacheRead = Math.max(0, opts.cacheRead ?? 0);
  const cacheCreation = Math.max(0, opts.cacheCreation ?? 0);
  const promptTokens = Math.max(0, opts.promptTokens || 0);
  const key = `${opts.sessionId}::${opts.model}`;
  const prev = cacheHistory.get(key);

  const next: CacheSnapshot = {
    cacheRead,
    cacheCreation,
    promptTokens,
    timestamp: Date.now(),
    scenario: opts.scenario,
    agentName: opts.agentName,
    configuredToolCount: opts.configuredToolCount,
  };

  if (prev) {
    /* 跌幅检测: 上一轮命中过 cache, 本轮明显跌 → 大概率有人改了 prompt/tool/system
     * 把 cache prefix 搞挂. 这里只 warn, 不 throw, 因为可能是用户主动清 context. */
    const drop = prev.cacheRead - cacheRead;
    const dropPct = prev.cacheRead > 0 ? drop / prev.cacheRead : 0;
    if (drop >= DROP_ABS && dropPct >= DROP_PCT) {
      const hitRate = promptTokens > 0 ? (cacheRead / promptTokens * 100).toFixed(1) : 'n/a';
      const sessionShort = opts.sessionId.length > 20 ? opts.sessionId.substring(0, 20) + '…' : opts.sessionId;
      cliLogger.warn('CACHE_HEALTH',
        `prompt cache dropped: ${prev.cacheRead} → ${cacheRead} ` +
        `(-${drop} tok, -${(dropPct * 100).toFixed(1)}%) ` +
        `· session=${sessionShort} model=${opts.model} ` +
        `· scenario=${opts.scenario || 'unknown'} ` +
        `· agent=${opts.agentName || 'unknown'} tools=${opts.configuredToolCount ?? 'n/a'} ` +
        `· current hit rate ${hitRate}% (${cacheRead}/${promptTokens})`
      );
    }
  }

  cacheHistory.set(key, next);

  // GC 防膨胀
  if (cacheHistory.size > GC_THRESHOLD) {
    const cutoff = Date.now() - GC_RETENTION_MS;
    for (const [k, v] of cacheHistory) {
      if (v.timestamp < cutoff) cacheHistory.delete(k);
    }
  }
}

/** 查指定 session 当前所有 model 的最新 snapshot — admin / debug 用. */
export function getCacheSnapshots(sessionId: string): Array<{ model: string; snapshot: CacheSnapshot }> {
  const results: Array<{ model: string; snapshot: CacheSnapshot }> = [];
  const prefix = `${sessionId}::`;
  for (const [k, v] of cacheHistory) {
    if (k.startsWith(prefix)) {
      results.push({ model: k.substring(prefix.length), snapshot: { ...v } });
    }
  }
  return results;
}

/** 单元测试 / 显式清场用 */
export function resetCacheHealthMonitor(): void {
  cacheHistory.clear();
}
