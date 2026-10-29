import { useEffect, useState } from 'react';
import { pluginLogoUrl } from '../../pages/plugins/pluginBrandAssets';
import { remoteIconUrl } from '../../pages/plugins/pluginListing';

const cache = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();

function loadListingIcon(name: string): Promise<string | null> {
  let p = pending.get(name);
  if (!p) {
    p = (async () => {
      /* 本机的 pluginInfo 不带 manifest, 图标只在市场记录里 (跟插件详情页同一个来源);
       * 本地导入、市场上没有的插件查不到 → null, 调用方退回 emoji */
      const api = (window as any).neox;
      const d = await api?.pluginDetail?.(name).catch(() => null);
      const url = remoteIconUrl(d) ?? null;
      cache.set(name, url);
      return url;
    })();
    pending.set(name, p);
  }
  return p;
}

export function usePluginViewIcon(pluginName: string | undefined): string | undefined {
  const bundled = pluginLogoUrl(pluginName);
  const [remote, setRemote] = useState<string | null | undefined>(() => (pluginName ? cache.get(pluginName) : null));
  useEffect(() => {
    if (bundled || !pluginName) return;
    if (cache.has(pluginName)) { setRemote(cache.get(pluginName)); return; }
    let alive = true;
    void loadListingIcon(pluginName).then((u) => { if (alive) setRemote(u); });
    return () => { alive = false; };
  }, [bundled, pluginName]);
  return bundled ?? remote ?? undefined;
}
