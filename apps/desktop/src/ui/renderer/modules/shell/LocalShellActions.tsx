import React from 'react';
import { IconCog } from './shellIcons';
import { useI18n } from '../../hooks/useI18n';
import './shell-local-actions.css';

interface Props {
  onOpenSettings?: () => void;
  onShowWorkspacePanel?: () => void;
  /** 'rail' 时收窄成一列, 供折叠态图标栏使用。 */
  layout?: 'row' | 'column';
}

/** 项目列表 — 两片叠起来的文件夹 (跟侧栏「项目」组头同语义, line-style 对齐 shellIcons) */
const IconFolders: React.FC<{ size?: number }> = ({ size = 15 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 8V6.5A1.5 1.5 0 0 1 5.5 5h3l1.6 2H15" opacity="0.5" />
    <path d="M3 11.5A1.5 1.5 0 0 1 4.5 10h4l1.6 2h9.4a1.5 1.5 0 0 1 1.5 1.5V18a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18Z" />
  </svg>
);

/**
 * 侧栏底缘 / 图标栏底部的本地入口行 —— 公开构建在这两处的默认内容。
 *
 * 这里是"安静区": 平时不抢眼, 但永远在同一个位置找得到, 所以不堆成第二个导航区
 * 跟上面的会话列表打架。
 *
 * 排布是 **左一个带文字的主入口 + 右端一个齿轮**, 两头各占一边。这不是随手排的:
 * 侧栏底缘是个跨发行版的固定位置, 装了账号体系的发行版在左边放账户行, 齿轮同样
 * 落在最右, 两种构建的设置键因此永远在同一个角上。全都挤在左端的话, 右边留出的
 * 整条空白会让这两个灰图标读起来像装饰点而不是按钮 —— 找不到设置就是这么来的。
 *
 * 主入口给文字、齿轮只给图标, 是因为齿轮本身已是全平台通识的符号, 再配字反而会让
 * 这一行的份量压过上面真正的导航。
 *
 * 这一行同时是设置的唯一常驻入口, 所以它不跟着会话类型做条件渲染 —— 切到别的段
 * 就把唯一入口收走, 会让人以为软件坏了。
 */
export const LocalShellActions: React.FC<Props> = ({ onOpenSettings, onShowWorkspacePanel, layout = 'row' }) => {
  /* 折叠成图标栏时只剩一列窄格, 放不下文字, 两个入口都退回纯图标。 */
  const isColumn = layout === 'column';
  const { language } = useI18n();
  /* 叫"全部项目"而不是"项目": 侧栏上面已经有一个「项目」分组头列着项目本身,
   * 同屏两个「项目」会让人以为点了会跳到同一处。这个键开的是工作区总览面板。 */
  const projectsLabel = language === 'zh' ? '全部项目' : 'All projects';
  const settingsLabel = language === 'zh' ? '设置' : 'Settings';
  return (
    <div className={`neox-shell-local-actions${isColumn ? ' is-column' : ''}`}>
      {/* 两个 onClick 都包了一层箭头函数, 不能直接把回调传进去: onShowWorkspacePanel
          的第一个参数是"要打开哪个工作区", 直接当 onClick 用, React 会把鼠标事件塞进
          那个位置, 下游按路径字符串 split 就崩在渲染里。 */}
      {onShowWorkspacePanel && (
        <button
          type="button"
          className={`neox-shell-local-action${isColumn ? '' : ' is-labelled'}`}
          onClick={() => onShowWorkspacePanel()}
          aria-label={projectsLabel}
          title={projectsLabel}
        >
          <IconFolders />
          {!isColumn && <span className="neox-shell-local-action__label">{projectsLabel}</span>}
        </button>
      )}
      {onOpenSettings && (
        <button
          type="button"
          className={`neox-shell-local-action${isColumn ? '' : ' is-trailing'}`}
          onClick={() => onOpenSettings()}
          aria-label={settingsLabel}
          title={settingsLabel}
        >
          <IconCog />
        </button>
      )}
    </div>
  );
};

export default LocalShellActions;
