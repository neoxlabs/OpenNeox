/**
 * 渲染侧的插件 views 订阅.
 *
 * 从主进程拉取 views 列表 + 监听 views-changed 事件. 使用 useSyncExternalStore
 * 风格接口, 任何组件可通过 usePluginViews() 拿到最新 views.
 */

import type { PluginViewSummary } from '@neoxlabs/platform/shared/ipc/plugin.js';

type Listener = () => void;

const neox = (globalThis as any).window?.neox;

let cached: PluginViewSummary[] = [];
const listeners = new Set<Listener>();
let inflight: Promise<void> | null = null;
let unsubChange: (() => void) | null = null;

function emit(): void {
  for (const cb of listeners) {
    try { cb(); } catch { /* ignore */ }
  }
}

async function refresh(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      if (typeof neox?.pluginListViews === 'function') {
        const list = await neox.pluginListViews();
        if (Array.isArray(list)) {
          cached = list as PluginViewSummary[];
          emit();
        }
      }
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function ensureChangeSubscription(): void {
  if (unsubChange) return;
  if (typeof neox?.pluginOnViewsChanged === 'function') {
    unsubChange = neox.pluginOnViewsChanged((views: PluginViewSummary[]) => {
      cached = Array.isArray(views) ? views : [];
      emit();
    });
  }
}

export const pluginViewsStore = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    if (listeners.size === 1) {
      ensureChangeSubscription();
      refresh();
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && unsubChange) {
        unsubChange();
        unsubChange = null;
      }
    };
  },
  getSnapshot(): PluginViewSummary[] {
    return cached;
  },
  getServerSnapshot(): PluginViewSummary[] {
    return cached;
  },
  /** 手动强制刷新 (例如 install/enable 后) */
  refresh,
};
