
/** 与 @parcel/watcher 的 Event 同形 (这里不引它的类型, 免得基建层依赖原生包) */
export interface HostedWatchEvent {
  path: string;
  type: 'create' | 'update' | 'delete';
}

export type HostedWatchCallback = (err: Error | null, events: HostedWatchEvent[]) => unknown;

export type ParcelSubscribe = (
  dir: string,
  fn: HostedWatchCallback,
  opts?: { ignore?: string[] },
) => Promise<{ unsubscribe(): Promise<void> }>;

export type HostedWatchToHost =
  | { type: 'fsw-sub'; id: number; dir: string; ignore: string[] }
  | { type: 'fsw-unsub'; id: number };

export type HostedWatchToWorker =
  | { type: 'fsw-ready'; id: number }
  | { type: 'fsw-failed'; id: number; error: string }
  | { type: 'fsw-events'; id: number; events: HostedWatchEvent[] }
  | { type: 'fsw-error'; id: number; error: string };

function isHostedWatchToHost(msg: unknown): msg is HostedWatchToHost {
  const t = (msg as { type?: unknown } | null)?.type;
  return t === 'fsw-sub' || t === 'fsw-unsub';
}

function isHostedWatchToWorker(msg: unknown): msg is HostedWatchToWorker {
  const t = (msg as { type?: unknown } | null)?.type;
  return t === 'fsw-ready' || t === 'fsw-failed' || t === 'fsw-events' || t === 'fsw-error';
}

/* ── worker 一侧 ───────────────────────────────────────────────────────────── */

export interface HostedWatcherClient {
  subscribe: ParcelSubscribe;
  /** 收到主线程消息时调; 是本协议的消息返回 true。 */
  handle(msg: unknown): boolean;
}

export function createHostedWatcherClient(post: (msg: HostedWatchToHost) => void): HostedWatcherClient {
  let seq = 0;
  const callbacks = new Map<number, HostedWatchCallback>();
  const pendingReady = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();

  return {
    subscribe(dir, fn, opts) {
      const id = ++seq;
      callbacks.set(id, fn);
      return new Promise((resolve, reject) => {
        pendingReady.set(id, {
          resolve: () => resolve({
            unsubscribe: async () => {
              if (!callbacks.delete(id)) return;
              try { post({ type: 'fsw-unsub', id }); } catch { /* 主线程已断, 它那边会随 worker 退出一并清掉 */ }
            },
          }),
          reject,
        });
        try {
          post({ type: 'fsw-sub', id, dir, ignore: opts?.ignore ?? [] });
        } catch (err) {
          callbacks.delete(id);
          pendingReady.delete(id);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
    handle(msg) {
      if (!isHostedWatchToWorker(msg)) return false;
      switch (msg.type) {
        case 'fsw-ready': {
          const p = pendingReady.get(msg.id);
          pendingReady.delete(msg.id);
          p?.resolve();
          break;
        }
        case 'fsw-failed': {
          const p = pendingReady.get(msg.id);
          pendingReady.delete(msg.id);
          callbacks.delete(msg.id);
          p?.reject(new Error(msg.error));
          break;
        }
        case 'fsw-events':
          callbacks.get(msg.id)?.(null, msg.events);
          break;
        case 'fsw-error':
          callbacks.get(msg.id)?.(new Error(msg.error), []);
          break;
      }
      return true;
    },
  };
}

/* ── 主线程一侧 ────────────────────────────────────────────────────────────── */

export interface HostedWatcherHost {
  /** 收到 worker 消息时调; 是本协议的消息返回 true。 */
  handle(msg: unknown): boolean;
  /** worker 退出 / 被回收时调: 退掉它名下的全部订阅。 */
  dispose(): void;
}

export function createHostedWatcherHost(
  post: (msg: HostedWatchToWorker) => void,
  loadWatcher: () => Promise<{ subscribe: ParcelSubscribe }>,
): HostedWatcherHost {
  const subs = new Map<number, { unsubscribe(): Promise<void> } | null>();
  let disposed = false;
  const send = (msg: HostedWatchToWorker) => {
    if (disposed) return;
    try { post(msg); } catch { /* worker 已退 */ }
  };
  const release = (sub: { unsubscribe(): Promise<void> }) => {
    void sub.unsubscribe().catch(() => { /* 目录已删 */ });
  };

  return {
    handle(msg) {
      if (!isHostedWatchToHost(msg)) return false;
      if (msg.type === 'fsw-unsub') {
        const sub = subs.get(msg.id);
        subs.delete(msg.id);
        if (sub) release(sub);
        return true;
      }
      if (disposed) return true;
      const { id, dir, ignore } = msg;
      /* 占位: 订阅还在路上时 worker 就退订/退出 —— 落地后发现不在表里就立刻退掉 */
      subs.set(id, null);
      void loadWatcher()
        .then((pw) => pw.subscribe(dir, (err, events) => {
          if (err) send({ type: 'fsw-error', id, error: err.message });
          else if (events.length > 0) send({ type: 'fsw-events', id, events });
        }, { ignore }))
        .then((sub) => {
          if (disposed || !subs.has(id)) { release(sub); return; }
          subs.set(id, sub);
          send({ type: 'fsw-ready', id });
        })
        .catch((err: unknown) => {
          subs.delete(id);
          send({ type: 'fsw-failed', id, error: err instanceof Error ? err.message : String(err) });
        });
      return true;
    },
    dispose() {
      disposed = true;
      for (const sub of subs.values()) if (sub) release(sub);
      subs.clear();
    },
  };
}
