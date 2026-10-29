/**
 * ToolWindowSlot —— 把某一 anchor（'left' / 'right' / 'bottom'）注册的
 * tool window 渲染出来的 React 插槽。
 *
 * 当前阶段简化策略
 * ----------------
 * - 只渲染该 anchor 下的"第一个"描述符（按 order 升序）
 * - 不实现 stripe button / 多 tool window 切换 / visibility 持久化等
 *   IDEA Tool Window 的高级功能 —— 当只有一个 panel 时这些都用不上
 * - 后续如果同 anchor 出现 2+ panel，再扩展为：内部维护 activeId state +
 *   暴露 stripe 按钮组 + 用 useToolWindowVisibility() hook 持久化
 *
 * 用法
 * ----
 * ```tsx
 * <ToolWindowSlot anchor="left" />
 * ```
 *
 * 渲染时把 descriptor.component 实例化（无 props）。tool window 组件应该
 * 通过 React Context 拉自己需要的业务数据，避免 ToolWindowDescriptor 接口
 * 跟具体 panel 耦合（这是 IDEA 的"DataContext"模式的简化版）。
 */

import type { FC } from 'react';
import type { ToolWindowAnchor } from '../../../ide/index.js';
import { useToolWindowsByAnchor } from './useToolWindows.js';

export interface ToolWindowSlotProps {
  anchor: ToolWindowAnchor;
  /** 没有任何注册的 tool window 时显示的 fallback */
  fallback?: React.ReactNode;
}

export const ToolWindowSlot: FC<ToolWindowSlotProps> = ({ anchor, fallback = null }) => {
  const items = useToolWindowsByAnchor(anchor);
  if (items.length === 0) return <>{fallback}</>;
  // 当前简化：只渲染第一个。后续 step 加切换。
  const Component = items[0].component;
  return <Component />;
};
