
import React, { useEffect, useState } from 'react';
import type { MarketplacePlugin } from '@neoxlabs/platform/shared/plugin-types.js';
import { FACET_LABELS, deriveFacets, type PluginFacet } from '@neoxlabs/platform/shared/plugin-facets.js';
import { declaredPlatforms, isPlatformSupported, platformsLabel } from '@neoxlabs/platform/shared/plugin-platform.js';
import { hostPlatform } from '../hostPlatform.js';
import { PluginPermissionDialog, toPermissionInfo, type PluginPermissionInfo } from './PluginPermissionDialog.js';
import { PluginBrandLogo } from './PluginBrandLogo.js';
import { ConnectorPanel } from './ConnectorPanel.js';
import { categoryLabel } from './PluginCard.js';
import { Gallery, TryAsking, Features, SettingsForm } from './PluginDetailSections.js';
import { readListing, readConfigFields, remoteIconUrl } from '../pluginListing.js';
import { useI18n } from '../../../hooks/useI18n.js';
import { localizedDescription } from '../localizedDescription.js';
import { dispatchHint } from '../../../components/notifyEvents';
import { SETTINGS_TAB_BY_CAPABILITY } from '../../../hooks/usePluginCapability';
import { usePluginViews } from '../../../modules/pluginViews/usePluginViews';
import { openPluginView } from '../../../modules/pluginViews/openPluginView';

interface PluginDetailProps {
  plugin: MarketplacePlugin & { pluginType?: string };
  installed?: boolean;
  enabled?: boolean;
  installing?: boolean;
  /** 有新版本时的版本号 */
  updateTo?: string;
  onInstall?: () => void;
  onInstalled?: () => void;  // 安装成功后回调 (刷新已安装列表)
  onToggle?: (next: boolean) => void;
  onUninstall?: () => void;
  onClose?: () => void;
}

type InstallState = 'idle' | 'installing' | 'success' | 'error';

