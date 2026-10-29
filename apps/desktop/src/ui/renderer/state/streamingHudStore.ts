import { useSyncExternalStore } from 'react';

let tokens = 0;
const listeners = new Set<() => void>();

let pending: number | null = null;
let rafId = 0;

const scheduleFrame = (cb: () => void): number =>
  (typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(cb)
    : (setTimeout(cb, 16) as unknown as number));

function notify(): void {
  for (const l of listeners) {
    try { l(); } catch { /* 单个订阅者异常不影响其它 */ }
  }
}

function flushPending(): void {
  rafId = 0;
  if (pending === null) return;
  const next = pending;
  pending = null;
  if (Object.is(next, tokens)) return;
  tokens = next;
  notify();
}

export function setStreamingTokensHud(next: number | ((prev: number) => number)): void {
  const base = pending ?? tokens;
  const resolved = typeof next === 'function' ? (next as (p: number) => number)(base) : next;
  if (Object.is(resolved, base)) return;
  pending = resolved;
  /* 归零 = 新一轮开始 / 切会话, 必须同帧可见, 否则会看到上一轮的残留数字 */
  if (resolved === 0 || resolved < tokens) {
    flushPending();
    return;
  }
  if (rafId) return;
  rafId = scheduleFrame(flushPending);
}

export function getStreamingTokensHud(): number {
  return tokens;
}

export function subscribeStreamingTokensHud(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 叶子组件订阅 hook — 只让显示该数字的组件跟随 token 频率重渲染 */
export function useStreamingTokensHud(): number {
  return useSyncExternalStore(subscribeStreamingTokensHud, getStreamingTokensHud, getStreamingTokensHud);
}
