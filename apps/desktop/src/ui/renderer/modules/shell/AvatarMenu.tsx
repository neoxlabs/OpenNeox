import React from 'react';
import { UiSlot } from './uiSlots';
import LocalShellActions from './LocalShellActions';

interface AvatarMenuProps {
  onOpenAccount?: () => void;
  onOpenSettings?: () => void;
  onShowWorkspacePanel?: () => void;
  /** 视觉变体 —— 决定按钮尺寸和菜单弹出方向。 */
  variant?: 'topbar' | 'rail';
}

/**
 * 折叠态图标栏底部的入口 —— 'iconrail.footer' 插槽的挂载点。
 *
 * 跟 SidebarAccountFooter 是同一件事的窄版: 公开构建只放本地入口, 带账号体系的
 * 发行版往插槽里注册自己的头像菜单 (edition/AccountRailMenu)。
 */
export const AvatarMenu: React.FC<AvatarMenuProps> = ({ onOpenAccount, onOpenSettings, onShowWorkspacePanel, variant = 'topbar' }) => (
  <UiSlot name="iconrail.footer" props={{ onOpenAccount, onOpenSettings, onShowWorkspacePanel, variant }}>
    <LocalShellActions
      onOpenSettings={onOpenSettings}
      onShowWorkspacePanel={onShowWorkspacePanel}
      layout={variant === 'rail' ? 'column' : 'row'}
    />
  </UiSlot>
);

export default AvatarMenu;
