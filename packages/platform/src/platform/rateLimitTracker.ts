/**
 * Rate Limit Tracker - 多 Provider 通用滑动窗口追踪
 *
 * 设计目标：
 * 1. 本地统计：滑动窗口内的请求数/token 用量（不依赖 provider API）
 * 2. Provider 适配器：可选对接各家 API 查询真实额度（Kimi/GLM/Anthropic/OpenAI）
 * 3. StatusLine 集成：显示当前窗口用量 + 剩余额度
 *
 * Claude Code 用的是 Anthropic 的 5h/7d 固定窗口。
 * 我们做成通用的，窗口可配，provider 可扩展。
 */

import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

// ==================== 类型定义 ====================

/** 滑动窗口定义 */
export interface RateLimitWindow {
  /** 窗口标识（如 '1h', '5h', '24h', '7d'） */
  id: string;
  /** 窗口显示名称 */
  label: string;
  /** 窗口时长（毫秒） */
  durationMs: number;
  /** 请求数上限（0 = 不限） */
  maxRequests: number;
  /** Token 上限（0 = 不限） */
  maxTokens: number;
}

/** 窗口内的使用统计 */
export interface WindowUsage {
  windowId: string;
  label: string;
  /** 窗口内请求数 */
  requests: number;
  /** 窗口内总 token */
  tokens: number;
  /** 请求上限 */
  maxRequests: number;
  /** Token 上限 */
  maxTokens: number;
  /** 请求数使用率 (0-1)，maxRequests=0 时为 -1 */
  requestUsage: number;
  /** Token 使用率 (0-1)，maxTokens=0 时为 -1 */
  tokenUsage: number;
  /** 窗口剩余时间（ms） */
  windowRemainingMs: number;
}

/** Provider 额度查询适配器 */
export interface RateLimitProviderAdapter {
  providerId: string;
  /** 查询真实额度（可选实现，返回 null 表示不支持） */
  queryLimits?: () => Promise<{
    windows: Array<{
      id: string;
      label: string;
      maxRequests: number;
      maxTokens: number;
      usedRequests: number;
      usedTokens: number;
      resetAt: number; // epoch ms
    }>;
  } | null>;
}

/** 单次请求记录 */
interface RequestRecord {
  timestamp: number;
  provider: string;
  model: string;
  tokens: number;
}

// ==================== 默认窗口 ====================

export const DEFAULT_WINDOWS: RateLimitWindow[] = [
  { id: '5h', label: '5 小时', durationMs: 5 * 60 * 60 * 1000, maxRequests: 0, maxTokens: 0 },
  { id: '7d', label: '7 天', durationMs: 7 * 24 * 60 * 60 * 1000, maxRequests: 0, maxTokens: 0 },
];

// ==================== RateLimitTracker ====================

export class RateLimitTracker {
  private records: RequestRecord[] = [];
  private windows: RateLimitWindow[];
  private adapters = new Map<string, RateLimitProviderAdapter>();
  private maxRecords = 10000;
  /** Provider 真实额度缓存 */
  private providerLimitsCache = new Map<string, {
    data: NonNullable<Awaited<ReturnType<NonNullable<RateLimitProviderAdapter['queryLimits']>>>>;
    fetchedAt: number;
  }>();
  private providerLimitsCacheTtl = 60_000; // 1 min cache

  constructor(windows?: RateLimitWindow[]) {
    this.windows = windows || DEFAULT_WINDOWS;
  }

  /** 注册 Provider 适配器 */
  registerAdapter(adapter: RateLimitProviderAdapter): void {
    this.adapters.set(adapter.providerId, adapter);
  }

  /** 记录一次请求 */
  recordRequest(provider: string, model: string, tokens: number): void {
    this.records.push({
      timestamp: Date.now(),
      provider,
      model,
      tokens,
    });

    // 清理过期记录（保留最大窗口时长 * 1.5 的数据）
    const maxWindowMs = Math.max(...this.windows.map(w => w.durationMs));
    const cutoff = Date.now() - maxWindowMs * 1.5;
    if (this.records.length > this.maxRecords) {
      this.records = this.records.filter(r => r.timestamp >= cutoff);
    }
  }