export const PluginDetail: React.FC<PluginDetailProps> = ({
  plugin: listed, installed, enabled, installing: externalInstalling, updateTo,
  onInstall, onInstalled, onToggle, onUninstall, onClose,
}) => {
  const { language } = useI18n();
  const isZh = language === 'zh';

  /* 列表项不带 manifest —— 拉一次详情, 拿到后跟列表数据合并 */
  const [full, setFull] = useState<any>(null);
  useEffect(() => {
    let alive = true;
    setFull(null);
    (async () => {
      const api = (window as any).neox;
      const d = await api?.pluginDetail?.(listed.name).catch(() => null);
      if (!alive) return;
      if (d?.manifest) { setFull(d); return; }
      /* 本地装的、市场上没有的插件: 用本机清单 */
      const info = await api?.pluginInfo?.(listed.name).catch(() => null);
      if (alive && info?.manifest) setFull({ manifest: info.manifest });
    })();
    return () => { alive = false; };
  }, [listed.name]);
  const plugin: any = { ...listed, ...(full ?? {}), manifest: full?.manifest ?? (listed as any).manifest };

  const pType = plugin.pluginType || 'plugin';
  const [installState, setInstallState] = useState<InstallState>(installed ? 'success' : 'idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [permissionInfo, setPermissionInfo] = useState<PluginPermissionInfo | null>(null);
  useEffect(() => { setInstallState(installed ? 'success' : 'idle'); }, [installed]);

  /* 跟卡片同一条规则取描述 (清单 i18n → 老 descriptionZh → 主描述), 见 localizedDescription.ts */
  const description = localizedDescription(plugin, language);
  const listing = readListing(plugin.manifest, isZh);
  const configFields = readConfigFields(plugin.manifest, isZh);
  /* 能力类插件 (kind: module) 装完没有任何可见产物 —— 它点亮的是设置里的一整页 */
  const declaredCaps: string[] = (plugin.capabilities ?? plugin.manifest?.capabilities ?? []) as string[];
  const settingsTab = declaredCaps.map((c) => SETTINGS_TAB_BY_CAPABILITY[c]).find(Boolean);
  const facets: PluginFacet[] = (Array.isArray(plugin.facets) && plugin.facets.length
    ? plugin.facets
    : deriveFacets(plugin.manifest)) as PluginFacet[];
  /* 平台声明 —— 不支持当前系统的插件不给装 (判据与卡片共用 plugin-platform.ts) */
  const platforms = declaredPlatforms(plugin);
  const unsupported = platforms !== null && !isPlatformSupported(platforms, hostPlatform());
  const unsupportedText = isZh ? '这个插件不支持当前系统' : 'Unsupported on this system';
  const isInstalled = installed || installState === 'success';
  const ownViews = usePluginViews().filter((v) => v.pluginName === plugin.name);

  // 点 安装: 先跑 preflight 拿权限摘要, 让用户装之前看清要什么
  const handleInstallClick = async () => {
    if (unsupported) return;
    try {
      const api = (window as any).neox;
      if (pType === 'plugin' && api?.pluginPreflight) {
        const info = toPermissionInfo(await api.pluginPreflight({ nameOrPath: plugin.name, source: 'marketplace', lang: isZh ? 'zh' : 'en' }));
        if (info) {
          setPermissionInfo(info);
          return; // 等用户在弹窗里点确认
        }
      }
      await runInstall();
    } catch (err: any) {
      setInstallState('error');
      setErrorMsg(err.message || (isZh ? '权限预读失败' : 'Preflight failed'));
    }
  };

  const runInstall = async () => {
    setInstallState('installing');
    setErrorMsg('');
    try {
      const api = (window as any).neox;
      if (!api?.pluginMarketplaceInstall) throw new Error(isZh ? '插件接口不可用' : 'Plugin API not available');
      const result = await api.pluginMarketplaceInstall({
        name: plugin.name,
        version: plugin.version,
        description: plugin.description,
        pluginType: pType,
        category: plugin.category,
        keywords: plugin.keywords,
        author: plugin.author,
        source: plugin.source,
      });
      if (!result.success) {
        setInstallState('error');
        setErrorMsg(result.error || (isZh ? '安装失败' : 'Installation failed'));
        return;
      }
      setInstallState('success');
      /* 非官方签名要说出来 */
      if (result.trust && result.trust !== 'official') {
        dispatchHint(
          result.trust === 'unsigned'
            ? (isZh ? '已安装，但这个包未签名，无法确认作者身份' : 'Installed, but this package is unsigned')
            : (isZh ? '已安装，但签名公钥不在受信任列表中' : 'Installed, but the signing key is not trusted'),
          'warning',
        );
      }
      onInstalled?.();
    } catch (err: any) {
      setInstallState('error');
      setErrorMsg(err.message || (isZh ? '安装失败' : 'Installation failed'));
    }
  };

  const perms = plugin.manifest?.permissions ?? {};
  const permLines: string[] = [
    ...(pType === 'plugin' && plugin.manifest?.kind !== 'connector'
      ? [isZh ? '在你的电脑上运行，数据不经过 Neox 服务器' : 'Runs on your computer; data does not pass through Neox servers']
      : []),
    ...(perms.network ? [isZh ? '会访问网络' : 'Uses the network'] : []),
    ...(perms.filesystem?.write?.length ? [isZh ? '会写入你指定的文件' : 'Writes files you point it to'] : []),
    ...(configFields.some((f) => f.sensitive) ? [isZh ? '密钥类设置加密保存在本机' : 'Secrets are stored encrypted on this machine'] : []),
  ];

  const stats: Array<[string, React.ReactNode]> = [
    [isZh ? '安装量' : 'Installs', (plugin.downloads ?? 0).toLocaleString()],
    /* 0 分 0 人不该显示成「☆☆☆☆☆ 0.0」—— 那看着像评分很差, 其实是还没人评 */
    [isZh ? '评分' : 'Rating', plugin.ratingCount ? `${plugin.rating.toFixed(1)} ★` : '—'],
    [isZh ? '分类' : 'Category', categoryLabel(plugin.category, isZh) || '—'],
    [isZh ? '开发者' : 'Developer', plugin.author?.name || '—'],
    [isZh ? '版本' : 'Version', `v${plugin.version}`],
  ];

  const meta: Array<[string, React.ReactNode]> = [
    [isZh ? '发布' : 'Published',
      plugin.publishedAt ? new Date(plugin.publishedAt).toLocaleDateString(isZh ? 'zh-CN' : 'en-US') : '—'],
    ...(plugin.manifest?.license ? [[isZh ? '许可' : 'License', plugin.manifest.license] as [string, React.ReactNode]] : []),
    /* 声明了平台才显示 —— 大多数插件没写, 显示「全平台」是句废话 */
    ...(platforms ? [[isZh ? '支持平台' : 'Platforms', platformsLabel(platforms, isZh)] as [string, React.ReactNode]] : []),
    ...(plugin.manifest?.homepage && /^https:\/\//.test(plugin.manifest.homepage)
      ? [[isZh ? '主页' : 'Website', <a key="hp" href={plugin.manifest.homepage} target="_blank" rel="noreferrer">{new URL(plugin.manifest.homepage).hostname}</a>] as [string, React.ReactNode]]
      : []),
  ];

  return (
    <div className="neox-plugin-detail npd">
      <button type="button" className="npd-back" onClick={onClose}>
        ← {isZh ? '返回插件市场' : 'Back to marketplace'}
      </button>

      <header className="npd-hero">
        <PluginBrandLogo name={plugin.name} icon={remoteIconUrl(plugin) ?? plugin.icon ?? plugin.manifest?.icon} size={88} />
        <div className="npd-hero__text">
          <h1 className="npd-hero__name">
            <span>{plugin.name}</span>
            {plugin.official && <span className="neox-plugin-card__chip is-official">{isZh ? '官方' : 'Official'}</span>}
          </h1>
          <p className="npd-hero__desc">{description}</p>
          {facets.length > 0 && (
            <div className="npd-hero__chips">
              {facets.map((f) => (
                <span key={f} className="neox-plugin-card__chip is-muted">
                  {FACET_LABELS[f] ? (isZh ? FACET_LABELS[f].zh : FACET_LABELS[f].en) : f}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="npd-hero__action">
          {!isInstalled && installState !== 'installing' && installState !== 'error' && (
            <button
              type="button"
              className="neox-plugins__btn is-primary npd-get"
              onClick={handleInstallClick}
              disabled={externalInstalling || unsupported}
              title={unsupported ? unsupportedText : undefined}
            >
              {externalInstalling ? (isZh ? '安装中…' : 'Installing…') : unsupported ? unsupportedText : (isZh ? '安装' : 'Install')}
            </button>
          )}
          {installState === 'installing' && (
            <div className="npd-progress" role="status">
              <span className="npd-progress__bar"><i /></span>
              <span className="npd-progress__text">{isZh ? '正在安装…' : 'Installing…'}</span>
            </div>
          )}
          {installState === 'error' && (
            <div className="npd-result is-err" role="alert">
              <span>{errorMsg}</span>
              <button type="button" className="neox-plugins__btn is-ghost" onClick={() => setInstallState('idle')}>
                {isZh ? '重试' : 'Retry'}
              </button>
            </div>
          )}
          {isInstalled && (
            <>
              <div className="npd-installed">
                <span className="npd-installed__state">✓ {isZh ? '已安装' : 'Installed'}</span>
                {onToggle && (
                  <label className="npd-switch" title={isZh ? '停用后它的工具不再出现在对话里' : 'When off, its tools are hidden from the agent'}>
                    <input type="checkbox" checked={enabled !== false} onChange={(e) => onToggle(e.target.checked)} />
                    <span>{enabled !== false ? (isZh ? '已启用' : 'Enabled') : (isZh ? '已停用' : 'Disabled')}</span>
                  </label>
                )}
              </div>
              <div className="npd-installed__btns">
                {/* 带面板的插件 (agent-hub / local-models …): 装完直接能打开看, 不用等 agent 调用。
                    只认主进程已注册的 views —— 停用了的插件不在里面, 按钮自然不出。 */}
                {ownViews.map((v) => (
                  <button key={v.id} type="button" className="neox-plugins__btn is-primary" onClick={() => openPluginView(v)}>
                    {ownViews.length > 1 ? `${isZh ? '打开' : 'Open'} ${v.title}` : (isZh ? '打开面板' : 'Open panel')}
                  </button>
                ))}
                {updateTo && onInstall && (
                  <button type="button" className="neox-plugins__btn is-primary" onClick={onInstall} disabled={externalInstalling}>
                    {externalInstalling ? (isZh ? '更新中…' : 'Updating…') : `${isZh ? '更新到' : 'Update to'} v${updateTo}`}
                  </button>
                )}
                {settingsTab && (
                  <button
                    type="button"
                    className="neox-plugins__btn is-ghost"
                    onClick={() => { try { window.dispatchEvent(new CustomEvent('neox:open-settings', { detail: { tab: settingsTab } })); } catch { /* ignore */ } }}
                  >
                    {isZh ? '打开设置' : 'Open settings'}
                  </button>
                )}
                {onUninstall && (
                  <button type="button" className="neox-plugins__btn is-ghost npd-uninstall" onClick={onUninstall}>
                    {isZh ? '卸载' : 'Uninstall'}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </header>

      <dl className="npd-stats">
        {stats.map(([label, value]) => (
          <div key={label} className="npd-stats__cell">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      <Gallery shots={listing.screenshots} isZh={isZh} />

      <div className="npd-body">
        <div className="npd-main">
          {isInstalled && <ConnectorPanel pluginName={plugin.name} />}
          <TryAsking examples={listing.examples} ready={Boolean(isInstalled && enabled !== false)} isZh={isZh} />
          <Features features={listing.features} isZh={isZh} />
          <section className="npd-block">
            <h2 className="npd-block__title">{isZh ? '简介' : 'About'}</h2>
            <p className="npd-about">{description}</p>
            {plugin.keywords?.length > 0 && (
              <div className="npd-tags">
                {plugin.keywords.map((k: string) => <span key={k} className="neox-plugin-card__chip is-muted">{k}</span>)}
              </div>
            )}
          </section>
        </div>

        <aside className="npd-side">
          {isInstalled && <SettingsForm pluginName={plugin.name} fields={configFields} isZh={isZh} />}
          {permLines.length > 0 && (
            <section className="npd-block">
              <h2 className="npd-block__title">{isZh ? '权限与隐私' : 'Permissions & privacy'}</h2>
              <ul className="npd-perms">{permLines.map((l) => <li key={l}>{l}</li>)}</ul>
            </section>
          )}
          <section className="npd-block">
            <h2 className="npd-block__title">{isZh ? '信息' : 'Information'}</h2>
            <dl className="npd-meta">
              {meta.map(([label, value]) => (
                <div key={String(label)} className="npd-meta__row">
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </section>
        </aside>
      </div>

      <PluginPermissionDialog
        visible={permissionInfo !== null}
        info={permissionInfo}
        onConfirm={async () => {
          setPermissionInfo(null);
          await runInstall();
        }}
        onClose={() => setPermissionInfo(null)}
      />
    </div>
  );
};
