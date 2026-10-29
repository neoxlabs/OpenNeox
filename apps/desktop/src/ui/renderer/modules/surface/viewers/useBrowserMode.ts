/**
 * useBrowserMode — 拿当前 desktop 决定的浏览器模式.
 *
 *   'external' — 走外置 Chrome + CDP. WebSurfaceViewer 不 mount BrowserView, 只显控制卡片.
 *   'embedded' — 老路径, 内嵌 BrowserView.
 *   'loading'  — 主进程还没答, UI 显骨架避免闪 (通常 <10ms).
 *
 * 主进程决定的字段, per Neox 冷启一次不会变, 缓存到模块级 promise 复用.
 */

import { useEffect, useState } from 'react';

type BrowserMode = 'external' | 'embedded';
type BrowserModeState = BrowserMode | 'loading';

let cache: Promise<BrowserMode> | null = null;

async function fetchMode(): Promise<BrowserMode> {
  const api = (window as any).neox;
  if (!api?.browserModeGet) return 'external';
  try {
    const r = await api.browserModeGet();
    return r?.mode === 'embedded' ? 'embedded' : 'external';
  } catch {
    return 'external';
  }
}

export function useBrowserMode(): BrowserModeState {
  const [mode, setMode] = useState<BrowserModeState>('loading');
  useEffect(() => {
    let alive = true;
    if (!cache) cache = fetchMode();
    cache.then(m => { if (alive) setMode(m); });
    return () => { alive = false; };
  }, []);
  return mode;
}

/** 同步查 — 已缓存时立即返, 未缓存返 'loading' (调用方可以自己 fallback). */
export function readBrowserModeSync(): BrowserModeState {
  if (!cache) return 'loading';
  /* Promise 已 resolve 时 .then 拿不到同步值, 用简单的 shortcut: mount effect + cache 已经足够 */
  return 'loading';
}
