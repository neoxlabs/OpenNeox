
import React, { useState, useCallback, useMemo } from 'react';
import { usePluginManager } from './hooks/usePluginManager.js';
import { PluginCard } from './components/PluginCard.js';
import { PluginDetail } from './components/PluginDetail.js';
import { takePendingPluginFocus } from './pluginFocus.js';
import { localizedDescription, allDescriptions } from './localizedDescription.js';
import { CatalogState, SkeletonCard } from './components/CatalogState.js';
import { PluginPermissionDialog, type PluginPermissionInfo } from './components/PluginPermissionDialog.js';
import { useI18n } from '../../hooks/useI18n.js';
import { IconRefresh } from '../../modules/shell/shellIcons';
import { useAgentModeVariant } from '../../hooks/useAgentModeVariant.js';
import { confirmAsync } from '../../components/confirmEvents';
import { dispatchHint, dispatchOpFailed } from '../../components/notifyEvents';
import {
  PLUGIN_FACETS,
  FACET_LABELS,
  deriveFacets,
  type PluginFacet,
} from '@neoxlabs/platform/shared/plugin-facets.js';
import { isMainstreamPlugin, isPluginVisibleInMode } from '@neoxlabs/platform/shared/plugin-types.js';
import { ToolPageHeader, ToolStats, ToolButton } from '../../components/ToolPage';
import pluginArt from '../../media/clay/tool-plugin.webp';
import './plugins-page.css';

type CatalogChip = 'popular' | 'all' | PluginFacet;

/**
 * 筛选按**分面**而不是 kind。
 *
 *   kind 是单值且描述的是「用什么做的」——「一个 Notion 工作流插件」同时是连接器和
 *   技能包, 单值分不了; 而且 MCP / Skill 跟侧栏那两个一等公民入口同名不同义。
 *   分面多值、由贡献点推导, 描述的是「能帮我干什么」。见 shared/plugin-facets.ts。
 */
const STATUS_FILTERS: Array<{ id: 'all' | 'installed' | 'updatable'; zh: string; en: string }> = [
  { id: 'all', zh: '全部', en: 'All' },
  { id: 'installed', zh: '已安装', en: 'Installed' },
  { id: 'updatable', zh: '可更新', en: 'Updates' },
];

const CATALOG_CHIPS: Array<{ id: CatalogChip; zh: string; en: string }> = [
  { id: 'all', zh: '全部', en: 'All' },
  { id: 'popular', zh: '热门', en: 'Popular' },
  ...PLUGIN_FACETS.map(f => ({ id: f, zh: FACET_LABELS[f].zh, en: FACET_LABELS[f].en })),
];

/**
 * 装完之后, 非官方签名的要说出来。
 *
 *   包校验通过 ≠ 来源可信: 逐文件哈希只保证「装到盘上的等于打包时的」, 保证不了
 *   打包的人是谁。这两件事必须分开告诉用户。
 */
function warnIfNotOfficial(result: { trust?: string; warnings?: string[] }, isZh: boolean): void {
  if (!result.trust || result.trust === 'official') return;
  const head = result.trust === 'unsigned'
    ? (isZh ? '这个插件包未签名，无法确认作者身份。' : 'This package is unsigned — the author cannot be verified.')
    : (isZh ? '这个插件包已签名，但签名公钥不在受信任列表中。' : 'Signed, but the key is not in the trusted list.');
  /* 提示而不是拦路弹窗: 装已经装完了, 这是一条要用户知道的信息, 不是要他做决定 */
  dispatchHint([head, ...(result.warnings ?? [])].join(' · '), 'warning');
}


