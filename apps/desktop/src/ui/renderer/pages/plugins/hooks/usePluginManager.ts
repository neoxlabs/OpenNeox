/**
 * usePluginManager — Electron 插件管理 Hook
 *
 * 封装 IPC 调用，提供 React 状态管理
 */

import { useState, useCallback, useEffect } from 'react';
import type {
  PluginSearchResponse,
  PluginListResponse,
  PluginCategoryInfo,
  PluginUpdateInfo,
} from '@neoxlabs/platform/shared/ipc/plugin.js';
import type { MarketplacePlugin, InstalledPlugin, PluginCategory } from '@neoxlabs/platform/shared/plugin-types.js';
import { PLUGINS_CHANGED_EVENT } from '../../../hooks/usePluginCapability';
import { toPermissionInfo } from '../components/PluginPermissionDialog.js';

// ============================================================================
// IPC Helper
// ============================================================================

/** 通过 window.neox preload API 调用 plugin IPC */
function neoxApi(): any {
  return (window as any).neox;
}

let lastCatalog: { plugins: MarketplacePlugin[]; total: number } | null = null;
let lastInstalled: InstalledPlugin[] | null = null;

// ============================================================================
// Hook
// ============================================================================

export interface PluginManagerState {
  // 市场搜索
  searchResults: MarketplacePlugin[];
  searchTotal: number;
  searchLoading: boolean;
  searchError: string | null;

  // 已安装
  installed: InstalledPlugin[];
  installedLoading: boolean;

  // 分类
  categories: PluginCategoryInfo[];

  // 更新
  updates: PluginUpdateInfo[];

  // 操作中
  installing: Set<string>;

  // 当前 tab
  activeTab: 'browse' | 'installed' | 'updates';

  // 当前选中的插件详情
  selectedPlugin: MarketplacePlugin | null;
}

