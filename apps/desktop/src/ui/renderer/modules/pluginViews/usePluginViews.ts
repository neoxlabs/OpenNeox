import { useSyncExternalStore } from 'react';
import { pluginViewsStore } from './pluginViewsStore.js';
import type { PluginViewSummary } from '@neoxlabs/platform/shared/ipc/plugin.js';

/**
 * 拿到当前所有注册的插件 views. 自动订阅 views-changed, 插件安装/卸载时更新.
 *
 * 用法:
 *   const sidebarViews = usePluginViews().filter(v => v.location === 'sidebar');
 */
export function usePluginViews(): PluginViewSummary[] {
  return useSyncExternalStore(
    pluginViewsStore.subscribe,
    pluginViewsStore.getSnapshot,
    pluginViewsStore.getServerSnapshot,
  );
}
