/**
 * terminalKeepalivePool — 虚拟窗口外的 xterm 实例停泊, 避免进出 overscan 冷启动.
 *
 * 离开视口: 从 DOM 卸下 element, 不 dispose.
 * 再进入: append 回容器 + fit, 跳过 new Terminal / 字体 / prompt 重建.
 * 超上限 LRU dispose.
 */

export type ParkedTerminal = {
  toolId: string;
  terminal: any;
  fitAddon: any;
  element: HTMLElement;
  lastUsed: number;
};

const MAX_PARKED = 10;
const pool = new Map<string, ParkedTerminal>();
const order: string[] = [];

function touch(toolId: string): void {
  const i = order.indexOf(toolId);
  if (i >= 0) order.splice(i, 1);
  order.push(toolId);
}

function evictIfNeeded(): void {
  while (pool.size >= MAX_PARKED && order.length > 0) {
    const oldest = order.shift()!;
    const parked = pool.get(oldest);
    if (!parked) continue;
    pool.delete(oldest);
    try { parked.terminal.dispose(); } catch { /* ignore */ }
  }
}

/** 停泊成功返回 true (调用方勿再 dispose). */
export function parkTerminal(
  toolId: string | undefined,
  terminal: any,
  fitAddon: any,
): boolean {
  if (!toolId || !terminal) return false;
  const el = terminal.element as HTMLElement | undefined | null;
  if (!el) return false;
  try {
    if (el.parentElement) el.parentElement.removeChild(el);
  } catch {
    return false;
  }
  /* 同 toolId 旧实例先扔 */
  const prev = pool.get(toolId);
  if (prev) {
    pool.delete(toolId);
    try { prev.terminal.dispose(); } catch { /* ignore */ }
  }
  evictIfNeeded();
  pool.set(toolId, {
    toolId,
    terminal,
    fitAddon,
    element: el,
    lastUsed: Date.now(),
  });
  touch(toolId);
  return true;
}

export function takeParkedTerminal(toolId: string | undefined): ParkedTerminal | null {
  if (!toolId) return null;
  const parked = pool.get(toolId);
  if (!parked) return null;
  pool.delete(toolId);
  const i = order.indexOf(toolId);
  if (i >= 0) order.splice(i, 1);
  parked.lastUsed = Date.now();
  return parked;
}

/** 测试 / session 切换清理 */
export function clearTerminalKeepalivePool(): void {
  for (const p of pool.values()) {
    try { p.terminal.dispose(); } catch { /* ignore */ }
  }
  pool.clear();
  order.length = 0;
}

export function parkedTerminalCount(): number {
  return pool.size;
}
