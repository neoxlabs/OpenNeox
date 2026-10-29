import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fetchCatalogJson, readCatalogCache, setCatalogCacheDir, resetCatalogMemoForTests } from '../catalogFetch.js';

let dir: string;
let server: http.Server;
let base: string;
let mode: 'ok' | 'hang' | 'fail-once' | 'down' = 'ok';
let hits = 0;
let sawIfNoneMatch: string | undefined;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'neox-catalog-'));
  setCatalogCacheDir(dir);
  resetCatalogMemoForTests();
  hits = 0;
  sawIfNoneMatch = undefined;
  mode = 'ok';
  server = http.createServer((req, res) => {
    hits++;
    sawIfNoneMatch = req.headers['if-none-match'] as string | undefined;
    if (mode === 'hang') return; /* 永不回 —— 模拟代理卡死 */
    if (mode === 'down' || (mode === 'fail-once' && hits === 1)) {
      res.writeHead(502); res.end('bad gateway'); return;
    }
    if (req.headers['if-none-match'] === 'W/"v1"') { res.writeHead(304); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json', etag: 'W/"v1"' });
    res.end(JSON.stringify({ plugins: [{ name: 'notion' }], total: 1 }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  setCatalogCacheDir(null);
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

describe('fetchCatalogJson', () => {
  it('首次拿网络数据并落盘; 再次请求带 If-None-Match, 304 时用缓存', async () => {
    const a = await fetchCatalogJson<any>(`${base}/plugins`);
    expect(a.data.plugins[0].name).toBe('notion');
    expect(a.fromCache).toBe(false);
    expect((await readCatalogCache<any>(`${base}/plugins`))?.data.total).toBe(1);

    const b = await fetchCatalogJson<any>(`${base}/plugins`);
    expect(sawIfNoneMatch).toBe('W/"v1"');
    expect(b.fromCache).toBe(true);
    expect(b.stale).toBe(false);
    expect(b.data.total).toBe(1);
  });

  it('卡住会超时, 有缓存就回退缓存并标 stale —— 页面不会一直转', async () => {
    await fetchCatalogJson<any>(`${base}/plugins`);
    mode = 'hang';
    const t0 = Date.now();
    const r = await fetchCatalogJson<any>(`${base}/plugins`, { timeoutMs: 300, retries: 0 });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.stale).toBe(true);
    expect(r.error).toMatch(/timeout/);
    expect(r.data.plugins[0].name).toBe('notion');
  });

  it('5xx 重试一次就过', async () => {
    mode = 'fail-once';
    const r = await fetchCatalogJson<any>(`${base}/plugins`, { retries: 1 });
    expect(hits).toBe(2);
    expect(r.data.total).toBe(1);
  });

  it('缓存常驻进程内: 读过一次之后不再碰盘 (盘上文件没了照样命中); 进程重启后才回到盘', async () => {
    await fetchCatalogJson<any>(`${base}/plugins`);
    rmSync(dir, { recursive: true, force: true });
    expect((await readCatalogCache<any>(`${base}/plugins`))?.data.total).toBe(1);
    resetCatalogMemoForTests();
    expect(await readCatalogCache<any>(`${base}/plugins`)).toBeNull();
  });

  it('没有缓存又连不上 → data 为 null 且带原因, 不假装成空目录', async () => {
    mode = 'down';
    const r = await fetchCatalogJson<any>(`${base}/plugins`, { retries: 0 });
    expect(r.data).toBeNull();
    expect(r.error).toBe('HTTP 502');
  });
});
