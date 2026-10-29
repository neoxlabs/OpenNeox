/**
 * ToolWindow 类型定义
 *
 * 灵感来自 IntelliJ Platform 的 Tool Window 模型 —— sidebar / bottom panel
 * 上的可注册"面板"，每个 tool window 有 id、标题、图标、anchor 位置和
 * 一个组件实现。
 *
 * 跟 IDEA 的差异（极度简化）
 * --------------------------
 * - 不引入 ToolWindowFactory / ToolWindowAnchor enum / Stripe button 等
 * - 不引入 stateRestored / persistence —— 每次启动按 default 显示
 * - 不引入 multiple content (tabs within tool window)
 * - 不引入 floating / dockable —— 当前只支持固定 anchor
 *
 * 这一层故意做得**最小**，目标只是建立"sidebar 是注册的"这个抽象，
 * 让未来插件能注册自己的面板。step 7C 不消费它（不动现有 sidebar 渲染），
 * 只验证 API + 注册一个"Project" 占位 descriptor。
 *
 * 当后续 step 真正消费 registry 时，会增量补充：
 *   - useToolWindow(id) hook
 *   - <ToolWindowSlot anchor="left"> 渲染插槽组件
 *   - 状态：当前 anchor 的 active id、visibility 等
 */

import type { ComponentType } from 'react';
import { createServiceToken } from '../container/ServiceContainer.js';
import { createTopic } from '../bus/MessageBus.js';
import type { ServiceToken } from '../container/ServiceContainer.js';
import type { Topic } from '../bus/MessageBus.js';

/** Tool window 可以贴在哪一边 */
export type ToolWindowAnchor = 'left' | 'right' | 'bottom';

/**
 * 注册一个 tool window 的描述符。
 *
 * `component` 是 React 组件，渲染时会被 ToolWindowSlot 实例化。
 * 当前阶段不规定 props —— 实际渲染时会传 IDE 平台层注入的 context
 * (workspace path 等)，具体接口在后续 step 消费 registry 时定义。
 */
export interface ToolWindowDescriptor {
  /** 全局唯一 id，约定 'category.name'，例如 'project'、'find'、'terminal'、'plugin.myPanel' */
  id: string;
  /** 显示名（标题栏 + tooltip） */
  title: string;
  /** 锚点位置 */
  anchor: ToolWindowAnchor;
  /**
   * 图标。当前用 string（图标名）让消费者自己映射到 React 节点 ——
   * 避免在 ide 包里依赖 React。后续如果需要更灵活，可以改成 `string | ComponentType`。
   */
  icon?: string;
  /** 渲染主体 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: ComponentType<any>;
  /**
   * 默认是否在该 anchor 中可见。
   * - true → 应用启动时该面板就显示
   * - false → 隐藏，用户点 stripe button 切换
   * 同 anchor 多个 default-visible 时由消费者决定（通常取注册顺序最后一个）
   */
  defaultVisible?: boolean;
  /**
   * 顺序权重，越小越靠前。同 anchor 内排序用。默认 100。
   */
  order?: number;
  /**
   * 可选的"是否可用"判定。返回 false 时这个 tool window 不出现在 stripe
   * 上。例如 "Debug" 只在有 debug session 时显示。当前阶段未消费。
   */
  isAvailable?: () => boolean;
}

/**
 * Registry 在 MessageBus 上发布的事件 —— 让监听 sidebar 渲染的组件
 * 能够在注册 / 反注册时刷新。
 */
export interface ToolWindowEvents {
  onRegistered(descriptor: ToolWindowDescriptor): void;
  onUnregistered(id: string): void;
}

export const TOOL_WINDOWS_TOPIC: Topic<ToolWindowEvents> =
  createTopic<ToolWindowEvents>('toolWindows');

/**
 * ToolWindowRegistry 在 ServiceContainer 中的 token。
 * 作用域 = 'app'：tool window 注册跨 workspace 共享。
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
export const TOOL_WINDOW_REGISTRY: ServiceToken<
  import('./ToolWindowRegistry.js').ToolWindowRegistry
> = createServiceToken('toolWindows', 'app');
