/* ============================================================
 * SidebarAccountFooter — 侧栏底缘那一行的**挂载点**
 *
 * 本文件只负责"这一行在哪、能拿到哪些回调", 具体画什么由插槽决定:
 *   · 公开构建 (无账号体系) 落到 LocalShellActions —— 全部项目 + 设置;
 *   · 带账号体系的发行版在 editionSlots.ts 注册自己的账户行 (头像 + 用户名 + 额度)。
 *
 * 为什么做成插槽而不是在这里写 if:
 *   两个发行版共用同一份外壳, 如果账户行直接写在本文件里, 公开构建就得把 auth /
 *   billing 的 import 全部摘掉 —— 于是每次两边合代码, 这个文件都要人工重挑一遍。
 *   挂载点、props 契约、兜底实现三者共用之后, 发行版差异只剩注册入口一个文件。
 *
 * 账户行的排版约定 (两个发行版都遵守, 否则设置键会跑到不同角落):
 *   侧栏底缘是"安静区", 一行放完, 不堆成第二个导航区; 左端是主入口, 齿轮永远在最右。
 * ============================================================ */
import React from 'react';
import { UiSlot } from './uiSlots';
import LocalShellActions from './LocalShellActions';

interface Props {
  /** 跳账户页 (设置页 account tab)。公开构建没有账户概念, 本地兜底忽略它。 */
  onOpenAccount?: () => void;
  /** 打开设置页 */
  onOpenSettings?: () => void;
  /** 打开「全部项目」工作区面板 */
  onShowWorkspacePanel?: () => void;
}

export const SidebarAccountFooter: React.FC<Props> = ({ onOpenAccount, onOpenSettings, onShowWorkspacePanel }) => (
  <UiSlot name="sidebar.footer" props={{ onOpenAccount, onOpenSettings, onShowWorkspacePanel }}>
    <LocalShellActions onOpenSettings={onOpenSettings} onShowWorkspacePanel={onShowWorkspacePanel} />
  </UiSlot>
);

export default SidebarAccountFooter;
