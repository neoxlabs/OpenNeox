/**
 * PluginCard — 无边框高级卡片 (质感表面, 非 Cursor 空态框风)
 */

import React from 'react';
import type { MarketplacePlugin, PluginKind } from '@neoxlabs/platform/shared/plugin-types.js';
import {
  declaredPlatforms,
  isPlatformSupported,
  platformsLabel,
} from '@neoxlabs/platform/shared/plugin-platform.js';
import { PluginBrandLogo } from './PluginBrandLogo.js';
import { hostPlatform } from '../hostPlatform.js';

interface PluginCardProps {
  plugin: MarketplacePlugin & { pluginType?: string };
  installed?: boolean;
  installing?: boolean;
  /** 已安装且有新版本时给出目标版本 */
  updateTo?: string;
  /** 已安装插件的启用状态 */
  enabled?: boolean;
  /** 只存在于本机、市场里没有的插件 (本地导入 / 内置) */
  localOnly?: boolean;
  onInstall?: () => void;
  onToggle?: (next: boolean) => void;
  onUninstall?: () => void;
  onClick?: () => void;
  isZh?: boolean;
}

const KIND_LABEL: Record<string, { zh: string; en: string }> = {
  module: { zh: '插件', en: 'Plugin' },
  mcp: { zh: 'MCP', en: 'MCP' },
  skill: { zh: 'Skill', en: 'Skill' },
  tool: { zh: '工具', en: 'Tool' },
  auth: { zh: '授权', en: 'Auth' },
  bundle: { zh: '组合包', en: 'Bundle' },
  plugin: { zh: '插件', en: 'Plugin' },
};

function resolveKind(plugin: MarketplacePlugin & { pluginType?: string }): string {
  return plugin.kind || plugin.pluginType || 'plugin';
}

/* 分类是清单里的英文 id (automation / connector …), 直接显示在中文界面里就是一串英文 */
const CATEGORY_LABEL: Record<string, { zh: string; en: string }> = {
  automation: { zh: '自动化', en: 'Automation' },
  connector: { zh: '连接平台', en: 'Connector' },
  productivity: { zh: '效率', en: 'Productivity' },
  devops: { zh: '运维', en: 'DevOps' },
  database: { zh: '数据库', en: 'Database' },
  web: { zh: '网页', en: 'Web' },
  testing: { zh: '测试', en: 'Testing' },
  'ai-ml': { zh: 'AI', en: 'AI / ML' },
  security: { zh: '安全', en: 'Security' },
  language: { zh: '语言', en: 'Language' },
  documentation: { zh: '文档', en: 'Docs' },
  community: { zh: '社区', en: 'Community' },
  media: { zh: '媒体', en: 'Media' },
  auth: { zh: '登录授权', en: 'Auth' },
};

export function categoryLabel(category: string | undefined, isZh: boolean): string {
  if (!category) return '';
  const hit = CATEGORY_LABEL[category];
  return hit ? (isZh ? hit.zh : hit.en) : category;
}

