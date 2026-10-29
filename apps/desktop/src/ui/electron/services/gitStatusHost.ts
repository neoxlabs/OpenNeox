
import { Worker } from 'node:worker_threads';
import { electronOrNull } from '../lazyElectron.js';
import type { GitStatusResult } from '../git/gitStatusCore.js';
import type { GitWorkerMessage, GitWorkerRequest } from '../git/gitStatusProtocol.js';
import { createHostedWatcherHost, type HostedWatcherHost } from '@neoxlabs/platform';

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

interface Pending {
  resolve: (v: GitStatusResult | null) => void;
  reject: (e: Error) => void;
}

class GitStatusHost {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  /** cwd → (webContents id → 订阅次数) */
  private readonly watchers = new Map<string, Map<number, number>>();
  private readonly destroyHooked = new Set<number>();
  /** worker 的工作区订阅由主线程代办 (见 hostedWatcher.ts), worker 挂了随之退订 */
  private watchHost: HostedWatcherHost | null = null;

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('../workers/gitStatusWorker.js', import.meta.url));
    const watchHost = createHostedWatcherHost((m) => worker.postMessage(m), () => import('@parcel/watcher'));
    this.watchHost = watchHost;
    worker.on('message', (msg: GitWorkerMessage) => {
      if (watchHost.handle(msg)) return;
      this.onMessage(msg);
    });
    worker.on('error', (err) => this.onFailure(worker, err));
    worker.on('exit', (code) => {
      if (this.worker === worker) this.onFailure(worker, new Error(`git status worker exited: ${code}`));
    });
    worker.unref();
    this.worker = worker;
    /* 重建: 把仍在看的仓库重新 retain, 否则事件驱动的推送就断了 */
    for (const [cwd, bySender] of this.watchers) {
      for (const n of bySender.values()) {
        for (let i = 0; i < n; i++) this.post({ op: 'retain', cwd }).catch(() => { /* 再挂由下一轮处理 */ });
      }
    }
    return worker;
  }

  private onFailure(worker: Worker, err: Error): void {
    if (this.worker !== worker) return;
    this.worker = null;
    this.watchHost?.dispose();
    this.watchHost = null;
    console.error('[git-status] worker failed:', err);
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private onMessage(msg: GitWorkerMessage): void {
    if (msg.type === 'reply') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error));
      return;
    }
    if (msg.type === 'problem') {
      console.error('[git-status]', msg.message);
      return;
    }
    const { payload } = msg;
    const wc = electronOrNull()?.webContents;
    if (!wc) return;
    const targets = new Set<number>();
    for (const cwd of payload.cwds) {
      for (const id of this.watchers.get(cwd)?.keys() ?? []) targets.add(id);
    }
    for (const id of targets) {
      try {
        const contents = wc.fromId(id);
        if (contents && !contents.isDestroyed()) contents.send('git:status-changed', payload);
      } catch { /* 窗口正在关 */ }
    }
  }

  private post(req: DistributiveOmit<GitWorkerRequest, 'id'>): Promise<GitStatusResult | null> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ ...req, id } as GitWorkerRequest);
    });
  }

  async get(cwd: string, fresh: boolean): Promise<GitStatusResult> {
    return (await this.post({ op: 'get', cwd, fresh }))!;
  }

  /** 窗口开始看这个仓库 → 返回当前完整状态 (之后只收增量) */
  async subscribe(senderId: number, sender: { once(ev: 'destroyed', fn: () => void): void }, cwd: string): Promise<GitStatusResult> {
    /* 先把 worker 起好: 重建时的重放只该覆盖"之前就有"的订阅, 不含这一次 */
    this.ensureWorker();
    let bySender = this.watchers.get(cwd);
    if (!bySender) { bySender = new Map(); this.watchers.set(cwd, bySender); }
    bySender.set(senderId, (bySender.get(senderId) ?? 0) + 1);
    if (!this.destroyHooked.has(senderId)) {
      this.destroyHooked.add(senderId);
      sender.once('destroyed', () => this.releaseSender(senderId));
    }
    await this.post({ op: 'retain', cwd });
    return this.get(cwd, false);
  }

  unsubscribe(senderId: number, cwd: string): void {
    const bySender = this.watchers.get(cwd);
    const n = bySender?.get(senderId) ?? 0;
    if (!bySender || n <= 0) return;
    if (n === 1) bySender.delete(senderId);
    else bySender.set(senderId, n - 1);
    if (bySender.size === 0) this.watchers.delete(cwd);
    this.post({ op: 'release', cwd }).catch(() => { /* worker 重建时不会再重放它 */ });
  }

  private releaseSender(senderId: number): void {
    this.destroyHooked.delete(senderId);
    for (const [cwd, bySender] of [...this.watchers]) {
      const n = bySender.get(senderId) ?? 0;
      for (let i = 0; i < n; i++) this.unsubscribe(senderId, cwd);
    }
  }

  async revalidate(cwd: string, fresh: boolean): Promise<void> {
    await this.post({ op: 'revalidate', cwd, fresh });
  }

  /** 我们自己的 git 写操作之后调 */
  invalidate(cwd: string): void {
    this.post({ op: 'invalidate', cwd }).catch(() => { /* worker 挂了, 重建后首次 get 本来就是新算 */ });
  }

  shutdown(): void {
    const w = this.worker;
    this.worker = null;
    this.watchHost?.dispose();
    this.watchHost = null;
    if (w) void w.terminate();
  }
}

export const gitStatusHost = new GitStatusHost();
