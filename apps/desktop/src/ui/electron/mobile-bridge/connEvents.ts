/**
 * 手机连接的开 / 关订阅与「最近打开的那台」挑选 —— Pilot 来电用 (从 wsServer.ts 拆出, 那边到了文件大小闸上限)。
 */

/* 断开: 正在手机上通话的那通电话要跟着结束, 不然电脑以为还在打, 再也打不进来。
 * 连上: 推送把被杀的 App 叫醒后, 正在响的来电要补发给它; 延后一拍, 连接刚登记时手机那头的订阅可能还没挂好。 */
export class ConnEvents<C> {
  private closed = new Set<() => void>();
  private opened = new Set<(conn: C) => void>();

  onClosed(fn: () => void): () => void {
    this.closed.add(fn);
    return () => { this.closed.delete(fn); };
  }

  onOpened(fn: (conn: C) => void): () => void {
    this.opened.add(fn);
    return () => { this.opened.delete(fn); };
  }

  emitClosed(): void {
    for (const fn of this.closed) {
      try { fn(); } catch { /* 订阅方自己的错不影响连接管理 */ }
    }
  }

  emitOpened(conn: C): void {
    setTimeout(() => {
      for (const fn of this.opened) {
        try { fn(conn); } catch { /* 同上 */ }
      }
    }, 800);
  }
}

interface PresenceConn {
  isOpen(): boolean;
  foreground?: boolean;
  foregroundAt?: number;
}

export function pickMostRecentConn<C extends PresenceConn>(conns: Iterable<C>): C | null {
  let best: C | null = null;
  for (const c of conns) {
    if (!c.isOpen()) continue;
    /* 后遍历到的 = 后连上的, 前两项打平时它赢 (>=) */
    const fg = Number(c.foreground === true);
    const bestFg = Number(best?.foreground === true);
    if (!best || fg > bestFg || (fg === bestFg && (c.foregroundAt ?? 0) >= (best.foregroundAt ?? 0))) {
      best = c;
    }
  }
  return best;
}
