/**
 * Marketplace Client — 插件市场 API 客户端
 *
 * 支持两种市场源:
 * 1. HTTP API (官方市场)
 * 2. Git-based registry (社区/离线)
 */

import { resolveMarketplaceBase } from './endpoint.js';
import type { MarketplacePlugin, PluginCategory } from '@neoxlabs/platform/shared/plugin-types.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

// ============================================================================
// Marketplace Config
// ============================================================================

export interface MarketplaceConfig {
  /** 市场唯一标识 */
  id: string;
  /** 显示名称 */
  name: string;
  /** 市场类型 */
  source: MarketplaceSource;
  /** 是否启用自动更新 */
  autoUpdate?: boolean;
  /** 是否为官方市场 */
  official?: boolean;
}

export type MarketplaceSource =
  | { type: 'api'; url: string; apiKey?: string }
  | { type: 'git'; repo: string; branch?: string }
  | { type: 'directory'; path: string };

/** 默认市场配置 */
export const DEFAULT_MARKETPLACES: MarketplaceConfig[] = [
  {
    id: 'official',
    name: 'Neox Official',
    source: {
      type: 'api',
      // 开发环境使用本地 NeoxCloud，生产环境使用线上服务
      url: resolveMarketplaceBase(),
    },
    autoUpdate: true,
    official: true,
  },
];

// ============================================================================
// Search & Discovery
// ============================================================================

export interface SearchOptions {
  query?: string;
  category?: PluginCategory;
  featured?: boolean;
  sort?: 'downloads' | 'rating' | 'newest' | 'name';
  page?: number;
  pageSize?: number;
}

