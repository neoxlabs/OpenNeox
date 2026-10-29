/**
 * useToolWindows —— React 接入 ToolWindowRegistry 的标准 hook。
 *
 * 提供两个 hook：
 *
 * 1. **useToolWindowsByAnchor(anchor)**：拿某一侧（'left' / 'right' / 'bottom'）
 *    所有当前注册的 tool window 描述符列表，按 order 排序。当注册 / 反注册
 *    发生时，hook 会自动重新订阅 TOOL_WINDOWS_TOPIC 并刷新返回值。
 *
 * 2. **useToolWindowRegistry()**：直接拿 registry 实例（用于命令式操作，
 *    例如插件初始化时调 register / registerAll）。
 *
 * 设计原则
 * --------
 * - 状态来自 ToolWindowRegistry，hook 只是 readonly view
 * - 用 useState + 订阅 TOOL_WINDOWS_TOPIC 刷新，保证插件运行时注册 / 卸载
 *   能立即在 UI 上反映
 * - registry 本身是稳定的（来自 ServiceContainer），useService 不会换实例
 */

import { useEffect, useState } from 'react';
import {
  TOOL_WINDOW_REGISTRY,
  TOOL_WINDOWS_TOPIC,
  type ToolWindowAnchor,
  type ToolWindowDescriptor,
  type ToolWindowRegistry,
} from '../../../ide/index.js';
import { useService } from './useService.js';
import { useTopicSubscription } from './useTopicSubscription.js';

/** 直接拿 registry 实例 */
export function useToolWindowRegistry(): ToolWindowRegistry {
  return useService(TOOL_WINDOW_REGISTRY);
}

/**
 * 拿某一 anchor 上的所有 tool window 描述符（按 order 升序）。
 *
 * - 初始化：从 registry 同步拿 byAnchor 结果
 * - 后续：订阅 TOOL_WINDOWS_TOPIC 的 onRegistered / onUnregistered，
 *   收到事件时重新拉一次 byAnchor 并 setState
 *
 * 返回的数组引用在没有变化时保持稳定（用 setState 的 functional 更新检测）。
 */
export function useToolWindowsByAnchor(anchor: ToolWindowAnchor): ToolWindowDescriptor[] {
  const registry = useToolWindowRegistry();
  const [items, setItems] = useState<ToolWindowDescriptor[]>(() => registry.byAnchor(anchor));

  // 锚点变化时立即重算
  useEffect(() => {
    setItems(registry.byAnchor(anchor));
  }, [registry, anchor]);

  // 订阅 register / unregister 事件，刷新对应 anchor 的列表
  useTopicSubscription(TOOL_WINDOWS_TOPIC, {
    onRegistered: (descriptor) => {
      if (descriptor.anchor !== anchor) return;
      setItems(registry.byAnchor(anchor));
    },
    onUnregistered: () => {
      // 不知道被卸的是哪个 anchor，无脑重算 —— 开销可忽略（map iteration）
      setItems(registry.byAnchor(anchor));
    },
  });

  return items;
}