export const PluginMarketplace: React.FC<{ onClose?: () => void }> = ({ onClose }) => {
  const { language } = useI18n();
  const isZh = language === 'zh';
  const {
    state, loadInstalled, install, preflight, uninstall, enable, disable, setActiveTab, selectPlugin,
    search,
  } = usePluginManager();

  /* 从对话里的 neox://plugins/<name> 链接跳过来: 直接打开那个插件的详情。
   * 列表里有就用列表那份 (描述已本地化), 没有就只凭名字开 —— 详情页自己会按名字拉全量。 */
  const searchResultsRef = React.useRef<any[]>([]);
  searchResultsRef.current = state.searchResults as any[];
  React.useEffect(() => {
    const focus = () => {
      const name = takePendingPluginFocus();
      if (!name) return;
      const hit = searchResultsRef.current.find((p) => p.name === name);
      selectPlugin(hit ?? ({ name, version: '', description: '' } as any));
    };
    focus();
    window.addEventListener('neox:open-plugin-store', focus);
    return () => window.removeEventListener('neox:open-plugin-store', focus);
  }, [selectPlugin]);

  const [searchQuery, setSearchQuery] = useState('');
  const [catalogChip, setCatalogChip] = useState<CatalogChip>('all');
  /* 状态筛选跟分面是两个维度: 「已安装的连接平台插件」是合理诉求 */
  const [statusFilter, setStatusFilter] = useState<'all' | 'installed' | 'updatable'>('all');
  const [page, setPage] = useState(1);
  const [installBusy, setInstallBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [pendingLocal, setPendingLocal] = useState<{
    pathOrUrl: string;
    source: 'local' | 'url' | 'package';
    info: PluginPermissionInfo;
  } | null>(null);
  const PAGE_SIZE = 18;

  const [refreshing, setRefreshing] = useState(false);
  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([loadInstalled(), search('')]);
    } finally {
      setRefreshing(false);
    }
  }, [loadInstalled, search]);

  const installedNames = useMemo(() => new Set(state.installed.map(p => p.name)), [state.installed]);
  const installedByName = useMemo(
    () => new Map(state.installed.map(p => [p.name, p])),
    [state.installed],
  );
  const updateByName = useMemo(
    () => new Map(state.updates.map(u => [u.name, u])),
    [state.updates],
  );

  /* 卡片菜单和详情页共用同一个确认 —— 两处文案原来是各写一份的 */
  const confirmUninstall = useCallback(async (name: string) => {
    const ok = await confirmAsync({
      title: isZh ? '卸载插件' : 'Uninstall plugin',
      message: isZh ? `确定卸载「${name}」？` : `Uninstall “${name}”?`,
      description: isZh
        ? '它贡献的工具会立即从 Agent 的工具表移除；凭据与已授予的能力也会一并清除。'
        : 'Its tools leave the agent immediately; stored credentials and grants are cleared too.',
      variant: 'danger',
      confirmLabel: isZh ? '卸载' : 'Uninstall',
    });
    if (ok) await uninstall(name);
  }, [isZh, uninstall]);

  /**
   * 只存在于本机、市场里没有的插件 (本地导入的 / 内置 auth 插件)。
   *
   *   合并进同一张网格, 否则「已安装」区一撤, 这些插件就彻底没地方显示了 ——
   *   它们不在目录里, 永远不会从市场结果里冒出来。
   */
  const localOnlyCards = useMemo(() => {
    const inCatalog = new Set(state.searchResults.map((p: any) => p.name));
    return state.installed
      .filter(p => !inCatalog.has(p.name))
      .map(p => {
        const m: any = p.manifest ?? {};
        return {
          name: p.name,
          version: p.version,
          description: m.description || '',
          /* 本机插件的清单里也可能带多语言文案, 一并带上, 卡片才能按界面语言显示 */
          i18n: m.i18n,
          author: m.author ?? { name: '' },
          category: m.category ?? '',
          keywords: m.keywords ?? [],
          icon: m.icon,
          kind: m.kind,
          downloads: 0,
          rating: 0,
          ratingCount: 0,
          official: false,
          publishedAt: p.installedAt,
          source: { type: 'local', url: '' },
          manifest: m,
          __localOnly: true,
        };
      });
  }, [state.installed, state.searchResults]);

  const modeVariant = useAgentModeVariant();
  const hideDelegate = !modeVariant.isCode;
  const isDelegate = useCallback((p: any): boolean => {
    const facets: string[] = Array.isArray(p.facets) && p.facets.length ? p.facets : deriveFacets(p.manifest);
    return facets.includes('delegate');
  }, []);

  const filteredResults = useMemo(() => {
    /* 「热门」= 主流白名单; 「全部」= 目录全量。两边都按 官方 > 精选 > 下载量 排。
     * 本机独有的卡只在「已安装」/ 分面 / 搜索里出现, 不混进发现区。 */
    const browsingCatalog = (catalogChip === 'popular' || catalogChip === 'all')
      && statusFilter === 'all'
      && !searchQuery.trim();
    const isPopular = browsingCatalog && catalogChip === 'popular';
    const dl = (p: any) => Number(p.downloads) || 0;
    const rank = (a: any, b: any) =>
      Number(Boolean(b.official)) - Number(Boolean(a.official))
      || Number(Boolean(b.featured)) - Number(Boolean(a.featured))
      || dl(b) - dl(a)
      || String(a.name).localeCompare(String(b.name));
    let results = browsingCatalog
      ? [...(state.searchResults as any[])].sort(rank)
      : [...localOnlyCards, ...(state.searchResults as any[])]
          /* 管理视角 (已安装 / 分面 / 搜索): 装过的排前面, 同组内再按热度 */
          .sort((a, b) => Number(installedNames.has(b.name)) - Number(installedNames.has(a.name)) || rank(a, b));

    if (hideDelegate && statusFilter !== 'installed') {
      results = results.filter(p => !isDelegate(p));
    }
    if (statusFilter !== 'installed') {
      results = results.filter(p => isPluginVisibleInMode(p.name, modeVariant.mode));
    }
    if (statusFilter === 'installed') {
      results = results.filter(p => installedNames.has(p.name));
    } else if (statusFilter === 'updatable') {
      results = results.filter(p => updateByName.has(p.name));
    }
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      results = results.filter((p: any) =>
        (p.name || '').toLowerCase().includes(q)
        /* 所有语言的描述都参与匹配: 英文界面搜"日历"、中文界面搜 calendar 都要能命中 */
        || allDescriptions(p).some((d) => d.toLowerCase().includes(q)),
      );
    }
    if (isPopular) {
      results = results.filter(p => isMainstreamPlugin(p.name));
    }
    if (catalogChip !== 'popular' && catalogChip !== 'all') {
      /* 服务端给了 facets 就用它; 老服务端没有这个字段时从 manifest 兜底推导 ——
       * 同一个 deriveFacets, 两边不会算出两套结果 */
      results = results.filter((p: any) => {
        const facets: string[] = Array.isArray(p.facets) && p.facets.length
          ? p.facets
          : deriveFacets(p.manifest);
        return facets.includes(catalogChip);
      });
    }
    return results;
  }, [state.searchResults, localOnlyCards, catalogChip, searchQuery, statusFilter, installedNames, updateByName, hideDelegate, isDelegate, modeVariant.mode]);

  const pagedResults = useMemo(
    () => filteredResults.slice(0, page * PAGE_SIZE),
    [filteredResults, page],
  );
  const hasMore = pagedResults.length < filteredResults.length;

  const handleInstallLocal = useCallback(async () => {
    const api = (window as any).neox;
    if (!api?.pluginPickInstallSource || !api?.pluginInstall) {
      dispatchOpFailed({
        op: isZh ? '导入插件' : 'Import plugin',
        message: isZh
          ? '桌面端插件接口未就绪，重启后再试；也可在终端用 neox /plugins install ./path'
          : 'Desktop plugin APIs unavailable. Restart the app, or use: neox /plugins install ./path',
      });
      return;
    }
    setInstallBusy(true);
    try {
      const picked = await api.pluginPickInstallSource({
        title: isZh ? '安装插件' : 'Install plugin',
        buttonLabel: isZh ? '安装' : 'Install',
      });
      if (!picked?.ok || !picked.pathOrUrl) {
        if (picked?.error) dispatchOpFailed({ op: isZh ? '选择插件' : 'Pick plugin', message: picked.error });
        return;
      }
      /* picker 会回 'package' (.neox-plugin) — 落回 'local' 会让带完整性校验的
       * 导入路径整条失效, 文件路径被当成目录去装, 只会报一句 plugin.json 找不到 */
      const source = (picked.source === 'url'
        ? 'url'
        : picked.source === 'package' ? 'package' : 'local') as 'local' | 'url' | 'package';
      const info = await preflight(picked.pathOrUrl, source, isZh ? 'zh' : 'en');
      if (info) {
        setPendingLocal({ pathOrUrl: picked.pathOrUrl, source, info });
        return;
      }
      /* 预读失败也不拦安装 — 目录/tarball 仍可直接装 */
      const result = await install(picked.pathOrUrl, source);
      if (!result.success) {
        dispatchOpFailed({ op: isZh ? '安装插件' : 'Install plugin', message: result.error || '' });
        return;
      }
      warnIfNotOfficial(result, isZh);
      setStatusFilter('installed');
    } catch (err: any) {
      dispatchOpFailed({ op: isZh ? '安装插件' : 'Install plugin', message: err?.message || String(err) });
    } finally {
      setInstallBusy(false);
    }
  }, [isZh, install, preflight, setActiveTab]);

  /**
   * 拖一个 .neox-plugin 进来直接导入。
   *
   *   Electron 40 起 `File.path` 被移除, 必须用 preload 侧的
   *   webUtils.getPathForFile 换真实路径 —— 渲染进程自己拿不到。
   */
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const api = (window as any).neox;
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;

    const filePath = api?.getPathForFile?.(file);
    if (!filePath) {
      dispatchOpFailed({
        op: isZh ? '导入插件' : 'Import plugin',
        message: isZh ? '拿不到文件路径，请改用「导入插件」按钮' : 'Could not resolve the file path — use the Import button',
      });
      return;
    }
    if (!/\.neox-plugin$/i.test(filePath)) {
      dispatchOpFailed({
        op: isZh ? '导入插件' : 'Import plugin',
        message: isZh ? '只能导入 .neox-plugin 包' : 'Only .neox-plugin packages can be imported',
      });
      return;
    }

    setInstallBusy(true);
    try {
      const info = await preflight(filePath, 'package', isZh ? 'zh' : 'en');
      if (info) {
        setPendingLocal({ pathOrUrl: filePath, source: 'package', info });
        return;
      }
      const result = await install(filePath, 'package');
      if (!result.success) {
        dispatchOpFailed({ op: isZh ? '导入插件' : 'Import plugin', message: result.error || '' });
        return;
      }
      setStatusFilter('installed');
    } catch (err: any) {
      dispatchOpFailed({ op: isZh ? '安装插件' : 'Install plugin', message: err?.message || String(err) });
    } finally {
      setInstallBusy(false);
    }
  }, [isZh, install, preflight]);

  const confirmLocalInstall = useCallback(async () => {
    if (!pendingLocal) return;
    const { pathOrUrl, source } = pendingLocal;
    setPendingLocal(null);
    setInstallBusy(true);
    try {
      const result = await install(pathOrUrl, source);
      if (!result.success) {
        dispatchOpFailed({ op: isZh ? '安装插件' : 'Install plugin', message: result.error || '' });
        return;
      }
      warnIfNotOfficial(result, isZh);
      /* 导入完把视图切到「已安装」, 让用户立刻看到刚装的那个 */
      setStatusFilter('installed');
    } catch (err: any) {
      dispatchOpFailed({ op: isZh ? '安装插件' : 'Install plugin', message: err?.message || String(err) });
    } finally {
      setInstallBusy(false);
    }
  }, [pendingLocal, install, isZh]);


  /* 数字条:「可以装」= 当前模式下看得到、还没装的目录插件 (跟网格同一套可见性) */
  const installableCount = useMemo(() => (state.searchResults as any[]).filter((p) =>
    !installedNames.has(p.name)
    && isPluginVisibleInMode(p.name, modeVariant.mode)
    && !(hideDelegate && isDelegate(p)),
  ).length, [state.searchResults, installedNames, modeVariant.mode, hideDelegate, isDelegate]);

  const [updatingAll, setUpdatingAll] = useState(false);
  const updateAll = useCallback(async () => {
    setUpdatingAll(true);
    try {
      for (const u of state.updates) await install(u.name);
    } finally {
      setUpdatingAll(false);
    }
  }, [state.updates, install]);

  const [catOpen, setCatOpen] = useState(false);
  React.useEffect(() => {
    if (!catOpen) return;
    const close = () => setCatOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [catOpen]);
  const catChips = CATALOG_CHIPS.filter((f) => !(hideDelegate && f.id === 'delegate'));
  const catCurrent = catChips.find((f) => f.id === catalogChip);
  const catLabel = catalogChip === 'all' || !catCurrent
    ? (isZh ? '所有分类' : 'All categories')
    : (isZh ? catCurrent.zh : catCurrent.en);

  return (
    <div className={`neox-plugins tp-page${state.selectedPlugin ? ' is-detail' : ''}`}>
      {!state.selectedPlugin && (
        <div className="neox-plugins__top">
          <ToolPageHeader
            icon={pluginArt}
            title={isZh ? '插件' : 'Plugins'}
            desc={isZh
              ? '给 Agent 装新本事：连上 GitHub、Cloudflare，查论文、汇率、数据库…'
              : 'Give the agent new skills: GitHub, Cloudflare, papers, currency, databases…'}
            onBack={onClose}
            zh={isZh}
            actions={(
              <ToolButton onClick={handleInstallLocal} disabled={installBusy}>
                {installBusy ? (isZh ? '导入中…' : 'Importing…') : (isZh ? '＋ 导入插件' : '＋ Import plugin')}
              </ToolButton>
            )}
          />
          <ToolStats
            items={[
              { value: state.installed.length, label: isZh ? '个已安装' : 'installed' },
              { value: installableCount, label: isZh ? '个可以装' : 'available' },
              ...(state.updates.length > 0
                ? [{ value: state.updates.length, label: isZh ? '个有更新' : 'updates', tone: 'accent' as const }]
                : []),
            ]}
            right={state.updates.length > 0 ? (
              <ToolButton onClick={() => { void updateAll(); }} disabled={updatingAll}>
                {updatingAll ? (isZh ? '更新中…' : 'Updating…') : (isZh ? '全部更新' : 'Update all')}
              </ToolButton>
            ) : undefined}
          />
        </div>
      )}

      <PluginPermissionDialog
        visible={!!pendingLocal}
        info={pendingLocal?.info ?? null}
        onConfirm={confirmLocalInstall}
        onClose={() => setPendingLocal(null)}
      />

      {state.selectedPlugin ? (
        <div className="neox-plugins__body">
          <PluginDetail
            plugin={state.selectedPlugin}
            installed={installedNames.has(state.selectedPlugin.name)}
            enabled={installedByName.get(state.selectedPlugin.name)?.enabled}
            updateTo={updateByName.get(state.selectedPlugin.name)?.latestVersion}
            installing={state.installing.has(state.selectedPlugin.name)}
            onInstall={() => install(state.selectedPlugin!.name)}
            onInstalled={() => loadInstalled()}
            onToggle={(next) => (next ? enable(state.selectedPlugin!.name) : disable(state.selectedPlugin!.name))}
            onUninstall={() => { void confirmUninstall(state.selectedPlugin!.name); }}
            onClose={() => selectPlugin(null)}
          />
        </div>
      ) : (
        <div className="neox-plugins__body">
          <section
            className={`neox-plugins__zone neox-plugins__catalog${dragOver ? ' is-dropping' : ''}`}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
          >
            {dragOver && (
              <div className="neox-plugins__droppad">
                {isZh ? '松手导入 .neox-plugin' : 'Drop to import .neox-plugin'}
              </div>
            )}
            <div className="neox-plugins__catalog-bar">
              <div className="neox-plugins__seg" role="tablist">
                {STATUS_FILTERS.map((f) => {
                  const count = f.id === 'installed'
                    ? state.installed.length
                    : f.id === 'updatable' ? state.updates.length : 0;
                  /* 没有可更新的就不显示这个筛选 —— 一个恒为 0 的入口只是噪音 */
                  if (f.id === 'updatable' && count === 0) return null;
                  return (
                    <button
                      key={f.id}
                      type="button"
                      role="tab"
                      aria-selected={statusFilter === f.id}
                      className={`neox-plugins__seg-item${statusFilter === f.id ? ' is-active' : ''}`}
                      onClick={() => { setStatusFilter(f.id); setPage(1); }}
                    >
                      {isZh ? f.zh : f.en}{count > 0 ? ` ${count}` : ''}
                    </button>
                  );
                })}
              </div>

              {/* 「委派 Agent」这颗分面同样只在 Code 里有 —— 见 hideDelegate */}
              <div className="neox-plugins__cat">
                <button
                  type="button"
                  className={`neox-plugins__cat-btn${catalogChip !== 'all' ? ' is-set' : ''}`}
                  aria-expanded={catOpen}
                  onClick={(e) => { e.stopPropagation(); setCatOpen((v) => !v); }}
                >
                  {catLabel}
                  <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3 4.5 3 3 3-3" /></svg>
                </button>
                {catOpen && (
                  <div className="neox-plugins__cat-menu" role="menu" onClick={(e) => e.stopPropagation()}>
                    {catChips.map((f) => (
                      <button
                        key={String(f.id)}
                        type="button"
                        role="menuitemradio"
                        aria-checked={catalogChip === f.id}
                        className={catalogChip === f.id ? 'is-active' : undefined}
                        onClick={() => { setCatalogChip(f.id); setPage(1); setCatOpen(false); }}
                      >
                        {f.id === 'all' ? (isZh ? '所有分类' : 'All categories') : (isZh ? f.zh : f.en)}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <label className="neox-plugins__search">
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></svg>
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => { setSearchQuery(e.target.value); setPage(1); }}
                  placeholder={isZh ? '搜插件' : 'Search plugins'}
                  aria-label={isZh ? '搜索插件' : 'Search plugins'}
                />
              </label>

              <button
                type="button"
                className={`neox-plugins__refresh${refreshing ? ' is-spinning' : ''}`}
                onClick={() => { void refreshAll(); }}
                disabled={refreshing}
                title={isZh ? '刷新' : 'Refresh'}
                aria-label={isZh ? '刷新插件列表' : 'Refresh plugins'}
              >
                <IconRefresh size={14} />
              </button>
            </div>

            <CatalogState
                loading={state.searchLoading && filteredResults.length === 0}
                error={state.searchError}
                empty={filteredResults.length === 0}
                filtered={Boolean(searchQuery.trim() || (catalogChip !== 'popular' && catalogChip !== 'all'))}
                isZh={isZh}
                onRetry={() => { void refreshAll(); }}
              />

              <div className="neox-plugin-grid">
                {pagedResults.map((plugin: any) => {
                  const localized = { ...plugin, description: localizedDescription(plugin, language) };
                  const inst = installedByName.get(plugin.name);
                  const upd = updateByName.get(plugin.name);
                  return (
                    <PluginCard
                      key={plugin.name}
                      plugin={localized}
                      isZh={isZh}
                      installed={Boolean(inst)}
                      enabled={inst?.enabled}
                      localOnly={Boolean(plugin.__localOnly)}
                      updateTo={upd?.latestVersion}
                      installing={state.installing.has(plugin.name)}
                      onInstall={() => install(plugin.name)}
                      onToggle={inst ? (next) => (next ? enable(plugin.name) : disable(plugin.name)) : undefined}
                      onUninstall={inst ? () => { void confirmUninstall(plugin.name); } : undefined}
                      onClick={() => selectPlugin(localized)}
                    />
                  );
                })}
                {state.searchLoading && filteredResults.length > 0
                  && Array.from({ length: 3 }, (_, i) => <SkeletonCard key={`pending-${i}`} />)}
              </div>

              {hasMore && (
                <div className="neox-plugins__pager">
                  <button type="button" className="neox-plugins__link" onClick={() => setPage(p => p + 1)}>
                    {isZh ? '加载更多' : 'Load more'}
                  </button>
                </div>
              )}

          </section>
        </div>
      )}
    </div>
  );
};

export default PluginMarketplace;
