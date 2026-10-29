/**
 * 设备端批量上传器: 写入先进本地队列立即返回 (UI 不等网络), 后台每 2 秒或攒满 200 条 / 256KB 发一批。
 *
 *   · 幂等: id 是客户端 ULID, 服务端 ON CONFLICT DO NOTHING; 网络断在半路重发也不会重复。
 *   · 按条隔离: 服务端逐条回 ok / dup / invalid; invalid 的交给 onInvalid 然后出队, 不堵后面的。
 *   · 失败退避: 网络错 / 5xx / 429 指数退避 (1s → 60s), 队列留着; 4xx (非 429) 说明这批本身有问题 —— 整批拆单条重试一次定位坏的。
 *
 * 队列存储可替换: 电脑 / 手机用持久化实现 (SQLite), 测试用内存。
 */
import { PilotDataHttpError, type PilotDataClient } from './client.js';
import { normalizeRecord } from './validate.js';
import { ulid } from './ulid.js';
import type { TypeResolver } from './registry.js';
import type { PutResult, RecordInput } from './types.js';

export interface QueueStore {
  push(records: RecordInput[]): Promise<void>;
  /** 按入队顺序取前 n 条 (不出队) */
  peek(n: number): Promise<RecordInput[]>;
  ack(ids: string[]): Promise<void>;
  size(): Promise<number>;
}

export class MemoryQueueStore implements QueueStore {
  private items: RecordInput[] = [];
  async push(records: RecordInput[]) { this.items.push(...records); }
  async peek(n: number) { return this.items.slice(0, n); }
  async ack(ids: string[]) { const s = new Set(ids); this.items = this.items.filter(r => !s.has(r.id)); }
  async size() { return this.items.length; }
}

export type UploaderOptions = {
  client: Pick<PilotDataClient, 'putBatch'>;
  store?: QueueStore;
  source: string;
  resolve?: TypeResolver;
  flushMs?: number;
  maxBatch?: number;
  maxBatchBytes?: number;
  onInvalid?: (r: PutResult, input: RecordInput | undefined) => void;
  onError?: (e: unknown) => void;
};

export type LogInput = Omit<RecordInput, 'id' | 'occurred_at' | 'source'> & { id?: string; occurred_at?: number; source?: string };

export class PilotDataUploader {
  readonly store: QueueStore;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private backoffMs = 0;
  private stopped = false;

  constructor(private readonly o: UploaderOptions) {
    this.store = o.store ?? new MemoryQueueStore();
  }

  /** 记一笔: 本地校验 → 入队 → 返回 id。校验不过直接抛 (调用方当场就知道写错了) */
  async log(input: LogInput | LogInput[]): Promise<string[]> {
    const list = Array.isArray(input) ? input : [input];
    const now = Date.now();
    const out: RecordInput[] = list.map(i => ({ ...i, id: i.id ?? ulid(), occurred_at: i.occurred_at ?? now, source: i.source ?? this.o.source }));
    for (const r of out) {
      const n = normalizeRecord(r, { resolve: this.o.resolve, now });
      /* 自定义类型本地可能不认识, 交给服务端判 */
      if (!n.ok && !n.error.startsWith('未知类型')) throw new Error(`${r.type}: ${n.error}`);
    }
    await this.store.push(out);
    this.schedule(this.o.flushMs ?? 2_000);
    return out.map(r => r.id);
  }

  private schedule(ms: number) {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, ms);
  }

  /** 把队列清空 (或遇到网络错为止)。并发调用合并成一次 */
  flush(): Promise<void> {
    if (!this.flushing) this.flushing = this.drain().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  private async takeBatch(): Promise<RecordInput[]> {
    const max = this.o.maxBatch ?? 200;
    const maxBytes = this.o.maxBatchBytes ?? 256 * 1024;
    const head = await this.store.peek(max);
    let bytes = 0;
    const batch: RecordInput[] = [];
    for (const r of head) {
      const b = JSON.stringify(r).length + 1;
      if (batch.length > 0 && bytes + b > maxBytes) break;
      bytes += b;
      batch.push(r);
    }
    return batch;
  }

  private async send(batch: RecordInput[]): Promise<void> {
    const { results } = await this.o.client.putBatch(batch);
    /* 一条都没回 = 服务端异常, 当可重试处理 (否则同一批会原地死循环) */
    if (!results?.length) throw new PilotDataHttpError(0, '服务端没有返回逐条结果', true);
    const byId = new Map(batch.map(r => [r.id, r]));
    for (const r of results) if (r.status === 'invalid') this.o.onInvalid?.(r, byId.get(r.id));
    /* 服务端回了结果的都出队 (ok / dup / invalid); 没回结果的留着下次 */
    await this.store.ack(results.map(r => r.id));
  }

  private async drain(): Promise<void> {
    while (!this.stopped) {
      const batch = await this.takeBatch();
      if (batch.length === 0) return;
      try {
        await this.send(batch);
        this.backoffMs = 0;
      } catch (e) {
        if (e instanceof PilotDataHttpError && !e.retryable && batch.length > 1) {
          /* 整批被拒 (多半是某条撑爆了体积): 拆成单条, 定位并丢掉坏的 */
          for (const r of batch) {
            try { await this.send([r]); } catch (e1) {
              if (e1 instanceof PilotDataHttpError && !e1.retryable) {
                this.o.onInvalid?.({ id: r.id, status: 'invalid', error: e1.message }, r);
                await this.store.ack([r.id]);
              } else throw e1;
            }
          }
          continue;
        }
        if (e instanceof PilotDataHttpError && !e.retryable) {
          this.o.onInvalid?.({ id: batch[0].id, status: 'invalid', error: e.message }, batch[0]);
          await this.store.ack([batch[0].id]);
          continue;
        }
        this.o.onError?.(e);
        this.backoffMs = Math.min(60_000, this.backoffMs ? this.backoffMs * 2 : 1_000);
        this.schedule(this.backoffMs);
        return;
      }
    }
  }

  /** 退出前: 尽量发完 */
  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.flush().catch(() => {});
    this.stopped = true;
  }
}