export const PluginCard: React.FC<PluginCardProps> = ({
  plugin, installed, installing, updateTo, enabled, localOnly,
  onInstall, onToggle, onUninstall, onClick, isZh,
}) => {
  const kind = resolveKind(plugin);
  const [menuOpen, setMenuOpen] = React.useState(false);

  const platforms = declaredPlatforms(plugin);
  const platformOk = isPlatformSupported(platforms, hostPlatform());
  const unsupported = platforms !== null && !platformOk;
  const platformsText = platformsLabel(platforms, Boolean(isZh));
  const unsupportedText = isZh ? '不支持当前系统' : 'Not for this system';

  /* 菜单开着时点别处要关掉 —— 不然会留一个跟着滚动的浮层 */
  React.useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menuOpen]);
  const label = KIND_LABEL[kind]?.[isZh ? 'zh' : 'en'] ?? KIND_LABEL.plugin[isZh ? 'zh' : 'en'];

  return (
    <article
      className={
        'neox-plugin-card'
        + (installed ? ' is-installed' : '')
        + (installed && enabled === false ? ' is-off' : '')
      }
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick?.();
        }
      }}
    >
      <header className="neox-plugin-card__head">
        {/* 真官方 mark; 没有本地资产时 PluginBrandLogo 自己退回 emoji / 首字母 */}
        <PluginBrandLogo name={plugin.name} icon={(plugin as any).icon} size={36} />
        <div className="neox-plugin-card__titles">
          <div className="neox-plugin-card__title-row">
            <h3 className="neox-plugin-card__name" title={`v${plugin.version}`}>{plugin.name}</h3>
          </div>
          <div className="neox-plugin-card__meta-row">
            <span>{plugin.category ? categoryLabel(plugin.category, Boolean(isZh)) : label}</span>
            {plugin.official && <span>{isZh ? '官方' : 'Official'}</span>}
            {localOnly && <span>{isZh ? '本地' : 'Local'}</span>}
            {installed && enabled === false && <span>{isZh ? '已停用' : 'Disabled'}</span>}
            {platforms && (
              <span
                className={unsupported ? 'is-warn' : undefined}
                title={unsupported ? unsupportedText : undefined}
              >
                {unsupported
                  ? (isZh ? `仅 ${platformsText}` : `${platformsText} only`)
                  : platformsText}
              </span>
            )}
          </div>
        </div>

        <div className="neox-plugin-card__actions">
          {!installed && (
            <button
              type="button"
              className="neox-plugin-card__install"
              disabled={installing || unsupported}
              title={unsupported ? unsupportedText : undefined}
              onClick={(e) => { e.stopPropagation(); onInstall?.(); }}
            >
              {installing
                ? (isZh ? '安装中…' : 'Installing…')
                : unsupported
                  ? unsupportedText
                  : (isZh ? '安装' : 'Install')}
            </button>
          )}

          {installed && updateTo && (
            /* 有新版本时这才是主操作 —— 「已安装」在这种情况下是句废话 */
            <button
              type="button"
              className="neox-plugin-card__install is-update"
              disabled={installing || unsupported}
              title={unsupported ? unsupportedText : undefined}
              onClick={(e) => { e.stopPropagation(); onInstall?.(); }}
            >
              {installing ? (isZh ? '更新中…' : 'Updating…') : `${isZh ? '更新' : 'Update'} v${updateTo}`}
            </button>
          )}

          {installed && !updateTo && !onToggle && (
            <span className="neox-plugin-card__status">{isZh ? '已安装' : 'Installed'}</span>
          )}

          {installed && onUninstall && (
            /* 卸载收进悬停才出的 ⋯ —— 开关已经是主操作, 卡片上常驻一颗 ⋯ 只是噪音 */
            <div className={`neox-plugin-card__more${menuOpen ? ' is-open' : ''}`}>
              <button
                type="button"
                className="neox-plugin-card__more-btn"
                aria-label={isZh ? '更多操作' : 'More actions'}
                aria-expanded={menuOpen}
                onClick={(e) => { e.stopPropagation(); setMenuOpen(v => !v); }}
              >
                ⋯
              </button>
              {menuOpen && (
                <div className="neox-plugin-card__menu" onClick={(e) => e.stopPropagation()}>
                  <button type="button" className="is-danger" onClick={() => { setMenuOpen(false); onUninstall(); }}>
                    {isZh ? '卸载' : 'Uninstall'}
                  </button>
                </div>
              )}
            </div>
          )}

          {installed && onToggle && !updateTo && (
            <button
              type="button"
              role="switch"
              aria-checked={enabled !== false}
              aria-label={enabled === false ? (isZh ? '启用' : 'Enable') : (isZh ? '停用' : 'Disable')}
              className={`neox-plugin-card__switch${enabled !== false ? ' is-on' : ''}`}
              onClick={(e) => { e.stopPropagation(); onToggle(enabled === false); }}
            >
              <span />
            </button>
          )}
        </div>
      </header>

      <p className="neox-plugin-card__desc">{plugin.description}</p>
    </article>
  );
};

export type { PluginKind };
