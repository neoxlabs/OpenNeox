/**
 * Pilot 数据层 HTTP 客户端 —— 电脑 / 手机 (经 Dart 移植) / Pilot 云容器 都按这份协议说话。
 * 只依赖 fetch (Node 18+ / 浏览器 / Electron 都有); gzip 用 CompressionStream, 没有就发明文。
 */
import type { Domain, Fact, MetricSeries, PutResult, QueryParams, StoredRecord, SyncPage, TypeDef } from './types.js';
import type { Insight } from './insights.js';

export type PilotDataClientOptions = {
  /** 'https://<api 域名>/api/v1/pilot/data' */
  baseUrl: string;
  /** 每次请求现取 (令牌会刷新) */
  getToken: () => string | Promise<string>;
  /** 服务间调用: 内部令牌 + 代哪个用户 */
  actAsUser?: string;
  /** 记进访问审计: device:desktop/<id> | agent:pilot:<id> */
  actor?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export class PilotDataHttpError extends Error {
  constructor(readonly status: number, message: string, readonly retryable: boolean) {
    super(message);
  }
}

async function gzip(text: string): Promise<{ body: BodyInit; encoded: boolean }> {
  const CS = (globalThis as { CompressionStream?: new (f: string) => GenericTransformStream }).CompressionStream;
  if (!CS) return { body: text, encoded: false };
  const stream = new Blob([text]).stream().pipeThrough(new CS('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>);
  return { body: await new Response(stream).arrayBuffer(), encoded: true };
}

function qs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    sp.set(k, Array.isArray(v) ? v.join(',') : typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export class PilotDataClient {
  private readonly f: typeof fetch;
  constructor(private readonly opts: PilotDataClientOptions) {
    this.f = opts.fetch ?? fetch;
  }

  private async req<T>(method: string, path: string, body?: { raw: BodyInit; type: string; gz?: boolean; headers?: Record<string, string> }): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${await this.opts.getToken()}` };
    if (this.opts.actAsUser) headers['x-pilot-user'] = this.opts.actAsUser;
    if (this.opts.actor) headers['x-pilot-actor'] = this.opts.actor;
    if (body) {
      headers['content-type'] = body.type;
      if (body.gz) headers['content-encoding'] = 'gzip';
      Object.assign(headers, body.headers);
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 20_000);
    let res: Response;
    try {
      res = await this.f(this.opts.baseUrl.replace(/\/$/, '') + path, { method, headers, body: body?.raw, signal: ctl.signal });
    } catch (e) {
      throw new PilotDataHttpError(0, `网络错误: ${(e as Error).message}`, true);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try { msg = JSON.parse(text).error ?? msg; } catch { /* 原文 */ }
      throw new PilotDataHttpError(res.status, msg, res.status === 429 || res.status >= 500);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** 批量写: NDJSON (+gzip)。返回逐条结果, 重发同 id 得 dup 不会重复 */
  async putBatch(records: unknown[]): Promise<{ results: PutResult[] }> {
    const nd = records.map(r => JSON.stringify(r)).join('\n');
    const { body, encoded } = await gzip(nd);
    return this.req('POST', '/records/batch', { raw: body, type: 'application/x-ndjson', gz: encoded });
  }

  query(p: QueryParams = {}): Promise<{ records: StoredRecord[]; next: { occurred_at: number; id: string } | null }> {
    const { before, ...rest } = p;
    return this.req('GET', `/records${qs({ ...rest, before: before ? `${before.occurred_at}:${before.id}` : undefined })}`);
  }

  get(id: string): Promise<{ record: StoredRecord; history: StoredRecord[] }> {
    return this.req('GET', `/records/${encodeURIComponent(id)}`);
  }

  delete(id: string): Promise<{ ok: true }> {
    return this.req('DELETE', `/records/${encodeURIComponent(id)}`);
  }

  sync(cursor: number, opts: { limit?: number; domains?: Domain[]; withRecords?: boolean } = {}): Promise<SyncPage> {
    return this.req('GET', `/sync${qs({ cursor, limit: opts.limit, domains: opts.domains, records: opts.withRecords ? 1 : undefined })}`);
  }

  metric(metric: string, p: { from?: number; to?: number; bucket?: 'day' | 'week' | 'month' } = {}): Promise<MetricSeries> {
    return this.req('GET', `/metrics/${encodeURIComponent(metric)}${qs(p)}`);
  }

  /** 洞察 (insights.ts 在服务端算): [today] = 用户当地的今天 'YYYY-MM-DD' */
  insights(today?: string): Promise<{ insights: Insight[]; records: number }> {
    return this.req('GET', `/insights${qs({ today })}`);
  }

  timeline(day: string, tz?: string): Promise<{ day: string; tz: string; groups: { domain: Domain; records: StoredRecord[] }[] }> {
    return this.req('GET', `/timeline${qs({ day, tz })}`);
  }

  facts(): Promise<{ facts: Fact[] }> {
    return this.req('GET', '/facts');
  }

  /** 给模型的档案摘要 (纯文本, 稳定排序, 吃缓存) */
  profile(): Promise<{ text: string; facts: number }> {
    return this.req('GET', '/profile');
  }

  types(): Promise<{ types: TypeDef[] }> {
    return this.req('GET', '/types');
  }

  registerType(def: TypeDef): Promise<{ ok: true }> {
    return this.req('POST', '/types', { raw: JSON.stringify(def), type: 'application/json' });
  }

  /** 传一个成品 (≤ 20MB), 拿回免登录的分享链接 */
  putBlob(name: string, mime: string, body: Uint8Array): Promise<{ id: string; name: string; mime: string; size: number; url: string }> {
    return this.req('POST', '/blobs', { raw: body as BodyInit, type: mime, headers: { 'x-filename': encodeURIComponent(name) } });
  }

  /** 团队专员这一次的提示词 (服务端只放它范围内的数据), 调用方拿去调模型 */
  teamPrompt(specialist: string, task: string): Promise<{ model: string; specialist: string; name: string; system: string; user: string; records: number }> {
    return this.req('POST', '/team/prompt', { raw: JSON.stringify({ specialist, task }), type: 'application/json' });
  }
}
