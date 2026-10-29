
import React from 'react';

/* ── 插画 ────────────────────────────────────────────────────────────────
   两张都刻意画得很轻: 空态插画抢戏会让人以为出了事。               */

const EmptyArt: React.FC = () => (
  <svg className="neox-plugin-art" viewBox="0 0 96 72" fill="none" aria-hidden="true">
    <rect x="10" y="14" width="30" height="24" rx="5" stroke="currentColor" strokeWidth="1.5" opacity=".55" />
    <rect x="56" y="14" width="30" height="24" rx="5" stroke="currentColor" strokeWidth="1.5" opacity=".28" />
    <rect x="10" y="46" width="30" height="14" rx="5" stroke="currentColor" strokeWidth="1.5" opacity=".28" />
    <rect x="56" y="46" width="30" height="14" rx="5" stroke="currentColor" strokeWidth="1.5" opacity=".16" />
    {/* 中间缺的那一块 —— 「这里本来该有东西」 */}
    <path d="M46 26h4M48 24v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity=".7" />
  </svg>
);

const OfflineArt: React.FC = () => (
  <svg className="neox-plugin-art" viewBox="0 0 96 72" fill="none" aria-hidden="true">
    <path d="M24 44a14 14 0 0 1 3-27.7A18 18 0 0 1 62 20a12 12 0 0 1 8 24H30"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity=".45" />
    {/* 断开的那一刀 */}
    <path d="M30 56l36-36" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity=".75" />
  </svg>
);

/* ── 骨架 ──────────────────────────────────────────────────────────────── */

/** 单张骨架卡 —— 也给外部用: 已有内容时把它**接在真卡后面**表示"还在拉",
 *  而不是铺一整屏盖住已有的 (见 PluginMarketplace 里的用法)。 */
export const SkeletonCard: React.FC = () => (
  <div className="neox-plugin-skeleton" aria-hidden="true">
    <div className="neox-plugin-skeleton__head">
      <span className="neox-plugin-skeleton__logo" />
      <span className="neox-plugin-skeleton__title" />
    </div>
    <span className="neox-plugin-skeleton__line" />
    <span className="neox-plugin-skeleton__line is-short" />
  </div>
);

interface Props {
  loading: boolean;
  error: string | null;
  empty: boolean;
  /** 有搜索词时的空态说法不一样 —— 那是「没搜到」不是「没有」 */
  filtered?: boolean;
  isZh: boolean;
  onRetry: () => void;
}

export const CatalogState: React.FC<Props> = ({ loading, error, empty, filtered, isZh, onRetry }) => {
  if (loading) {
    return (
      <div className="neox-plugin-grid" aria-busy="true" aria-live="polite">
        {Array.from({ length: 6 }, (_, i) => <SkeletonCard key={i} />)}
      </div>
    );
  }

  if (error) {
    return (
      <div className="neox-plugin-state" role="status">
        <OfflineArt />
        <p className="neox-plugin-state__title">
          {isZh ? '暂时没有可用的插件' : 'No plugins available right now'}
        </p>
        <p className="neox-plugin-state__hint">
          {isZh
            ? '连不上插件市场。可能是网络断了，或者服务暂时不可用——已安装的插件不受影响。'
            : 'Can’t reach the plugin marketplace. Your installed plugins are unaffected.'}
        </p>
        <ol className="neox-plugin-state__steps">
          <li>{isZh ? '在 Neox 官网或插件作者那里下载 .neox-plugin 安装包' : 'Download the .neox-plugin package from the Neox website or the plugin’s author'}</li>
          <li>{isZh ? '点右上角「导入插件」, 选中这个包 (也可以选插件文件夹)' : 'Click Import plugin at the top right and pick the package (a plugin folder works too)'}</li>
          <li>{isZh ? '确认它要的权限, 装好就能在对话里用' : 'Review the permissions it asks for — then it’s ready in your chats'}</li>
        </ol>
        <button type="button" className="neox-plugins__btn is-ghost" onClick={onRetry}>
          {isZh ? '重试' : 'Retry'}
        </button>
        {/* 原始错误留给排查, 但不占主位 */}
        <p className="neox-plugin-state__detail">{error}</p>
      </div>
    );
  }

  if (empty) {
    return (
      <div className="neox-plugin-state" role="status">
        <EmptyArt />
        <p className="neox-plugin-state__title">
          {filtered
            ? (isZh ? '没有匹配的插件' : 'No matching plugins')
            : (isZh ? '暂时没有可用的插件' : 'No plugins available yet')}
        </p>
        <p className="neox-plugin-state__hint">
          {filtered
            ? (isZh ? '换个关键词，或清掉筛选看看全部。' : 'Try another keyword, or clear the filters.')
            : (isZh
              ? '市场还在上架中。你也可以点右上角导入本地的 .neox-plugin 包。'
              : 'The catalog is still filling up. You can also import a local .neox-plugin package.')}
        </p>
      </div>
    );
  }

  return null;
};
