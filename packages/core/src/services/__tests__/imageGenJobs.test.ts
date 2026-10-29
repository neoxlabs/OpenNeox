import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { NeoxCloudImageProvider, BYOKImageProvider, isTransientImageFailure } from '../imageGenService.js';

type Handler = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;

let server: http.Server;
let base = '';
let handler: Handler;
const seen: Array<{ method: string; url: string; prefer?: string }> = [];

beforeEach(async () => {
  seen.length = 0;
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, prefer: req.headers.prefer as string | undefined });
      handler(req, body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true, advanceTimeDelta: 50 });
});

afterEach(async () => {
  vi.useRealTimers();
  await new Promise<void>((r) => server.close(() => r()));
});

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const okImage = { created: 1, data: [{ b64_json: 'aGk=' }] };
const req = { model: 'gpt-image-2', prompt: 'p', n: 1 };

describe('NeoxCloudImageProvider · 网关后台任务', () => {
  it('202 → 轮询到 succeeded, 拿到同步接口一样的结果', async () => {
    let polls = 0;
    handler = (r, _b, res) => {
      if (r.method === 'POST') return json(res, 202, { id: 'job_1', status: 'running' });
      polls++;
      if (polls < 3) return json(res, 200, { id: 'job_1', status: 'running' });
      json(res, 200, { id: 'job_1', status: 'succeeded', result: okImage });
    };
    const p = new NeoxCloudImageProvider({ baseUrl: `${base}/n1`, apiKey: 'k' });
    const out = await p.generate(req);
    expect(out.data[0]?.b64Json).toBe('aGk=');
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/n1/images/generations', prefer: 'respond-async' });
    expect(seen.filter((s) => s.method === 'GET').every((s) => s.url === '/n1/media/jobs/job_1')).toBe(true);
  });

  it('老网关不认 Prefer 头, 直接 200 —— 照旧当同步结果用', async () => {
    handler = (_r, _b, res) => json(res, 200, okImage);
    const out = await new NeoxCloudImageProvider({ baseUrl: `${base}/n1`, apiKey: 'k' }).generate(req);
    expect(out.data).toHaveLength(1);
    expect(seen).toHaveLength(1);
  });

  it('任务失败: 抛出跟同步接口同一种格式的错误 (状态码 + 错误对象)', async () => {
    handler = (r, _b, res) => r.method === 'POST'
      ? json(res, 202, { id: 'job_2', status: 'running' })
      : json(res, 200, { id: 'job_2', status: 'failed', http_status: 503, error: { code: 'upstream.unavailable', message: '服务繁忙' } });
    await expect(new NeoxCloudImageProvider({ baseUrl: `${base}/n1`, apiKey: 'k' }).generate(req))
      .rejects.toThrow(/failed: 503 .*upstream\.unavailable/);
  });

  it('查询偶尔失败 (网关重启中) 不算任务失败, 接着查', async () => {
    let polls = 0;
    handler = (r, _b, res) => {
      if (r.method === 'POST') return json(res, 202, { id: 'job_3', status: 'running' });
      polls++;
      if (polls === 1) return json(res, 502, { error: 'bad gateway' });
      json(res, 200, { id: 'job_3', status: 'succeeded', result: okImage });
    };
    const out = await new NeoxCloudImageProvider({ baseUrl: `${base}/n1`, apiKey: 'k' }).generate(req);
    expect(out.data).toHaveLength(1);
  });

  it('中断: DELETE 掉网关上的任务 (预占退回), 抛 AbortError', async () => {
    handler = (r, _b, res) => r.method === 'POST'
      ? json(res, 202, { id: 'job_4', status: 'running' })
      : json(res, 200, { id: 'job_4', status: r.method === 'DELETE' ? 'cancelled' : 'running' });
    const ac = new AbortController();
    const pending = new NeoxCloudImageProvider({ baseUrl: `${base}/n1`, apiKey: 'k' }).generate(req, { signal: ac.signal });
    setTimeout(() => ac.abort(), 2500);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(seen.some((s) => s.method === 'DELETE' && s.url === '/n1/media/jobs/job_4')).toBe(true));
  });
});

describe('BYOKImageProvider · 直连中转的临时错误重发一次', () => {
  it('524 (中转的 Cloudflare 超时) → 重发成功', async () => {
    let n = 0;
    handler = (_r, _b, res) => (++n === 1 ? json(res, 524, { error: 'timeout' }) : json(res, 200, okImage));
    const out = await new BYOKImageProvider({ baseUrl: `${base}/v1`, apiKey: 'k' }).generate(req);
    expect(out.data).toHaveLength(1);
    expect(n).toBe(2);
  });

  it('参数错 (400 非安全拦截) 不重发', async () => {
    let n = 0;
    handler = (_r, _b, res) => { n++; json(res, 400, { error: { message: 'invalid size' } }); };
    await expect(new BYOKImageProvider({ baseUrl: `${base}/v1`, apiKey: 'k' }).generate(req)).rejects.toThrow(/failed: 400/);
    expect(n).toBe(1);
  });

  it('连续两次 503 → 只试两次就报错, 不无限重试', async () => {
    let n = 0;
    handler = (_r, _b, res) => { n++; json(res, 503, { error: 'busy' }); };
    await expect(new BYOKImageProvider({ baseUrl: `${base}/v1`, apiKey: 'k' }).generate(req)).rejects.toThrow(/failed: 503/);
    expect(n).toBe(2);
  });

  it('判定表', () => {
    expect(isTransientImageFailure(524, '')).toBe(true);
    expect(isTransientImageFailure(429, '')).toBe(true);
    expect(isTransientImageFailure(400, '该请求可能因安全政策被拦截')).toBe(true);
    expect(isTransientImageFailure(400, 'invalid size')).toBe(false);
    expect(isTransientImageFailure(403, 'insufficient_user_quota')).toBe(false);
  });
});
