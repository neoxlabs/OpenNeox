/**
 * Marketplace Cache — 市场数据本地缓存
 *
 * 缓存搜索结果和插件列表，减少网络请求
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import type { MarketplacePlugin } from '@neoxlabs/platform/shared/plugin-types.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

const CACHE_DIR = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'plugins', 'cache');
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 分钟

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

class MarketplaceCache {
  /** 获取缓存的插件列表 */
  async getCachedPlugins(marketplaceId: string): Promise<MarketplacePlugin[]> {
    const entry = await this.read<MarketplacePlugin[]>(`${marketplaceId}_plugins`);
    return entry ?? [];
  }

  /** 缓存插件列表 */
  async setCachedPlugins(marketplaceId: string, plugins: MarketplacePlugin[]): Promise<void> {
    await this.write(`${marketplaceId}_plugins`, plugins);
  }

  /** 获取缓存的搜索结果 */
  async getCachedSearch(marketplaceId: string, query: string): Promise<MarketplacePlugin[] | null> {
    const key = `${marketplaceId}_search_${this.hashKey(query)}`;
    return this.read<MarketplacePlugin[]>(key);
  }

  /** 缓存搜索结果 */
  async setCachedSearch(marketplaceId: string, query: string, results: MarketplacePlugin[]): Promise<void> {
    const key = `${marketplaceId}_search_${this.hashKey(query)}`;
    await this.write(key, results, 10 * 60 * 1000); // 10 分钟
  }

  /** 清除所有缓存 */
  async clear(): Promise<void> {
    try {
      await fs.rm(CACHE_DIR, { recursive: true, force: true });
    } catch { /* ignore */ }
  }

  /** 清除特定市场的缓存 */
  async clearMarketplace(marketplaceId: string): Promise<void> {
    try {
      const files = await fs.readdir(CACHE_DIR);
      for (const file of files) {
        if (file.startsWith(marketplaceId)) {
          await fs.unlink(path.join(CACHE_DIR, file));
        }
      }
    } catch { /* ignore */ }
  }

  // ============================================================================
  // Internal
  // ============================================================================

  private async read<T>(key: string): Promise<T | null> {
    try {
      const filePath = path.join(CACHE_DIR, `${key}.json`);
      const raw = await fs.readFile(filePath, 'utf-8');
      const entry: CacheEntry<T> = JSON.parse(raw);
      // TTL 检查
      if (Date.now() - entry.timestamp > entry.ttl) {
        return null; // 过期
      }
      return entry.data;
    } catch {
      return null;
    }
  }

  private async write<T>(key: string, data: T, ttl = CACHE_TTL_MS): Promise<void> {
    try {
      await fs.mkdir(CACHE_DIR, { recursive: true });
      const entry: CacheEntry<T> = { data, timestamp: Date.now(), ttl };
      const filePath = path.join(CACHE_DIR, `${key}.json`);
      await fs.writeFile(filePath, JSON.stringify(entry), 'utf-8');
    } catch { /* ignore cache write failures */ }
  }

  private hashKey(input: string): string {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  }
}

/** 全局缓存实例 */
export const marketplaceCache = new MarketplaceCache();
