/**
 * ipcHealthStore — Renderer 侧 IPC 通路健康状态 (Phase E).
 *
 * 数据源: 主进程每 15s 广播 'neox:heartbeat' event.
 *   Renderer 收到就更新 lastHeartbeatAtMs; 45s 无 heartbeat → unhealthy.
 *   配合 useStreamHandler 里的 STALE_WATCHDOG (stream 120s 无 event) 做双重检测:
 *     · heartbeat 挂 = 主进程死 / IPC 通路断
 *     · stream stall = 主进程活但上游 (LLM / provider) 卡了
 *   两条并存; 健康翻转只打 console，不弹 toast（避免误报刷屏）.
 *
 * 用法: const { healthy, lastHeartbeatAtMs, msSinceLast } = useIpcHealth()
 */

import { useSyncExternalStore } from 'react';

export interface IpcHealth {
  /** true = 30s 内收到过 heartbeat; false = 通路挂了 */
  healthy: boolean;
  /** 最近一次收到 heartbeat 的时间戳 (ms epoch), null 表示从未收到 (启动初期 / preload 未挂) */
  lastHeartbeatAtMs: number | null;
  /** 距最近 heartbeat 已过多久 (ms). lastHeartbeatAtMs 为 null 时 = Infinity */
  msSinceLast: number;
}

const UNHEALTHY_THRESHOLD_MS = 45_000;

let lastHeartbeatAtMs: number | null = null;
const listeners = new Set<() => void>();
let subscribed = false;
let tickInterval: number | null = null;

// getSnapshot 必须 stable ref — 复用同一个 IpcHealth 对象直到状态实际变化,
// 避免 useSyncExternalStore 每次调用创建新对象引发无限 rerender.
let cachedSnapshot: IpcHealth = { healthy: false, lastHeartbeatAtMs: null, msSinceLast: Infinity };

function recomputeSnapshot(): IpcHealth {
  const now = Date.now();
  const ms = lastHeartbeatAtMs == null ? Infinity : now - lastHeartbeatAtMs;
  const healthy = ms < UNHEALTHY_THRESHOLD_MS;
  // 只在实际变化时新建对象; 否则返回旧引用.
  if (
    cachedSnapshot.healthy === healthy &&
    cachedSnapshot.lastHeartbeatAtMs === lastHeartbeatAtMs &&
    Math.abs(cachedSnapshot.msSinceLast - ms) < 500
  ) {
    return cachedSnapshot;
  }
  cachedSnapshot = { healthy, lastHeartbeatAtMs, msSinceLast: ms };
  return cachedSnapshot;
}

/* 健康翻转只打 console — 不再弹 toast。
 *   开发时主进程偶发卡住 / HMR / 重活会误触发 30s 阈值，"IPC 通路已恢复" 刷屏无意义。
 *   useIpcHealth() 仍可供内部状态使用。 */
let lastLoggedHealthy: boolean | null = null;
function logHealthTransitionIfNeeded(now: IpcHealth): void {
  if (lastLoggedHealthy === now.healthy) return;
  const wasEverTracked = lastLoggedHealthy !== null;
  lastLoggedHealthy = now.healthy;
  if (!wasEverTracked && now.lastHeartbeatAtMs == null) return;
  if (!now.healthy) {
    console.warn('[ipc-health] heartbeat stale', { msSinceLast: now.msSinceLast });
  } else if (wasEverTracked) {
    console.info('[ipc-health] heartbeat restored', { msSinceLast: now.msSinceLast });
  }
}

function emit(): void {
  cachedSnapshot = recomputeSnapshot();
  logHealthTransitionIfNeeded(cachedSnapshot);
  listeners.forEach(fn => {
    try { fn(); } catch { /* noop */ }
  });
}

function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  try {
    const api = (window as any).neox;
    if (typeof api?.onHeartbeat === 'function') {
      api.onHeartbeat((payload: { atMs?: number } | undefined) => {
        lastHeartbeatAtMs = typeof payload?.atMs === 'number' ? payload.atMs : Date.now();
        emit();
      });
    }
  } catch (err: any) {
    console.warn('[ipc-health] preload onHeartbeat unavailable:', err?.message);
  }
  /* 每 5s 触发一次 recompute — 让 msSinceLast 持续递增 + 跨过 30s 阈值时立刻 flip 到 unhealthy,
   *   不用等下一个 heartbeat 才 detect. 这个 tick 只 emit-if-changed, 无过度 rerender. */
  if (tickInterval == null && typeof window !== 'undefined') {
    tickInterval = window.setInterval(() => emit(), 5_000);
  }
}

function subscribe(fn: () => void): () => void {
  ensureSubscribed();
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function getSnapshot(): IpcHealth {
  return cachedSnapshot;
}

export function useIpcHealth(): IpcHealth {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** 测试 / 调试用: 手动重置 heartbeat 时间戳. */
export function _resetIpcHealthForTest(): void {
  lastHeartbeatAtMs = null;
  cachedSnapshot = { healthy: false, lastHeartbeatAtMs: null, msSinceLast: Infinity };
  emit();
}

/* 模块加载时自动 subscribe 一次 — 不用等 UI 组件 useIpcHealth() 才启动检测.
 *   这样心跳 / degrade 通知从 renderer 启动就一直在跑, 用户下第一秒就有保护. */
if (typeof window !== 'undefined') {
  ensureSubscribed();
}