export interface SearchResult {
  plugins: MarketplacePlugin[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Marketplace Client — 搜索/下载/检查更新
 */
export class MarketplaceClient {
  private config: MarketplaceConfig;

  constructor(config: MarketplaceConfig) {
    this.config = config;
  }

  /** 搜索插件 */
  async search(options: SearchOptions = {}): Promise<SearchResult> {
    const { source } = this.config;

    if (source.type === 'api') {
      return this.searchViaApi(source.url, options);
    }
    if (source.type === 'git') {
      return this.searchViaGit(source.repo, options);
    }
    if (source.type === 'directory') {
      return this.searchViaDirectory(source.path, options);
    }

    return { plugins: [], total: 0, page: 1, pageSize: 20 };
  }

  /** 获取精选插件 */
  async getFeatured(): Promise<MarketplacePlugin[]> {
    const result = await this.search({ featured: true, sort: 'downloads', pageSize: 10 });
    return result.plugins;
  }

  /** 获取分类列表 */
  async getCategories(): Promise<Array<{ id: PluginCategory; name: string; count: number }>> {
    const { source } = this.config;
    if (source.type === 'api') {
      return this.fetchJson(`${source.url}/categories`);
    }
    // Git/directory: 从缓存数据中聚合
    const all = await this.search({ pageSize: 1000 });
    const counts = new Map<PluginCategory, number>();
    for (const p of all.plugins) {
      counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
    }
    return Array.from(counts.entries()).map(([id, count]) => ({
      id,
      name: CATEGORY_NAMES[id] ?? id,
      count,
    }));
  }

  /** 获取插件详情 */
  async getPluginDetail(name: string): Promise<MarketplacePlugin | null> {
    const { source } = this.config;
    if (source.type === 'api') {
      try {
        return await this.fetchJson(`${source.url}/plugins/${name}`);
      } catch { return null; }
    }
    // Fallback: search by exact name
    const result = await this.search({ query: name });
    return result.plugins.find(p => p.name === name) ?? null;
  }

  /** 获取插件版本列表 */
  async getVersions(name: string): Promise<string[]> {
    const { source } = this.config;
    if (source.type === 'api') {
      try {
        const data = await this.fetchJson(`${source.url}/plugins/${name}/versions`);
        return Array.isArray(data) ? data : [];
      } catch { return []; }
    }
    return [];
  }

  /** 获取插件下载 URL */
  getDownloadUrl(name: string, version?: string): string {
    const { source } = this.config;
    if (source.type === 'api') {
      return version
        ? `${source.url}/plugins/${name}/${version}/download`
        : `${source.url}/plugins/${name}/download`;
    }
    if (source.type === 'git') {
      return `${source.repo}/tree/${source.branch ?? 'main'}/plugins/${name}`;
    }
    return '';
  }

  /** 批量检查更新 */
  async checkUpdates(installed: Array<{ name: string; version: string }>): Promise<Array<{
    name: string;
    currentVersion: string;
    latestVersion: string;
    hasUpdate: boolean;
  }>> {
    const { source } = this.config;

    if (source.type === 'api') {
      try {
        const params = installed.map(p => `${p.name}@${p.version}`).join(',');
        return await this.fetchJson(`${source.url}/updates?plugins=${encodeURIComponent(params)}`);
      } catch {
        // Fallback: check one by one
        const results = [];
        for (const p of installed) {
          const detail = await this.getPluginDetail(p.name);
          if (detail) {
            results.push({
              name: p.name,
              currentVersion: p.version,
              latestVersion: detail.version,
              hasUpdate: detail.version !== p.version,
            });
          }
        }
        return results;
      }
    }

    return installed.map(p => ({
      name: p.name,
      currentVersion: p.version,
      latestVersion: p.version,
      hasUpdate: false,
    }));
  }

  // ============================================================================
  // Internal: API Source
  // ============================================================================

  private async searchViaApi(baseUrl: string, options: SearchOptions): Promise<SearchResult> {
    const params = new URLSearchParams();
    if (options.query) params.set('q', options.query);
    if (options.category) params.set('category', options.category);
    if (options.featured) params.set('featured', 'true');
    if (options.sort) params.set('sort', options.sort);
    if (options.page) params.set('page', String(options.page));
    if (options.pageSize) params.set('pageSize', String(options.pageSize));

    try {
      return await this.fetchJson(`${baseUrl}/plugins?${params.toString()}`);
    } catch (err: any) {
      cliLogger.error('MARKETPLACE', `API search failed: ${err.message}`);
      return { plugins: [], total: 0, page: 1, pageSize: 20 };
    }
  }

  private async fetchJson(url: string): Promise<any> {
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Neox-CLI/2.0',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response.json();
  }

  // ============================================================================
  // Internal: Git Source
  // ============================================================================

  private async searchViaGit(repo: string, options: SearchOptions): Promise<SearchResult> {
    // Git-based marketplace: read from local cache (populated by updateChecker)
    const { marketplaceCache } = await import('./marketplaceCache.js');
    const cached = await marketplaceCache.getCachedPlugins(this.config.id);
    let filtered = cached;

    if (options.query) {
      const q = options.query.toLowerCase();
      filtered = filtered.filter(p =>
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.keywords.some(k => k.toLowerCase().includes(q)),
      );
    }
    if (options.category) {
      filtered = filtered.filter(p => p.category === options.category);
    }
    if (options.featured) {
      filtered = filtered.filter(p => p.featured);
    }

    // Sort
    switch (options.sort) {
      case 'downloads': filtered.sort((a, b) => b.downloads - a.downloads); break;
      case 'rating': filtered.sort((a, b) => b.rating - a.rating); break;
      case 'newest': filtered.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()); break;
      case 'name': filtered.sort((a, b) => a.name.localeCompare(b.name)); break;
    }

    // Paginate
    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? 20;
    const start = (page - 1) * pageSize;
    const plugins = filtered.slice(start, start + pageSize);

    return { plugins, total: filtered.length, page, pageSize };
  }

  // ============================================================================
  // Internal: Directory Source
  // ============================================================================

  private async searchViaDirectory(dirPath: string, options: SearchOptions): Promise<SearchResult> {
    // 本地目录市场: 扫描子目录的 plugin.json
    const fs = await import('fs/promises');
    const path = await import('path');
    const plugins: MarketplacePlugin[] = [];

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const manifestPath = path.join(dirPath, entry.name, 'plugin.json');
        try {
          const raw = await fs.readFile(manifestPath, 'utf-8');
          const manifest = JSON.parse(raw);
          plugins.push({
            name: manifest.name ?? entry.name,
            version: manifest.version ?? '0.0.0',
            description: manifest.description ?? '',
            author: manifest.author ?? { name: 'Unknown' },
            category: manifest.category ?? 'community',
            keywords: manifest.keywords ?? [],
            icon: manifest.icon,
            downloads: 0,
            rating: 0,
            ratingCount: 0,
            official: false,
            publishedAt: new Date().toISOString(),
            source: { type: 'tarball', url: path.join(dirPath, entry.name) },
          });
        } catch { /* skip invalid */ }
      }
    } catch { /* dir not found */ }

    let filtered = plugins;
    if (options.query) {
      const q = options.query.toLowerCase();
      filtered = filtered.filter(p =>
        p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q),
      );
    }

    return { plugins: filtered, total: filtered.length, page: 1, pageSize: filtered.length };
  }
}

// ============================================================================
// Category Names
// ============================================================================

const CATEGORY_NAMES: Record<string, string> = {
  devops: 'DevOps',
  database: 'Database',
  web: 'Web',
  testing: 'Testing',
  'ai-ml': 'AI/ML',
  security: 'Security',
  language: 'Language',
  productivity: 'Productivity',
  documentation: 'Documentation',
  community: 'Community',
};

// ============================================================================
// Factory
// ============================================================================

/** 创建默认市场客户端 */
export function createDefaultMarketplaceClient(): MarketplaceClient {
  return new MarketplaceClient(DEFAULT_MARKETPLACES[0]);
}
