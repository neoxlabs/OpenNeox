
/* ============================================================
 * Sidebar view + 标记 (pin / archive)
 *   - 后端 Session 还没 pinned/archived 字段, 前端 localStorage 自管. 后端补 schema 后再迁.
 *   - view 切换: 最近 (排除已归档) / 收藏 (pinned) / 归档 (archived).
 * ============================================================ */
export type SessionView = 'recent' | 'pinned' | 'archived';
export const VIEW_LABELS = {
  zh: { recent: '最近任务', pinned: '收藏', archived: '归档' },
  en: { recent: 'Recent', pinned: 'Pinned', archived: 'Archived' },
} as const;
export const SB_PINNED_KEY = 'neox-sidebar-pinned';
export const SB_ARCHIVED_KEY = 'neox-sidebar-archived';
export const SB_SEEN_IMAGE_KEY = 'neox-sidebar-seen-images';
export const SETTINGS_INITIAL_TAB_KEY = 'neox-settings-initial-tab';

export function loadIdSet(key: string): Set<string> {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(key) : null;
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr.filter((x): x is string => typeof x === 'string')) : new Set();
  } catch { return new Set(); }
}
export function saveIdSet(key: string, s: Set<string>): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(key, JSON.stringify([...s]));
  } catch { /* ignore */ }
}

/* workspace 自定义顺序 — 用户拖动后的 path 序. 没拖过的 path 走 latestActivity 兜底.
 *   localStorage 跨重启持久, 跨 Sidebar 实例共享 (跟 rank cache 同款架构). */
const SB_WS_ORDER_KEY = 'neox-sidebar-workspace-order-v1';
export function loadWsOrder(): string[] {
  try {
    if (typeof window === 'undefined') return [];
    const raw = window.localStorage.getItem(SB_WS_ORDER_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}
export function saveWsOrder(order: string[]): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(SB_WS_ORDER_KEY, JSON.stringify(order));
  } catch { /* ignore */ }
}
