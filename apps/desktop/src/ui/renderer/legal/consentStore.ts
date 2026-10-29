/**
 * 法律同意状态 (D1) — 客户端持久化 + 版本比对.
 *
 *   localStorage key: 'neox_legal_consent_version'
 *   值 = 用户最后一次同意时的 LEGAL_VERSION 字符串.
 *   未存 / 跟当前 LEGAL_VERSION 不一致 → ConsentModal 强制弹窗.
 *
 *   注: 这只是 UI 层 gate. 服务端不依赖此状态决定授权 — 用户用 BYO 模式可
 *   不登录, 但仍必须先同意一次本地法律条款.
 */
import { useSyncExternalStore } from 'react';
import { LEGAL_VERSION } from './policies';

const STORAGE_KEY = 'neox_legal_consent_version';
/** 监听同 window 的 set/clear; 跨 window 走 storage event */
const listeners = new Set<() => void>();

function readVersion(): string | null {
  if (typeof window === 'undefined') return null;
  try { return window.localStorage.getItem(STORAGE_KEY); }
  catch { return null; }
}

function writeVersion(version: string): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(STORAGE_KEY, version); }
  catch { /* incognito / quota — 接受失败时 fall through, 下次启动再弹 */ }
  for (const fn of listeners) {
    try { fn(); } catch { /* listener 异常不影响其他订阅者 */ }
  }
}

export function getConsentedVersion(): string | null {
  return readVersion();
}

/** true = 当前 LEGAL_VERSION 已被用户同意过, 不需要弹 */
export function hasConsentedCurrentVersion(): boolean {
  return readVersion() === LEGAL_VERSION;
}

/** 用户接受当前版本 — ConsentModal 点"接受继续"时调 */
export function recordConsent(): void {
  writeVersion(LEGAL_VERSION);
}

/** dev/测试用 — 清状态强制下次启动重弹 */
export function clearConsent(): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  for (const fn of listeners) {
    try { fn(); } catch { /* ignore */ }
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  /* 跨 window/tab: storage event 自动同步 */
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY || e.key === null) cb();
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage);
  }
  return () => {
    listeners.delete(cb);
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', onStorage);
    }
  };
}

/** React hook: 当前是否需要弹同意 modal. 内置 LEGAL_VERSION 比对.
 *   loading=true 在 SSR/初次渲染时短暂出现, 用于避免闪一下 modal 又消失.
 *   桌面 Electron 一般 readVersion 是同步的, loading 几乎瞬时. */
export function useConsentNeeded(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => readVersion() !== LEGAL_VERSION,
    () => true,           /* SSR fallback: 假设需要 — 客户端 hydration 后立刻 settle */
  );
}