export function usePluginManager() {
  const [state, setState] = useState<PluginManagerState>({
    searchResults: lastCatalog?.plugins ?? [],
    searchTotal: lastCatalog?.total ?? 0,
    /* 挂载即开始拉 (见底部 useEffect) —— 还一张卡都没有时就是"加载中", 不是"空" */
    searchLoading: !lastCatalog,
    searchError: null,
    installed: lastInstalled ?? [],
    installedLoading: false,
    categories: [],
    updates: [],
    installing: new Set(),
    activeTab: 'installed',
    selectedPlugin: null,
  });

  // ============================================================================
  // 市场搜索
  // ============================================================================

  const search = useCallback(async (query: string, category?: PluginCategory) => {
    const request = { query, category, sort: 'downloads' as const, pageSize: 500 };
    /* 只有全量目录 (无搜索词无分类) 才记成"上一次的目录" */
    const isFullCatalog = !query && !category;
    let showedCache = false;
    /* 屏上还没东西就先亮骨架 —— 读缓存那一下也要时间, 不能先露一个空态 */
    setState(s => (s.searchResults.length ? s : { ...s, searchLoading: true, searchError: null }));
    try {
      const cached = await neoxApi()?.pluginSearch?.({ ...request, cacheOnly: true }) as (PluginSearchResponse | null | undefined);
      if (cached && Array.isArray(cached.plugins) && cached.plugins.length > 0) {
        showedCache = true;
        if (isFullCatalog) lastCatalog = { plugins: cached.plugins, total: cached.total ?? cached.plugins.length };
        setState(s => ({
          ...s, searchResults: cached.plugins, searchTotal: cached.total ?? cached.plugins.length,
          searchLoading: false, searchError: null,
        }));
      }
    } catch { /* 缓存读不到就走网络 */ }
    if (!showedCache) setState(s => ({ ...s, searchLoading: true, searchError: null }));
    try {
      const api = neoxApi();
      if (!api?.pluginSearch) throw new Error('Plugin API not available');
      const result = await api.pluginSearch(request) as PluginSearchResponse & { error?: string };
      if (showedCache && (!result?.plugins || result.plugins.length === 0) && result?.error) return;
      if (isFullCatalog && result?.plugins?.length) {
        lastCatalog = { plugins: result.plugins, total: result.total ?? result.plugins.length };
      }
      setState(s => ({
        ...s,
        searchResults: result.plugins ?? [],
        searchTotal: result.total ?? 0,
        searchLoading: false,
        searchError: result.error ?? null,
      }));
    } catch (err: any) {
      if (showedCache) return;
      setState(s => ({ ...s, searchLoading: false, searchError: err.message }));
    }
  }, []);

  const loadFeatured = useCallback(async () => {
    setState(s => ({ ...s, searchLoading: true }));
    try {
      const api = neoxApi();
      if (!api?.pluginFeatured) throw new Error('Plugin API not available');
      const raw = await api.pluginFeatured() as MarketplacePlugin[] | { plugins: MarketplacePlugin[]; error?: string };
      const plugins = Array.isArray(raw) ? raw : (raw?.plugins ?? []);
      const error = Array.isArray(raw) ? null : (raw?.error ?? null);
      setState(s => ({
        ...s, searchResults: plugins, searchTotal: plugins.length,
        searchLoading: false, searchError: error,
      }));
    } catch (err: any) {
      setState(s => ({ ...s, searchLoading: false, searchError: err.message }));
    }
  }, []);

  // ============================================================================
  // 已安装管理
  // ============================================================================

  const loadInstalled = useCallback(async () => {
    setState(s => ({ ...s, installedLoading: true }));
    try {
      const api = neoxApi();
      if (!api?.pluginList) { setState(s => ({ ...s, installedLoading: false })); return; }
      const result = await api.pluginList() as PluginListResponse;
      lastInstalled = result.plugins;
      setState(s => ({ ...s, installed: result.plugins, installedLoading: false }));
      /* 装/卸/启停之后都会走到这里: 通知按插件能力显隐的入口 (设置页「GitHub」等) 重查 */
      try { window.dispatchEvent(new CustomEvent(PLUGINS_CHANGED_EVENT)); } catch { /* ignore */ }
    } catch {
      setState(s => ({ ...s, installedLoading: false }));
    }
  }, []);

  const install = useCallback(async (nameOrPath: string, source: 'marketplace' | 'local' | 'url' | 'package' = 'marketplace') => {
    setState(s => {
      const installing = new Set(s.installing);
      installing.add(nameOrPath);
      return { ...s, installing };
    });
    try {
      const api = neoxApi();
      if (!api?.pluginInstall) {
        return { success: false as const, error: 'Plugin install API unavailable' };
      }
      const result = await api.pluginInstall({ nameOrPath, source });
      if (result?.success === false) {
        const error = Array.isArray(result.errors) && result.errors.length > 0
          ? result.errors.join('\n')
          : (result.error || 'Install failed');
        return { success: false as const, error };
      }
      await loadInstalled();
      try { window.dispatchEvent(new CustomEvent('neox:plugins-changed')); } catch { /* ignore */ }
      return {
        success: true as const,
        trust: result?.trust as string | undefined,
        warnings: (result?.warnings ?? []) as string[],
      };
    } catch (err: any) {
      return { success: false as const, error: err?.message || String(err) };
    } finally {
      setState(s => {
        const installing = new Set(s.installing);
        installing.delete(nameOrPath);
        return { ...s, installing };
      });
    }
  }, [loadInstalled]);

  /**
   * 安装前预读插件权限. 返回的 info 可以传给 <PluginPermissionDialog />.
   * 用法:
   *   const info = await preflight('my-plugin', 'marketplace');
   *   if (info) { setConfirmInfo(info); } // 让用户点确认后再 install(...)
   */
  const preflight = useCallback(async (nameOrPath: string, source: 'marketplace' | 'local' | 'url' | 'package', lang: 'zh' | 'en' = 'zh') => {
    const api = neoxApi();
    if (!api?.pluginPreflight) return null;
    const info = await api.pluginPreflight({ nameOrPath, source, lang });
    return toPermissionInfo(info);
  }, []);

  const uninstall = useCallback(async (name: string) => {
    await neoxApi()?.pluginUninstall?.(name);
    await loadInstalled();
      try { window.dispatchEvent(new CustomEvent('neox:plugins-changed')); } catch { /* ignore */ }
  }, [loadInstalled]);

  const enable = useCallback(async (name: string) => {
    await neoxApi()?.pluginEnable?.(name);
    await loadInstalled();
  }, [loadInstalled]);

  const disable = useCallback(async (name: string) => {
    await neoxApi()?.pluginDisable?.(name);
    await loadInstalled();
  }, [loadInstalled]);

  // ============================================================================
  // 分类 & 更新
  // ============================================================================

  const loadCategories = useCallback(async () => {
    try {
      const api = neoxApi();
      if (!api?.pluginCategories) return;
      const categories = await api.pluginCategories() as PluginCategoryInfo[];
      setState(s => ({ ...s, categories }));
    } catch { /* ignore */ }
  }, []);

  const checkUpdates = useCallback(async () => {
    try {
      const api = neoxApi();
      if (!api?.pluginCheckUpdates) return;
      const updates = await api.pluginCheckUpdates() as PluginUpdateInfo[];
      setState(s => ({ ...s, updates }));
    } catch { /* ignore */ }
  }, []);

  // ============================================================================
  // Tab & Selection
  // ============================================================================

  const setActiveTab = useCallback((tab: PluginManagerState['activeTab']) => {
    setState(s => ({ ...s, activeTab: tab }));
  }, []);

  const selectPlugin = useCallback((plugin: MarketplacePlugin | null) => {
    setState(s => ({ ...s, selectedPlugin: plugin }));
  }, []);

  // ============================================================================
  // 初始化
  // ============================================================================

  useEffect(() => {
    loadInstalled();
    search('');  // 初始加载全量 (不是 featured 的 10 条限制)
    loadCategories();
    checkUpdates();
  }, []);

  return {
    state,
    search,
    loadFeatured,
    loadInstalled,
    install,
    preflight,
    uninstall,
    enable,
    disable,
    loadCategories,
    checkUpdates,
    setActiveTab,
    selectPlugin,
  };
}
