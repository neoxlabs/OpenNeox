/**
 * worker 的文件订阅由主线程代办 (hostedWatcher)。
 *
 * 真崩溃的复现 (两个 worker 环境共用 watcher.node 的全局 Watcher, 回收后投递到已销毁的环境 →
 * SIGABRT) 要真 worker_threads + 真原生模块, 不适合放单测; 这里钉协议本身:
 * 事件送得到、退订真的退、worker 没了主线程把它名下的订阅全退掉、订阅在路上时退出也不漏。
 */
import { describe, expect, it } from 'vitest';
import { createHostedWatcherClient, createHostedWatcherHost, type ParcelSubscribe } from '../hostedWatcher.js';

/** 假的 @parcel/watcher: 记下活着的订阅, 能手动触发事件 */
function fakeWatcher(opts?: { delayMs?: number; fail?: boolean }) {
  const live = new Map<number, (err: Error | null, events: any[]) => void>();
  let seq = 0;
  const subscribe: ParcelSubscribe = async (_dir, fn) => {
    if (opts?.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (opts?.fail) throw new Error('no watcher on this platform');
    const id = ++seq;
    live.set(id, fn as any);
    return { unsubscribe: async () => { live.delete(id); } };
  };
  const fire = (events: any[]) => { for (const fn of live.values()) fn(null, events); };
  return { subscribe, live, fire };
}

/** 把 client 和 host 接成一对 (同步投递, 模拟 postMessage) */
function wire(watcher: ReturnType<typeof fakeWatcher>) {
  let client!: ReturnType<typeof createHostedWatcherClient>;
  const host = createHostedWatcherHost((m) => { client.handle(m); }, async () => ({ subscribe: watcher.subscribe }));
  client = createHostedWatcherClient((m) => { host.handle(m); });
  return { client, host };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('hostedWatcher', () => {
  it('订阅成功后, 主线程那边的事件原样送到 worker 的回调', async () => {
    const w = fakeWatcher();
    const { client } = wire(w);
    const got: any[] = [];
    await client.subscribe('/proj', (_err, events) => got.push(...events), { ignore: ['node_modules'] });
    w.fire([{ path: '/proj/a.ts', type: 'update' }]);
    expect(got).toEqual([{ path: '/proj/a.ts', type: 'update' }]);
  });

  it('worker 退订 → 主线程那份订阅真的退掉', async () => {
    const w = fakeWatcher();
    const { client } = wire(w);
    const sub = await client.subscribe('/proj', () => {});
    expect(w.live.size).toBe(1);
    await sub.unsubscribe();
    await tick();
    expect(w.live.size).toBe(0);
  });

  it('worker 被回收 (host.dispose) → 它名下的订阅全部退掉, 不留悬空回调', async () => {
    const w = fakeWatcher();
    const { client, host } = wire(w);
    await client.subscribe('/a', () => {});
    await client.subscribe('/b', () => {});
    expect(w.live.size).toBe(2);
    host.dispose();
    await tick();
    expect(w.live.size).toBe(0);
  });

  it('订阅还在路上时 worker 就没了 → 落地后立刻退掉', async () => {
    const w = fakeWatcher({ delayMs: 10 });
    const { client, host } = wire(w);
    void client.subscribe('/slow', () => {}).catch(() => {});
    host.dispose();
    await new Promise((r) => setTimeout(r, 30));
    expect(w.live.size).toBe(0);
  });

  it('主线程订阅失败 → worker 那边的 subscribe 拒绝, 调用方按降级处理', async () => {
    const w = fakeWatcher({ fail: true });
    const { client } = wire(w);
    await expect(client.subscribe('/x', () => {})).rejects.toThrow('no watcher on this platform');
  });

  it('不是本协议的消息两边都不认, 交还给调用方', () => {
    const w = fakeWatcher();
    const { client, host } = wire(w);
    expect(client.handle({ type: 'result', reqId: 1 })).toBe(false);
    expect(host.handle({ type: 'host-call', reqId: 1 })).toBe(false);
  });
});
