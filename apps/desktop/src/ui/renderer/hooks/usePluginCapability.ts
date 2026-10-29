/**
 * usePluginCapability —— 装了 (并启用了) 声明某个能力的插件没有。
 *
 *   渲染端版本的「插件能力闸」: core 那边读 ~/.neox/plugins/registry.json 决定功能跑不跑,
 *   这里用同一份注册表 (plugin:list 读的就是它) 决定入口露不露 —— 两边判据一致,
 *   不会出现"设置页开着但功能没跑"或反过来。
 *
 *   返回 null = 还在查。调用方别把 null 当成"没装"去做重定向, 否则深链进来的页面
 *   会在列表回来之前被踢走。
 *
 *   插件页装/卸/启停后会派 PLUGINS_CHANGED_EVENT, 这里重查; 窗口回到前台也重查一次
 *   (用 CLI 装的插件也能跟上)。
 */
import { useEffect, useState } from 'react';

export const PLUGINS_CHANGED_EVENT = 'neox:plugins-changed';

/** 能力 → 它在设置页里的那一页。插件详情页据此给「打开设置」按钮。 */
export const SETTINGS_TAB_BY_CAPABILITY: Record<string, string> = {
  'github-pr-agent': 'github',
};

export function listDeclaresCapability(plugins: unknown, capability: string): boolean {
  if (!Array.isArray(plugins)) return false;
  return plugins.some((p) => {
    const e = p as { enabled?: boolean; manifest?: { capabilities?: unknown } };
    const caps = e?.manifest?.capabilities;
    return e?.enabled === true && Array.isArray(caps) && caps.includes(capability);
  });
}

export function usePluginCapability(capability: string): boolean | null {
  const [value, setValue] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const api = (window as unknown as { neox?: { pluginList?: () => Promise<{ plugins?: unknown }> } }).neox;
        if (typeof api?.pluginList !== 'function') { if (alive) setValue(false); return; }
        const r = await api.pluginList();
        if (alive) setValue(listDeclaresCapability(r?.plugins, capability));
      } catch {
        if (alive) setValue(false);
      }
    };
    void check();
    const onChange = () => { void check(); };
    window.addEventListener(PLUGINS_CHANGED_EVENT, onChange);
    window.addEventListener('focus', onChange);
    return () => {
      alive = false;
      window.removeEventListener(PLUGINS_CHANGED_EVENT, onChange);
      window.removeEventListener('focus', onChange);
    };
  }, [capability]);
  return value;
}
