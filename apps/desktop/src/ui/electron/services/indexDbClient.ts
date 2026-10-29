/**
 * IndexDbClient —— 主线程这一侧的索引库句柄。所有方法都是 async, 因为真正干活的
 * 是 indexDbWorker。主线程在这条路径上只做两件事: postMessage 和 resolve promise。
 *
 *   worker 是**单个**而不是池: SQLite 的写要串行, 多个 worker 抢同一个库只会
 *   拿到 SQLITE_BUSY。索引的并行度在 indexingCpuPool 那一层 (解析/分词), 那才是
 *   真正吃 CPU 的部分; 落库这一层要的是"不挡主线程", 不是"更多并发"。
 *
 *   worker 挂掉不该让整个 App 跟着倒 —— 重建一个, 把在途请求全部 reject,
 *   并且**重放 open**, 否则新 worker 手里没有库, 后面每一笔都报 "index db not open"。
 */

import { Worker } from 'worker_threads';

import type {
  IndexDbOp,
  IndexDbResponse,
  IndexPendingChunk,
  IndexSearchResult,
  IndexStatus,
} from './indexDbTypes.js';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class IndexDbClient {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  /** 最近一次 open 的库 —— worker 重建后照着它把状态接回去 */
  private currentDbPath: string | null = null;

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('../workers/indexDbWorker.js', import.meta.url));
    worker.on('message', (message: IndexDbResponse) => {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.ok) entry.resolve(message.result);
      else entry.reject(new Error(message.error));
    });
    worker.on('error', (error) => this.handleFailure(error));
    worker.on('exit', (code) => {
      if (code !== 0) this.handleFailure(new Error(`index db worker exited: ${code}`));
    });
    this.worker = worker;
    return worker;
  }

  private handleFailure(error: Error): void {
    for (const [, entry] of this.pending) entry.reject(error);
    this.pending.clear();
    this.worker = null;
    /* 有库就自动接回去。不 await —— 后续请求会排在这条之后, 顺序由消息队列保证。 */
    if (this.currentDbPath) {
      this.send({ op: 'open', dbPath: this.currentDbPath }).catch(() => { /* 接不回来就等下一次 open */ });
    }
  }

  private send(payload: IndexDbOp): Promise<unknown> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, payload });
    });
  }

  async open(dbPath: string): Promise<void> {
    this.currentDbPath = dbPath;
    await this.send({ op: 'open', dbPath });
  }

  async close(): Promise<void> {
    if (!this.worker) { this.currentDbPath = null; return; }
    this.currentDbPath = null;
    try { await this.send({ op: 'close' }); } catch { /* 关不上就让 terminate 收场 */ }
  }

  /** 彻底销毁 worker —— 换 workspace / 退出时用 */
  async dispose(): Promise<void> {
    await this.close();
    const worker = this.worker;
    this.worker = null;
    if (worker) { try { await worker.terminate(); } catch { /* noop */ } }
  }

  get isOpen(): boolean {
    return this.currentDbPath !== null;
  }

  listIndexedFiles(): Promise<string[]> {
    return this.send({ op: 'listIndexedFiles' }) as Promise<string[]>;
  }

  getFileHashes(relPaths: string[]): Promise<Record<string, string>> {
    return this.send({ op: 'getFileHashes', relPaths }) as Promise<Record<string, string>>;
  }

  async deleteFiles(relPaths: string[]): Promise<void> {
    if (relPaths.length === 0) return;
    await this.send({ op: 'deleteFiles', relPaths });
  }

  insertChunks(batch: IndexPendingChunk[]): Promise<number> {
    return this.send({ op: 'insertChunks', batch }) as Promise<number>;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.send({ op: 'setMeta', key, value });
  }

  search(query: string, topK: number): Promise<IndexSearchResult[]> {
    return this.send({ op: 'search', query, topK }) as Promise<IndexSearchResult[]>;
  }

  status(): Promise<IndexStatus> {
    return this.send({ op: 'status' }) as Promise<IndexStatus>;
  }

  async clear(): Promise<void> {
    await this.send({ op: 'clear' });
  }
}