  /** 获取所有窗口的使用统计 */
  getUsage(provider?: string): WindowUsage[] {
    const now = Date.now();

    return this.windows.map(window => {
      const cutoff = now - window.durationMs;
      let requests = 0;
      let tokens = 0;

      for (const record of this.records) {
        if (record.timestamp < cutoff) continue;
        if (provider && record.provider !== provider) continue;
        requests++;
        tokens += record.tokens;
      }

      const requestUsage = window.maxRequests > 0 ? requests / window.maxRequests : -1;
      const tokenUsage = window.maxTokens > 0 ? tokens / window.maxTokens : -1;

      return {
        windowId: window.id,
        label: window.label,
        requests,
        tokens,
        maxRequests: window.maxRequests,
        maxTokens: window.maxTokens,
        requestUsage,
        tokenUsage,
        windowRemainingMs: window.durationMs, // 滑动窗口始终是完整时长
      };
    });
  }

  /** 获取单个窗口的使用统计 */
  getWindowUsage(windowId: string, provider?: string): WindowUsage | null {
    const all = this.getUsage(provider);
    return all.find(u => u.windowId === windowId) || null;
  }

  /**
   * 查询 Provider 真实额度（如果有适配器）
   * 带缓存，避免频繁请求
   */
  async queryProviderLimits(providerId: string): Promise<WindowUsage[] | null> {
    const adapter = this.adapters.get(providerId);
    if (!adapter?.queryLimits) return null;

    // 检查缓存
    const cached = this.providerLimitsCache.get(providerId);
    if (cached && Date.now() - cached.fetchedAt < this.providerLimitsCacheTtl) {
      return this.formatProviderLimits(cached.data);
    }

    try {
      const result = await adapter.queryLimits();
      if (!result) return null;

      this.providerLimitsCache.set(providerId, { data: result, fetchedAt: Date.now() });
      return this.formatProviderLimits(result);
    } catch (err: any) {
      cliLogger.debug('RATELIMIT', `Failed to query provider limits for ${providerId}: ${err.message}`);
      return null;
    }
  }

  private formatProviderLimits(data: {
    windows: Array<{
      id: string;
      label: string;
      maxRequests: number;
      maxTokens: number;
      usedRequests: number;
      usedTokens: number;
      resetAt: number;
    }>;
  }): WindowUsage[] {
    const now = Date.now();
    return data.windows.map(w => ({
      windowId: w.id,
      label: w.label,
      requests: w.usedRequests,
      tokens: w.usedTokens,
      maxRequests: w.maxRequests,
      maxTokens: w.maxTokens,
      requestUsage: w.maxRequests > 0 ? w.usedRequests / w.maxRequests : -1,
      tokenUsage: w.maxTokens > 0 ? w.usedTokens / w.maxTokens : -1,
      windowRemainingMs: Math.max(0, w.resetAt - now),
    }));
  }

  /** 设置窗口配置（运行时可调） */
  setWindows(windows: RateLimitWindow[]): void {
    this.windows = windows;
  }

  /** 设置指定窗口的限额（用于 provider 回调更新） */
  setWindowLimits(windowId: string, limits: { maxRequests?: number; maxTokens?: number }): void {
    const window = this.windows.find(w => w.id === windowId);
    if (window) {
      if (limits.maxRequests !== undefined) window.maxRequests = limits.maxRequests;
      if (limits.maxTokens !== undefined) window.maxTokens = limits.maxTokens;
    }
  }

  /** 获取格式化的摘要（给 StatusLine 用） */
  getStatusSummary(provider?: string): string {
    const usage = this.getUsage(provider);
    if (usage.length === 0) return '';

    // 找最短有意义的窗口来显示
    const meaningful = usage.find(u => u.requests > 0) || usage[0];
    const parts: string[] = [];

    parts.push(`${meaningful.requests} req/${meaningful.windowId}`);

    if (meaningful.maxRequests > 0) {
      const pct = Math.round(meaningful.requestUsage * 100);
      parts.push(`${pct}%`);
    }

    return parts.join(' ');
  }

  /** 是否接近限额（任意窗口超 80%） */
  isNearLimit(provider?: string): boolean {
    const usage = this.getUsage(provider);
    return usage.some(u =>
      (u.requestUsage >= 0.8) || (u.tokenUsage >= 0.8)
    );
  }

  /** 重置 */
  reset(): void {
    this.records = [];
    this.providerLimitsCache.clear();
  }
}

// ==================== 全局单例 ====================

let _globalTracker: RateLimitTracker | null = null;

export function getGlobalRateLimitTracker(): RateLimitTracker {
  if (!_globalTracker) {
    _globalTracker = new RateLimitTracker();
  }
  return _globalTracker;
}

export function initGlobalRateLimitTracker(windows?: RateLimitWindow[]): RateLimitTracker {
  _globalTracker = new RateLimitTracker(windows);
  return _globalTracker;
}
