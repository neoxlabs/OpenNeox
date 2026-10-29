/**
 * computer use 会话中断 —— 叠加层「停止」和 agent abort 共用这一条。
 *
 * 为什么单独一份, 不复用 ctx.signal:
 *   叠加层在 Electron 主进程, 工具跑在 worker。ctx.signal 是这一轮 agent 的,
 *   但「停止操控」必须立刻掐掉正在飞的 dump / expectChange 轮询, 不能等
 *   abort 穿过整条 agent 循环才轮到 computer_run 看到。
 *
 * abort() 只把**当前** controller 标 aborted, 下一轮 beginComputerSession()
 * 会换新的 —— 否则停完之后的下一次 computer_run 一进来就是 aborted。
 */

import { EventEmitter } from 'node:events';

const bus = new EventEmitter();
bus.setMaxListeners(20);

let current = new AbortController();

export function beginComputerSession(): AbortSignal {
  if (current.signal.aborted) current = new AbortController();
  return current.signal;
}

export function computerAbortSignal(): AbortSignal {
  return current.signal;
}

export function abortComputerSession(): void {
  if (!current.signal.aborted) {
    try { current.abort(); } catch { /* ignore */ }
  }
  bus.emit('abort');
}

export function onComputerAbort(cb: () => void): () => void {
  bus.on('abort', cb);
  return () => { bus.off('abort', cb); };
}

export function mergeAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const live = signals.filter((s): s is AbortSignal => !!s);
  if (live.length === 0) return undefined;
  if (live.length === 1) return live[0];
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') return anyFn(live);
  const merged = new AbortController();
  for (const s of live) {
    if (s.aborted) {
      merged.abort();
      break;
    }
    s.addEventListener('abort', () => merged.abort(), { once: true });
  }
  return merged.signal;
}
